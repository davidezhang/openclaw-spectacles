import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {Agent} from "./Agent"
import {CaptionBehavior} from "./CaptionBehavior"

const STAGING_TIMEOUT_SEC = 30
const STAGING_SHRINK_DELAY_SEC = 2
const STAGING_SHRINK_SCALE = 0.3
const ASR_FINALIZATION_WAIT_SEC = 0.35

@component
export class VoiceQueryController extends BaseScriptComponent {
  @input agent: Agent
  @input caption: CaptionBehavior
  @input editorCamObj: SceneObject

  private asrModule: AsrModule = require("LensStudio:AsrModule")

  private isEditor = global.deviceInfoSystem.isEditor()

  private rightHand = SIK.HandInputData.getHand("right")
  private leftHand = SIK.HandInputData.getHand("left")

  private transcript: string = ""
  private isRecording: boolean = false

  // Staging state
  private stagedImageTex: Texture | null = null
  private stagedSceneObj: SceneObject | null = null
  private stagedAnchorTrans: Transform | null = null
  private stagedCaptionPos: vec3 | null = null
  private stagedCaptionRot: quat | null = null
  private activeCaptionPos: vec3 | null = null
  private activeCaptionRot: quat | null = null
  private stagingTimeoutEvent: any = null
  private pendingSendEvent: any = null
  private shrinkCancel: CancelSet = new CancelSet()
  private isWaitingForFinalTranscript: boolean = false

  // Camera-follow state for staged image
  private camTrans: Transform
  private stagedFollowDistance: number = 60
  private stagedFollowVerticalOffset: number = -15
  private stagedFollowScale: vec3 | null = null

  // Scanner lock — suppresses ASR while two-hand crop is active
  isScannerActive: boolean = false

  onAwake() {
    this.camTrans = this.editorCamObj.getTransform()

    this.createEvent("UpdateEvent").bind(() => {
      this.updateStagedFollow()
    })

    if (!this.isEditor) {
      this.rightHand.onPinchDown.add(this.onRightPinchDown)
      this.rightHand.onPinchUp.add(this.onRightPinchUp)
    }
  }

  // ── Staging API (called by PictureBehavior) ──────────────────────────

  stageImage(
    imageTex: Texture,
    sceneObj: SceneObject,
    anchorTrans: Transform,
    captionPos: vec3,
    captionRot: quat
  ) {
    // If an image is already staged, clear it first
    this.clearStagedImage(false)

    this.stagedImageTex = imageTex
    this.stagedSceneObj = sceneObj
    this.stagedAnchorTrans = anchorTrans
    this.stagedCaptionPos = captionPos
    this.stagedCaptionRot = captionRot

    // Capture the current scale so the follow loop preserves it
    this.stagedFollowScale = anchorTrans.getWorldScale()

    print("Image staged — waiting for voice query (" + STAGING_TIMEOUT_SEC + "s)")

    // After STAGING_SHRINK_DELAY_SEC, animate the crop frame smaller
    const shrinkEvent = this.createEvent("DelayedCallbackEvent")
    shrinkEvent.bind(() => {
      this.animateShrink()
    })
    shrinkEvent.reset(STAGING_SHRINK_DELAY_SEC)

    // After STAGING_TIMEOUT_SEC, discard the staged image
    this.stagingTimeoutEvent = this.createEvent("DelayedCallbackEvent")
    this.stagingTimeoutEvent.bind(() => {
      print("Staging timeout — discarding staged image")
      this.clearStagedImage(true)
    })
    this.stagingTimeoutEvent.reset(STAGING_TIMEOUT_SEC)
  }

  private updateStagedFollow() {
    if (!this.stagedAnchorTrans || !this.stagedFollowScale) return

    const camPos = this.camTrans.getWorldPosition()
    const camForward = this.camTrans.forward
    const camUp = this.camTrans.up

    this.stagedAnchorTrans.setWorldPosition(
      camPos
        .add(camForward.uniformScale(-this.stagedFollowDistance))
        .add(camUp.uniformScale(this.stagedFollowVerticalOffset))
    )
    this.stagedAnchorTrans.setWorldRotation(quat.lookAt(camForward, vec3.up()))
    this.stagedAnchorTrans.setWorldScale(this.stagedFollowScale)
  }

  private animateShrink() {
    if (!this.stagedAnchorTrans || !this.stagedFollowScale) return
    if (this.shrinkCancel) this.shrinkCancel.cancel()

    const startScale = this.stagedFollowScale
    const targetScale = startScale.uniformScale(STAGING_SHRINK_SCALE)

    animate({
      easing: "ease-out-back",
      duration: 0.6,
      update: (t: number) => {
        if (!this.stagedFollowScale) return
        this.stagedFollowScale = vec3.lerp(startScale, targetScale, t)
      },
      ended: null,
      cancelSet: this.shrinkCancel,
    })
  }

  private clearStagedImage(destroy: boolean) {
    this.stagedImageTex = null
    this.stagedCaptionPos = null
    this.stagedCaptionRot = null

    if (this.shrinkCancel) this.shrinkCancel.cancel()

    if (this.stagingTimeoutEvent) {
      this.removeEvent(this.stagingTimeoutEvent)
      this.stagingTimeoutEvent = null
    }

    if (destroy && this.stagedSceneObj && this.stagedFollowScale) {
      // Animate scale to zero while the follow loop keeps it in front of camera
      const obj = this.stagedSceneObj
      const startScale = this.stagedFollowScale
      this.stagedSceneObj = null

      animate({
        easing: "ease-in-back",
        duration: 0.3,
        update: (t: number) => {
          if (!this.stagedFollowScale) return
          this.stagedFollowScale = vec3.lerp(startScale, vec3.zero(), t)
        },
        ended: () => {
          this.stagedAnchorTrans = null
          this.stagedFollowScale = null
          obj.destroy()
        },
      })
    } else {
      this.stagedAnchorTrans = null
      this.stagedFollowScale = null
    }
  }

  // ── Right-hand pinch-and-hold ASR ────────────────────────────────────

  private onRightPinchDown = () => {
    // Don't start ASR if scanner is active (two-hand crop in progress)
    // or if left hand is also pinching (would be a crop gesture)
    if (this.isScannerActive) return
    if (this.leftHand.isPinching()) return

    this.startRecording()
  }

  private onRightPinchUp = () => {
    if (!this.isRecording) return
    this.stopRecordingAndSend()
  }

  private getCurrentCaptionPose(): {pos: vec3; rot: quat} {
    if (this.stagedCaptionPos && this.stagedCaptionRot) {
      return {
        pos: this.stagedCaptionPos,
        rot: this.stagedCaptionRot,
      }
    }

    return {
      pos: this.getDefaultPos(),
      rot: this.getDefaultRot(),
    }
  }

  private lockCaptionPose() {
    const pose = this.getCurrentCaptionPose()
    this.activeCaptionPos = pose.pos
    this.activeCaptionRot = pose.rot
  }

  private getCaptionPose(): {pos: vec3; rot: quat} {
    if (this.activeCaptionPos && this.activeCaptionRot) {
      return {
        pos: this.activeCaptionPos,
        rot: this.activeCaptionRot,
      }
    }

    return this.getCurrentCaptionPose()
  }

  private updateCaption(text: string) {
    const pose = this.getCaptionPose()
    this.caption.setText(text, pose.pos, pose.rot)
  }

  private clearPendingSendEvent() {
    if (this.pendingSendEvent) {
      this.removeEvent(this.pendingSendEvent)
      this.pendingSendEvent = null
    }
  }

  private finalizeStoppedRecording() {
    if (!this.isWaitingForFinalTranscript) return

    this.isWaitingForFinalTranscript = false
    this.clearPendingSendEvent()

    const query = this.transcript.trim()

    if (!query) {
      print("No speech detected")
      this.updateCaption("No speech detected")
      const clearEvent = this.createEvent("DelayedCallbackEvent")
      clearEvent.bind(() => {
        this.caption.hide()
      })
      clearEvent.reset(2)
      return
    }

    print("Sending query: " + query)
    this.updateCaption("Thinking...")

    if (this.stagedImageTex) {
      this.agent.sendImageWithQuery(this.stagedImageTex, query, (response) => {
        this.updateCaption(response)
        this.clearStagedImage(true)
      })
    } else {
      this.agent.sendTextOnly(query, (response) => {
        this.updateCaption(response)
      })
    }
  }

  private startRecording() {
    if (this.isRecording) {
      this.asrModule.stopTranscribing()
    }

    this.clearPendingSendEvent()
    this.isWaitingForFinalTranscript = false
    this.isRecording = true
    this.transcript = ""
    this.lockCaptionPose()
    this.updateCaption("Listening...")

    const options = AsrModule.AsrTranscriptionOptions.create()
    options.mode = AsrModule.AsrMode.Balanced
    options.silenceUntilTerminationMs = 500

    options.onTranscriptionUpdateEvent.add((eventArgs: any) => {
      this.transcript = eventArgs.text
      const displayText = eventArgs.isFinal ? eventArgs.text : eventArgs.text + "..."
      this.updateCaption(displayText)

      if (eventArgs.isFinal && this.isWaitingForFinalTranscript) {
        this.finalizeStoppedRecording()
      }
    })

    options.onTranscriptionErrorEvent.add((error: any) => {
      print("ASR error: " + error)
      this.isRecording = false
      this.isWaitingForFinalTranscript = false
      this.clearPendingSendEvent()
      this.updateCaption("ASR error")
    })

    print("ASR started — listening...")
    this.asrModule.startTranscribing(options)
  }

  private stopRecordingAndSend() {
    this.isRecording = false
    this.isWaitingForFinalTranscript = true
    this.asrModule.stopTranscribing()

    this.clearPendingSendEvent()
    this.pendingSendEvent = this.createEvent("DelayedCallbackEvent")
    this.pendingSendEvent.bind(() => {
      this.finalizeStoppedRecording()
    })
    this.pendingSendEvent.reset(ASR_FINALIZATION_WAIT_SEC)
  }

  // Caption at a default position (for text-only queries without a crop region)
  private showCaptionDefault(text: string) {
    this.updateCaption(text)
  }

  // Public helper for editor auto-send path
  showResponse(text: string) {
    this.showCaptionDefault(text)
  }

  private getDefaultPos(): vec3 {
    const camTrans = this.editorCamObj.getTransform()
    return camTrans.getWorldPosition().add(camTrans.forward.uniformScale(-60))
  }

  private getDefaultRot(): quat {
    const camTrans = this.editorCamObj.getTransform()
    return quat.lookAt(camTrans.forward, vec3.up())
  }
}

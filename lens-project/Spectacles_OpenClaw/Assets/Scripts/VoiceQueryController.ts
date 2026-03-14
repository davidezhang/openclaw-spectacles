import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {Agent} from "./Agent"
import {CaptionBehavior} from "./CaptionBehavior"

const STAGING_TIMEOUT_SEC = 30
const STAGING_SHRINK_DELAY_SEC = 2
const STAGING_SHRINK_SCALE = 0.3

@component
export class VoiceQueryController extends BaseScriptComponent {
  @input agent: Agent
  @input caption: CaptionBehavior
  @input loadingObj: SceneObject
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
  private stagingTimeoutEvent: any = null
  private shrinkCancel: CancelSet = new CancelSet()

  // Scanner lock — suppresses ASR while two-hand crop is active
  isScannerActive: boolean = false

  private loadingTrans: Transform | null = null

  onAwake() {
    if (this.loadingObj) {
      this.loadingObj.enabled = false
      this.loadingTrans = this.loadingObj.getTransform()
    }

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

  private animateShrink() {
    if (!this.stagedAnchorTrans) return
    if (this.shrinkCancel) this.shrinkCancel.cancel()

    const startScale = this.stagedAnchorTrans.getWorldScale()
    const targetScale = startScale.uniformScale(STAGING_SHRINK_SCALE)

    // Move downward by ~15cm relative to current position
    const startPos = this.stagedAnchorTrans.getWorldPosition()
    const downOffset = vec3.up().uniformScale(-15)
    const targetPos = startPos.add(downOffset)

    animate({
      easing: "ease-out-back",
      duration: 0.6,
      update: (t: number) => {
        if (!this.stagedAnchorTrans) return
        this.stagedAnchorTrans.setWorldScale(vec3.lerp(startScale, targetScale, t))
        this.stagedAnchorTrans.setWorldPosition(vec3.lerp(startPos, targetPos, t))
      },
      ended: null,
      cancelSet: this.shrinkCancel,
    })
  }

  private clearStagedImage(destroy: boolean) {
    this.stagedImageTex = null
    this.stagedCaptionPos = null
    this.stagedCaptionRot = null
    this.stagedAnchorTrans = null

    if (this.shrinkCancel) this.shrinkCancel.cancel()

    if (this.stagingTimeoutEvent) {
      this.removeEvent(this.stagingTimeoutEvent)
      this.stagingTimeoutEvent = null
    }

    if (destroy && this.stagedSceneObj) {
      // Animate out before destroying
      const obj = this.stagedSceneObj
      const trans = obj.getTransform()
      const startScale = trans.getWorldScale()
      animate({
        easing: "ease-in-back",
        duration: 0.3,
        update: (t: number) => {
          trans.setWorldScale(vec3.lerp(startScale, vec3.zero(), t))
        },
        ended: () => {
          obj.destroy()
        },
      })
      this.stagedSceneObj = null
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

  private startRecording() {
    if (this.isRecording) {
      this.asrModule.stopTranscribing()
    }

    this.isRecording = true
    this.transcript = ""
    this.caption.hide()

    const options = AsrModule.AsrTranscriptionOptions.create()
    options.mode = AsrModule.AsrMode.HighAccuracy
    options.silenceUntilTerminationMs = 1500

    options.onTranscriptionUpdateEvent.add((eventArgs: any) => {
      this.transcript = eventArgs.text
      const displayText = eventArgs.isFinal
        ? eventArgs.text
        : eventArgs.text + "..."
      const pos = this.getDefaultPos()
      const rot = this.getDefaultRot()
      this.caption.setText(displayText, pos, rot)
    })

    options.onTranscriptionErrorEvent.add((error: any) => {
      print("ASR error: " + error)
      this.isRecording = false
      this.caption.hide()
    })

    print("ASR started — listening...")
    this.asrModule.startTranscribing(options)
  }

  private stopRecordingAndSend() {
    this.asrModule.stopTranscribing()
    this.isRecording = false

    const query = this.transcript.trim()

    if (!query) {
      print("No speech detected")
      const pos = this.getDefaultPos()
      const rot = this.getDefaultRot()
      this.caption.setText("No speech detected", pos, rot)
      const clearEvent = this.createEvent("DelayedCallbackEvent")
      clearEvent.bind(() => {
        this.caption.hide()
      })
      clearEvent.reset(2)
      return
    }

    print("Sending query: " + query)
    this.showLoading(true)

    if (this.stagedImageTex) {
      // Send image + voice query together
      const captionPos = this.stagedCaptionPos
      const captionRot = this.stagedCaptionRot
      this.agent.sendImageWithQuery(this.stagedImageTex, query, (response) => {
        this.showLoading(false)
        if (captionPos && captionRot) {
          this.caption.openCaption(response, captionPos, captionRot)
        } else {
          this.showCaptionDefault(response)
        }
        this.clearStagedImage(true)
      })
    } else {
      // Text-only query — no image
      this.agent.sendTextOnly(query, (response) => {
        this.showLoading(false)
        this.showCaptionDefault(response)
      })
    }
  }

  private showLoading(on: boolean) {
    if (this.loadingObj) {
      this.loadingObj.enabled = on
    }
  }

  // Caption at a default position (for text-only queries without a crop region)
  private showCaptionDefault(text: string) {
    this.caption.openCaption(text, this.getDefaultPos(), this.getDefaultRot())
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

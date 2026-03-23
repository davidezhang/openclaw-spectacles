import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {Agent} from "./Agent"
import {CaptionBehavior} from "./CaptionBehavior"

const STAGING_TIMEOUT_SEC = 30
const STAGING_SHRINK_DELAY_SEC = 2
const STAGING_SHRINK_SCALE = 0.3
const ASR_FINALIZATION_WAIT_SEC = 0.35
const RESPONSE_TIMEOUT_SEC = 10
const LISTENING_IMAGE_SCALE_FACTOR = 0.6
const LISTENING_IMAGE_GAP = 1.5
const RECORDING_DEBOUNCE_SEC = 0.1

@component
export class VoiceQueryController extends BaseScriptComponent {
  @input agent: Agent
  @input caption: CaptionBehavior
  @input editorCamObj: SceneObject
  @input
  @allowUndefined
  loadingObj: SceneObject

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
  private listeningScaleCancel: CancelSet = new CancelSet()
  private isWaitingForFinalTranscript: boolean = false
  private responseTimeoutEvent: any = null
  private stagedOriginalScale: vec3 | null = null
  private showImageAboveCaption: boolean = false
  private recordingDebounceEvent: any = null

  // Camera-follow state for staged image
  private camTrans: Transform
  private stagedFollowDistance: number = 60
  private stagedFollowVerticalOffset: number = -15
  private stagedFollowScale: vec3 | null = null

  // Loading indicator state
  private loadingTrans: Transform | null = null
  private loadingFollowDistance: number = 60
  private loadingFollowVerticalOffset: number = -10
  private loadingScale: vec3 = new vec3(13, 10, 1)

  // Scanner lock — suppresses ASR while two-hand crop is active
  isScannerActive: boolean = false

  onAwake() {
    this.camTrans = this.editorCamObj.getTransform()

    if (this.loadingObj) {
      this.loadingTrans = this.loadingObj.getTransform()
      this.loadingObj.enabled = false
    }

    this.createEvent("UpdateEvent").bind(() => {
      this.updateStagedFollow()
      this.updateLoadingFollow()
    })

    if (!this.isEditor) {
      this.rightHand.onPinchDown.add(this.onRightPinchDown)
      this.rightHand.onPinchUp.add(this.onRightPinchUp)
      this.leftHand.onPinchDown.add(this.onLeftPinchDown)
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
    this.stagedOriginalScale = anchorTrans.getWorldScale()

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

  private updateLoadingFollow() {
    if (!this.loadingObj || !this.loadingTrans) return
    if (!this.loadingObj.enabled) return

    this.positionLoading()
  }

  private positionLoading() {
    if (!this.loadingTrans) return

    const camPos = this.camTrans.getWorldPosition()
    const camForward = this.camTrans.forward
    const camUp = this.camTrans.up

    this.loadingTrans.setWorldPosition(
      camPos
        .add(camForward.uniformScale(-this.loadingFollowDistance))
        .add(camUp.uniformScale(this.loadingFollowVerticalOffset))
    )
    this.loadingTrans.setWorldRotation(quat.lookAt(camForward, vec3.up()))
    this.loadingTrans.setWorldScale(this.loadingScale)
  }

  private showLoading() {
    if (this.loadingObj) {
      this.positionLoading()
      this.loadingObj.enabled = true
    }
  }

  private hideLoading() {
    if (this.loadingObj) this.loadingObj.enabled = false
  }

  private updateStagedFollow() {
    if (!this.stagedAnchorTrans || !this.stagedFollowScale) return

    const camPos = this.camTrans.getWorldPosition()
    const camForward = this.camTrans.forward
    const camUp = this.camTrans.up
    const camRight = camUp.cross(camForward).normalize()

    let verticalOffset = this.stagedFollowVerticalOffset
    if (this.showImageAboveCaption) {
      const captionWorldHalfHeight = this.caption.getWorldHalfHeight()
      const imageHalfHeight = this.stagedFollowScale.y / 2
      verticalOffset = this.caption.getFollowVerticalOffset()
        + captionWorldHalfHeight + LISTENING_IMAGE_GAP + imageHalfHeight
    }

    // The anchor pivot is not at the mesh center — offset horizontally
    // so the image appears centered in view.
    const halfW = this.stagedFollowScale.x / 2

    this.stagedAnchorTrans.setWorldPosition(
      camPos
        .add(camForward.uniformScale(-this.stagedFollowDistance))
        .add(camUp.uniformScale(verticalOffset))
        .add(camRight.uniformScale(halfW))
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

  private animateToListeningScale() {
    if (!this.stagedOriginalScale || !this.stagedFollowScale) return
    this.shrinkCancel.cancel()
    this.listeningScaleCancel.cancel()

    const startScale = this.stagedFollowScale
    const targetScale = this.stagedOriginalScale.uniformScale(LISTENING_IMAGE_SCALE_FACTOR)

    animate({
      easing: "ease-out-back",
      duration: 0.4,
      update: (t: number) => {
        if (!this.stagedFollowScale) return
        this.stagedFollowScale = vec3.lerp(startScale, targetScale, t)
      },
      ended: null,
      cancelSet: this.listeningScaleCancel,
    })
  }

  private animateBackToShrink() {
    if (!this.stagedOriginalScale || !this.stagedFollowScale) return
    this.listeningScaleCancel.cancel()

    const startScale = this.stagedFollowScale
    const targetScale = this.stagedOriginalScale.uniformScale(STAGING_SHRINK_SCALE)

    animate({
      easing: "ease-out-back",
      duration: 0.4,
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
    this.listeningScaleCancel.cancel()

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
          this.stagedOriginalScale = null
          this.showImageAboveCaption = false
          obj.destroy()
        },
      })
    } else {
      this.stagedAnchorTrans = null
      this.stagedFollowScale = null
      this.stagedOriginalScale = null
      this.showImageAboveCaption = false
    }
  }

  // ── Right-hand pinch-and-hold ASR ────────────────────────────────────

  private onRightPinchDown = () => {
    // Don't start ASR if scanner is active (two-hand crop in progress)
    // or if left hand is also pinching (would be a crop gesture)
    if (this.isScannerActive) return
    if (this.leftHand.isPinching()) return

    // Debounce: wait briefly to see if left hand also pinches (two-hand crop)
    this.clearRecordingDebounce()
    this.recordingDebounceEvent = this.createEvent("DelayedCallbackEvent")
    this.recordingDebounceEvent.bind(() => {
      this.recordingDebounceEvent = null
      // Re-check: left hand may have pinched during the debounce window
      if (this.isScannerActive) return
      if (this.leftHand.isPinching()) return
      if (!this.rightHand.isPinching()) return
      this.startRecording()
    })
    this.recordingDebounceEvent.reset(RECORDING_DEBOUNCE_SEC)
  }

  private onRightPinchUp = () => {
    this.clearRecordingDebounce()
    if (!this.isRecording) return
    this.stopRecordingAndSend()
  }

  private onLeftPinchDown = () => {
    // Only cancel if this is actually a two-hand crop gesture
    // (both thumbs close together), not random hand-tracking jitter.
    const thumbDist = this.leftHand.thumbTip.position.distance(
      this.rightHand.thumbTip.position
    )
    if (thumbDist > 10) return

    this.clearRecordingDebounce()
    if (this.isRecording) {
      this.cancelRecording()
    }
  }

  private clearRecordingDebounce() {
    if (this.recordingDebounceEvent) {
      this.removeEvent(this.recordingDebounceEvent)
      this.recordingDebounceEvent = null
    }
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

  private scheduleResponseTimeout() {
    this.clearResponseTimeout()
    this.responseTimeoutEvent = this.createEvent("DelayedCallbackEvent")
    this.responseTimeoutEvent.bind(() => {
      this.caption.hide()
    })
    this.responseTimeoutEvent.reset(RESPONSE_TIMEOUT_SEC)
  }

  private clearResponseTimeout() {
    if (this.responseTimeoutEvent) {
      this.removeEvent(this.responseTimeoutEvent)
      this.responseTimeoutEvent = null
    }
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
      if (this.showImageAboveCaption) {
        this.showImageAboveCaption = false
        this.animateBackToShrink()
      }
      const clearEvent = this.createEvent("DelayedCallbackEvent")
      clearEvent.bind(() => {
        this.caption.hide()
      })
      clearEvent.reset(2)
      return
    }

    print("Sending query: " + query)
    this.updateCaption("Thinking...")
    this.showLoading()

    if (this.stagedImageTex) {
      this.agent.sendImageWithQuery(this.stagedImageTex, query, (response) => {
        this.hideLoading()
        this.updateCaption(response)
        this.scheduleResponseTimeout()
        this.clearStagedImage(true)
      })
    } else {
      this.agent.sendTextOnly(query, (response) => {
        this.hideLoading()
        this.updateCaption(response)
        this.scheduleResponseTimeout()
      })
    }
  }

  private startRecording() {
    // No need to call stopTranscribing() — startTranscribing()
    // automatically cancels any active session.

    this.clearPendingSendEvent()
    this.clearResponseTimeout()
    this.isWaitingForFinalTranscript = false
    this.isRecording = true
    this.transcript = ""
    this.lockCaptionPose()
    this.updateCaption("Listening...")

    if (this.stagedImageTex) {
      this.showImageAboveCaption = true
      this.animateToListeningScale()
    }

    const options = AsrModule.AsrTranscriptionOptions.create()
    options.mode = AsrModule.AsrMode.HighAccuracy
    options.silenceUntilTerminationMs = 2000

    options.onTranscriptionUpdateEvent.add(
      (eventArgs: AsrModule.TranscriptionUpdateEvent) => {
        this.transcript = eventArgs.text
        const displayText = eventArgs.isFinal ? eventArgs.text : eventArgs.text + "..."
        this.updateCaption(displayText)

        if (eventArgs.isFinal && this.isWaitingForFinalTranscript) {
          this.finalizeStoppedRecording()
        }
      }
    )

    options.onTranscriptionErrorEvent.add(
      (errorCode: AsrModule.AsrStatusCode) => {
        // stopTranscribing() fires an error callback — don't clear
        // finalization state when we intentionally stopped recording.
        if (this.isWaitingForFinalTranscript) return
        print("ASR error: " + errorCode)
        this.isRecording = false
        this.clearPendingSendEvent()
        this.updateCaption("ASR error")
      }
    )

    this.asrModule.startTranscribing(options)
  }

  private stopRecordingAndSend() {
    this.isRecording = false
    this.isWaitingForFinalTranscript = true
    this.asrModule.stopTranscribing().catch(() => {})

    this.clearPendingSendEvent()
    this.pendingSendEvent = this.createEvent("DelayedCallbackEvent")
    this.pendingSendEvent.bind(() => {
      this.finalizeStoppedRecording()
    })
    this.pendingSendEvent.reset(ASR_FINALIZATION_WAIT_SEC)
  }

  private cancelRecording() {
    this.isRecording = false
    this.isWaitingForFinalTranscript = false
    this.asrModule.stopTranscribing().catch(() => {})
    this.clearPendingSendEvent()
    this.caption.hide()
    if (this.showImageAboveCaption) {
      this.showImageAboveCaption = false
      this.animateBackToShrink()
    }
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

import {SIK} from "SpectaclesInteractionKit.lspkg/SIK"
import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"
import {Agent} from "./Agent"
import {CaptionBehavior} from "./CaptionBehavior"

const STAGING_TIMEOUT_SEC = 30
const STAGING_SHRINK_DELAY_SEC = 2
const STAGING_SHRINK_SCALE = 0.3
const ASR_FINALIZATION_WAIT_SEC = 2.35
const ASR_PROCESSING_HINT_DELAY_SEC = 0.45
const RESPONSE_TIMEOUT_SEC = 10
const LISTENING_IMAGE_SCALE_FACTOR = 0.6
const RECORDING_DEBOUNCE_SEC = 0.1
const STAGED_IMAGE_GAP = 1.0

interface StagedImage {
  tex: Texture
  sceneObj: SceneObject | null
  anchorTrans: Transform
  followScale: vec3
  originalScale: vec3
  shrinkCancel: CancelSet
  timeoutEvent: any
}

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
  private lastNonEmptyTranscript: string = ""
  private isRecording: boolean = false

  // Staging state — multiple images in a horizontal tray
  private stagedImages: StagedImage[] = []
  private activeQueryIndex: number = -1
  private activeCaptionPos: vec3 | null = null
  private activeCaptionRot: quat | null = null
  private pendingSendEvent: any = null
  private processingHintEvent: any = null
  private listeningScaleCancel: CancelSet = new CancelSet()
  private isWaitingForFinalTranscript: boolean = false
  private responseTimeoutEvent: any = null
  private recordingDebounceEvent: any = null

  // Camera-follow state for staged image tray
  private camTrans: Transform
  private stagedFollowDistance: number = 60
  private stagedFollowVerticalOffset: number = -15

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
    _captionPos: vec3,
    _captionRot: quat
  ) {
    const entry: StagedImage = {
      tex: imageTex,
      sceneObj: sceneObj,
      anchorTrans: anchorTrans,
      followScale: anchorTrans.getWorldScale(),
      originalScale: anchorTrans.getWorldScale(),
      shrinkCancel: new CancelSet(),
      timeoutEvent: null,
    }

    this.stagedImages.push(entry)
    const count = this.stagedImages.length

    print("Image staged (" + count + " total) — waiting for voice query (" + STAGING_TIMEOUT_SEC + "s)")

    // After STAGING_SHRINK_DELAY_SEC, animate the crop frame smaller
    const shrinkEvent = this.createEvent("DelayedCallbackEvent")
    shrinkEvent.bind(() => {
      this.animateShrinkFor(entry)
    })
    shrinkEvent.reset(STAGING_SHRINK_DELAY_SEC)

    // After STAGING_TIMEOUT_SEC, discard this staged image
    entry.timeoutEvent = this.createEvent("DelayedCallbackEvent")
    entry.timeoutEvent.bind(() => {
      print("Staging timeout — discarding staged image")
      const currentIdx = this.stagedImages.indexOf(entry)
      if (currentIdx >= 0) this.removeStagedImage(currentIdx, true)
    })
    entry.timeoutEvent.reset(STAGING_TIMEOUT_SEC)
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
    if (this.stagedImages.length === 0) return

    const camPos = this.camTrans.getWorldPosition()
    const camForward = this.camTrans.forward
    const camUp = this.camTrans.up
    const camRight = camUp.cross(camForward).normalize()

    const verticalOffset = this.stagedFollowVerticalOffset

    // Compute total width of the horizontal tray
    let totalWidth = 0
    for (const img of this.stagedImages) {
      totalWidth += img.followScale.x
    }
    totalWidth += STAGED_IMAGE_GAP * Math.max(0, this.stagedImages.length - 1)

    const basePos = camPos
      .add(camForward.uniformScale(-this.stagedFollowDistance))
      .add(camUp.uniformScale(verticalOffset))

    const faceRot = quat.lookAt(camForward, vec3.up())

    // Lay out images horizontally, centered on camera forward
    let cursor = 0
    for (const img of this.stagedImages) {
      const halfW = img.followScale.x / 2
      const centerX = -totalWidth / 2 + cursor + halfW
      // Anchor pivot is at the right edge — shift right by halfW
      const anchorX = centerX + halfW

      img.anchorTrans.setWorldPosition(
        basePos.add(camRight.uniformScale(anchorX))
      )
      img.anchorTrans.setWorldRotation(faceRot)
      img.anchorTrans.setWorldScale(img.followScale)

      cursor += img.followScale.x + STAGED_IMAGE_GAP
    }
  }

  private animateShrinkFor(img: StagedImage) {
    img.shrinkCancel.cancel()

    const startScale = img.followScale
    const targetScale = startScale.uniformScale(STAGING_SHRINK_SCALE)

    animate({
      easing: "ease-out-back",
      duration: 0.6,
      update: (t: number) => {
        img.followScale = vec3.lerp(startScale, targetScale, t)
      },
      ended: null,
      cancelSet: img.shrinkCancel,
    })
  }

  private animateToListeningScaleFor(img: StagedImage) {
    img.shrinkCancel.cancel()
    this.listeningScaleCancel.cancel()

    const startScale = img.followScale
    const targetScale = img.originalScale.uniformScale(LISTENING_IMAGE_SCALE_FACTOR)

    animate({
      easing: "ease-out-back",
      duration: 0.4,
      update: (t: number) => {
        img.followScale = vec3.lerp(startScale, targetScale, t)
      },
      ended: null,
      cancelSet: this.listeningScaleCancel,
    })
  }

  private animateBackToShrinkFor(img: StagedImage) {
    this.listeningScaleCancel.cancel()

    const startScale = img.followScale
    const targetScale = img.originalScale.uniformScale(STAGING_SHRINK_SCALE)

    animate({
      easing: "ease-out-back",
      duration: 0.4,
      update: (t: number) => {
        img.followScale = vec3.lerp(startScale, targetScale, t)
      },
      ended: null,
      cancelSet: img.shrinkCancel,
    })
  }

  private removeStagedImage(index: number, destroy: boolean) {
    if (index < 0 || index >= this.stagedImages.length) return
    const img = this.stagedImages[index]

    // Guard against double-destroy
    if (!img.sceneObj && destroy) return

    img.shrinkCancel.cancel()

    if (img.timeoutEvent) {
      this.removeEvent(img.timeoutEvent)
      img.timeoutEvent = null
    }

    if (destroy) {
      const obj = img.sceneObj
      img.sceneObj = null
      const startScale = img.followScale

      animate({
        easing: "ease-in-back",
        duration: 0.3,
        update: (t: number) => {
          img.followScale = vec3.lerp(startScale, vec3.zero(), t)
        },
        ended: () => {
          const currentIdx = this.stagedImages.indexOf(img)
          if (currentIdx >= 0) {
            this.stagedImages.splice(currentIdx, 1)
            if (this.activeQueryIndex >= 0) {
              if (currentIdx < this.activeQueryIndex) {
                this.activeQueryIndex--
              } else if (currentIdx === this.activeQueryIndex) {
                this.activeQueryIndex = -1
              }
            }
          }
          if (obj) obj.destroy()
        },
      })
    } else {
      this.stagedImages.splice(index, 1)
      if (this.activeQueryIndex >= 0) {
        if (index < this.activeQueryIndex) {
          this.activeQueryIndex--
        } else if (index === this.activeQueryIndex) {
          this.activeQueryIndex = -1
        }
      }
    }
  }

  // ── Right-hand pinch-and-hold ASR ────────────────────────────────────

  private onRightPinchDown = () => {
    // Don't start ASR if scanner is active (two-hand crop in progress)
    // or if left hand is also pinching (would be a crop gesture)
    if (this.isScannerActive) return
    if (this.leftHand.isPinching()) return
    if (this.isRecording || this.isWaitingForFinalTranscript) return

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

  private clearProcessingHintEvent() {
    if (this.processingHintEvent) {
      this.removeEvent(this.processingHintEvent)
      this.processingHintEvent = null
    }
  }

  private finalizeStoppedRecording() {
    if (!this.isWaitingForFinalTranscript) return

    this.isWaitingForFinalTranscript = false
    this.clearPendingSendEvent()
    this.clearProcessingHintEvent()

    const query = this.getResolvedTranscript()

    if (!query) {
      print("No speech detected")
      this.updateCaption("No speech detected")
      if (this.activeQueryIndex >= 0 && this.stagedImages[this.activeQueryIndex]) {
        this.animateBackToShrinkFor(this.stagedImages[this.activeQueryIndex])
        this.activeQueryIndex = -1
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

    const activeImg = this.activeQueryIndex >= 0 ? this.stagedImages[this.activeQueryIndex] : null
    if (activeImg) {
      this.agent.sendImageWithQuery(activeImg.tex, query, (response) => {
        this.hideLoading()
        this.updateCaption(response)
        this.scheduleResponseTimeout()
        const idx = this.stagedImages.indexOf(activeImg)
        if (idx >= 0) this.removeStagedImage(idx, true)
      })
    } else {
      this.agent.sendTextOnly(query, (response) => {
        this.hideLoading()
        this.updateCaption(response)
        this.scheduleResponseTimeout()
      })
    }
  }

  private getResolvedTranscript(): string {
    const currentTranscript = this.transcript.trim()
    if (currentTranscript.length > 0) {
      return currentTranscript
    }

    return this.lastNonEmptyTranscript.trim()
  }

  private startRecording() {
    // No need to call stopTranscribing() — startTranscribing()
    // automatically cancels any active session.

    this.clearPendingSendEvent()
    this.clearResponseTimeout()
    this.isWaitingForFinalTranscript = false
    this.isRecording = true
    this.transcript = ""
    this.lastNonEmptyTranscript = ""
    this.lockCaptionPose()
    this.updateCaption("Listening...")

    if (this.stagedImages.length > 0) {
      this.activeQueryIndex = this.stagedImages.length - 1
      const activeImg = this.stagedImages[this.activeQueryIndex]
      if (activeImg.timeoutEvent) {
        this.removeEvent(activeImg.timeoutEvent)
        activeImg.timeoutEvent = null
      }
      this.animateToListeningScaleFor(activeImg)
    }

    print("ASR started — listening...")

    const options = AsrModule.AsrTranscriptionOptions.create()
    options.mode = AsrModule.AsrMode.HighAccuracy
    options.silenceUntilTerminationMs = 2000

    options.onTranscriptionUpdateEvent.add(
      (eventArgs: AsrModule.TranscriptionUpdateEvent) => {
        this.transcript = eventArgs.text || ""

        const trimmedTranscript = this.transcript.trim()
        if (trimmedTranscript.length > 0) {
          this.clearProcessingHintEvent()
          this.lastNonEmptyTranscript = this.transcript
          const displayText = eventArgs.isFinal ? this.transcript : this.transcript + "..."
          this.updateCaption(displayText)
        }

        if (eventArgs.isFinal && this.isWaitingForFinalTranscript) {
          print("ASR final transcript received after release")
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
    print("Pinch released — waiting for ASR finalization")

    if (!this.getResolvedTranscript()) {
      this.clearProcessingHintEvent()
      this.processingHintEvent = this.createEvent("DelayedCallbackEvent")
      this.processingHintEvent.bind(() => {
        this.processingHintEvent = null
        if (!this.isWaitingForFinalTranscript) return
        if (this.getResolvedTranscript()) return
        this.updateCaption("Processing speech...")
      })
      this.processingHintEvent.reset(ASR_PROCESSING_HINT_DELAY_SEC)
    }

    this.clearPendingSendEvent()
    this.pendingSendEvent = this.createEvent("DelayedCallbackEvent")
    this.pendingSendEvent.bind(() => {
      print("ASR finalization timeout — using best available transcript")
      this.asrModule.stopTranscribing().catch(() => {})
      this.finalizeStoppedRecording()
    })
    this.pendingSendEvent.reset(ASR_FINALIZATION_WAIT_SEC)
  }

  private cancelRecording() {
    this.isRecording = false
    this.isWaitingForFinalTranscript = false
    this.asrModule.stopTranscribing().catch(() => {})
    this.clearPendingSendEvent()
    this.clearProcessingHintEvent()
    this.caption.hide()
    if (this.activeQueryIndex >= 0 && this.stagedImages[this.activeQueryIndex]) {
      this.animateBackToShrinkFor(this.stagedImages[this.activeQueryIndex])
      this.activeQueryIndex = -1
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

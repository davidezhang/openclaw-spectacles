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

// Helix gallery layout
const GALLERY_HELIX_RADIUS = 8          // cm — radius of the helix
const GALLERY_HELIX_VERTICAL_STEP = 4  // cm — vertical spacing per item
const GALLERY_HELIX_ANGLE_STEP_DEG = 60  // degrees — angular spacing per item
const GALLERY_ITEM_HEIGHT = 9            // cm — fixed display height; width = height * aspect
const GALLERY_DISTANCE_FROM_CAM = 50     // cm — distance forward from cam at open time
const GALLERY_ROTATION_SPEED_DEG_S = 8   // slow Y-axis rotation
const GALLERY_OPEN_DURATION = 0.5
const GALLERY_GRASP_DEBOUNCE_SEC = 0.6   // ignore repeat grasps within this window

interface StagedImage {
  tex: Texture
  sceneObj: SceneObject | null
  anchorTrans: Transform
  followScale: vec3
  originalScale: vec3
  shrinkCancel: CancelSet
  timeoutEvent: any
}

interface ArchivedImage {
  tex: Texture
  picAnchor: SceneObject
  trans: Transform
  aspectRatio: number
  scaleCancel: CancelSet
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

  // Helix gallery state
  private archivedImages: ArchivedImage[] = []
  private galleryOpen: boolean = false
  private galleryCenter: vec3 = vec3.zero()
  private galleryBaseRot: quat = quat.quatIdentity()
  private gallerySpinAngleDeg: number = 0
  private lastGraspTime: number = -10
  private gestureModule: GestureModule = require("LensStudio:GestureModule")

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
      this.updateGallerySpin()
    })

    if (!this.isEditor) {
      this.rightHand.onPinchDown.add(this.onRightPinchDown)
      this.rightHand.onPinchUp.add(this.onRightPinchUp)
      this.leftHand.onPinchDown.add(this.onLeftPinchDown)

      // Left-hand grasp toggles the spatial gallery (open hand → fist).
      this.gestureModule
        .getGrabBeginEvent(GestureModule.HandType.Left)
        .add(() => this.onLeftGraspBegin())
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
          if (obj) this.archiveScannerObj(img, obj)
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

  private clearAllStagedTimeouts() {
    for (const img of this.stagedImages) {
      if (img.timeoutEvent) {
        this.removeEvent(img.timeoutEvent)
        img.timeoutEvent = null
      }
    }
  }

  private rearmAllStagedTimeouts() {
    for (const img of this.stagedImages) {
      if (img.timeoutEvent) continue // already has a timer
      if (!img.sceneObj) continue     // being destroyed
      img.timeoutEvent = this.createEvent("DelayedCallbackEvent")
      img.timeoutEvent.bind(() => {
        print("Staging timeout — discarding staged image")
        const idx = this.stagedImages.indexOf(img)
        if (idx >= 0) this.removeStagedImage(idx, true)
      })
      img.timeoutEvent.reset(STAGING_TIMEOUT_SEC)
    }
  }

  // ── Spatial helix gallery ───────────────────────────────────────────

  /**
   * Detach the picAnchor child (which carries the captured texture +
   * RoundedRectangleStroke material with feathered edges) from the Scanner
   * shell, destroy the rest of the Scanner, and add it to the archived
   * helix gallery.
   */
  private archiveScannerObj(img: StagedImage, scannerRoot: SceneObject) {
    const picAnchor = img.anchorTrans.getSceneObject()
    if (!picAnchor || isNull(picAnchor)) {
      scannerRoot.destroy()
      return
    }

    // Capture aspect ratio from the live on-stage scale (W, H, 1).
    const onStageScale = img.originalScale
    const aspect = onStageScale.y > 0.0001 ? onStageScale.x / onStageScale.y : 1.0

    // Detach picAnchor from the Scanner shell so we can dispose the shell.
    // setParent(null) re-parents to the scene root and preserves the
    // SceneObject so destroying the Scanner shell below doesn't destroy it.
    picAnchor.setParent(null as unknown as SceneObject)

    // Now safe to destroy the Scanner shell (corners, frame, AI-Caption,
    // loading indicator) without taking the picture with it.
    scannerRoot.destroy()

    const archived: ArchivedImage = {
      tex: img.tex,
      picAnchor: picAnchor,
      trans: img.anchorTrans,
      aspectRatio: aspect,
      scaleCancel: new CancelSet(),
    }

    // Enable two-sided rendering on the actual render child (CameraCrop),
    // not just the ImageAnchor parent.
    this.enableTwoSidedRecursively(picAnchor)

    this.archivedImages.push(archived)
    print("Image archived (" + this.archivedImages.length + " in gallery)")

    if (this.galleryOpen) {
      this.placeArchivedImage(archived, this.archivedImages.length - 1, true)
    } else {
      // Park hidden until the gallery opens.
      picAnchor.enabled = false
    }
  }

  private enableTwoSidedRecursively(obj: SceneObject) {
    const rmv = obj.getComponent("Component.RenderMeshVisual") as RenderMeshVisual
    if (rmv) {
      const count = rmv.getMaterialsCount()
      for (let i = 0; i < count; i++) {
        const mat = rmv.getMaterial(i)
        if (mat && mat.mainPass) {
          mat.mainPass.twoSided = true
        }
      }
      if (rmv.mainPass) {
        rmv.mainPass.twoSided = true
      }
    }

    for (let i = 0; i < obj.getChildrenCount(); i++) {
      this.enableTwoSidedRecursively(obj.getChild(i))
    }
  }

  private onLeftGraspBegin() {
    const now = getTime()
    if (now - this.lastGraspTime < GALLERY_GRASP_DEBOUNCE_SEC) return
    this.lastGraspTime = now

    // Don't toggle while a crop is in progress (both hands engaged).
    if (this.isScannerActive) return
    // Don't toggle while ASR is recording (right pinch held).
    if (this.isRecording || this.isWaitingForFinalTranscript) return

    if (this.galleryOpen) {
      this.closeGallery()
    } else {
      this.openGallery()
    }
  }

  private openGallery() {
    if (this.archivedImages.length === 0) {
      print("Gallery is empty — nothing to show")
      return
    }

    this.galleryOpen = true
    this.gallerySpinAngleDeg = 0

    // World-anchor the helix in front of the user at the moment they open it.
    const camPos = this.camTrans.getWorldPosition()
    const camForward = this.camTrans.forward
    // camForward in Lens Studio points away from the look direction, hence -.
    this.galleryCenter = camPos.add(camForward.uniformScale(-GALLERY_DISTANCE_FROM_CAM))

    print("Opening gallery with " + this.archivedImages.length + " image(s)")

    for (let i = 0; i < this.archivedImages.length; i++) {
      this.placeArchivedImage(this.archivedImages[i], i, true)
    }
  }

  private closeGallery() {
    this.galleryOpen = false
    print("Closing gallery")
    for (const a of this.archivedImages) {
      this.animateArchivedScale(a, 0, () => {
        if (a.picAnchor && !isNull(a.picAnchor)) a.picAnchor.enabled = false
      })
    }
  }

  /**
   * Position one archived image at its slot on the helix.
   * Index drives helix angle + height. If `animateIn` is true, the image
   * scales up from 0 for a "pop in" feel.
   */
  private placeArchivedImage(a: ArchivedImage, index: number, animateIn: boolean) {
    if (!a.picAnchor || isNull(a.picAnchor)) return
    a.picAnchor.enabled = true

    const targetTransform = this.computeHelixTransform(index)
    this.applyArchivedTransform(a, targetTransform)

    if (animateIn) {
      a.trans.setWorldScale(vec3.zero())
      this.animateArchivedScale(a, 1, null)
    } else {
      const scale = this.archivedFinalScale(a)
      a.trans.setWorldScale(scale)
    }
  }

  private archivedFinalScale(a: ArchivedImage): vec3 {
    return new vec3(GALLERY_ITEM_HEIGHT * a.aspectRatio, GALLERY_ITEM_HEIGHT, 1)
  }

  private animateArchivedScale(a: ArchivedImage, targetT: number, onEnded: (() => void) | null) {
    a.scaleCancel.cancel()
    const finalScale = this.archivedFinalScale(a)
    const startScale = a.trans.getWorldScale()
    const endScale = finalScale.uniformScale(targetT)

    animate({
      easing: "ease-out-back",
      duration: GALLERY_OPEN_DURATION,
      update: (t: number) => {
        const scale = vec3.lerp(startScale, endScale, t)
        a.trans.setWorldScale(scale)
      },
      ended: onEnded as any,
      cancelSet: a.scaleCancel,
    })
  }

  private applyArchivedTransform(
    a: ArchivedImage,
    targetTransform: {pos: vec3; rot: quat; normal: vec3}
  ) {
    a.trans.setWorldPosition(targetTransform.pos)
    a.trans.setWorldRotation(targetTransform.rot)
  }

  /**
   * Compute the world transform for slot `index` on the helix, including
   * the current spin angle. The image normal is computed directly from its
   * world-space offset from the helix axis, so the plane is exactly tangent
   * to the helix (normal = radial-out).
   */
  private computeHelixTransform(index: number): {pos: vec3; rot: quat; normal: vec3} {
    const angleDeg = index * GALLERY_HELIX_ANGLE_STEP_DEG + this.gallerySpinAngleDeg
    const angleRad = (angleDeg * Math.PI) / 180

    // Center the helix vertically around 0 across the current item count.
    const total = this.archivedImages.length
    const yOffset = (index - (total - 1) / 2) * GALLERY_HELIX_VERTICAL_STEP

    const sinA = Math.sin(angleRad)
    const cosA = Math.cos(angleRad)

    // World-space helix around a vertical axis through galleryCenter.
    const localOffset = new vec3(GALLERY_HELIX_RADIUS * sinA, yOffset, GALLERY_HELIX_RADIUS * cosA)
    const pos = this.galleryCenter.add(localOffset)

    // Build the image basis the same way PictureBehavior does:
    //   col0 = right, col1 = up, col2 = forward (= right × up, points out
    //   of the image plane toward viewer of front face).
    // We want the image's outward face (+Z local) to point exactly radially
    // out from the helix axis.
    const radialOut = new vec3(sinA, 0, cosA).normalize()
    const worldUp = vec3.up()
    const worldRight = worldUp.cross(radialOut).normalize()

    const rotMat = new mat3()
    rotMat.column0 = worldRight
    rotMat.column1 = worldUp
    rotMat.column2 = radialOut
    const rot = quat.fromRotationMat(rotMat)

    return {pos, rot, normal: radialOut}
  }

  private updateGallerySpin() {
    if (!this.galleryOpen) return
    if (this.archivedImages.length === 0) return

    this.gallerySpinAngleDeg += GALLERY_ROTATION_SPEED_DEG_S * getDeltaTime()
    if (this.gallerySpinAngleDeg > 360) this.gallerySpinAngleDeg -= 360

    for (let i = 0; i < this.archivedImages.length; i++) {
      const a = this.archivedImages[i]
      if (!a.picAnchor || isNull(a.picAnchor)) continue
      // Skip if a scale animation is currently driving the transform.
      const t = this.computeHelixTransform(i)
      this.applyArchivedTransform(a, t)
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
      this.rearmAllStagedTimeouts()
      const clearEvent = this.createEvent("DelayedCallbackEvent")
      clearEvent.bind(() => {
        this.caption.hide()
      })
      clearEvent.reset(2)
      return
    }

    print("Sending query: " + query)
    this.updateCaption("Thinking...")

    const activeImg = this.activeQueryIndex >= 0 ? this.stagedImages[this.activeQueryIndex] : null
    if (activeImg) {
      this.agent.sendImageWithQuery(activeImg.tex, query, (response) => {
        this.updateCaption(response)
        this.scheduleResponseTimeout()
        const idx = this.stagedImages.indexOf(activeImg)
        if (idx >= 0) this.removeStagedImage(idx, true)
        this.rearmAllStagedTimeouts()
      })
    } else {
      this.agent.sendTextOnly(query, (response) => {
        this.updateCaption(response)
        this.scheduleResponseTimeout()
        this.rearmAllStagedTimeouts()
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
      // Pause timeouts for ALL staged images while recording
      this.clearAllStagedTimeouts()
      this.activeQueryIndex = this.stagedImages.length - 1
      this.animateToListeningScaleFor(this.stagedImages[this.activeQueryIndex])
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
    this.rearmAllStagedTimeouts()
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

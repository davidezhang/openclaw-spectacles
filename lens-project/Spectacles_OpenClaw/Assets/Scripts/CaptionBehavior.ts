import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"

@component
export class CaptionBehavior extends BaseScriptComponent {
  @input captionText: Text
  @input scaleObj: SceneObject
  @input
  @allowUndefined
  followTargetObj: SceneObject

  private trans: Transform
  private scaleTrans: Transform
  private startPos: vec3
  private followTarget: Transform | null = null
  private followDistance: number = 60
  private followVerticalOffset: number = -8
  private updateEvent: SceneEvent | null = null

  private scaleCancel: CancelSet = new CancelSet()

  private isVisible: boolean = false

  onAwake() {
    this.trans = this.getSceneObject().getTransform()
    this.scaleTrans = this.scaleObj.getTransform()
    this.scaleTrans.setLocalScale(vec3.zero())
    this.followTarget = this.followTargetObj ? this.followTargetObj.getTransform() : null

    this.updateEvent = this.createEvent("UpdateEvent")
    this.updateEvent.bind(() => {
      this.updateFollowTransform()
    })
  }


  private updateFollowTransform() {
    if (!this.isVisible || !this.followTarget) return

    const camPos = this.followTarget.getWorldPosition()
    const camForward = this.followTarget.forward
    const camUp = this.followTarget.up

    this.trans.setWorldPosition(
      camPos
        .add(camForward.uniformScale(-this.followDistance))
        .add(camUp.uniformScale(this.followVerticalOffset))
    )
    this.trans.setWorldRotation(quat.lookAt(camForward, vec3.up()))
    this.trans.setWorldScale(vec3.one().uniformScale(0.5))
  }

  openCaption(text: string, pos: vec3, rot: quat) {
    this.startPos = pos
    this.captionText.text = text
    this.isVisible = true
    this.updateFollowTransform()
    if (!this.followTarget) {
      this.trans.setWorldPosition(pos)
      this.trans.setWorldRotation(rot)
      this.trans.setWorldScale(vec3.one().uniformScale(0.5))
    }
    //animate in caption
    if (this.scaleCancel) this.scaleCancel.cancel()
    animate({
      easing: "ease-out-elastic",
      duration: 1,
      update: (t: number) => {
        this.scaleTrans.setLocalScale(vec3.lerp(vec3.zero(), vec3.one().uniformScale(1.33), t))
      },
      ended: null,
      cancelSet: this.scaleCancel
    })
  }

  // Update text immediately without an intro animation.
  setText(text: string, pos: vec3, rot: quat) {
    this.captionText.text = text
    if (!this.isVisible) {
      this.isVisible = true
      if (this.scaleCancel) this.scaleCancel.cancel()
      this.scaleTrans.setLocalScale(vec3.one().uniformScale(1.33))
    }

    this.updateFollowTransform()
    if (!this.followTarget) {
      this.trans.setWorldPosition(pos)
      this.trans.setWorldRotation(rot)
      this.trans.setWorldScale(vec3.one().uniformScale(0.5))
    }
  }

  // Scale to zero and clear text.
  hide() {
    if (!this.isVisible) return
    this.isVisible = false
    if (this.scaleCancel) this.scaleCancel.cancel()
    const startScale = this.scaleTrans.getLocalScale()
    animate({
      easing: "ease-in-back",
      duration: 0.2,
      update: (t: number) => {
        this.scaleTrans.setLocalScale(vec3.lerp(startScale, vec3.zero(), t))
      },
      ended: () => {
        this.captionText.text = ""
      },
      cancelSet: this.scaleCancel
    })
  }
}

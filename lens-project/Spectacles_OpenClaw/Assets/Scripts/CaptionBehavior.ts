import animate, {CancelSet} from "SpectaclesInteractionKit.lspkg/Utils/animate"

@component
export class CaptionBehavior extends BaseScriptComponent {
  @input captionText: Text
  @input scaleObj: SceneObject

  private trans: Transform
  private scaleTrans: Transform
  private startPos: vec3

  private scaleCancel: CancelSet = new CancelSet()

  private isVisible: boolean = false

  onAwake() {
    this.trans = this.getSceneObject().getTransform()
    this.scaleTrans = this.scaleObj.getTransform()
    this.scaleTrans.setLocalScale(vec3.zero())
  }

  openCaption(text: string, pos: vec3, rot: quat) {
    this.startPos = pos
    this.captionText.text = text
    this.trans.setWorldPosition(pos)
    this.trans.setWorldRotation(rot)
    this.trans.setWorldScale(vec3.one().uniformScale(0.5))
    this.isVisible = true
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
    this.trans.setWorldPosition(pos)
    this.trans.setWorldRotation(rot)
    this.trans.setWorldScale(vec3.one().uniformScale(0.5))
    if (!this.isVisible) {
      this.isVisible = true
      if (this.scaleCancel) this.scaleCancel.cancel()
      this.scaleTrans.setLocalScale(vec3.one().uniformScale(1.33))
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

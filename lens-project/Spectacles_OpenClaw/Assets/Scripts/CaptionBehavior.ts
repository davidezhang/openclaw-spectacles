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
  @input followVerticalOffset: number = -8
  private updateEvent: SceneEvent | null = null

  private scaleCancel: CancelSet = new CancelSet()

  private isVisible: boolean = false

  onHidden: (() => void) | null = null
  onSizeChanged: (() => void) | null = null

  // Auto-resize tile background
  @input halfWidth: number = 7
  @input baseHalfHeight: number = 1.85
  @input padding: number = 0.4
  @input cornerRadius: number = 0.5

  private tileVisual: RenderMeshVisual | null = null
  private meshBuilder: MeshBuilder | null = null
  private needsSizeUpdate: boolean = false
  currentHalfHeight: number = 1.85

  onAwake() {
    this.trans = this.getSceneObject().getTransform()
    this.scaleTrans = this.scaleObj.getTransform()
    this.scaleTrans.setLocalScale(vec3.zero())
    this.followTarget = this.followTargetObj ? this.followTargetObj.getTransform() : null

    this.setupTileMesh()

    this.updateEvent = this.createEvent("UpdateEvent")
    this.updateEvent.bind(() => {
      this.updateFollowTransform()
      if (this.needsSizeUpdate) {
        this.needsSizeUpdate = false
        this.updateTileSize()
      }
    })
  }

  private setupTileMesh() {
    this.tileVisual = this.scaleObj.getComponent("Component.RenderMeshVisual")
    if (!this.tileVisual) return

    this.meshBuilder = new MeshBuilder([
      { name: "position", components: 3 },
      { name: "normal", components: 3 },
      { name: "texture0", components: 2 },
    ])
    this.meshBuilder.topology = MeshTopology.Triangles
    this.meshBuilder.indexType = MeshIndexType.UInt16

    this.buildRoundedRectMesh(this.halfWidth, this.baseHalfHeight)
    this.tileVisual.mesh = this.meshBuilder.getMesh()
  }

  private readonly CORNER_SEGMENTS = 8

  private buildRoundedRectMesh(hw: number, hh: number) {
    const r = Math.min(this.cornerRadius, hw, hh)
    const mb = this.meshBuilder!
    const segs = this.CORNER_SEGMENTS

    if (mb.getVerticesCount() > 0) mb.eraseVertices(0, mb.getVerticesCount())
    if (mb.getIndicesCount() > 0) mb.eraseIndices(0, mb.getIndicesCount())

    // Center vertex
    const verts: number[] = [0, 0, 0, 0, 0, 1, 0.5, 0.5]
    const centerIdx = 0

    // Build perimeter vertices: 4 corners in CCW order, each with `segs` arc segments
    // Order: TR → TL → BL → BR so perimeter is continuous
    const corners = [
      { cx:  hw - r, cy:  hh - r, startAngle: 0 },              // top-right
      { cx: -hw + r, cy:  hh - r, startAngle: Math.PI / 2 },    // top-left
      { cx: -hw + r, cy: -hh + r, startAngle: Math.PI },        // bottom-left
      { cx:  hw - r, cy: -hh + r, startAngle: 3 * Math.PI / 2 }, // bottom-right
    ]

    for (const corner of corners) {
      for (let i = 0; i <= segs; i++) {
        const angle = corner.startAngle + (i / segs) * (Math.PI / 2)
        const x = corner.cx + r * Math.cos(angle)
        const y = corner.cy + r * Math.sin(angle)
        const u = (x + hw) / (2 * hw)
        const v = (y + hh) / (2 * hh)
        verts.push(x, y, 0, 0, 0, 1, u, v)
      }
    }
    mb.appendVerticesInterleaved(verts)

    // Fan triangles from center to perimeter
    const perimCount = 4 * (segs + 1)
    const indices: number[] = []
    for (let i = 0; i < perimCount; i++) {
      const curr = 1 + i
      const next = 1 + ((i + 1) % perimCount)
      indices.push(centerIdx, curr, next)
    }
    mb.appendIndices(indices)
  }

  private updateTileSize() {
    if (!this.meshBuilder || !this.tileVisual) return
    if (!this.captionText.text || this.captionText.text.length === 0) return

    const bbox = this.captionText.getBoundingBox()
    const textHeight = bbox.top - bbox.bottom
    const neededHalfHeight = Math.max(
      this.baseHalfHeight,
      textHeight / 2 + this.padding
    )

    this.currentHalfHeight = neededHalfHeight

    // Expand text layout rect to fit content
    this.captionText.worldSpaceRect = Rect.create(
      -this.halfWidth, this.halfWidth,
      -neededHalfHeight, neededHalfHeight
    )

    // Rebuild background mesh to match
    this.buildRoundedRectMesh(this.halfWidth, neededHalfHeight)
    this.meshBuilder.updateMesh()

    if (this.onSizeChanged) this.onSizeChanged()
  }

  private resetTileSize() {
    if (!this.meshBuilder || !this.tileVisual) return
    this.captionText.worldSpaceRect = Rect.create(
      -this.halfWidth, this.halfWidth,
      -this.baseHalfHeight, this.baseHalfHeight
    )
    this.buildRoundedRectMesh(this.halfWidth, this.baseHalfHeight)
    this.meshBuilder.updateMesh()
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
    this.needsSizeUpdate = true
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
    this.needsSizeUpdate = true
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
        this.resetTileSize()
        if (this.onHidden) this.onHidden()
      },
      cancelSet: this.scaleCancel
    })
  }
}

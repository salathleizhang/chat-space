import type { Vec3 } from "../../../shared/lib/cameraRig";
import {
  boundsCenter, boundsSize, BOX_PADDING_RATIO, HIGHLIGHT_COLOR, highlightAppearance,
  paddedBounds, UNIT_CUBE_EDGE_POSITIONS, type Bounds3, type Highlight,
} from "./selectionBounds";

/**
 * 选中/悬浮**线框包围盒**的引擎绑定：一个持久实体 + 一条 12 棱的 line 网格。
 *
 * ### 三条关键决定（都有代价对照）
 * ① **持久网格，不用 `app.drawWireAlignedBox()`**：引擎确实自带一个线框盒绘制器
 *    （`immediate.js` 的 `drawWireAlignedBox`），但那是**立即模式**——每帧都要重新提交
 *    （静止场景里也跑）。three 侧的高亮盒是持久对象，这里跟它对齐：建一次网格，
 *    之后 `set(bounds)` 只改实体的位置与缩放（单位立方体棱网格 × 缩放）。
 * ② **层要 `clearDepthBuffer: true`** ⇒ 等价于 three 侧的 `material-depthTest={false}`：
 *    选中反馈要在任意视角都读得到，不该被模型正面挡住（gizmo/HUD 用的是同一条）。
 * ③ **`meshInstance.pick = false` 不是可选项**：three 侧那段注释写得很清楚——由指针状态
 *    产生的视觉反馈**绝不能反过来参与命中判定**，否则状态与命中区互为因果（悬停进出不是同一条
 *    边界、还会把相邻模型的点击截走）。
 */

export interface WireframeLayer {
  id: number;
  layer: unknown;
}

/** 线框对象的最小接口（测试注入点）。 */
export interface WireframeObjectLike {
  setTransform(center: Vec3, size: Vec3): void;
  setVisible(visible: boolean): void;
  setOpacity(opacity: number): void;
  /** 这条网格里还有没有可被拾取的实例——必须是 0。 */
  pickableCount(): number;
  instanceCount(): number;
  destroy(): void;
}

export interface SelectionWireframeOptions {
  /** 建层（引擎侧应给 `clearDepthBuffer: true`，见文件头 ②）。 */
  createLayer(): WireframeLayer;
  /** 删层：引擎的实体销毁不会删层（同 gizmo 那条约束）。 */
  removeLayer(layer: WireframeLayer): void;
  addChild(child: unknown): void;
  createObject?(layer: WireframeLayer): WireframeObjectLike;
}

export interface SelectionWireframeHandle {
  /** 层 id——**必须交给 `PaneSpec.extraLayerIds`**（否则下次 sync 会被 `camera.layers` 覆盖）。 */
  layerId(): number | null;
  /** 摆到某一个盒上；传 null 隐藏。`style` 决定透明度（hover 淡、selected 实）。 */
  set(bounds: Bounds3 | null, style: Highlight, paddingRatio?: number): void;
  bounds(): Bounds3 | null;
  style(): Highlight;
  visible(): boolean;
  /** 当前线框实体中心/尺寸（探针核对用）。 */
  transform(): { center: Vec3; size: Vec3 } | null;
  /** 有没有可被拾取的实例（必须恒为 0）。 */
  pickableCount(): number;
  /** 当前挂了几段线（探针核对几何用；同样是"引擎事实"，不是自述）。 */
  instanceCount(): number;
  dispose(): void;
}

export async function createSelectionWireframe(
  app: unknown,
  options: SelectionWireframeOptions,
): Promise<SelectionWireframeHandle> {
  let createObject = options.createObject;
  if (!createObject) {
    const pc = await import("playcanvas");
    createObject = (layer) => {
      const { Entity, Mesh, MeshInstance, StandardMaterial, Color, BLEND_NORMAL } = pc;
      const device = (app as { graphicsDevice: unknown }).graphicsDevice;
      const mesh = new Mesh(device as never);
      mesh.clear(true, false);
      mesh.setPositions([...UNIT_CUBE_EDGE_POSITIONS]);
      mesh.update((pc as unknown as { PRIMITIVE_LINES: number }).PRIMITIVE_LINES);
      const material = new StandardMaterial();
      material.useLighting = false; // 纯色高亮，不吃光照
      material.diffuse = new Color(0, 0, 0);
      material.emissive = new Color(HIGHLIGHT_COLOR[0], HIGHLIGHT_COLOR[1], HIGHLIGHT_COLOR[2]);
      material.opacity = 1;
      material.blendType = BLEND_NORMAL;
      material.depthWrite = false;
      material.update();
      const entity = new Entity("selection-wireframe");
      (entity as unknown as { layers: number[] }).layers = [layer.id];
      const instance = new MeshInstance(mesh as never, material as never, entity as never);
      // ③ 视觉反馈绝不参与命中判定
      instance.pick = false;
      entity.addComponent("render", {});
      if (entity.render) entity.render.meshInstances = [instance as never];
      options.addChild(entity);
      return {
        setTransform(center, size) {
          entity.setPosition(center[0], center[1], center[2]);
          entity.setLocalScale(size[0], size[1], size[2]);
        },
        setVisible(visible) { entity.enabled = visible; },
        setOpacity(opacity) {
          material.opacity = opacity;
          material.update();
        },
        pickableCount: () => (instance.pick === false ? 0 : 1),
        instanceCount: () => (entity.render?.meshInstances?.length ?? 0),
        destroy() {
          mesh.destroy();
          material.destroy();
          entity.destroy();
        },
      };
    };
  }

  let layer: WireframeLayer | null = null;
  let object: WireframeObjectLike | null = null;
  let current: Bounds3 | null = null;
  let currentStyle: Highlight = "none";

  const ensure = () => {
    if (object) return object;
    layer = options.createLayer();
    object = createObject!(layer);
    object.setVisible(false);
    return object;
  };

  return {
    layerId: () => layer?.id ?? null,
    set(bounds, style, paddingRatio = BOX_PADDING_RATIO) {
      currentStyle = style;
      current = bounds ? paddedBounds(bounds, paddingRatio) : null;
      const appearance = highlightAppearance(style);
      if (!current || !appearance.visible) {
        if (object) object.setVisible(false);
        else if (style !== "none") ensure().setVisible(false);
        return;
      }
      const target = ensure();
      target.setTransform(boundsCenter(current), boundsSize(current));
      target.setOpacity(appearance.opacity);
      target.setVisible(true);
    },
    bounds: () => current,
    style: () => currentStyle,
    visible: () => current !== null && highlightAppearance(currentStyle).visible,
    transform() {
      if (!current || !object) return null;
      return { center: boundsCenter(current), size: boundsSize(current) };
    },
    pickableCount: () => object?.pickableCount() ?? 0,
    instanceCount: () => object?.instanceCount() ?? 0,
    dispose() {
      object?.destroy();
      object = null;
      if (layer) options.removeLayer(layer);
      layer = null;
      current = null;
      currentStyle = "none";
    },
  };
}

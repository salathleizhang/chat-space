import { INSPECTION_VIEWS, composeInspectionSheet, sheetToBase64, SHEET_TILE, type InspectionView } from "../../../shared/lib/inspectionSheet";
import { captureSceneThroughQueue } from "./captureViaQueue";

/**
 * PlayCanvas 侧的**四视角检查图**：ISO / 前 / 右 / 顶，拼成 2×2 并加标注。
 *
 * 视角语义与 2×2 版式都在纯模块 `shared/lib/inspectionSheet.ts` 里，两个引擎共用同一份——
 * 本文件只负责引擎相关的那一步：**把相机摆到某个视角**，以及逐视角走准入层截图。
 *
 * ### 相机数学对齐 three 侧（`inspectionViews.ts`）
 *  - `fitDistance = (radius / tan(fov·π/360)) × 1.35`——同一个 1.35 余量，
 *    否则两个引擎出来的检查图构图会不一样。
 *  - ISO 用透视、三个轴向用**正交**；正交的半高取 `radius × 1.35`
 *    （three 侧是 `left/right/top/bottom = ±radius×1.35`，半高同值）。
 *  - TOP 的上方向是 `(0,0,-1)`：沿 -Y 俯视时屏幕上方为 -Z。若沿用 Y-up 再偏移 X/Z
 *    会产生约 45° 滚转。
 *
 * ### 为什么要一台**专用**相机
 * 不改用户那台相机的投影/机位：截图期间可见帧循环可能还在跑，改它会把用户的预览视角也掰走。
 * 专用相机只挂在 world 层（`layers = [0]`），所以检查图里没有 gizmo/坐标轴球这些 HUD。
 */

export interface InspectionFrame {
  /** 被拍对象的中心（世界坐标）。 */
  center: [number, number, number];
  /** 包围球半径。 */
  radius: number;
}

export interface InspectionCaptureOptions {
  /** 每格边长，默认 `SHEET_TILE`（512）。 */
  tile?: number;
  /** 透视视角用的 fov，默认 60（与 three 侧相机默认一致）。 */
  fov?: number;
  /** 需要画面的投影类型；缺省时用相机的默认透视。 */
  onProgress?: (stage: string) => void;
}

interface CameraLike {
  projection: number;
  fov: number;
  orthoHeight: number;
  nearClip: number;
  farClip: number;
  layers: number[];
}

interface EntityLike {
  camera: CameraLike;
  up: { set(x: number, y: number, z: number): void };
  setPosition(x: number, y: number, z: number): void;
  lookAt(x: number, y: number, z: number): void;
  destroy(): void;
  enabled: boolean;
}

/**
 * 拍一组四视角检查图，返回**不含 `data:` 前缀**的 PNG base64。
 * 任何一步失败都直接抛出（调用方负责回传"截图失败"，别让 agent 干等）。
 */
export async function captureInspectionSheet(app: unknown, frame: InspectionFrame, options: InspectionCaptureOptions = {}): Promise<string> {
  const pc = await import("playcanvas");
  const { Entity, Vec3, PROJECTION_PERSPECTIVE, PROJECTION_ORTHOGRAPHIC, LAYERID_WORLD } = pc;
  const application = app as { root: { addChild(child: unknown): void } };
  const tile = options.tile ?? SHEET_TILE;
  const fov = options.fov ?? 60;
  const radius = Math.max(frame.radius, 1e-3);
  const center = new Vec3(...frame.center);
  const fitDistance = (radius / Math.tan((fov * Math.PI) / 360)) * 1.35;

  const entity = new Entity("inspection-camera") as unknown as EntityLike;
  (entity as unknown as { addComponent(type: string, options: Record<string, unknown>): void })
    .addComponent("camera", { fov, clearColor: new pc.Color(0.05, 0.05, 0.06) });
  (entity as unknown as { camera: CameraLike }).camera.layers = [LAYERID_WORLD];
  application.root.addChild(entity);

  try {
    const images: { image: CanvasImageSource }[] = [];
    for (const view of INSPECTION_VIEWS) {
      applyView(entity, view, center, fitDistance, radius, fov, PROJECTION_PERSPECTIVE, PROJECTION_ORTHOGRAPHIC);
      options.onProgress?.(`capture ${view.label}`);
      const shot = await captureSceneThroughQueue(app, {
        size: tile,
        priority: "inspection",
        camera: entity.camera,
      });
      // 逐视角独立走队列：每张都是一次完整的"预约 → 渲染 → 读回 → 释放"，
      // 所以四张不会同时占着四块显存（这正是尺寸阶梯与预算存在的意义）。
      images.push({ image: pixelsToCanvas(shot.rgba, shot.width, shot.height) });
    }
    return sheetToBase64(composeInspectionSheet(images, tile));
  } finally {
    entity.destroy();
  }
}

function applyView(
  entity: EntityLike,
  view: InspectionView,
  center: { x: number; y: number; z: number },
  fitDistance: number,
  radius: number,
  fov: number,
  perspective: number,
  orthographic: number,
): void {
  const camera = entity.camera;
  camera.nearClip = 0.001;
  camera.farClip = fitDistance + radius * 2;
  if (view.projection === "perspective") {
    camera.projection = perspective;
    camera.fov = fov;
  } else {
    camera.projection = orthographic;
    // three 侧是 left/right/top/bottom = ±radius×1.35，半高就是 radius×1.35
    camera.orthoHeight = radius * 1.35;
  }
  entity.up.set(view.up[0], view.up[1], view.up[2]);
  const [dx, dy, dz] = view.dir;
  const length = Math.hypot(dx, dy, dz) || 1;
  entity.setPosition(
    center.x + (dx / length) * fitDistance,
    center.y + (dy / length) * fitDistance,
    center.z + (dz / length) * fitDistance,
  );
  entity.lookAt(center.x, center.y, center.z);
}

/** 把读回的紧凑 RGBA 放进一张 canvas，供合成器绘制。 */
function pixelsToCanvas(rgba: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("inspection: 2D context unavailable");
  // 拷一份成 `Uint8ClampedArray<ArrayBuffer>`：直接拿 `rgba.buffer` 视图会带上
  // `ArrayBufferLike`（可能是 SharedArrayBuffer），`ImageData` 不接受。
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return canvas;
}

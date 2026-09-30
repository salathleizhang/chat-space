import { orthoHalfHeight, rigPosition, type CameraRig } from "../../../shared/lib/cameraRig";

/**
 * 把纯相机台架的状态写到 PlayCanvas 实体上。
 *
 * 骨架很薄是刻意的：判断（钳制、乘性缩放、平移换算、聚焦距离）全在 `shared/lib/cameraRig.ts`
 * 里并被单测覆盖；这里只回答"写哪个属性"。
 *
 * ### 与 three 侧的一处净简化
 * `camera.orthoHeight` 是**世界单位的半高**，所以正交窗格直接写常量 `7.5` 就满足
 * "竖直恒定可见 15 个世界单位"。three 侧因为 drei 把视锥按像素重设，必须每帧用
 * `zoom = 窗格像素高 / 15` 反推（`PaneCamera.tsx` 的 `OrthoZoomSync`）——**那一整段没有了**。
 * 宽高比由 `camera.rect` + `calculateAspectRatio()` 负责，这里不要碰。
 */

export interface RigEntityLike {
  up: { set(x: number, y: number, z: number): void };
  setPosition(x: number, y: number, z: number): void;
  lookAt(x: number, y: number, z: number): void;
  camera: {
    projection: number;
    fov: number;
    orthoHeight: number;
    nearClip: number;
    farClip: number;
  };
}

/** 三个轴向正交机位各自的上方向（读自 `PaneCamera.tsx` 的 `ORTHO_RIGS`）。 */
export const ORTHO_UP: Record<"top" | "front" | "right", [number, number, number]> = {
  top: [0, 0, -1],
  front: [0, 1, 0],
  right: [0, 1, 0],
};

export interface ApplyRigOptions {
  /** 引擎的 `PROJECTION_PERSPECTIVE` / `PROJECTION_ORTHOGRAPHIC` 常量。 */
  perspective: number;
  orthographic: number;
  /** 上方向覆盖；不传就用 `(0,1,0)`。俯视窗格必须传 `ORTHO_UP.top`。 */
  up?: [number, number, number];
  nearClip?: number;
  farClip?: number;
}

export function applyRig(entity: RigEntityLike, rig: CameraRig, options: ApplyRigOptions): void {
  const camera = entity.camera;
  if (rig.projection === "orthographic") {
    camera.projection = options.orthographic;
    camera.orthoHeight = orthoHalfHeight();
  } else {
    camera.projection = options.perspective;
    camera.fov = rig.fov;
  }
  camera.nearClip = options.nearClip ?? Math.max(rig.distance / 1000, 0.01);
  camera.farClip = options.farClip ?? Math.max(rig.distance * 20, 100);

  const up = options.up ?? [0, 1, 0];
  entity.up.set(up[0], up[1], up[2]);
  const [x, y, z] = rigPosition(rig);
  entity.setPosition(x, y, z);
  entity.lookAt(rig.target[0], rig.target[1], rig.target[2]);
}

import type * as THREE from "three";

/**
 * 一个窗格的轨道控制器里**贴近检查真正需要的那三样**。
 *
 * 为什么不直接写 `ComponentRef<typeof OrbitControls>`：需要它的两处（`PaneCamera` 交出去、
 * `CloseupInspectionRig` 用它飞行）都不该为了一个类型把 drei 的组件类型拖进依赖图；
 * 而这个结构就是"能读位置/注视点、能动相机"的最小事实。
 */
export interface PaneControls {
  /** 该窗格当前实际的相机（透视/正交都可能是它——投影可随时切换） */
  object: THREE.Camera;
  /** 轨道注视点：与 `object.position` 一起才构成"用户在看的这一帧" */
  target: THREE.Vector3;
  /** 写完 position/target 必须调一次，否则画面上不动（OrbitControls 的惯例） */
  update(): void;
}

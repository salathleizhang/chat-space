import * as THREE from "three";

interface InspectionView {
  label: string;
  dir: [number, number, number];
  up: [number, number, number];
  projection: "perspective" | "orthographic";
}

/** 与检查图提示词一致：ISO/前/右/顶；轴向视图不添加俯角。 */
export const INSPECTION_VIEWS: InspectionView[] = [
  { label: "ISO", dir: [1, 0.8, 1], up: [0, 1, 0], projection: "perspective" },
  { label: "FRONT", dir: [0, 0, 1], up: [0, 1, 0], projection: "orthographic" },
  { label: "RIGHT", dir: [1, 0, 0], up: [0, 1, 0], projection: "orthographic" },
  // 俯视沿 -Y 看，屏幕上方为 -Z，与主视口一致。
  // 不能沿用 Y-up 再偏移 X/Z 来避开共线，否则会产生约 45° 的滚转。
  { label: "TOP", dir: [0, 1, 0], up: [0, 0, -1], projection: "orthographic" },
];

export function createInspectionCamera(
  source: THREE.PerspectiveCamera,
  view: InspectionView,
  center: THREE.Vector3,
  radius: number,
) {
  const safeRadius = Math.max(radius, 1e-3);
  const fitDistance = (safeRadius / Math.tan((source.fov * Math.PI) / 360)) * 1.35;
  const camera = view.projection === "perspective"
    ? source.clone()
    : new THREE.OrthographicCamera(
        -safeRadius * 1.35,
        safeRadius * 1.35,
        safeRadius * 1.35,
        -safeRadius * 1.35,
        0.001,
        fitDistance + safeRadius * 2,
      );
  setInspectionView(camera, view, center, fitDistance);
  camera.updateProjectionMatrix();
  return camera;
}

export function setInspectionView(
  camera: THREE.Camera,
  view: InspectionView,
  center: THREE.Vector3,
  distance: number,
) {
  camera.up.set(...view.up);
  camera.position.copy(center).addScaledVector(new THREE.Vector3(...view.dir).normalize(), distance);
  camera.lookAt(center);
  camera.updateMatrixWorld();
}

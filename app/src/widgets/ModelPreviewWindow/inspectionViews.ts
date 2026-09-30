import * as THREE from "three";
// 视角定义是**纯数据**，已搬到 shared/lib/inspectionSheet.ts，与 PlayCanvas 侧共用同一份。
// 本文件只剩 three 相关的"把相机摆到某个视角"。
import { INSPECTION_VIEWS, type InspectionView } from "../../shared/lib/inspectionSheet";

export { INSPECTION_VIEWS, type InspectionView };

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

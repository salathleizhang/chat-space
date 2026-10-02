import type { OrbitControls } from "@react-three/drei/core/OrbitControls";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ComponentRef, type RefObject } from "react";
import {
  dampToward,
  hasArrived,
  FLIGHT_DAMP_LAMBDA,
} from "../../shared/lib/cameraFlight";

export interface CameraTarget {
  camPos: [number, number, number];
  lookAt: [number, number, number];
}

/**
 * 相机飞行：focusKey 变化时（不含首次挂载）启动缓动，
 * 每帧从 targetRef 读最新目标值（避免场景刷新导致的坐标对象换引用触发误动画）。
 * 只挂在透视窗格：正交窗格的平移/缩放保持独立，不随聚焦联动。
 */
export function CameraRig({
  focusKey,
  targetRef,
  controlsRef,
}: {
  focusKey: string;
  targetRef: RefObject<CameraTarget>;
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const animating = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    animating.current = true;
    invalidate();
  }, [focusKey, invalidate]);

  useFrame((state, delta) => {
    if (!animating.current) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const { camPos, lookAt } = targetRef.current;

    camera.position.x = dampToward(camera.position.x, camPos[0], FLIGHT_DAMP_LAMBDA, delta);
    camera.position.y = dampToward(camera.position.y, camPos[1], FLIGHT_DAMP_LAMBDA, delta);
    camera.position.z = dampToward(camera.position.z, camPos[2], FLIGHT_DAMP_LAMBDA, delta);
    controls.target.x = dampToward(controls.target.x, lookAt[0], FLIGHT_DAMP_LAMBDA, delta);
    controls.target.y = dampToward(controls.target.y, lookAt[1], FLIGHT_DAMP_LAMBDA, delta);
    controls.target.z = dampToward(controls.target.z, lookAt[2], FLIGHT_DAMP_LAMBDA, delta);
    controls.update();

    const dx = camera.position.x - camPos[0];
    const dy = camera.position.y - camPos[1];
    const dz = camera.position.z - camPos[2];
    if (hasArrived(dx, dy, dz)) animating.current = false;
    else state.invalidate();
  });

  return null;
}

import type { OrbitControls } from "@react-three/drei/core/OrbitControls";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ComponentRef, type RefObject } from "react";
import * as THREE from "three";

export interface CameraTarget {
  camPos: [number, number, number];
  lookAt: [number, number, number];
}

/** 相机飞行缓动系数（越大越快收敛），越小的距离阈值判定为"到达" */
const DAMP_LAMBDA = 4;
const ARRIVE_DISTANCE_SQ = 0.0004;

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

    camera.position.x = THREE.MathUtils.damp(camera.position.x, camPos[0], DAMP_LAMBDA, delta);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, camPos[1], DAMP_LAMBDA, delta);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, camPos[2], DAMP_LAMBDA, delta);
    controls.target.x = THREE.MathUtils.damp(controls.target.x, lookAt[0], DAMP_LAMBDA, delta);
    controls.target.y = THREE.MathUtils.damp(controls.target.y, lookAt[1], DAMP_LAMBDA, delta);
    controls.target.z = THREE.MathUtils.damp(controls.target.z, lookAt[2], DAMP_LAMBDA, delta);
    controls.update();

    const dx = camera.position.x - camPos[0];
    const dy = camera.position.y - camPos[1];
    const dz = camera.position.z - camPos[2];
    if (dx * dx + dy * dy + dz * dz < ARRIVE_DISTANCE_SQ) animating.current = false;
    else state.invalidate();
  });

  return null;
}

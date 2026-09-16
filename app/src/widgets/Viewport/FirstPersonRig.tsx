import { PointerLockControls } from "@react-three/drei/core/PointerLockControls";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, type ComponentRef } from "react";
import * as THREE from "three";

const WALK_SPEED = 3;
const RUN_SPEED = 7;
const EYE_HEIGHT = 1.6;

/** 第一人称漫游：指针锁定视角 + WASD 平移（Shift 加速），高度锁定在视线高度 */
export function FirstPersonRig({ lockSelector }: { lockSelector: string }) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const controlsRef = useRef<ComponentRef<typeof PointerLockControls>>(null);
  const keys = useRef<Set<string>>(new Set());
  const direction = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());
  const clearKeys = useCallback(() => keys.current.clear(), []);

  useEffect(() => {
    camera.position.set(0, EYE_HEIGHT, 3);
    const down = (e: KeyboardEvent) => {
      keys.current.add(e.key.toLowerCase());
      invalidate();
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      keys.current.clear();
    };
  }, [camera, invalidate]);

  useFrame((state, delta) => {
    // 未锁定时用户可能正在 Agent 输入框里打字；这时 WASD 绝不能偷偷移动相机。
    if (!controlsRef.current?.isLocked) return;
    const k = keys.current;
    const forward = (k.has("w") ? 1 : 0) - (k.has("s") ? 1 : 0);
    const strafe = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
    if (!forward && !strafe) return;
    const speed = k.has("shift") ? RUN_SPEED : WALK_SPEED;

    camera.getWorldDirection(direction.current);
    direction.current.y = 0;
    direction.current.normalize();
    right.current.crossVectors(direction.current, camera.up).normalize();

    // 标签页恢复时 delta 可能突增，钳住单帧步长避免人物瞬移穿过场景。
    const frameDelta = Math.min(delta, 0.1);
    camera.position.addScaledVector(direction.current, forward * speed * frameDelta);
    camera.position.addScaledVector(right.current, strafe * speed * frameDelta);
    camera.position.y = EYE_HEIGHT;
    state.invalidate();
  });

  return (
    <PointerLockControls
      ref={controlsRef}
      makeDefault
      selector={lockSelector}
      onUnlock={clearKeys}
    />
  );
}

import { CuboidCollider, RigidBody } from "@react-three/rapier";
import {
  PHYSICS_GROUND_HALF_EXTENT,
  PHYSICS_GROUND_THICKNESS,
  PHYSICS_SAFETY_NET_Y,
} from "./physics";

/**
 * 地面与兜底安全网。两者都**不可见**（chat-space 的网格是另一套纯视觉的 `WebGPUGrid`），
 * 只做物理。数值与理由见 `physics.ts` 里 `PHYSICS_GROUND_HALF_EXTENT` 的注释。
 *
 * 结构上刻意用两个独立的固定刚体、而不是一个厚板：
 * 厚板会把"本来就摆在地面之下的资产"从最近的面顶出来（也就是从上面冒出来），
 * 那是凭空改摆放；薄板 + 远处的安全网只负责"别无限下落"。
 */
export function PhysicsGround() {
  return (
    <>
      {/* 顶面恰好落在 y = 0 */}
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider
          args={[
            PHYSICS_GROUND_HALF_EXTENT,
            PHYSICS_GROUND_THICKNESS,
            PHYSICS_GROUND_HALF_EXTENT,
          ]}
          position={[0, -PHYSICS_GROUND_THICKNESS, 0]}
        />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[0, PHYSICS_SAFETY_NET_Y, 0]}>
        <CuboidCollider
          args={[PHYSICS_GROUND_HALF_EXTENT, 1, PHYSICS_GROUND_HALF_EXTENT]}
        />
      </RigidBody>
    </>
  );
}

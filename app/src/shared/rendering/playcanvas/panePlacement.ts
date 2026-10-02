import { eulerXyzFromQuat, quatFromEulerXyz, type Placement } from "./selectionTransform";

/**
 * 实体 ↔ 摆放的**适配层**：把引擎实体的 TRS 读成摆放、把摆放写回实体。
 *
 * ### 为什么读旋转必须走 `getRotation()` + 自己换算，**不能用 `getEulerAngles()`**
 * 引擎的欧拉 API 是**度数 + ZYX 序**（`quat.js:88` 的 `mulScalar(RAD_TO_DEG)`；本机实测见
 * `selectionTransform.ts` 文件头与 §三之十一）。而摆放的约定是 three 的**弧度 + XYZ 序**。
 * 直接 `entity.getEulerAngles()` 拿到的是度数，喂进摆放就是"静默转错朝向"；
 * 反过来 `entity.setEulerAngles(...)` 也会把弧度当度数、把 XYZ 当 ZYX。
 * 所以这一层**只用四元数**：读 `getRotation()` → `eulerXyzFromQuat`；写 `quatFromEulerXyz` → `setRotation`。
 */

/** 引擎 `Entity` 里我们用到的那几个方法（测试可以给假实体）。 */
export interface PlacementEntityLike {
  getPosition(): { x: number; y: number; z: number };
  getRotation(): { x: number; y: number; z: number; w: number };
  getLocalScale(): { x: number; y: number; z: number };
  setPosition(x: number, y: number, z: number): void;
  setRotation(rotation: { x: number; y: number; z: number; w: number }): void;
  setLocalScale(x: number, y: number, z: number): void;
}

/** 读实体的**局部** TRS 成摆放（父级必须是不带变换的容器，多窗格场景里就是 `app.root`）。 */
export function readEntityPlacement(entity: PlacementEntityLike): Placement {
  const position = entity.getPosition();
  const scale = entity.getLocalScale();
  const rotation = entity.getRotation();
  return {
    position: [position.x, position.y, position.z],
    rotation: eulerXyzFromQuat(rotation as never),
    scale: [scale.x, scale.y, scale.z],
  };
}

/** 把摆放写回实体（同样只走四元数）。 */
export function applyEntityPlacement(entity: PlacementEntityLike, placement: Placement): void {
  entity.setPosition(placement.position[0], placement.position[1], placement.position[2]);
  entity.setRotation(quatFromEulerXyz(placement.rotation) as never);
  entity.setLocalScale(placement.scale[0], placement.scale[1], placement.scale[2]);
}

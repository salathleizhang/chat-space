import * as THREE from "three";
import type { Vec3 } from "../../shared/lib/libraryApi";
import type { AssetPlacement } from "./scenePlacement";

/**
 * 「第一人称抓起模型，松手落定后写回摆放」的**纯数学**（three / rapier 路径）。
 *
 * ### 为什么要单独一层，而不是在 hook 里就地算
 * 三件事都有静默错法，全都只能靠单测钉住：
 *
 * 1. **刚体姿态 → 摆放的欧拉约定**。摆放（`scene.json` / `AssetPlacement`）是**弧度 + XYZ**；
 *    rapier 给的是四元数。转换必须与 `TransformGizmo.decomposePlacement` 逐字同源
 *    （`Euler.setFromQuaternion` 的默认 XYZ），否则"抓一次"就把物体静默转错一个朝向。
 *    ⚠️ 注意欧拉是**多对一**的表示：同一个朝向可以写成 `(0, π, 0)` 也可以写成 `(π, 0, π)`，
 *    所以判"动过没有"**绝不能逐分量比欧拉**（见下一条）。
 *
 * 2. **"动过没有"要用四元数夹角比**。`|dot|` 让 `q` 与 `−q`（同一姿态）等价，
 *    而逐分量比欧拉会把"没动过但落在了万向节那种写法上"误判成"动过"⇒ 点一下就多一条
 *    撤销步骤（而且写着"Move 沙发"，其实沙发一动没动）。
 *
 * 3. **落定判据不能只看"松手那一瞬"**。松手时物体带着速度飞出去/往下掉，
 *    那一刻的姿态根本不是它最后待的地方——所以这一层只负责"给定姿态算摆放"，
 *    等待与判停由 `useObjectGrab` 的物理步负责。
 */

/** 物理刚体给出的姿态：位置是**刚体原点**（= 摆放的包围盒中心），姿态是四元数 xyzw */
export interface BodyPose {
  position: Vec3;
  quaternion: [number, number, number, number];
}

/** 位置阈值（米）：小于它算"没挪过" */
export const DROP_POSITION_EPSILON = 1e-3;
/** 姿态阈值（弧度）：小于它算"没转过" */
export const DROP_ROTATION_EPSILON = 1e-3;

const tmpQuaternion = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpBefore = new THREE.Quaternion();

/**
 * 刚体姿态 + 原摆放的缩放 → 可直接提交的摆放。
 *
 * 缩放取自**原摆放**：物理不改变缩放（`RigidBody` 的 `scale` 是我们喂进去的），
 * 拿刚体的矩阵去反解缩放只会引入 1e-7 级的漂移。
 */
export function placementFromBodyPose(pose: BodyPose, scale: Vec3): AssetPlacement {
  const [x, y, z, w] = pose.quaternion;
  tmpEuler.setFromQuaternion(tmpQuaternion.set(x, y, z, w).normalize());
  return {
    position: [pose.position[0], pose.position[1], pose.position[2]],
    rotation: [tmpEuler.x, tmpEuler.y, tmpEuler.z],
    scale: [scale[0], scale[1], scale[2]],
  };
}

/**
 * 落定姿态与"抓之前那份摆放"是否算真的动过。
 *
 * 判据是**位置距离 + 四元数夹角**（不是欧拉逐分量），理由见文件头第 2 条。
 * 返回 false 时调用方**不要提交**：抓一下又放开、物体一动没动，不该在历史里留一步。
 */
export function dropPoseMoved(before: AssetPlacement, after: BodyPose): boolean {
  const [px, py, pz] = before.position;
  const dx = after.position[0] - px;
  const dy = after.position[1] - py;
  const dz = after.position[2] - pz;
  if (Math.hypot(dx, dy, dz) > DROP_POSITION_EPSILON) return true;

  const [x, y, z, w] = after.quaternion;
  tmpBefore.setFromEuler(tmpEuler.fromArray(before.rotation)).normalize();
  tmpQuaternion.set(x, y, z, w).normalize();
  // three 的 `angleTo` 自己取 `|dot|` 并钳到 acos 的定义域，正是我们要的"同一姿态"语义
  return tmpBefore.angleTo(tmpQuaternion) > DROP_ROTATION_EPSILON;
}

import { quatFromEulerXyz, type Placement } from "./selectionTransform";

/**
 * 「第一人称抓起模型，松手落定后写回摆放」的**纯逻辑**（PlayCanvas 路径，与引擎无关）。
 *
 * 与 three 侧的 `widgets/Viewport/grabCommit.ts` **同一口径**，只是这边不引 three：
 * 四元数用 `selectionTransform` 自己那份（`quatFromEulerXyz`，已用 three 当真值钉过），
 * 于是本模块能纯逻辑单测。
 *
 * 三件事都不能省：
 * ① **落定判据**：松手会把速度还给物体（甩出），它还要飞、还要掉、还要滚。
 *    松手那一刻的姿态不是它最后待的地方，照那一刻落盘等于记了一个半空中的位置。
 *    而且**"这一刻速度小"本身也不够**——把沙发端在半空、停下鼠标再松开时，关节会把它
 *    吊住（速度≈0）；所以还要"连续静够 150 ms"（`shared/lib/settleHold.ts`，两版共用）。
 * ② **真的动过才提交**：位置距离 + **四元数夹角**（欧拉是多对一的，逐分量比会把
 *    "同一姿态的另一种写法"误判成"转过"，抓一下又放开也会在历史里留一步）。
 * ③ **等落定要有上限**：投掷出去的物体可能滚很久，不能无限等（到点按当时姿态落盘）。
 */

/** 位置阈值（米）：小于它算"没挪过" */
export const DROP_POSITION_EPSILON = 1e-3;
/** 姿态阈值（弧度）：小于它算"没转过" */
export const DROP_ROTATION_EPSILON = 1e-3;
/** 速度阈值（米/秒、弧度/秒）：两个都在它以下算"停下了" */
export const DROP_SETTLE_LINEAR_EPSILON = 0.05;
export const DROP_SETTLE_ANGULAR_EPSILON = 0.15;
/** 等落定的上限，到点就按当时姿态落盘（见文件头第 ③ 条） */
export const DROP_SETTLE_TIMEOUT_MS = 5_000;

/** 引擎 `Vec3` 的最小形状（只读三个分量；**没有**数字下标） */
export interface DropVec3Like {
  x: number;
  y: number;
  z: number;
}

/** 刚体是不是停下来了。两个速度都要小——只转不走的陀螺也是"没停" */
export function dropSettled(linear: DropVec3Like, angular: DropVec3Like): boolean {
  return Math.hypot(linear.x, linear.y, linear.z) < DROP_SETTLE_LINEAR_EPSILON
    && Math.hypot(angular.x, angular.y, angular.z) < DROP_SETTLE_ANGULAR_EPSILON;
}

/**
 * 落定姿态与"抓之前那份摆放"是否算真的动过。
 *
 * `after` 用 `readEntityPlacement` 读出来（同一个坐标约定：位置 / **弧度 XYZ** / 缩放），
 * 所以两边能直接比。
 */
export function dropPlacementMoved(before: Placement, after: Placement): boolean {
  const distance = Math.hypot(
    after.position[0] - before.position[0],
    after.position[1] - before.position[1],
    after.position[2] - before.position[2],
  );
  if (distance > DROP_POSITION_EPSILON) return true;

  const a = quatFromEulerXyz(before.rotation);
  const b = quatFromEulerXyz(after.rotation);
  return quatAngle(a, b) > DROP_ROTATION_EPSILON;
}

/**
 * 两个四元数之间的夹角（弧度）。取 `|dot|` 所以 `q` 与 `−q`（同一姿态）算 0
 * ——three 的 `Quaternion.angleTo` 是同一套语义，两侧判据因此一致。
 * 参数按**结构**收（不引引擎类型），这个模块因此不依赖 `playcanvas` 的类。
 */
function quatAngle(a: QuatLike, b: QuatLike): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}

interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

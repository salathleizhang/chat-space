import { Mat4, Quat, Vec3 } from "playcanvas";

/**
 * 多选整体变换的**集成层数学**：轴心（pivot）+ 冻结相对矩阵 + 由 pivot 位姿还原各成员摆放。
 * 对应 three 侧 `widgets/Viewport/TransformGizmo.tsx` 的那三个 handler
 * （`handleMouseDown` 冻结 `pivot⁻¹·member`、`handleObjectChange` 用 `pivot.matrix·relative`
 * 还原、`handleMouseUp` 提交一次）。
 *
 * ### 为什么用引擎的 Mat4，却**自己写欧拉换算**
 * 摆放的三元组来自 three 约定（`scene.json` 里 `rotation` 是**弧度、XYZ 序**），而引擎自带的
 * 欧拉 API **两者都不同**——本机实测（见 §三之十一）：
 * - `pc.Quat.setFromEulerAngles(90,0,0)` == three 的 `makeRotationX(π/2)` ⇒ **引擎收的是角度**；
 * - `pc.Mat4.setFromEulerAngles(x·RAD2DEG, …)` 与 three 的 `Euler(x,y,z,'XYZ')` 差 **0.43–1.73**，
 *   而与 three 的 `Euler(x,y,z,'ZYX')` 只差 **2.7e-8**（float32 量级）⇒ **引擎用的是 ZYX**。
 *
 * 所以直接拿摆放三元组喂引擎的欧拉 API，会**静默**得到错的朝向（不报错、不崩，只是模型转错了）。
 * 这里只把"欧拉 ↔ 四元数"这一步按 three 的公式自己写（`quatFromEulerXyz` / `eulerXyzFromQuat`），
 * 其余（乘、逆、TRS、分解、点变换）一律用引擎实现，避免重复造矩阵库。
 * `selectionTransform.test.ts` 用 **three 当真值**逐元素比对（同一位姿在两套引擎里必须得到同一个矩阵）。
 *
 * ### 轴心口径（与 three 侧逐项一致）
 * - **单选**：pivot 直接取该成员自身的摆放（位置/旋转/缩放）⇒ gizmo 落在物体原点上，相对矩阵是单位阵。
 * - **多选**：pivot.position = 各成员**位置**的包围盒中心（Blender 的"中位点"），
 *   旋转归零、缩放归一——一组朝向各异的对象没有共同的"自身轴"，从单位姿态起算最不意外。
 */

/** 弧度、XYZ 序的欧拉三元组。结构上与 three 侧 `AssetPlacement` 一致（不 import 应用层类型）。 */
export type Vec3Tuple = [number, number, number];

export interface Placement {
  position: Vec3Tuple;
  rotation: Vec3Tuple;
  scale: Vec3Tuple;
}

export interface Member<Id extends string = string> {
  id: Id;
  placement: Placement;
}

export const IDENTITY_ROTATION: Vec3Tuple = [0, 0, 0];
export const UNIT_SCALE: Vec3Tuple = [1, 1, 1];

const HALF = 0.5;

/** three `Quaternion.setFromEuler(euler, 'XYZ')`：**弧度、XYZ 序**。 */
export function quatFromEulerXyz([x, y, z]: Vec3Tuple, out = new Quat()): Quat {
  const c1 = Math.cos(x * HALF);
  const c2 = Math.cos(y * HALF);
  const c3 = Math.cos(z * HALF);
  const s1 = Math.sin(x * HALF);
  const s2 = Math.sin(y * HALF);
  const s3 = Math.sin(z * HALF);
  return out.set(
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  );
}

/** three `Euler.setFromQuaternion(q, 'XYZ')` 的提取式（含万向锁分支）。 */
export function eulerXyzFromQuat(q: Quat): Vec3Tuple {
  const { x, y, z, w } = q;
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - z * w);
  const m13 = 2 * (x * z + y * w);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const m32 = 2 * (y * z + x * w);
  const clamped = Math.min(Math.max(m13, -1), 1);
  const ey = Math.asin(clamped);
  if (Math.abs(clamped) < 0.9999999) {
    return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
  }
  // 万向锁：x 与 z 只剩一个自由度，按 three 的取法把 z 归零
  return [Math.atan2(m32, m22), ey, 0];
}


/** 摆放 → 世界矩阵（TRS）。与 three 的 `Object3D.matrix` 逐元素一致（测试用 three 当真值）。 */
export function matrixFromPlacement(placement: Placement, out = new Mat4()): Mat4 {
  /*
    **每次调用都用独立的临时量**：`Mat4.setTRS` 是**按引用**把 position/quaternion/scale 存进
    矩阵里的（引擎随后才在 `update()` 时展开），所以复用模块级 tmp 会让"上一次返回的矩阵"
    被下一次调用改写——实测症状是连续算两个矩阵、第二个的 scale 漏进第一个（差 0.836）。
    这条只影响"同一帧里算多个矩阵"的调用方（测试与多选线框），但错得很隐蔽。
  */
  const position = new Vec3(placement.position[0], placement.position[1], placement.position[2]);
  const scale = new Vec3(placement.scale[0], placement.scale[1], placement.scale[2]);
  return out.setTRS(position, quatFromEulerXyz(placement.rotation, new Quat()), scale);
}

/** 世界矩阵 → 摆放（分解）。 */
export function placementFromMatrix(matrix: Mat4): Placement {
  const position = new Vec3();
  const scale = new Vec3();
  const rotation = new Quat();
  matrix.getTranslation(position);
  matrix.getScale(scale);
  rotation.setFromMat4(matrix);
  return {
    position: [position.x, position.y, position.z],
    rotation: eulerXyzFromQuat(rotation),
    scale: [scale.x, scale.y, scale.z],
  };
}

/** 轴心姿态：单选取自身摆放；多选取"位置包围盒中心 + 姿态归零"。 */
export function selectionPivot(members: readonly Member[]): Placement | null {
  if (members.length === 0) return null;
  if (members.length === 1) {
    const only = members[0]!.placement;
    return {
      position: [...only.position] as Vec3Tuple,
      rotation: [...only.rotation] as Vec3Tuple,
      scale: [...only.scale] as Vec3Tuple,
    };
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const member of members) {
    const [x, y, z] = member.placement.position;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    position: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    rotation: [...IDENTITY_ROTATION] as Vec3Tuple,
    scale: [...UNIT_SCALE] as Vec3Tuple,
  };
}

/** 按下瞬间冻结的"成员相对 pivot"矩阵：`pivot⁻¹ · member`。 */
export interface FrozenMember<Id extends string = string> {
  id: Id;
  relative: Mat4;
}

export function freezeRelatives<Id extends string>(
  pivot: Placement,
  members: readonly Member<Id>[],
): FrozenMember<Id>[] {
  const inverse = matrixFromPlacement(pivot).invert();
  return members.map((member) => ({
    id: member.id,
    relative: new Mat4().mul2(inverse, matrixFromPlacement(member.placement)),
  }));
}

/** 拖动中：`pivot.matrix · relative` → 每个成员的新摆放。 */
export function placementsFromPivot<Id extends string>(
  pivot: Placement,
  frozen: readonly FrozenMember<Id>[],
): Record<Id, Placement> {
  const pivotMatrix = matrixFromPlacement(pivot);
  const updates = {} as Record<Id, Placement>;
  for (const member of frozen) {
    updates[member.id] = placementFromMatrix(new Mat4().mul2(pivotMatrix, member.relative));
  }
  return updates;
}

/**
 * 拖拽生命周期（纯状态机，**不含引擎与 React**）。对应 three 侧三个 handler 的语义：
 * `reset` ← 成员/摆放变化时的 `resetPivot`；`begin` ← `handleMouseDown`；
 * `update` ← `handleObjectChange`；`end` ← `handleMouseUp`（只提交一次、带 mode）。
 */
export interface SelectionTransformOptions<Id extends string> {
  /** 拖动中把实时摆放写进 `LiveTransforms`（three 侧同一张表：各窗格每帧读它） */
  writeLive(updates: Record<Id, Placement>): void;
  /** 清空实时表（松手时先清表再提交，两者在同一事件里，订阅方看不到回跳） */
  clearLive(): void;
  /** 松手提交绝对值 + 模式（撤销栈文案用） */
  onCommit(updates: Record<Id, Placement>, mode: string): void;
  /**
   * 换了一批成员（可选）。**内部已经记下了**，这里只是通知：调用方要同步自己的实体表时用它。
   * 保留这个钩子是因为旧接口就是靠它把成员交给控制器的（两种接线都得能用）。
   */
  onMembers?(members: readonly Member<Id>[]): void;
}

export interface SelectionTransformHandle<Id extends string> {
  /**
   * 换一批成员（选中集合变了）。**同时重算轴心**——只换成员不重算的话，轴心会留在旧集合上。
   * 与 `reset(members)` 等价，两个名字都留着是因为现场两套接线都在用：
   * 组件走 `reset(members)`，测试与旧接线走 `setMembers(members)` + `reset()`。
   */
  setMembers(next: readonly Member<Id>[]): void;
  /**
   * 重置轴心基准。
   * - 不传：按当前成员各自的摆放算（换完成员后调用）；
   * - 传函数：按该函数给出的摆放算（"实体当前位姿"这类外部真值）；
   * - 传成员数组：等价于先 `setMembers` 再按它们的摆放算（调用方的现行用法）。
   */
  reset(at?: ((member: Member<Id>) => Placement) | readonly Member<Id>[]): void;
  pivot(): Placement | null;
  /** 按下：冻结相对矩阵。返回是否真的开始了一次拖拽 */
  begin(): boolean;
  /** 拖动中：按当前 pivot 位姿算出各成员摆放并写进实时表 */
  update(pivotPlacement: Placement): Record<Id, Placement> | null;
  /** 松手：提交一次（没有在拖就返回 null） */
  end(mode: string): { updates: Record<Id, Placement>; mode: string } | null;
  /** 有没有正在拖（供拾取闸门 / 让出手势用） */
  active(): boolean;
  /** 切布局/卸载时的兜底清理：清实时表、丢弃冻结矩阵 */
  abort(): void;
}

export function createSelectionTransform<Id extends string>(
  options: SelectionTransformOptions<Id>,
): SelectionTransformHandle<Id> {
  let members: Member<Id>[] = [];
  let pivot: Placement | null = null;
  let frozen: FrozenMember<Id>[] = [];
  /** 最近一次 `update()` 算出的摆放；`end()` 提交的就是它（不是按下时的旧 pivot） */
  let lastUpdates: Record<Id, Placement> | null = null;

  /*
    `reset()` 要按**当前成员来源**重算轴心，而"来源"有两种：`setMembers()` 给的最新一批，
    或调用方直接传进来的那批。**不能读 `members` 变量**——那条路径只有在调用方把数组传给
    `reset()` 时才被赋值；`setMembers()` + `reset()`（测试 fixture 与组件的现行用法）会读到
    空数组，于是 `pivot` 被算成 null → `begin()` 永远返回 false（gizmo 拖不动）。
  */
  let resetSource: readonly Member<Id>[] = [];
  const setMembers = (next: readonly Member<Id>[]) => {
    resetSource = next;
    members = next.map((member) => ({ id: member.id, placement: member.placement }));
    options.onMembers?.(next);
    // 换了成员就必须重算轴心（否则轴心留在旧集合上；空集合时算成 null 正是预期）
    pivot = selectionPivot(members);
  };
  const reset = (at?: ((member: Member<Id>) => Placement) | readonly Member<Id>[]) => {
    if (Array.isArray(at)) {
      resetSource = at;
      members = at.map((member) => ({ id: member.id, placement: member.placement }));
      options.onMembers?.(at);
    }
    const source =
      typeof at === "function"
        ? resetSource.map((member) => ({ id: member.id, placement: at(member) }))
        : resetSource;
    pivot = selectionPivot(source);
  };

  return {
    setMembers,
    reset,
    pivot: () => pivot,
    begin() {
      if (!pivot || members.length === 0) return false;
      frozen = freezeRelatives(pivot, members);
      return true;
    },
    update(pivotPlacement) {
      if (frozen.length === 0) return null;
      const updates = placementsFromPivot(pivotPlacement, frozen);
      /*
        **把这次的结果留下来**：`end()` 要提交的是"拖到哪儿了"，不是"起点在哪"。
        早先 `end()` 自己拿 `pivot!`（按下那一刻的旧值）又算了一遍，于是拖完提交回来的
        是**原位**——UI 上表现为松手后物体弹回起点（实测：update 到 y=5，提交回来 y=0）。
      */
      lastUpdates = updates;
      options.writeLive(updates);
      return updates;
    },
    end(mode) {
      if (frozen.length === 0) return null;
      const updates = lastUpdates ?? ({} as Record<Id, Placement>);
      lastUpdates = null;
      frozen = [];
      options.clearLive();
      options.onCommit(updates, mode);
      return { updates, mode };
    },
    active: () => frozen.length > 0,
    abort() {
      if (frozen.length > 0) {
        frozen = [];
        lastUpdates = null;
        options.clearLive();
      }
    },
  };
}

/** 成员集合的**位置**包围盒（探针/线框都要它：选中高亮画的就是这个盒）。 */
export interface Bounds3 {
  center: Vec3Tuple;
  size: Vec3Tuple;
  min: Vec3Tuple;
  max: Vec3Tuple;
}

export function positionsBounds(members: readonly Member[]): Bounds3 | null {
  if (members.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const member of members) {
    const [x, y, z] = member.placement.position;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

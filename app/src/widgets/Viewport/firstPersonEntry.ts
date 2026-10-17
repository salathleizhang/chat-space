import { CHARACTER_EYE_OFFSET } from "./physics";

/**
 * 「进第一人称时从**当前机位**接上」的纯数学。
 *
 * 改造前的口径是一个固定出生点 `[0, eye, 3]` + 朝 -Z：不管用户在哪个窗格、朝哪看，
 * 一按第一人称就跳过去（用户报的现象就是"到一个固定的位置"）。现在接三样东西：
 *
 * - **平面位置**取当前（透视）窗格相机所在的 X、Z——"我站在我刚才看的地方"；
 * - **朝向**取那台相机这一帧的视线（偏航 + 俯仰），进去之后转头从同一个方向续上；
 * - **高度**不照抄相机的 y。轨道机位通常在半空（默认 `[5, 4.5, 5]`），照抄就是
 *   "进场先从天而降"；第一人称的人始终站在地面上，所以地面高度由 `ENTRY_GROUND_Y`
 *   给出、脚留一点余量让重力把它放到真正的地面上（与改造前的 0.2 一致）。
 *
 * 地面在 y = 0 是**结构性**的：世界 collider 的 `groundPlaneOffset` 语义就是"把地面抬到
 * y=0"，没有 world 时由 `PhysicsGround` 的平板兜住（见 `physics.ts` 的那段注释）。
 *
 * 朝向口径与 `walkRig.ts` / `PointerLockControls` 一致：偏航 0 = 看向 -Z，
 * 俯仰向上为正，`Euler(pitch, yaw, 0, "YXZ")` 就是那台相机的四元数。
 */

/** 出生点离地余量：留一点高度让重力把角色放到真正的地面上（沿用改造前的 0.2 m） */
export const ENTRY_GROUND_MARGIN = 0.2;
/** 地面高度（世界单位）。见文件头：地面被定义在 y = 0 */
export const ENTRY_GROUND_Y = 0;
/** 俯仰钳制：与 `walkRig.ts` 的 `MAX_PITCH` 同一个数（留 0.01 弧度避免与上方向共线后翻转） */
export const ENTRY_MAX_PITCH = Math.PI / 2 - 0.01;

/** 进第一人称的初始状态：刚体中心（胶囊中心）+ 视线朝向 */
export interface FirstPersonEntry {
  /** 出生点（**刚体中心**）：脚在 `spawn[1] - CHARACTER_EYE_OFFSET` */
  spawn: [number, number, number];
  /** 偏航（绕 +Y，0 = 看向 -Z） */
  yaw: number;
  /** 俯仰（向上为正） */
  pitch: number;
}

/**
 * 拿不到任何机位信息时的回退（窗格还没挂载、控制器刚换代）。就是改造前那个固定出生点，
 * 所以"读不到机位"这条路径的行为与改造前逐字一致。
 */
export const DEFAULT_FIRST_PERSON_ENTRY: FirstPersonEntry = {
  spawn: [0, ENTRY_GROUND_Y + CHARACTER_EYE_OFFSET + ENTRY_GROUND_MARGIN, 3],
  yaw: 0,
  pitch: 0,
};

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * 视线方向 → 偏航/俯仰。方向不必归一化。
 *
 * 退化情形（零向量、NaN、无穷）一律回 `yaw 0 / pitch 0`：这时没有任何"用户在看的那个方向"
 * 可接，回退到改造前的朝向比返回 NaN 好——NaN 会一路写进相机四元数，画面上是**纯黑**且零报错。
 */
export function yawPitchFromDirection(dx: number, dy: number, dz: number): { yaw: number; pitch: number } {
  const length = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(length) || length < 1e-6) return { yaw: 0, pitch: 0 };
  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;
  // forward = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
  const pitch = Math.min(Math.max(Math.asin(Math.min(Math.max(ny, -1), 1)), -ENTRY_MAX_PITCH), ENTRY_MAX_PITCH);
  const yaw = Math.atan2(-nx, -nz);
  return { yaw, pitch };
}

/** 眼位置 + 看向的点 → 进场状态（位置取眼睛的 XZ、朝向取 `lookAt - eye`） */
export function firstPersonEntryFromPose(
  eye: Vec3Like,
  lookAt: Vec3Like,
  options: { groundY?: number; margin?: number } = {},
): FirstPersonEntry {
  const { yaw, pitch } = yawPitchFromDirection(lookAt.x - eye.x, lookAt.y - eye.y, lookAt.z - eye.z);
  const groundY = options.groundY ?? ENTRY_GROUND_Y;
  const margin = options.margin ?? ENTRY_GROUND_MARGIN;
  return {
    spawn: [eye.x, groundY + CHARACTER_EYE_OFFSET + margin, eye.z],
    yaw,
    pitch,
  };
}

/**
 * 从窗格的轨道控制器（`PaneControls` 的最小形状）推导进场状态。
 *
 * 控制器为空（窗格还没挂载、或刚换代还没落回 ref）时回退默认出生点——调用方**必须**在切换模式
 * 之前调它：`mode` 一变成 firstPerson，窗格整棵就卸载了，那时 ref 已经清空、只能拿到 null。
 */
export function firstPersonEntryFromControls(
  controls: { object: { position: Vec3Like }; target: Vec3Like } | null | undefined,
  options: { groundY?: number; margin?: number } = {},
): FirstPersonEntry {
  if (!controls) return DEFAULT_FIRST_PERSON_ENTRY;
  return firstPersonEntryFromPose(controls.object.position, controls.target, options);
}

import type { Vec3 } from "../../../shared/lib/cameraRig";

/**
 * 第一人称漫游的**纯数学**：视角（偏航/俯仰）+ WASD 平移 + 高度锁定。
 * 对应 three 侧 `widgets/Viewport/FirstPersonRig.tsx`（`PointerLockControls` + `WALK_SPEED=3` /
 * `RUN_SPEED=7` / `EYE_HEIGHT=1.6` / `Shift` 加速 / 单帧 `delta` 钳到 0.1 s）。
 *
 * ### 为什么单独一套状态，不复用 `CameraRig`
 * `CameraRig` 是 **turntable**（目标点 + 方位角/极角/距离，`up` 固定），表达不了"人站在原地转头再
 * 走出去"——那需要**眼睛位置 + 朝向**（6 自由度里锁掉滚转与爬升）。所以第一人称是另一份状态，
 * 而不是往 `CameraRig` 里硬塞。
 *
 * ### 三条与 three 侧逐项一致的行为
 * ① **高度锁定**：`y` 恒为 `EYE_HEIGHT`（WASD 只走水平面，没有 Q/E 升降）。
 * ② **只在锁定时移动**：指针没锁定时用户可能在 Agent 输入框里打字，WASD 绝不能偷偷移动相机——
 *    这条由调用方把 `locked` 传进来（本模块只做数学）。
 * ③ **单帧步长钳到 `MAX_FRAME_DELTA`**：标签页恢复时 `delta` 会突增，不钳住会让人瞬移穿过场景。
 *
 * ### 全局而非逐窗格
 * three 侧进入第一人称时不渲染多窗格（也没有拾取/gizmo），所以这份 rig 是**全局**的，
 * 不像其它窗格输入那样按格路由。
 */

export const WALK_SPEED = 3;
export const RUN_SPEED = 7;
/** 眼睛高度（世界单位）。产品可见值。 */
export const EYE_HEIGHT = 1.6;
/** 单帧最大步长（秒）。 */
export const MAX_FRAME_DELTA = 0.1;
/** 初始机位（three 侧 `camera.position.set(0, EYE_HEIGHT, 3)`）。 */
export const WALK_START: Vec3 = [0, EYE_HEIGHT, 3];
/** 俯仰钳制：留 0.01 弧度，避免与"上方向"共线后视角翻转。 */
export const MAX_PITCH = Math.PI / 2 - 0.01;

/** 视角状态：眼睛位置 + 偏航（绕 +Y，0 = 看向 -Z）+ 俯仰（向上为正）。 */
export interface WalkState {
  position: Vec3;
  yaw: number;
  pitch: number;
}

export function createWalkState(over: Partial<WalkState> = {}): WalkState {
  return { position: [...WALK_START], yaw: 0, pitch: 0, ...over };
}

/** 朝向单位向量（偏航 0、俯仰 0 时看向 -Z，与相机惯例一致）。 */
export function walkForward(state: Pick<WalkState, "yaw" | "pitch">): Vec3 {
  const cosPitch = Math.cos(state.pitch);
  return [-Math.sin(state.yaw) * cosPitch, Math.sin(state.pitch), -Math.cos(state.yaw) * cosPitch];
}

/**
 * 转身/抬头。`deltaYaw`/`deltaPitch` 由指针位移换算（调用方决定灵敏度）；
 * 俯仰钳在 `±MAX_PITCH`，偏航可以无限绕。
 */
export function lookStep(state: WalkState, deltaYaw: number, deltaPitch: number): WalkState {
  if (!Number.isFinite(deltaYaw) || !Number.isFinite(deltaPitch)) return state;
  const pitch = Math.min(Math.max(state.pitch + deltaPitch, -MAX_PITCH), MAX_PITCH);
  if (deltaYaw === 0 && pitch === state.pitch) return state;
  return { ...state, yaw: state.yaw + deltaYaw, pitch };
}

export interface WalkMoveInput {
  /** W/S：+1 向前、-1 向后。 */
  forward: number;
  /** D/A：+1 向右、-1 向左。 */
  strafe: number;
  run: boolean;
  /** 帧间隔（秒）；内部钳到 `MAX_FRAME_DELTA`。 */
  delta: number;
}

/**
 * 走一步。三个方向都取自**水平面**（`forward` 的 y 分量丢掉、`right` 与地面平行）；
 * 位置 `y` 始终回到 `EYE_HEIGHT`。
 */
export function walkStep(state: WalkState, input: WalkMoveInput): WalkState {
  const delta = Math.min(Math.max(input.delta, 0), MAX_FRAME_DELTA);
  const forward = Number.isFinite(input.forward) ? input.forward : 0;
  const strafe = Number.isFinite(input.strafe) ? input.strafe : 0;
  if (delta <= 0 || (forward === 0 && strafe === 0)) {
    // 即使不动也把高度锁回去（相机可能被别的东西挪过）
    return state.position[1] === EYE_HEIGHT ? state : { ...state, position: [state.position[0], EYE_HEIGHT, state.position[2]] };
  }
  const speed = input.run ? RUN_SPEED : WALK_SPEED;
  // 水平前方：把朝向的 y 丢掉再归一化（俯视/仰视时不会往地里钻或飞起来）
  const flat = [-Math.sin(state.yaw), 0, -Math.cos(state.yaw)] as Vec3;
  const flatLength = Math.hypot(flat[0], flat[2]);
  const unitForward: Vec3 = flatLength < 1e-6 ? [0, 0, -1] : [flat[0] / flatLength, 0, flat[2] / flatLength];
  // 右向 = forward × up（up = +Y）：three 侧 `right.crossVectors(direction, camera.up)`
  const right: Vec3 = [-unitForward[2], 0, unitForward[0]];
  const step = speed * delta;
  return {
    ...state,
    position: [
      state.position[0] + unitForward[0] * forward * step + right[0] * strafe * step,
      EYE_HEIGHT,
      state.position[2] + unitForward[2] * forward * step + right[2] * strafe * step,
    ],
  };
}

/**
 * **速度意图**（m/s）：与 `walkStep` 同一套朝向/按键口径，但输出速度而不是位移。
 *
 * 为什么要有它：第一人称改成物理胶囊体之后，位置由物理引擎说了算——`walkStep` 那种
 * "自己算位移、再把 y 锁回眼高"的做法正是要拆掉的东西（它让人穿墙、不掉下台阶）。
 * 所以物理路径只问这一个问题："这一帧想往哪走、多快"，剩下的交给刚体。
 *
 * 与 `walkStep` 唯一的有意差异：**斜向归一化**（同时按 W+D 不会比直走快 41%）。
 */
export function walkVelocity(
  state: Pick<WalkState, "yaw">,
  input: Pick<WalkMoveInput, "forward" | "strafe" | "run">,
): Vec3 {
  const forward = Number.isFinite(input.forward) ? input.forward : 0;
  const strafe = Number.isFinite(input.strafe) ? input.strafe : 0;
  if (forward === 0 && strafe === 0) return [0, 0, 0];
  const speed = input.run ? RUN_SPEED : WALK_SPEED;
  const flat = [-Math.sin(state.yaw), 0, -Math.cos(state.yaw)] as Vec3;
  const flatLength = Math.hypot(flat[0], flat[2]);
  const unitForward: Vec3 = flatLength < 1e-6 ? [0, 0, -1] : [flat[0] / flatLength, 0, flat[2] / flatLength];
  const right: Vec3 = [-unitForward[2], 0, unitForward[0]];
  const x = unitForward[0] * forward + right[0] * strafe;
  const z = unitForward[2] * forward + right[2] * strafe;
  // 把 `-0` 归一成 `0`：`0 * -1` 会得到 `-0`，它数值上等于 0 却会让"速度是零向量"的
  // 判等与快照断言到处噪声（本仓库的测试就是逐分量 toEqual）
  const clean = (value: number) => (value === 0 ? 0 : value);
  const length = Math.hypot(x, z);
  if (length <= 1 || length === 0) return [clean(x * speed), 0, clean(z * speed)];
  return [(x / length) * speed, 0, (z / length) * speed];
}

/** 按键集合 → 前进/后退/横移/加速（只认小写字母，与 three 侧 `e.key.toLowerCase()` 一致）。 */
export function walkInputFromKeys(keys: ReadonlySet<string>, delta: number): WalkMoveInput {
  return {
    forward: (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0),
    strafe: (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0),
    run: keys.has("shift"),
    delta,
  };
}

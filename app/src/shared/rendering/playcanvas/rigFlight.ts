import { rigPosition, type CameraRig, type Vec3 } from "../../../shared/lib/cameraRig";

/**
 * 相机**飞行动画**的纯数学：指数阻尼收敛 + 到位判定。
 * 对应 three 侧 `widgets/Viewport/CameraRig.tsx`（`DAMP_LAMBDA = 4`、`ARRIVE_DISTANCE_SQ = 0.0004`）。
 *
 * ### 为什么插值"位置 + 目标点"而不是"方位角/极角/距离"
 * three 侧每帧对 `camera.position` 与 `controls.target` 分别做阻尼（`MathUtils.damp`），
 * 所以轨迹是**位姿空间里的一条曲线**，不是角度上的直线。本模块照做：先取台架的位姿
 * （位置 + 目标点），在两个位姿之间阻尼，再**反解**回 `CameraRig`（`rigFromPose`）。
 * 反解复用 `rigPosition` 的正向定义（方向 = 目标点 → 位置），所以两者互为逆运算、可单测。
 *
 * ### 两条边界
 * ① 俯仰在反解时会钳到开区间（与 `orbitBy`/`panBy` 同一套钳制），所以"飞到正上方"会被削一点——
 *    这正是我们想要的（避免与 up 共线后滚转跳变）。
 * ② 飞行是**渲染循环**的事，不是在输入层里：调用方每帧喂 `delta`，本模块只回答"下一帧在哪、到了没有"。
 */

export const DAMP_LAMBDA = 4;
export const ARRIVE_DISTANCE_SQ = 0.0004;

export interface RigPose {
  position: Vec3;
  target: Vec3;
}

/** 台架 → 位姿（位置 + 目标点）。 */
export function rigPose(rig: CameraRig): RigPose {
  return { position: rigPosition(rig), target: [...rig.target] };
}

/** 位姿 → 台架（反解方位角/极角/距离；`fov`/`projection` 原样保留）。 */
export function rigFromPose(pose: RigPose, rig: CameraRig): CameraRig {
  const dx = pose.position[0] - pose.target[0];
  const dy = pose.position[1] - pose.target[1];
  const dz = pose.position[2] - pose.target[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-9) return { ...rig, target: [...pose.target] };
  const horizontal = Math.hypot(dx, dz);
  const polar = Math.atan2(horizontal, dy);
  return {
    ...rig,
    target: [...pose.target],
    azimuth: horizontal < 1e-9 ? rig.azimuth : Math.atan2(dx, dz),
    polar: Math.min(Math.max(polar, 0.01), Math.PI - 0.01),
    distance,
  };
}

/** three `MathUtils.damp` 同式：`current + (target - current) * (1 - exp(-lambda * delta))`。 */
export function damp(current: number, target: number, lambda: number, delta: number): number {
  if (!(delta > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-lambda * delta));
}

/**
 * 飞一步：位置与目标点各自阻尼向目标位姿收敛。
 * `arrived` 用**位置**的剩余距离平方判定（与 three 侧一致：只看相机位置）。
 */
export function flightStep(
  pose: RigPose,
  destination: RigPose,
  delta: number,
  lambda: number = DAMP_LAMBDA,
  arriveDistanceSq: number = ARRIVE_DISTANCE_SQ,
): { pose: RigPose; arrived: boolean } {
  const next: RigPose = {
    position: [
      damp(pose.position[0], destination.position[0], lambda, delta),
      damp(pose.position[1], destination.position[1], lambda, delta),
      damp(pose.position[2], destination.position[2], lambda, delta),
    ],
    target: [
      damp(pose.target[0], destination.target[0], lambda, delta),
      damp(pose.target[1], destination.target[1], lambda, delta),
      damp(pose.target[2], destination.target[2], lambda, delta),
    ],
  };
  const dx = next.position[0] - destination.position[0];
  const dy = next.position[1] - destination.position[1];
  const dz = next.position[2] - destination.position[2];
  const arrived = dx * dx + dy * dy + dz * dz < arriveDistanceSq;
  return { pose: arrived ? { position: [...destination.position], target: [...destination.target] } : next, arrived };
}

export interface RigFlightOptions {
  /** 每步把台架写进引擎（调用方负责 `applyRig`）。带 paneId，便于宿主按格写入。 */
  apply(paneId: string, rig: CameraRig): void;
  /** 当前台架（每步重新读，这样用户在飞行途中手改台架也不会被覆盖成旧值）。 */
  read(): CameraRig | null;
  /** 每帧订阅/退订；测试注入点。 */
  subscribe?: (tick: (deltaMs: number) => void) => () => void;
}

export interface RigFlightHandle {
  /** 开始一次飞行；返回 false 表示没有台架可飞。 */
  start(paneId: string, destination: CameraRig): boolean;
  /** 立刻结束飞行（用户一有输入就该调用它，否则手感和 three 侧不同）。 */
  cancel(): void;
  flying(): boolean;
  /** 飞过的帧数、是否已到位、以及**内部**看到的剩余距离（探针/测试读）。 */
  stats(): { steps: number; arrived: boolean; lastError: number };
  dispose(): void;
}

const defaultSubscribe = (tick: (deltaMs: number) => void) => {
  let handle = 0;
  let previous = performance.now();
  const loop = () => {
    const now = performance.now();
    const delta = now - previous;
    previous = now;
    tick(delta);
    handle = requestAnimationFrame(loop);
  };
  handle = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(handle);
};

/**
 * 建一个台架飞行器：`start()` 之后每帧把当前台架往目标台架阻尼推进，到位即停。
 * 同一时刻只飞一条（新的 `start()` 覆盖旧的）。
 */
export function createRigFlight(options: RigFlightOptions): RigFlightHandle {
  let destination: CameraRig | null = null;
  let destinationPane = "";
  let steps = 0;
  let arrived = false;
  let lastError = Number.POSITIVE_INFINITY;
  let unsubscribe: (() => void) | null = null;

  const stop = () => {
    destination = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const tick = (deltaMs: number) => {
    if (!destination) return;
    const current = options.read();
    if (!current) {
      stop();
      return;
    }
    const { pose, arrived: done } = flightStep(rigPose(current), rigPose(destination), deltaMs / 1000);
    steps += 1;
    lastError = Math.hypot(
      pose.position[0] - destination.target[0] - (rigPosition(destination)[0] - destination.target[0]),
      pose.position[1] - destination.target[1] - (rigPosition(destination)[1] - destination.target[1]),
      pose.position[2] - destination.target[2] - (rigPosition(destination)[2] - destination.target[2]),
    );
    const next = rigFromPose(pose, destination);
    options.apply(destinationPane, next);
    if (done) {
      arrived = true;
      stop();
    }
  };

  return {
    start(paneId, target) {
      if (!options.read()) return false;
      destination = target;
      destinationPane = paneId;
      steps = 0;
      arrived = false;
      lastError = Number.POSITIVE_INFINITY;
      if (!unsubscribe) unsubscribe = (options.subscribe ?? defaultSubscribe)(tick);
      return true;
    },
    cancel: stop,
    flying: () => destination !== null,
    stats: () => ({ steps, arrived, lastError }),
    dispose() {
      stop();
    },
  };
}

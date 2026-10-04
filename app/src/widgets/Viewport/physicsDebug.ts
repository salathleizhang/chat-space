/**
 * 物理诊断口：只在**开发构建 + `?physicsDebug=1`** 时往 `window.__PHYSICS__` 上装活口。
 *
 * 存在理由与 PC 侧的 `viewportDebug.ts` 完全一样：单测能证明纯数学（碰撞盒尺寸、速度钳制、
 * 续帧判据），**证明不了真机行为**——rapier 的 wasm 有没有加载、重力有没有把角色放到地面、
 * 走起来会不会穿墙、抓取关节有没有真的把物体粘住，只有在真实浏览器里读引擎事实才知道。
 *
 * 纪律（踩过的坑，照抄 PC 侧）：
 * ① 生产构建与没带参数的页面**一律不装**，免得诊断口变成事实上的公开 API；
 * ② 组件内部要用这些能力必须走自己的引用，**不能绕 `window` 上那个回调自己**——
 *    一加开关（生产不装）内部路径就静默失效。
 */

export interface PhysicsDebugBody {
  handle: number;
  /** 节点名：资产刚体是 `asset:<id>`，角色没有名字 */
  name: string | null;
  position: [number, number, number];
  awake: boolean;
  type: number;
  character: boolean;
  /** 这个刚体上挂了几个碰撞体。"有没有碰撞体"必须读引擎事实，不能读我们自己的记账 */
  colliders: number;
  /** 质量：没有碰撞体的刚体质量是 0，这是"忘了建碰撞体"最直接的信号 */
  mass: number;
}

export interface PhysicsDebugApi {
  camera: () => { position: [number, number, number]; quaternion: [number, number, number, number] };
  bodies: () => PhysicsDebugBody[];
  character: () => PhysicsDebugBody | null;
  /** 把某个刚体（按 handle）挪到指定位置，零速度唤醒 */
  teleport: (handle: number, position: [number, number, number]) => boolean;
  /** 只摆相机朝向（俯仰/偏航，弧度，YXZ）。位置由物理角色每步写，所以别在这里改位置。 */
  look: (yaw: number, pitch: number) => void;
  grab: () => void;
  release: () => void;
  grabbing: () => boolean;
  /** 活动刚体数：A/B 测量时用来确认"物理是不是真的在跑" */
  awake: () => number;
  /** 世界总账：刚体数 / 碰撞体数。两者不匹配就是"刚体建了、碰撞体没建" */
  world: () => { bodies: number; colliders: number };
  /** 渲染层量模型包围盒走到哪一步了（measured / empty / reported） */
  boundsReports: () => { measured: number; empty: number; reported: number };
  /**
   * 某个刚体上每个碰撞体的**形状事实**。`numColliders() === 1` 只说明"挂上了"，
   * 挂上去的那个东西是不是在正确的位置、是不是退化形状、是不是 sensor，只有这里能回答。
   */
  colliderFacts: (handle: number) => unknown;
  /**
   * 准星射线（与抓取同一套判据）打了什么。抓取失败时第一个要回答的问题就是
   * "是射线没打中，还是打中了但关节没建起来"——这个读数把两者分开。
   */
  raycast: () => unknown;
  /**
   * 强制"指针已锁定"。本沙箱拿不到真实的指针锁定（Chrome 直接拒，
   * 见 `PLAYCANVAS_MIGRATION.md` 的记录），所以拖动/抓取只能在驱动里这样验。
   * 生产构建不装诊断口，这个开关也就不存在。
   */
  forceInput: (locked: boolean) => void;
}

/** 抓取句柄由 `FirstPersonGrab` 在挂载时登记（hook 不能条件调用，所以只能这样传出来） */
let grabHandles: { tryGrab: () => void; release: () => void; isGrabbing: () => boolean } | null = null;

export function setGrabHandles(
  handles: { tryGrab: () => void; release: () => void; isGrabbing: () => boolean } | null,
): void {
  grabHandles = handles;
}

export function activeGrabHandles() {
  return grabHandles;
}

/**
 * 「强制指针已锁定」。本沙箱拿不到真实的指针锁定（Chrome 直接拒绝，见
 * `PLAYCANVAS_MIGRATION.md` 的记录），所以"走动/抓取"这两条只能在驱动里用它验。
 * 生产构建不装诊断口，这个开关也就不存在；它是**唯一的**一条绕过点，别的判据仍然走产品路径。
 */
let forcedLocked = false;

export function setForcedLock(locked: boolean): void {
  forcedLocked = locked;
}

export function isForcedLocked(): boolean {
  return forcedLocked;
}

/**
 * 「模型包围盒走到哪一步了」的三个计数。碰撞体尺寸只能由渲染层量出来，所以当资产刚体上
 * `numColliders() === 0` 时，必须能一眼分清三种完全不同的故障：
 *   measured = 0 → 连模型 group 都没拿到（渲染层根本没进这条 effect）；
 *   empty    > 0 → 拿到了 group，但量出来的盒是空的（几何还没加载 / 层级不对）；
 *   reported > 0 → 量到了、回调也接上了，那问题在刚体/碰撞体那一侧。
 * 没有这三个数，"包围盒没报上来"和"报了但没建出碰撞体"只能靠猜。
 */
const boundsStats = { measured: 0, empty: 0, reported: 0 };

export function noteBoundsMeasured(): void {
  boundsStats.measured += 1;
}

export function noteBoundsEmpty(): void {
  boundsStats.empty += 1;
}

export function noteBoundsReported(): void {
  boundsStats.reported += 1;
}

export function boundsReportStats(): { measured: number; empty: number; reported: number } {
  return { ...boundsStats };
}

const DEBUG_KEY = "__PHYSICS__";

/**
 * 是否装诊断口。`import.meta.env` 在 bun 的测试环境里可能整个不存在，所以按可选读取，
 * 不能在模块顶层直接 `.DEV`（那会让引入本模块的单测在导入期就炸）。
 */
export function physicsDebugEnabled(search: string): boolean {
  const env = (import.meta as { env?: { DEV?: boolean } }).env;
  if (env?.DEV !== true) return false;
  return /[?&]physicsDebug=1(?:&|$)/.test(search);
}

export function installPhysicsDebug(
  api: Omit<PhysicsDebugApi, "grab" | "release" | "grabbing" | "forceInput">,
): () => void {
  if (typeof window === "undefined") return () => {};
  const target = window as unknown as Record<string, unknown>;
  target[DEBUG_KEY] = {
    camera: api.camera,
    bodies: api.bodies,
    character: api.character,
    teleport: api.teleport,
    look: api.look,
    grab: () => grabHandles?.tryGrab(),
    release: () => grabHandles?.release(),
    grabbing: () => grabHandles?.isGrabbing() ?? false,
    awake: api.awake,
    world: api.world,
    boundsReports: api.boundsReports,
    colliderFacts: api.colliderFacts,
    raycast: api.raycast,
    forceInput: (locked: boolean) => setForcedLock(locked),
  };
  return () => {
    delete target[DEBUG_KEY];
    grabHandles = null;
    forcedLocked = false;
  };
}

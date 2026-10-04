import * as THREE from "three";

/**
 * 物理层的**纯数值与纯判定**，与 rapier / R3F 无关，所以能被 happy-dom 单测直接钉住
 * （同 `shared/lib/cameraFlight.ts` 的形状：常量 + 纯函数，组件只负责接线）。
 *
 * 这里的每一个数都不是随手写的：
 * - 角色尺寸/眼高沿用第一人称漫游原有的 `EYE_HEIGHT = 1.6`（`FirstPersonRig.tsx`）与
 *   引擎侧 `walkRig.ts` 的 `EYE_HEIGHT`，换物理驱动不该顺手改手感；
 * - 半径 0.25、速度 3/7、阻尼 0.45/0.35、抓取限速 5/10 与 `image-blaster` 逐项一致
 *   （它的 `CharacterController.tsx` / `SceneObject.tsx` / `useObjectGrab.ts`），
 *   这样"能推、能抓、能甩"的手感有对照物，改动前先有基准。
 */

/** 与 rapier 默认一致；写出来是为了让"重力属于产品参数"这件事显式 */
export const PHYSICS_GRAVITY: [number, number, number] = [0, -9.81, 0];

/** 第一人称胶囊体：总高 1.6、半径 0.25 ⇒ 圆柱段半长 0.55 */
export const CHARACTER_HEIGHT = 1.6;
export const CHARACTER_RADIUS = 0.25;
/**
 * 眼睛相对**刚体中心**的高度差。胶囊体中心在这一点上，所以眼高 = 身高的一半；
 * `FirstPersonRig` 以前直接写 `camera.position.y = 1.6`（脚在 y=0 时的眼高），
 * 两者只在"站在 y=0 的地面上"时相等——换成物理驱动后地面可能不是 y=0（见 groundOffset）。
 */
export const CHARACTER_EYE_OFFSET = CHARACTER_HEIGHT / 2;

export const WALK_SPEED = 3;
export const RUN_SPEED = 7;
/** 起跳初速度：约 0.9 m 跳跃高度（h = v²/2g），比 image-blaster 的 3 稍高，因为房间尺度更大 */
export const JUMP_VELOCITY = 4.2;

/**
 * 单帧步长上限。标签页恢复、首次编译卡顿都会给出一个巨大的 delta，不钳住就会出现
 * "人物瞬移穿墙"——与 `FirstPersonRig` 原有的 `Math.min(delta, 0.1)` 同一个理由。
 */
export const MAX_FRAME_DELTA = 0.1;

/** 向下探地的射线长度：从刚体中心到略低于脚底 */
export const GROUND_PROBE_DISTANCE = CHARACTER_HEIGHT / 2 + 0.12;

/**
 * 掉到这个高度以下就判定"掉出世界"，把角色送回出生点。
 * 不用 y = 0 当前的安全网：世界碰撞网格的地面在 `groundPlaneOffset`（实测某项目 1.06），
 * 贴着 0 放一张地板会让角色站在世界地板**下面**，画面里直接消失。
 */
export const FALL_RESET_Y = -50;

/**
 * 多窗格每帧都在画同一个核心场景，物理调试可视化会污染 agent 的整场景检查图，
 * 所以默认不开（需要时把 `debug` 传成 true 在探针里看）。
 */
export const PHYSICS_DEBUG = false;

export const OBJECT_LINEAR_DAMPING = 0.45;
export const OBJECT_ANGULAR_DAMPING = 0.35;

/**
 * 地面平板：与 image-blaster 的 `GroundPlane` 同构（它也是 200×200、顶面在 y=0）。
 *
 * 为什么必须有它：世界碰撞网格**只是那一间房的外壳**，不是无限地面。实测同一件家具
 * （2026-10-04，`p-muo3u17c`）：
 *   - 丢在角色站过的位置（房间内）→ 落在 y=0.456，底面贴地；
 *   - 丢在它自己的网格默认位 (−3, ·, −6) → 一路掉到 −41 仍在加速，**那个位置没有地板**。
 * 而 `computeSceneLayout` 的网格默认位就是铺开到 ±3 / −9 的，很容易落在房间外；
 * 没有 world 的项目（如 `p-mupq6eua`）更是整块地板都不存在——那样角色一进第一人称
 * 就会永远下落。
 *
 * `ground_plane_offset` 的语义是把地面抬到 **y=0**（见 `WorldSemantics.groundPlaneOffset`
 * 的注释：Y 平移，把地面抬到 y=0），所以这块平板的顶面也放在 y=0：有 world 时它与房间
 * 地面重合，没有 world 时它就是唯一的地面。半尺寸 100 ⇒ 200×200，覆盖整个网格布局。
 */
export const PHYSICS_GROUND_HALF_EXTENT = 100;
export const PHYSICS_GROUND_THICKNESS = 0.05;

/**
 * 兜底安全网（image-blaster 也有一张，在 y = −10）：万一有东西掉到地板以下
 * （例如 scene.json 里本来就摆在地面之下的资产），别让它无限下落——
 * 无限下落会让刚体一直"活动"，`forEachActiveRigidBody` 就会每帧要新帧，白烧 CPU。
 */
export const PHYSICS_SAFETY_NET_Y = -10;

/** 准星抓取：手感半径与限速 */
export const GRAB_MAX_DISTANCE = 3;
export const GRAB_LINEAR_LIMIT = 5;
export const GRAB_ANGULAR_LIMIT = 10;

/** 胶囊体的 rapier 参数：`CapsuleCollider args = [圆柱半长, 半径]` */
export function characterCapsule(): { halfSegment: number; radius: number } {
  return { halfSegment: CHARACTER_HEIGHT / 2 - CHARACTER_RADIUS, radius: CHARACTER_RADIUS };
}

export interface ColliderBox {
  /** 盒体半尺寸（局部坐标系，未乘摆放缩放） */
  halfExtents: [number, number, number];
  /** 盒体中心（局部坐标系） */
  center: [number, number, number];
}

/**
 * 把一个**已渲染模型**的局部包围盒变成盒体碰撞体参数。
 *
 * 为什么必须是盒体而不是 trimesh：本项目真实资产是 40 MB 级、140 万三角面的生成模型
 * （`cream-sofa` 1 487 850 tris、`geometric-rug` 1 400 702 tris，2026-10-04 实测），
 * 逐个建 trimesh 既慢又占内存；世界碰撞网格则是 6.4 万面（`0-world.glb` 63 861 tris），
 * 那一份才用 trimesh。这个取舍与 `image-blaster` 一致。
 *
 * 最小边长钳到 0.01：塌成零厚度的盒体在 rapier 里会产生 NaN 法线。
 */
export function boxColliderFromBounds(box: THREE.Box3): ColliderBox {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const half = (value: number) => Math.max(Math.abs(value) / 2, 0.01);
  return {
    halfExtents: [half(size.x), half(size.y), half(size.z)],
    center: [center.x, center.y, center.z],
  };
}

/**
 * 从偏航角算水平速度（三的 `Euler(0, yaw, 0, "YXZ")` 约定）：
 * forward = (0,0,-1) 绕 Y 转 yaw ⇒ (-sin, 0, -cos)；right = (1,0,0) ⇒ (cos, 0, -sin)。
 * 单测拿真实 `THREE.Quaternion` 当真值钉住，避免这里写反方向（写反了是"按 W 后退"，
 * 静默、只是别扭）。
 */
export function horizontalVelocity(
  forward: number,
  strafe: number,
  yaw: number,
  speed: number,
): [number, number] {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const x = -sin * forward + cos * strafe;
  const z = -cos * forward - sin * strafe;
  const length = Math.hypot(x, z);
  if (length <= 1) return [x * speed, z * speed];
  return [(x / length) * speed, (z / length) * speed];
}

/** 把三维速度钳到上限（原地改传入数组，避免每帧分配） */
export function clampVelocity(
  velocity: [number, number, number],
  limit: number,
): [number, number, number] {
  const length = Math.hypot(velocity[0], velocity[1], velocity[2]);
  if (length <= limit || length === 0) return velocity;
  const scale = limit / length;
  velocity[0] *= scale;
  velocity[1] *= scale;
  velocity[2] *= scale;
  return velocity;
}

/**
 * 松手时给物体的速度：取指针目标点两帧之间的位移除以物理步长。
 * 等于"跟着手甩出去"，但必须钳上限，否则快速拖拽会把物体弹到墙外。
 * `dt <= 0`（物理世界刚重建、时间步还没写）时返回零速度——除零会得到 Infinity，
 * rapier 收到 Infinity 会静默把物体变成 NaN 位置。
 */
export function dragVelocity(
  previous: [number, number, number],
  next: [number, number, number],
  dt: number,
  limit: number,
): [number, number, number] {
  if (!(dt > 0)) return [0, 0, 0];
  return clampVelocity(
    [(next[0] - previous[0]) / dt, (next[1] - previous[1]) / dt, (next[2] - previous[2]) / dt],
    limit,
  );
}

export interface PhysicsFrameDemand {
  /** 第一人称（物理角色）是否挂着：它每帧都要被模拟与重画 */
  characterActive: boolean;
  /** 是否正在抓取物体 */
  grabbing: boolean;
  /** 还没睡着的刚体数量：>0 就说明画面还在变 */
  awakeBodies: number;
}

/**
 * `frameloop="demand"` 下的续帧判据：只有这三件事之一成立时才需要新的帧。
 *
 * 写成纯函数而不是在组件里 `invalidate()` 无脑调用，是因为这个仓库已经踩过
 * "无条件 invalidate = 常驻 60 fps 空转"的坑（见 `animationLoop.ts` 的说明）；
 * 判据必须能被单测枚举，否则回归时没人发现它变成恒真。
 */
export function needsPhysicsFrames(demand: PhysicsFrameDemand): boolean {
  return demand.characterActive || demand.grabbing || demand.awakeBodies > 0;
}

/**
 * 摆放（gizmo 提交或布局变化）与刚体当前位姿是否已经分开。
 * 分开就要把摆放**推**回刚体（teleport），否则物理会一直把物体拉回旧位置。
 * 阈值按 Float32 精度取 1e-4：rapier 内部是 f32，比这更小的差值是噪声。
 */
export const PLACEMENT_EPSILON = 1e-4;

export function placementMoved(
  current: { position: [number, number, number]; rotation: [number, number, number, number] },
  desired: { position: [number, number, number]; rotation: [number, number, number, number] },
  epsilon = PLACEMENT_EPSILON,
): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(current.position[i]! - desired.position[i]!) > epsilon) return true;
  }
  // 四元数 q 与 -q 是同一个旋转，逐个分量比会误判，取"点积绝对值接近 1"为准
  let dot = 0;
  for (let i = 0; i < 4; i += 1) dot += current.rotation[i]! * desired.rotation[i]!;
  return Math.abs(Math.abs(dot) - 1) > epsilon;
}

/**
 * 物理**默认开启**；`?physics=0` 是给测量用的 A/B 开关。
 *
 * 这个开关不是"功能开关"，而是仓库测量纪律要求的对照臂：任何"加了物理之后帧时间变了多少"
 * 的结论都必须有一轮关掉物理的同机对照（见 `AGENTS.md` 第二节：不得在无测量的情况下
 * 改性能/画质默认值）。产品路径不带这个参数，行为就是开启。
 */
export function physicsEnabledFromSearch(search: string): boolean {
  return !/[?&]physics=0(?:&|$)/.test(search);
}

import { Raycaster, Vector3, type Object3D } from "three";
import type { Vec3 } from "./handLandmarks";
import type { AssetPlacement } from "./scenePlacement";

/**
 * 手势**与场景交互**的纯数学：把"相机 → 捏合点"这支射线打在摆放资产上，再把命中的那一件
 * 沿着射线搬走。
 *
 * ### 为什么拾取不用 R3F 的指针事件
 * R3F 的事件是从**指针**（鼠标/触摸）产生的，而手势模式里没有指针——它是一支由关键点算出来的
 * 射线。`PanePickTarget` 那条通路绑在窗格 DOM 上，第一人称下整棵都不挂（没有窗格）。
 * 所以这里直接用 `THREE.Raycaster` 打**已挂载资产的根节点**：`objects` 那张表就是
 * `PlacedAsset` 登记进来的（见 index.tsx），与拾取代理读的是同一份场景图。
 *
 * ### 为什么必须"沿父链找身份"，不能按名字比
 * 命中给的是某一块 `Mesh`，而我们要的是资产 id。PC 侧踩过按名字比的坑（容器实例化的根名
 * 可能是文件名），所以这里从命中对象沿 `parent` 往上走，直到遇到 `objects` 里的那个**同一个对象**
 * （按引用比对）。`objects` 的键本来就是稳定资产 id，于是"命中 → id"是一条不会误认的路。
 * 单测见 `handGrab.test.ts`。
 */

export interface HandRay {
  origin: Vec3;
  direction: Vec3;
}

export interface HandPick {
  assetId: string;
  /** 命中的那个节点（不一定是根：可能是某一级子 mesh） */
  object: Object3D;
  /** 世界空间的命中点 */
  point: Vec3;
  /** 命中距离（米） */
  distance: number;
}

/** 位置阈值（米）：小于它算"没挪过"，与 `grabCommit.ts` 的 `DROP_POSITION_EPSILON` 同口径 */
export const DRAG_POSITION_EPSILON = 1e-3;

/** 拖动时物体最多能被搬到多远（米）：超出这条线的点会被钳住，防止物体被甩到无穷远 */
export const DRAG_MAX_DISTANCE = 12;

/**
 * 命中对象 → 资产 id（沿父链找**同一引用**）。
 *
 * 用一次性的 `Map<Object3D, string>` 而不是对每个祖先遍历 `objects`：
 * `objects` 可能有几十项、父链也可能有好几级，每次 pointermove 都双重循环是没必要的开销。
 */
export function assetIdForObject(
  object: Object3D | null | undefined,
  objects: ReadonlyMap<string, Object3D>,
): string | null {
  if (!object) return null;
  const owners = new Map<Object3D, string>();
  for (const [id, root] of objects) {
    // 同一棵树被登记两次时保留先登记的那个：`objects` 的键是资产 id，先来后到是确定的
    if (!owners.has(root)) owners.set(root, id);
  }
  let node: Object3D | null = object;
  while (node) {
    const id = owners.get(node);
    if (id !== undefined) return id;
    node = node.parent;
  }
  return null;
}

/**
 * 射线打在摆放资产上，返回**最近的一个能解析出资产 id 的**命中。
 *
 * 为什么不是"最近命中"直接返回：命中的可能是资产自身之外的节点（将来加进来的辅助网格、
 * 或者世界碰撞网格被顺手放进 objects），解析不出 id 时应当继续往后找，而不是判成"点空了"。
 * 这与 PC 侧 `PlayCanvasViewport` 的拾取口径一致。
 */
export function pickPlacedAsset(
  raycaster: Raycaster,
  objects: ReadonlyMap<string, Object3D>,
  maxDistance = DRAG_MAX_DISTANCE,
): HandPick | null {
  if (objects.size === 0) return null;
  const roots = [...objects.values()];
  raycaster.near = 0;
  raycaster.far = maxDistance;
  const hits = raycaster.intersectObjects(roots, true);
  for (const hit of hits) {
    // 射线起点后面的交点一律不算（three 在某些几何上会给出负距离）
    if (!(hit.distance >= 0) || hit.distance > maxDistance) continue;
    const assetId = assetIdForObject(hit.object, objects);
    if (!assetId) continue;
    return {
      assetId,
      object: hit.object,
      point: [hit.point.x, hit.point.y, hit.point.z],
      distance: hit.distance,
    };
  }
  return null;
}

/** 射线上距离起点 `distance` 的那个点（`distance` 会被钳到 `DRAG_MAX_DISTANCE`） */
export function pointAlongRay(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  const d = Math.min(Math.max(distance, 0), DRAG_MAX_DISTANCE);
  return [origin[0] + direction[0] * d, origin[1] + direction[1] * d, origin[2] + direction[2] * d];
}

/** 从 `from` 指向 `to` 的单位方向；两点重合时返回 null（不能拿零向量去 setFromUnitVectors） */
export function directionBetween(from: Vec3, to: Vec3): Vec3 | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  if (length <= 1e-6) return null;
  return [dx / length, dy / length, dz / length];
}

/**
 * 拖动中的摆放：位置 = 沿射线固定深度的点 + 抓取时冻结的相对偏移，姿态与缩放原样不动。
 *
 * 冻结偏移（而不是"物体直接贴到命中点"）是必须的：手捏在模型的边角上时，物体应当保持
 * 那个被捏住的相对位置，否则一捏住物体就会跳一下、把捏住的点对到自己的原点。
 * 与第一人称抓取（`useObjectGrab` 的球形关节锚点写在命中表面上）是同一个口径。
 */
export function draggedPlacement(base: AssetPlacement, position: Vec3): AssetPlacement {
  return {
    position: [position[0], position[1], position[2]],
    rotation: [base.rotation[0], base.rotation[1], base.rotation[2]],
    scale: [base.scale[0], base.scale[1], base.scale[2]],
  };
}

/** 松手时判断"真的挪过没有"：只比位置（拖动不改姿态与缩放），阈值同抓取落盘 */
export function dragMoved(before: Vec3, after: Vec3, epsilon = DRAG_POSITION_EPSILON): boolean {
  return Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > epsilon;
}

/** 抓取时冻结"命中点 → 物体原点"的偏移（世界坐标） */
export function grabOffsetFor(objectPosition: Vec3, hitPoint: Vec3): Vec3 {
  return [
    objectPosition[0] - hitPoint[0],
    objectPosition[1] - hitPoint[1],
    objectPosition[2] - hitPoint[2],
  ];
}

/** 复用同一个 Raycaster 的模块级实例（每帧拾取一次，别在热路径里 new） */
const dragRaycaster = new Raycaster();
const _origin = new Vector3();
const _direction = new Vector3();

/**
 * 每帧一次的拾取：给定射线与资产表，返回最近的可抓取命中。
 * `Raycaster` 复用模块级实例（避免每帧新建）；调用方不该保存返回的对象身份之外的引用。
 */
export function pickWithRay(
  ray: HandRay,
  objects: ReadonlyMap<string, Object3D>,
  maxDistance = DRAG_MAX_DISTANCE,
): HandPick | null {
  if (ray.direction[0] === 0 && ray.direction[1] === 0 && ray.direction[2] === 0) return null;
  _origin.set(ray.origin[0], ray.origin[1], ray.origin[2]);
  _direction.set(ray.direction[0], ray.direction[1], ray.direction[2]).normalize();
  dragRaycaster.set(_origin, _direction);
  return pickPlacedAsset(dragRaycaster, objects, maxDistance);
}

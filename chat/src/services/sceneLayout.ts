import type { AssetTransform, Vec3 } from "../dto/library";

/**
 * 工作台场景的**默认网格布局**：没有手动摆放记录的资产由这里算位置。
 *
 * 这是 `app/src/widgets/Viewport/scenePlacement.ts` 的 chat 侧同源实现，两处必须给出
 * 同一组坐标——否则 agent 会说"小熊在 (3,0,-3)"，而视口把它画在别处，任何
 * "把 A 放到 B 上面"的计算都会偏一整格。app 在冻结集里、两个包也不共享代码，
 * 所以这里只能靠**同源公式 + 两侧各自的测试**钉住（app 侧 `scenePlacement.test.ts`，
 * 这里 `sceneLayout.test.ts`）。
 *
 * 三条与 app 逐字一致的约定：
 * 1. 参与布局的资产按 `createdAt` 升序排、相同时按 slug 排；**手动摆过的资产仍然占着
 *    自己那个序号**（不摘掉，否则挪走一个会让后面全体前移一格）。
 * 2. 列数 = min(3, 总数)，行号沿 **−Z** 增长；起点在中列，所以 3 列时是 −3 / 0 / +3。
 * 3. 没有条目的资产用网格默认位，条目按**资产稳定 id** 索引（不是 slug）——删除后用
 *    同名 slug 重建不会继承旧摆放。
 */

const GRID_CELL_SIZE = 3;
const GRID_MAX_COLUMNS = 3;

/** 网格布局起点（world 背景存在时也在其范围内居中） */
const GRID_ORIGIN: Vec3 = [0, 0, 0];

const NO_ROTATION: Vec3 = [0, 0, 0];
const UNIT_SCALE: Vec3 = [1, 1, 1];

/** 参与网格布局的资产：只要视口会画它的模型，它就得占一个格子。 */
export interface PlaceableAsset {
  /** 资产稳定 id（`assetStableId`） */
  id: string;
  slug: string;
  createdAt?: string;
}

export function gridPosition(index: number, total: number): Vec3 {
  const columns = Math.min(GRID_MAX_COLUMNS, Math.max(1, total));
  const column = index % columns;
  const row = Math.floor(index / columns);

  return [
    GRID_ORIGIN[0] + (column - (columns - 1) / 2) * GRID_CELL_SIZE,
    GRID_ORIGIN[1],
    GRID_ORIGIN[2] + row * -GRID_CELL_SIZE,
  ];
}

/**
 * 布局顺序：`createdAt` 升序，相同则按 slug。**只有这一份实现**——分析场景时给资产
 * 编号（A1/A2…）和算网格坐标必须是同一个顺序，否则编号与实际落点会错位。
 */
export function comparePlaceable(a: PlaceableAsset, b: PlaceableAsset): number {
  const ac = a.createdAt ?? "";
  const bc = b.createdAt ?? "";
  if (ac !== bc) return ac < bc ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/**
 * 资产稳定 id → 它**当前生效**的摆放：手动记录优先，否则网格默认位。
 * 与 app 的 `computeSceneLayout` 同源，用来回答"某个资产现在到底在哪"。
 */
export function computeSceneLayout(
  assets: readonly PlaceableAsset[],
  transforms: Record<string, AssetTransform> = {},
): Map<string, AssetTransform> {
  const placeable = [...assets].sort(comparePlaceable);

  const layout = new Map<string, AssetTransform>();
  placeable.forEach((asset, index) => {
    layout.set(
      asset.id,
      transforms[asset.id] ?? {
        position: gridPosition(index, placeable.length),
        rotation: NO_ROTATION,
        scale: UNIT_SCALE,
      },
    );
  });
  return layout;
}

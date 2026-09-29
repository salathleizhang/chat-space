import type { AssetTransform, LibraryAsset, Vec3 } from "../../shared/lib/libraryApi";

const GRID_CELL_SIZE = 3;
const GRID_MAX_COLUMNS = 3;

/** 网格布局起点（world 背景存在时也在其范围内居中） */
const GRID_ORIGIN: Vec3 = [0, 0, 0];

const NO_ROTATION: Vec3 = [0, 0, 0];
const UNIT_SCALE: Vec3 = [1, 1, 1];

/** 场景里一个资产的完整摆放，直接喂给 `<group position rotation scale>` */
export interface AssetPlacement {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

function gridPosition(index: number, total: number): Vec3 {
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
 * 共享场景摆放：按 createdAt（缺失时退化为 assetSlug）排序后逐个分配网格坐标，
 * **用户用 gizmo 手动调过的资产以 `transforms` 里的记录为准**（按 assetSlug 索引，
 * 来自 scene.json，见 `pages/AppDashboard/useSceneTransforms.ts`）。
 *
 * 网格默认位仍是纯派生、不落盘的：已有资产的排序位置不因新资产加入而改变，新资产只会
 * 追加到末尾的新格子。手动摆过的资产虽然不在原格子上了，但**仍然占着自己那个序号**
 * ——不把它从排序里摘掉，否则手动挪走一个模型会让后面所有模型集体前移一格。
 * world 资产不参与摆放（作为场景背景渲染），排除在外。
 */
export function computeSceneLayout(
  assets: LibraryAsset[],
  transforms: Record<string, AssetTransform> = {},
): Map<string, AssetPlacement> {
  // filter() 已经返回一份新数组，原地 sort 它不会影响调用方的 assets，
  // 不需要再多一次 .slice() 复制
  const placeable = assets
    // 世界是背景；天空盒/图片等没有模型产物，也不能占掉一个默认网格位置
    .filter((a) => a.kind !== "world" && a.modelPath)
    .sort((a, b) => {
      const ac = a.createdAt ?? "";
      const bc = b.createdAt ?? "";
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.assetSlug < b.assetSlug ? -1 : a.assetSlug > b.assetSlug ? 1 : 0;
    });

  const layout = new Map<string, AssetPlacement>();
  placeable.forEach((asset, index) => {
    // 场景表按**稳定 id** 索引，不是 slug：删除同名资产重建后不该继承旧摆放
    const saved = transforms[asset.id];
    layout.set(
      asset.id,
      saved ?? {
        position: gridPosition(index, placeable.length),
        rotation: NO_ROTATION,
        scale: UNIT_SCALE,
      },
    );
  });
  return layout;
}

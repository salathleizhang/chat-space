/**
 * PC 侧"摆放资产 → 物理化身"的**纯数学**（与引擎无关，所以能单测）。
 *
 * 引擎侧怎么算包围盒、怎么挂组件在 `assetScene.ts`；这里只回答一个可验证的问题：
 * "一对待定界的 min/max 换成一个盒体碰撞体的半尺寸是多少"。
 */

export interface LocalBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * 最小半边长度。塌成零厚度的盒体在 Bullet 里会产生退化形状（法线为 NaN、接触解不出来），
 * 而生成模型确实会出现"某一轴厚度为 0"的情况（例如一张贴地的地毯）。
 */
export const MIN_HALF_EXTENT = 0.01;

/**
 * 局部包围盒 → 盒体碰撞体半尺寸。没有包围盒（模型没有网格、AABB 拿不到）时返回 `null`，
 * 让调用方**显式跳过**这次挂载——挂一个尺寸为零的碰撞体比不挂更难查。
 */
export function halfExtentsFromBounds(
  bounds: LocalBounds | null | undefined,
): [number, number, number] | null {
  if (!bounds) return null;
  const half = (min: number, max: number) =>
    Math.max(Math.abs(max - min) / 2, MIN_HALF_EXTENT);
  return [
    half(bounds.min[0], bounds.max[0]),
    half(bounds.min[1], bounds.max[1]),
    half(bounds.min[2], bounds.max[2]),
  ];
}

/**
 * 包围盒中心（盒体碰撞体相对实体的偏移）。
 *
 * ⚠️ three 侧把模型 `<Center>` 到原点，所以那边**不需要**偏移；PC 侧没有这一步，
 * GLB 自己的原点可能不在几何中心（生成模型的常见情况），不补这个偏移的话碰撞体会跟
 * 模型错开一截——症状是"看着没碰到、却被弹开"。
 */
export function centerFromBounds(
  bounds: LocalBounds | null | undefined,
): [number, number, number] | null {
  if (!bounds) return null;
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

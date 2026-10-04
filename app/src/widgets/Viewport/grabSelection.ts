/**
 * 「第一人称抓起模型 = 在第三人称选中它」的**纯映射**（three / rapier 路径）。
 *
 * 为什么要有这一层而不是就地写两行：抓取那一步只拿得到 rapier 的碰撞体，
 * "抓到的是哪一件资产"必须从刚体的 `userData`（`PhysicalAsset` 写的 `assetId`）
 * 反查回 `LibraryAsset`。这三件事各有独立的失败方式，且**全都静默**：
 *
 * 1. 刚体没带 `assetId`（例如角色刚体只带 `character: true`、或将来别处新建的刚体）
 *    ⇒ 不是"选错了"，而是**不该选中任何东西**；写成 `userData.assetId` 直接透传的话，
 *    `undefined` 会一路进 `selectedIds`，症状是"选中集里多了一个不存在的 id"，
 *    右侧栏空白、线框不出现，看不出是谁的错。
 * 2. `assetId` 不属于**已摆放**的资产（世界里固定不动的刚体、已删除资产留下的刚体）
 *    ⇒ 同样只能什么都不做；**不能顺手清空选中**——第一人称里那一下点击的本意是"抓"，
 *    没抓到不该等于"点空白"。
 * 3. 抓到了、也解析出来了，但传上去的必须是**同一份** `LibraryAsset`（上层按 id 比对），
 *    所以这里统一从 `placedAssets` 里取对象，不新造。
 *
 * 单测见 `grabSelection.test.ts`：①角色刚体 ②无关刚体 ③世界里的固定物 ④正常命中。
 */

/**
 * 从刚体的 `userData` 里取稳定资产 id。
 *
 * 只认**非空字符串**：空串同样是一个"看起来有值"的坑（`{ assetId: "" }` 会通过真值判断
 * 的反面写法，却永远匹配不到任何资产）。
 */
export function grabbedAssetId(userData: unknown): string | null {
  if (!userData || typeof userData !== "object") return null;
  const id = (userData as { assetId?: unknown }).assetId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * 在已摆放资产里按 id 取对象。
 *
 * 返回 `null` 表示"这一下抓取不该改变选中"（不是"抓失败了"——抓取本身成功与否由
 * `useObjectGrab` 自己的关节状态回答）。调用方拿到 `null` 时**保持原选中不变**。
 */
export function findGrabbedAsset<T extends { id: string }>(
  assets: readonly T[],
  assetId: string,
): T | null {
  return assets.find((asset) => asset.id === assetId) ?? null;
}

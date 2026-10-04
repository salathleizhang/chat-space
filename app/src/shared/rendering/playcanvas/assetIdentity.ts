/**
 * PC 侧「命中实体 → 已挂载资产 id」的**唯一解析点**（纯逻辑，与引擎无关，所以能单测）。
 *
 * 两条入口共用它：**点选**（`panePicking` 的 Picker 给一个 mesh 实体）与
 * **第一人称准星抓取**（引擎 `rigidbody.raycastFirst` 给一个碰撞实体）。两者拿到的实体
 * 层次不同——Picker 给的是某块 mesh（资产根的后代），抓取给的是资产根自己（盒体碰撞体
 * 挂在根上，见 `assetScene.attachDynamicBoxBody`）——所以判据必须**双向**包含：
 * 命中就是根、命中是根的后代、或被命中的实体是根的后代。
 *
 * 为什么必须按**身份**而不是名字：引擎里容器的根名可能是文件名/"model.glb"，
 * 拿它去比 `asset.id`/`assetSlug` 永远比不中，于是"点中模型"被当成"点空白"而清空选中——
 * 真机症状是**怎么点都选不中**（扫 28 个点全落空，本机踩过）。
 */

/** 引擎实体里我们真正依赖的那一个方法（`GraphNode.isDescendantOf`） */
export interface IdentityNode {
  isDescendantOf?(node: unknown): boolean;
}

/**
 * 解析命中实体属于哪一件已挂载资产；解析不出来返回 `null`。
 *
 * `ids` / `rootFor` 由调用方给（产品里是 `SceneAssetsHandle` 的 `ids()` 与
 * `entry(id)?.entity`），这样本模块不需要认识那个句柄。
 *
 * 返回 `null` 有两种情况，调用方**必须分开对待**：
 * ① 这个实体不属于任何已挂载资产（地面、天空、锚点……）——点选时算"点了空白"，
 *    抓取时算"抓到了不该抓的东西"，**不要**顺手清空选中；
 * ② 根实体还没建好（`rootFor` 返回空）——跳过它，继续找下一个。
 */
export function assetIdForEntity(
  ids: Iterable<string>,
  rootFor: (id: string) => IdentityNode | null | undefined,
  hit: unknown,
): string | null {
  if (!hit) return null;
  const hitNode = hit as IdentityNode;
  for (const id of ids) {
    const root = rootFor(id);
    if (!root) continue;
    if (
      root === hit
      || root.isDescendantOf?.(hit)
      || hitNode.isDescendantOf?.(root)
    ) {
      return id;
    }
  }
  return null;
}

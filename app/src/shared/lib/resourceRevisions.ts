import type { AssetResourceIdentity } from "./libraryApi";

/**
 * 资源修订号（`LibraryAsset.resourceRevision`）的发放规则。
 *
 * 修订号是 loader 身份的**唯一**来源：它进 URL（`.../0-chair.glb?revision=7`）、进 R3F 的
 * `key`、进 `ResettableErrorBoundary` 的 `resetKey`。它一变，three 的 `useLoader` 就按新
 * URL 重新下载并重新解析，组件也会整个重挂载。
 *
 * **所以它必须按资产发，不能按"项目扫描代次"发。** 曾经的写法是把整个工作台的
 * `refreshKey` 直接塞给所有资产（`useProjectState`），而 `refreshKey` 在每个后台任务落盘时
 * 都会 +1（`useTaskPolling` 的完成回调）：一次批量生成 10 件家具，每落盘一件就把已经加载好的
 * 全部模型重新下载 + 重新解析 + 重新挂载一遍（那时每件 GLB 40+ MB）。
 */

/**
 * 资产"渲染产物身份"：只有它变化时 loader 才应该换修订号。
 *
 * 只取 loader 真正加载的那几个路径——模型主产物/分段部件、OBJ 的 `.mtl`、world 的 splat、
 * 天空盒的环境贴图。刻意不含 `files` 全表（里面有 `.thumb-*`、`inspections` 目录项），
 * 也不含 `worldSemantics`：那是渲染时的变换参数，由 props 传下去，换值不需要重新加载 splat。
 *
 * 由此推出的四种情形：
 * - 缺文件被 `repair-assets` 回填 → 身份从"没有模型"变成有 → 换号，重新加载并让
 *   `RecoverableModelLoader` 获得一次清掉旧"拒绝"缓存的机会（这正是修订号的原意）；
 * - 新的一代产物（索引递增，`0-x.glb` → `1-x.glb`）→ 路径本身变了，顺带换号；
 * - 缩略图、预览图、四视角自检图落盘 → **不换号**：它们不是 loader 的输入；
 * - 同一路径被原样重写（`repair-assets` 重新解包同一个 seed3d zip）→ 拿不到新号。
 *   这种字节来自同一个供应商产物，缓存里的解析结果仍然是对的；真正换了内容的情形
 *   都是新一代文件，路径本身就会变。
 */
export function resourceSignature(asset: AssetResourceIdentity): string {
  // JSON 而不是分隔符拼接：全等比较要求这个串无歧义，路径里出现分隔符字符也不该撞签名
  return JSON.stringify([asset.modelPaths, asset.mtlPath, asset.spzPath, asset.hdrPath]);
}

export interface ResourceRevisions {
  /** 该资产此刻应使用的修订号；身份没变就返回同一个号，身份变了才发新号。 */
  revisionFor(asset: AssetResourceIdentity): number;
  /** 丢掉已经不存在的资产（删除、换项目），避免长会话里无界增长。 */
  prune(liveIds: Iterable<string>): void;
}

/**
 * 按**资产稳定 id**记账，不是 slug：slug 可以被删除后复用，而 `0-chair.glb?revision=N`
 * 这样的 URL 只靠修订号区分新旧身份。按 id 记账，同名重建的资产天然拿不到旧号，
 * 也就不会命中浏览器/loader 里那份属于上一件资产的缓存。
 */
export function createResourceRevisions(): ResourceRevisions {
  const byId = new Map<string, { signature: string; revision: number }>();
  let next = 0;
  return {
    revisionFor(asset) {
      const signature = resourceSignature(asset);
      const seen = byId.get(asset.id);
      if (seen && seen.signature === signature) return seen.revision;
      const revision = ++next;
      byId.set(asset.id, { signature, revision });
      return revision;
    },
    prune(liveIds) {
      const live = new Set(liveIds);
      for (const id of [...byId.keys()]) {
        if (!live.has(id)) byId.delete(id);
      }
    },
  };
}

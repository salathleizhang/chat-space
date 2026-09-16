import { useCallback, useEffect, useRef, useState } from "react";
import { libraryUrl, uploadThumbnail, type LibraryAsset } from "../../shared/lib/libraryApi";

/**
 * 列表缩略图的生成队列。
 *
 * 只对**新出现的产物**排队，不回填历史资产（产品决策 2026-07，天空盒也不破例）：
 * 挂载时先把磁盘现状登记进 seenRef 但一张不渲，之后某个资产第一次出现、或换代出
 * 更高索引的产物（`3-chair.glb` → `4-chair.glb`）才进队列——后者不渲的话列表会挂着
 * 一张跟当前模型对不上的旧图，比没有图更糟。
 *
 * 队列严格串行（一次只喂一个给 ThumbnailRenderer）：并发渲染会同时拉起 N 个 glb，
 * 内存和网络都扛不住，而缩略图完全不急。
 */

/**
 * 这个资产拿什么渲缩略图：模型资产渲主产物模型，天空盒没有模型产物、渲的是
 * 贴了环境贴图的球，源就是那张 HDR（与 `deriveLibraryAssets` 里的 thumbSource 同取舍）。
 * 返回 null 即"这类资产不出缩略图"，走 kind 图标占位。
 */
export function thumbSourcePath(asset: LibraryAsset): string | null {
  return asset.modelPath ?? (asset.kind === "skybox" ? asset.hdrPath : null);
}

/** 任务身份必须包含源产物版本；同一资产换代时 id 不变。 */
function thumbnailJobKey(asset: LibraryAsset): string {
  return `${asset.id}::${thumbSourcePath(asset)}`;
}

interface Options {
  projectSlug: string;
  assets: LibraryAsset[];
  /** 生成任务/导入完成时由上层递增——第一次递增之前只登记不排队 */
  refreshKey: number;
  /** 缩略图已经落盘；用于把它回填到对应的异步任务消息。 */
  onGenerated?: (asset: LibraryAsset, sourcePath: string, thumbnailPath: string) => void;
}

export interface ThumbnailQueue {
  /** 当前该渲的资产，null 表示队列空闲（此时不该挂载离屏画布） */
  current: LibraryAsset | null;
  /** 队列里待处理（含正在渲）的资产 id，列表据此显示占位骨架 */
  pendingIds: Set<string>;
  /** 本次会话刚渲好的缩略图：`assetId::源产物路径` → 逻辑路径，省一次全量刷新 */
  generated: Map<string, string>;
  onCaptured: (asset: LibraryAsset, pngBase64: string | null) => void;
}

export function useThumbnailQueue({
  projectSlug,
  assets,
  refreshKey,
  onGenerated,
}: Options): ThumbnailQueue {
  const activeRef = useRef(true);
  const [queue, setQueue] = useState<LibraryAsset[]>([]);
  const [generated, setGenerated] = useState<Map<string, string>>(() => new Map());
  /** assetId → 上次见到的源产物路径，用来认出"新出现/换代了" */
  const seenRef = useRef(new Map<string, string>());
  /** `${assetId}::${源产物路径}` 已处理过（成功或失败都算），避免失败资产反复重试 */
  const doneRef = useRef(new Set<string>());
  /** 当前仍存活的资产 id；onCaptured 用它丢弃"渲染/上传期间被删除"的在途缩略图 */
  const aliveIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const initialKeyRef = useRef(refreshKey);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // 先于下面登记 assets 的 effect 声明：同一次提交里先解锁再登记，
  // 这样"刷新带进来的新资产"当轮就能排上队
  useEffect(() => {
    if (refreshKey !== initialKeyRef.current) primedRef.current = true;
  }, [refreshKey]);

  useEffect(() => {
    const pending: LibraryAsset[] = [];
    for (const asset of assets) {
      const source = thumbSourcePath(asset);
      if (!source) continue;
      const changed = seenRef.current.get(asset.id) !== source;
      seenRef.current.set(asset.id, source);
      if (!changed || !primedRef.current || asset.thumbPath) continue;
      if (doneRef.current.has(thumbnailJobKey(asset))) continue;
      pending.push(asset);
    }
    // 资产被删除后要把登记一并清掉：否则删掉 chair 再重新导入一个同名 chair
    // （slug 复用、产物索引照样从 0 起）会被认成"没变过"，永远排不上队
    const alive = new Set(assets.map((a) => a.id));
    aliveIdsRef.current = alive;
    for (const id of seenRef.current.keys()) {
      if (!alive.has(id)) seenRef.current.delete(id);
    }
    for (const stamp of doneRef.current) {
      if (!alive.has(stamp.slice(0, stamp.lastIndexOf("::")))) doneRef.current.delete(stamp);
    }
    if (pending.length === 0) return;
    setQueue((items) => {
      const existing = new Set(items.map(thumbnailJobKey));
      const additions = pending.filter((asset) => !existing.has(thumbnailJobKey(asset)));
      return additions.length === 0 ? items : [...items, ...additions];
    });
  }, [assets]);

  const onCaptured = useCallback(
    async (asset: LibraryAsset, pngBase64: string | null) => {
      if (!activeRef.current) return;
      // 资产在渲染/上传期间被删除：丢弃这次在途结算，别把 stale stamp 写回 doneRef，
      // 否则同名重导入资产（slug 复用、id 与源路径完全一致）会命中旧登记而永远排不上队。
      if (!aliveIdsRef.current.has(asset.id)) return;
      const source = thumbSourcePath(asset);
      const stamp = thumbnailJobKey(asset);
      doneRef.current.add(stamp);
      if (pngBase64 && source) {
        const sourceFile = source.split("/").pop() ?? "";
        try {
          const path = await uploadThumbnail(projectSlug, asset.assetSlug, sourceFile, pngBase64);
          if (!activeRef.current) return;
          setGenerated((prev) => {
            const entries = new Map(prev);
            entries.set(stamp, path);
            return entries;
          });
          onGenerated?.(asset, source, path);
        } catch {
          // 缩略图是锦上添花：落盘失败就静默退回占位图，不打断用户手头的事
        }
      }
      setQueue((items) =>
        // 只结算这一个“资产 + 源版本”；同资产的新版本可能已经排在后面。
        items.filter((queued) => thumbnailJobKey(queued) !== stamp),
      );
    },
    [projectSlug, onGenerated],
  );

  return {
    current: queue[0] ?? null,
    pendingIds: new Set(queue.map((a) => a.id)),
    generated,
    onCaptured,
  };
}

/**
 * 缩略图的 HTTP 地址：优先本次会话刚渲好的，其次磁盘上已有的。
 * 会话内缓存按 `assetId::源产物路径` 取——换代后旧图不会顶掉新图。
 */
export function thumbnailSrc(
  asset: LibraryAsset,
  generated: Map<string, string>,
): string | null {
  const path = generated.get(`${asset.id}::${thumbSourcePath(asset)}`) ?? asset.thumbPath;
  return path ? libraryUrl(path) : null;
}

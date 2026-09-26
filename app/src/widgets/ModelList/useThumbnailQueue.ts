import { useCallback, useEffect, useRef, useState } from "react";
import { libraryUrl, uploadThumbnail, type LibraryAsset } from "../../shared/lib/libraryApi";

/**
 * 列表缩略图的生成队列。
 *
 * 缩略图是资产的派生缓存，不是一次性事件：只要当前模型（或天空盒环境图）存在、
 * 与它同代的缩略图不存在，队列就负责把它补齐。这样生成后立即刷新、关闭页面，或
 * 旧项目从未生成过缩略图，都只会推迟工作，不会永久留下占位图。
 *
 * 队列严格串行（一次只喂一个给 ThumbnailRenderer）：并发渲染会同时拉起 N 个 glb，
 * 内存和网络都扛不住。资产换代时会立即淘汰旧版本任务，只渲最新产物。
 */

/**
 * 这个资产拿什么渲缩略图：模型资产渲主产物模型，天空盒没有模型产物、渲的是
 * 贴了环境贴图的球。返回 null 即“这类资产不出缩略图”，走 kind 图标占位。
 */
export function thumbSourcePath(asset: LibraryAsset): string | null {
  return asset.modelPath ?? (asset.kind === "skybox" ? asset.hdrPath : null);
}

/** 任务身份必须包含源产物版本；同一资产换代时 id 不变。 */
function thumbnailJobKey(asset: LibraryAsset): string {
  return `${asset.id}::${thumbSourcePath(asset)}`;
}

/** 永久损坏的模型不能无限占住后台队列；重新打开项目后会获得一轮新的尝试。 */
export const MAX_THUMBNAIL_ATTEMPTS = 3;
/** 第一次失败很可能只是模型文件刚落盘或本机服务短暂繁忙，稍等后再试。 */
export const THUMBNAIL_RETRY_BASE_MS = 250;

interface Options {
  projectSlug: string;
  assets: LibraryAsset[];
  /** 缩略图已经落盘；用于把它回填到对应的异步任务消息。 */
  onGenerated?: (asset: LibraryAsset, sourcePath: string, thumbnailPath: string) => void;
}

export interface ThumbnailQueue {
  /** 当前该渲的资产，null 表示队列空闲（此时不该挂载离屏画布） */
  current: LibraryAsset | null;
  /** 队列里待处理（含正在渲）的资产 id，列表据此显示占位骨架 */
  pendingIds: Set<string>;
  /** 本次会话刚渲好的缩略图：`assetId::源产物路径` → 带缓存戳的逻辑路径 */
  generated: Map<string, string>;
  /** 已加载失败、应暂时显示占位图并等待重建的任务 stamp。 */
  invalidImages: Set<string>;
  /** 已声明存在的图片读不到/解码失败时，废弃它并重新生成。 */
  onImageError: (asset: LibraryAsset) => void;
  onCaptured: (asset: LibraryAsset, pngBase64: string | null) => void;
}

function retryDelay(attempt: number): number {
  return THUMBNAIL_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
}

export function useThumbnailQueue({
  projectSlug,
  assets,
  onGenerated,
}: Options): ThumbnailQueue {
  const activeRef = useRef(true);
  const [queue, setQueue] = useState<LibraryAsset[]>([]);
  const [generated, setGenerated] = useState<Map<string, string>>(() => new Map());
  const [invalidImages, setInvalidImages] = useState<Set<string>>(() => new Set());
  const generatedRef = useRef(generated);
  const invalidImagesRef = useRef(invalidImages);
  /** 当前项目快照里仍然有效的任务；同资产换代后旧 stamp 会立刻消失。 */
  const currentJobsRef = useRef(new Map<string, LibraryAsset>());
  /** 当前页面生命周期内每个源版本已经失败多少次。 */
  const attemptsRef = useRef(new Map<string, number>());
  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const replaceGenerated = useCallback((next: Map<string, string>) => {
    generatedRef.current = next;
    setGenerated(next);
  }, []);

  const replaceInvalidImages = useCallback((next: Set<string>) => {
    invalidImagesRef.current = next;
    setInvalidImages(next);
  }, []);

  const needsThumbnail = useCallback((asset: LibraryAsset): boolean => {
    const source = thumbSourcePath(asset);
    if (!source) return false;
    const stamp = thumbnailJobKey(asset);
    if (generatedRef.current.has(stamp)) return false;
    return !asset.thumbPath || invalidImagesRef.current.has(stamp);
  }, []);

  const enqueue = useCallback((asset: LibraryAsset) => {
    const stamp = thumbnailJobKey(asset);
    if (!currentJobsRef.current.has(stamp) || !needsThumbnail(asset)) return;
    if ((attemptsRef.current.get(stamp) ?? 0) >= MAX_THUMBNAIL_ATTEMPTS) return;
    setQueue((items) =>
      items.some((queued) => thumbnailJobKey(queued) === stamp) ? items : [...items, asset],
    );
  }, [needsThumbnail]);

  const scheduleRetry = useCallback((asset: LibraryAsset) => {
    const stamp = thumbnailJobKey(asset);
    const attempt = (attemptsRef.current.get(stamp) ?? 0) + 1;
    attemptsRef.current.set(stamp, attempt);
    setQueue((items) => items.filter((queued) => thumbnailJobKey(queued) !== stamp));
    if (attempt >= MAX_THUMBNAIL_ATTEMPTS || retryTimersRef.current.has(stamp)) return;

    const timer = setTimeout(() => {
      retryTimersRef.current.delete(stamp);
      if (!activeRef.current) return;
      const current = currentJobsRef.current.get(stamp);
      if (current) enqueue(current);
    }, retryDelay(attempt));
    retryTimersRef.current.set(stamp, timer);
  }, [enqueue]);

  useEffect(() => {
    activeRef.current = true;
    const timers = retryTimersRef.current;
    return () => {
      activeRef.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const currentJobs = new Map<string, LibraryAsset>();
    for (const asset of assets) {
      if (thumbSourcePath(asset)) currentJobs.set(thumbnailJobKey(asset), asset);
    }
    currentJobsRef.current = currentJobs;

    // 换代/删除/切项目后，旧任务与旧重试都没有继续工作的价值。
    for (const [stamp, timer] of retryTimersRef.current) {
      if (currentJobs.has(stamp)) continue;
      clearTimeout(timer);
      retryTimersRef.current.delete(stamp);
    }
    for (const stamp of attemptsRef.current.keys()) {
      if (!currentJobs.has(stamp)) attemptsRef.current.delete(stamp);
    }

    setQueue((items) => {
      const next = items.filter((asset) => {
        const stamp = thumbnailJobKey(asset);
        return currentJobs.has(stamp) && needsThumbnail(asset);
      });
      const queued = new Set(next.map(thumbnailJobKey));
      for (const asset of assets) {
        const stamp = thumbnailJobKey(asset);
        if (
          currentJobs.has(stamp) &&
          needsThumbnail(asset) &&
          (attemptsRef.current.get(stamp) ?? 0) < MAX_THUMBNAIL_ATTEMPTS &&
          !retryTimersRef.current.has(stamp) &&
          !queued.has(stamp)
        ) {
          next.push(asset);
          queued.add(stamp);
        }
      }
      return next;
    });
  }, [assets, needsThumbnail]);

  const onCaptured = useCallback(
    async (asset: LibraryAsset, pngBase64: string | null) => {
      if (!activeRef.current) return;
      const source = thumbSourcePath(asset);
      const stamp = thumbnailJobKey(asset);
      // 渲染期间资产已删除或换代：只清掉旧任务，不能为过期版本重试或回填消息。
      if (!source || !currentJobsRef.current.has(stamp)) {
        setQueue((items) => items.filter((queued) => thumbnailJobKey(queued) !== stamp));
        return;
      }
      if (!pngBase64) {
        scheduleRetry(asset);
        return;
      }

      const sourceFile = source.split("/").pop() ?? "";
      try {
        const path = await uploadThumbnail(projectSlug, asset.assetSlug, sourceFile, pngBase64);
        if (!activeRef.current || !currentJobsRef.current.has(stamp)) {
          setQueue((items) => items.filter((queued) => thumbnailJobKey(queued) !== stamp));
          return;
        }
        // 覆盖损坏的同名 PNG 时绕开浏览器的旧失败/图片缓存。
        const nextGenerated = new Map(generatedRef.current);
        nextGenerated.set(stamp, `${path}?thumbnail=${Date.now()}`);
        replaceGenerated(nextGenerated);
        if (invalidImagesRef.current.has(stamp)) {
          const nextInvalid = new Set(invalidImagesRef.current);
          nextInvalid.delete(stamp);
          replaceInvalidImages(nextInvalid);
        }
        setQueue((items) => items.filter((queued) => thumbnailJobKey(queued) !== stamp));
        onGenerated?.(asset, source, path);
      } catch {
        // 上传失败通常是本机服务刚重启或短暂不可用，按同一套有限退避策略重试。
        scheduleRetry(asset);
      }
    },
    [projectSlug, onGenerated, replaceGenerated, replaceInvalidImages, scheduleRetry],
  );

  const onImageError = useCallback((asset: LibraryAsset) => {
    const stamp = thumbnailJobKey(asset);
    if (!currentJobsRef.current.has(stamp)) return;
    const nextGenerated = new Map(generatedRef.current);
    nextGenerated.delete(stamp);
    replaceGenerated(nextGenerated);
    const nextInvalid = new Set(invalidImagesRef.current);
    nextInvalid.add(stamp);
    replaceInvalidImages(nextInvalid);
    scheduleRetry(asset);
  }, [replaceGenerated, replaceInvalidImages, scheduleRetry]);

  return {
    current: queue[0] ?? null,
    pendingIds: new Set(queue.map((a) => a.id)),
    generated,
    invalidImages,
    onImageError,
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
  invalidImages: Set<string> = new Set(),
): string | null {
  const stamp = `${asset.id}::${thumbSourcePath(asset)}`;
  if (invalidImages.has(stamp) && !generated.has(stamp)) return null;
  const path = generated.get(stamp) ?? asset.thumbPath;
  return path ? libraryUrl(path) : null;
}

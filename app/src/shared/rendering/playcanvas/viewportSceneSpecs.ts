import type { SceneAssetSpec, SceneAssetKind } from "./assetScene";
import type { Placement } from "./selectionTransform";

/**
 * `ViewportProps` → 场景规格的**纯解析**：视口每次渲染都要调它，所以它必须没有副作用、
 * 只做"哪些资产要渲染、用什么 URL、摆在哪儿"。
 *
 * ### 三条来自既有记录的规则
 * ① **修订号按资产发号，不能用工作台的 `refreshKey`**（见 `shared/lib/resourceRevisions.ts`
 *    文件头）：`refreshKey` 在每个后台任务落盘时都 +1，绑上去就变成"生成一件家具，场景里
 *    已有模型全部重新下载 + 重新解析 + 重新挂载"。
 * ② **摆放按稳定 id 索引**（`computeSceneLayout` 的输出），不是 slug——删除同名资产重建后
 *    不该继承旧摆放。
 * ③ 第一切片**不渲染 world 背景**（它是场景背景，走另一条渲染路径），但要在 `skipped` 里
 *    显式列出来，免得"模型没出现"时无从判断。
 */

/** 只取本模块真正读的字段（`LibraryAsset` 结构上满足）。 */
export interface ViewportAssetLike {
  id: string;
  assetSlug: string;
  kind: string;
  modelPath: string | null;
  spzPath: string | null;
}

export type SkipReason = "other-world" | "no-product" | "no-placement";

export interface SkippedAsset {
  id: string;
  reason: SkipReason;
}

export interface SceneSpecsResult {
  specs: SceneAssetSpec[];
  skipped: SkippedAsset[];
}

export interface SceneSpecsOptions {
  assets: readonly ViewportAssetLike[];
  /** 摆放，按**稳定 id** 索引（`computeSceneLayout(assets, transforms)` 的输出） */
  layout: ReadonlyMap<string, Placement>;
  /** 资源修订号；不传就不带 `?revision=`（探针/测试用） */
  revisionFor?(asset: ViewportAssetLike): number | null;
  /** 当前生效的 World 资产 slug（`ViewportProps.currentWorld`）：它是**场景背景**，单独成一条规格 */
  currentWorld?: string;
  /** gizmo 调过的摆放（按稳定 id）；世界不参与网格布局，所以它的摆放只可能来自这里 */
  transforms?: Record<string, Placement | undefined>;
  /**
   * 把资产的逻辑路径变成**可 fetch 的 URL**。**必须由调用方给**：应用侧是
   * `libraryUrl(path)`（`${CHAT_BASE_URL}/api/library/…`），而 `LibraryAsset.modelPath`
   * 只是逻辑路径——直接拿来 fetch 会命中 SPA 回退拿到 `index.html`，
   * 症状是引擎报 `Invalid magic number … found 0x6f64213c`（那四个字节是 `<!do`）。
   * 不传就按原样用（探针/测试里传的是 `/@fs/...` 这种已经可 fetch 的 URL）。
   */
  urlFor?(logicalPath: string): string;
}

const IDENTITY: Placement = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/**
 * 给 URL 加上 `?revision=N`。**已经带 query 的 URL 要用 `&`**——本仓库的资产 URL 平时不带
 * query，但贴图/环境贴图那条路会带，拼接写死会得到一个坏 URL（而且静默 404）。
 */
export function withRevision(url: string, revision: number | null | undefined): string {
  if (revision === null || revision === undefined || !Number.isFinite(revision)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}revision=${revision}`;
}

/** 一件资产该渲染成哪种实体：有 `.spz` 就是点云，有模型产物就是模型，两者都没有就不渲染。 */
export function specKindFor(asset: ViewportAssetLike): SceneAssetKind | null {
  if (asset.spzPath) return "splat";
  if (asset.modelPath) return "model";
  return null;
}

export function viewportSceneSpecs(options: SceneSpecsOptions): SceneSpecsResult {
  const specs: SceneAssetSpec[] = [];
  const skipped: SkippedAsset[] = [];
  for (const asset of options.assets) {
    /*
      世界是**场景背景**：它不参与网格布局（`computeSceneLayout` 就把它排除了），摆放只可能来自
      `transforms`，没有就用单位阵——它在世界坐标里本来就是摆好的。
      **只渲染 `currentWorld` 指的那一个**：项目里可能有多份世界资产，其余显式列进 `skipped`。
    */
    if (asset.kind === "world") {
      if (!options.currentWorld || asset.assetSlug !== options.currentWorld) {
        skipped.push({ id: asset.id, reason: "other-world" });
        continue;
      }
      const kind = specKindFor(asset);
      if (!kind) { skipped.push({ id: asset.id, reason: "no-product" }); continue; }
      const rawUrl = (kind === "splat" ? asset.spzPath : asset.modelPath)!;
      specs.push({
        id: asset.id,
        kind,
        url: withRevision(options.urlFor?.(rawUrl) ?? rawUrl, options.revisionFor?.(asset) ?? null),
        placement: options.transforms?.[asset.id] ?? IDENTITY,
      });
      continue;
    }
    const kind = specKindFor(asset);
    if (!kind) {
      skipped.push({ id: asset.id, reason: "no-product" });
      continue;
    }
    const placement = options.layout.get(asset.id);
    if (!placement) {
      // 能渲染但没有摆放（例如被 gizmo 表排除在外）：宁可显式跳过，也不要猜一个摆位
      skipped.push({ id: asset.id, reason: "no-placement" });
      continue;
    }
    const rawUrl = (kind === "splat" ? asset.spzPath : asset.modelPath)!;
    specs.push({
      id: asset.id,
      kind,
      url: withRevision(options.urlFor?.(rawUrl) ?? rawUrl, options.revisionFor?.(asset) ?? null),
      placement,
    });
  }
  return { specs, skipped };
}

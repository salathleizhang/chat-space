import { ChatServiceError } from "../../common/errors";
import { parseRequestSidecarName } from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { readJson, type AssetStorage } from "../../services/assetStorage";
import { latestAssetModel } from "./projectTools";

/** 将资产的最新模型解析为下游可访问的供应商 URL。 */
export interface PublicModelRef {
  url: string;
  /** 大写扩展名（GLB/FBX…），混元 File.Type 直用 */
  type: string;
}

/** 供应商链接按混元最短的 24h 时效判定，留 4h 余量给下游任务消费 */
const PROVIDER_URL_FRESH_MS = 20 * 60 * 60 * 1000;

const MODEL_FILE_RE = /\.(glb|gltf|obj|fbx|stl)$/i;

function extOf(path: string): string {
  return path.split(".").pop()!.toLowerCase();
}

/** 侧写里的模型 providerUrl：优先匹配指定文件，无本地文件时退回最高索引的模型产物 */
async function findSidecarModelUrl(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  modelPath: string | null,
): Promise<{ url: string; type: string; fresh: boolean } | null> {
  const dir = assetDir(projectSlug, assetSlug);
  let best: { index: number; url: string; type: string; updatedAt: string } | null = null;
  for (const name of await storage.list(dir)) {
    if (!parseRequestSidecarName(name)) continue;
    try {
      const sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
      if (sidecar.status !== "succeeded") continue;
      for (const output of sidecar.outputs) {
        if (!output.providerUrl) continue;
        if (modelPath ? output.path !== modelPath : !MODEL_FILE_RE.test(output.path)) continue;
        if (!best || sidecar.index > best.index) {
          best = {
            index: sidecar.index,
            url: output.providerUrl,
            type: extOf(output.path).toUpperCase(),
            updatedAt: sidecar.updatedAt,
          };
        }
      }
    } catch {
      // 坏侧写不阻塞扫描
    }
  }
  if (!best) return null;
  const age = Date.now() - Date.parse(best.updatedAt);
  return { url: best.url, type: best.type, fresh: Number.isFinite(age) && age < PROVIDER_URL_FRESH_MS };
}

/** 资产最新模型的公网 URL。 */
export async function resolveModelPublicUrl(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<PublicModelRef> {
  let modelPath: string | null = null;
  try {
    modelPath = await latestAssetModel(storage, projectSlug, assetSlug);
  } catch {
    // 本地文件缺失但侧写可能仍有 URL（修复场景），继续走策略链
  }

  const sidecarRef = await findSidecarModelUrl(storage, projectSlug, assetSlug, modelPath);
  if (sidecarRef?.fresh) {
    return { url: sidecarRef.url, type: sidecarRef.type };
  }

  // 过期链接兜底：混元 24h 之外的供应商可能仍有效，好过直接失败
  if (sidecarRef) {
    return { url: sidecarRef.url, type: sidecarRef.type };
  }

  throw new ChatServiceError(
    modelPath
      ? `The model for asset "${assetSlug}" has no accessible public URL (local import or provider link missing): use a model with an accessible link first`
      : `Asset "${assetSlug}" has no model file in its directory; generate a 3D model first`,
    409,
    "public_model_url_unavailable",
  );
}

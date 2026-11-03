import { ChatServiceError } from "../../common/errors";
import type { GenerationTask } from "../../dto/tasks";
import type { ThreeDModelEntry } from "../../models/threeD";
import { threeDProviderKeyEnv, threeDProviderKeyName } from "../../models/threeD";
import type { Seed3dSubdivisionLevel } from "../../models/seed3d";
import type { GenerationObject } from "../../services/modelPublishing";
import { startArk3dBatch } from "./ark3dOps";
import { startSeed3d3dBatch } from "./seed3dOps";
import { startTripo3dBatch } from "./tripoOps";

/**
 * 3D 生成的**唯一入口**：按选中的模型把一批对象分派给对应渠道。
 *
 * 以前每个调用点（Agent 工具、HTTP、失败重试、浏览器本地版）都直接调
 * `startTripo3dBatch`，于是"换成火山"就得在四处各改一遍、且很容易漏掉一处
 * （漏了的那处就还在偷偷用 Tripo）。现在只有这里知道渠道差异。
 *
 * 三家渠道的差异：
 * - **Seed3D**：图片收公网 URL 或 data URI，细分档 `high|medium|low`，模型 ID 不可覆盖；
 * - **Hyper3D / Hi3D**：共用方舟任务协议，参数走命令行式 text（`--face` 等）；
 *   其中 **Hi3D 只收公网图片 URL**（由 ark3dOps 里的 `findVolcImageUrl` 处理）；
 * - **Tripo**：目前不开放（积分用尽），保留分支只为把历史调用路径收口。
 */
export interface Start3dBatchKeys {
  seed3dApiKey?: string;
  tripo3dApiKey?: string;
}

export interface Start3dBatchOptions {
  /** 界面选中的模型（决定渠道与模型 ID） */
  entry: ThreeDModelEntry;
  keys: Start3dBatchKeys;
  /** 当前会话开始时刻；兜底取图时的归属判据 */
  sessionStartedAt?: number;
  /** Tripo 专用：单图 / 多视角 */
  generationMode?: "auto" | "single" | "multiview";
  /** Seed3D 专用：细分档 */
  subdivisionLevel?: Seed3dSubdivisionLevel;
  /** Hyper3D / Hi3D 专用：目标面数 */
  faceCount?: number;
}

function requireKey(options: Start3dBatchOptions): string {
  const name = threeDProviderKeyName(options.entry.provider);
  const key = options.keys[name];
  if (!key) {
    throw new ChatServiceError(
      `${threeDProviderKeyEnv(options.entry.provider)} is not configured in the local chat/.env`,
      401,
      options.entry.provider === "tripo-direct" ? "missing_tripo_key" : "missing_seed3d_key",
    );
  }
  return key;
}

export function start3dBatch(
  projectSlug: string,
  objects: GenerationObject[],
  options: Start3dBatchOptions,
): GenerationTask[] {
  const apiKey = requireKey(options);
  switch (options.entry.provider) {
    case "seed3d-direct":
      return startSeed3d3dBatch(projectSlug, objects, {
        seed3dApiKey: apiKey,
        subdivisionLevel: options.subdivisionLevel ?? options.entry.subdivision ?? "medium",
        model: options.entry.model,
        ...(options.sessionStartedAt !== undefined
          ? { sessionStartedAt: options.sessionStartedAt }
          : {}),
      });
    case "hyper3d-volc":
    case "hi3d-volc":
      return startArk3dBatch(options.entry.provider, projectSlug, objects, {
        apiKey,
        model: options.entry.model,
        ...(options.faceCount !== undefined ? { faceCount: options.faceCount } : {}),
        ...(options.sessionStartedAt !== undefined
          ? { sessionStartedAt: options.sessionStartedAt }
          : {}),
      });
    case "tripo-direct":
      return startTripo3dBatch(projectSlug, objects, {
        tripo3dApiKey: apiKey,
        imageModel: options.entry.model,
        generationMode: options.generationMode ?? "auto",
        ...(options.sessionStartedAt !== undefined
          ? { sessionStartedAt: options.sessionStartedAt }
          : {}),
      });
    default: {
      const provider = options.entry.provider as string;
      throw new ChatServiceError(
        `Unknown 3D provider "${provider}"`,
        400,
        "model_provider_unknown",
      );
    }
  }
}

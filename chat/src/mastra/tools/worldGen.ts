import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  pickLatestSourceImage,
} from "../../common/indexedFiles";
import {
  assetDir,
  assetIdentityFile,
  projectAnalysisFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
  SlugSchema,
  type RequestSidecar,
  type SceneAnalysis,
} from "../../dto/library";
import {
  extractWorldAssetUrls,
  MARBLE_MODEL,
  pollMarbleOperation,
  submitMarbleWorld,
  type WorldLabsOptions,
} from "../../models/worldlabs";
import {
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { downloadToLibrary } from "./assetRepair";
import {
  requireProject,
  setCurrentWorld,
  uniqueAssetSlug,
} from "./projectTools";

export const WorldGenParamsSchema = z.object({
  projectSlug: SlugSchema,
  /** 省略时创建新的 world / world-2 / world-3…；显式传入则向指定资产追加一代 */
  worldSlug: SlugSchema.optional(),
  /** 源图（通常是最新 plate）；与 prompt 至少给一个 */
  image: LogicalPathSchema.optional(),
  prompt: z.string().optional(),
});
export type WorldGenParams = z.infer<typeof WorldGenParamsSchema>;

export interface WorldGenResult {
  worldJson: string;
  files: string[];
  sidecar: string;
  operationId: string;
}

/**
 * 世界生成（上游 generate-world.mjs 的迁移）："世界"是资产类型之一（决策 4），
 * 落盘到 assets/<worldSlug>/：N-world.json + glb/pano/thumbnail/spz 共享同一索引。
 * 磁盘优先：全部引用资产下载完成才算成功。
 */
export async function runWorldGeneration(
  storage: AssetStorage,
  rawParams: WorldGenParams,
  callOptions: WorldLabsOptions,
  /** 身份提交后回调（供任务化在「已发布但状态未落盘」的崩溃窗口前回写 assetSlug） */
  onPublished?: (assetSlug: string) => void | Promise<void>,
): Promise<WorldGenResult> {
  const parsed = WorldGenParamsSchema.parse(rawParams);
  await requireProject(storage, parsed.projectSlug);
  const params = {
    ...parsed,
    worldSlug:
      parsed.worldSlug ??
      (await uniqueAssetSlug(storage, parsed.projectSlug, "world")),
  };

  const dir = assetDir(params.projectSlug, params.worldSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.worldSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.worldSlug,
    provider: "world-labs",
    model: MARBLE_MODEL,
    params: {
      ...(params.prompt ? { prompt: params.prompt } : {}),
      ...(params.image ? { image: params.image } : {}),
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      updatedAt: now(),
    });
  await saveSidecar();

  try {
    let imagePrompt;
    if (params.image) {
      const dataUri = await readAsDataUri(storage, params.image);
      const [, mimeType, dataBase64] = /^data:([^;]+);base64,(.*)$/.exec(dataUri)!;
      imagePrompt = {
        dataBase64: dataBase64!,
        extension: params.image.split(".").pop()!.toLowerCase(),
        mimeType: mimeType!,
      };
    }

    // 提交后立即落盘 operationId，轮询/下载中途崩溃也能凭侧写续跑。
    const { operationId, done, response: submittedResponse } = await submitMarbleWorld(
      {
        displayName: `${params.projectSlug}/${params.worldSlug}`,
        imagePrompt,
        textPrompt: params.prompt,
      },
      callOptions,
    );
    sidecar.status = "running";
    sidecar.providerTaskId = operationId;
    await saveSidecar();
    const response = done
      ? (submittedResponse ??
        (() => {
          throw new ChatServiceError(
            "World Labs operation 完成但没有 response",
            502,
            "worldlabs_bad_response",
          );
        })())
      : await pollMarbleOperation(operationId, callOptions);

    // world 响应 JSON 本身是可见产物
    const worldJsonPath = `${dir}/${formatIndexedName(index, params.worldSlug, "json")}`;
    await storage.writeText(worldJsonPath, JSON.stringify(response, null, 2));
    sidecar.outputs = [{ path: worldJsonPath }];

    const urls = extractWorldAssetUrls(response);
    const files: string[] = [];
    const download = async (url: string, fileName: string) => {
      const path = `${dir}/${fileName}`;
      await downloadToLibrary(storage, url, path, { fetchFn: callOptions.fetchFn });
      files.push(path);
      sidecar.outputs.push({ path, providerUrl: url });
    };

    if (urls.glb) await download(urls.glb, formatIndexedName(index, params.worldSlug, "glb"));
    if (urls.pano)
      await download(
        urls.pano,
        formatIndexedName(index, `${params.worldSlug}-pano`, extOf(urls.pano, "png")),
      );
    if (urls.thumbnail)
      await download(
        urls.thumbnail,
        formatIndexedName(
          index,
          `${params.worldSlug}-thumbnail`,
          extOf(urls.thumbnail, "webp"),
        ),
      );
    for (const [key, url] of Object.entries(urls.spz)) {
      await download(
        url,
        formatIndexedName(
          index,
          `${params.worldSlug}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          "spz",
        ),
      );
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    const identityPath = assetIdentityFile(params.projectSlug, params.worldSlug);
    if (!(await storage.exists(identityPath))) {
      await writeJson(storage, identityPath, AssetIdentitySchema, {
        schemaVersion: 1,
        slug: params.worldSlug,
        kind: "world",
        name: params.worldSlug,
        intent: params.prompt ?? "Explorable 3D environment generated from source image",
        sourceImages: params.image ? [params.image] : [],
        createdAt: new Date().toISOString(),
      });
    }
    await setCurrentWorld(storage, params.projectSlug, params.worldSlug);
    await onPublished?.(params.worldSlug);
    return { worldJson: worldJsonPath, files, sidecar: sidecarPath, operationId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

function extOf(url: string, fallback: string): string {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  return match ? match[1]!.toLowerCase() : fallback;
}

// ---------- 项目级入口：从场景分析合成空环境世界 ----------

export const ProjectWorldInputSchema = z.object({
  projectSlug: SlugSchema,
  sourceImage: LogicalPathSchema.optional(),
  extraPrompt: z.string().optional(),
});
export type ProjectWorldInput = z.infer<typeof ProjectWorldInputSchema>;

/**
 * "文字底板" prompt（§4.4）：原场景描述减去全部已确认对象，
 * 保留材质、光照、氛围、空间布局，描述为空环境。
 */
export function composeEmptyWorldPrompt(
  analysis: SceneAnalysis,
  extraPrompt?: string,
): string {
  const environment = [
    analysis.environment.lighting && `lighting: ${analysis.environment.lighting}`,
    analysis.environment.mood && `mood: ${analysis.environment.mood}`,
    analysis.environment.spatialLayout &&
      `spatial layout: ${analysis.environment.spatialLayout}`,
  ]
    .filter(Boolean)
    .join("; ");
  const removed =
    analysis.objects.length > 0
      ? ` The scene is empty: the following objects have been removed and must not appear: ${analysis.objects
          .map((o) => o.name)
          .join(", ")}.`
      : " The scene contains no loose movable objects.";
  return (
    `${analysis.sceneDescription}${environment ? ` (${environment})` : ""}.` +
    ` Keep the original materials, lighting, atmosphere, and spatial layout.${removed}` +
    (extraPrompt ? ` ${extraPrompt}` : "")
  );
}

/** 世界生成的项目级入口（§4.4）：读分析 → 空环境 prompt → 默认最新源图 → 生成 */
export async function runProjectWorldGeneration(
  storage: AssetStorage,
  rawInput: ProjectWorldInput,
  callOptions: WorldLabsOptions,
  onPublished?: (assetSlug: string) => void | Promise<void>,
): Promise<WorldGenResult> {
  const input = ProjectWorldInputSchema.parse(rawInput);
  await requireProject(storage, input.projectSlug);

  const analysisPath = projectAnalysisFile(input.projectSlug);
  if (!(await storage.exists(analysisPath))) {
    throw new ChatServiceError(
      `项目「${input.projectSlug}」还没有场景分析，请先运行图片分析（uncover）`,
      409,
      "analysis_missing",
    );
  }
  const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);

  let image = input.sourceImage;
  if (!image) {
    const sourceDir = projectSourceDir(input.projectSlug);
    const latest = pickLatestSourceImage(await storage.list(sourceDir));
    if (latest) image = `${sourceDir}/${latest}`;
  }

  return runWorldGeneration(
    storage,
    WorldGenParamsSchema.parse({
      projectSlug: input.projectSlug,
      image,
      prompt: composeEmptyWorldPrompt(analysis, input.extraPrompt),
    }),
    callOptions,
    onPublished,
  );
}

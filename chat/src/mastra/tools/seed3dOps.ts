import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { formatRequestSidecarName, nextIndex } from "../../common/indexedFiles";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  extractSeed3dFileUrls,
  SEED3D_MODEL,
  submitSeed3dTask,
  waitForSeed3dTask,
  type Seed3dCallOptions,
} from "../../models/seed3d";
import {
  getAssetStorage,
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { runAndPublishGeneratedModel, type GenerationObject } from "../../services/modelPublishing";
import { startCustomTask } from "../../services/tasks";
import { requireProject } from "./projectTools";
import { resolveSessionReferenceImage } from "./referenceResolution";
import { downloadAndLandSeed3dOutput } from "./seed3dOutput";
import { runWithGeneratedModelInfo } from "./modelInfo";

/**
 * 火山方舟 Seed3D 直连能力（seed3d-direct 渠道）——图生 3D，一张参考图 + 可选
 * 输出规格，产出带纹理与 PBR 材质的模型。图片走 data URI（本地优先，免上传
 * 基础设施），输出规格经 `models/seed3d.ts` 拼成该家独有的
 * `--subdivisionlevel/--fileformat` 文本命令。
 *
 * 无后处理能力（贴图/绑骨/分割等方舟这边没有对应端点），所以本文件只有生成一件事，
 * 比 tripoOps 薄很多。
 */

/** doubao-seed3d-2-0-260328 的档位实际面数（官方文档 2026-07），仅用于提示与侧写 */
export const SEED3D_FACE_COUNTS = { high: 1_000_000, medium: 500_000, low: 100_000 } as const;

export const Seed3dGenParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  /** 参考图（库内逻辑路径）；省略 = 身份绑定的 sourceImages > 最新源图 */
  image: LogicalPathSchema.optional(),
  /** 面数档位：high=100 万 / medium=50 万 / low=10 万，缺省用供应商默认（medium） */
  subdivisionLevel: z.enum(["high", "medium", "low"]).optional(),
  /** 产物格式，缺省用供应商默认（glb）；usd/usdz 是 Seed3D 独有档 */
  fileFormat: z.enum(["glb", "obj", "usd", "usdz"]).optional(),
  /** 供应商模型 ID；缺省用 SEED3D_MODEL（用户在界面选定具体模型时由服务端钉住） */
  model: z.string().min(1).optional(),
});
export type Seed3dGenParams = z.input<typeof Seed3dGenParamsSchema>;

export interface Seed3dOpResult {
  files: string[];
  sidecar: string;
  taskId: string;
}

/**
 * 参考图优先级：显式 > 身份绑定 > 最新源图。
 *
 * 后两档会过**会话归属闸门**（见 referenceResolution.ts）：上一轮会话生成的图不许
 * 静默复用，要复用得先问用户。`sessionStartedAt` 来自请求上下文（客户端带来的会话
 * 开始时刻）；省略时不做本轮判断，保持原行为。
 */
export async function resolveSingleImage(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  explicit?: string,
  sessionStartedAt?: number,
): Promise<string> {
  const identityPath = assetIdentityFile(projectSlug, assetSlug);
  const boundCandidates =
    !explicit && (await storage.exists(identityPath))
      ? (await readJson(storage, identityPath, AssetIdentitySchema)).sourceImages
      : [];
  return resolveSessionReferenceImage(storage, projectSlug, {
    explicit,
    boundCandidates,
    ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
    operation: "3D 生成",
  });
}
export async function runSeed3dImageTo3d(
  storage: AssetStorage,
  rawParams: Seed3dGenParams,
  callOptions: Seed3dCallOptions,
  /** 当前会话开始时刻；判断兜底取到的那张图能不能自动用（见 referenceResolution） */
  sessionStartedAt?: number,
): Promise<Seed3dOpResult> {
  const params = Seed3dGenParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  const image = await resolveSingleImage(
    storage,
    params.projectSlug,
    params.assetSlug,
    params.image,
    sessionStartedAt,
  );

  const dir = assetDir(params.projectSlug, params.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: "seed3d",
    model: params.model ?? SEED3D_MODEL,
    params: {
      image,
      ...(params.subdivisionLevel ? { subdivision_level: params.subdivisionLevel } : {}),
      ...(params.fileFormat ? { file_format: params.fileFormat } : {}),
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, { ...sidecar, updatedAt: now() });
  await saveSidecar();

  try {
    const taskId = await submitSeed3dTask(
      {
        image: await readAsDataUri(storage, image),
        model: params.model,
        subdivisionLevel: params.subdivisionLevel,
        fileFormat: params.fileFormat,
      },
      callOptions,
    );
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();

    const result = await waitForSeed3dTask(taskId, callOptions);
    const files = await downloadSeed3dOutputs(storage, result, {
      dir,
      index,
      assetSlug: params.assetSlug,
      sidecar,
      fetchFn: callOptions.fetchFn,
    });

    sidecar.status = "succeeded";
    await saveSidecar();
    return { files, sidecar: sidecarPath, taskId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

/** 查询响应 → 产物全部落盘（续跑复用，故与 runSeed3dImageTo3d 拆开） */
export async function downloadSeed3dOutputs(
  storage: AssetStorage,
  result: unknown,
  target: {
    dir: string;
    index: number;
    assetSlug: string;
    sidecar: RequestSidecar;
    fetchFn?: typeof fetch;
  },
): Promise<string[]> {
  const urls = extractSeed3dFileUrls(result);
  const files: string[] = [];
  for (const url of urls) {
    const fileSlug =
      files.length === 0 ? target.assetSlug : `${target.assetSlug}-f${files.length + 1}`;
    const path = await downloadAndLandSeed3dOutput(storage, url, {
      basePath: `${target.dir}/${target.index}-${fileSlug}`,
      fallbackExtension:
        typeof target.sidecar.params.file_format === "string"
          ? (target.sidecar.params.file_format as "glb" | "obj" | "usd" | "usdz")
          : "glb",
      fetchFn: target.fetchFn,
    });
    files.push(path);
    target.sidecar.outputs.push({ path, providerUrl: url });
  }
  if (files.length === 0) {
    throw new ChatServiceError("Seed3D 结果中没有可下载文件", 502, "seed3d_no_files");
  }
  return files;
}

/** seed3d-direct 的批量 3D 生成。 */
export function startSeed3d3dBatch(
  projectSlug: string,
  objects: GenerationObject[],
  options: {
    seed3dApiKey: string;
    subdivisionLevel?: "high" | "medium" | "low";
    fileFormat?: "glb" | "obj" | "usd" | "usdz";
    /** 供应商模型 ID；缺省用 SEED3D_MODEL */
    model?: string;
    /** 当前会话开始时刻；兜底取图时的归属判据（见 referenceResolution） */
    sessionStartedAt?: number;
  },
) {
  return objects.map((object) =>
    startCustomTask("3d", projectSlug, `3D 生成（Seed3D 直连）：${object.name}`, (task) =>
      runAndPublishGeneratedModel(
        getAssetStorage(), projectSlug, task.id, object, task.setPhase,
        // 结果带上真实面数与"是不是高模"：生成完那一轮 Agent 才有依据问用户要不要减面
        (target) => runWithGeneratedModelInfo(
          target,
          projectSlug,
          object.slug,
          () => runSeed3dImageTo3d(
            target,
            {
              projectSlug,
              assetSlug: object.slug,
              image: object.sourceImages[0],
              subdivisionLevel: options.subdivisionLevel,
              fileFormat: options.fileFormat,
              model: options.model,
            },
            {
              apiKey: options.seed3dApiKey,
              // 每次轮询都刷一次任务记录：看板进度可见，卡死看门狗也才分得清
              // 「在动」和「没动」（与 ark3dOps 同款，见那边的注释）。
              onStatus: () => task.setPhase("generating"),
            },
            options.sessionStartedAt,
          ),
        ),
      ), {
      assetSlug: object.slug,
      retry: {
        kind: "3d", assetSlug: object.slug, name: object.name, intent: object.intent,
        sourceImages: object.sourceImages, provider: "seed3d-direct",
        options: {
          subdivisionLevel: options.subdivisionLevel,
          fileFormat: options.fileFormat,
          model: options.model,
        },
      },
    }),
  );
}

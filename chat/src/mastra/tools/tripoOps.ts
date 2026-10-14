import { CloudTaskPending } from "../../cloud/context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { extractFileUrls } from "../../common/fileUrls";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  parseRequestSidecarName,
  pickLatestSourceImage,
} from "../../common/indexedFiles";
import {
  assetDir,
  assetIdentityFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  ReferenceImageViewsSchema,
  RequestSidecarSchema,
  SlugSchema,
  type ReferenceImageViews,
  type RequestSidecar,
} from "../../dto/library";
import type { GenerationPhase } from "../../dto/tasks";
import { convertModel } from "../../services/modelConvert";
import {
  DEFAULT_TRIPO_IMAGE_MODEL,
  DEFAULT_TRIPO_TEXTURE_MODEL,
  runTripoTask,
  TRIPO_DECIMATE_FACES,
  tripoImageToModelRequest,
  tripoImportModelRequest,
  tripoMultiviewToModelRequest,
  tripoSegmentRequest,
  tripoTextureVersionFor,
  uploadTripoFile,
  uploadTripoModelViaSts,
  waitForTripoTask,
  type TripoCallOptions,
} from "../../models/tripo";
import {
  getAssetStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import {
  publishGeneratedModel,
  runAndPublishGeneratedModel,
  type GenerationObject,
} from "../../services/modelPublishing";
import { startCustomTask } from "../../services/tasks";
import { downloadToLibrary } from "./assetRepair";
import { runWithGeneratedModelInfo } from "./modelInfo";
import { latestAssetModel, requireProject } from "./projectTools";
import {
  optionalContextString,
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import {
  assertSelectedReferenceUsable,
  type ReferenceResolutionOptions,
} from "./referenceResolution";

/**
 * Tripo 直连能力（链式设计）：后处理任务只收 original_model_task_id。
 * 链头两种来源：tripo-direct 生成（侧写存 tripo task id），或对任意已有模型
 * 自动导入（STS 直传 S3 + import_model，同样落侧写以复用）。
 */

const TRIPO_PROVIDER = "tripo";

/**
 * Tripo 的轮询状态 → 任务阶段。
 * 终态之前的每一查都算"在生成"（`running` / `queued` / `processing` …），拿到终态才是"在下产物"。
 */
export function tripoStatusPhase(status: string): GenerationPhase {
  return status === "success" ? "downloading" : "generating";
}

/** 单图与已标注多视角一起解析；普通的多张 sourceImages 不会被误判为四视图。 */
async function resolveTripoImages(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  explicitImage?: string,
  explicitViews?: ReferenceImageViews,
  sessionStartedAt?: number,
): Promise<{ image: string; referenceViews?: ReferenceImageViews }> {
  if (explicitImage) {
    if (!(await storage.exists(explicitImage))) {
      throw new ChatServiceError(`Reference image not found: ${explicitImage}`, 404, "input_image_missing");
    }
    return { image: explicitImage, ...(explicitViews ? { referenceViews: explicitViews } : {}) };
  }
  /*
    Tripo 的取图顺序比通用兜底多一档（多视角的 front 视图优先），所以不能直接复用
    resolveSessionReferenceImage 的顺序；但**归属纪律是同一套**——每一档选出来的图
    都要过闸门，上一轮会话生成的图不许静默复用（见 referenceResolution.ts 头注）。
  */
  const gate: ReferenceResolutionOptions = {
    ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
    operation: "Tripo image-to-3D",
  };
  const identityPath = assetIdentityFile(projectSlug, assetSlug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    const views = explicitViews ?? identity.referenceViews;
    if (views?.front && await storage.exists(views.front)) {
      await assertSelectedReferenceUsable(storage, projectSlug, views.front, gate);
      return { image: views.front, referenceViews: views };
    }
    for (const image of identity.sourceImages) {
      if (await storage.exists(image)) {
        await assertSelectedReferenceUsable(storage, projectSlug, image, gate);
        return { image, ...(views ? { referenceViews: views } : {}) };
      }
    }
  }
  const sourceDir = projectSourceDir(projectSlug);
  const latest = pickLatestSourceImage(await storage.list(sourceDir));
  if (!latest) {
    throw new ChatServiceError(
      `Project "${projectSlug}" has no usable reference image; upload a source image first or generate one with generate-reference-images`,
      409,
      "reference_image_missing",
    );
  }
  const latestPath = `${sourceDir}/${latest}`;
  await assertSelectedReferenceUsable(storage, projectSlug, latestPath, gate);
  return { image: latestPath, ...(explicitViews ? { referenceViews: explicitViews } : {}) };
}

export interface TripoOpResult {
  files: string[];
  sidecar: string;
  tripoTaskId: string;
}

/** 通用落盘段：轮询成功的任务 data → 全部产物下载进资产目录（共享索引）+ 侧写收尾 */
async function landTripoOutputs(
  storage: AssetStorage,
  dir: string,
  index: number,
  assetSlug: string,
  sidecar: RequestSidecar,
  saveSidecar: () => Promise<void>,
  taskData: Record<string, unknown>,
  fetchFn?: typeof fetch,
): Promise<string[]> {
  const refs = extractFileUrls(taskData);
  const seen = new Set<string>();
  const files: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref.url)) continue;
    seen.add(ref.url);
    const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(ref.url)?.[1]?.toLowerCase() ?? "bin";
    const fileSlug = files.length === 0 ? assetSlug : `${assetSlug}-f${files.length + 1}`;
    const path = `${dir}/${formatIndexedName(index, fileSlug, ext)}`;
    await downloadToLibrary(storage, ref.url, path, { fetchFn });
    files.push(path);
    sidecar.outputs.push({ path, providerUrl: ref.url });
  }
  if (files.length === 0) {
    throw new ChatServiceError("No downloadable files in the Tripo result", 502, "tripo_no_files");
  }
  sidecar.status = "succeeded";
  await saveSidecar();
  return files;
}

export const TripoGenParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  image: LogicalPathSchema.optional(),
  referenceViews: ReferenceImageViewsSchema.optional(),
  generationMode: z.enum(["auto", "single", "multiview"]).default("auto"),
});
export type TripoGenParams = z.input<typeof TripoGenParamsSchema>;

/** Tripo 直连图生 3D：产物可被 Tripo 后处理（分割等）链式使用 */
export async function runTripoImageTo3d(
  storage: AssetStorage,
  rawParams: TripoGenParams,
  callOptions: TripoCallOptions,
  /** 当前会话开始时刻；兜底取到的那张图能不能自动用（见 referenceResolution） */
  sessionStartedAt?: number,
): Promise<TripoOpResult> {
  const params = TripoGenParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  const resolved = await resolveTripoImages(
    storage,
    params.projectSlug,
    params.assetSlug,
    params.image,
    params.referenceViews,
    sessionStartedAt,
  );
  const availableViews = params.generationMode === "single"
    ? []
    : await Promise.all(
        (["front", "left", "back", "right"] as const).map(async (view) => {
          const path = resolved.referenceViews?.[view];
          return path && await storage.exists(path) ? ([view, path] as const) : null;
        }),
      ).then((entries) => entries.filter((entry): entry is readonly ["front" | "left" | "back" | "right", string] => Boolean(entry)));
  const hasValidMultiview = availableViews.some(([view]) => view === "front") && availableViews.length >= 2;
  if (params.generationMode === "multiview" && !hasValidMultiview) {
    throw new ChatServiceError(
      "Multiview 3D generation requires a labeled front view and at least one other view; generate multi-angle reference images first",
      409,
      "reference_multiview_missing",
    );
  }
  const useMultiview = params.generationMode !== "single" && hasValidMultiview;

  const dir = assetDir(params.projectSlug, params.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`;

  const now = () => new Date().toISOString();
  const imageModel = callOptions.imageModel ?? DEFAULT_TRIPO_IMAGE_MODEL;
  const textureModel = callOptions.textureModel ?? tripoTextureVersionFor(imageModel);
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: TRIPO_PROVIDER,
    model: useMultiview
      ? "v3/generation/multiview-to-model"
      : "v3/generation/image-to-model",
    params: useMultiview
      ? {
          generation_mode: "multiview",
          reference_views: Object.fromEntries(availableViews),
          image_model: imageModel,
          texture_model: textureModel,
        }
      : {
          generation_mode: "single",
          image: resolved.image,
          image_model: imageModel,
          texture_model: textureModel,
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
    // 上传（换 file_token）不占生成并发，先做完再进闸门
    const request = useMultiview
      ? tripoMultiviewToModelRequest(
          Object.fromEntries(
            await Promise.all(
              availableViews.map(async ([view, path]) => [
                view,
                await uploadTripoFile(
                  path.split("/").pop()!,
                  await storage.readBytes(path),
                  callOptions,
                ),
              ] as const),
            ),
          ),
          callOptions,
        )
      : tripoImageToModelRequest(
          await uploadTripoFile(
            resolved.image.split("/").pop()!,
            await storage.readBytes(resolved.image),
            callOptions,
          ),
          callOptions,
        );

    // 槽一直持到轮询结束：Tripo 数的是"正在跑"的任务数，提交完就放槽等于没限并发
    const { data, taskId } = await runTripoTask(request, callOptions, async (taskId) => {
      sidecar.providerTaskId = taskId;
      sidecar.status = "running";
      await saveSidecar();
      return { taskId, data: await waitForTripoTask(taskId, callOptions) };
    });
    const files = await landTripoOutputs(
      storage,
      dir,
      index,
      params.assetSlug,
      sidecar,
      saveSidecar,
      (data.output ?? data) as Record<string, unknown>,
      callOptions.fetchFn,
    );
    return { files, sidecar: sidecarPath, tripoTaskId: taskId };
  } catch (err) {
    if (err instanceof CloudTaskPending) throw err;
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

/** 该资产最近一次成功的 Tripo 任务 id（分割等后处理的链式输入） */
async function findLatestTripoTaskId(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<string> {
  const dir = assetDir(projectSlug, assetSlug);
  let best: { index: number; taskId: string } | null = null;
  for (const name of await storage.list(dir)) {
    if (!parseRequestSidecarName(name)) continue;
    try {
      const sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
      if (
        sidecar.provider === TRIPO_PROVIDER &&
        sidecar.status === "succeeded" &&
        sidecar.providerTaskId &&
        (!best || sidecar.index > best.index)
      ) {
        best = { index: sidecar.index, taskId: sidecar.providerTaskId };
      }
    } catch {
      // 坏侧写不阻塞扫描
    }
  }
  if (!best) {
    throw new ChatServiceError(
      `Asset "${assetSlug}" has no Tripo task record`,
      409,
      "tripo_task_missing",
    );
  }
  return best.taskId;
}

/** 动作重定向必须引用绑骨任务，而不是任意最新 Tripo 后处理任务。 */
async function findLatestTripoRigTaskId(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<string> {
  const dir = assetDir(projectSlug, assetSlug);
  let best: { index: number; taskId: string } | null = null;
  for (const name of await storage.list(dir)) {
    if (!parseRequestSidecarName(name)) continue;
    try {
      const sidecar = await readJson(storage, `${dir}/${name}`, RequestSidecarSchema);
      if (
        sidecar.provider === TRIPO_PROVIDER &&
        sidecar.model === "/animations/rig" &&
        sidecar.status === "succeeded" &&
        sidecar.providerTaskId &&
        (!best || sidecar.index > best.index)
      ) {
        best = { index: sidecar.index, taskId: sidecar.providerTaskId };
      }
    } catch {
      // 坏侧写不阻塞扫描
    }
  }
  if (!best) {
    throw new ChatServiceError(
      `Asset "${assetSlug}" has no successful Tripo rig record yet; run rig-model first`,
      409,
      "tripo_rig_missing",
    );
  }
  return best.taskId;
}

/** 把资产最新模型导入成 Tripo 任务（STS 直传 + import_model），侧写记录以便复用不重复导入 */
export async function importAssetModelToTripo(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  callOptions: TripoCallOptions,
): Promise<string> {
  const modelPath = await latestAssetModel(storage, projectSlug, assetSlug);
  const ext = modelPath.split(".").pop()!.toLowerCase();

  const dir = assetDir(projectSlug, assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, assetSlug)}`;
  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: assetSlug,
    provider: TRIPO_PROVIDER,
    model: "v3/models/import",
    params: { input_model: modelPath },
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
    const fileToken = await uploadTripoModelViaSts(
      ext,
      await storage.readBytes(modelPath),
      callOptions,
    );
    const taskId = await runTripoTask(
      tripoImportModelRequest(fileToken),
      callOptions,
      async (taskId) => {
        sidecar.providerTaskId = taskId;
        sidecar.status = "running";
        await saveSidecar();
        await waitForTripoTask(taskId, callOptions);
        return taskId;
      },
    );
    sidecar.status = "succeeded";
    await saveSidecar();
    return taskId;
  } catch (err) {
    if (err instanceof CloudTaskPending) throw err;
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

/** 分割等后处理的链头：已有 Tripo 任务直接用，没有则自动导入资产最新模型 */
async function ensureTripoTaskId(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  callOptions: TripoCallOptions,
): Promise<string> {
  try {
    return await findLatestTripoTaskId(storage, projectSlug, assetSlug);
  } catch (err) {
    if ((err as { code?: string }).code !== "tripo_task_missing") throw err;
    return importAssetModelToTripo(storage, projectSlug, assetSlug, callOptions);
  }
}

/** 部件分割（Tripo Segmentation v2，链最近一次 Tripo 任务） */
export async function runTripoSegmentation(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  const originalTaskId = await ensureTripoTaskId(
    storage,
    params.projectSlug,
    params.assetSlug,
    callOptions,
  );

  const dir = assetDir(params.projectSlug, params.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: TRIPO_PROVIDER,
    model: "v3/mesh/segment",
    params: { original_model_task_id: originalTaskId },
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
  const onPhase = callOptions.onPhase;

  try {
    const { files, taskId } = await runTripoTask(
      tripoSegmentRequest(originalTaskId),
      callOptions,
      async (taskId) => {
        sidecar.providerTaskId = taskId;
        sidecar.status = "running";
        await saveSidecar();
        await onPhase?.("generating");

        const data = await waitForTripoTask(taskId, {
          ...callOptions,
          onStatus: async (status) => {
            await callOptions.onStatus?.(status);
            await onPhase?.(tripoStatusPhase(status));
          },
        });
        await onPhase?.("downloading");
        const files = await landTripoOutputs(
          storage,
          dir,
          index,
          params.assetSlug,
          sidecar,
          saveSidecar,
          (data.output ?? data) as Record<string, unknown>,
          callOptions.fetchFn,
        );
        return { files, taskId };
      },
    );
    return { files, sidecar: sidecarPath, tripoTaskId: taskId };
  } catch (err) {
    if (err instanceof CloudTaskPending) throw err;
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

/** tripo-direct 的批量 3D 生成，避免循环依赖放在本文件。 */
export function startTripo3dBatch(
  projectSlug: string,
  objects: GenerationObject[],
  options: {
    tripo3dApiKey: string;
    imageModel?: string;
    generationMode?: "auto" | "single" | "multiview";
    /** 当前会话开始时刻；兜底取图时的归属判据（见 referenceResolution） */
    sessionStartedAt?: number;
  },
) {
  return objects.map((object) =>
    startCustomTask(
      "3d",
      projectSlug,
      `3D generation (Tripo): ${object.name}`,
      (task) =>
        runAndPublishGeneratedModel(
          getAssetStorage(), projectSlug, task.id, object, task.setPhase,
          // 结果带上真实面数与"是不是高模"：生成完那一轮 Agent 才有依据问用户要不要减面
          (target) => runWithGeneratedModelInfo(
            target,
            projectSlug,
            object.slug,
            () => runTripoImageTo3d(
              target,
              {
                projectSlug,
                assetSlug: object.slug,
                image: object.sourceImages[0],
                referenceViews: object.referenceViews,
                generationMode: options.generationMode ?? "auto",
              },
              { apiKey: options.tripo3dApiKey, imageModel: options.imageModel },
              options.sessionStartedAt,
            ),
          ),
        ),
      {
        assetSlug: object.slug,
        retry: {
          kind: "3d",
          assetSlug: object.slug,
          name: object.name,
          intent: object.intent,
          sourceImages: object.sourceImages,
          ...(object.referenceViews ? { referenceViews: object.referenceViews } : {}),
          provider: "tripo-direct",
          options: {
            generationMode: options.generationMode ?? "auto",
            imageModel: options.imageModel,
          },
        },
      },
    ),
  );
}

// ---------- Mastra tool 包装 ----------

export const segmentPartsTool = createTool({
  id: "segment-parts",
  description:
    "Split a 3D model into semantic parts via Tripo Segmentation v2 (paid operation — user consent is required before starting). Supports assets from any source; models not generated by Tripo are imported automatically (≤150MB). Returns a task; follow up with list-generation-tasks",
  inputSchema: z.object({
    assetSlug: SlugSchema,
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const apiKey = requireContextString(
      context,
      "tripo3dApiKey",
      "Missing Tripo3D API key (ask the user to enter it in settings)",
    );
    const task = startCustomTask(
      "segment",
      projectSlug,
      `Part segmentation: ${input.assetSlug}`,
      (task) =>
        runTripoSegmentation(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug },
          { apiKey, onPhase: (phase) => task.setPhase(phase) },
        ),
      { assetSlug: input.assetSlug, cloudOperation: { operation: "segment", input } },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

// ---------- 后处理渠道函数（v3 新版独立端点，developers.tripo3d.ai 核实 2026-07） ----------

/** 贴图重生成只调用 Tripo v3 /models/texture；上传资产库最新模型作为输入。 */
export async function runTripoTexture(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    prompt?: string;
    pbr?: boolean;
    /** 贴图模型版本，缺省用最新的 v3.5；fast 与 delight 只有 v3.5 认。 */
    model?: string;
    textureQuality?: "fast" | "standard" | "detailed" | "extreme";
    delight?: boolean;
  },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  const identityPath = assetIdentityFile(params.projectSlug, params.assetSlug);
  if (!(await storage.exists(identityPath))) {
    throw new ChatServiceError(`Model asset "${params.assetSlug}" does not exist`, 404, "asset_not_found");
  }
  const identity = await readJson(storage, identityPath, AssetIdentitySchema);
  if (identity.kind !== "model") {
    throw new ChatServiceError(`Asset "${params.assetSlug}" is not a model`, 409, "asset_not_model");
  }
  const modelPath = await latestAssetModel(storage, params.projectSlug, params.assetSlug);
  // glTF 可能引用同目录的 .bin/贴图，上传前打包成单文件内嵌资源。
  const bytes = modelPath.toLowerCase().endsWith(".gltf")
    ? (await convertModel(storage, modelPath, "gltf")).bytes
    : await storage.readBytes(modelPath);
  if (bytes.byteLength === 0) {
    throw new ChatServiceError(`Model file "${modelPath}" is empty`, 422, "model_empty");
  }
  if (bytes.byteLength > 150 * 1024 * 1024) {
    throw new ChatServiceError("The Tripo texture endpoint only accepts models up to 150 MB", 413, "tripo_model_too_large");
  }
  const fileName = modelPath.split("/").pop()!;
  const ext = fileName.split(".").pop()!.toLowerCase();
  const textureModel = params.model ?? DEFAULT_TRIPO_TEXTURE_MODEL;
  const fileToken = bytes.byteLength > 60 * 1024 * 1024
    ? await uploadTripoModelViaSts(ext, bytes, callOptions)
    : await uploadTripoFile(fileName, bytes, callOptions);
  return runTripoV3Job(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      path: "/models/texture",
      body: {
        input: fileToken,
        model: textureModel,
        ...(params.prompt ? { texture_prompt: { text: params.prompt } } : {}),
        ...(params.pbr !== undefined ? { pbr: params.pbr } : {}),
        ...(params.textureQuality ? { texture_quality: params.textureQuality } : {}),
        ...(params.delight !== undefined ? { delight: params.delight } : {}),
      },
      sidecarParams: {
        input_model: modelPath,
        texture_model: textureModel,
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(params.pbr !== undefined ? { pbr: params.pbr } : {}),
        ...(params.textureQuality ? { texture_quality: params.textureQuality } : {}),
        ...(params.delight !== undefined ? { delight: params.delight } : {}),
      },
    },
    callOptions,
  );
}

/** 绑骨（POST /v3/animations/rig）：rig_type 支持人形/四足/禽类等，spec tripo/mixamo */
export async function runTripoRig(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    rigType?: "biped" | "quadruped" | "hexapod" | "octopod" | "avian" | "serpentine" | "aquatic";
    spec?: "tripo" | "mixamo";
    model?: "v1.0-20240301" | "v2.5-20260210";
    outFormat?: "glb" | "fbx";
  },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  const originalTaskId = await ensureTripoTaskId(
    storage,
    params.projectSlug,
    params.assetSlug,
    callOptions,
  );
  const model = params.model ?? (
    params.rigType && params.rigType !== "biped"
      ? "v2.5-20260210"
      : "v1.0-20240301"
  );
  if (model === "v1.0-20240301" && params.rigType && params.rigType !== "biped") {
    throw new ChatServiceError(
      "Tripo v1.0 rigging only supports biped; use v2.5-20260210 for non-humanoid skeletons",
      400,
      "tripo_rig_model_mismatch",
    );
  }
  return runTripoV3Job(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      path: "/animations/rig",
      body: {
        input: originalTaskId,
        model,
        out_format: params.outFormat ?? "glb",
        ...(params.rigType ? { rig_type: params.rigType } : {}),
        ...(params.spec ? { spec: params.spec } : {}),
      },
      sidecarParams: {
        original_model_task_id: originalTaskId,
        model,
        out_format: params.outFormat ?? "glb",
        ...(params.rigType ? { rig_type: params.rigType } : {}),
        ...(params.spec ? { spec: params.spec } : {}),
      },
    },
    callOptions,
  );
}

/** Tripo v3 智能重拓扑/减面（POST /mesh/decimate）。 */
export async function runTripoRetopology(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    faceLimit?: number;
    quad?: boolean;
    bake?: boolean;
    model?: "v2.0" | "v1.0";
  },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  const model = params.model ?? "v2.0";
  const quad = params.quad ?? false;
  if (params.faceLimit !== undefined) {
    const { min, max } = quad ? TRIPO_DECIMATE_FACES.quad : TRIPO_DECIMATE_FACES.triangle;
    if (params.faceLimit < min || params.faceLimit > max) {
      throw new ChatServiceError(
        `Tripo ${quad ? "quad" : "triangle"} target face count must be within ${min}–${max}`,
        400,
        "tripo_face_limit_invalid",
      );
    }
  }
  const originalTaskId = await ensureTripoTaskId(
    storage,
    params.projectSlug,
    params.assetSlug,
    callOptions,
  );
  return runTripoV3Job(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      path: "/mesh/decimate",
      body: {
        input: originalTaskId,
        model,
        ...(params.faceLimit !== undefined ? { face_limit: params.faceLimit } : {}),
        quad,
        ...(model === "v2.0" ? { bake: params.bake ?? true } : {}),
      },
      sidecarParams: {
        original_model_task_id: originalTaskId,
        model,
        ...(params.faceLimit !== undefined ? { face_limit: params.faceLimit } : {}),
        quad,
        ...(model === "v2.0" ? { bake: params.bake ?? true } : {}),
      },
    },
    callOptions,
  );
}

/** 把 Tripo 预设动作重定向到最近一次 Tripo 绑骨任务。 */
export async function runTripoAnimationRetarget(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    animation: string;
    outFormat?: "glb" | "fbx";
    bakeAnimation?: boolean;
    exportWithGeometry?: boolean;
    animateInPlace?: boolean;
  },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  if (!params.animation.startsWith("preset:")) {
    throw new ChatServiceError(
      "Tripo animations must use an official preset identifier starting with preset:",
      400,
      "tripo_animation_invalid",
    );
  }
  const rigTaskId = await findLatestTripoRigTaskId(
    storage,
    params.projectSlug,
    params.assetSlug,
  );
  return runTripoV3Job(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      path: "/animations/retarget",
      body: {
        input: rigTaskId,
        animation: params.animation,
        out_format: params.outFormat ?? "glb",
        bake_animation: params.bakeAnimation ?? true,
        export_with_geometry: params.exportWithGeometry ?? true,
        animate_in_place: params.animateInPlace ?? false,
      },
      sidecarParams: {
        rig_task_id: rigTaskId,
        animation: params.animation,
        out_format: params.outFormat ?? "glb",
        bake_animation: params.bakeAnimation ?? true,
        export_with_geometry: params.exportWithGeometry ?? true,
        animate_in_place: params.animateInPlace ?? false,
      },
    },
    callOptions,
  );
}

/** Tripo 没有单独的人物端点；以图生 3D → biped 绑骨组合成带骨骼人物。 */
export async function runTripoCharacter(
  storage: AssetStorage,
  params: {
    projectSlug: string;
    assetSlug: string;
    image?: string;
    spec?: "tripo" | "mixamo";
    rigModel?: "v1.0-20240301" | "v2.5-20260210";
  },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  const resolved = await resolveTripoImages(
    storage,
    params.projectSlug,
    params.assetSlug,
    params.image,
  );
  await runTripoImageTo3d(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      image: resolved.image,
      generationMode: "single",
    },
    callOptions,
  );
  const result = await runTripoRig(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      rigType: "biped",
      spec: params.spec,
      model: params.rigModel,
    },
    callOptions,
  );
  await publishGeneratedModel(
    storage,
    params.projectSlug,
    {
      slug: params.assetSlug,
      name: params.assetSlug,
      intent: `Rigged 3D character of ${params.assetSlug}`,
      sourceImages: [resolved.image],
    },
    result,
  );
  return result;
}

export const generateCharacterTool = createTool({
  id: "generate-character",
  description:
    "Generate a rigged 3D character by running Tripo image-to-3D from a reference image and then automatically applying biped rigging (two paid operations — user consent is required before starting). Returns a task",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    image: LogicalPathSchema.optional(),
    spec: z.enum(["tripo", "mixamo"]).optional(),
    tripoRigModel: z.enum(["v1.0-20240301", "v2.5-20260210"]).optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const apiKey = requireContextString(
      context,
      "tripo3dApiKey",
      "TRIPO_KEY is not configured in the local chat/.env",
    );
    const task = startCustomTask(
      "character",
      projectSlug,
      `3D character generation (Tripo): ${input.assetSlug}`,
      (task) =>
        runTripoCharacter(
          getAssetStorage(),
          {
            projectSlug,
            assetSlug: input.assetSlug,
            image: input.image,
            spec: input.spec,
            rigModel: input.tripoRigModel,
          },
          { apiKey, onPhase: (phase) => task.setPhase(phase) },
        ),
      { assetSlug: input.assetSlug, cloudOperation: { operation: "character", input } },
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

/** v3 通用：提交 → 轮询 /v3/tasks → 产物落盘（与分割同构） */
async function runTripoV3Job(
  storage: AssetStorage,
  request: {
    projectSlug: string;
    assetSlug: string;
    path: string;
    body: Record<string, unknown>;
    sidecarParams: Record<string, unknown>;
  },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  const dir = assetDir(request.projectSlug, request.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, request.assetSlug)}`;
  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: request.assetSlug,
    provider: TRIPO_PROVIDER,
    model: request.path,
    params: request.sidecarParams,
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
  const onPhase = callOptions.onPhase;

  try {
    const { files, taskId } = await runTripoTask(
      { path: request.path, body: request.body },
      callOptions,
      async (taskId) => {
        sidecar.providerTaskId = taskId;
        sidecar.status = "running";
        await saveSidecar();
        await onPhase?.("generating");
        const data = await waitForTripoTask(taskId, {
          ...callOptions,
          // 每查一次都推一次阶段：任务时间戳跟着走，卡死看门狗才分得出"在动"和"没动"
          // （与世界生成同一口径，见 tasks.ts 的 onStatus 注释）
          onStatus: async (status) => {
            await callOptions.onStatus?.(status);
            await onPhase?.(tripoStatusPhase(status));
          },
        });
        await onPhase?.("downloading");
        const files = await landTripoOutputs(
          storage,
          dir,
          index,
          request.assetSlug,
          sidecar,
          saveSidecar,
          (data.output ?? data) as Record<string, unknown>,
          callOptions.fetchFn,
        );
        return { files, taskId };
      },
    );
    return { files, sidecar: sidecarPath, tripoTaskId: taskId };
  } catch (err) {
    if (err instanceof CloudTaskPending) throw err;
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

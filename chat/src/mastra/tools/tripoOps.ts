import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
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
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import { extractMeshyFileUrls } from "../../models/meshy";
import { convertModel } from "../../services/modelConvert";
import {
  createTripoImageToModelTask,
  createTripoImportModelTask,
  createTripoSegmentTask,
  createTripoV3Task,
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
import { runAndPublishGeneratedModel, type GenerationObject } from "../../services/modelPublishing";
import { startCustomTask } from "../../services/tasks";
import { downloadToLibrary } from "./assetRepair";
import { runHunyuanPartSegmentation } from "./hunyuanOps";
import { latestAssetModel, requireProject } from "./projectTools";
import {
  optionalContextString,
  requireContextString,
  requireCurrentProject,
} from "./requestContext";

/**
 * Tripo 直连能力（链式设计）：后处理任务只收 original_model_task_id。
 * 链头两种来源：tripo-direct 生成（侧写存 tripo task id），或对任意已有模型
 * 自动导入（STS 直传 S3 + import_model，同样落侧写以复用）。
 */

const TRIPO_PROVIDER = "tripo";

/** 参考图解析（单图）：显式 > 身份绑定 > 最新源图 */
async function resolveSingleImage(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
  explicit?: string,
): Promise<string> {
  if (explicit) {
    if (!(await storage.exists(explicit))) {
      throw new ChatServiceError(`参考图不存在：${explicit}`, 404, "input_image_missing");
    }
    return explicit;
  }
  const identityPath = assetIdentityFile(projectSlug, assetSlug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    for (const image of identity.sourceImages) {
      if (await storage.exists(image)) return image;
    }
  }
  const sourceDir = projectSourceDir(projectSlug);
  const latest = pickLatestSourceImage(await storage.list(sourceDir));
  if (!latest) {
    throw new ChatServiceError(
      `项目「${projectSlug}」没有可用参考图，请先上传源图或用 generate-reference-images 生成`,
      409,
      "reference_image_missing",
    );
  }
  return `${sourceDir}/${latest}`;
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
  const refs = extractMeshyFileUrls(taskData);
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
    throw new ChatServiceError("Tripo 结果中没有可下载文件", 502, "tripo_no_files");
  }
  sidecar.status = "succeeded";
  await saveSidecar();
  return files;
}

export const TripoGenParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  image: LogicalPathSchema.optional(),
});
export type TripoGenParams = z.input<typeof TripoGenParamsSchema>;

/** Tripo 直连图生 3D：产物可被 Tripo 后处理（分割等）链式使用 */
export async function runTripoImageTo3d(
  storage: AssetStorage,
  rawParams: TripoGenParams,
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  const params = TripoGenParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  const image = await resolveSingleImage(
    storage,
    params.projectSlug,
    params.assetSlug,
    params.image,
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
    model: "v3/generation/image-to-model",
    params: { image },
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
    const fileToken = await uploadTripoFile(
      image.split("/").pop()!,
      await storage.readBytes(image),
      callOptions,
    );
    const taskId = await createTripoImageToModelTask(fileToken, callOptions);
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();

    const data = await waitForTripoTask(taskId, callOptions);
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
      `资产「${assetSlug}」没有 Tripo 任务记录`,
      409,
      "tripo_task_missing",
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
    const taskId = await createTripoImportModelTask(fileToken, callOptions);
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();
    await waitForTripoTask(taskId, callOptions);
    sidecar.status = "succeeded";
    await saveSidecar();
    return taskId;
  } catch (err) {
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

  try {
    const taskId = await createTripoSegmentTask(originalTaskId, callOptions);
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();

    const data = await waitForTripoTask(taskId, callOptions);
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
  options: { tripo3dApiKey: string; imageModel?: string },
) {
  return objects.map((object) =>
    startCustomTask(
      "3d",
      projectSlug,
      `3D 生成（Tripo 直连）：${object.name}`,
      (task) =>
        runAndPublishGeneratedModel(
          getAssetStorage(), projectSlug, task.id, object, task.setPhase,
          (target) => runTripoImageTo3d(
            target,
            { projectSlug, assetSlug: object.slug, image: object.sourceImages[0] },
            { apiKey: options.tripo3dApiKey, imageModel: options.imageModel },
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
          provider: "tripo-direct",
          options: {},
        },
      },
    ),
  );
}

// ---------- Mastra tool 包装 ----------

export const segmentPartsTool = createTool({
  id: "segment-parts",
  description:
    "把 3D 模型拆分成语义部件（付费操作——启动前须经用户同意）。渠道：tripo 默认（Segmentation v2，任意来源资产，非 Tripo 生成的自动导入 ≤150MB）/ hunyuan（仅收 FBX 产物）。任务化返回，用 list-generation-tasks 跟进",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    channel: z.enum(["tripo", "hunyuan"]).default("tripo"),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    if (input.channel === "hunyuan") {
      const hunyuanKey = requireContextString(
        context,
        "hunyuanApiKey",
        "缺少混元 API key（腾讯云「SecretId:SecretKey」，请用户在设置中填写）",
      );
      const task = startCustomTask(
        "segment",
        projectSlug,
        `部件分割：${input.assetSlug}`,
        () =>
          runHunyuanPartSegmentation(
            getAssetStorage(),
            { projectSlug, assetSlug: input.assetSlug },
            { apiKey: hunyuanKey },
          ),
      );
      return { task: { id: task.id, subject: task.subject, status: task.status } };
    }
    const apiKey = requireContextString(
      context,
      "tripo3dApiKey",
      "缺少 Tripo3D API key（请用户在设置中填写）",
    );
    const task = startCustomTask(
      "segment",
      projectSlug,
      `部件分割：${input.assetSlug}`,
      () =>
        runTripoSegmentation(
          getAssetStorage(),
          { projectSlug, assetSlug: input.assetSlug },
          { apiKey },
        ),
    );
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

// ---------- 后处理渠道函数（v3 新版独立端点，developers.tripo3d.ai 核实 2026-07） ----------

/** 贴图重生成只调用 Tripo v3 /models/texture；上传资产库最新模型作为输入。 */
export async function runTripoTexture(
  storage: AssetStorage,
  params: { projectSlug: string; assetSlug: string; prompt?: string; pbr?: boolean },
  callOptions: TripoCallOptions,
): Promise<TripoOpResult> {
  await requireProject(storage, params.projectSlug);
  const identityPath = assetIdentityFile(params.projectSlug, params.assetSlug);
  if (!(await storage.exists(identityPath))) {
    throw new ChatServiceError(`模型资产「${params.assetSlug}」不存在`, 404, "asset_not_found");
  }
  const identity = await readJson(storage, identityPath, AssetIdentitySchema);
  if (identity.kind !== "model") {
    throw new ChatServiceError(`资产「${params.assetSlug}」不是模型`, 409, "asset_not_model");
  }
  const modelPath = await latestAssetModel(storage, params.projectSlug, params.assetSlug);
  // glTF 可能引用同目录的 .bin/贴图，上传前打包成单文件内嵌资源。
  const bytes = modelPath.toLowerCase().endsWith(".gltf")
    ? (await convertModel(storage, modelPath, "gltf")).bytes
    : await storage.readBytes(modelPath);
  if (bytes.byteLength === 0) {
    throw new ChatServiceError(`模型文件「${modelPath}」为空`, 422, "model_empty");
  }
  if (bytes.byteLength > 150 * 1024 * 1024) {
    throw new ChatServiceError("Tripo 贴图接口只接受不超过 150 MB 的模型", 413, "tripo_model_too_large");
  }
  const fileName = modelPath.split("/").pop()!;
  const ext = fileName.split(".").pop()!.toLowerCase();
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
        ...(params.prompt ? { texture_prompt: { text: params.prompt } } : {}),
        ...(params.pbr !== undefined ? { pbr: params.pbr } : {}),
      },
      sidecarParams: {
        input_model: modelPath,
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(params.pbr !== undefined ? { pbr: params.pbr } : {}),
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
  return runTripoV3Job(
    storage,
    {
      projectSlug: params.projectSlug,
      assetSlug: params.assetSlug,
      path: "/animations/rig",
      body: {
        input: originalTaskId,
        out_format: "glb",
        ...(params.rigType ? { rig_type: params.rigType } : {}),
        ...(params.spec ? { spec: params.spec } : {}),
      },
      sidecarParams: {
        original_model_task_id: originalTaskId,
        ...(params.rigType ? { rig_type: params.rigType } : {}),
        ...(params.spec ? { spec: params.spec } : {}),
      },
    },
    callOptions,
  );
}

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

  try {
    const taskId = await createTripoV3Task(request.path, request.body, callOptions);
    sidecar.providerTaskId = taskId;
    sidecar.status = "running";
    await saveSidecar();
    const data = await waitForTripoTask(taskId, callOptions);
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
    return { files, sidecar: sidecarPath, tripoTaskId: taskId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

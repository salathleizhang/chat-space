import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { assetIdentityFile } from "../../common/libraryPaths";
import { AssetIdentitySchema, LogicalPathSchema, SlugSchema } from "../../dto/library";
import { THREE_D_PROVIDER_IDS } from "../../models/threeD";
import { getAssetStorage, readJson } from "../../services/assetStorage";
import type { GenerationObject } from "../../services/modelPublishing";
import { listTasks, resolve3dObjects, startWorldTask } from "../../services/tasks";
import {
  currentSessionStartedAt,
  currentThreeDModel,
  requireContextString,
  requireCurrentProject,
} from "./requestContext";
import {
  ReferenceReuseConsentError,
  resolveSessionReferenceImage,
} from "./referenceResolution";
import { startSeed3d3dBatch } from "./seed3dOps";
import { startTripo3dBatch } from "./tripoOps";
import { startArk3dBatch } from "./ark3dOps";

/** creator agent 的生成任务工具：启动即返回任务 id，不阻塞对话流 */

/**
 * 批量生成前的参考图闸门：逐个对象判断"这次实际会用哪张图、它能不能自动用"。
 *
 * 判据不是"有没有 sourceImages"——`resolve3dObjects` 会把资产绑定的 sourceImages
 * 填进 `object.sourceImages`，那张图同样可能是**上一轮会话生成的**（资产保留着旧
 * 参考图就是常态）。所以这里把三档来源（已确定的 sourceImages[0] → 身份绑定 →
 * 最新源图）统一交给 `resolveSessionReferenceImage`，并用 `explicitMustBeFresh`
 * 把"来自存档的选择"也纳入归属判定：用户自己上传的原图没有生成时间，永远可复用；
 * 上一轮生成的参考图一律要用户点头。
 */
async function assertBatchReferencesUsable(
  projectSlug: string,
  objects: GenerationObject[],
  sessionStartedAt: number | undefined,
): Promise<void> {
  const storage = getAssetStorage();
  for (const object of objects) {
    await assertReferenceUsableForAsset(storage, projectSlug, object, sessionStartedAt);
  }
}

/**
 * 单个对象实际会用到的那张图能不能自动用。找不到任何图时**不当失败**——让生成任务
 * 照旧启动、照旧在那里报 `reference_image_missing`，保持这条路径被改造前的行为；
 * 闸门只负责"不许静默复用旧图"。
 */
async function assertReferenceUsableForAsset(
  storage: ReturnType<typeof getAssetStorage>,
  projectSlug: string,
  object: GenerationObject,
  sessionStartedAt: number | undefined,
): Promise<void> {
  const identityPath = assetIdentityFile(projectSlug, object.slug);
  const boundCandidates =
    (await storage.exists(identityPath))
      ? (await readJson(storage, identityPath, AssetIdentitySchema)).sourceImages
      : [];
  const options = {
    ...(object.sourceImages[0] ? { explicit: object.sourceImages[0] } : {}),
    boundCandidates,
    explicitMustBeFresh: true,
    ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
    operation: "3D generation",
  };
  try {
    await resolveSessionReferenceImage(storage, projectSlug, options);
  } catch (error) {
    if (error instanceof ReferenceReuseConsentError) throw error;
    if ((error as ChatServiceError).code !== "reference_image_missing") throw error;
  }
}

export type WorldSourceMode = "latest" | "text-only" | "explicit-path";

/**
 * 工具调用里的可选字符串偶尔会被模型编码成 `__OMIT__`。它不是资产路径；旧调用
 * 没有 sourceMode 时，把它按真正的“省略”处理。新调用以 sourceMode 为唯一语义，
 * 因而 latest/text-only 即使夹带了占位值也不会误读文件。
 */
export function resolveWorldSourceImage(input: {
  sourceMode?: WorldSourceMode;
  sourceImage?: string | null;
}): string | null | undefined {
  const legacyOmitted = input.sourceImage === "__OMIT__";
  const sourceMode = input.sourceMode ?? (
    input.sourceImage === null
      ? "text-only"
      : input.sourceImage === undefined || legacyOmitted
        ? "latest"
        : "explicit-path"
  );

  if (sourceMode === "latest") return undefined;
  if (sourceMode === "text-only") return null;
  if (!input.sourceImage || legacyOmitted) {
    throw new ChatServiceError(
      "sourceMode=explicit-path requires a real sourceImage logical path",
      400,
      "world_source_image_missing",
    );
  }
  return input.sourceImage;
}

/** 整批统一的生成选项（与 dto/tasks.ts 的 HTTP 契约对齐） */
export const Batch3dOptionsSchema = z.object({
  assetSlugs: z.array(SlugSchema).optional(),
  provider: z.enum(THREE_D_PROVIDER_IDS).default("seed3d-direct"),
  faceCount: z.number().int().min(500).max(2000000).optional(),
  taPose: z.boolean().optional(),
  resolution: z.enum(["1536", "1536pro"]).optional(),
  /** seed3d-direct：面数走档位而非精确值（high=100 万 / medium=50 万 / low=10 万） */
  subdivisionLevel: z.enum(["high", "medium", "low"]).optional(),
  /** Tripo：auto 会在资产带有 front + 至少另一视角时自动切换多视角生成。 */
  tripoGenerationMode: z.enum(["auto", "single", "multiview"]).default("auto"),
});

export const start3dBatchTool = createTool({
  id: "start-3d-batch",
  description:
    "Generate 3D models in parallel for the objects of the current project. Options are Volcano Engine Ark Seed3D (default), Hyper3D Gen-2, ShuMei Hi3D 2.0, or Tripo3D; get the user's consent before starting a paid operation. When the user has selected a specific 3D model in the dropdown, the server pins the channel and model ID to that choice and the provider parameter is ignored. Tripo's tripoGenerationMode=auto automatically uses multiview generation for reference images tagged with views; single/multiview can also be specified explicitly. Hi3D uses the URL of a reference image generated or edited by Seedream. Returns task ids; follow up with list-generation-tasks. A task's result carries modelInfo (measured triangle count and highPoly) — once a high-poly model is done, ask the user once with ask-user whether to decimate, as prompted.",
  inputSchema: Batch3dOptionsSchema,
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const { assetSlugs, provider: requestedProvider, ...options } = input;
    /** 用户选定的具体模型优先于 agent 的判断；未选择（Auto）才用请求里的 provider。 */
    const pinned = currentThreeDModel(context);
    const provider = pinned?.provider ?? requestedProvider;
    const model = pinned?.model;
    const objects = await resolve3dObjects(projectSlug, assetSlugs);
    /*
      闸门：这批对象有没有"要靠兜底拿图"的？
      `object.sourceImages` 非空表示调用方（Agent 或场景任务）**点名**了用哪张图，
      那是有意为之；为空则表示生成时会走"身份绑定 → 最新源图"的兜底。兜底里那张图
      若是上一轮会话的产物，就必须先问用户，不能替他把这笔钱花了（口径见
      referenceResolution.ts 头注）。放在这里而不是任务内部：任务一旦启动就返回
      id 了，失败只会沉在任务列表里，Agent 当场看不到、也就不会去问用户。
    */
    const sessionStartedAt = currentSessionStartedAt(context);
    await assertBatchReferencesUsable(projectSlug, objects, sessionStartedAt);
    if (provider === "tripo-direct") {
      const tripo3dApiKey = requireContextString(
        context,
        "tripo3dApiKey",
        "TRIPO_KEY is not configured in the local chat/.env",
      );
      const tasks = startTripo3dBatch(projectSlug, objects, {
        tripo3dApiKey,
        generationMode: options.tripoGenerationMode,
        imageModel: model,
        sessionStartedAt,
      });
      return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
    }
    if (provider === "hyper3d-volc" || provider === "hi3d-volc") {
      const apiKey = requireContextString(
        context,
        "volcengineApiKey",
        "VOLC_KEY is not configured in the local chat/.env",
      );
      const tasks = startArk3dBatch(provider, projectSlug, objects, {
        apiKey,
        faceCount: options.faceCount,
        taPose: options.taPose,
        resolution: options.resolution,
        model,
        sessionStartedAt,
      });
      return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
    }
    const seed3dApiKey = requireContextString(
      context,
      "seed3dApiKey",
      "VOLC_KEY is not configured in the local chat/.env",
    );
    const tasks = startSeed3d3dBatch(projectSlug, objects, {
      seed3dApiKey,
      subdivisionLevel: options.subdivisionLevel,
      model,
      sessionStartedAt,
    });
    return { tasks: tasks.map(({ id, subject, status }) => ({ id, subject, status })) };
  },
});

/**
 * `start-world-task` 的 `latest` 兜底闸门。和 3D 那条的区别只是**没有身份绑定这一档**
 * ——World Labs 的输入是"项目最新源图"，与某个资产无关，所以直接问"最新那张能不能
 * 自动用"。一张图都没有时保持原行为（生成照旧启动、由它自己报缺图）。
 */
async function assertLatestSourceUsable(
  projectSlug: string,
  sessionStartedAt: number | undefined,
): Promise<void> {
  const storage = getAssetStorage();
  try {
    await resolveSessionReferenceImage(storage, projectSlug, {
      ...(sessionStartedAt !== undefined ? { sessionStartedAt } : {}),
      operation: "World generation (sourceMode=latest)",
    });
  } catch (error) {
    if (error instanceof ReferenceReuseConsentError) throw error;
    if ((error as ChatServiceError).code !== "reference_image_missing") throw error;
  }
}

export const startWorldTaskTool = createTool({
  id: "start-world-task",
  description:
    "Start a World Labs scene generation task for the current project (paid operation — get the user's consent before starting). mode=direct generates the world directly and needs no image analysis; mode=empty-environment removes objects according to the confirmed scene analysis. Use sourceMode to choose the image source explicitly: latest uses the newest source image, text-only uses no image, and explicit-path uses the logical path given in sourceImage. sourceMode may only be omitted for compatibility with old calls; new calls must pass it.",
  inputSchema: z.object({
    mode: z.enum(["direct", "empty-environment"]),
    sourceMode: z.enum(["latest", "text-only", "explicit-path"]).optional(),
    sourceImage: LogicalPathSchema.nullable().optional(),
    prompt: z.string().optional(),
    extraPrompt: z.string().optional(),
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    const worldLabsApiKey = requireContextString(
      context,
      "worldLabsApiKey",
      "WORLDLABS_KEY is not configured in the local chat/.env",
    );
    const sourceImage = resolveWorldSourceImage(input);
    /*
      `sourceMode=latest` 是一条真兜底：没点名图片，由服务端取 source/ 里最新那张——
      那完全可能是上一轮会话为别的对象生成的参考图。所以这里与 3D 批量同一套闸门
      （explicit-path 是点名，text-only 不用图，两者都不过闸门）。
    */
    if (sourceImage === undefined) {
      await assertLatestSourceUsable(projectSlug, currentSessionStartedAt(context));
    }
    const task = startWorldTask(projectSlug, input.mode === "direct"
      ? { worldLabsApiKey, mode: input.mode, sourceImage, prompt: input.prompt }
      : { worldLabsApiKey, mode: input.mode, sourceImage, extraPrompt: input.extraPrompt });
    return { task: { id: task.id, subject: task.subject, status: task.status } };
  },
});

export const listGenerationTasksTool = createTool({
  id: "list-generation-tasks",
  description:
    "Check the generation task statuses (running / succeeded / failed) and output paths of the current project." +
    "A task carrying `stall` is running but has made no progress for a long time: `pumpActive=true` means the local clock is still watching it" +
    " (just keep waiting, do not resubmit), while `pumpActive=false` means you should first resume-generation (continue from the sidecar without paying again) before considering a retry",
  inputSchema: z.object({}),
  execute: async (_input, context) => ({
    tasks: (await listTasks(requireCurrentProject(context))).map(
      ({ id, subject, status, phase, error, result, stall }) => ({
        id,
        subject,
        status,
        phase,
        error,
        result,
        // 只在真的停顿时出现，不刷屏：它是"running 且静默超过 90 秒"的读时派生诊断
        ...(stall ? { stall } : {}),
      }),
    ),
  }),
});

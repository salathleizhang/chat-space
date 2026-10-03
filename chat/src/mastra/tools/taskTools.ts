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
    operation: "3D 生成",
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
      "sourceMode=explicit-path 时必须提供真实的 sourceImage 逻辑路径",
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
    "为当前项目的对象并行生成 3D 模型。可选火山方舟 Seed3D（默认）、Hyper3D Gen-2、数美 Hi3D 2.0，或 Tripo3D；付费启动前须经用户同意。用户在下拉框选定具体 3D 模型时，渠道与模型 ID 由服务端按该选择钉住，provider 参数会被忽略。Tripo 的 tripoGenerationMode=auto 会对带视角标记的参考图自动使用多视角生成，也可指定 single/multiview。Hi3D 使用 Seedream 生成或编辑的参考图 URL。返回任务 id，用 list-generation-tasks 跟进；任务的 result 里带 modelInfo（实测三角面数与 highPoly），高模完成后要按提示用 ask-user 问一次要不要降面。",
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
        "本机 chat/.env 未配置 TRIPO_KEY",
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
        "本机 chat/.env 未配置 VOLC_KEY",
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
      "本机 chat/.env 未配置 VOLC_KEY",
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
      operation: "世界生成（sourceMode=latest）",
    });
  } catch (error) {
    if (error instanceof ReferenceReuseConsentError) throw error;
    if ((error as ChatServiceError).code !== "reference_image_missing") throw error;
  }
}

export const startWorldTaskTool = createTool({
  id: "start-world-task",
  description:
    "为当前项目启动 World Labs 场景生成任务（付费操作——启动前须经用户同意）。mode=direct 直接生成世界，不需要图片分析；mode=empty-environment 根据已确认的场景分析去除物体。用 sourceMode 明确选择图片来源：latest 使用最新源图，text-only 不使用图片，explicit-path 使用 sourceImage 指定的逻辑路径。sourceMode 仅为兼容旧调用而允许省略，新调用必须传。",
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
      "本机 chat/.env 未配置 WORLDLABS_KEY",
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
    "查看当前项目的生成任务状态（running / succeeded / failed）与产物路径。" +
    "任务带 `stall` 表示它 running 但长时间没有进展：`pumpActive=true` 说明本机时钟仍在照看它" +
    "（继续等即可，不要重复提交），`pumpActive=false` 才需要先 resume-generation（凭侧写续跑、不重复付费）再考虑重试",
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

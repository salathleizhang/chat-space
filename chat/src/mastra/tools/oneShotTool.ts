import { createTool } from "@mastra/core/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  projectAnalysisFile,
  projectDir,
  projectSourceDir,
} from "../../common/libraryPaths";
import { slugifyOrFallback } from "../../common/slug";
import {
  ImageAnalysisSchema,
  LogicalPathSchema,
  ObjectCandidateSchema,
  SceneAnalysisSchema,
  SlugSchema,
  type ConfirmedObject,
  type ObjectCandidate,
} from "../../dto/library";
import { getAssetStorage, readJson, writeJson } from "../../services/assetStorage";
import { mutateCandidates } from "../../services/candidateRegistry";
import { startWorldTask } from "../../services/tasks";
import type { RunKeys } from "../../services/workflowRuns";
import { runPlateGeneration, type ImageEditResult } from "./falImageEdit";
import { requireProject, uniqueAssetSlug } from "./projectTools";
import { startSeed3d3dBatch } from "./seed3dOps";
import {
  currentImagePaths,
  optionalContextString,
  referenceAnalysisAllowed,
  requireCurrentProject,
} from "./requestContext";

/**
 * 场景管线的对话入口，三个工具对应"发现对象 → 确认 → 一次跑完"三段：
 *
 * - analyze-reference（免费）：Creator 已经在当前多模态消息里看到了参考图，直接
 *   把观察结果作为工具参数交给本地代码校验、落盘，并停在对象确认站。这里不再
 *   嵌套调用第二个 LLM，也不再为一次确认维护 Mastra workflow suspend/resume。
 * - confirm-reference-assets（免费，本身不生成任何东西）：确认对象 → 只落盘
 *   analysis.json 候选；模型成功发布前绝不创建正式资产。
 * - run-one-shot（付费）：直接读已经落盘的 analysis.json（跟
 *   generate-plate 读的是同一份），点火 plate→world→批量 3D，立即返回不等待
 *   收尾（跟 start-3d-batch/start-world-task 一样的"启动即返回"纪律）。
 *
 * 想要更细的控制——只生成底板、跳过场景、只挑几个对象——分别用
 * generate-plate / start-world-task / start-3d-batch，不必经过 run-one-shot。
 */

export interface CandidateObject {
  slug: string;
  name: string;
  description: string;
}

export interface AnalyzeReferenceResult {
  runId: string;
  title: string;
  description?: string;
  objects: CandidateObject[];
}

export const AnalyzeReferenceDraftSchema = z.object({
  sceneName: z.string().min(1),
  sceneDescription: z.string().min(1),
  environment: z
    .object({
      lighting: z.string(),
      mood: z.string(),
      spatialLayout: z.string(),
    })
    .partial()
    .default({}),
  observations: z.string().min(1),
  objects: z
    .array(
      z.object({
        /** LLM 产出的 slug 不可信；执行层会统一消毒，留空时从 name 推导。 */
        slug: z.string().optional(),
        name: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .max(50),
});
export type AnalyzeReferenceDraft = z.input<typeof AnalyzeReferenceDraftSchema>;

const PendingReferenceAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  projectSlug: SlugSchema,
  image: LogicalPathSchema,
  sceneName: z.string().min(1),
  sceneDescription: z.string().min(1),
  environment: AnalyzeReferenceDraftSchema.shape.environment,
  observations: z.string().min(1),
  objects: z.array(ObjectCandidateSchema),
  createdAt: z.iso.datetime(),
});

function pendingAnalysisPath(projectSlug: string, runId: string): string {
  return `${projectDir(projectSlug)}/.analyze-reference-${runId}.json`;
}

function sanitizeCandidateSlugs(
  objects: z.infer<typeof AnalyzeReferenceDraftSchema>["objects"],
): ObjectCandidate[] {
  const used = new Set<string>();
  return objects.map((object) => {
    const base =
      object.slug && SlugSchema.safeParse(object.slug).success
        ? object.slug
        : slugifyOrFallback(object.name, "object");
    let slug = base;
    let suffix = 2;
    while (used.has(slug)) slug = `${base}-${suffix++}`;
    used.add(slug);
    return { slug, name: object.name, description: object.description };
  });
}

function keysFromContext(context: Parameters<typeof optionalContextString>[0]): RunKeys {
  return {
    worldLabsApiKey: optionalContextString(context, "worldLabsApiKey"),
    volcengineApiKey: optionalContextString(context, "volcengineApiKey"),
    seed3dApiKey: optionalContextString(context, "seed3dApiKey"),
  };
}

const IMAGE_EXT_RE = /^(png|jpe?g|webp)$/i;

/** 校验 Creator 的视觉分析并落逐图元数据，返回候选清单供其转述给用户确认。 */
export async function runAnalyzeReference(
  projectSlug: string,
  input: { image: string; analysis: AnalyzeReferenceDraft },
): Promise<AnalyzeReferenceResult> {
  const storage = getAssetStorage();
  await requireProject(storage, projectSlug);
  const sourceDir = projectSourceDir(projectSlug);
  const imageName = input.image.slice(sourceDir.length + 1);
  const ext = imageName.split(".").pop() ?? "";
  if (
    !input.image.startsWith(`${sourceDir}/`) ||
    imageName.includes("/") ||
    !IMAGE_EXT_RE.test(ext)
  ) {
    throw new ChatServiceError(
      `参考图不属于当前项目或格式不受支持：${input.image}`,
      400,
      "invalid_reference_image",
    );
  }
  if (!(await storage.exists(input.image))) {
    throw new ChatServiceError(
      `参考图不存在：${input.image}`,
      404,
      "reference_image_not_found",
    );
  }

  const analysis = AnalyzeReferenceDraftSchema.parse(input.analysis);
  const objects = sanitizeCandidateSlugs(analysis.objects);
  const analyzedAt = new Date().toISOString();
  await writeJson(storage, `${sourceDir}/${imageName}.json`, ImageAnalysisSchema, {
    schemaVersion: 1,
    image: input.image,
    observations: analysis.observations,
    objects,
    analyzedAt,
  });

  const runId = randomUUID();
  await writeJson(
    storage,
    pendingAnalysisPath(projectSlug, runId),
    PendingReferenceAnalysisSchema,
    {
      schemaVersion: 1,
      runId,
      projectSlug,
      image: input.image,
      sceneName: analysis.sceneName,
      sceneDescription: analysis.sceneDescription,
      environment: analysis.environment,
      observations: analysis.observations,
      objects,
      createdAt: analyzedAt,
    },
  );
  return {
    runId,
    title: `在「${analysis.sceneName}」中发现 ${objects.length} 个可生成对象`,
    description: "请确认要建立为 3D 资产的对象；未选择的对象不会落盘。",
    objects,
  };
}

export interface ConfirmReferenceAssetsResult {
  projectSlug: string;
  objects: ObjectCandidate[];
}

/** 确认对象 → 落盘参考图分析候选；不创建资产，也不生成任何东西。 */
export async function runConfirmReferenceAssets(
  projectSlug: string,
  input: { runId: string; selectedSlugs?: string[] },
): Promise<ConfirmReferenceAssetsResult> {
  const parsedRunId = z.uuid().safeParse(input.runId);
  const storage = getAssetStorage();
  const pendingPath = parsedRunId.success
    ? pendingAnalysisPath(projectSlug, parsedRunId.data)
    : "";
  if (!pendingPath || !(await storage.exists(pendingPath))) {
    throw new ChatServiceError(
      `没有可恢复的参考图分析 run「${input.runId}」（可能不存在或已经确认过，请重新调用 analyze-reference）`,
      404,
      "run_not_found",
    );
  }
  const pending = await readJson(
    storage,
    pendingPath,
    PendingReferenceAnalysisSchema,
  );
  if (pending.projectSlug !== projectSlug) {
    throw new ChatServiceError(
      "参考图分析 run 属于其他项目，无法在当前项目继续",
      409,
      "confirm_reference_assets_project_mismatch",
    );
  }

  const selectedSlugs = new Set(
    input.selectedSlugs ?? pending.objects.map((object) => object.slug),
  );
  const selected = pending.objects.filter((object) => selectedSlugs.has(object.slug));
  if (selected.length === 0) {
    // 空选择（[] 或全不匹配的 slug）不能静默清空 analysis.json 并消费 run——
    // run-one-shot / generate-plate 都读 analysis.json，会把它清成空。
    throw new ChatServiceError(
      "没有选中任何候选对象，请至少确认一个对象",
      409,
      "no_selected_objects",
    );
  }
  const now = new Date().toISOString();
  let resolved: ObjectCandidate[] = [];
  // candidates.json 的读改写走统一串行 mutator：与后台 3D 任务完成后的删项交错时不丢更新。
  await mutateCandidates(storage, projectSlug, async (previousCandidates) => {
    const reserved = new Set(previousCandidates.objects.map((object) => object.slug));
    resolved = [];
    for (const object of selected) {
      const base = await uniqueAssetSlug(storage, projectSlug, object.slug);
      let slug = base;
      let suffix = 2;
      while (reserved.has(slug)) slug = `${base}-${suffix++}`;
      reserved.add(slug);
      resolved.push(slug === object.slug ? object : { ...object, slug });
    }
    await writeJson(storage, projectAnalysisFile(projectSlug), SceneAnalysisSchema, {
      schemaVersion: 1,
      sceneName: pending.sceneName,
      sceneDescription: pending.sceneDescription,
      environment: pending.environment,
      objects: resolved.map((object) => ({
        ...object,
        sourceImages: [pending.image],
      })),
      sources: [pending.image],
      analyzedAt: now,
    });
    return {
      schemaVersion: 1,
      objects: [
        ...previousCandidates.objects,
        ...resolved.map((object) => ({ ...object, sourceImages: [pending.image] })),
      ],
      updatedAt: now,
    };
  });
  // 全部元数据成功落盘后才消费 run；磁盘失败时保留草稿供原 runId 重试确认。
  await storage.remove(pendingPath);
  return { projectSlug, objects: resolved };
}

export interface OneShotLaunchSummary {
  projectSlug: string;
  objects: ObjectCandidate[];
  plate?: ImageEditResult;
  plateSkippedReason?: string;
  plateError?: string;
  worldStarted: boolean;
  tasksStarted: number;
}

/** plate → world + 批量 3D 任务点火，不等待任务收尾 */
async function launchOneShotGeneration(
  project: string,
  uncover: { objects: ConfirmedObject[] },
  keys: RunKeys,
): Promise<OneShotLaunchSummary> {
  const summary: OneShotLaunchSummary = {
    projectSlug: project,
    objects: uncover.objects,
    worldStarted: false,
    tasksStarted: 0,
  };

  if (uncover.objects.length > 0) {
    const hasImageEditKey = keys.volcengineApiKey;
    if (!hasImageEditKey) {
      summary.plateSkippedReason = "本机 chat/.env 未配置 VOLC_KEY";
    } else {
      try {
        summary.plate = await runPlateGeneration(
          getAssetStorage(),
          { projectSlug: project },
          keys,
        );
      } catch (err) {
        summary.plateError = toErrorMessage(err);
      }
    }
  }

  if (keys.worldLabsApiKey) {
    startWorldTask(project, { worldLabsApiKey: keys.worldLabsApiKey });
    summary.worldStarted = true;
  }
  if (keys.seed3dApiKey && uncover.objects.length > 0) {
    const tasks = startSeed3d3dBatch(
      project,
      uncover.objects.map((object) => ({
        slug: object.slug,
        name: object.name,
        intent: object.description,
        sourceImages: object.sourceImages ?? [],
      })),
      { seed3dApiKey: keys.seed3dApiKey },
    );
    summary.tasksStarted = tasks.length;
  }

  return summary;
}

export interface RunOneShotResult extends OneShotLaunchSummary {
  message: string;
}

/** 不碰 workflow，直接读已落盘的参考图分析（跟 generate-plate 读的是同一份）→ 点火 */
export async function runRunOneShot(
  projectSlug: string,
  keys: RunKeys,
): Promise<RunOneShotResult> {
  const storage = getAssetStorage();
  const analysisPath = projectAnalysisFile(projectSlug);
  if (!(await storage.exists(analysisPath))) {
    throw new ChatServiceError(
      `项目「${projectSlug}」还没有参考图资产分析，请先用 analyze-reference + confirm-reference-assets 确认对象`,
      409,
      "analysis_missing",
    );
  }
  const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
  const launch = await launchOneShotGeneration(
    projectSlug,
    { objects: analysis.objects },
    keys,
  );
  return {
    ...launch,
    message:
      launch.worldStarted || launch.tasksStarted > 0
        ? "已启动生成，用 list-generation-tasks 跟进进度"
        : "没有配置任何生成用的 key，没有启动任何任务",
  };
}

// ---------- Mastra 工具包装 ----------

export const analyzeReferenceTool = createTool({
  id: "analyze-reference",
  description:
    "把本条用户消息明确附带的图片作为正式参考图并进入资产确认流程（免费，本地落盘，不会再调用另一个 LLM）。你已经能直接看到当前图片：请按实际画面填写场景描述，并把每件可独立拿起、独立建模的原子物品列入 objects；不要把墙、地面、地毯、天空、水面列为对象，也不要把一组家具合并成套装。只有用户明确要求拆资产或从图生成 3D 时调用；普通看图、截图排错、设计评价不调用。",
  inputSchema: AnalyzeReferenceDraftSchema,
  execute: async (input, context) => {
    if (!referenceAnalysisAllowed(context)) {
      throw new ChatServiceError(
        "本条消息没有明确要求把附图作为参考图提取 3D 资产",
        400,
        "reference_analysis_intent_required",
      );
    }
    const images = currentImagePaths(context);
    if (images.length !== 1) {
      throw new ChatServiceError(
        images.length === 0
          ? "本条消息没有附带图片，不能启动参考图资产提取"
          : "本条消息附带多张图片，当前参考图资产提取只支持单图",
        400,
        "reference_image_required",
      );
    }
    return runAnalyzeReference(
      requireCurrentProject(context),
      { image: images[0]!, analysis: input },
    );
  },
});

export const confirmReferenceAssetsTool = createTool({
  id: "confirm-reference-assets",
  description:
    "确认 analyze-reference 从参考图提取的资产候选（免费，本身不生成任何东西）：省略 selectedSlugs 视为全部确认，传入子集则只对这些对象建立资产身份。确认后分析与各对象身份落盘，之后按需调用 generate-plate / start-world-task / start-3d-batch，或者用 run-one-shot 跑完整条链路。",
  inputSchema: z.object({
    runId: z.string().min(1),
    selectedSlugs: z.array(z.string()).optional(),
  }),
  execute: async (input, context) =>
    runConfirmReferenceAssets(
      requireCurrentProject(context),
      input,
    ),
});

export const runOneShotTool = createTool({
  id: "run-one-shot",
  description:
    "一次性跑完已确认参考图的干净底板、World Labs 场景生成、逐对象并行 3D 生成（付费操作——启动前须经用户同意）。要求当前项目已经用 analyze-reference + confirm-reference-assets 确认过资产（即 analysis.json 已存在）。启动后立即返回摘要，不等待任务收尾——用 list-generation-tasks 跟进进度。只想要其中一部分用 generate-plate / start-world-task / start-3d-batch 分别调用。",
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const projectSlug = requireCurrentProject(context);
    return runRunOneShot(projectSlug, keysFromContext(context));
  },
});

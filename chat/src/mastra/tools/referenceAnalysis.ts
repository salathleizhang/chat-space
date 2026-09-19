import { createTool } from "@mastra/core/tools";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
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
  type ObjectCandidate,
} from "../../dto/library";
import { getAssetStorage, readJson, writeJson } from "../../services/assetStorage";
import { mutateCandidates } from "../../services/candidateRegistry";
import { requireProject, uniqueAssetSlug } from "./projectTools";
import {
  currentImagePaths,
  referenceAnalysisAllowed,
  requireCurrentProject,
} from "./requestContext";

/**
 * 场景管线的确认入口；完整生成由注册到 Agent 的 Mastra Workflow 执行：
 *
 * - analyze-reference（免费）：Creator 已经在当前多模态消息里看到了参考图，直接
 *   把观察结果作为工具参数交给本地代码校验、落盘，并停在对象确认站。这里不再
 *   嵌套调用第二个 LLM，也不再为一次确认维护 Mastra workflow suspend/resume。
 * - one-shot-scene Workflow 的首个步骤（免费）：确认对象 → 只落盘
 *   analysis.json 候选；模型成功发布前绝不创建正式资产。确认不再作为 Agent Tool 暴露。
 * - one-shot-scene Workflow（付费）：逐对象参考图 → 干净底板 → 空环境世界
 *   → 逐对象 3D；后台任务在全部产物落盘后才完成。
 *
 * 已有场景确认记录后，仍可用 generate-reference-images(mode=plate) /
 * start-world-task / start-3d-batch 对产物做单步补充或重试。
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

async function pendingRunPath(projectSlug: string, runId?: string): Promise<string> {
  const storage = getAssetStorage();
  if (runId !== undefined) {
    const parsed = z.uuid().safeParse(runId);
    const path = parsed.success ? pendingAnalysisPath(projectSlug, parsed.data) : "";
    if (path && await storage.exists(path)) return path;
    throw new ChatServiceError(
      `没有可恢复的参考图分析 run「${runId}」（可能不存在或已经确认过，请重新调用 analyze-reference）`,
      404,
      "run_not_found",
    );
  }
  const pending = (await storage.list(projectDir(projectSlug)))
    .filter((name) => /^\.analyze-reference-[0-9a-f-]{36}\.json$/i.test(name));
  if (pending.length === 1) return `${projectDir(projectSlug)}/${pending[0]}`;
  throw new ChatServiceError(
    pending.length === 0
      ? "没有待确认的参考图分析，请重新调用 analyze-reference"
      : "当前项目有多份待确认的参考图分析，请指定 runId",
    409,
    pending.length === 0 ? "run_not_found" : "multiple_pending_runs",
  );
}

/** 确认对象 → 落盘参考图分析候选；不创建资产，也不生成任何东西。 */
export async function runConfirmReferenceAssets(
  projectSlug: string,
  input: { runId?: string; selectedSlugs?: string[] },
): Promise<ConfirmReferenceAssetsResult> {
  const storage = getAssetStorage();
  let pendingPath: string;
  try {
    pendingPath = await pendingRunPath(projectSlug, input.runId);
  } catch (error) {
    // Workflow 启动成功后会消费临时 run。重试完整流程时，同一 runId 应直接
    // 复用已经确认的分析，而不是要求用户重新上传和确认。
    const analysisPath = projectAnalysisFile(projectSlug);
    if (
      input.runId &&
      error instanceof ChatServiceError &&
      error.code === "run_not_found" &&
      await storage.exists(analysisPath)
    ) {
      const confirmed = await readJson(storage, analysisPath, SceneAnalysisSchema);
      const confirmation = confirmed.confirmation;
      if (confirmation?.runId === input.runId) {
        const requested = input.selectedSlugs
          ? new Set(input.selectedSlugs)
          : undefined;
        const matchesPreviousSelection = requested
          ? requested.size === confirmation.selectedSlugs.length &&
            confirmation.selectedSlugs.every((slug) => requested.has(slug))
          : confirmation.allSelected;
        if (!matchesPreviousSelection) {
          throw new ChatServiceError(
            "这次参考图分析已经用另一份对象选择启动过 Workflow；如需更改选择，请重新调用 analyze-reference",
            409,
            "confirmation_selection_mismatch",
          );
        }
        return {
          projectSlug,
          objects: confirmed.objects.map(({ slug, name, description }) => ({
            slug,
            name,
            description,
          })),
        };
      }
    }
    throw error;
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
  const unknownSlugs = [...selectedSlugs].filter(
    (slug) => !pending.objects.some((object) => object.slug === slug),
  );
  if (unknownSlugs.length > 0) {
    throw new ChatServiceError(
      `对象选择不属于这次参考图分析：${unknownSlugs.join("、")}`,
      409,
      "unknown_selected_objects",
    );
  }
  const selected = pending.objects.filter((object) => selectedSlugs.has(object.slug));
  if (selected.length === 0) {
    // 空选择（[] 或全不匹配的 slug）不能静默清空 analysis.json 并消费 run——
    // 完整场景 Workflow / generate-reference-images(mode=plate) 都读 analysis.json，会把它清成空。
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
      confirmation: {
        runId: pending.runId,
        selectedSlugs: selected.map((object) => object.slug),
        allSelected: input.selectedSlugs === undefined,
      },
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

// ---------- Mastra 工具包装 ----------

export const analyzeReferenceTool = createTool({
  id: "analyze-reference",
  description:
    "把本条用户消息明确附带的图片作为完整场景生成的正式参考图，并产出等待用户确认的对象候选（免费，本地落盘，不会再调用另一个 LLM）。你已经能直接看到当前图片：请按实际画面填写场景描述，并把每件可独立拿起、独立建模的原子物品列入 objects；不要把墙、地面、地毯、天空、水面列为对象，也不要把一组家具合并成套装。用户确认后把返回的 runId 和可选 selectedSlugs 直接交给 one-shot-scene Workflow。普通看图、截图排错、设计评价不调用。",
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

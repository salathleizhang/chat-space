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
  CameraEstimateSchema,
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
 * 场景管线的确认入口；完整生成由持久化 SceneJob 执行：
 *
 * - analyze-reference（免费）：Creator 已经在当前多模态消息里看到了参考图，直接
 *   把观察结果作为工具参数交给本地代码校验、落盘，并停在对象确认站。这里不再
 *   嵌套调用第二个 LLM，也不再为一次确认维护 Mastra workflow suspend/resume。
 * - start-scene-job 先确认对象，再将 analysis.json 升格为可修订 SceneSpec；
 * - SceneJob（付费）并行执行「逐对象参考图 → 对应 3D」与「干净底板 →
 *   空环境世界」，支持局部失效和重建。
 *
 * 已有场景确认记录后，仍可用 generate-clean-plate /
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
  /** 相机估计；摆放节点用它把下面每个对象的框反投影成 3D 坐标。 */
  camera: CameraEstimateSchema.optional(),
  objects: z
    .array(
      /**
       * 与 `ObjectCandidateSchema` 同源，只把 slug 换成"LLM 产出、执行层消毒"的可选字符串
       * （见 `sanitizeCandidateSlugs`），这样 box / heightMeters 的类型只有一份定义。
       */
      ObjectCandidateSchema.omit({ slug: true }).extend({
        slug: z.string().optional(),
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
  camera: CameraEstimateSchema.optional(),
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
    // 只替换 slug；box / heightMeters 是摆放的输入，必须原样穿过消毒这一步。
    const { slug: _rawSlug, ...rest } = object;
    return { ...rest, slug };
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
      `The reference image does not belong to the current project or its format is not supported: ${input.image}`,
      400,
      "invalid_reference_image",
    );
  }
  if (!(await storage.exists(input.image))) {
    throw new ChatServiceError(
      `Reference image does not exist: ${input.image}`,
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
      ...(analysis.camera ? { camera: analysis.camera } : {}),
      createdAt: analyzedAt,
    },
  );
  return {
    runId,
    title: `Found ${objects.length} objects that can be generated in "${analysis.sceneName}"`,
    description: "Please confirm which objects to create as 3D assets; unselected objects will not be written to disk.",
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
      `There is no recoverable reference image analysis run "${runId}" (it may not exist or may already have been confirmed; call analyze-reference again)`,
      404,
      "run_not_found",
    );
  }
  const pending = (await storage.list(projectDir(projectSlug)))
    .filter((name) => /^\.analyze-reference-[0-9a-f-]{36}\.json$/i.test(name));
  if (pending.length === 1) return `${projectDir(projectSlug)}/${pending[0]}`;
  throw new ChatServiceError(
    pending.length === 0
      ? "There is no reference image analysis pending confirmation; call analyze-reference again"
      : "The current project has multiple reference image analyses pending confirmation; specify a runId",
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
    // SceneJob 启动成功后会消费临时 run。重试完整场景时，同一 runId 应直接
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
            "This reference image analysis has already started a SceneJob with a different object selection; to change the selection, call analyze-reference again",
            409,
            "confirmation_selection_mismatch",
          );
        }
        return {
          projectSlug,
          // 保留 box / heightMeters：摆放读的就是它们。
          objects: confirmed.objects.map(({ sourceImages: _sources, ...object }) => object),
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
      "The reference image analysis run belongs to another project and cannot be continued in the current project",
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
      `Object selection does not belong to this reference image analysis: ${unknownSlugs.join(", ")}`,
      409,
      "unknown_selected_objects",
    );
  }
  const selected = pending.objects.filter((object) => selectedSlugs.has(object.slug));
  if (selected.length === 0) {
    // 空选择（[] 或全不匹配的 slug）不能静默清空 analysis.json 并消费 run——
    // 完整场景 SceneJob / generate-reference-images(mode=plate) 都读 analysis.json，会把它清成空。
    throw new ChatServiceError(
      "No candidate objects were selected; confirm at least one object",
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
      ...(pending.camera ? { camera: pending.camera } : {}),
      analyzedAt: now,
    });
    return {
      schemaVersion: 1,
      objects: [
        ...previousCandidates.objects,
        ...resolved.map((object) => ({
          ...object,
          sourceImages: [pending.image],
          createdAt: now,
        })),
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
    "Use the image explicitly attached to this user message as the official reference image for full scene generation, and produce object candidates awaiting user confirmation (free, written to disk locally, does not call another LLM). You can already see the current image directly: fill in the scene description according to the actual picture, and list in objects every atomic item that can be picked up and modeled independently; do not list walls, floors, carpets, sky, or water as objects, and do not merge a group of furniture into a set. **Every object must be given a normalized bounding box box=[x0,y0,x1,y1] (origin at top-left, values 0–1, tightly following the object's own outline; do not frame the ground projection, shadows, or neighboring objects), and give the real heightMeters where possible**; objects missing box cannot be automatically placed back into the 3D scene. Also fill in camera according to your observation: horizonRow (the normalized row where the horizon is; 0 is the top of the image; approximately the image centerline when the camera is level), cameraHeightMeters (shooting height; about 1.4–1.6 for a standing handheld shot), verticalFovDeg (vertical field of view; about 55–70 for a phone main camera) — placement relies on these three values to convert pixels into meters. After the user confirms, pass the returned runId and the optional selectedSlugs directly to start-scene-job. Do not call it for ordinary image viewing, screenshot debugging, or design critique.",
  inputSchema: AnalyzeReferenceDraftSchema,
  execute: async (input, context) => {
    if (!referenceAnalysisAllowed(context)) {
      throw new ChatServiceError(
        "This message does not explicitly ask to extract 3D assets from the attached image as a reference image",
        400,
        "reference_analysis_intent_required",
      );
    }
    const images = currentImagePaths(context);
    if (images.length !== 1) {
      throw new ChatServiceError(
        images.length === 0
          ? "This message has no attached image, so reference image asset extraction cannot be started"
          : "This message has multiple attached images; reference image asset extraction currently supports only a single image",
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

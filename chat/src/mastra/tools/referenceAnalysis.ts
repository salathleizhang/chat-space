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
  referenceImagesInPlay,
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
  /**
   * 这次确认复用的是项目里**已经确认过**的场景分析，而不是一份新的待确认分析。
   *
   * 两条真实路径都会走到这里：同一轮中断后的重试（临时文件已被消费），以及新会话
   * 里模型把 runId 弄丢了。旧实现一律报 `run_not_found`，于是模型以为"缺个 runId"、
   * 编一个占位符重试，用户看到的是一次假失败。
   */
  reused?: { runId: string; analyzedAt: string };
}

const NIL_UUID_RE = /^0{8}-0{4}-0{4}-0{4}-0{12}$/i;

/**
 * 把模型给的 runId 归一成"真实的 UUID"或 undefined。
 *
 * runId 是**消歧参数**，不是钥匙：模型在上下文压缩、会话重开之后经常把它弄丢，
 * 丢掉时的典型表现是编一个占位符——实测最常见的是全零 UUID，而 zod 4 的
 * `z.uuid()` 按设计会放它过去（不报错、只是查不到文件）。既然"要确认哪一份分析"
 * 本来就该由服务端从磁盘状态 + 本轮请求上下文决定，这里就把"编错了/没给"
 * 统一当成"没有"，而不是让它变成一次失败。
 */
export function normalizeRunId(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || NIL_UUID_RE.test(trimmed)) return undefined;
  const parsed = z.uuid().safeParse(trimmed);
  return parsed.success ? parsed.data : undefined;
}

interface PendingRun {
  path: string;
  runId: string;
  image: string;
  createdAt: string;
}

/** 项目里所有还没被确认消费掉的 `.analyze-reference-<uuid>.json`（按时间排序）。 */
async function listPendingRuns(projectSlug: string): Promise<PendingRun[]> {
  const storage = getAssetStorage();
  const dir = projectDir(projectSlug);
  const runs: PendingRun[] = [];
  for (const name of await storage.list(dir)) {
    const match = /^\.analyze-reference-([0-9a-f-]{36})\.json$/i.exec(name);
    if (!match?.[1]) continue;
    const runId = match[1];
    try {
      const pending = await readJson(storage, `${dir}/${name}`, PendingReferenceAnalysisSchema);
      runs.push({
        path: `${dir}/${name}`,
        runId,
        image: pending.image,
        createdAt: pending.createdAt,
      });
    } catch {
      // 单份损坏记录不该让其它待确认分析一起不可用（与 listSceneJobs 同款取舍）。
    }
  }
  return runs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function ambiguousPendingRuns(runs: PendingRun[]): ChatServiceError {
  return new ChatServiceError(
    "The current project has multiple reference image analyses pending confirmation; specify a runId. " +
      `Pending: ${runs
        .map((run) => `${run.runId} (${run.image}, analyzed at ${run.createdAt})`)
        .join("; ")}`,
    409,
    "ambiguous_pending_runs",
  );
}

/**
 * 从待确认分析里挑出这次确认该用的那一份。runId 的**精确命中**由调用方先试过
 * （包括"它其实已经被消费、对应已确认分析"那条路），这里只做启发式解析：
 *
 * 1. 先按**本条消息**附带的图片缩小范围（用户重发同一张图是最强的指代）；
 * 2. 再按**本场对话**里出现过的图片；
 * 3. 再看是不是**本会话**创建的分析（`sessionStartedAt` 的口径与"参考图能否
 *    跨会话复用"同源）：本会话新分析出来的那份，就是用户刚在确认的那份；
 * 4. 客户端没带 `sessionStartedAt`（旧客户端）时不做会话判断，回到"只有一份就是它"；
 * 5. 仍然分不清就报错并列出候选——**绝不静默挑一份**，那等于把 A 图的确认套到 B 图上。
 *
 * 返回 undefined = 没有可用作"新确认"的待确认分析（调用方按"复用已确认分析"
 * 或"请重新 analyze-reference"处理，而不是在这里报 run_not_found）。
 */
async function pickPendingRun(
  runs: PendingRun[],
  currentImagePaths: string[],
  conversationImagePaths: string[],
  sessionStartedAt: number | undefined,
): Promise<PendingRun | undefined> {
  if (runs.length === 0) return undefined;
  const narrow = (wanted: Set<string>, candidates: PendingRun[]): PendingRun[] =>
    wanted.size === 0 ? [] : candidates.filter((run) => wanted.has(run.image));

  const byCurrentImage = narrow(new Set(currentImagePaths), runs);
  if (byCurrentImage.length === 1) return byCurrentImage[0];
  if (byCurrentImage.length > 1) throw ambiguousPendingRuns(byCurrentImage);

  const byConversationImage = narrow(new Set(conversationImagePaths), runs);
  if (byConversationImage.length === 1) return byConversationImage[0];
  if (byConversationImage.length > 1) throw ambiguousPendingRuns(byConversationImage);

  if (sessionStartedAt !== undefined) {
    const fromThisSession = runs.filter(
      (run) => Date.parse(run.createdAt) >= sessionStartedAt,
    );
    if (fromThisSession.length === 1) return fromThisSession[0];
    if (fromThisSession.length > 1) throw ambiguousPendingRuns(fromThisSession);
    // 本会话没有新分析：剩下的都是上一会话的遗留，不许自动捡起来当成本次确认
    // （这会直接触发一轮付费生成），交给调用方按"已确认分析"或"请重新分析"处理。
    return undefined;
  }
  if (runs.length === 1) return runs[0];
  throw ambiguousPendingRuns(runs);
}

/**
 * 项目里已经有确认过的场景分析时，按它幂等返回（不需要 runId，也不是错误）。
 *
 * 这是"runId 只是消歧参数"的另一半：确认过一次之后，真正的事实是磁盘上的
 * analysis.json，而不是某条对话里的一个 UUID。
 *
 * `requireRunId` 用于"模型确实带了一个 runId"的情形：只有它正好就是那次确认的
 * runId 时才复用（已经消费掉的 run 再调用一次 = 纯重试）；否则这份已确认分析
 * 可能是另一个场景，不该顶替调用方明确指的那个 run。
 */
async function reusableConfirmation(
  projectSlug: string,
  selectedSlugs: string[] | undefined,
  requireRunId?: string,
): Promise<ConfirmReferenceAssetsResult | undefined> {
  const storage = getAssetStorage();
  const analysisPath = projectAnalysisFile(projectSlug);
  if (!(await storage.exists(analysisPath))) return undefined;
  const confirmed = await readJson(storage, analysisPath, SceneAnalysisSchema);
  const confirmation = confirmed.confirmation;
  if (!confirmation) return undefined;
  if (requireRunId !== undefined && confirmation.runId !== requireRunId) return undefined;
  const requested = selectedSlugs ? new Set(selectedSlugs) : undefined;
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
    reused: { runId: confirmation.runId, analyzedAt: confirmed.analyzedAt },
  };
}

/** 确认对象 → 落盘参考图分析候选；不创建资产，也不生成任何东西。 */
export async function runConfirmReferenceAssets(
  projectSlug: string,
  input: { runId?: string; selectedSlugs?: string[] },
  context: {
    /** 本条消息附带的图片（工具上下文里的 currentImagePaths）。 */
    imagePaths?: string[];
    /** 本场对话里用户附带过的全部图片（conversationImagePaths）。 */
    conversationImagePaths?: string[];
    sessionStartedAt?: number;
  } = {},
): Promise<ConfirmReferenceAssetsResult> {
  const storage = getAssetStorage();
  const requestedRunId = normalizeRunId(input.runId);
  const runs = await listPendingRuns(projectSlug);
  /*
    解析顺序（这是"runId 只是消歧参数"的完整形状）：
    1. runId 精确命中一份待确认分析 → 用它；
    2. runId 命中**已确认分析**的那次 runId（临时文件已被消费）→ 幂等复用，
       无论项目里还躺着多少别的遗留待确认分析——纯重试不该被它们搅成歧义；
    3. 否则按服务端自己看得到的信号挑（图片 / 本会话 / 唯一一份）；
    4. 挑不出来时，只要项目已确认过场景就复用，最后才报"请重新 analyze-reference"。
  */
  const exactPending = requestedRunId === undefined
    ? undefined
    : runs.find((run) => run.runId === requestedRunId);
  if (exactPending === undefined && requestedRunId !== undefined) {
    const reusedByRunId = await reusableConfirmation(
      projectSlug,
      input.selectedSlugs,
      requestedRunId,
    );
    if (reusedByRunId) return reusedByRunId;
  }
  const pendingRun = exactPending ?? await pickPendingRun(
    runs,
    context.imagePaths ?? [],
    context.conversationImagePaths ?? [],
    context.sessionStartedAt,
  );
  if (!pendingRun) {
    // 没有可用的待确认分析：如果这个项目已经确认并升格过一份场景，那真正的事实
    // 就在磁盘上，按它幂等返回即可（中断重试 / 新会话丢了 runId 都走这条路）。
    const reused = await reusableConfirmation(projectSlug, input.selectedSlugs);
    if (reused) return reused;
    /*
      这里是死路的**唯一**出口，所以文案必须能被执行：点名已修复为常驻工具的
      analyze-reference，并说清图片从哪来（本条消息或本场对话）。旧文案只说
      "call analyze-reference again"，而在 2026-10-15 的事故里那个工具恰恰不在
      工具表里——模型于是反复重试同两件事。
    */
    throw new ChatServiceError(
      "There is no reference image analysis pending confirmation in this project" +
        (input.runId ? ` (runId "${input.runId}" does not match one)` : "") +
        "; first call analyze-reference with the reference image (the image attached to this message, or the one the user attached earlier in this conversation), then call start-scene-job again",
      404,
      "run_not_found",
    );
  }
  const pending = await readJson(
    storage,
    pendingRun.path,
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
  await storage.remove(pendingRun.path);
  return { projectSlug, objects: resolved };
}

// ---------- Mastra 工具包装 ----------

/**
 * 工具入参 = 视觉分析草稿 + 一个**可选**的 `image`。
 *
 * `image` 只在"这场对话里有不止一张用户附图"时用来指认（否则由服务端按
 * `referenceImagesInPlay` 解析：本条消息的图，没有就用本场对话里的那张）。少了它，
 * 多图对话里的用户说"用第二张"时模型没有任何字段能把这句话表达出来，又变成一条死路。
 * 它只是指认手段，不是钥匙：路径最终仍由 runAnalyzeReference 校验必须落在本项目 source/。
 */
const AnalyzeReferenceToolInputSchema = AnalyzeReferenceDraftSchema.extend({
  image: LogicalPathSchema.optional(),
});

export const analyzeReferenceTool = createTool({
  id: "analyze-reference",
  description:
    "Use the reference image the user pointed at as the official reference image for full scene generation, and produce object candidates awaiting user confirmation (free, written to disk locally, does not call another LLM). **The image is the one attached to this message, or — when this message carries none — the one the user attached earlier in this conversation; the server resolves that itself, so never ask the user to upload it again, and never pick a file out of the project's source/ directory on your own.** Pass image only to say explicitly which one, and only when the conversation holds several images. You can already see the current image directly: fill in the scene description according to the actual picture, and list in objects every atomic item that can be picked up and modeled independently; do not list walls, floors, carpets, sky, or water as objects, and do not merge a group of furniture into a set. **Every object must be given a normalized bounding box box=[x0,y0,x1,y1] (origin at top-left, values 0–1, tightly following the object's own outline; do not frame the ground projection, shadows, or neighboring objects), and give the real heightMeters where possible**; objects missing box cannot be automatically placed back into the 3D scene. Also fill in camera according to your observation: horizonRow (the normalized row where the horizon is; 0 is the top of the image; approximately the image centerline when the camera is level), cameraHeightMeters (shooting height; about 1.4–1.6 for a standing handheld shot), verticalFovDeg (vertical field of view; about 55–70 for a phone main camera) — placement relies on these three values to convert pixels into meters. After the user confirms, pass the returned runId (if you still have it) and the optional selectedSlugs to start-scene-job; the server can also find this pending analysis by itself, so never invent a runId placeholder. **Only call it when the user asks to extract assets or generate a scene from the image** — for ordinary image viewing, screenshot debugging, or design critique, just answer. Do not call it on an automatic resume turn: there is no new user request in such a turn; report to the user and let them decide.",
  inputSchema: AnalyzeReferenceToolInputSchema,
  execute: async (input, context) => {
    const { image: designatedImage, ...analysis } = input;
    const projectSlug = requireCurrentProject(context);
    const candidates = referenceImagesInPlay(context);
    /*
      图片解析是**唯一**的前置条件（"该不该做"由模型按工具描述与系统提示词判断）。
      解析不出来时错误必须写成"下一步该做什么"：这是可恢复的，不是死路。
    */
    const image =
      designatedImage ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!image) {
      throw new ChatServiceError(
        candidates.length === 0
          ? "There is no image to use as a reference image: this message carries none and the user attached none earlier in this conversation. " +
            "Ask the user to attach the scene photo (or to say which existing image to use) before calling this tool again."
          : `This conversation has more than one image the user attached (${candidates.join(", ")}), and reference asset extraction takes exactly one. ` +
            "Put this on an ask-user card so the user picks one, then pass that image's full path as the image parameter.",
        400,
        "reference_image_required",
      );
    }
    return runAnalyzeReference(projectSlug, { image, analysis });
  },
});

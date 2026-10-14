import { ChatServiceError } from "../../common/errors";
import { pickLatestSourceImage } from "../../common/indexedFiles";
import { projectSourceDir } from "../../common/libraryPaths";
import { RequestSidecarSchema } from "../../dto/library";
import { readJson, type AssetStorage } from "../../services/assetStorage";

/**
 * 参考图的"会话归属"与自动复用纪律。
 *
 * 用户口径（2026-10-02）：**上一轮会话生成的参考图不许自动复用，但看得见；
 * 想复用必须先问过用户。**
 *
 * 为什么要有这条：`source/` 里同时住着用户上传的原始照片（索引最小）和 AI 为各个
 * 对象生成的 3D 参考图（索引最大），而旧的兜底是"取索引最大的那张"
 * （`pickLatestSourceImage`）。于是"没显式指定图片"这个再普通不过的状态，会静默地
 * 把**上一轮会话为别的东西生成的参考图**喂进这次付费生成——界面上什么都看不到，
 * 钱已经花了，而且模型自己都说不清用的是什么（它只被告知"已有参考图，可直接复用"）。
 *
 * 判据是**时间**，不是"这张图在不在项目里"：侧写的 `createdAt` 早于本会话开始时刻的
 * 图，一律要用户点头。时间由客户端随请求带来（`ChatStreamRequest.sessionStartedAt`）
 * ——服务端自己不知道会话边界，`source/` 是项目级目录，没有"这一轮"的概念。
 */

/** 侧写的 `createdAt` 解析不出来时按"不是本轮产物"处理（保守：宁可多问一次）。 */
function sidecarCreatedAtMs(createdAt: string): number | null {
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface SourceReferenceInfo {
  path: string;
  /** 由参考图生成请求落盘的图（有成功侧写）；用户上传的原图没有侧写 */
  generatedAt?: string;
}

/**
 * `source/` 目录里所有可用的图片，附生成时间。给"报错时列清单"用：
 * 模型要被明确告知有哪些图、哪些不能直接用、以及该怎么办。
 */
export async function listSourceReferences(
  storage: AssetStorage,
  projectSlug: string,
): Promise<SourceReferenceInfo[]> {
  const sourceDir = projectSourceDir(projectSlug);
  const names = await storage.list(sourceDir);
  const generatedAtByPath = new Map<string, string>();

  for (const name of names) {
    if (!name.startsWith(".") || !name.endsWith("-request.json")) continue;
    try {
      const sidecar = await readJson(storage, `${sourceDir}/${name}`, RequestSidecarSchema);
      if (sidecar.status !== "succeeded") continue;
      for (const output of sidecar.outputs) {
        generatedAtByPath.set(output.path, sidecar.createdAt);
      }
    } catch {
      // 旧版或损坏的侧写不该让"可复用性"判断整个失败。
    }
  }

  const references: SourceReferenceInfo[] = [];
  for (const name of names) {
    if (!/^\d+-.*\.(?:png|jpe?g|webp)$/i.test(name)) continue;
    const path = `${sourceDir}/${name}`;
    const generatedAt = generatedAtByPath.get(path);
    references.push({ path, ...(generatedAt ? { generatedAt } : {}) });
  }
  // 新→旧：与项目状态的 generatedReferences 同序，模型读到的清单顺序一致。
  return references.sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true }));
}

export interface ReferenceResolutionOptions {
  /**
   * 当前会话开始的时刻（epoch ms）。缺省表示客户端没带这个信息——此时**不**做本轮
   * 判断（保持旧行为），因为"不知道会话边界"不等于"所有图都是上一轮的"：把
   * 同会话的正常复用也挡掉，会让每次生成都多问一轮，得不偿失。
   */
  sessionStartedAt?: number;
  /** 报错文案里用来说清"是谁在要图"（如「Seed3D 图生 3D」） */
  operation?: string;
}

/**
 * 这张参考图能不能在本轮直接自动使用？
 *
 * - 没有生成时间（用户上传的原图）：能——它是用户自己给的输入，不是上一轮的产物；
 * - 生成时间晚于本会话开始：能——本会话刚落盘的图，就是这次要用的那张；
 * - 更早、或时间解析不出来：不能，必须由调用方显式指定并经用户同意。
 */
export function isReferenceReusableInSession(
  reference: SourceReferenceInfo,
  sessionStartedAt: number | undefined,
): boolean {
  if (sessionStartedAt === undefined) return true;
  if (!reference.generatedAt) return true;
  const createdMs = sidecarCreatedAtMs(reference.generatedAt);
  if (createdMs === null) return false;
  return createdMs >= sessionStartedAt;
}

/**
 * 兜底失败时抛的错误。带结构化细节，让 Agent 一眼看到：有哪些图、哪张不能直接用、
 * 下一步该做什么（显式指名 + 先问用户）。
 */
export class ReferenceReuseConsentError extends ChatServiceError {
  constructor(
    message: string,
    readonly availableReferences: SourceReferenceInfo[],
    readonly reusableReferences: string[],
  ) {
    super(message, 409, "reference_reuse_needs_consent");
    this.name = "ReferenceReuseConsentError";
  }
}

/** 清单文案：图 + 是否属本轮，模型据此向用户解释"为什么要问"。 */
function formatAvailable(references: SourceReferenceInfo[]): string {
  if (references.length === 0) return "(there are no images in source/ at all)";
  return references
    .map((reference) => {
      const stamp = reference.generatedAt
        ? `generated at ${reference.generatedAt}`
        : "original image uploaded by the user";
      return `- ${reference.path} (${stamp})`;
    })
    .join("\n");
}

/**
 * 兜底链共享的"该不该自动用这张图"闸门。
 *
 * 返回一个可用的图路径；不可用时抛 `ReferenceReuseConsentError`，把清单交给模型。
 * **不静默降级**：旧行为是"拿最新的就走"，现在宁可不做，也不替用户决定花这笔钱。
 */
export function assertReferenceReusable(
  reference: SourceReferenceInfo,
  available: SourceReferenceInfo[],
  options: ReferenceResolutionOptions,
): void {
  if (isReferenceReusableInSession(reference, options.sessionStartedAt)) return;
  const operation = options.operation ? `${options.operation}: ` : "";
  throw new ReferenceReuseConsentError(
    `${operation}there is no reference image that can be used automatically. ` +
      `By default the most recent one, ${reference.path}, would have been taken, but it is not a product of the current session (it was generated earlier), ` +
      "so by discipline it cannot be reused automatically.\n" +
      "Images currently available in source/:\n" +
      `${formatAvailable(available)}\n` +
      "Next step: if you really need to use one of them, **first use an ask-user card to confirm with the user which one to use** (state clearly which image it is, " +
      "why it is suitable, and what paid operation it will be used for), and only after getting consent call this tool again and pass the image parameter explicitly; " +
      "if this is a new object, use generate-reference-images to generate a new one instead of reusing an old image.",
    available,
    available
      .filter((candidate) => isReferenceReusableInSession(candidate, options.sessionStartedAt))
      .map((candidate) => candidate.path),
  );
}

/**
 * 兜底选图：按优先级 ① 显式 ② 资产身份绑定 ③ 最新源图。
 *
 * 后两档一律过 `assertReferenceReusable` 闸门；显式那一档默认放行（显式传入是"点名"
 * 这个动作本身，调用方已经做过选择），但调用方可以传 `explicitMustBeFresh` 让**存档
 * 里的显式选择**也纳入判定——批量生成那条路就是如此，因为那里的"显式"是历史决定，
 * 不是本轮意图。所以本函数要么返回一张本轮可用的图，要么抛
 * `ReferenceReuseConsentError`，绝不静默拿旧图去付费。
 */
export async function resolveSessionReferenceImage(
  storage: AssetStorage,
  projectSlug: string,
  options: ReferenceResolutionOptions & {
    explicit?: string;
    /** 身份绑定的候选（asset.json 的 sourceImages），按优先级排列 */
    boundCandidates?: string[];
    /**
     * 显式传入的那张图也要按会话判定归属。
     *
     * 默认 **false**：显式传入是"点名"，工具的调用方已经做了选择（用户答复、Agent 的
     * 明确决定），不该再被拦一道。批量生成那条路要传 **true**——那里的"显式"来自
     * 存档的 `object.sourceImages[0]`，是**历史**选择而不是本轮意图：资产绑定的是上一
     * 轮生成的参考图时，它和兜底一样属于"静默复用"。
     */
    explicitMustBeFresh?: boolean;
  },
): Promise<string> {
  const { explicit, boundCandidates = [], explicitMustBeFresh = false } = options;

  if (explicit) {
    if (!(await storage.exists(explicit))) {
      throw new ChatServiceError(`Reference image does not exist: ${explicit}`, 404, "input_image_missing");
    }
    if (explicitMustBeFresh) {
      const available = await listSourceReferences(storage, projectSlug);
      assertReferenceReusable(
        available.find((reference) => reference.path === explicit) ?? { path: explicit },
        available,
        options,
      );
    }
    return explicit;
  }

  const available = await listSourceReferences(storage, projectSlug);
  const byPath = new Map(available.map((reference) => [reference.path, reference]));

  for (const candidate of boundCandidates) {
    if (!(await storage.exists(candidate))) continue;
    const info = byPath.get(candidate) ?? { path: candidate };
    assertReferenceReusable(info, available, options);
    return candidate;
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
  assertReferenceReusable(
    byPath.get(latestPath) ?? { path: latestPath },
    available,
    options,
  );
  return latestPath;
}

/**
 * 给"调用方自己选好了图"的场景用：只判这一张能不能在本轮自动使用。
 *
 * Tripo 是这么用的——它的候选里多了"多视角的 front 视图"，取图顺序与通用兜底不同，
 * 但**归属纪律必须同一套**：不能因为换了取图顺序就绕开闸门。图不存在时报
 * `input_image_missing`（与显式传入同一语义），图存在但属于上一轮则抛同意错误。
 */
export async function assertSelectedReferenceUsable(
  storage: AssetStorage,
  projectSlug: string,
  path: string,
  options: ReferenceResolutionOptions,
): Promise<void> {
  if (!(await storage.exists(path))) {
    throw new ChatServiceError(`Reference image does not exist: ${path}`, 404, "input_image_missing");
  }
  const available = await listSourceReferences(storage, projectSlug);
  const info = available.find((reference) => reference.path === path) ?? { path };
  assertReferenceReusable(info, available, options);
}

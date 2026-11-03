import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  reserveIndex,
} from "../../common/indexedFiles";
import {
  assetIdentityFile,
  projectAnalysisFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
  SlugSchema,
  type ReferenceImageViews,
  type RequestSidecar,
} from "../../dto/library";
import {
  IMAGE_CHANNELS,
  IMAGE_EDIT_MODEL_IDS,
  IMAGE_GENERATE_MODEL_IDS,
  REFERENCE_IMAGE_CANVASES,
  routeImageEditChannel,
  routeImageGenerateChannel,
  runImageEdit,
  runImageGenerate,
  type ImageChannel,
  type ImageProviderKeys,
  type ReferenceImageCanvas,
} from "../../models/images";
import {
  runTripoTask,
  uploadTripoFile,
  waitForTripoTask,
} from "../../models/tripo";
import {
  getAssetStorage,
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { mutateCandidates, readCandidates } from "../../services/candidateRegistry";
import { downloadToLibrary } from "./assetRepair";
import { PlateInputObjectSchema, PlateInputSchema, runPlateGeneration } from "./imageEdit";
import { requireProject } from "./projectTools";
import { listSourceReferences } from "./referenceResolution";
import {
  conversationImagePaths,
  currentImagePaths,
  optionalContextString,
  requireCurrentProject,
} from "./requestContext";

/**
 * 参考图生成能力（配合 start-3d-batch）：既可文生图，也可把资产已有的场景图
 * 通过图生图隔离成 3D 生成用的单物体参考图。产物落盘 source/ 新索引；指定
 * assetSlug 时把参考图绑进该资产的身份（identity.sourceImages），3D 生成缺省
 * 参考图时优先取它。
 *
 * 模型×渠道注册表、按 key 选渠道、按渠道分发调用都下沉到 models/images.ts
 * （与 imageEdit.ts 共用同一套渠道选路，2026-07 迁移，见该文件头注）；
 * 本文件只管参考图特有的业务逻辑：assetSlug 身份绑定、落盘索引与侧写。
 */

export const ReferenceImageParamsSchema = z.object({
  projectSlug: SlugSchema,
  prompt: z.string().min(1),
  model: z.enum(IMAGE_GENERATE_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
  /**
   * 绑定到某个生成目标。目标已存在时更新它；文生单物体参考图时目标不存在也会在
   * 图片成功后登记为待发布候选，让 start-3d-batch 可以直接消费，不需要图片分析。
   */
  assetSlug: SlugSchema.optional(),
  /** 新生成目标的显示名；省略时由 slug 生成人类可读的兜底名。 */
  assetName: z.string().min(1).optional(),
  /** 新生成目标的建模意图；省略时直接使用 prompt。 */
  assetIntent: z.string().min(1).optional(),
  count: z.number().int().min(1).max(4).default(1),
  /** 宽物体默认横版；高瘦物体由 agent 显式改用 portrait，小型近方物体可用 square。 */
  canvas: z.enum(REFERENCE_IMAGE_CANVASES).default("landscape"),
});
export type ReferenceImageParams = z.input<typeof ReferenceImageParamsSchema>;

export interface ReferenceImageResult {
  images: string[];
  sidecar: string;
  channel: ImageChannel;
  target?: { assetSlug: string; name: string; intent: string };
}

interface GenOptions {
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
}

/** 参考图既可绑定已发布资产，也可绑定尚未生成的确认对象。 */
async function readReferenceOwner(
  storage: AssetStorage,
  projectSlug: string,
  slug: string,
): Promise<{ images: string[]; referenceViews?: ReferenceImageViews } | null> {
  const identityPath = assetIdentityFile(projectSlug, slug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    return {
      images: identity.sourceImages,
      ...(identity.referenceViews ? { referenceViews: identity.referenceViews } : {}),
    };
  }
  const candidates = await readCandidates(storage, projectSlug);
  const candidateMatch = candidates.objects.find((object) => object.slug === slug);
  if (candidateMatch) {
    return {
      images: candidateMatch.sourceImages ?? [],
      ...(candidateMatch.referenceViews ? { referenceViews: candidateMatch.referenceViews } : {}),
    };
  }
  const analysisPath = projectAnalysisFile(projectSlug);
  if (!(await storage.exists(analysisPath))) return null;
  const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
  const object = analysis.objects.find((candidate) => candidate.slug === slug);
  if (!object) return null;
  return {
    images: object.sourceImages ?? [],
    ...(object.referenceViews ? { referenceViews: object.referenceViews } : {}),
  };
}

async function bindReferenceImages(
  storage: AssetStorage,
  projectSlug: string,
  slug: string,
  images: string[],
  createTarget?: { name: string; description: string },
  referenceViews?: ReferenceImageViews,
): Promise<void> {
  const identityPath = assetIdentityFile(projectSlug, slug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    const { referenceViews: _oldViews, ...identityWithoutViews } = identity;
    await writeJson(storage, identityPath, AssetIdentitySchema, {
      ...identityWithoutViews,
      sourceImages: images,
      ...(referenceViews ? { referenceViews } : {}),
    });
    return;
  }
  const updated = await mutateCandidates(storage, projectSlug, (candidates) => {
    let found = false;
    const objects = candidates.objects.map((object) => {
      if (object.slug !== slug) return object;
      found = true;
      const { referenceViews: _oldViews, ...objectWithoutViews } = object;
      return {
        ...objectWithoutViews,
        sourceImages: images,
        ...(referenceViews ? { referenceViews } : {}),
      };
    });
    if (!found) return undefined;
    return { ...candidates, objects, updatedAt: new Date().toISOString() };
  });
  if (updated) return;

  const analysisPath = projectAnalysisFile(projectSlug);
  if (await storage.exists(analysisPath)) {
    const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
    let found = false;
    const objects = analysis.objects.map((object) => {
      if (object.slug !== slug) return object;
      found = true;
      const { referenceViews: _oldViews, ...objectWithoutViews } = object;
      return {
        ...objectWithoutViews,
        sourceImages: images,
        ...(referenceViews ? { referenceViews } : {}),
      };
    });
    if (found) {
      await writeJson(storage, analysisPath, SceneAnalysisSchema, { ...analysis, objects });
      return;
    }
  }

  if (!createTarget) {
    throw new ChatServiceError(`Confirmed object "${slug}" does not exist`, 404, "candidate_not_found");
  }
  await mutateCandidates(storage, projectSlug, (candidates) => ({
    ...candidates,
    objects: [
      ...candidates.objects,
      {
        slug,
        ...createTarget,
        sourceImages: images,
        ...(referenceViews ? { referenceViews } : {}),
        // 第一次登记的时刻：新建会话只列本会话登记的目标（见 ConfirmedObjectSchema）
        createdAt: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  }));
}

function fallbackAssetName(slug: string): string {
  return slug.split("-").join(" ");
}

/** 在任何付费请求前挡住会与非模型正式资产撞名的目标。 */
async function assertReferenceTargetWritable(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug?: string,
): Promise<void> {
  if (!assetSlug) return;
  const identityPath = assetIdentityFile(projectSlug, assetSlug);
  if (!(await storage.exists(identityPath))) return;
  const identity = await readJson(storage, identityPath, AssetIdentitySchema);
  if (identity.kind !== "model") {
    throw new ChatServiceError(
      `Target "${assetSlug}" is already occupied by a ${identity.kind} asset; choose a different assetSlug`,
      409,
      "asset_slug_conflict",
    );
  }
}

const CANVAS_WORDING: Record<ReferenceImageCanvas, string> = {
  landscape: "a landscape 4:3 canvas",
  portrait: "a portrait 3:4 canvas",
  square: "a square 1:1 canvas",
};

/**
 * 用户/Agent 负责描述“生成什么”，工具层负责保证“它必须能作为 3D 参考图”。
 * 构图契约放在发送前最后追加，避免不同 Agent、语言和调用渠道各写一套松散规则。
 */
export function composeReferenceImagePrompt(
  prompt: string,
  canvas: ReferenceImageCanvas,
): string {
  return `${prompt.trim()}

MANDATORY 3D ASSET REFERENCE COMPOSITION — these rules override any earlier conflicting framing instructions:
- Show exactly one instance of the requested asset per image.
- The entire object must be fully visible inside the frame, including every outer edge, extremity, support, leg, and base. Nothing may be cut off or extend beyond the canvas.
- Center the object on ${CANVAS_WORDING[canvas]}. Pull the camera back far enough that the object occupies about 60–70% of the canvas, with at least 12–18% clear negative space on every side.
- Use a natural front three-quarter product-reference view with restrained perspective, similar to a 70 mm product lens. Do not use a close-up, macro crop, dramatic wide angle, or edge-to-edge composition.
- Keep the silhouette unobstructed. Do not add unrelated props, people, text, logos, room scenery, or decorative clutter. Keep explicitly requested accessories only when they do not hide the object's structural parts.
- Use a seamless neutral studio background that clearly contrasts with the object, plus soft even lighting and a subtle grounding shadow. No border, collage, split view, or watermark.
- Before finalizing, verify again that the complete object and clear margin are visible on all four sides.`;
}

/**
 * 图生图同样必须产出可直接喂给 3D 的单物体参考图。与文生图不同，这里明确要求
 * 把输入图当作外观证据，隔离目标物体而不是另行设计一个相似物。
 */
export function composeReferenceImageEditPrompt(prompt: string): string {
  return `${prompt.trim()}

MANDATORY IMAGE-TO-IMAGE 3D REFERENCE EXTRACTION — these rules override any earlier conflicting instructions:
- Use the input image as the visual source of truth. Preserve the requested asset's visible shape, colors, materials, proportions, and distinctive details.
- Isolate exactly one instance of the requested asset. Remove every other object, person, scene element, attachment, adjacent duplicate, and item resting on or overlapping the target.
- Reproduce the complete target object on a seamless neutral studio background, centered in a natural front three-quarter product-reference view.
- Keep the entire silhouette visible with clear negative space on every side. Nothing may be cropped, hidden, or extend beyond the canvas.
- Use soft even studio lighting with a subtle grounding shadow. Do not add text, logos, props, scenery, borders, collages, or watermarks.
- Before finalizing, verify that the result contains one clean, unobstructed, fully visible asset faithful to the input image.`;
}

function extFromMime(mimeType?: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function extFromUrl(url: string): string {
  const match = /\.(png|jpe?g|webp)(?:\?|$)/i.exec(url);
  return match ? match[1]!.toLowerCase().replace("jpeg", "jpg") : "png";
}

export async function runReferenceImageGeneration(
  storage: AssetStorage,
  rawParams: ReferenceImageParams,
  keys: ImageProviderKeys,
  options: GenOptions = {},
): Promise<ReferenceImageResult> {
  const params = ReferenceImageParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  await assertReferenceTargetWritable(storage, params.projectSlug, params.assetSlug);
  const route = routeImageGenerateChannel(params.model, keys, params.channel);

  const sourceDir = projectSourceDir(params.projectSlug);
  const slug = params.assetSlug ? `${params.assetSlug}-ref` : "ref";

  const now = () => new Date().toISOString();
  const effectivePrompt = composeReferenceImagePrompt(params.prompt, params.canvas);
  const sidecarFor = (index: number): RequestSidecar => ({
    schemaVersion: 1,
    index,
    slug,
    provider: route.channel,
    model: route.entry.model,
    params: {
      prompt: params.prompt,
      effective_prompt: effectivePrompt,
      model: params.model,
      count: params.count,
      canvas: params.canvas,
      ...(params.assetSlug ? { asset_slug: params.assetSlug } : {}),
      ...(params.assetName ? { asset_name: params.assetName } : {}),
      ...(params.assetIntent ? { asset_intent: params.assetIntent } : {}),
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  });
  /*
    一轮对话里模型会并发发起多张参考图，而不指定 assetSlug 时 slug 固定是 `ref`。
    必须原子占索引，否则这些调用会算出同一个文件名互相覆盖（2026-09 三张图只剩
    一张就是这个原因）；占位内容直接用 queued 侧写，中途崩掉也不会留下半成品。
  */
  const index = await reserveIndex(storage, sourceDir, slug, (candidate) =>
    JSON.stringify(sidecarFor(candidate), null, 2),
  );
  const sidecarPath = `${sourceDir}/${formatRequestSidecarName(index, slug)}`;
  const sidecar = sidecarFor(index);
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      updatedAt: now(),
    });
  await saveSidecar();

  try {
    const { refs } = await runImageGenerate(
      route.channel,
      route.entry,
      { prompt: effectivePrompt, count: params.count, canvas: params.canvas },
      route.apiKey,
      options,
    );
    if (refs.length === 0) {
      throw new ChatServiceError("The generation result contains no image", 502, "imagegen_no_images");
    }

    const images: string[] = [];
    for (const [i, ref] of refs.entries()) {
      const fileSlug = i === 0 ? slug : `${slug}-v${i + 1}`;
      if (ref.url) {
        const path = `${sourceDir}/${formatIndexedName(index, fileSlug, extFromUrl(ref.url))}`;
        // 先记账、再下载：下载失败时侧写里已经留着供应商地址，repair-assets 才能把它补回来。
        // 反过来写（下完再 push）会让「图生成出来了、只是没落盘」变成补无可补，
        // 而错误信息还在让用户去 repair-assets（2026-11-03 实测踩到）。
        sidecar.outputs.push({ path, providerUrl: ref.url });
        await saveSidecar();
        await downloadToLibrary(storage, ref.url, path, { fetchFn: options.fetchFn });
        images.push(path);
      } else if (ref.dataBase64) {
        const path = `${sourceDir}/${formatIndexedName(index, fileSlug, extFromMime(ref.mimeType))}`;
        await storage.writeBytes(path, new Uint8Array(Buffer.from(ref.dataBase64, "base64")));
        images.push(path);
        sidecar.outputs.push({ path });
      }
    }

    // 未发布对象只更新 analysis 候选；绝不为了绑定参考图提前创建资产。
    if (params.assetSlug) {
      await bindReferenceImages(storage, params.projectSlug, params.assetSlug, images, {
        name: params.assetName ?? fallbackAssetName(params.assetSlug),
        description: params.assetIntent ?? params.prompt,
      });
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    return {
      images,
      sidecar: sidecarPath,
      channel: route.channel,
      ...(params.assetSlug
        ? {
            target: {
              assetSlug: params.assetSlug,
              name: params.assetName ?? fallbackAssetName(params.assetSlug),
              intent: params.assetIntent ?? params.prompt,
            },
          }
        : {}),
    };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

// ---------- 单图扩展为标准四视图（Tripo image-to-multiview） ----------

export const MultiviewReferenceImageParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  /** 省略时优先使用该目标已有 front 视图，否则使用第一张有效参考图。 */
  sourceImage: LogicalPathSchema.optional(),
});
export type MultiviewReferenceImageParams = z.input<
  typeof MultiviewReferenceImageParamsSchema
>;

export interface MultiviewReferenceImageResult {
  images: string[];
  referenceViews: Required<ReferenceImageViews>;
  sidecar: string;
  channel: "tripo";
}

const TRIPO_MULTIVIEW_OUTPUTS = [
  ["front", "front_view_url"],
  ["left", "left_view_url"],
  ["back", "back_view_url"],
  ["right", "right_view_url"],
] as const;

/** 从目标的一张干净参考图生成前/左/后/右四视图，并把方位元数据绑定回目标。 */
export async function runReferenceImageMultiview(
  storage: AssetStorage,
  rawParams: MultiviewReferenceImageParams,
  apiKey: string,
  options: GenOptions = {},
): Promise<MultiviewReferenceImageResult> {
  const params = MultiviewReferenceImageParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  await assertReferenceTargetWritable(storage, params.projectSlug, params.assetSlug);
  const owner = await readReferenceOwner(storage, params.projectSlug, params.assetSlug);
  if (!owner) {
    throw new ChatServiceError(
      `Asset or confirmed object "${params.assetSlug}" does not exist; cannot generate multi-view reference images`,
      404,
      "asset_not_found",
    );
  }

  const candidates = [
    params.sourceImage,
    owner.referenceViews?.front,
    ...owner.images,
  ].filter((path): path is string => Boolean(path));
  let sourceImage: string | undefined;
  for (const candidate of candidates) {
    if (await storage.exists(candidate)) {
      sourceImage = candidate;
      break;
    }
  }
  if (!sourceImage) {
    throw new ChatServiceError(
      `Asset "${params.assetSlug}" has no reference image yet; generate one first with generate-reference-images`,
      409,
      "reference_image_missing",
    );
  }

  const sourceDir = projectSourceDir(params.projectSlug);
  const slug = `${params.assetSlug}-ref-multiview`;
  const now = () => new Date().toISOString();
  const sidecarFor = (index: number): RequestSidecar => ({
    schemaVersion: 1,
    index,
    slug,
    provider: "tripo",
    model: "v3/generation/image-to-multiview",
    params: { asset_slug: params.assetSlug, input_image: sourceImage },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  });
  const index = await reserveIndex(storage, sourceDir, slug, (candidate) =>
    JSON.stringify(sidecarFor(candidate), null, 2),
  );
  const sidecarPath = `${sourceDir}/${formatRequestSidecarName(index, slug)}`;
  const sidecar = sidecarFor(index);
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      updatedAt: now(),
    });
  await saveSidecar();

  try {
    const fileToken = await uploadTripoFile(
      sourceImage.split("/").pop()!,
      await storage.readBytes(sourceImage),
      { apiKey, fetchFn: options.fetchFn, pollIntervalMs: options.pollIntervalMs },
    );
    const tripoCall = { apiKey, fetchFn: options.fetchFn, pollIntervalMs: options.pollIntervalMs };
    // 图像生成类目在 Tripo 侧只有 1 个并发槽，必须进闸门（多张参考图会排队而不是撞 429）
    const task = await runTripoTask(
      { path: "/generation/image-to-multiview", body: { input: fileToken } },
      tripoCall,
      async (taskId) => {
        sidecar.providerTaskId = taskId;
        sidecar.status = "running";
        await saveSidecar();
        return await waitForTripoTask(taskId, tripoCall);
      },
    );
    const output = (task.output ?? {}) as Record<string, unknown>;
    const referenceViews: Partial<ReferenceImageViews> = {};
    const images: string[] = [];
    for (const [view, outputKey] of TRIPO_MULTIVIEW_OUTPUTS) {
      const url = output[outputKey];
      if (typeof url !== "string" || !url) {
        throw new ChatServiceError(
          `The Tripo multi-view result is missing ${outputKey}`,
          502,
          "tripo_multiview_incomplete",
        );
      }
      const path = `${sourceDir}/${formatIndexedName(index, `${slug}-${view}`, extFromUrl(url))}`;
      await downloadToLibrary(storage, url, path, { fetchFn: options.fetchFn });
      referenceViews[view] = path;
      images.push(path);
      sidecar.outputs.push({ path, providerUrl: url });
    }

    const completeViews = referenceViews as Required<ReferenceImageViews>;
    await bindReferenceImages(
      storage,
      params.projectSlug,
      params.assetSlug,
      images,
      undefined,
      completeViews,
    );
    sidecar.status = "succeeded";
    await saveSidecar();
    return { images, referenceViews: completeViews, sidecar: sidecarPath, channel: "tripo" };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

// ---------- 编辑参考图（间接编辑 3D 模型：改图 → 重新生成，见 docs 讨论） ----------

/**
 * 编辑资产已有的参考图（图生图）：绝大多数供应商没有"编辑模型"能力，
 * 取巧的办法是编辑生成模型用的参考图，再让用户对该资产重跑 start-3d-batch——
 * 3D 生成本身不动，走的还是"参考图优先级：显式 images > 身份绑定 sourceImages
 * > 最新源图"这条旧路径。产物落盘 source/ 新索引，
 * 且替换 identity.sourceImages（旧参考图/旧模型都留在磁盘上，不覆盖，可回退）。
 */
export const EditReferenceImageParamsSchema = z.object({
  projectSlug: SlugSchema,
  /**
   * 目标资产/待生成对象。**目标不存在时不再是错误**：只要同时给了 sourceImage
   * （或本条消息带了图），就按"新对象 + 这张图"登记一个待生成目标——这条通路
   * 解决的是「从这张照片里把 XX 抠出来做成模型」，而那个 XX 此刻还不是资产。
   */
  assetSlug: SlugSchema,
  prompt: z.string().min(1),
  model: z.enum(IMAGE_EDIT_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
  /**
   * 输入图（库内逻辑路径）。省略时按"目标已有参考图 > 本条消息附带的图"取。
   * 显式给出即"点名"这张图，调用方已经做过选择。
   */
  sourceImage: LogicalPathSchema.optional(),
  /** 目标不存在时用它登记新对象；省略时由 slug 生成兜底名。 */
  assetName: z.string().min(1).optional(),
  /** 目标不存在时用它登记新对象；省略时退回 prompt。 */
  assetIntent: z.string().min(1).optional(),
});
export type EditReferenceImageParams = z.input<typeof EditReferenceImageParamsSchema>;

export interface EditReferenceImageResult {
  image: string;
  sidecar: string;
  channel: ImageChannel;
}

export async function runReferenceImageEdit(
  storage: AssetStorage,
  rawParams: EditReferenceImageParams,
  keys: ImageProviderKeys,
  options: GenOptions = {},
  /** 本条消息附带的图片；只是"显式 > 已有参考图 > 本条附图"这条链的最后一档 */
  currentImages: string[] = [],
): Promise<EditReferenceImageResult> {
  const params = EditReferenceImageParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  // 与非模型正式资产撞名时不能改写它——文生图那条路一直有这道预检，这里补齐。
  // 原先靠"目标必须已有参考图"间接挡住了大部分情况，但 sourceImage 那条新通路
  // （新对象隔离）会绕过它。
  await assertReferenceTargetWritable(storage, params.projectSlug, params.assetSlug);

  const owner = await readReferenceOwner(
    storage,
    params.projectSlug,
    params.assetSlug,
  );

  /*
    输入图优先级：显式 sourceImage > 目标已有参考图 > 本条消息附带的图。

    第三档是为「从这张照片里把 XX 抠出来做成模型」准备的：那个 XX 此刻还不是资产、
    也没有参考图，唯一能用的输入就是用户刚发的那张图。没有它，Agent 只能退回
    mode=generate 照文字重画一个"像"的——保真度全丢，而且花的是另一笔钱。
  */
  const candidateInputs = params.sourceImage
    ? [params.sourceImage]
    : owner
      ? owner.images
      : currentImages;

  if (candidateInputs.length === 0) {
    if (!owner) {
      throw new ChatServiceError(
        `Asset or confirmed object "${params.assetSlug}" does not exist, and this message has no attached image, ` +
          "so the reference image cannot be edited",
        404,
        "asset_not_found",
      );
    }
    throw new ChatServiceError(
      `Asset "${params.assetSlug}" has no reference image yet; generate one first with generate-reference-images`,
      409,
      "reference_image_missing",
    );
  }

  const existingImages: string[] = [];
  for (const image of candidateInputs) {
    if (await storage.exists(image)) existingImages.push(image);
  }
  if (existingImages.length === 0) {
    throw new ChatServiceError(
      `Input image does not exist: ${candidateInputs.join(", ")}`,
      404,
      "input_image_missing",
    );
  }

  const route = routeImageEditChannel(params.model, keys, params.channel);
  const sourceDir = projectSourceDir(params.projectSlug);
  const slug = `${params.assetSlug}-ref`;

  const now = () => new Date().toISOString();
  const effectivePrompt = composeReferenceImageEditPrompt(params.prompt);
  const sidecarFor = (index: number): RequestSidecar => ({
    schemaVersion: 1,
    index,
    slug,
    provider: route.channel,
    model: route.entry.model,
    params: {
      prompt: params.prompt,
      effective_prompt: effectivePrompt,
      model: params.model,
      asset_slug: params.assetSlug,
      input_images: existingImages,
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  });
  // 同一个资产并发编辑也要各占一个索引，理由同文生图
  const index = await reserveIndex(storage, sourceDir, slug, (candidate) =>
    JSON.stringify(sidecarFor(candidate), null, 2),
  );
  const sidecarPath = `${sourceDir}/${formatRequestSidecarName(index, slug)}`;
  const sidecar = sidecarFor(index);
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, { ...sidecar, updatedAt: now() });
  await saveSidecar();

  try {
    const imageUrls: string[] = [];
    for (const image of existingImages) {
      imageUrls.push(await readAsDataUri(storage, image));
    }

    const { refs } = await runImageEdit(
      route.channel,
      route.entry,
      { prompt: effectivePrompt, images: imageUrls },
      route.apiKey,
      options,
    );
    const ref = refs[0];
    if (!ref) {
      throw new ChatServiceError("The image edit result contains no image", 502, "imageedit_no_images");
    }

    let imagePath: string;
    if (ref.url) {
      imagePath = `${sourceDir}/${formatIndexedName(index, slug, extFromUrl(ref.url))}`;
      await downloadToLibrary(storage, ref.url, imagePath, { fetchFn: options.fetchFn });
      sidecar.outputs = [{ path: imagePath, providerUrl: ref.url }];
    } else if (ref.dataBase64) {
      imagePath = `${sourceDir}/${formatIndexedName(index, slug, extFromMime(ref.mimeType))}`;
      await storage.writeBytes(imagePath, new Uint8Array(Buffer.from(ref.dataBase64, "base64")));
      sidecar.outputs = [{ path: imagePath }];
    } else {
      throw new ChatServiceError("The image edit result contains no image", 502, "imageedit_no_images");
    }

    /*
      owner 为空 = 目标是新对象（这条通路就是为它开的）：登记成待生成目标，
      start-3d-batch 才找得到它。已存在的目标照旧只替换它的 sourceImages。
    */
    await bindReferenceImages(
      storage,
      params.projectSlug,
      params.assetSlug,
      [imagePath],
      owner
        ? undefined
        : {
            name: params.assetName ?? fallbackAssetName(params.assetSlug),
            description: params.assetIntent ?? params.prompt,
          },
    );

    sidecar.status = "succeeded";
    await saveSidecar();
    return { image: imagePath, sidecar: sidecarPath, channel: route.channel };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

// ---------- 统一工具入口 + Mastra 包装 ----------

export interface ReferenceProviderKeys extends ImageProviderKeys {
  tripo3dApiKey?: string;
}

function providerKeysFromContext(
  context: Parameters<typeof optionalContextString>[0],
): ReferenceProviderKeys {
  return {
    volcengineApiKey:
      optionalContextString(context, "volcengineApiKey") ??
      optionalContextString(context, "seed3dApiKey"),
    googleApiKey: optionalContextString(context, "googleApiKey"),
    openaiApiKey: optionalContextString(context, "openaiApiKey"),
    openrouterApiKey: optionalContextString(context, "openrouterApiKey"),
    tripo3dApiKey: optionalContextString(context, "tripo3dApiKey"),
  };
}

export const GenerateReferenceImagesInputSchema = z.union([
  ReferenceImageParamsSchema.omit({ projectSlug: true }).extend({
    mode: z.literal("generate").default("generate"),
  }),
  EditReferenceImageParamsSchema.omit({ projectSlug: true }).extend({
    mode: z.literal("edit"),
  }),
  MultiviewReferenceImageParamsSchema.omit({ projectSlug: true }).extend({
    mode: z.literal("multiview"),
  }),
  PlateInputObjectSchema.omit({ projectSlug: true }).extend({
    mode: z.literal("plate"),
    prompt: z.never().optional(),
  }),
]);
export type GenerateReferenceImagesInput = z.input<
  typeof GenerateReferenceImagesInputSchema
>;

/**
 * 部分 OpenAI-compatible 模型会把数组参数再次 JSON 序列化成字符串。
 * 只接受能解成真正数组的字符串；其他值原样交给 Zod 报错，避免把任意文本
 * 静默扩成业务参数。
 */
function parseStringifiedArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * 工具对模型暴露的入参必须是顶层 `type: object`。上面的 union 会被序列化成
 * `{ anyOf: [...] }`，火山方舟的 DeepSeek 接入点会直接拒绝整轮请求：
 * `tools.N.function.parameters must be a JSON Schema of type object`
 * （Doubao 接入点恰好容忍 anyOf，所以只有切到 DeepSeek 才暴露）。
 * 因此工具层把各模式合并成一个扁平对象；分支必填约束仍由上面的 union 在执行层校验。
 */
export const GenerateReferenceImagesToolSchema = z.object({
  mode: z.enum(["generate", "edit", "multiview", "plate"]).default("generate"),
  /** generate/edit 必填；plate 的移除指令由已确认的对象清单自动组装。 */
  prompt: z.string().min(1).optional(),
  model: z.enum(IMAGE_GENERATE_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
  /** mode=generate 时可选绑定目标；mode=edit 时必填。 */
  assetSlug: SlugSchema.optional(),
  assetName: z.string().min(1).optional(),
  assetIntent: z.string().min(1).optional(),
  // DeepSeek 偶尔把 JSON number 输出成 "1"；这里只做 number 的标准安全 coercion。
  count: z.coerce.number().int().min(1).max(4).default(1),
  canvas: z.enum(REFERENCE_IMAGE_CANVASES).default("landscape"),
  /** plate 缺省移除全部已确认对象，使用场景分析绑定的原参考图。 */
  objectSlugs: z.preprocess(
    parseStringifiedArray,
    z.array(SlugSchema).optional(),
  ),
  sourceImage: LogicalPathSchema.optional(),
  extraInstructions: z.string().optional(),
});

/**
 * 参考图落盘那一刻要重申给模型的下一步约束。
 *
 * "参考图与 3D 必须分两次同意"写在系统提示词里，但离决策点太远：模型刚拿到图片
 * 结果时最容易顺手接着调 start-3d-batch。参考图是用户判断方向对不对的唯一依据，
 * 所以在这个工具结果里再钉一次，并说明工作台会把图贴进对话——让"先让用户看图"
 * 这件事在模型的上下文里有具体去处。
 *
 * 最后一句是 2026-10-02 补的：工作台会在图落盘后自动把 Agent 拉起来再问一轮，
 * 所以这一轮不要用正文要用户"回复继续"（实测模型正是这么写的，用户必须手打一句
 * 才有下一步），确认请求留给那张 ask-user 卡片。
 */
const REFERENCE_REVIEW_NOTE =
  "The reference images have been written to disk; the workbench will paste them into the conversation and then automatically wake you up to continue. End this turn now: " +
  "do not call start-3d-batch in the same reply; and do not use the message body to ask the user to \"reply to continue\" or \"tell me whether the direction is right\"" +
  " — anything that requires them to type before progress can continue. In the next turn, use ask-user to hand the images to the user for confirmation, " +
  "and start the 3D generation only after the user agrees.";

/** 各模式归一成 images 数组，方便 SSE 统一展示新图片。 */
export async function runGenerateReferenceImages(
  storage: AssetStorage,
  projectSlug: string,
  rawInput: GenerateReferenceImagesInput,
  keys: ReferenceProviderKeys,
  options: GenOptions = {},
  /** 本条消息附带的图片；只有 mode=edit 会用到，见 runReferenceImageEdit 的取图链 */
  currentImages: string[] = [],
) {
  const input = GenerateReferenceImagesInputSchema.parse(rawInput);
  if (input.mode === "plate") {
    const result = await runPlateGeneration(storage, { ...input, projectSlug }, keys, options);
    return {
      mode: "plate" as const,
      images: [result.output],
      sidecar: result.sidecar,
    };
  }
  if (input.mode === "edit") {
    const result = await runReferenceImageEdit(
      storage,
      { ...input, projectSlug },
      keys,
      options,
      currentImages,
    );
    return {
      mode: "edit" as const,
      images: [result.image],
      sidecar: result.sidecar,
      channel: result.channel,
      note: REFERENCE_REVIEW_NOTE,
    };
  }
  if (input.mode === "multiview") {
    if (!keys.tripo3dApiKey) {
      throw new ChatServiceError(
        "TRIPO_KEY is not configured in the local chat/.env",
        409,
        "provider_key_missing",
      );
    }
    const result = await runReferenceImageMultiview(
      storage,
      { ...input, projectSlug },
      keys.tripo3dApiKey,
      options,
    );
    return { mode: "multiview" as const, note: REFERENCE_REVIEW_NOTE, ...result };
  }

  const result = await runReferenceImageGeneration(
    storage,
    { ...input, projectSlug },
    keys,
    options,
  );
  return { mode: "generate" as const, note: REFERENCE_REVIEW_NOTE, ...result };
}

export const generateReferenceImagesTool = createTool({
  id: "generate-reference-images",
  description:
    "Unified entry point for reference image generation (paid operation — get the user's consent before calling). mode=generate is text-to-single-object reference image generation and requires prompt; to continue on to 3D generation pass assetSlug, optionally with assetName/assetIntent. mode=edit is image-to-image: it both edits a target's existing reference image and can isolate a user-uploaded scene photo into a new single-object reference image (in that case give assetSlug as the new object's slug, and if sourceImage is omitted the image attached to this message is used; a nonexistent target is registered as well). mode=multiview uses Tripo to expand a target's existing clean reference image into front/left/back/right four views. mode=plate exists only for backward compatibility with old calls; new standalone plate requests should use generate-clean-plate, and a full scene should use start-scene-job. **Do not use this tool in two cases**: ① the image the user uploaded is itself a clean single-object photo; ② **the user explicitly said not to generate a reference image, or asked to use the image they gave directly** — the latter is their decision, not a technical choice; instead use the free attach-source-image to register the original image, and write the risks (composition, background, camera angle, back-side information) into an ask-user card for them to decide, and do not substitute generating one first.",
  inputSchema: GenerateReferenceImagesToolSchema,
  execute: async (input, context) =>
    runGenerateReferenceImages(
      getAssetStorage(),
      requireCurrentProject(context),
      GenerateReferenceImagesInputSchema.parse(input),
      providerKeysFromContext(context),
      {},
      currentImagePaths(context),
    ),
});

// ---------- 把用户上传的原图直接登记为参考图（免费，不调用任何供应商） ----------

/**
 * 为什么需要这条通路。
 *
 * 现在的默认链路是"文生单物体 → generate-reference-images → start-3d-batch"：参考图
 * 是**生成出来**的。但用户直接上传一张照片说「把这个做成 3D 模型」时，这张照片本身
 * 就是参考图——再花钱画一张不仅多一笔费用，还会把用户真实物体的细节换成模型想象出来
 * 的版本。而在此之前这条路根本走不通：`start-3d-batch` 没有 image 参数，图只能来自
 * 资产身份 `sourceImages[0]`（见 seed3dOps/ark3dOps/tripoOps 三处），而把一张上传图
 * 绑定到某个 slug 的唯一入口是 `generate-reference-images` —— 那个工具一定要生成新图。
 *
 * 所以本工具只做一件事：**把已经存在的那张用户原图绑上去**。免费、本地、不需要付费
 * 同意（不碰任何供应商）。绑定之后 `start-3d-batch` 靠已有的 `sourceImages[0]` 通路
 * 直接消费它，一行生成代码都不用改。
 *
 * 只吃"用户上传的原图"是刻意的：`listSourceReferences` 用请求侧写区分二者，有成功侧写
 * 的是 AI 产物、没有的是用户原图。而"用户原图可以跨会话复用"本来就是既有口径
 * （`isReferenceReusableInSession`：没有 generatedAt 一律放行，见 referenceResolution.ts），
 * 所以这里放行老上传图与之一致；AI 产物则必须回到既有那条需要用户点头的复用路径上去。
 */

/**
 * 部分 OpenAI 兼容模型会把"我没这个参数"输出成字符串 `"null"` 或 `"undefined"`。
 *
 * 2026-10-05 实测：模型调 attach-source-image 时传了 `image: "null"`，Zod 的
 * `.optional()` 拦不住（它收到的是一个合法字符串），于是被当成一个图路径去做扩展名
 * 校验，报出「不是支持的图片格式（png/jpg/webp）：null」——错误信息指向格式，而真正的
 * 问题是"参数不该有这个值"。所以在这里归一成"没传"：调用方要的行为本来就是省略。
 *
 * `assetSlug` 也要过这一关：slug 允许纯小写字母，`"null"` 是个**合法 slug**，
 * 不挡就会凭空建出一个叫 null 的资产。
 */
function nullishToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return /^(null|undefined|none|nil)$/i.test(trimmed) ? undefined : value;
}

const OptionalSlugInput = z.preprocess(nullishToUndefined, SlugSchema.optional());
const OptionalTextInput = z.preprocess(nullishToUndefined, z.string().min(1).optional());

export const AttachSourceImageParamsSchema = z.object({
  projectSlug: SlugSchema,
  /**
   * 要绑定的图（库内逻辑路径）。省略时服务端按"本条消息附带的 > 整场对话里唯一的一张"
   * 自己取——**推荐省略**，模型不需要（也往往不知道）这个路径。
   * 显式给出时必须落在本项目 `source/` 里、且是用户原图（不是 AI 产物）。
   */
  image: z.preprocess(nullishToUndefined, LogicalPathSchema.optional()),
  /**
   * 省略 = 只确认这张图可用，不登记任何目标；那样 `start-3d-batch` 找不到它，
   * 所以正常调用都要带上。
   */
  assetSlug: OptionalSlugInput,
  assetName: OptionalTextInput,
  assetIntent: OptionalTextInput,
});
export type AttachSourceImageParams = z.input<typeof AttachSourceImageParamsSchema>;

export interface AttachSourceImageResult {
  image: string;
  target?: { assetSlug: string; name: string; intent: string };
  note: string;
}

/** 绑定成功后的下一步：与参考图那条一样，先取付费同意，不要顺手接着调 3D。 */
const ATTACH_NOTE =
  "The user-uploaded original image has been registered as the reference image: no provider was called and no cost was incurred. " +
  "Next, call start-3d-batch with **the same assetSlug**; before starting, follow the discipline and get paid-operation consent with ask-user, " +
  "and state in the card that the user-uploaded original image will be used directly (no new reference image will be generated).";

/** 没有 assetSlug 时绑定无处可挂——必须说清后果，否则 Agent 会以为已经就绪。 */
const ATTACH_UNBOUND_NOTE =
  "This image is usable, but it is not bound to any generation target: start-3d-batch cannot find it. " +
  "Call this tool again with assetSlug (giving assetName/assetIntent as well is recommended).";

/**
 * 解析"要绑定哪张图"。
 *
 * 优先级：① 显式 `image` ② 本条消息附带的图（恰好一张）③ 整场对话里唯一的一张用户附图。
 *
 * ②③ 由**服务端**从请求里取，所以模型既不用知道路径、也指不了别的历史文件。加 ③ 是因为
 * 用户的指代是"我发你的那张"而不是"这一条消息里的那张"：他常常先发图，再单独补一句
 * 「不要生成参考图，直接用我发你的这张」——那条消息本身没有图，2026-10-05 实测工具因此
 * 报"本条消息没有附带图片"，模型转而去猜路径（`"null"`、裸文件名、`source/` 前缀，全错）。
 *
 * 显式路径要求落在本项目 `source/` 内且没有成功侧写（= 用户原图）。
 */
export async function resolveAttachImage(
  storage: AssetStorage,
  projectSlug: string,
  explicit: string | undefined,
  currentImages: string[],
  conversationImages: string[] = [],
): Promise<string> {
  if (!explicit) {
    // 本条消息附带的优先（他刚发的就是他要说的），本条没带才落到整场对话。
    const candidates = currentImages.length > 0 ? currentImages : conversationImages;
    if (candidates.length === 0) {
      throw new ChatServiceError(
        "There are no user-attached images in this conversation yet, so the original image cannot be used as a reference image; " +
          "ask the user to resend the image, or generate one with generate-reference-images",
        400,
        "input_image_missing",
      );
    }
    if (candidates.length > 1) {
      throw new ChatServiceError(
        `The user attached ${candidates.length} images in this conversation; use the image parameter to name which one to use: ` +
          `${candidates.join(", ")}`,
        400,
        "input_image_ambiguous",
      );
    }
    return candidates[0]!;
  }

  /*
    两条"路径不对"的错误都带上这场对话的真实路径。模型最可能的错法就是自己拼路径
    （2026-10-05 实测：裸文件名与 `source/` 前缀两种写法各试了一次），把正确答案
    摆在错误旁边，它下一轮就不用再猜。
  */
  const pathHint =
    conversationImages.length > 0
      ? `. The images in this conversation are: ${conversationImages.join(", ")}`
      : "";
  const sourceDir = projectSourceDir(projectSlug);
  if (!explicit.startsWith(`${sourceDir}/`)) {
    throw new ChatServiceError(
      `You can only bind a source image from this project's source/ directory: ${explicit}${pathHint}`,
      400,
      "not_a_project_source",
    );
  }
  /*
    一次 listSourceReferences 同时回答两个问题：这张图在不在、以及它是不是用户上传的
    原图（有成功侧写 = AI 产物）。原先还叠了"扩展名"与"文件是否存在"两道各自独立的
    预检，但 source/ 里的图本来就只可能是上传时的 png/jpg/webp 或生成的产物，两道都
    只是更早地报出一个更差的错。
  */
  const references = await listSourceReferences(storage, projectSlug);
  const found = references.find((reference) => reference.path === explicit);
  if (!found) {
    throw new ChatServiceError(
      `Reference image does not exist: ${explicit}. Use the full logical path of the user-uploaded image exactly as given${pathHint}`,
      404,
      "input_image_missing",
    );
  }
  if (found.generatedAt) {
    throw new ChatServiceError(
      `attach-source-image can only bind user-uploaded original images, but this one is an AI-generated/edited product (${found.generatedAt}): ` +
        `${explicit}. To reuse it, pass the target asset's assetSlug to start-3d-batch and follow that existing reuse path.`,
      409,
      "attach_requires_user_original",
    );
  }
  return explicit;
}

export async function runAttachSourceImage(
  storage: AssetStorage,
  rawParams: AttachSourceImageParams,
  currentImages: string[] = [],
  conversationImages: string[] = [],
): Promise<AttachSourceImageResult> {
  const params = AttachSourceImageParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  // 优先级只由 resolveAttachImage 一处决定，调用方不要自己再挑一遍。
  const image = await resolveAttachImage(
    storage,
    params.projectSlug,
    params.image,
    currentImages,
    conversationImages,
  );

  if (!params.assetSlug) return { image, note: ATTACH_UNBOUND_NOTE };

  // 与非模型正式资产撞名时不能悄悄改写它——与文生图那条预检同一口径。
  await assertReferenceTargetWritable(storage, params.projectSlug, params.assetSlug);
  /*
    目标已经是资产时**只换 sourceImages，不动它的名字与意图**（`bindReferenceImages`
    就是这么写的）。所以回执里要报资产自己的 name/intent，不能报我们按 slug 编的兜底名
    ——否则 Agent 会把"victorian playhouse"这种 slug 变形当成资产真名讲给用户听。
  */
  const identityPath = assetIdentityFile(params.projectSlug, params.assetSlug);
  const existing = (await storage.exists(identityPath))
    ? await readJson(storage, identityPath, AssetIdentitySchema)
    : null;
  const name = existing?.name ?? params.assetName ?? fallbackAssetName(params.assetSlug);
  const intent = existing?.intent ?? params.assetIntent ?? name;
  await bindReferenceImages(storage, params.projectSlug, params.assetSlug, [image], {
    name,
    description: intent,
  });
  return {
    image,
    target: { assetSlug: params.assetSlug, name, intent },
    note: ATTACH_NOTE,
  };
}

export const attachSourceImageTool = createTool({
  id: "attach-source-image",
  description:
    "Register the **user-uploaded original image** directly as the reference image for 3D generation — free, local, calls no provider, and **does not need user consent**. " +
    "Use it for requests like \"make this/that photo into a 3D model\" when the user has sent an image in this conversation: the image is already input the user gave, " +
    "so do not spend money generating another reference image. **When the user explicitly says not to generate a reference image, or asks to use the image they gave directly, this tool is the only correct landing point for their decision — do it, and do not switch to generating one first.**" +
    "**Omit the image parameter entirely**: the server picks it itself (the image attached to this message; if this message has none, the single one in the whole conversation). " +
    "When the user sends an image first and then adds \"just use the one I sent you\", likewise omit image; do **not** pass the string \"null\", and do **not** build a `source/` prefix or a bare filename yourself — guessing the path wrong only wastes a turn. " +
    "Only user-uploaded original images are accepted; AI-generated or AI-edited reference images are rejected (those go through start-3d-batch's existing reuse path). " +
    "Only when assetSlug is passed is it registered as a pending generation target, so that start-3d-batch can recognize it; if the target is already an asset, just use its slug, and give assetName and assetIntent at the same time if possible. " +
    "This tool incurs no cost, but the 3D generation after calling it still requires paid-operation consent via ask-user first, and \"using the original image you uploaded directly\" plus its risks must be written into the card for the user to decide. " +
    "**Note**: when the image model selected in the user interface is ShuMei Hi3D, this path does not work (it only accepts the public URL of a Seedream product), so switch to mode=edit/generate first.",
  inputSchema: AttachSourceImageParamsSchema.omit({ projectSlug: true }),
  execute: async (input, context) =>
    runAttachSourceImage(
      getAssetStorage(),
      { ...input, projectSlug: requireCurrentProject(context) },
      currentImagePaths(context),
      conversationImagePaths(context),
    ),
});

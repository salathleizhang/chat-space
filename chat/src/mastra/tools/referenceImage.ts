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
import { optionalContextString, requireCurrentProject } from "./requestContext";

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
    throw new ChatServiceError(`确认对象「${slug}」不存在`, 404, "candidate_not_found");
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
      `目标「${assetSlug}」已被 ${identity.kind} 资产占用，请换一个 assetSlug`,
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
      throw new ChatServiceError("生成结果中没有图片", 502, "imagegen_no_images");
    }

    const images: string[] = [];
    for (const [i, ref] of refs.entries()) {
      const fileSlug = i === 0 ? slug : `${slug}-v${i + 1}`;
      if (ref.url) {
        const path = `${sourceDir}/${formatIndexedName(index, fileSlug, extFromUrl(ref.url))}`;
        await downloadToLibrary(storage, ref.url, path, { fetchFn: options.fetchFn });
        images.push(path);
        sidecar.outputs.push({ path, providerUrl: ref.url });
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
      `资产或确认对象「${params.assetSlug}」不存在，无法生成多角度参考图`,
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
      `资产「${params.assetSlug}」还没有参考图，请先用 generate-reference-images 生成`,
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
          `Tripo 多角度结果缺少 ${outputKey}`,
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
  assetSlug: SlugSchema,
  prompt: z.string().min(1),
  model: z.enum(IMAGE_EDIT_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
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
): Promise<EditReferenceImageResult> {
  const params = EditReferenceImageParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);

  const owner = await readReferenceOwner(
    storage,
    params.projectSlug,
    params.assetSlug,
  );
  if (!owner) {
    throw new ChatServiceError(
      `资产或确认对象「${params.assetSlug}」不存在，无法编辑参考图`,
      404,
      "asset_not_found",
    );
  }
  const existingImages: string[] = [];
  for (const image of owner.images) {
    if (await storage.exists(image)) existingImages.push(image);
  }
  if (existingImages.length === 0) {
    throw new ChatServiceError(
      `资产「${params.assetSlug}」还没有参考图，请先用 generate-reference-images 生成`,
      409,
      "reference_image_missing",
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
      throw new ChatServiceError("图片编辑结果中没有图片", 502, "imageedit_no_images");
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
      throw new ChatServiceError("图片编辑结果中没有图片", 502, "imageedit_no_images");
    }

    await bindReferenceImages(storage, params.projectSlug, params.assetSlug, [imagePath]);

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
  "参考图已落盘，工作台会把它们贴进对话，并随后自动把你拉起来继续。现在结束这一轮：" +
  "不要在同一条回复里调用 start-3d-batch；也不要用正文要用户「回复继续」「告诉我方向对不对」" +
  "这类需要他打字才能往下走的话——下一轮用 ask-user 把图交给用户确认，" +
  "用户同意后再启动 3D 生成。";

/** 各模式归一成 images 数组，方便 SSE 统一展示新图片。 */
export async function runGenerateReferenceImages(
  storage: AssetStorage,
  projectSlug: string,
  rawInput: GenerateReferenceImagesInput,
  keys: ReferenceProviderKeys,
  options: GenOptions = {},
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
        "本机 chat/.env 未配置 TRIPO_KEY",
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
    "统一参考图生成入口（付费操作——调用前须经用户同意）。mode=generate 是文生单物体参考图，需要 prompt；要继续生成 3D 时传 assetSlug，可附 assetName/assetIntent。mode=edit 是图生图编辑资产参考图。mode=multiview 使用 Tripo 把目标已有的一张干净参考图扩展为前/左/后/右四视图。mode=plate 仅为旧调用兼容；新的独立底板请求使用 generate-clean-plate，完整场景用 start-scene-job。",
  inputSchema: GenerateReferenceImagesToolSchema,
  execute: async (input, context) =>
    runGenerateReferenceImages(
      getAssetStorage(),
      requireCurrentProject(context),
      GenerateReferenceImagesInputSchema.parse(input),
      providerKeysFromContext(context),
    ),
});

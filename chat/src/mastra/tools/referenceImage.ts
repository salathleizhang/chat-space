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
  RequestSidecarSchema,
  SceneAnalysisSchema,
  SlugSchema,
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
  getAssetStorage,
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { mutateCandidates, readCandidates } from "../../services/candidateRegistry";
import { downloadToLibrary } from "./assetRepair";
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
async function readReferenceOwnerImages(
  storage: AssetStorage,
  projectSlug: string,
  slug: string,
): Promise<string[] | null> {
  const identityPath = assetIdentityFile(projectSlug, slug);
  if (await storage.exists(identityPath)) {
    return (await readJson(storage, identityPath, AssetIdentitySchema)).sourceImages;
  }
  const candidates = await readCandidates(storage, projectSlug);
  const candidateMatch = candidates.objects.find((object) => object.slug === slug);
  if (candidateMatch) return candidateMatch.sourceImages ?? null;
  const analysisPath = projectAnalysisFile(projectSlug);
  if (!(await storage.exists(analysisPath))) return null;
  const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);
  return analysis.objects.find((object) => object.slug === slug)?.sourceImages ?? null;
}

async function bindReferenceImages(
  storage: AssetStorage,
  projectSlug: string,
  slug: string,
  images: string[],
  createTarget?: { name: string; description: string },
): Promise<void> {
  const identityPath = assetIdentityFile(projectSlug, slug);
  if (await storage.exists(identityPath)) {
    const identity = await readJson(storage, identityPath, AssetIdentitySchema);
    await writeJson(storage, identityPath, AssetIdentitySchema, { ...identity, sourceImages: images });
    return;
  }
  const updated = await mutateCandidates(storage, projectSlug, (candidates) => {
    let found = false;
    const objects = candidates.objects.map((object) => {
      if (object.slug !== slug) return object;
      found = true;
      return { ...object, sourceImages: images };
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
      return { ...object, sourceImages: images };
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
    objects: [...candidates.objects, { slug, ...createTarget, sourceImages: images }],
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
    const { refs, providerTaskId } = await runImageGenerate(
      route.channel,
      route.entry,
      { prompt: effectivePrompt, count: params.count, canvas: params.canvas },
      route.apiKey,
      {
        ...options,
        // fal 渠道提交后立即落盘 requestId：轮询中途崩溃也能凭侧写续跑，不重复扣费。
        onSubmitted: async (requestId) => {
          sidecar.providerTaskId = requestId;
          sidecar.status = "running";
          await saveSidecar();
        },
      },
    );
    if (providerTaskId) sidecar.providerTaskId = providerTaskId;
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

// ---------- 编辑参考图（间接编辑 3D 模型：改图 → 重新生成，见 docs 讨论） ----------

/**
 * 编辑资产已有的参考图（图生图）：绝大多数供应商没有"编辑模型"能力，
 * 取巧的办法是编辑生成模型用的参考图，再让用户对该资产重跑 start-3d-batch——
 * 3D 生成本身不动，走的还是"参考图优先级：显式 images > 身份绑定 sourceImages
 * > 最新源图"这条老路径（fal3d.ts resolveImages）。产物落盘 source/ 新索引，
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

  const ownerImages = await readReferenceOwnerImages(
    storage,
    params.projectSlug,
    params.assetSlug,
  );
  if (!ownerImages) {
    throw new ChatServiceError(
      `资产或确认对象「${params.assetSlug}」不存在，无法编辑参考图`,
      404,
      "asset_not_found",
    );
  }
  const existingImages: string[] = [];
  for (const image of ownerImages) {
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

    const { refs, providerTaskId } = await runImageEdit(
      route.channel,
      route.entry,
      { prompt: effectivePrompt, images: imageUrls },
      route.apiKey,
      {
        ...options,
        // fal 渠道提交后立即落盘 requestId：轮询中途崩溃也能凭侧写续跑，不重复扣费。
        onSubmitted: async (requestId) => {
          sidecar.providerTaskId = requestId;
          sidecar.status = "running";
          await saveSidecar();
        },
      },
    );
    if (providerTaskId) sidecar.providerTaskId = providerTaskId;
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

function providerKeysFromContext(context: Parameters<typeof optionalContextString>[0]): ImageProviderKeys {
  return {
    falApiKey: optionalContextString(context, "falApiKey"),
    volcengineApiKey:
      optionalContextString(context, "volcengineApiKey") ??
      optionalContextString(context, "seed3dApiKey"),
    googleApiKey: optionalContextString(context, "googleApiKey"),
    openaiApiKey: optionalContextString(context, "openaiApiKey"),
    openrouterApiKey: optionalContextString(context, "openrouterApiKey"),
  };
}

export const GenerateReferenceImagesInputSchema = z.union([
  ReferenceImageParamsSchema.omit({ projectSlug: true }).extend({
    mode: z.literal("generate").default("generate"),
  }),
  EditReferenceImageParamsSchema.omit({ projectSlug: true }).extend({
    mode: z.literal("edit"),
  }),
]);
export type GenerateReferenceImagesInput = z.input<
  typeof GenerateReferenceImagesInputSchema
>;

/**
 * 工具对模型暴露的入参必须是顶层 `type: object`。上面的 union 会被序列化成
 * `{ anyOf: [...] }`，火山方舟的 DeepSeek 接入点会直接拒绝整轮请求：
 * `tools.N.function.parameters must be a JSON Schema of type object`
 * （Doubao 接入点恰好容忍 anyOf，所以只有切到 DeepSeek 才暴露）。
 * 因此工具层把 generate/edit 合并成一个扁平对象；分支必填约束仍由上面的
 * union 在执行层校验，模型看到的字段与两种模式的实际入参保持一致。
 */
export const GenerateReferenceImagesToolSchema = z.object({
  mode: z.enum(["generate", "edit"]).default("generate"),
  prompt: z.string().min(1),
  model: z.enum(IMAGE_GENERATE_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
  /** mode=generate 时可选绑定目标；mode=edit 时必填。 */
  assetSlug: SlugSchema.optional(),
  assetName: z.string().min(1).optional(),
  assetIntent: z.string().min(1).optional(),
  count: z.number().int().min(1).max(4).default(1),
  canvas: z.enum(REFERENCE_IMAGE_CANVASES).default("landscape"),
});

/** generate/edit 两种模式归一成同一返回形状，方便 SSE 统一展示新参考图。 */
export async function runGenerateReferenceImages(
  storage: AssetStorage,
  projectSlug: string,
  rawInput: GenerateReferenceImagesInput,
  keys: ImageProviderKeys,
  options: GenOptions = {},
) {
  const input = GenerateReferenceImagesInputSchema.parse(rawInput);
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
    };
  }

  const result = await runReferenceImageGeneration(
    storage,
    { ...input, projectSlug },
    keys,
    options,
  );
  return { mode: "generate" as const, ...result };
}

export const generateReferenceImagesTool = createTool({
  id: "generate-reference-images",
  description:
    "生成 3D 用的单物体参考图（付费操作——调用前须经用户同意）。mode=generate 是文生图，默认火山 Seedream；要继续生成 3D 时必须传 assetSlug，并可传 assetName/assetIntent：图片成功后会自动登记待发布生成目标并绑定图片，紧接着用同一 assetSlug 调 start-3d-batch。mode=edit 使用火山 Seedream 图生图，要求已存在的 assetSlug，读取现有 sourceImages 隔离物体或修改外观。工具层强制完整入镜、四周留白、无遮挡。",
  inputSchema: GenerateReferenceImagesToolSchema,
  execute: async (input, context) =>
    runGenerateReferenceImages(
      getAssetStorage(),
      requireCurrentProject(context),
      GenerateReferenceImagesInputSchema.parse(input),
      providerKeysFromContext(context),
    ),
});

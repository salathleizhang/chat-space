import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  pickLatestSourceImage,
} from "../../common/indexedFiles";
import { projectAnalysisFile, projectSourceDir } from "../../common/libraryPaths";
import {
  LogicalPathSchema,
  RequestSidecarSchema,
  SceneAnalysisSchema,
  SlugSchema,
  type ObjectCandidate,
  type RequestSidecar,
} from "../../dto/library";
import {
  IMAGE_CHANNELS,
  IMAGE_EDIT_MODEL_IDS,
  routeImageEditChannel,
  runImageEdit,
  type ImageProviderKeys,
} from "../../models/images";
import {
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { downloadToLibrary } from "./assetRepair";
import { requireProject } from "./projectTools";

/**
 * 图片编辑能力（img2img）：给定库内输入图 + 指令，产出编辑后的新图，落盘 source/
 * 新索引 + 侧写。模型×渠道选路、按渠道分发调用都下沉到 models/images.ts
 * （2026-07 迁移，原来只有 fal 一个渠道，现覆盖 fal/google/openrouter）；
 * 本文件只管编辑特有的业务逻辑：输入图存在性校验 + plate 特化（读场景分析→
 * 合成"只删不补"移除 prompt→最新源图）。仍是场景级能力，服务 one-shot 管线的
 * world 生成前置步骤，跟资产级的参考图编辑（referenceImage.ts）不是一回事，
 * 见该文件头注。
 */

export const ImageEditParamsSchema = z.object({
  projectSlug: SlugSchema,
  /** 库内输入图（逻辑路径），以 data URI 送入模型 */
  images: z.array(LogicalPathSchema).min(1),
  prompt: z.string().min(1),
  /** plate = 干净底板（只删不补）；edit = 通用编辑。产物都是新的源图索引 */
  role: z.enum(["edit", "plate"]).default("edit"),
  outputSlug: SlugSchema.optional(),
  model: z.enum(IMAGE_EDIT_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
  resolution: z.string().default("1K"),
  aspectRatio: z.string().default("auto"),
  outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
  seed: z.number().int().optional(),
});
export type ImageEditParams = z.infer<typeof ImageEditParamsSchema>;
export type ImageEditParamsInput = z.input<typeof ImageEditParamsSchema>;

export interface ImageEditResult {
  output: string;
  sidecar: string;
  requestId?: string;
}

interface GenOptions {
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
}

/** 图片编辑：生成 → 落盘 → 侧写，磁盘不齐不算成功 */
export async function runFalImageEdit(
  storage: AssetStorage,
  rawParams: ImageEditParamsInput,
  keys: ImageProviderKeys,
  options: GenOptions = {},
): Promise<ImageEditResult> {
  const params = ImageEditParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  for (const image of params.images) {
    if (!(await storage.exists(image))) {
      throw new ChatServiceError(`输入图不存在：${image}`, 404, "input_image_missing");
    }
  }

  const route = routeImageEditChannel(params.model, keys, params.channel);
  const sourceDir = projectSourceDir(params.projectSlug);
  const slug = params.outputSlug ?? params.role;
  const index = nextIndex(await storage.list(sourceDir));
  const outputPath = `${sourceDir}/${formatIndexedName(index, slug, params.outputFormat)}`;
  const sidecarPath = `${sourceDir}/${formatRequestSidecarName(index, slug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug,
    provider: route.channel,
    model: route.entry.model,
    params: {
      prompt: params.prompt,
      role: params.role,
      input_images: params.images,
      resolution: params.resolution,
      aspect_ratio: params.aspectRatio,
      output_format: params.outputFormat,
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, { ...sidecar, updatedAt: now() });
  await saveSidecar();

  try {
    const imageUrls: string[] = [];
    for (const image of params.images) {
      imageUrls.push(await readAsDataUri(storage, image));
    }

    const { refs, providerTaskId } = await runImageEdit(
      route.channel,
      route.entry,
      {
        prompt: params.prompt,
        images: imageUrls,
        resolution: params.resolution,
        aspectRatio: params.aspectRatio,
        outputFormat: params.outputFormat,
        seed: params.seed,
      },
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

    if (ref.url) {
      await downloadToLibrary(storage, ref.url, outputPath, { fetchFn: options.fetchFn });
      sidecar.outputs = [{ path: outputPath, providerUrl: ref.url }];
    } else if (ref.dataBase64) {
      await storage.writeBytes(
        outputPath,
        new Uint8Array(Buffer.from(ref.dataBase64, "base64")),
      );
      sidecar.outputs = [{ path: outputPath }];
    } else {
      throw new ChatServiceError("图片编辑结果中没有图片", 502, "imageedit_no_images");
    }

    sidecar.status = "succeeded";
    await saveSidecar();

    return { output: outputPath, sidecar: sidecarPath, requestId: providerTaskId };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

// ---------- plate：分析驱动的"只删不补"特化 ----------

export const PlateInputSchema = z.object({
  projectSlug: SlugSchema,
  /** 不填 = 移除分析里的全部已确认对象 */
  objectSlugs: z.array(SlugSchema).optional(),
  /** 不填 = 最高索引的可见源图 */
  sourceImage: LogicalPathSchema.optional(),
  extraInstructions: z.string().optional(),
  model: z.enum(IMAGE_EDIT_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
});
export type PlateInput = z.input<typeof PlateInputSchema>;

/** "只删不补"的移除 prompt：一次移除全部对象，不逐对象拆分（§4.3） */
export function composePlatePrompt(
  objects: ObjectCandidate[],
  extraInstructions?: string,
): string {
  const list = objects.map((o) => `${o.name} (${o.description})`).join("; ");
  const base =
    `Remove the following objects from the image completely: ${list}. ` +
    `Removal only: erase each object and plausibly reconstruct the background behind it. ` +
    `Do not add new objects, do not move or restyle anything else, and keep the lighting, ` +
    `materials, perspective, and framing identical to the original.`;
  return extraInstructions ? `${base} ${extraInstructions}` : base;
}

/** 干净底板：读参考图分析 → 组移除 prompt → 使用同一张参考图 → 图片编辑 */
export async function runPlateGeneration(
  storage: AssetStorage,
  rawInput: PlateInput,
  keys: ImageProviderKeys,
  options: GenOptions = {},
): Promise<ImageEditResult> {
  const input = PlateInputSchema.parse(rawInput);
  await requireProject(storage, input.projectSlug);

  const analysisPath = projectAnalysisFile(input.projectSlug);
  if (!(await storage.exists(analysisPath))) {
    throw new ChatServiceError(
      `项目「${input.projectSlug}」还没有场景分析，请先用 analyze-reference + confirm-reference-assets 确认对象清单`,
      409,
      "analysis_missing",
    );
  }
  const analysis = await readJson(storage, analysisPath, SceneAnalysisSchema);

  const objects = input.objectSlugs
    ? analysis.objects.filter((o) => input.objectSlugs!.includes(o.slug))
    : analysis.objects;
  if (objects.length === 0) {
    throw new ChatServiceError(
      "没有可移除的对象（分析对象清单为空或过滤后为空）",
      409,
      "no_objects_to_remove",
    );
  }

  const sourceDir = projectSourceDir(input.projectSlug);
  let resolvedSource = input.sourceImage;
  if (!resolvedSource) {
    // 新分析永远只绑定显式参考图；latest 仅兼容没有 sources 的早期 analysis.json。
    resolvedSource = analysis.sources[0];
    if (!resolvedSource) {
      const latest = pickLatestSourceImage(await storage.list(sourceDir));
      if (latest) resolvedSource = `${sourceDir}/${latest}`;
    }
    if (!resolvedSource) {
      throw new ChatServiceError(
        `项目「${input.projectSlug}」的 source/ 中没有可用源图`,
        409,
        "source_image_missing",
      );
    }
  }

  return runFalImageEdit(
    storage,
    {
      projectSlug: input.projectSlug,
      images: [resolvedSource],
      prompt: composePlatePrompt(objects, input.extraInstructions),
      role: "plate" as const,
      model: input.model,
      channel: input.channel,
    },
    keys,
    options,
  );
}

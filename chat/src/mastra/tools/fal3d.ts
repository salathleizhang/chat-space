import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  pickLatestSourceImage,
} from "../../common/indexedFiles";
import {
  assetDir,
  assetIdentityFile,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  callFalQueue,
  extractFileRefs,
  type FalCallOptions,
} from "../../models/fal";
import {
  readAsDataUri,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { downloadToLibrary } from "./assetRepair";
import { requireProject } from "./projectTools";

/**
 * 图生 3D 供应商注册表（供应商 → 模型两级建模的 FAL 侧，决策 6）。
 * 一个供应商的全部知识（端点、参考图入参形状与张数、专属参数分支）都在本文件。
 * hunyuan/meshy 经上游验证；trellis/tripo3d/rodin 端点 id 经 fal 模型页核实（2026-07）；
 * seed3d 不在这份注册表里——fal 聚合没有它的端点，它走 `seed3dOps.ts` 的
 * 火山方舟直连（provider=seed3d-direct）。
 */
export const FAL_3D_PROVIDERS = {
  hunyuan: {
    endpoint: "fal-ai/hunyuan3d-v3/image-to-3d",
    imageInputKey: "input_image_url",
    imageAsArray: false,
    minImages: 1,
    maxImages: 1,
  },
  meshy: {
    endpoint: "fal-ai/meshy/v6/image-to-3d",
    imageInputKey: "image_url",
    imageAsArray: false,
    minImages: 1,
    maxImages: 1,
  },
  trellis: {
    endpoint: "fal-ai/trellis",
    imageInputKey: "image_url",
    imageAsArray: false,
    minImages: 1,
    maxImages: 1,
  },
  tripo3d: {
    endpoint: "tripo3d/tripo/v2.5/image-to-3d",
    imageInputKey: "image_url",
    imageAsArray: false,
    minImages: 1,
    maxImages: 1,
  },
  rodin: {
    // 多视角参考图：input_image_urls 收数组
    endpoint: "fal-ai/hyper3d/rodin",
    imageInputKey: "input_image_urls",
    imageAsArray: true,
    minImages: 1,
    maxImages: 5,
  },
} as const;
export type Fal3dProvider = keyof typeof FAL_3D_PROVIDERS;
export const FAL_3D_PROVIDER_IDS = Object.keys(FAL_3D_PROVIDERS) as [
  Fal3dProvider,
  ...Fal3dProvider[],
];

export const Object3dParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  /** 参考图（库内逻辑路径）；省略 = 最高索引可见源图。张数须满足供应商 min/maxImages */
  images: z.array(LogicalPathSchema).optional(),
  provider: z.enum(FAL_3D_PROVIDER_IDS).default("hunyuan"),
  faceCount: z.number().int().min(40000).max(1500000).default(50000),
  enablePbr: z.boolean().default(true),
  /** hunyuan：LowPoly = 重拓扑/减面 */
  generateType: z.enum(["Normal", "LowPoly", "Geometry"]).default("Normal"),
  polygonType: z.enum(["triangle", "quadrilateral"]).default("triangle"),
  /** meshy：骨骼绑定与动画生成 */
  enableRigging: z.boolean().default(false),
  enableAnimation: z.boolean().default(false),
});
export type Object3dParams = z.infer<typeof Object3dParamsSchema>;
export type Object3dParamsInput = z.input<typeof Object3dParamsSchema>;

export interface Object3dResult {
  model: string;
  extras: string[];
  sidecar: string;
  requestId: string;
}

// 与 modelPublishing 的 RENDERABLE_MODEL_RE（glb/gltf/obj/fbx）对齐：usdz 不在其中，
// 选它当主模型会落盘后仍被判 renderable_model_missing 发布失败，属死/不一致路径。
const MODEL_EXT_RE = /\.(glb|obj|fbx)(\?|$)/i;
const TEXTURE_EXT_RE = /\.(png|jpe?g|webp)(\?|$)/i;

function extFromUrl(url: string, fallback: string): string {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  return match ? match[1]!.toLowerCase() : fallback;
}

/**
 * 解析并校验参考图，优先级：显式 images > 资产身份绑定的 sourceImages
 * （generate-reference-images 写入，过滤已不存在的）> 最高索引可见源图。
 * 张数须落在供应商声明区间内。
 */
async function resolveImages(
  storage: AssetStorage,
  params: Object3dParams,
): Promise<string[]> {
  let images = params.images ?? [];
  if (images.length === 0) {
    const identityPath = assetIdentityFile(params.projectSlug, params.assetSlug);
    if (await storage.exists(identityPath)) {
      const identity = await readJson(storage, identityPath, AssetIdentitySchema);
      const existing: string[] = [];
      for (const image of identity.sourceImages) {
        if (await storage.exists(image)) existing.push(image);
      }
      images = existing;
    }
  }
  if (images.length === 0) {
    const sourceDir = projectSourceDir(params.projectSlug);
    const latest = pickLatestSourceImage(await storage.list(sourceDir));
    if (!latest) {
      throw new ChatServiceError(
        `项目「${params.projectSlug}」没有可用参考图，请指定 images、用 generate-reference-images 生成或先上传源图`,
        409,
        "reference_image_missing",
      );
    }
    images = [`${sourceDir}/${latest}`];
  }

  const { minImages, maxImages } = FAL_3D_PROVIDERS[params.provider];
  const explicit = (params.images?.length ?? 0) > 0;
  // 隐式来源（身份绑定/默认源图）超出上限时裁剪即可；显式传参才值得报错纠正
  if (!explicit && images.length > maxImages) {
    images = images.slice(0, maxImages);
  }
  if (images.length < minImages || images.length > maxImages) {
    const range = minImages === maxImages ? `${minImages}` : `${minImages}–${maxImages}`;
    throw new ChatServiceError(
      `供应商「${params.provider}」需要 ${range} 张参考图，收到 ${images.length} 张`,
      400,
      "image_count_mismatch",
    );
  }
  for (const image of images) {
    if (!(await storage.exists(image))) {
      throw new ChatServiceError(`参考图不存在：${image}`, 404, "input_image_missing");
    }
  }
  return images;
}

/** 供应商专属入参（不含参考图）；侧写记录的就是这份 —— 记录 = 实际发送 */
function buildProviderInput(params: Object3dParams): Record<string, unknown> {
  if (params.provider === "hunyuan") {
    return {
      generate_type: params.generateType,
      enable_pbr: params.enablePbr,
      face_count: params.faceCount,
      ...(params.generateType === "LowPoly"
        ? { polygon_type: params.polygonType }
        : {}),
    };
  }
  if (params.provider === "meshy") {
    return {
      enable_pbr: params.enablePbr,
      ...(params.enableRigging ? { enable_rigging: true } : {}),
      ...(params.enableAnimation ? { enable_animation: true } : {}),
    };
  }
  if (params.provider === "rodin") {
    return {
      geometry_file_format: "glb",
      ...(params.enablePbr ? { material: "PBR" } : {}),
    };
  }
  // trellis / tripo3d：只收参考图
  return {};
}

/**
 * 单个原子对象的 3D 生成（上游 generate-single-asset.mjs 的迁移）。
 * 缺资产身份时先建最小意图记录（§4.5）；模型 + 贴图全部落盘，磁盘不齐不算成功。
 */
export async function runFal3dGeneration(
  storage: AssetStorage,
  rawParams: Object3dParamsInput,
  callOptions: FalCallOptions,
): Promise<Object3dResult> {
  const params = Object3dParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);
  const images = await resolveImages(storage, params);
  const providerConfig = FAL_3D_PROVIDERS[params.provider];
  const providerInput = buildProviderInput(params);

  // 缺参即建最小意图记录，而不是报错拒绝
  const dir = assetDir(params.projectSlug, params.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: "fal",
    model: providerConfig.endpoint,
    // 参考图以逻辑路径记录，其余字段与实际发送的入参一致
    params: { images, ...providerInput },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      updatedAt: now(),
    });
  await saveSidecar();

  try {
    const imageValues: string[] = [];
    for (const image of images) {
      imageValues.push(await readAsDataUri(storage, image));
    }
    const input: Record<string, unknown> = {
      ...providerInput,
      [providerConfig.imageInputKey]: providerConfig.imageAsArray
        ? imageValues
        : imageValues[0],
    };

    const { submission, result } = await callFalQueue(
      providerConfig.endpoint,
      input,
      { pollIntervalMs: 10_000, ...callOptions },
      {
        onSubmit: async (s) => {
          sidecar.providerTaskId = s.requestId;
          sidecar.status = "running";
          await saveSidecar();
        },
      },
    );

    const refs = extractFileRefs(result);
    const modelRef = refs.find((ref) => MODEL_EXT_RE.test(ref.url));
    if (!modelRef) {
      throw new ChatServiceError("FAL 结果中没有可下载的 3D 模型文件", 502, "fal_no_model");
    }

    const modelPath = `${dir}/${formatIndexedName(
      index,
      params.assetSlug,
      extFromUrl(modelRef.url, "glb"),
    )}`;
    await downloadToLibrary(storage, modelRef.url, modelPath, {
      fetchFn: callOptions.fetchFn,
    });
    sidecar.outputs = [{ path: modelPath, providerUrl: modelRef.url }];

    // 贴图等附属文件共享同一索引
    const extras: string[] = [];
    let extraSeq = 0;
    for (const ref of refs) {
      if (ref === modelRef || !TEXTURE_EXT_RE.test(ref.url)) continue;
      extraSeq += 1;
      const extraPath = `${dir}/${formatIndexedName(
        index,
        `${params.assetSlug}-tex${extraSeq}`,
        extFromUrl(ref.url, "png"),
      )}`;
      await downloadToLibrary(storage, ref.url, extraPath, {
        fetchFn: callOptions.fetchFn,
      });
      extras.push(extraPath);
      sidecar.outputs.push({ path: extraPath, providerUrl: ref.url });
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    return {
      model: modelPath,
      extras,
      sidecar: sidecarPath,
      requestId: submission.requestId,
    };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

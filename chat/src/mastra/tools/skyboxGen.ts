import { CloudTaskPending } from "../../cloud/context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { API_REQUEST_TIMEOUT_MS, fetchWithTimeout, readBodyWithTimeout } from "../../common/http";
import { currentTaskPump } from "../../common/taskPump";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  reserveIndex,
} from "../../common/indexedFiles";
import { assetDir, assetIdentityFile } from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  RequestSidecarSchema,
  SlugSchema,
  createAssetIdentity,
  type RequestSidecar,
} from "../../dto/library";
import type { GenerationPhase } from "../../dto/tasks";
import {
  pollSkyboxExport,
  pollSkyboxGenerate,
  submitSkybox,
  submitSkyboxExport,
  type BlockadeLabsOptions,
} from "../../models/blockadelabs";
import {
  IMAGE_CHANNELS,
  IMAGE_EDIT_MODEL_IDS,
  routeImageEditChannel,
  runImageEdit,
  type ImageEditModel,
  type ImageProviderKeys,
} from "../../models/images";
import {
  getAssetStorage,
  readAsDataUri,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { downloadToLibrary } from "./assetRepair";
import {
  getProjectState,
  requireProject,
  setCurrentSkybox,
  uniqueAssetSlug,
} from "./projectTools";
import {
  currentImageGenerateModel,
  optionalContextString,
  requireCurrentProject,
} from "./requestContext";

export const SkyboxGenParamsSchema = z.object({
  projectSlug: SlugSchema,
  /** 省略时创建新的 sky / sky-2 / sky-3…；显式传入则向指定资产追加一代 */
  skyboxSlug: SlugSchema.optional(),
  prompt: z.string().min(1),
  /** Blockade Labs 风格模型 id，缺省用其平台默认风格 */
  styleId: z.number().int().optional(),
  negativeText: z.string().optional(),
});
export type SkyboxGenParams = z.infer<typeof SkyboxGenParamsSchema>;

export interface SkyboxGenResult {
  hdrPath: string;
  panoPath: string;
  sidecars: string[];
}

const SKYBOX_RASTER_RE = /^(\d+)-.*\.(png|jpe?g|webp)$/i;

function latestSkyboxRaster(files: string[]): string | undefined {
  let best: { name: string; index: number } | undefined;
  for (const name of files) {
    const match = SKYBOX_RASTER_RE.exec(name);
    if (!match) continue;
    const index = Number(match[1]);
    if (!best || index > best.index) best = { name, index };
  }
  return best?.name;
}

function imageExtension(ref: { url?: string; mimeType?: string }): "png" | "jpg" | "webp" {
  const mime = ref.mimeType?.toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  const url = ref.url?.split(/[?#]/)[0];
  const urlExt = url?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (urlExt === "jpg" || urlExt === "jpeg") return "jpg";
  if (urlExt === "webp") return "webp";
  return "png";
}

function composeSkyboxEditPrompt(prompt: string): string {
  return [
    "Edit the supplied image as a seamless 360-degree equirectangular skybox panorama.",
    "Preserve the exact equirectangular projection, original aspect ratio, horizon continuity, and a seamless left/right edge.",
    "Do not add borders, text, watermarks, frames, or a visible seam.",
    `Requested change: ${prompt}`,
  ].join("\n");
}

export const EditCurrentSkyboxParamsSchema = z.object({
  projectSlug: SlugSchema,
  prompt: z.string().min(1),
  model: z.enum(IMAGE_EDIT_MODEL_IDS).default("seedream"),
  channel: z.enum(IMAGE_CHANNELS).optional(),
});

export interface EditCurrentSkyboxResult {
  skyboxSlug: string;
  image: string;
  sidecar: string;
  model: ImageEditModel;
}

/**
 * 天空盒的固定生成口径：**Seedream 4.5 + 精确 4096×2048**，故意不看 AgentDock
 * 当前选择的图片模型。
 *
 * 为什么钉 4.5：天空盒是项目级单张环境资产，视口一屏只取约 80° 水平视野，于是
 * 2912×1456 的产物在单窗格里被放大 **约 3.4 倍**（8.1 px/度，而单窗格需要约
 * 27 px/度）——"内容满意但非常不清楚"就是这么来的。方舟各模型的像素上限差别很大：
 * 5.0 / 5.0 Pro 只有约 419 万（2K 档，2:1 全景落在 2912×1456 就到顶），
 * **4.5 是方舟当前支持 4K 的编辑模型**（4.0 也能，但更旧）。
 *
 * 为什么用精确像素而不是 `4K` 档：档位下宽高比由模型按画面内容自选，一旦它给出
 * 近似方形，等距柱状映射就废了；`4096x2048` 同时钉住 2:1 与像素预算（约 839 万，
 * 落在方舟的 [2560x1440, 4096x4096] 区间内，也是 2:1 全景能拿到的上限）。
 *
 * 不做任何后处理：产物按供应商原格式（jpeg）直接落盘，不本地锐化、不重采样。
 *
 * 没有方舟 key 时才回退到调用方指定的模型（那种情况下我们控制不了分辨率）。
 */
const SKYBOX_EDIT_MODEL: ImageEditModel = "seedream";
const SKYBOX_EDIT_SIZE = "4096x2048";

const DEFAULT_SKYBOX_IMAGE_URLS = [
  new URL("../../../../app/dist/env/sky.jpg", import.meta.url),
  new URL("../../../../app/public/env/sky.jpg", import.meta.url),
];

async function defaultSkyboxDataUri(): Promise<string> {
  if (typeof Bun === "undefined") return fetchDefaultSkyboxDataUri();
  for (const url of DEFAULT_SKYBOX_IMAGE_URLS) {
    const file = Bun.file(url);
    if (await file.exists()) {
      return `data:image/jpeg;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
    }
  }
  throw new ChatServiceError(
    "The editable panorama for the built-in default skybox does not exist",
    500,
    "default_skybox_missing",
  );
}

/** 浏览器 Worker 从网站静态文件读默认全景，不能调用 Bun.file 或本机文件系统。 */
export async function fetchDefaultSkyboxDataUri(
  fetchFn: typeof fetch = fetch,
  baseUrl: string = import.meta.url,
): Promise<string> {
  const pump = currentTaskPump();
  pump?.enter(API_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchWithTimeout(fetchFn, new URL("/env/sky.jpg", baseUrl),
      pump ? { signal: pump.signal } : undefined, API_REQUEST_TIMEOUT_MS, "Default skybox");
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) {
      throw new ChatServiceError("The built-in default skybox image could not be loaded",
        500, "default_skybox_missing");
    }
    const bytes = await readBodyWithTimeout(() => response.arrayBuffer(), API_REQUEST_TIMEOUT_MS, "Default skybox");
    return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
  } finally {
    pump?.leave();
  }
}

interface ResolvedSkyboxInput {
  skyboxSlug: string;
  inputLabel: string;
  dataUri: string;
  isNewAsset: boolean;
}

/** 当前指针优先；旧项目没有指针时自动复用最近创建的天空盒；都没有才使用内置默认图。 */
async function resolveSkyboxInput(
  storage: AssetStorage,
  projectSlug: string,
  currentSkybox: string | undefined,
  defaultImageDataUri?: string,
): Promise<ResolvedSkyboxInput> {
  const state = await getProjectState(storage, projectSlug);
  const skyboxes = state.assets
    .filter((asset) => asset.identity?.kind === "skybox")
    .sort((a, b) =>
      (b.identity?.createdAt ?? "").localeCompare(a.identity?.createdAt ?? ""),
    );
  const existing = skyboxes.find((asset) => asset.slug === currentSkybox) ?? skyboxes[0];
  if (existing) {
    const inputFile = latestSkyboxRaster(existing.files);
    const inputPath = inputFile
      ? `${assetDir(projectSlug, existing.slug)}/${inputFile}`
      : "builtin:/env/sky.jpg";
    return {
      skyboxSlug: existing.slug,
      inputLabel: inputPath,
      dataUri: inputFile
        ? await readAsDataUri(storage, inputPath)
        : defaultImageDataUri ?? await defaultSkyboxDataUri(),
      isNewAsset: false,
    };
  }

  return {
    skyboxSlug: await uniqueAssetSlug(storage, projectSlug, "skybox"),
    inputLabel: "builtin:/env/sky.jpg",
    dataUri: defaultImageDataUri ?? await defaultSkyboxDataUri(),
    isNewAsset: true,
  };
}

/**
 * 用当前图片生成模型编辑项目当前启用的天空盒。输出作为同一天空盒资产的新代次，
 * 不覆盖旧全景/HDR；视口按最高索引选择环境图，因此刷新后立即显示新结果。
 */
export async function runCurrentSkyboxEdit(
  storage: AssetStorage,
  rawParams: z.input<typeof EditCurrentSkyboxParamsSchema>,
  keys: ImageProviderKeys,
  options: { fetchFn?: typeof fetch; defaultImageDataUri?: string } = {},
): Promise<EditCurrentSkyboxResult> {
  const params = EditCurrentSkyboxParamsSchema.parse(rawParams);
  const project = await requireProject(storage, params.projectSlug);
  const resolved = await resolveSkyboxInput(
    storage,
    params.projectSlug,
    project.currentSkybox,
    options.defaultImageDataUri,
  );
  const { skyboxSlug } = resolved;
  const dir = assetDir(params.projectSlug, skyboxSlug);
  // 清晰度优先：有方舟 key 就固定 4.5 + 4096×2048（4K），不看 AgentDock 的图片模型选择。
  // 显式指定 channel 的调用方保留逃生口（那种调用是有意选渠道的）。
  const pinned = !params.channel && Boolean(keys.volcengineApiKey);
  const effectiveModel = pinned ? SKYBOX_EDIT_MODEL : params.model;
  const outputSize = pinned ? SKYBOX_EDIT_SIZE : undefined;
  const route = routeImageEditChannel(effectiveModel, keys, params.channel);
  const effectivePrompt = composeSkyboxEditPrompt(params.prompt);
  const now = () => new Date().toISOString();
  const sidecarFor = (index: number): RequestSidecar => ({
    schemaVersion: 1,
    index,
    slug: skyboxSlug,
    provider: route.channel,
    model: route.entry.model,
    params: {
      prompt: params.prompt,
      effective_prompt: effectivePrompt,
      // 调用方原本点的模型也留着，便于回溯"为什么不按我选的来"
      model: params.model,
      ...(pinned ? { effective_model: effectiveModel, output_size: outputSize } : {}),
      input_image: resolved.inputLabel,
      operation: "skybox/edit",
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  });
  const index = await reserveIndex(storage, dir, skyboxSlug, (candidate) =>
    JSON.stringify(sidecarFor(candidate), null, 2),
  );
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, skyboxSlug)}`;
  const sidecar = sidecarFor(index);
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, { ...sidecar, updatedAt: now() });
  await saveSidecar();

  try {
    sidecar.status = "running";
    await saveSidecar();
    const { refs } = await runImageEdit(
      route.channel,
      route.entry,
      {
        prompt: effectivePrompt,
        images: [resolved.dataUri],
        ...(outputSize ? { size: outputSize } : {}),
      },
      route.apiKey,
      options,
    );
    const ref = refs[0];
    if (!ref) {
      throw new ChatServiceError("The skybox edit produced no image", 502, "skybox_edit_no_image");
    }

    const outputPath = `${dir}/${formatIndexedName(
      index,
      skyboxSlug,
      imageExtension(ref),
    )}`;
    if (ref.url) {
      // 先记账、再下载：失败时侧写里留着供应商地址，repair-assets 才补得回来（同 referenceImage）。
      sidecar.outputs = [{ path: outputPath, providerUrl: ref.url }];
      await saveSidecar();
      await downloadToLibrary(storage, ref.url, outputPath, { fetchFn: options.fetchFn });
    } else if (ref.dataBase64) {
      await storage.writeBytes(outputPath, new Uint8Array(Buffer.from(ref.dataBase64, "base64")));
      sidecar.outputs = [{ path: outputPath }];
    } else {
      throw new ChatServiceError("The skybox edit produced no image", 502, "skybox_edit_no_image");
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    if (resolved.isNewAsset) {
      await writeJson(
        storage,
        assetIdentityFile(params.projectSlug, skyboxSlug),
        AssetIdentitySchema,
        createAssetIdentity({
          slug: skyboxSlug,
          kind: "skybox",
          name: "Skybox",
          intent: params.prompt,
          sourceImages: [],
        }),
      );
    }
    await setCurrentSkybox(storage, params.projectSlug, skyboxSlug);
    return {
      skyboxSlug,
      image: outputPath,
      sidecar: sidecarPath,
      model: effectiveModel,
    };
  } catch (err) {
    if (err instanceof CloudTaskPending) throw err;
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

function imageProviderKeysFromContext(
  context: Parameters<typeof optionalContextString>[0],
): ImageProviderKeys {
  return {
    volcengineApiKey:
      optionalContextString(context, "volcengineApiKey") ??
      optionalContextString(context, "seed3dApiKey"),
    googleApiKey: optionalContextString(context, "googleApiKey"),
    openaiApiKey: optionalContextString(context, "openaiApiKey"),
    openrouterApiKey: optionalContextString(context, "openrouterApiKey"),
  };
}

export const generateSkyboxTool = createTool({
  id: "generate-skybox",
  description:
    "Skybox generation (paid operation — get the user's consent before calling): modify the project's single skybox according to the prompt. It always uses Volcano Engine Ark Seedream 4.5 to generate at **4096×2048 (4K, 2:1 panorama)**, and **deliberately ignores the image generation model currently selected in the dialog** — the 5.0 family caps at about 4.19 million pixels (roughly 2912×1456 for a 2:1 panorama), which is blurrier for a panorama than 4.5's 4K; only when no Ark key is configured does it fall back to the currently selected model and its default resolution. Output is persisted directly in the provider's original format with **no post-processing whatsoever**. If a skybox has already been generated it keeps editing that one; otherwise it creates one using the built-in default skybox as input. Old generations are kept, the result is used for the current scene immediately on success, and the user is not asked to choose a skybox.",
  inputSchema: z.object({ prompt: z.string().min(1) }),
  execute: async (input, context) =>
    runCurrentSkyboxEdit(
      getAssetStorage(),
      {
        projectSlug: requireCurrentProject(context),
        prompt: input.prompt,
        model: currentImageGenerateModel(context),
      },
      imageProviderKeysFromContext(context),
    ),
});

/**
 * 天空盒生成（Blockade Labs）：两段链式——生成全景图 → 导出 HDR，各自独立侧写、独立索引
 * （跟 tripoOps.ts 的链式后处理同一个模式：第二段的 params 里记第一段的 provider task id）。
 * 省略 slug 时创建独立的新天空盒资产；成功后把 currentSkybox 指向新资产。
 */
export async function runSkyboxGeneration(
  storage: AssetStorage,
  rawParams: z.input<typeof SkyboxGenParamsSchema>,
  callOptions: BlockadeLabsOptions,
  /** 身份提交后回调（供任务化在「已发布但状态未落盘」的崩溃窗口前回写 assetSlug） */
  onPublished?: (assetSlug: string) => void | Promise<void>,
  /** 阶段推进回调：让任务 phase 从 queued 一路可见地走到 publishing */
  onPhase?: (phase: GenerationPhase) => void | Promise<void>,
): Promise<SkyboxGenResult> {
  const parsed = SkyboxGenParamsSchema.parse(rawParams);
  await requireProject(storage, parsed.projectSlug);
  const params = {
    ...parsed,
    skyboxSlug:
      parsed.skyboxSlug ??
      (await uniqueAssetSlug(storage, parsed.projectSlug, "sky")),
  };

  const dir = assetDir(params.projectSlug, params.skyboxSlug);
  const now = () => new Date().toISOString();

  // ---------- 阶段 1：生成全景图（PNG） ----------
  const genIndex = nextIndex(await storage.list(dir));
  const genSidecarPath = `${dir}/${formatRequestSidecarName(genIndex, params.skyboxSlug)}`;
  const genSidecar: RequestSidecar = {
    schemaVersion: 1,
    index: genIndex,
    slug: params.skyboxSlug,
    provider: "blockade-labs",
    model: "skybox/generate",
    params: {
      prompt: params.prompt,
      ...(params.styleId !== undefined ? { styleId: params.styleId } : {}),
    },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveGenSidecar = () =>
    writeJson(storage, genSidecarPath, RequestSidecarSchema, { ...genSidecar, updatedAt: now() });
  await saveGenSidecar();

  let obfuscatedId: string;
  let panoPath: string;
  try {
    // 提交后立即落盘续跑 id（providerTaskId + requestId），轮询/下载中途崩溃也能凭侧写续跑。
    const submitted = await submitSkybox(
      { prompt: params.prompt, styleId: params.styleId, negativeText: params.negativeText },
      callOptions,
    );
    obfuscatedId = submitted.obfuscatedId;
    genSidecar.status = "running";
    genSidecar.providerTaskId = obfuscatedId;
    // 轮询生成状态用的是数字 requestId（跟导出阶段链式用的 obfuscatedId 是两个字段），
    // 续跑（resumeGeneration.ts）要能重新轮询就得把它也记下来，非密钥字段，允许入侧写。
    genSidecar.params = { ...genSidecar.params, requestId: submitted.requestId };
    await saveGenSidecar();

    const pano = await pollSkyboxGenerate(submitted.requestId, callOptions);
    panoPath = `${dir}/${formatIndexedName(genIndex, params.skyboxSlug, "png")}`;
    await onPhase?.("downloading");
    await downloadToLibrary(storage, pano.fileUrl, panoPath, { fetchFn: callOptions.fetchFn });
    genSidecar.status = "succeeded";
    genSidecar.outputs = [{ path: panoPath, providerUrl: pano.fileUrl }];
    await saveGenSidecar();
  } catch (err) {
    genSidecar.status = "failed";
    genSidecar.error = toErrorMessage(err);
    await saveGenSidecar();
    throw err;
  }

  // ---------- 阶段 2：导出 HDR（链式，off 阶段 1 的 obfuscatedId） ----------
  const exportIndex = nextIndex(await storage.list(dir));
  const exportSidecarPath = `${dir}/${formatRequestSidecarName(exportIndex, params.skyboxSlug)}`;
  const exportSidecar: RequestSidecar = {
    schemaVersion: 1,
    index: exportIndex,
    slug: params.skyboxSlug,
    provider: "blockade-labs",
    model: "skybox/export",
    params: { skyboxId: obfuscatedId },
    status: "queued",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveExportSidecar = () =>
    writeJson(storage, exportSidecarPath, RequestSidecarSchema, {
      ...exportSidecar,
      updatedAt: now(),
    });
  await saveExportSidecar();

  let hdrPath: string;
  try {
    // 提交后立即落盘 exportId，导出轮询/下载中途崩溃也能凭侧写续跑。
    const submitted = await submitSkyboxExport(obfuscatedId, callOptions);
    const exportId = submitted.exportId;
    exportSidecar.status = "running";
    exportSidecar.providerTaskId = exportId;
    await saveExportSidecar();

    const hdr = await pollSkyboxExport(exportId, callOptions);
    hdrPath = `${dir}/${formatIndexedName(exportIndex, params.skyboxSlug, "hdr")}`;
    await onPhase?.("downloading");
    await downloadToLibrary(storage, hdr.fileUrl, hdrPath, { fetchFn: callOptions.fetchFn });
    exportSidecar.status = "succeeded";
    exportSidecar.outputs = [{ path: hdrPath, providerUrl: hdr.fileUrl }];
    await saveExportSidecar();
  } catch (err) {
    exportSidecar.status = "failed";
    exportSidecar.error = toErrorMessage(err);
    await saveExportSidecar();
    throw err;
  }

  const identityPath = assetIdentityFile(params.projectSlug, params.skyboxSlug);
  if (!(await storage.exists(identityPath))) {
    await writeJson(
      storage,
      identityPath,
      AssetIdentitySchema,
      createAssetIdentity({
        slug: params.skyboxSlug,
        kind: "skybox",
        name: params.skyboxSlug,
        intent: params.prompt,
        sourceImages: [],
      }),
    );
  }
  await setCurrentSkybox(storage, params.projectSlug, params.skyboxSlug);
  await onPublished?.(params.skyboxSlug);

  return { hdrPath, panoPath, sidecars: [genSidecarPath, exportSidecarPath] };
}

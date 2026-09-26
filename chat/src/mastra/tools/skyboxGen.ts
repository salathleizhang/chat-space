import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
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
  type RequestSidecar,
} from "../../dto/library";
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

const DEFAULT_SKYBOX_IMAGE_URLS = [
  new URL("../../../../app/dist/env/sky.jpg", import.meta.url),
  new URL("../../../../app/public/env/sky.jpg", import.meta.url),
];

async function defaultSkyboxDataUri(): Promise<string> {
  for (const url of DEFAULT_SKYBOX_IMAGE_URLS) {
    const file = Bun.file(url);
    if (await file.exists()) {
      return `data:image/jpeg;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
    }
  }
  throw new ChatServiceError(
    "内置默认天空盒的可编辑全景图不存在",
    500,
    "default_skybox_missing",
  );
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
  const route = routeImageEditChannel(params.model, keys, params.channel);
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
      model: params.model,
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
      { prompt: effectivePrompt, images: [resolved.dataUri] },
      route.apiKey,
      options,
    );
    const ref = refs[0];
    if (!ref) {
      throw new ChatServiceError("天空盒编辑结果中没有图片", 502, "skybox_edit_no_image");
    }

    const outputPath = `${dir}/${formatIndexedName(
      index,
      skyboxSlug,
      imageExtension(ref),
    )}`;
    if (ref.url) {
      await downloadToLibrary(storage, ref.url, outputPath, { fetchFn: options.fetchFn });
      sidecar.outputs = [{ path: outputPath, providerUrl: ref.url }];
    } else if (ref.dataBase64) {
      await storage.writeBytes(outputPath, new Uint8Array(Buffer.from(ref.dataBase64, "base64")));
      sidecar.outputs = [{ path: outputPath }];
    } else {
      throw new ChatServiceError("天空盒编辑结果中没有图片", 502, "skybox_edit_no_image");
    }

    sidecar.status = "succeeded";
    await saveSidecar();
    if (resolved.isNewAsset) {
      await writeJson(storage, assetIdentityFile(params.projectSlug, skyboxSlug), AssetIdentitySchema, {
        schemaVersion: 1,
        slug: skyboxSlug,
        kind: "skybox",
        name: "Skybox",
        intent: params.prompt,
        sourceImages: [],
        createdAt: new Date().toISOString(),
      });
    }
    await setCurrentSkybox(storage, params.projectSlug, skyboxSlug);
    return {
      skyboxSlug,
      image: outputPath,
      sidecar: sidecarPath,
      model: params.model,
    };
  } catch (err) {
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
    "天空盒生成（付费操作——调用前须经用户同意）：根据提示词修改项目唯一的天空盒，并自动使用 AgentDock 当前选择的图片生成模型。有已生成天空盒就继续编辑它；没有则以内置默认天空盒为输入创建。保留旧代次，成功后立即用于当前场景，不要求用户选择天空盒。",
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
    await writeJson(storage, identityPath, AssetIdentitySchema, {
      schemaVersion: 1,
      slug: params.skyboxSlug,
      kind: "skybox",
      name: params.skyboxSlug,
      intent: params.prompt,
      sourceImages: [],
      createdAt: new Date().toISOString(),
    });
  }
  await setCurrentSkybox(storage, params.projectSlug, params.skyboxSlug);
  await onPublished?.(params.skyboxSlug);

  return { hdrPath, panoPath, sidecars: [genSidecarPath, exportSidecarPath] };
}

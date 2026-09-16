import { z } from "zod";
import { toErrorMessage } from "../../common/errors";
import { formatIndexedName, formatRequestSidecarName, nextIndex } from "../../common/indexedFiles";
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
import { writeJson, type AssetStorage } from "../../services/assetStorage";
import { downloadToLibrary } from "./assetRepair";
import {
  requireProject,
  setCurrentSkybox,
  uniqueAssetSlug,
} from "./projectTools";

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

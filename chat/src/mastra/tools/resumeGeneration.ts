import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import { extractFileUrls } from "../../common/fileUrls";
import {
  formatIndexedName,
  formatRequestSidecarName,
  parseRequestSidecarName,
} from "../../common/indexedFiles";
import {
  assetDir,
  assetIdentityFile,
  projectAssetsDir,
  projectSourceDir,
  projectTaskWorkDir,
  projectTasksDir,
} from "../../common/libraryPaths";
import {
  AssetIdentitySchema,
  LogicalPathSchema,
  RequestSidecarSchema,
  createAssetIdentity,
  isResumableSidecar,
  type RequestSidecar,
} from "../../dto/library";
import type { GenerationPhase } from "../../dto/tasks";
import { pollSkyboxExport, pollSkyboxGenerate } from "../../models/blockadelabs";
import { waitForHunyuanJob } from "../../models/hunyuan";
import { extractSeed3dFileUrls, waitForSeed3dTask } from "../../models/seed3d";
import { waitForTripoTask } from "../../models/tripo";
import {
  extractWorldAssetUrls,
  pollMarbleOperation,
} from "../../models/worldlabs";
import {
  getAssetStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { mutateCandidates, readCandidates } from "../../services/candidateRegistry";
import { publishGeneratedModel } from "../../services/modelPublishing";
import { downloadSpzToLibrary, downloadToLibrary } from "./assetRepair";
import { setCurrentSkybox, setCurrentWorld } from "./projectTools";
import {
  optionalContextString,
  requireCurrentProject,
} from "./requestContext";
import {
  downloadAndLandSeed3dOutput,
  landSeed3dOutputBytes,
  seed3dOutputBasePath,
} from "./seed3dOutput";

/**
 * 凭请求侧写跨会话/跨重启续跑（§5 失败恢复）：
 * 侧写记录了 providerTaskId 与参数——供应商侧任务还在跑或已完成时，
 * 不重新提交（不重复花钱），只接续轮询 + 下载落盘。
 * 续跑 ≠ 重生成：沿用侧写自己的索引，不产生新索引。
 */

export interface ResumeKeys {
  worldLabsApiKey?: string;
  tripo3dApiKey?: string;
  /** "SecretId:SecretKey" */
  hunyuanApiKey?: string;
  seed3dApiKey?: string;
  blockadeLabsApiKey?: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
}

export interface ResumableEntry {
  sidecarPath: string;
  provider: string;
  model: string;
  slug: string;
  status: string;
  hasProviderTaskId: boolean;
}

/** 从侧写逻辑路径取项目 slug：projects/<projectSlug>/assets/<assetSlug>/.N-…-request.json */
function projectSlugOf(sidecarPath: string): string {
  const parts = sidecarPath.split("/");
  const slug = parts[0] === "projects" ? parts[1] : undefined;
  if (!slug) {
    throw new ChatServiceError(
      `无法从侧写路径解析出项目：${sidecarPath}`,
      400,
      "invalid_sidecar_path",
    );
  }
  return slug;
}

/**
 * 世界续跑成功后必须登记资产身份与当前世界指针。
 *
 * 只把文件落盘是不够的：项目状态是从 `assets/<slug>/asset.json` 读出来的，缺了身份，
 * 世界在界面里根本不存在——2026-09-26 的 World Labs 任务失败后走续跑就会踩到这个坑。
 * 语义与 runWorldGeneration 的收尾保持一致。
 */
async function registerResumedWorld(
  storage: AssetStorage,
  projectSlug: string,
  sidecar: RequestSidecar,
): Promise<void> {
  const identityPath = assetIdentityFile(projectSlug, sidecar.slug);
  if (await storage.exists(identityPath)) {
    // 已经登记过：这是「补齐旧侧写文件」，不要去动用户可能已经切走的当前世界指针。
    return;
  }
  const prompt = typeof sidecar.params.prompt === "string" ? sidecar.params.prompt : undefined;
  const image = typeof sidecar.params.image === "string" ? sidecar.params.image : undefined;
  await writeJson(
    storage,
    identityPath,
    AssetIdentitySchema,
    createAssetIdentity({
      slug: sidecar.slug,
      kind: "world",
      name: sidecar.slug,
      intent: prompt ?? "Explorable 3D environment generated from source image",
      sourceImages: image ? [image] : [],
    }),
  );
  await setCurrentWorld(storage, projectSlug, sidecar.slug);
}

/** 天空盒导出续跑成功后的资产登记；与 runSkyboxGeneration 的收尾保持一致。 */
async function registerResumedSkybox(
  storage: AssetStorage,
  projectSlug: string,
  sidecar: RequestSidecar,
): Promise<void> {
  const identityPath = assetIdentityFile(projectSlug, sidecar.slug);
  if (await storage.exists(identityPath)) return;
  await writeJson(
    storage,
    identityPath,
    AssetIdentitySchema,
    createAssetIdentity({
      slug: sidecar.slug,
      kind: "skybox",
      name: sidecar.slug,
      intent:
        typeof sidecar.params.prompt === "string" && sidecar.params.prompt
          ? sidecar.params.prompt
          : sidecar.slug,
      sourceImages: [],
    }),
  );
  await setCurrentSkybox(storage, projectSlug, sidecar.slug);
}

/** 会产出模型产物、需要「续跑即发布」的渠道。 */
const MODEL_PROVIDERS = new Set(["seed3d", "ark-hyper3d", "ark-hitem3d", "tripo", "hunyuan"]);

/**
 * 模型续跑成功后的发布收尾——与 `runAndPublishGeneratedModel` 的尾部等价。
 *
 * 为什么必须有这一步：任务中途死掉时侧写还在 `tasks/<id>/work/` 里（生产流程原本会
 * 在成功后把整个工作目录 `move` 到 `assets/<slug>/`），而 `asset.json` 是资产在界面里
 * 存在的唯一依据。只把字节下回来而不发布，用户看到的就是「任务失败、资产列表里什么
 * 也没有」——2026-10-02 三个已经生成成功的火山 3D 任务正是卡在这里。
 *
 * 已发布资产（侧写本来就在 `assets/<slug>/` 下）原样跳过：那是在补齐旧文件，
 * 不该重写已存在的身份，更不该动用户当前的模型代次。
 */
async function publishResumedModel(
  storage: AssetStorage,
  projectSlug: string,
  sidecarPath: string,
  sidecar: RequestSidecar,
  files: string[],
  outputs: RequestSidecar["outputs"],
): Promise<void> {
  if (!sidecarPath.startsWith(`${projectTasksDir(projectSlug)}/`)) return;
  if (files.length === 0) return;
  if (await storage.exists(assetIdentityFile(projectSlug, sidecar.slug))) return;

  const finalDir = assetDir(projectSlug, sidecar.slug);
  const renamed = new Map<string, string>();
  for (const [index, file] of files.entries()) {
    // 工作目录里的文件名本来就是按资产规范生成的（StagedAssetStorage 的映射），
    // 所以只搬位置、不改名字。
    const target = `${finalDir}/${file.split("/").pop()}`;
    await storage.writeBytes(target, await storage.readBytes(file));
    renamed.set(file, target);
    files[index] = target;
  }
  for (const output of outputs) {
    const target = renamed.get(output.path);
    if (target) output.path = target;
  }

  // 侧写副本进资产目录：latestModelOperation 与 repair-assets 都从那里读。
  // 写成 succeeded——它马上就会是（调用方随后落盘同一状态），写成 running 会让
  // 应用把这一代读成"还在跑"；`error` 同理不能带着上一次的失败原因。
  await writeJson(
    storage,
    `${finalDir}/${formatRequestSidecarName(sidecar.index, sidecar.slug)}`,
    RequestSidecarSchema,
    { ...sidecar, outputs, status: "succeeded", error: undefined },
  );

  const candidate = (await readCandidates(storage, projectSlug)).objects.find(
    (object) => object.slug === sidecar.slug,
  );
  const image = typeof sidecar.params.image === "string" ? sidecar.params.image : undefined;
  await publishGeneratedModel(
    storage,
    projectSlug,
    {
      slug: sidecar.slug,
      name: candidate?.name ?? sidecar.slug,
      intent: candidate?.description ?? "由请求侧写续跑恢复的 3D 模型",
      sourceImages: candidate?.sourceImages ?? (image ? [image] : []),
    },
    { files },
  );
  await mutateCandidates(storage, projectSlug, (current) => {
    const objects = current.objects.filter((object) => object.slug !== sidecar.slug);
    if (objects.length === current.objects.length) return undefined;
    return { ...current, objects, updatedAt: new Date().toISOString() };
  });
}

async function scanDir(
  storage: AssetStorage,
  dirPath: string,
  found: ResumableEntry[],
): Promise<void> {
  for (const name of await storage.list(dirPath)) {
    if (!parseRequestSidecarName(name)) continue;
    const path = `${dirPath}/${name}`;
    try {
      const sidecar = await readJson(storage, path, RequestSidecarSchema);
      // 超时（504）等失败会写成 failed，但只要有 providerTaskId 就仍可重新轮询续跑；
      // 漏掉它们会让「可凭侧写续跑」的超时侧写永远无法在清单里被发现。
      if (isResumableSidecar(sidecar)) {
        found.push({
          sidecarPath: path,
          provider: sidecar.provider,
          model: sidecar.model,
          slug: sidecar.slug,
          status: sidecar.status,
          hasProviderTaskId: Boolean(sidecar.providerTaskId),
        });
      }
    } catch {
      // 坏侧写不阻塞扫描
    }
  }
}

/**
 * 单个任务的 work 目录里有没有**已提交**（有 providerTaskId）的可续跑侧写。
 *
 * 重启自动续跑走这条路，不为此扫整个项目：事故恢复发生在任务列表这条 1 Hz 的读路径上，
 * 一次 readdir 与整个项目几十个目录的扫描是两种开销。没提交过的侧写（连 providerTaskId
 * 都没有）不算可续跑——续跑它等于重新付费，必须由用户/Agent 决定。
 */
export async function resumableSidecarForTask(
  storage: AssetStorage,
  projectSlug: string,
  taskId: string,
): Promise<ResumableEntry | undefined> {
  const found: ResumableEntry[] = [];
  await scanDir(storage, projectTaskWorkDir(projectSlug, taskId), found);
  return found.find((entry) => entry.hasProviderTaskId);
}

/** 扫描项目里所有可续跑的侧写（queued/running，或已提交但失败的 failed） */
export async function listResumableSidecars(
  storage: AssetStorage,
  projectSlug: string,
): Promise<ResumableEntry[]> {
  const found: ResumableEntry[] = [];
  await scanDir(storage, projectSourceDir(projectSlug), found);
  for (const assetSlug of await storage.list(projectAssetsDir(projectSlug))) {
    await scanDir(storage, assetDir(projectSlug, assetSlug), found);
  }
  // 中途死掉的任务：侧写还留在工作目录里（资产没发布，assets/ 下根本没有它）。
  // 漏了这一段，「凭侧写续跑（不重复付费）」就只是句空话——错误文案让用户去续跑，
  // 清单里却找不到（2026-10-02 三个火山 3D 任务的实际事故）。
  for (const name of await storage.list(projectTasksDir(projectSlug))) {
    if (name.endsWith(".json")) continue;
    await scanDir(storage, projectTaskWorkDir(projectSlug, name), found);
  }
  return found;
}

function extOf(url: string, fallback: string): string {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  return match ? match[1]!.toLowerCase() : fallback;
}


export interface ResumeResult {
  files: string[];
  sidecar: string;
}

export async function resumeGeneration(
  storage: AssetStorage,
  sidecarPath: string,
  keys: ResumeKeys,
  /**
   * 阶段推进回调。续跑也是长流程（轮询 + 下载几十 MB），不报阶段的话任务会全程停在
   * `queued`，看板上跟「卡死」长得一模一样——2026-09-26 的世界生成正是被这个坑到。
   */
  onPhase?: (phase: GenerationPhase) => void | Promise<void>,
): Promise<ResumeResult> {
  const sidecar = await readJson(storage, sidecarPath, RequestSidecarSchema);
  if (!["volcengine", "seed3d", "ark-hyper3d", "ark-hitem3d", "tripo", "hunyuan", "world-labs"].includes(sidecar.provider)) {
    throw new ChatServiceError(
      `供应商「${sidecar.provider}」已停用，无法续跑该历史任务`,
      409,
      "provider_unsupported",
    );
  }
  const dir = sidecarPath.split("/").slice(0, -1).join("/");
  const now = () => new Date().toISOString();
  const save = (patch: Partial<RequestSidecar>) =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, {
      ...sidecar,
      ...patch,
      updatedAt: now(),
    });

  // 已成功：只补齐缺失文件（等价 repair）
  if (sidecar.status === "succeeded") {
    // 这一支只补文件，不轮询供应商。
    await onPhase?.("downloading");
    const files: string[] = [];
    const outputs: RequestSidecar["outputs"] = [];
    for (const output of sidecar.outputs) {
      let path = output.path;
      if (["seed3d", "ark-hyper3d", "ark-hitem3d"].includes(sidecar.provider) && path.toLowerCase().endsWith(".zip")) {
        if (await storage.exists(path)) {
          path = await landSeed3dOutputBytes(storage, await storage.readBytes(path), {
            basePath: seed3dOutputBasePath(path),
            fallbackExtension: "glb",
          });
        } else if (output.providerUrl) {
          path = await downloadAndLandSeed3dOutput(storage, output.providerUrl, {
            basePath: seed3dOutputBasePath(path),
            fallbackExtension: "glb",
            fetchFn: keys.fetchFn,
          });
        }
      } else if (!(await storage.exists(path)) && output.providerUrl) {
        if (["seed3d", "ark-hyper3d", "ark-hitem3d"].includes(sidecar.provider)) {
          path = await downloadAndLandSeed3dOutput(storage, output.providerUrl, {
            basePath: seed3dOutputBasePath(path),
            fallbackExtension: path.split(".").pop()?.toLowerCase() as
              | "glb"
              | "gltf"
              | "obj"
              | "fbx"
              | "stl"
              | "usd"
              | "usdz",
            fetchFn: keys.fetchFn,
          });
        } else {
          await downloadToLibrary(storage, output.providerUrl, path, {
            fetchFn: keys.fetchFn,
          });
        }
      }
      files.push(path);
      outputs.push({ path, providerUrl: output.providerUrl });
    }
    if (["seed3d", "ark-hyper3d", "ark-hitem3d"].includes(sidecar.provider)) {
      await save({ outputs });
    }
    // 补文件的同时保证世界/天空盒在项目里登记过（幂等；已登记就不动当前指针）。
    if (sidecar.provider === "world-labs") {
      await registerResumedWorld(storage, projectSlugOf(sidecarPath), sidecar);
    } else if (sidecar.provider === "blockade-labs" && sidecar.model === "skybox/export") {
      await registerResumedSkybox(storage, projectSlugOf(sidecarPath), sidecar);
    }
    return { files, sidecar: sidecarPath };
  }

  if (!sidecar.providerTaskId) {
    throw new ChatServiceError(
      `侧写「${sidecarPath}」没有供应商任务 id，无法续跑，请重新生成`,
      409,
      "not_resumable",
    );
  }

  try {
    const outputs: RequestSidecar["outputs"] = [];
    const files: string[] = [];
    let downloadPhaseReported = false;
    const download = async (url: string, fileName: string) => {
      // 第一个文件开始下载时才切 downloading：之前的等待都在轮询供应商。
      if (!downloadPhaseReported) {
        downloadPhaseReported = true;
        await onPhase?.("downloading");
      }
      const path = `${dir}/${fileName}`;
      await downloadToLibrary(storage, url, path, { fetchFn: keys.fetchFn });
      files.push(path);
      outputs.push({ path, providerUrl: url });
    };
    /** Tripo/混元通用：扫描任务结果里的产物 URL 全部落盘（沿用原索引） */
    const landScannedUrls = async (value: unknown) => {
      const refs = extractFileUrls(value);
      const seen = new Set<string>();
      for (const ref of refs) {
        if (seen.has(ref.url)) continue;
        seen.add(ref.url);
        const ext = /\.([a-z0-9]+)(?:\?|$)/i.exec(ref.url)?.[1]?.toLowerCase() ?? "bin";
        await download(
          ref.url,
          formatIndexedName(
            sidecar.index,
            seen.size === 1 ? sidecar.slug : `${sidecar.slug}-f${seen.size}`,
            ext,
          ),
        );
      }
      if (files.length === 0) {
        throw new ChatServiceError("续跑结果中没有可下载文件", 502, "resume_no_files");
      }
    };

    if (sidecar.provider === "world-labs") {
      if (!keys.worldLabsApiKey) {
        throw new ChatServiceError("续跑世界生成需要 World Labs API key", 401, "missing_worldlabs_key");
      }
      const response = await pollMarbleOperation(sidecar.providerTaskId, {
        apiKey: keys.worldLabsApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
      });
      const worldJsonPath = `${dir}/${formatIndexedName(sidecar.index, sidecar.slug, "json")}`;
      await storage.writeText(worldJsonPath, JSON.stringify(response, null, 2));
      files.push(worldJsonPath);
      outputs.push({ path: worldJsonPath });
      const urls = extractWorldAssetUrls(response);
      if (urls.glb)
        await download(urls.glb, formatIndexedName(sidecar.index, sidecar.slug, "glb"));
      if (urls.pano)
        await download(
          urls.pano,
          formatIndexedName(sidecar.index, `${sidecar.slug}-pano`, extOf(urls.pano, "png")),
        );
      if (urls.thumbnail)
        await download(
          urls.thumbnail,
          formatIndexedName(
            sidecar.index,
            `${sidecar.slug}-thumbnail`,
            extOf(urls.thumbnail, "webp"),
          ),
        );
      for (const [key, url] of Object.entries(urls.spz)) {
        // 与首次生成同一条口径：legacy SPZ 落盘前转 v4（见 common/spz.ts）
        const path = `${dir}/${formatIndexedName(
          sidecar.index,
          `${sidecar.slug}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          "spz",
        )}`;
        await downloadSpzToLibrary(storage, url, path, { fetchFn: keys.fetchFn });
        files.push(path);
        outputs.push({ path, providerUrl: url });
      }
    } else if (sidecar.provider === "tripo") {
      if (!keys.tripo3dApiKey) {
        throw new ChatServiceError("续跑 Tripo 任务需要 Tripo3D API key", 401, "missing_tripo_key");
      }
      const data = await waitForTripoTask(sidecar.providerTaskId, {
        apiKey: keys.tripo3dApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
      });
      await landScannedUrls(data.output ?? data);
    } else if (sidecar.provider === "hunyuan") {
      if (sidecar.model !== "SubmitHunyuanTo3DUVJob") {
        throw new ChatServiceError(
          `混元能力「${sidecar.model}」已停用；当前只保留 UV 展开续跑`,
          409,
          "provider_unsupported",
        );
      }
      if (!keys.hunyuanApiKey) {
        throw new ChatServiceError(
          "续跑 UV 展开需要本机 HUNYUAN_KEY（SecretId:SecretKey）",
          401,
          "missing_hunyuan_key",
        );
      }
      const result = await waitForHunyuanJob("DescribeHunyuanTo3DUVJob", sidecar.providerTaskId, {
        apiKey: keys.hunyuanApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
      });
      await landScannedUrls(result);
    } else if (["seed3d", "ark-hyper3d", "ark-hitem3d"].includes(sidecar.provider)) {
      if (!keys.seed3dApiKey) {
        throw new ChatServiceError(
          "续跑火山 3D 任务需要本机 VOLC_KEY",
          401,
          "missing_seed3d_key",
        );
      }
      const result = await waitForSeed3dTask(sidecar.providerTaskId, {
        apiKey: keys.seed3dApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
      });
      let seq = 0;
      for (const url of extractSeed3dFileUrls(result)) {
        seq += 1;
        const fileSlug = seq === 1 ? sidecar.slug : `${sidecar.slug}-f${seq}`;
        const path = await downloadAndLandSeed3dOutput(storage, url, {
          basePath: `${dir}/${sidecar.index}-${fileSlug}`,
          fallbackExtension:
            typeof sidecar.params.file_format === "string"
              ? (sidecar.params.file_format as "glb" | "obj" | "usd" | "usdz")
              : "glb",
          fetchFn: keys.fetchFn,
        });
        files.push(path);
        outputs.push({ path, providerUrl: url });
      }
      if (files.length === 0) {
        throw new ChatServiceError("续跑结果中没有可下载文件", 502, "resume_no_files");
      }
    } else if (sidecar.provider === "blockade-labs") {
      if (!keys.blockadeLabsApiKey) {
        throw new ChatServiceError(
          "续跑天空盒任务需要 Blockade Labs API key",
          401,
          "missing_blockadelabs_key",
        );
      }
      const pollOptions = {
        apiKey: keys.blockadeLabsApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
      };
      // 两段链式（生成→导出）各自独立侧写：v1 只重新轮询自己这一段，不会从
      // "生成成功但导出失败"自动接着跑导出——续跑粒度就是单个侧写，跟现有语义一致。
      if (sidecar.model === "skybox/generate") {
        const requestId = sidecar.params.requestId;
        if (typeof requestId !== "string") {
          throw new ChatServiceError(
            "侧写缺少生成阶段的 requestId，无法续跑，请重新生成",
            409,
            "not_resumable",
          );
        }
        const result = await pollSkyboxGenerate(requestId, pollOptions);
        await download(result.fileUrl, formatIndexedName(sidecar.index, sidecar.slug, "png"));
      } else if (sidecar.model === "skybox/export") {
        const result = await pollSkyboxExport(sidecar.providerTaskId, pollOptions);
        await download(result.fileUrl, formatIndexedName(sidecar.index, sidecar.slug, "hdr"));
      } else {
        throw new ChatServiceError(
          `不认识的天空盒阶段「${sidecar.model}」，无法续跑`,
          409,
          "not_resumable",
        );
      }
    } else {
      throw new ChatServiceError(
        `不认识的供应商「${sidecar.provider}」，无法续跑`,
        409,
        "not_resumable",
      );
    }

    // 世界/天空盒的续跑也要登记资产身份，否则文件在、界面里却没有这个资产。
    if (sidecar.provider === "world-labs") {
      await registerResumedWorld(storage, projectSlugOf(sidecarPath), sidecar);
    } else if (sidecar.provider === "blockade-labs" && sidecar.model === "skybox/export") {
      await registerResumedSkybox(storage, projectSlugOf(sidecarPath), sidecar);
    } else if (MODEL_PROVIDERS.has(sidecar.provider)) {
      // 模型类同理：中途死掉的任务侧写在 tasks/<id>/work 里，只落文件等于什么都没恢复。
      await publishResumedModel(
        storage,
        projectSlugOf(sidecarPath),
        sidecarPath,
        sidecar,
        files,
        outputs,
      );
    }

    sidecar.outputs = outputs;
    sidecar.status = "succeeded";
    // 上一次失败留下的原因不能跟着一个成功的状态走：`error` 是"这次为什么失败"，
    // 不是历史。清掉它，看板和 repair 的输出才不会被旧文案误导。
    sidecar.error = undefined;
    await save({});
    return { files, sidecar: sidecarPath };
  } catch (err) {
    await save({ status: "failed", error: toErrorMessage(err) });
    throw err;
  }
}

// ---------- Mastra tool 包装 ----------

export const resumeGenerationTool = createTool({
  id: "resume-generation",
  description:
    "凭当前项目的请求侧写续跑中断的生成任务（不重新提交、不重复花钱）：接续轮询供应商任务并把产物落盘",
  inputSchema: z.object({
    sidecarPath: LogicalPathSchema,
  }),
  execute: async (input, context) => {
    const projectSlug = requireCurrentProject(context);
    if (!input.sidecarPath.startsWith(`projects/${projectSlug}/`)) {
      throw new ChatServiceError("只能续跑当前项目中的生成任务", 403, "project_scope_violation");
    }
    return resumeGeneration(getAssetStorage(), input.sidecarPath, {
      worldLabsApiKey: optionalContextString(context, "worldLabsApiKey"),
      tripo3dApiKey: optionalContextString(context, "tripo3dApiKey"),
      hunyuanApiKey: optionalContextString(context, "hunyuanApiKey"),
      seed3dApiKey:
        optionalContextString(context, "seed3dApiKey") ??
        optionalContextString(context, "volcengineApiKey"),
      blockadeLabsApiKey: optionalContextString(context, "blockadeLabsApiKey"),
    });
  },
});

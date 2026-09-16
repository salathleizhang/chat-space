import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  parseRequestSidecarName,
} from "../../common/indexedFiles";
import {
  assetDir,
  projectAssetsDir,
  projectSourceDir,
} from "../../common/libraryPaths";
import {
  LogicalPathSchema,
  RequestSidecarSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  extractFileRefs,
  getFalQueueResult,
  waitForFalCompletion,
} from "../../models/fal";
import { pollSkyboxExport, pollSkyboxGenerate } from "../../models/blockadelabs";
import { waitForHunyuanJob } from "../../models/hunyuan";
import { extractSeed3dFileUrls, waitForSeed3dTask } from "../../models/seed3d";
import {
  extractMeshyFileUrls,
  waitForMeshyTask,
  type MeshyCapabilityPath,
} from "../../models/meshy";
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
import { downloadToLibrary } from "./assetRepair";
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
  falApiKey?: string;
  worldLabsApiKey?: string;
  meshyApiKey?: string;
  tripo3dApiKey?: string;
  /** "SecretId:SecretKey" */
  hunyuanApiKey?: string;
  seed3dApiKey?: string;
  blockadeLabsApiKey?: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
}

/** 混元 Submit → 查询 Action 的特例映射（其余按 Submit→Describe 规则） */
const HUNYUAN_QUERY_BY_SUBMIT: Record<string, string> = {
  SubmitHunyuanTo3DProJob: "QueryHunyuanTo3DProJob",
  SubmitHunyuan3DPartJob: "QueryHunyuan3DPartJob",
};

export interface ResumableEntry {
  sidecarPath: string;
  provider: string;
  model: string;
  slug: string;
  status: string;
  hasProviderTaskId: boolean;
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
      const hasProviderTaskId = Boolean(sidecar.providerTaskId);
      if (
        sidecar.status === "queued" ||
        sidecar.status === "running" ||
        (sidecar.status === "failed" && hasProviderTaskId)
      ) {
        found.push({
          sidecarPath: path,
          provider: sidecar.provider,
          model: sidecar.model,
          slug: sidecar.slug,
          status: sidecar.status,
          hasProviderTaskId,
        });
      }
    } catch {
      // 坏侧写不阻塞扫描
    }
  }
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
  return found;
}

function extOf(url: string, fallback: string): string {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  return match ? match[1]!.toLowerCase() : fallback;
}

const MODEL_EXT_RE = /\.(glb|obj|fbx|usdz)(\?|$)/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)(\?|$)/i;

export interface ResumeResult {
  files: string[];
  sidecar: string;
}

export async function resumeGeneration(
  storage: AssetStorage,
  sidecarPath: string,
  keys: ResumeKeys,
): Promise<ResumeResult> {
  const sidecar = await readJson(storage, sidecarPath, RequestSidecarSchema);
  if (!["volcengine", "seed3d", "ark-hyper3d", "ark-hitem3d", "tripo", "world-labs"].includes(sidecar.provider)) {
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
    const download = async (url: string, fileName: string) => {
      const path = `${dir}/${fileName}`;
      await downloadToLibrary(storage, url, path, { fetchFn: keys.fetchFn });
      files.push(path);
      outputs.push({ path, providerUrl: url });
    };
    /** meshy/tripo/hunyuan 通用：扫描任务结果里的产物 URL 全部落盘（沿用原索引） */
    const landScannedUrls = async (value: unknown) => {
      const refs = extractMeshyFileUrls(value);
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
        await download(
          url,
          formatIndexedName(
            sidecar.index,
            `${sidecar.slug}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            "spz",
          ),
        );
      }
    } else if (sidecar.provider === "fal") {
      if (!keys.falApiKey) {
        throw new ChatServiceError("续跑 FAL 任务需要 fal.ai API key", 401, "missing_fal_key");
      }
      const options = {
        apiKey: keys.falApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
      };
      const submission = {
        requestId: sidecar.providerTaskId,
        submittedAt: sidecar.createdAt,
      };
      await waitForFalCompletion(sidecar.model, submission, options);
      const result = await getFalQueueResult(sidecar.model, submission, options);
      const refs = extractFileRefs(result);
      const primary =
        refs.find((r) => MODEL_EXT_RE.test(r.url)) ??
        refs.find(
          (r) => r.contentType?.startsWith("image/") || IMAGE_EXT_RE.test(r.url),
        );
      if (!primary) {
        throw new ChatServiceError("续跑结果中没有可下载文件", 502, "resume_no_files");
      }
      await download(
        primary.url,
        formatIndexedName(sidecar.index, sidecar.slug, extOf(primary.url, "bin")),
      );
      let seq = 0;
      for (const ref of refs) {
        if (ref === primary) continue;
        if (!MODEL_EXT_RE.test(ref.url) && !IMAGE_EXT_RE.test(ref.url)) continue;
        seq += 1;
        await download(
          ref.url,
          formatIndexedName(
            sidecar.index,
            `${sidecar.slug}-f${seq}`,
            extOf(ref.url, "bin"),
          ),
        );
      }
    } else if (sidecar.provider === "meshy") {
      if (!keys.meshyApiKey) {
        throw new ChatServiceError("续跑 Meshy 任务需要 Meshy API key", 401, "missing_meshy_key");
      }
      const task = await waitForMeshyTask(
        sidecar.model as MeshyCapabilityPath,
        sidecar.providerTaskId,
        {
          apiKey: keys.meshyApiKey,
          fetchFn: keys.fetchFn,
          pollIntervalMs: keys.pollIntervalMs,
        },
      );
      await landScannedUrls(task);
    } else if (sidecar.provider === "tripo") {
      if (!keys.tripo3dApiKey) {
        throw new ChatServiceError("续跑 Tripo 任务需要 Tripo3D API key", 401, "missing_tripo_key");
      }
      const data = await waitForTripoTask(sidecar.providerTaskId, {
        apiKey: keys.tripo3dApiKey,
        fetchFn: keys.fetchFn,
        pollIntervalMs: keys.pollIntervalMs,
        v3: sidecar.model.includes("v3/"),
      });
      await landScannedUrls(data.output ?? data);
    } else if (sidecar.provider === "hunyuan") {
      if (!keys.hunyuanApiKey) {
        throw new ChatServiceError(
          "续跑混元任务需要混元 API key（SecretId:SecretKey）",
          401,
          "missing_hunyuan_key",
        );
      }
      const queryAction =
        HUNYUAN_QUERY_BY_SUBMIT[sidecar.model] ?? sidecar.model.replace(/^Submit/, "Describe");
      const result = await waitForHunyuanJob(queryAction, sidecar.providerTaskId, {
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

    sidecar.outputs = outputs;
    sidecar.status = "succeeded";
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
      falApiKey: optionalContextString(context, "falApiKey"),
      worldLabsApiKey: optionalContextString(context, "worldLabsApiKey"),
      meshyApiKey: optionalContextString(context, "meshyApiKey"),
      tripo3dApiKey: optionalContextString(context, "tripo3dApiKey"),
      hunyuanApiKey: optionalContextString(context, "hunyuanApiKey"),
      seed3dApiKey:
        optionalContextString(context, "seed3dApiKey") ??
        optionalContextString(context, "volcengineApiKey"),
      blockadeLabsApiKey: optionalContextString(context, "blockadeLabsApiKey"),
    });
  },
});

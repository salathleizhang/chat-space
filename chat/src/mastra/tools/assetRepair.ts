import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError } from "../../common/errors";
import { DOWNLOAD_REQUEST_TIMEOUT_MS, fetchWithTimeout, isTimeoutError } from "../../common/http";
import { parseRequestSidecarName } from "../../common/indexedFiles";
import {
  assetDir,
  projectAssetsDir,
  projectSourceDir,
} from "../../common/libraryPaths";
import { RequestSidecarSchema, SlugSchema, isResumableSidecar } from "../../dto/library";
import {
  getAssetStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { requireCurrentProject } from "./requestContext";
import {
  downloadAndLandSeed3dOutput,
  landSeed3dOutputBytes,
  seed3dOutputBasePath,
} from "./seed3dOutput";

export interface DownloadOptions {
  fetchFn?: typeof fetch;
}

/** 显式下载：把远程文件写进资产库（磁盘优先的执行者） */
export async function downloadToLibrary(
  storage: AssetStorage,
  url: string,
  targetPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchWithTimeout(
    fetchFn,
    url,
    undefined,
    DOWNLOAD_REQUEST_TIMEOUT_MS,
    "产物下载",
  );
  if (!response.ok) {
    throw new ChatServiceError(
      `下载失败（${response.status}）：${url}`,
      502,
      "download_failed",
    );
  }
  try {
    // 超时信号覆盖响应体读取：连接不断但不传数据时也要在这里中止，不能无限等。
    await storage.writeBytes(targetPath, new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new ChatServiceError(`产物下载超时：${url}`, 504, "download_timeout");
    }
    throw error;
  }
}

export interface RepairReport {
  checkedSidecars: number;
  repaired: string[];
  /** 本地缺失且侧写里没有可用 providerUrl，需要重新生成 */
  unrecoverable: string[];
  /**
   * 已提交但没跑完的侧写（queued/running，或失败但有 providerTaskId）。
   * 这些必须先走 `resume-generation` 接续轮询与下载，**不要重新提交**——供应商侧
   * 可能早就完成，重新提交就是重复付费（2026-09-26 的 Tripo 批量任务正是如此）。
   */
  resumable: string[];
}

async function repairDir(
  storage: AssetStorage,
  dirPath: string,
  report: RepairReport,
  options: DownloadOptions,
): Promise<void> {
  for (const name of await storage.list(dirPath)) {
    if (!parseRequestSidecarName(name)) continue;
    const sidecarPath = `${dirPath}/${name}`;
    const sidecar = await readJson(storage, sidecarPath, RequestSidecarSchema);
    report.checkedSidecars += 1;
    if (isResumableSidecar(sidecar)) report.resumable.push(sidecarPath);
    const outputs: typeof sidecar.outputs = [];
    let outputsChanged = false;
    for (const output of sidecar.outputs) {
      let path = output.path;
      const exists = await storage.exists(path);
      if (sidecar.provider === "seed3d" && path.toLowerCase().endsWith(".zip")) {
        if (exists) {
          path = await landSeed3dOutputBytes(storage, await storage.readBytes(path), {
            basePath: seed3dOutputBasePath(path),
            fallbackExtension: "glb",
          });
          report.repaired.push(path);
        } else if (output.providerUrl) {
          path = await downloadAndLandSeed3dOutput(storage, output.providerUrl, {
            basePath: seed3dOutputBasePath(path),
            fallbackExtension: "glb",
            fetchFn: options.fetchFn,
          });
          report.repaired.push(path);
        } else {
          report.unrecoverable.push(path);
        }
      } else if (!exists && output.providerUrl) {
        if (sidecar.provider === "seed3d") {
          path = await downloadAndLandSeed3dOutput(storage, output.providerUrl, {
            basePath: seed3dOutputBasePath(path),
            fallbackExtension: "glb",
            fetchFn: options.fetchFn,
          });
        } else {
          await downloadToLibrary(storage, output.providerUrl, path, options);
        }
        report.repaired.push(path);
      } else if (!exists) {
        report.unrecoverable.push(path);
      }
      if (path !== output.path) outputsChanged = true;
      outputs.push({ path, providerUrl: output.providerUrl });
    }
    if (outputsChanged) {
      await writeJson(storage, sidecarPath, RequestSidecarSchema, {
        ...sidecar,
        outputs,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

/**
 * 本地资产修复：按已记录的请求侧写补齐缺失文件。
 * 修复 ≠ 重生成——不产生新索引，只回填（决策 4、§5 失败恢复）。
 */
export async function repairProjectAssets(
  storage: AssetStorage,
  projectSlug: string,
  options: DownloadOptions & { assetSlug?: string } = {},
): Promise<RepairReport> {
  const report: RepairReport = {
    checkedSidecars: 0,
    repaired: [],
    unrecoverable: [],
    resumable: [],
  };

  if (options.assetSlug) {
    await repairDir(storage, assetDir(projectSlug, options.assetSlug), report, options);
    return report;
  }

  await repairDir(storage, projectSourceDir(projectSlug), report, options);
  for (const assetSlug of await storage.list(projectAssetsDir(projectSlug))) {
    await repairDir(storage, assetDir(projectSlug, assetSlug), report, options);
  }
  return report;
}

// ---------- Mastra tool 包装 ----------

export const repairAssetsTool = createTool({
  id: "repair-assets",
  description:
    "按请求侧写补齐当前项目里缺失的本地文件（修复不产生新索引）。返回 resumable 的侧写必须先用 resume-generation 接续（供应商侧可能已完成，重新提交等于重复付费），unrecoverable 的才需要走原 workflow 重生成",
  inputSchema: z.object({
    assetSlug: SlugSchema.optional(),
  }),
  execute: async (input, context) =>
    repairProjectAssets(getAssetStorage(), requireCurrentProject(context), {
      assetSlug: input.assetSlug,
    }),
});

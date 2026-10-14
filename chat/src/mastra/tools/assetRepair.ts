import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { downloadBytesWithRetry } from "../../common/download";
import { ensureSpzV4, type SpzConversion } from "../../common/spz";
import { parseRequestSidecarName } from "../../common/indexedFiles";
import {
  assetDir,
  projectAssetsDir,
  projectSourceDir,
  projectTaskWorkDir,
  projectTasksDir,
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
  /** 单次尝试的预算；默认 DOWNLOAD_REQUEST_TIMEOUT_MS */
  requestTimeoutMs?: number;
  /** 尝试次数（含首次）；默认 DOWNLOAD_MAX_ATTEMPTS */
  maxAttempts?: number;
}

/**
 * 显式下载：把远程文件写进资产库（磁盘优先的执行者）。
 *
 * 重试与断点续传都在 `downloadBytesWithRetry` 里：链路抖一下不该让整条任务白跑。
 */
export async function downloadToLibrary(
  storage: AssetStorage,
  url: string,
  targetPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  await storage.writeBytes(targetPath, await downloadBytesWithRetry(url, options));
}

/**
 * 下载一件 **splat 产物**（`.spz`）并按需转成引擎认的 **v4** 再落盘。
 *
 * 上游（World Labs）下发的是 legacy v2/v3（整段 gzip），而 PlayCanvas 引擎的解析器**只认 v4**
 * ——不转的话 PC 分支稳定报 `No parser found for resource`，房间/背景整块不渲染。
 * three 侧两种都能读，所以统一存 v4 对两边都合法（见 `common/spz.ts` 文件头）。
 *
 * **转不了就保留原样**（没装工具 / 转换抛错 / 产物不合法都会走这条），资产不因为缺工具而丢；
 * 调用方拿返回值知道发生了什么，不必自己再嗅一遍魔数。
 */
export async function downloadSpzToLibrary(
  storage: AssetStorage,
  url: string,
  targetPath: string,
  options: DownloadOptions = {},
): Promise<SpzConversion> {
  const bytes = await downloadBytesWithRetry(url, options);
  const conversion = await ensureSpzV4(bytes);
  await storage.writeBytes(targetPath, conversion.bytes);
  if (conversion.reason) {
    console.warn(`[spz] ${targetPath} 保持原样（${conversion.reason}）`);
  } else if (conversion.converted) {
    console.info(`[spz] ${targetPath} 已转为 v4（${bytes.byteLength} → ${conversion.bytes.byteLength} 字节）`);
  }
  return conversion;
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
        } else if (path.toLowerCase().endsWith(".spz")) {
          // 补下来的也是上游的 legacy SPZ：与首次生成同一条口径（见 common/spz.ts）
          await downloadSpzToLibrary(storage, output.providerUrl, path, options);
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
  // 中途死掉的任务：侧写留在工作目录里、资产还没发布（assets/ 下没有它）。
  // 不扫这一段，最需要「先续跑、别重新提交」的那类侧写反而不会出现在 resumable 里
  // ——2026-10-02 三个已生成成功的火山 3D 任务就是这么被漏掉的。
  for (const name of await storage.list(projectTasksDir(projectSlug))) {
    if (name.endsWith(".json")) continue;
    await repairDir(storage, projectTaskWorkDir(projectSlug, name), report, options);
  }
  return report;
}

// ---------- Mastra tool 包装 ----------

export const repairAssetsTool = createTool({
  id: "repair-assets",
  description:
    "Backfill local files missing from the current project using the request sidecars (repair creates no new index). Sidecars returned in resumable must first be continued with resume-generation (the provider side may already be done, so resubmitting means paying twice); only the unrecoverable ones need the original workflow to regenerate",
  inputSchema: z.object({
    assetSlug: SlugSchema.optional(),
  }),
  execute: async (input, context) =>
    repairProjectAssets(getAssetStorage(), requireCurrentProject(context), {
      assetSlug: input.assetSlug,
    }),
});

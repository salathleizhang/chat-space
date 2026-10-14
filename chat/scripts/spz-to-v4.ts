/**
 * 把历史项目里的 legacy `.spz`（World Labs 下发的 v2/v3，整段 gzip）补转成 **v4**。
 *
 * 用法：
 *   bun run scripts/spz-to-v4.ts [--dry-run] [--tool <模块路径>] [根目录...]
 *
 * - 根目录默认 `~/ChatSpace/projects`；逐个匹配 `<root>/<project>/assets/<asset>/N-*.spz`。
 * - 已经是 v4 的跳过；不是 gzip 的也跳过（不猜格式）。
 * - **转换前先备份**：原文件复制到同资产的 `.spz-legacy/<原名>`（点开头 ⇒ 不被资产库当产物列出），
 *   **校验通过后才**替换原路径；校验失败就整件回滚（原文件不动）。
 * - 校验：产物是 v4，且 `numPoints` / `shDegree` 与源文件（gunzip 后读头）一致。
 * - 转换器默认走 `@playcanvas/splat-transform`；没装时可以用 `--tool`（或 `SPLAT_TRANSFORM_PATH`）
 *   指向一份本地已装的副本，例如
 *   `--tool /path/to/node_modules/@playcanvas/splat-transform/dist/index.mjs`。
 *
 * 退出码：0 = 全部成功（或无事可做）；1 = 有失败项。
 */
import { gunzipSync } from "node:zlib";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureSpzV4, isLegacyGzipSpz, isSpzV4, loadSpzConverter } from "../src/common/spz";

interface Header {
  version: number;
  numPoints: number;
  shDegree: number;
}

/** 读 v4 的明文头。 */
function readV4Header(bytes: Uint8Array): Header {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { version: view.getUint32(4, true), numPoints: view.getUint32(8, true), shDegree: bytes[12] ?? -1 };
}

/** 读 legacy 的头：整段 gzip，先解压再按同一布局读。 */
function readLegacyHeader(bytes: Uint8Array): Header {
  const raw = new Uint8Array(gunzipSync(bytes));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  return { version: view.getUint32(4, true), numPoints: view.getUint32(8, true), shDegree: raw[12] ?? -1 };
}

interface Entry {
  path: string;
  status: "converted" | "already-v4" | "unrecognised" | "failed";
  bytesIn?: number;
  bytesOut?: number;
  points?: number;
  legacyVersion?: number;
  backup?: string;
  reason?: string;
  ms?: number;
}

async function listSpzFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return found;
  }
  for (const project of projects) {
    const assetsDir = join(root, project, "assets");
    let assets: string[];
    try {
      assets = await readdir(assetsDir);
    } catch {
      continue;
    }
    for (const asset of assets) {
      const dir = join(assetsDir, asset);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        // 只认资产产物命名（`N-*.spz`）；点开头的备份/隐藏文件一律不看
        if (!/^\d+-.*\.spz$/i.test(file)) continue;
        found.push(join(dir, file));
      }
    }
  }
  return found.sort();
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const toolIndex = argv.indexOf("--tool");
  const toolArg = toolIndex >= 0 ? argv[toolIndex + 1] : process.env.SPLAT_TRANSFORM_PATH;
  const roots = argv.filter((arg, i) => !arg.startsWith("--") && i !== toolIndex + 1);
  const searchRoots = (roots.length > 0 ? roots : [join(homedir(), "ChatSpace", "projects")]).map((r) => resolve(r));

  const modulePath = toolArg ? pathToFileURL(resolve(toolArg)).href : undefined;
  const converter = await loadSpzConverter(modulePath);
  if (!converter) {
    console.error(
      "[spz-to-v4] cannot get the converter: install `@playcanvas/splat-transform`, " +
      "or point `--tool <…/splat-transform/dist/index.mjs>` (SPLAT_TRANSFORM_PATH also works) at a local copy.",
    );
    return 1;
  }

  const entries: Entry[] = [];
  for (const root of searchRoots) {
    for (const path of await listSpzFiles(root)) {
      const bytes = new Uint8Array(await readFile(path));
      if (isSpzV4(bytes)) {
        entries.push({ path, status: "already-v4", bytesIn: bytes.byteLength });
        continue;
      }
      if (!isLegacyGzipSpz(bytes)) {
        entries.push({ path, status: "unrecognised", bytesIn: bytes.byteLength, reason: "neither v4 nor gzip" });
        continue;
      }
      if (dryRun) {
        const header = readLegacyHeader(bytes);
        entries.push({
          path, status: "converted", bytesIn: bytes.byteLength,
          legacyVersion: header.version, points: header.numPoints, reason: "dry-run",
        });
        continue;
      }

      const started = Date.now();
      const legacyHeader = readLegacyHeader(bytes);
      const result = await ensureSpzV4(bytes, converter);
      if (!result.converted) {
        entries.push({ path, status: "failed", bytesIn: bytes.byteLength, reason: result.reason ?? "unknown" });
        continue;
      }
      const outHeader = readV4Header(result.bytes);
      if (outHeader.numPoints !== legacyHeader.numPoints || outHeader.shDegree !== legacyHeader.shDegree) {
        entries.push({
          path, status: "failed", bytesIn: bytes.byteLength,
          reason: `verification mismatch: points ${legacyHeader.numPoints} → ${outHeader.numPoints}, sh ${legacyHeader.shDegree} → ${outHeader.shDegree}`,
        });
        continue;
      }

      // 先备份（点开头的目录 ⇒ 资产库不会把它当产物），再写回；写回失败就还原
      const backupDir = join(dirname(path), ".spz-legacy");
      const backup = join(backupDir, path.split("/").pop()!);
      await mkdir(backupDir, { recursive: true });
      await copyFile(path, backup);
      try {
        await writeFile(path, result.bytes);
      } catch (error) {
        await copyFile(backup, path);
        entries.push({ path, status: "failed", bytesIn: bytes.byteLength, reason: `write-back failed: ${String(error)}` });
        continue;
      }
      entries.push({
        path, status: "converted", bytesIn: bytes.byteLength, bytesOut: result.bytes.byteLength,
        points: outHeader.numPoints, legacyVersion: legacyHeader.version, backup, ms: Date.now() - started,
      });
    }
  }

  const converted = entries.filter((e) => e.status === "converted" && e.reason !== "dry-run");
  const pending = entries.filter((e) => e.status === "converted");
  const failed = entries.filter((e) => e.status === "failed");
  const report = {
    dryRun,
    converter: modulePath ?? "@playcanvas/splat-transform",
    roots: searchRoots,
    scanned: entries.length,
    converted: converted.length,
    /** 预演时的"待转"件数（真实运行时与 `converted` 相同） */
    pending: pending.length,
    alreadyV4: entries.filter((e) => e.status === "already-v4").length,
    failed: failed.length,
    entries,
  };
  console.log(JSON.stringify(report, null, 2));
  for (const entry of converted) {
    console.log(`[spz-to-v4] ${entry.path}: v${entry.legacyVersion} → v4, ${entry.points} points, ${entry.bytesIn} → ${entry.bytesOut} bytes (${entry.ms} ms)`);
  }
  for (const entry of failed) console.error(`[spz-to-v4] failed ${entry.path}: ${entry.reason}`);
  if (dryRun) console.log(`[spz-to-v4] dry run: ${pending.length} item(s) pending conversion, no files were written`);
  return failed.length > 0 ? 1 : 0;
}

// 直接跑才执行（被 import 时只暴露函数，便于测试）
if (import.meta.main) {
  const code = await main();
  process.exit(code);
}

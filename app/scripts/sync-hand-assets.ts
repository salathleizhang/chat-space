/**
 * 把手势模式要的**运行时资产**准备到 `app/public/mediapipe/<版本>/` 下（同源发布，不再走第三方 CDN）。
 *
 * 跑法：`bun run sync:hand`（`app/package.json` 的 `dev` / `build` 都会先跑一次，所以不用记）。
 *
 * ### 各文件从哪来
 * - **wasm（2 个文件）**：`node_modules/@mediapipe/tasks-vision/wasm/` 里的 SIMD 那一套。
 *   它随 npm 包发出，所以**零网络、零 git 体积**，而且版本天然与 js 运行时一致
 *   （这正是以前"CDN 版本号靠一条单测盯着"要防的那类错配）。
 * - **模型 `hand_landmarker.task`**：**提交进仓库**（npm 包里没有它），这里只校验它的 sha256。
 *   7.82 MB 的二进制，来源与更新办法见 `app/public/mediapipe/README.md`。
 *
 * 三条会影响正确性的纪律：
 * ① 依赖版本与 `handAssets.ts` 的 `HAND_ASSET_VERSION` 必须一致——wasm 与 js 错配的报错
 *    是无意义的 `RuntimeError`，类型上不会暴露，所以在这里直接拒绝构建；
 * ② 每个文件的 sha256 都对钉子——"升级只改了一半""模型下到不完整"的症状都是运行时静默失败；
 * ③ **只发 SIMD 那一套**（理由见 `handAssets.ts` 的 `HAND_WASM_FILES`），非 SIMD 环境由 CDN 兜底。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HAND_ASSET_BASE,
  HAND_ASSET_VERSION,
  HAND_MODEL_SHA256,
  HAND_WASM_FILES,
  HAND_WASM_SHA256,
} from "../src/widgets/Viewport/handAssets";

/*
  产物里的布局（路径**由 handAssets.ts 决定**，这里只负责把它落到磁盘上）：

    app/public/mediapipe/0.10.17/hand_landmarker.task   ← 仓库里的模型，这里只校验
    app/public/mediapipe/0.10.17/wasm/vision_wasm_internal.{js,wasm}  ← 每次从 node_modules 复制

  版本号在路径里，是为了让 `vercel.json` 那条 `/mediapipe/*` 的 `immutable` 成立：
  换内容必然换 URL。所以这里**不允许**出现第二处版本号。
*/
const appDir = fileURLToPath(new URL("..", import.meta.url));
/** `/mediapipe/0.10.17` → `mediapipe/0.10.17`（web 路径不能直接当 fs 路径用） */
const assetRelDir = HAND_ASSET_BASE.replace(/^\/+/, "");
const assetDir = join(appDir, "public", assetRelDir);
const wasmOutDir = join(assetDir, "wasm");
const modelPath = join(assetDir, "hand_landmarker.task");

/**
 * 报错用 `process.exit(1)` 而不是 `throw`：这条脚本的前置条件是 `dev` / `build` 的第一步，
 * 退出码才是 CI 与 bun 读的东西；抛异常多打一坨栈，反而把"该改哪一处"埋掉。
 */
function fail(message: string): never {
  console.error(`[hand-assets] ${message}`);
  process.exit(1);
}

/** 按内容而不是"大小 + 时间戳"判定：换过版本的同名文件大小可能一样，mtime 又不可靠 */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * wasm 的来源目录。**读安装到的包，而不是 `app/package.json`**：后者写的是 semver 范围
 * （`0.10.17` 也可能被解析成别的补丁版），只有装到磁盘上的那份才是真正会被复制进产物的字节。
 * bun 可能把它 hoist 到仓库根，所以两个位置都看。
 */
function findPackageDir(): string {
  const candidates = [
    join(appDir, "node_modules/@mediapipe/tasks-vision"),
    join(appDir, "..", "node_modules/@mediapipe/tasks-vision"),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "package.json")));
  if (!found) {
    fail(
      "找不到 @mediapipe/tasks-vision：先 `bun install`（wasm 是从这个包里复制出来的，"
      + "不走网络下载）",
    );
  }
  return found;
}

/** 装到的包自报的版本；只用于与 `HAND_ASSET_VERSION` 对比（未知就报未知，不猜） */
async function readPinnedVersion(packageDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "(未知)";
}

/**
 * 把 SIMD 那一套 wasm 复制进 `public/`，逐个文件先校验再落盘。
 *
 * **顺序不能反**：先写后校验的话，一旦依赖被换过，产物里留下的就是一份没人验证过的 wasm，
 * 而"复制过去了"本身看起来完全正常。已经一致的文件不重写——`dev` 每次启动都会跑这条脚本，
 * 没必要每回都动 9.5 MB 的 mtime（那会让 Vite / 增量构建认为整棵树变了）。
 */
async function copyWasm(packageDir: string): Promise<string[]> {
  await mkdir(wasmOutDir, { recursive: true });
  const lines: string[] = [];
  for (const name of HAND_WASM_FILES) {
    const bytes = new Uint8Array(await readFile(join(packageDir, "wasm", name)));
    const digest = sha256(bytes);
    const expected = HAND_WASM_SHA256[name];
    if (digest !== expected) {
      fail(
        `依赖里的 ${name} 与钉子不一致（实际 ${digest}，期望 ${expected}）。`
        + `这通常意味着 @mediapipe/tasks-vision 被换过版本——请确认版本为 ${HAND_ASSET_VERSION}，`
        + "若确实要升级，就连同 HAND_ASSET_VERSION 与模型文件一起改（见 app/public/mediapipe/README.md）。",
      );
    }
    const target = join(wasmOutDir, name);
    const existing = existsSync(target) ? new Uint8Array(await readFile(target)) : null;
    if (existing && sha256(existing) === digest) {
      lines.push(`${name}（已是最新）`);
      continue;
    }
    await writeFile(target, bytes);
    lines.push(`${name}（${(bytes.byteLength / 1e6).toFixed(2)} MB）`);
  }
  return lines;
}

/**
 * 校验（不下载、不复制）仓库里那份模型。
 *
 * 两种失败要分开报：**文件不在**（多半是被 `.gitignore` 连带忽略掉、或误删）与
 * **哈希不符**（被换过 / 下到一半）。两者的处理动作不同，所以文案里直接给出可粘贴的
 * `curl` 与期望哈希——这条脚本的读者通常是几周后升级 MediaPipe 的自己。
 */
async function checkModel(): Promise<string> {
  if (!existsSync(modelPath)) {
    fail(
      `缺少 ${assetRelDir}/hand_landmarker.task。它是**提交进仓库**的文件，正常情况下不该缺；`
      + "重新取一份：\n"
      + "  curl -o app/public/" + assetRelDir + "/hand_landmarker.task \\\n"
      + "    https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
      + `\n  期望 sha256 = ${HAND_MODEL_SHA256}`,
    );
  }
  const bytes = new Uint8Array(await readFile(modelPath));
  const digest = sha256(bytes);
  if (digest !== HAND_MODEL_SHA256) {
    fail(
      `hand_landmarker.task 的 sha256 不匹配（实际 ${digest}，期望 ${HAND_MODEL_SHA256}）：`
      + "文件被换过或不完整。重新按 app/public/mediapipe/README.md 取一份，并同步更新钉子。",
    );
  }
  return `hand_landmarker.task（${(bytes.byteLength / 1e6).toFixed(2)} MB，已提交在仓库里）`;
}

/*
  顶层直接跑（不是 `main()`）：这条脚本没有可复用的导出，被 import 的唯一可能是复制它。
  **顺序有意义**——先对版本，再复制 wasm，最后校验模型：版本不对时后面两步读的是不该用的字节，
  早点失败才不会留下"复制好了但版本是错的"这种半成品目录。
*/
const packageDir = findPackageDir();
const installed = await readPinnedVersion(packageDir);
if (installed !== HAND_ASSET_VERSION) {
  fail(
    `@mediapipe/tasks-vision 装到的是 ${installed}，但 handAssets.ts 写的是 ${HAND_ASSET_VERSION}。`
    + "wasm 与 js 必须同版本（0.10.x 里接口动过，错配不会在类型上暴露、只在运行时炸）。"
    + "升级时：改 handAssets.ts 的 HAND_ASSET_VERSION → 重新放模型文件 → 更新两个 sha256 钉子。",
  );
}

const copied = await copyWasm(packageDir);
const model = await checkModel();
console.log(`[hand-assets] ${HAND_ASSET_VERSION} 就绪：${copied.join("、")}；${model}`);

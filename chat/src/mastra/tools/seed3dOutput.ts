import JSZip from "jszip";
import { ChatServiceError } from "../../common/errors";
import { downloadBytesWithRetry } from "../../common/download";
import type { AssetStorage } from "../../services/assetStorage";

const MODEL_EXTENSIONS = ["glb", "gltf", "obj", "fbx", "stl", "usd", "usdz"] as const;
type ModelExtension = (typeof MODEL_EXTENSIONS)[number];

const MODEL_EXTENSION_RE = new RegExp(`\\.(${MODEL_EXTENSIONS.join("|")})$`, "i");

function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (
    (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08)
  );
}

function assertValidModelBytes(bytes: Uint8Array, ext: ModelExtension): void {
  if (
    ext === "glb" &&
    !(
      bytes.length >= 4 &&
      bytes[0] === 0x67 &&
      bytes[1] === 0x6c &&
      bytes[2] === 0x54 &&
      bytes[3] === 0x46
    )
  ) {
    throw new ChatServiceError(
      "Seed3D GLB 产物缺少有效的 glTF 文件头",
      502,
      "seed3d_invalid_glb",
    );
  }
}

function modelExtension(name: string): ModelExtension | undefined {
  return MODEL_EXTENSION_RE.exec(name)?.[1]?.toLowerCase() as ModelExtension | undefined;
}

function archiveEntryPriority(name: string): number {
  const normalized = name.replace(/^\/+/, "").toLowerCase();
  if (normalized === "pbr/mesh_textured_pbr.glb") return 0;
  if (normalized.endsWith("/mesh_textured_pbr.glb")) return 1;
  const ext = modelExtension(normalized);
  const order: ModelExtension[] = ["glb", "gltf", "obj", "fbx", "stl", "usdz", "usd"];
  return ext ? 10 + order.indexOf(ext) : Number.MAX_SAFE_INTEGER;
}

function urlExtension(url: string): ModelExtension | undefined {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase();
  return (MODEL_EXTENSIONS as readonly string[]).includes(match ?? "")
    ? (match as ModelExtension)
    : undefined;
}

export function seed3dOutputBasePath(path: string): string {
  return path.replace(/\.[^./]+$/, "");
}

export interface Seed3dOutputTarget {
  /** 不含扩展名的库内逻辑路径；最终扩展名由实际产物决定。 */
  basePath: string;
  fallbackExtension?: ModelExtension;
}

/**
 * 把 Seed3D 下载字节变成资产库可直接使用的模型文件。
 * ZIP 内部路径永远不会用作落盘路径，只用于挑选模型，因此天然阻断路径穿越。
 */
export async function landSeed3dOutputBytes(
  storage: AssetStorage,
  bytes: Uint8Array,
  target: Seed3dOutputTarget,
): Promise<string> {
  if (bytes.length === 0) {
    throw new ChatServiceError("Seed3D 下载产物为空", 502, "seed3d_empty_output");
  }

  if (isZip(bytes)) {
    let archive: JSZip;
    try {
      archive = await JSZip.loadAsync(bytes);
    } catch (err) {
      throw new ChatServiceError(
        `Seed3D 产物 ZIP 无法读取：${err instanceof Error ? err.message : String(err)}`,
        502,
        "seed3d_invalid_archive",
      );
    }

    const candidates = Object.values(archive.files)
      .filter((entry) => !entry.dir && modelExtension(entry.name))
      .sort((a, b) => archiveEntryPriority(a.name) - archiveEntryPriority(b.name));
    const selected = candidates[0];
    const ext = selected ? modelExtension(selected.name) : undefined;
    if (!selected || !ext) {
      throw new ChatServiceError(
        "Seed3D 产物 ZIP 中没有可用模型文件",
        502,
        "seed3d_archive_no_model",
      );
    }

    const extracted = await selected.async("uint8array");
    if (extracted.length === 0) {
      throw new ChatServiceError(
        `Seed3D 产物 ZIP 中的模型为空：${selected.name}`,
        502,
        "seed3d_empty_archive_model",
      );
    }
    assertValidModelBytes(extracted, ext);
    const path = `${target.basePath}.${ext}`;
    await storage.writeBytes(path, extracted);
    return path;
  }

  const ext = target.fallbackExtension ?? "glb";
  assertValidModelBytes(bytes, ext);
  const path = `${target.basePath}.${ext}`;
  await storage.writeBytes(path, bytes);
  return path;
}

/** 下载 Seed3D URL；若是 ZIP 则提取模型，否则按实际/期望格式直接落盘。 */
export async function downloadAndLandSeed3dOutput(
  storage: AssetStorage,
  url: string,
  target: Seed3dOutputTarget & { fetchFn?: typeof fetch },
): Promise<string> {
  // 走公共下载：有限重试 + Range 断点续传（Seed3D 的 GLB/ZIP 也常常几十 MB）。
  const bytes = await downloadBytesWithRetry(url, {
    ...(target.fetchFn ? { fetchFn: target.fetchFn } : {}),
    label: "Seed3D 产物下载",
  });
  if (/\.zip(?:\?|$)/i.test(url) && !isZip(bytes)) {
    throw new ChatServiceError(
      "Seed3D 返回的 ZIP 产物格式无效",
      502,
      "seed3d_invalid_archive",
    );
  }
  return landSeed3dOutputBytes(storage, bytes, {
    basePath: target.basePath,
    fallbackExtension: urlExtension(url) ?? target.fallbackExtension,
  });
}

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { z } from "zod";
import { ChatServiceError } from "../common/errors";
import { config } from "../config";
import { LogicalPathSchema } from "../dto/library";

/**
 * 存储访问层：workflow/tool 不直接调文件系统 API，一律经此接口。
 * 所有 path 参数是相对资产库根的逻辑路径；本机实现拼磁盘路径，浏览器实现使用 IndexedDB 逻辑键。
 */
export interface AssetStorage {
  /** 浏览器使用 Web Locks 串行化读改写；本机实现沿用调用方的进程锁。 */
  withLock?<T>(path: string, operation: () => Promise<T>): Promise<T>;
  /** 可选流读取，浏览器本地文件可直接使用 Blob.stream()。 */
  readStream?(path: string): Promise<ReadableStream<Uint8Array>>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  /** 同目录临时文件完整落盘后原子替换目标；用于 JSON 等不能出现半截内容的元数据。 */
  writeTextAtomic(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** 列目录直接子项名（含隐藏侧写文件），目录不存在返回空数组 */
  list(dirPath: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /**
   * 只在目标不存在时创建并写入 content，返回是否由本次调用创建成功。并发下抢占
   * 同一个名字必须靠这个原子操作，`exists` + 写入之间的窗口挡不住两个同时在跑的调用。
   */
  createExclusive(path: string, content: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  /** 同库发布用原子移动；浏览器将目录键变更合并为一个事务。 */
  move?(sourcePath: string, targetPath: string): Promise<void>;
}

export class LocalFileStorage implements AssetStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private toDiskPath(logicalPath: string): string {
    const parsed = LogicalPathSchema.safeParse(logicalPath);
    if (!parsed.success) {
      throw new ChatServiceError(
        `Invalid logical path "${logicalPath}": ${parsed.error.issues[0]?.message}`,
        400,
        "invalid_logical_path",
      );
    }
    const abs = resolve(this.root, logicalPath);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new ChatServiceError(
        `Logical path "${logicalPath}" escapes the asset library root`,
        400,
        "invalid_logical_path",
      );
    }
    return abs;
  }

  async readText(path: string): Promise<string> {
    return readFile(this.toDiskPath(path), "utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.toDiskPath(path)));
  }

  async writeText(path: string, text: string): Promise<void> {
    const disk = this.toDiskPath(path);
    await mkdir(dirname(disk), { recursive: true });
    await writeFile(disk, text, "utf8");
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    const disk = this.toDiskPath(path);
    await mkdir(dirname(disk), { recursive: true });
    const temporary = `${disk}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
      await rename(temporary, disk);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const disk = this.toDiskPath(path);
    await mkdir(dirname(disk), { recursive: true });
    await writeFile(disk, bytes);
  }

  async createExclusive(path: string, content: string): Promise<boolean> {
    const disk = this.toDiskPath(path);
    await mkdir(dirname(disk), { recursive: true });
    try {
      await writeFile(disk, content, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async list(dirPath: string): Promise<string[]> {
    try {
      return await readdir(this.toDiskPath(dirPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.toDiskPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await rm(this.toDiskPath(path), { recursive: true, force: true });
  }

  async move(sourcePath: string, targetPath: string): Promise<void> {
    const source = this.toDiskPath(sourcePath);
    const target = this.toDiskPath(targetPath);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }
}

/**
 * 读 JSON 但不校验。给"必须先按版本迁移、再收敛到当前契约"的文档用（scene.json）：
 * 旧版本文件拿当前 schema 直接 parse 会失败，所以要先拿到原始值。
 */
export async function readJsonRaw(storage: AssetStorage, path: string): Promise<unknown> {
  const text = await storage.readText(path);
  try {
    return JSON.parse(text);
  } catch {
    // 手工改坏 / 旧版遗留的半截 JSON 不应以原始 SyntaxError 冒泡，转成带路径的错误
    throw new ChatServiceError(`"${path}" is not valid JSON`, 500, "metadata_parse_failed");
  }
}

/** 读 JSON 并用 schema 校验：解析失败/校验失败都抛带上下文的错误 */
export async function readJson<T extends z.ZodType>(
  storage: AssetStorage,
  path: string,
  schema: T,
): Promise<z.infer<T>> {
  const data = await readJsonRaw(storage, path);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ChatServiceError(
      `"${path}" does not match the contract: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      500,
      "metadata_schema_mismatch",
    );
  }
  return parsed.data;
}

/** 写 JSON 前先过 schema：坏元数据不落盘 */
export async function writeJson<T extends z.ZodType>(
  storage: AssetStorage,
  path: string,
  schema: T,
  value: z.infer<T>,
): Promise<void> {
  const validated = schema.parse(value);
  await storage.writeTextAtomic(path, JSON.stringify(validated, null, 2));
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  // 3D 模型（二进制读取供直连供应商上传）
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  fbx: "application/octet-stream",
  stl: "model/stl",
};

/** 库内图片/模型文件 → data URI（送多模态模型/直连渠道的统一入口） */
export async function readAsDataUri(
  storage: AssetStorage,
  logicalPath: string,
): Promise<string> {
  const ext = logicalPath.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new ChatServiceError(
      `Unsupported file format "${logicalPath}" (supported: png/jpg/webp/glb/gltf/obj/fbx/stl)`,
      400,
      "unsupported_file",
    );
  }
  const bytes = await storage.readBytes(logicalPath);
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

let defaultStorage: AssetStorage | undefined;
const storageContext = new AsyncLocalStorage<AssetStorage>();

/** 每个 HTTP 请求/队列任务各自持有工作区，不能通过全局 setter 切换租户。 */
export function withAssetStorage<T>(storage: AssetStorage, operation: () => T): T {
  return storageContext.run(storage, operation);
}

export function getAssetStorage(): AssetStorage {
  const scoped = storageContext.getStore();
  if (scoped) return scoped;
  if (process.env.VERCEL === "1") {
    throw new ChatServiceError("The cloud workspace has not been initialized", 503, "cloud_storage_unavailable");
  }
  defaultStorage ??= new LocalFileStorage(config.library.root);
  return defaultStorage;
}

/** 组合缝：测试注入临时目录存储 / 云版注入对象存储实现；传 undefined 恢复默认 */
export function setAssetStorage(storage: AssetStorage | undefined): void {
  defaultStorage = storage;
}

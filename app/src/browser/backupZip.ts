/**
 * 备份 ZIP 的**流式**读取（BackupPanel 的导入侧）。
 *
 * 三条硬约束，改之前先读：
 *
 * 1. **不把包读进 JS 堆。** 只读中央目录拿"文件名 + 压缩方式 + 偏移"，真正取数时
 *    `Blob.slice()` 出一段交给 IndexedDB——STORE 档零拷贝。这是本文件存在的**唯一**理由：
 *    2026-10-17 本机实测（真 Chrome，用户那份 454 MB / 816 个文件的备份，全部 STORE），
 *    旧的 JSZip 路径 `loadAsync()` + 逐项 `async("blob")` + 一次性事务
 *    **63 分钟写入 0 个文件、不报错、也不崩**（同一份包用这里的流式路径 1.0 s 写完、
 *    8 项校验全过）。别再退回 JSZip。
 * 2. **`.json` 必须落成字符串。** 应用里有 `JSON.parse(entry.value as string)` 这类读取路径
 *    （`browser/client.ts` 的 `.jobs/` 续跑、`browser/jobs.ts`），存成 Blob 会让任务轮询当场抛错。
 *    二进制才是 Blob。
 * 3. **`chatspace-backup.json` 是清单本身，不进工作区。** 应用自己的导入也跳它
 *    （旧 BackupPanel 的 filter 就是这么写的），否则工作区会多出一个应用永远不会产生的文件。
 *
 * 支持 STORE(0) 与 deflate(8) 两档：应用导出的包固定 STORE（`compression: "STORE"`），
 * deflate 是给手工/第三方打的包留的路（浏览器用 `DecompressionStream("deflate-raw")`）。
 * ZIP64 明确报错而不是静默读错——本仓库的备份到不了 4 GB/65535 项，但别的工具打的包可能。
 */

/** 备份清单的文件名：BackupPanel 导出时写它，导入时用它校验版本。 */
export const BACKUP_MANIFEST = "chatspace-backup.json";

export interface BackupManifest {
  version: number;
  savedAt?: string;
  files?: number;
}

export interface BackupEntry {
  name: string;
  /** 0 = STORE，8 = deflate */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** 本地头在 zip 里的偏移；数据起点要从它 + 本地头的 name/extra 长度算出来。 */
  localOffset: number;
}

export interface BackupArchive {
  file: Blob;
  /** 工作区要写的文件（已排除目录项与清单）。 */
  entries: BackupEntry[];
  /** 清单本身（不属于 `entries`，只用来校验版本）。 */
  manifest?: BackupEntry;
}

export interface BackupPlan {
  /** 工作区里已有同名文件的路径（导入时按 mode 决定是否覆盖）。 */
  conflicts: Set<string>;
  /** 备份里有、工作区没有的路径。 */
  missing: string[];
  /** 工作区里有、备份里没有的路径（只有 replace 才会删它们）。 */
  extra: string[];
  /** 备份里全部文件的解压后总字节数，用来在动手前告诉用户量级。 */
  bytes: number;
  /** 工作区现有文件数（含 extra）。 */
  existing: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_BYTES = 30;
/** EOCD 的最小长度（无注释、0 项）。空 zip 是合法 zip，别在这里判死——它会走到"没有清单"那条。 */
const MIN_ZIP_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;

/** 按后缀决定落库形态：`.json` → 字符串，其余 → Blob。见文件头第 2 条。 */
export const isTextEntry = (name: string) => name.endsWith(".json");

/** 读中央目录：只碰末尾 64 KB（找 EOCD）与中央目录本身，文件内容一个字节都不读。 */
async function readCentralDirectory(file: Blob): Promise<BackupEntry[]> {
  if (!file || typeof file.slice !== "function") throw new Error("That is not a zip file");
  if (file.size < MIN_ZIP_BYTES) throw new Error("That is not a zip file");

  const tailLength = Math.min(file.size, MAX_COMMENT_BYTES + 22);
  const tail = new DataView(await file.slice(file.size - tailLength).arrayBuffer());
  let eocd = -1;
  for (let index = tail.byteLength - 22; index >= 0; index -= 1) {
    if (tail.getUint32(index, true) === EOCD_SIGNATURE) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("That is not a zip file");
  const count = tail.getUint16(eocd + 10, true);
  const centralSize = tail.getUint32(eocd + 12, true);
  const centralOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 backups are not supported");
  }

  const central = new DataView(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries: BackupEntry[] = [];
  for (let cursor = 0, index = 0; index < count; index += 1) {
    if (cursor + 46 > central.byteLength) throw new Error("This backup is damaged (truncated index)");
    if (central.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error("This backup is damaged (bad index)");
    const nameLength = central.getUint16(cursor + 28, true);
    const extraLength = central.getUint16(cursor + 30, true);
    const commentLength = central.getUint16(cursor + 32, true);
    const name = decoder.decode(new Uint8Array(central.buffer, central.byteOffset + cursor + 46, nameLength));
    // 目录项（末尾 `/`）不进工作区。
    if (!name.endsWith("/")) {
      entries.push({
        name,
        method: central.getUint16(cursor + 10, true),
        compressedSize: central.getUint32(cursor + 20, true),
        uncompressedSize: central.getUint32(cursor + 24, true),
        localOffset: central.getUint32(cursor + 42, true),
      });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * 解析备份包。`manifest` 单拎出来，`entries` 里不含它（见文件头第 3 条）：
 * 写工作区时不会顺手把它塞进去，而校验版本仍然拿得到。
 */
export async function parseBackupZip(file: Blob): Promise<BackupArchive> {
  const records = await readCentralDirectory(file);
  return {
    file,
    entries: records.filter((entry) => entry.name !== BACKUP_MANIFEST),
    manifest: records.find((entry) => entry.name === BACKUP_MANIFEST),
  };
}

/** 校验版本号。这是"选错了文件"与"包坏了"的分界线，文案要能直接给用户看。 */
export async function readBackupManifest(archive: BackupArchive): Promise<BackupManifest> {
  if (!archive.manifest) throw new Error("This is not a ChatSpace project backup");
  const value = await readBackupValue(archive, archive.manifest);
  const manifest = JSON.parse(typeof value === "string" ? value : await value.text()) as BackupManifest;
  if (manifest?.version !== 1) throw new Error("This is not a ChatSpace project backup");
  return manifest;
}

/**
 * 取一个条目的内容。数据起点用**本地头**里的 name/extra 长度（中央目录里的长度可以与它不同，
 * 尤其带 data descriptor 的包）；压缩尺寸以中央目录为准。见文件头第 1 条：STORE 只 slice。
 */
export async function readBackupValue(archive: BackupArchive, entry: BackupEntry): Promise<string | Blob> {
  const header = new DataView(await archive.file.slice(entry.localOffset, entry.localOffset + LOCAL_HEADER_BYTES).arrayBuffer());
  const dataStart = entry.localOffset + LOCAL_HEADER_BYTES + header.getUint16(26, true) + header.getUint16(28, true);
  const raw = archive.file.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported compression in this backup (method ${entry.method})`);
  const blob = entry.method === 0
    ? raw
    : await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
  return isTextEntry(entry.name) ? await blob.text() : blob;
}

/**
 * 把底层错误翻成**用户能读的**一句话。设置对话框里没有别的地方显示原因，所以这句是唯一的诊断信息：
 * 已知的几类（配额、ZIP64、选错文件）给出可行动的文案，未知错误**原样透出**——不要吞掉。
 */
export function backupErrorMessage(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/quota|not enough local storage/i.test(text)) return "Not enough storage in this browser; free some space and import again";
  if (/ZIP64/.test(text)) return "This backup is ZIP64, which this app cannot read yet";
  if (/not a zip file/i.test(text)) return "That is not a zip file";
  return text || fallback;
}

/** 选包之后**只做计划**，不写任何东西：让用户先看到"会动哪些文件"再决定。 */
export function planBackupImport(entries: BackupEntry[], existing: Iterable<string>): BackupPlan {
  const have = new Set(existing);
  const conflicts = new Set<string>();
  const missing: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    bytes += entry.uncompressedSize;
    if (have.has(entry.name)) conflicts.add(entry.name);
    else missing.push(entry.name);
  }
  const inBackup = new Set(entries.map((entry) => entry.name));
  return { conflicts, missing, extra: [...have].filter((path) => !inBackup.has(path)), bytes, existing: have.size };
}

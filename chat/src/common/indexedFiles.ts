/**
 * 索引文件命名约定（沿用 image-blaster，docs/image-blast-mastra.md §7 决策 4）：
 * - 可见产物：`N-slug.ext`，N=0 是源/原件，更高编号是派生代
 * - 请求侧写：`.N-slug-request.json`，与它生成的文件成对出现
 * - 多文件生成共享同一个索引
 */

export interface IndexedName {
  index: number;
  slug: string;
  ext: string;
}

const INDEXED_NAME_RE = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-z0-9.]+)$/i;
const SIDECAR_NAME_RE = /^\.(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)-request\.json$/i;

export function formatIndexedName(index: number, slug: string, ext: string): string {
  return `${index}-${slug}.${ext}`;
}

export function formatRequestSidecarName(index: number, slug: string): string {
  return `.${index}-${slug}-request.json`;
}

export function parseIndexedName(fileName: string): IndexedName | null {
  const match = INDEXED_NAME_RE.exec(fileName);
  if (!match) return null;
  return { index: Number(match[1]), slug: match[2]!, ext: match[3]! };
}

export function parseRequestSidecarName(
  fileName: string,
): Omit<IndexedName, "ext"> | null {
  const match = SIDECAR_NAME_RE.exec(fileName);
  if (!match) return null;
  return { index: Number(match[1]), slug: match[2]! };
}

const IMAGE_EXT_RE = /^(png|jpe?g|webp)$/i;

/** 选最高索引的可见源图（通常是最新的 plate 或原图），忽略侧写与非图片 */
export function pickLatestSourceImage(fileNames: string[]): string | null {
  let best: { index: number; name: string } | null = null;
  for (const name of fileNames) {
    const parsed = parseIndexedName(name);
    if (!parsed || !IMAGE_EXT_RE.test(parsed.ext)) continue;
    if (!best || parsed.index > best.index) best = { index: parsed.index, name };
  }
  return best?.name ?? null;
}

/** 下一个可用生成索引：已有可见产物与侧写的最大索引 + 1，空目录从 0 开始 */
export function nextIndex(fileNames: string[]): number {
  let max = -1;
  for (const name of fileNames) {
    const indexed = parseIndexedName(name) ?? parseRequestSidecarName(name);
    if (indexed && indexed.index > max) max = indexed.index;
  }
  return max + 1;
}

/** reserveIndex 只需要这两件事，用结构化类型写，避免 common 反向依赖 services 层。 */
export interface IndexReservationStore {
  list(dirPath: string): Promise<string[]>;
  createExclusive(path: string, content: string): Promise<boolean>;
}

/**
 * 原子占用下一个索引。`nextIndex` 是"列目录 → 取最大 + 1"，两个同时在跑的调用
 * 会算出同一个索引、写同一个文件名，后写的静默盖掉先写的（2026-09 三张并发参考图
 * 只落盘一张就是这么来的）。
 *
 * 这里改成用侧写文件名做排他占位：扩展名要等供应商返回才知道，侧写名与扩展名无关，
 * 所以它既能先占住索引，又天然满足 nextIndex 的解析规则。撞名就顺延到下一个索引。
 *
 * 占位内容由调用方给出，而且必须是一份合法侧写：占位和随后的正式落盘之间进程如果
 * 挂掉，磁盘上留下的就是这份内容。写空文件的话，repair-assets 这类会读侧写的路径
 * 就会在一个半成品上抛错。
 */
export async function reserveIndex(
  store: IndexReservationStore,
  dirPath: string,
  slug: string,
  reserveContent: (index: number) => string,
): Promise<number> {
  let index = nextIndex(await store.list(dirPath));
  for (;;) {
    const reserved = await store.createExclusive(
      `${dirPath}/${formatRequestSidecarName(index, slug)}`,
      reserveContent(index),
    );
    if (reserved) return index;
    index += 1;
  }
}

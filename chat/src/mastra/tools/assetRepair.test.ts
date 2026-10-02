import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLegacyGzipSpz, isSpzV4 } from "../../common/spz";
import { LocalFileStorage } from "../../services/assetStorage";
import { downloadSpzToLibrary } from "./assetRepair";

/**
 * 入库那一步的**接线**：上游给的是 legacy SPZ，落盘必须是引擎认的 v4。
 *
 * 转换逻辑本身在 `common/spz.test.ts` 里覆盖（含真工具的往返）；这里测的是这句话：
 * "下载 splat 产物走的是 `downloadSpzToLibrary`，而且它写下去的确实是转换后的字节"。
 * 夹具现造（`writeSpz` 的 `version: 3`），所以不需要往仓库里塞二进制。
 */

const root = await mkdtemp(join(tmpdir(), "chatspace-spz-ingest-"));
const storage = new LocalFileStorage(root);
afterAll(() => rm(root, { recursive: true, force: true }));

/** 与 `common/spz.test.ts` 同一份夹具：两个高斯点的 v3（整段 gzip）。 */
async function makeLegacySpz(): Promise<Uint8Array> {
  const { Column, DataTable, MemoryFileSystem, writeSpz } = await import("@playcanvas/splat-transform");
  const column = (name: string, data: number[]) => new Column(name, new Float32Array(data));
  const table = new DataTable([
    column("x", [0, 1]), column("y", [0, 0.5]), column("z", [0, -1]),
    column("scale_0", [-2, -1.5]), column("scale_1", [-1, -1.2]), column("scale_2", [-3, -2.5]),
    column("rot_0", [1, 1]), column("rot_1", [0, 0]), column("rot_2", [0, 0]), column("rot_3", [0, 0]),
    column("f_dc_0", [0.5, 0.2]), column("f_dc_1", [0.1, 0.3]), column("f_dc_2", [0.9, 0.4]),
    column("opacity", [2, 1]),
  ]);
  const fs = new MemoryFileSystem();
  await writeSpz({ filename: "legacy.spz", dataTable: table, version: 3 }, fs);
  const bytes = fs.results.get("legacy.spz");
  if (!bytes) throw new Error("测试夹具没写出来");
  return bytes;
}

describe("splat 产物入库", () => {
  test("下载 legacy .spz → 落盘的是 v4（点数不变）", async () => {
    const legacy = await makeLegacySpz();
    expect(isLegacyGzipSpz(legacy)).toBe(true);

    const path = "projects/demo/assets/world/0-world.spz";
    const fetchFn = (async () => new Response(legacy, { status: 200 })) as unknown as typeof fetch;
    const result = await downloadSpzToLibrary(storage, "https://cdn.fake/world.spz", path, { fetchFn });

    expect(result.converted).toBe(true);
    expect(result.reason).toBeNull();
    const written = await storage.readBytes(path);
    expect(isSpzV4(written)).toBe(true);
    expect(new DataView(written.buffer, written.byteOffset).getUint32(8, true)).toBe(2);
  });
});

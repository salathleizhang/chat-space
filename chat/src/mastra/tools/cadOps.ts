import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ChatServiceError, toErrorMessage } from "../../common/errors";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  parseRequestSidecarName,
} from "../../common/indexedFiles";
import { assetDir } from "../../common/libraryPaths";
import {
  RequestSidecarSchema,
  SlugSchema,
  type RequestSidecar,
} from "../../dto/library";
import {
  getAssetStorage,
  readJson,
  writeJson,
  type AssetStorage,
} from "../../services/assetStorage";
import { publishGeneratedModel } from "../../services/modelPublishing";
import { requireProject } from "./projectTools";
import { requireCurrentProject } from "./requestContext";
import type { CadWorkerRequest, CadWorkerResponse } from "./cadWorker";

/**
 * CAD 硬表面参数化建模能力（免费本地计算，不经任何供应商）：
 * LLM 写完整 OpenSCAD 代码 → vendored OpenSCAD-WASM 编译 STL →
 * 转平面着色 GLB 落盘，.scad 源码与 GLB 同索引成对落盘并存入侧写 params，
 * 改参重生成 = 读回源码改参数后整份重编（新索引，不覆盖旧产物）。
 * 路线参考 CADAM（Adam-CAD）的 build_parametric_model 模式。
 */

export const CAD_PROVIDER = "openscad";
export const CAD_ENGINE = "openscad-wasm-2025.03.25";

/** 单次编译上限：WASM 侧无法中断，超时直接 terminate worker */
const COMPILE_TIMEOUT_MS = 60_000;

/** OpenSCAD 单位是毫米，glTF 规范单位是米 */
const MM_TO_M = 0.001;

// ---------- OpenSCAD 编译（worker 隔离） ----------

export interface CadCompileResult {
  stl: Uint8Array;
  log: string[];
}

export async function compileScadToStl(
  scadCode: string,
  timeoutMs = COMPILE_TIMEOUT_MS,
): Promise<CadCompileResult> {
  const worker = new Worker(new URL("./cadWorker.ts", import.meta.url));
  try {
    const response = await new Promise<CadWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ChatServiceError(
            `OpenSCAD 编译超过 ${Math.round(timeoutMs / 1000)}s 被中止：请降低 $fn 或简化布尔结构后重试`,
            504,
            "cad_compile_timeout",
          ),
        );
      }, timeoutMs);
      worker.onmessage = (event: MessageEvent<CadWorkerResponse>) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(
          new ChatServiceError(
            `OpenSCAD 编译线程异常：${event.message ?? "unknown"}`,
            500,
            "cad_worker_error",
          ),
        );
      };
      worker.postMessage({ scadCode } satisfies CadWorkerRequest);
    });
    if (!response.ok) {
      if (response.log.some((line) => /top level object is empty/i.test(line))) {
        throw new ChatServiceError(
          "编译产出几何为空：布尔运算可能减掉了全部实体，检查各部件位置与尺寸",
          422,
          "cad_empty_geometry",
        );
      }
      const detail = response.log
        .filter((line) => /ERROR|WARNING|Can't/i.test(line))
        .slice(-8);
      throw new ChatServiceError(
        `OpenSCAD 编译失败：${detail.length ? detail.join("\n") : response.error}`,
        422,
        "cad_compile_failed",
      );
    }
    return { stl: response.stl, log: response.log };
  } finally {
    worker.terminate();
  }
}

// ---------- STL 解析与 GLB 导出 ----------

export interface CadGeometryStats {
  triangles: number;
  /** 毫米单位的包围盒，供 agent 对照尺寸意图做质检 */
  bboxMm: { min: [number, number, number]; max: [number, number, number] };
  volumeMm3: number;
}

/** 二进制 STL → 非索引三角形顶点坐标（毫米） */
export function parseBinaryStl(bytes: Uint8Array): Float32Array {
  if (bytes.length < 84) {
    throw new ChatServiceError("STL 文件不完整（不足 84 字节头）", 500, "cad_bad_stl");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  if (bytes.length < 84 + triangles * 50) {
    throw new ChatServiceError("STL 三角形数据被截断", 500, "cad_bad_stl");
  }
  const positions = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    const base = 84 + t * 50 + 12; // 跳过面法线，法线由顶点重算
    for (let i = 0; i < 9; i++) {
      positions[t * 9 + i] = view.getFloat32(base + i * 4, true);
    }
  }
  return positions;
}

function computeStats(positionsMm: Float32Array): CadGeometryStats {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positionsMm.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positionsMm[i + axis]!;
      if (v < min[axis]!) min[axis] = v;
      if (v > max[axis]!) max[axis] = v;
    }
  }
  // 有向四面体体积和：封闭流形网格得到实体体积
  let volume6 = 0;
  for (let i = 0; i < positionsMm.length; i += 9) {
    const [ax, ay, az] = [positionsMm[i]!, positionsMm[i + 1]!, positionsMm[i + 2]!];
    const [bx, by, bz] = [positionsMm[i + 3]!, positionsMm[i + 4]!, positionsMm[i + 5]!];
    const [cx, cy, cz] = [positionsMm[i + 6]!, positionsMm[i + 7]!, positionsMm[i + 8]!];
    volume6 +=
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return {
    triangles: positionsMm.length / 9,
    bboxMm: { min, max },
    volumeMm3: Math.abs(volume6) / 6,
  };
}

function alignTo4(length: number): number {
  return (length + 3) & ~3;
}

/**
 * 非索引三角形（毫米）→ 平面着色 GLB：逐面重算法线，硬表面用平直着色最诚实；
 * 顶点坐标按 glTF 规范折算成米。
 */
export function buildFlatShadedGlb(positionsMm: Float32Array, name: string): Uint8Array {
  const vertexCount = positionsMm.length / 3;
  const positions = new Float32Array(positionsMm.length);
  const normals = new Float32Array(positionsMm.length);
  const posMin = [Infinity, Infinity, Infinity];
  const posMax = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positionsMm.length; i += 9) {
    const ux = positionsMm[i + 3]! - positionsMm[i]!;
    const uy = positionsMm[i + 4]! - positionsMm[i + 1]!;
    const uz = positionsMm[i + 5]! - positionsMm[i + 2]!;
    const vx = positionsMm[i + 6]! - positionsMm[i]!;
    const vy = positionsMm[i + 7]! - positionsMm[i + 1]!;
    const vz = positionsMm[i + 8]! - positionsMm[i + 2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (let corner = 0; corner < 3; corner++) {
      const at = i + corner * 3;
      normals[at] = nx;
      normals[at + 1] = ny;
      normals[at + 2] = nz;
      for (let axis = 0; axis < 3; axis++) {
        const meters = positionsMm[at + axis]! * MM_TO_M;
        positions[at + axis] = meters;
        if (meters < posMin[axis]!) posMin[axis] = meters;
        if (meters > posMax[axis]!) posMax[axis] = meters;
      }
    }
  }

  const positionBytes = new Uint8Array(positions.buffer);
  const normalBytes = new Uint8Array(normals.buffer);
  const binLength = alignTo4(positionBytes.length) + alignTo4(normalBytes.length);

  const gltf = {
    asset: { version: "2.0", generator: `gabo ${CAD_ENGINE}` },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [
      {
        name,
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, mode: 4, material: 0 }],
      },
    ],
    materials: [
      {
        name: "cad-neutral",
        pbrMetallicRoughness: {
          baseColorFactor: [0.72, 0.74, 0.78, 1],
          metallicFactor: 0.2,
          roughnessFactor: 0.6,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: vertexCount,
        type: "VEC3",
        min: posMin,
        max: posMax,
      },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      {
        buffer: 0,
        byteOffset: alignTo4(positionBytes.length),
        byteLength: normalBytes.length,
        target: 34962,
      },
    ],
    buffers: [{ byteLength: binLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = alignTo4(jsonBytes.length);
  const totalLength = 12 + 8 + jsonPadded + 8 + binLength;
  const glb = new Uint8Array(totalLength);
  const header = new DataView(glb.buffer);

  header.setUint32(0, 0x46546c67, true); // magic "glTF"
  header.setUint32(4, 2, true);
  header.setUint32(8, totalLength, true);

  header.setUint32(12, jsonPadded, true);
  header.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonBytes, 20);
  glb.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded); // 空格填充

  const binChunkStart = 20 + jsonPadded;
  header.setUint32(binChunkStart, binLength, true);
  header.setUint32(binChunkStart + 4, 0x004e4942, true); // "BIN\0"
  glb.set(positionBytes, binChunkStart + 8);
  glb.set(normalBytes, binChunkStart + 8 + alignTo4(positionBytes.length));

  return glb;
}

// ---------- 生成与源码读回 ----------

export const CadBuildParamsSchema = z.object({
  projectSlug: SlugSchema,
  assetSlug: SlugSchema,
  name: z.string().min(1).optional(),
  intent: z.string().min(1).optional(),
  /** 完整 OpenSCAD 源码（单位毫米，顶部参数变量 + Customizer 注释） */
  scadCode: z.string().min(1),
});
export type CadBuildParams = z.infer<typeof CadBuildParamsSchema>;

export interface CadBuildResult {
  glbPath: string;
  scadPath: string;
  sidecar: string;
  stats: CadGeometryStats;
}

export async function runCadGeneration(
  storage: AssetStorage,
  rawParams: CadBuildParams,
): Promise<CadBuildResult> {
  const params = CadBuildParamsSchema.parse(rawParams);
  await requireProject(storage, params.projectSlug);

  const dir = assetDir(params.projectSlug, params.assetSlug);
  const index = nextIndex(await storage.list(dir));
  const sidecarPath = `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`;

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: CAD_PROVIDER,
    model: CAD_ENGINE,
    params: { scadCode: params.scadCode },
    status: "running",
    outputs: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const saveSidecar = () =>
    writeJson(storage, sidecarPath, RequestSidecarSchema, { ...sidecar, updatedAt: now() });
  await saveSidecar();

  try {
    const { stl } = await compileScadToStl(params.scadCode);
    const positionsMm = parseBinaryStl(stl);
    if (positionsMm.length === 0) {
      throw new ChatServiceError(
        "编译成功但几何为空：布尔运算可能减掉了全部实体，检查各部件位置与尺寸",
        422,
        "cad_empty_geometry",
      );
    }
    const stats = computeStats(positionsMm);
    const glb = buildFlatShadedGlb(positionsMm, params.name ?? params.assetSlug);

    const glbPath = `${dir}/${formatIndexedName(index, params.assetSlug, "glb")}`;
    const scadPath = `${dir}/${formatIndexedName(index, params.assetSlug, "scad")}`;
    await storage.writeBytes(glbPath, glb);
    await storage.writeText(scadPath, params.scadCode);
    sidecar.outputs.push({ path: glbPath }, { path: scadPath });

    sidecar.status = "succeeded";
    await saveSidecar();
    await publishGeneratedModel(
      storage,
      params.projectSlug,
      {
        slug: params.assetSlug,
        name: params.name ?? params.assetSlug,
        intent: params.intent ?? `CAD 硬表面参数化建模：${params.name ?? params.assetSlug}`,
        sourceImages: [],
      },
      { files: [glbPath] },
    );
    return { glbPath, scadPath, sidecar: sidecarPath, stats };
  } catch (err) {
    sidecar.status = "failed";
    sidecar.error = toErrorMessage(err);
    await saveSidecar();
    throw err;
  }
}

export interface CadSourceResult {
  index: number;
  status: RequestSidecar["status"];
  scadCode: string;
}

/** 读回资产最新一代 CAD 源码（改参重生成的输入；失败代也返回，便于修正后重编） */
export async function readLatestCadSource(
  storage: AssetStorage,
  projectSlug: string,
  assetSlug: string,
): Promise<CadSourceResult> {
  await requireProject(storage, projectSlug);
  const dir = assetDir(projectSlug, assetSlug);
  const entries = await storage.list(dir);
  const indexes = entries
    .map(parseRequestSidecarName)
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null)
    .sort((a, b) => b.index - a.index);
  for (const entry of indexes) {
    const sidecar = await readJson(
      storage,
      `${dir}/${formatRequestSidecarName(entry.index, entry.slug)}`,
      RequestSidecarSchema,
    );
    if (sidecar.provider !== CAD_PROVIDER) continue;
    const scadCode = sidecar.params.scadCode;
    if (typeof scadCode === "string" && scadCode) {
      return { index: sidecar.index, status: sidecar.status, scadCode };
    }
  }
  throw new ChatServiceError(
    `资产「${assetSlug}」没有 CAD 生成记录（只有 build-cad-model 产出的资产才能读回源码）`,
    404,
    "cad_source_not_found",
  );
}

// ---------- Mastra tool 包装 ----------

export const buildCadModelTool = createTool({
  id: "build-cad-model",
  description:
    "CAD 硬表面参数化建模（免费本地编译，不需要任何供应商 key）：传入完整 OpenSCAD 源码，服务端用 OpenSCAD-WASM 编译成 GLB 与 .scad 源码落盘。适合支架、外壳、法兰、齿轮等规则几何体；有机形态请走 start-3d-batch。传已有 assetSlug 即为该资产追加新一代（改参重生成），不覆盖旧产物。返回三角数/毫米包围盒/体积等几何统计，务必对照尺寸意图核对后再向用户汇报",
  inputSchema: z.object({
    assetSlug: SlugSchema,
    name: z.string().min(1).optional(),
    intent: z.string().min(1).optional(),
    scadCode: z.string().min(1),
  }),
  execute: async (input, context) => {
    const result = await runCadGeneration(getAssetStorage(), {
      projectSlug: requireCurrentProject(context),
      ...input,
    });
    return result;
  },
});

export const getCadSourceTool = createTool({
  id: "get-cad-source",
  description:
    "读回 CAD 资产最新一代的 OpenSCAD 源码（免费）：用户要改尺寸/参数时先读回源码，修改后用 build-cad-model 整份重新提交。失败代也会返回，便于修正语法后重编",
  inputSchema: z.object({ assetSlug: SlugSchema }),
  execute: async (input, context) => {
    return readLatestCadSource(
      getAssetStorage(),
      requireCurrentProject(context),
      input.assetSlug,
    );
  },
});

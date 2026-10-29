import { NodeIO, type Accessor, type Document, type Primitive } from "@gltf-transform/core";
import { dedup, prune } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { ChatServiceError } from "../common/errors";
import { glbTriangleCount } from "../common/glb";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
  parseIndexedName,
} from "../common/indexedFiles";
import { assetDir } from "../common/libraryPaths";
import { RequestSidecarSchema, type RequestSidecar } from "../dto/library";
import type { GenerationPhase } from "../dto/tasks";
import { writeJson, type AssetStorage } from "./assetStorage";

/**
 * 本地减面：不再调 Tripo `/mesh/decimate`，用 meshoptimizer 在进程内（浏览器里是 Worker）完成。
 *
 * 三条口径：
 * 1. **能保住 UV 就保住**。`simplifyWithAttributes` 把 TEXCOORD_0 当属性参与误差计算并
 *    `LockBorder` 锁边界，UV 接缝不会被合掉，贴图不需要重新烘焙；只有压到几百面、
 *    属性约束无法达标时才退到 `simplifySloppy`（那时的 UV 本来也没有意义）。
 * 2. **保面数的是 sloppy**。`simplifyWithAttributes` 在误差上限处会停手（1.5 M 面的资产
 *    实测停在 ~576 三角面），所以"必须到 N 面"的请求由 sloppy 兜底。
 * 3. **产物是新的一代**（`N-slug.glb` + 侧写），原高模保留——与 Tripo 时代的语义一致，
 *    视口与摆放自动用最新一代。
 */

/** 本地减面允许的面数区间。低于 40 面任何算法都只剩一个盒子。 */
export const LOCAL_RETOPO_FACES = { min: 40, max: 40_000 } as const;

/** 目标面数低于这个值时放弃保 UV（属性约束会阻碍降到目标）。 */
const UV_SAFE_FLOOR = 800;

/**
 * 没给目标面数时的默认值。用 sqrt 曲线：大模型多给、小模型少给，封顶 2 000——
 * 用户的实际预期是"一般降到几百面"，而 2 000 面是家具类资产还能维持轮廓的上限
 * （1 500 面以下开始走形，见 RETOPO_RESEARCH.md 的实测）。
 */
export function defaultRetopoFaces(triangles: number): number {
  return Math.min(2_000, Math.max(300, Math.round(Math.sqrt(Math.max(0, triangles)) * 3)));
}

export interface LocalRetopoParams {
  projectSlug: string;
  assetSlug: string;
  /** 目标三角面数；省略时按 `defaultRetopoFaces` 自适应 */
  targetPolycount?: number;
  onPhase?: (phase: GenerationPhase) => Promise<void> | void;
}

export interface LocalRetopoResult {
  model: string;
  files: string[];
  /** 源模型三角面数 */
  fromFaces: number;
  /** 产物三角面数 */
  faces: number;
  /** 实际使用的目标面数 */
  target: number;
  /** 是否退到了 sloppy（UV 不再可信） */
  sloppy: boolean;
}

interface PrimitivePlan {
  primitive: Primitive;
  triangles: number;
}

function countTriangles(prim: Primitive): number {
  const indices = prim.getIndices();
  if (indices) return Math.floor(indices.getCount() / 3);
  const position = prim.getAttribute("POSITION");
  return position ? Math.floor(position.getCount() / 3) : 0;
}

function collectPrimitives(doc: Document): PrimitivePlan[] {
  const plans: PrimitivePlan[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const triangles = countTriangles(primitive);
      if (triangles > 0) plans.push({ primitive, triangles });
    }
  }
  return plans;
}

/** 读成 Float32Array：POSITION / TEXCOORD 这类浮点属性走快路径，其余逐元素转。 */
function readFloats(accessor: Accessor | null): Float32Array | null {
  if (!accessor) return null;
  const array = accessor.getArray();
  if (!array) return null;
  if (array instanceof Float32Array && !accessor.getNormalized()) return array;
  const elementSize = accessor.getElementSize();
  const out = new Float32Array(accessor.getCount() * elementSize);
  const scratch: number[] = [];
  for (let i = 0; i < accessor.getCount(); i++) {
    accessor.getElement(i, scratch);
    for (let k = 0; k < elementSize; k++) out[i * elementSize + k] = scratch[k] ?? 0;
  }
  return out;
}

function readIndices(prim: Primitive, vertexCount: number): Uint32Array {
  const accessor = prim.getIndices();
  if (!accessor) {
    const sequential = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) sequential[i] = i;
    return sequential;
  }
  const array = accessor.getArray();
  if (array instanceof Uint32Array) return array;
  const out = new Uint32Array(accessor.getCount());
  for (let i = 0; i < out.length; i++) out[i] = accessor.getScalar(i);
  return out;
}

/**
 * 按目标面数分布到每个 primitive：权重取 `sqrt(三角形数)`，让小部件（桌腿、把手）
 * 分到比"按面积比例"更多的预算，否则它们在大平面面前会被整体抹掉。
 */
function distribute(totalTarget: number, plans: PrimitivePlan[]): number[] {
  const weights = plans.map((plan) => Math.sqrt(plan.triangles));
  const weightSum = weights.reduce((sum, value) => sum + value, 0) || 1;
  const minimum = plans.map((plan) => Math.min(plan.triangles, 4));
  const result = plans.map((plan, i) =>
    Math.min(plan.triangles, Math.max(minimum[i]!, Math.round((totalTarget * weights[i]!) / weightSum))),
  );
  // 下限之和可能超过目标：按"能压到多少"回填
  let assigned = result.reduce((sum, value) => sum + value, 0);
  for (let i = 0; assigned > totalTarget && i < result.length; i++) {
    const floor = Math.min(minimum[i]!, result[i]!);
    const cut = Math.min(result[i]! - floor, assigned - totalTarget);
    result[i]! -= cut;
    assigned -= cut;
  }
  return result;
}

interface SimplifiedPrimitive {
  indices: Uint32Array;
  sloppy: boolean;
}

/** 单个 primitive 减面；返回的索引仍然指向原来的顶点数组（顶点不动，UV 因此原样保留）。 */
function simplifyPrimitive(
  plan: PrimitivePlan,
  targetTriangles: number,
  allowSloppy: boolean,
): SimplifiedPrimitive | null {
  const position = readFloats(plan.primitive.getAttribute("POSITION"));
  if (!position) return null;
  const vertices = position.length / 3;
  const indices = readIndices(plan.primitive, vertices);
  const uv = readFloats(plan.primitive.getAttribute("TEXCOORD_0"));
  const targetIndexCount = Math.max(3, Math.floor(targetTriangles) * 3);

  const withAttributes = (error: number) => {
    if (uv && uv.length === vertices * 2) {
      const [out] = MeshoptSimplifier.simplifyWithAttributes(
        indices,
        position,
        3,
        uv,
        2,
        [1, 1],
        null,
        targetIndexCount,
        error,
        ["LockBorder"],
      );
      return out;
    }
    const [out] = MeshoptSimplifier.simplify(
      indices,
      position,
      3,
      targetIndexCount,
      error,
      ["LockBorder"],
    );
    return out;
  };

  let out = withAttributes(0.01);
  for (const error of [0.05, 0.2, 1]) {
    if (out.length / 3 <= targetTriangles * 1.25) break;
    out = withAttributes(error);
  }
  if (out.length / 3 > targetTriangles * 1.25 && allowSloppy) {
    const [sloppy] = MeshoptSimplifier.simplifySloppy(
      indices,
      position,
      3,
      null,
      targetIndexCount,
      0.5,
    );
    if (sloppy.length > 0) return { indices: Uint32Array.from(sloppy), sloppy: true };
  }
  return { indices: Uint32Array.from(out), sloppy: false };
}

/**
 * 选源：**面数最多的那一代**，不是最新一代。
 * 减面产物本身也是一代（`1-slug.glb`），若每次都从最新代往下压，第二次减面就变成
 * "在 400 面上再减到 800"（直接拒绝），想换个大一点的数字都回不去。Tripo 时代也是
 * 从原始 task 往下减的，这里保持同一语义。
 */
export async function pickHighestPolyModel(
  storage: AssetStorage,
  dir: string,
): Promise<{ path: string; bytes: Uint8Array; triangles: number }> {
  let best: { path: string; bytes: Uint8Array; triangles: number } | null = null;
  for (const name of await storage.list(dir)) {
    const parsed = parseIndexedName(name);
    if (!parsed || parsed.ext.toLowerCase() !== "glb") continue;
    const path = `${dir}/${name}`;
    const bytes = await storage.readBytes(path);
    const triangles = glbTriangleCount(bytes) ?? 0;
    if (!best || triangles > best.triangles) best = { path, bytes, triangles };
  }
  if (!best) {
    throw new ChatServiceError(
      "Local decimation only supports GLB models; re-export this asset as GLB first",
      409,
      "retopo_source_unsupported",
    );
  }
  return best;
}

export async function runLocalRetopology(
  storage: AssetStorage,
  params: LocalRetopoParams,
): Promise<LocalRetopoResult> {
  const dir = assetDir(params.projectSlug, params.assetSlug);
  const source = await pickHighestPolyModel(storage, dir);

  await params.onPhase?.("generating");
  const doc = await new NodeIO().readBinary(source.bytes);
  const plans = collectPrimitives(doc);
  const fromFaces = plans.reduce((sum, plan) => sum + plan.triangles, 0);
  if (fromFaces === 0) {
    throw new ChatServiceError("The source model has no triangles", 409, "retopo_empty_model");
  }

  const target = params.targetPolycount ?? defaultRetopoFaces(fromFaces);
  if (target < LOCAL_RETOPO_FACES.min || target > LOCAL_RETOPO_FACES.max) {
    throw new ChatServiceError(
      `The target face count must be within ${LOCAL_RETOPO_FACES.min}–${LOCAL_RETOPO_FACES.max}`,
      400,
      "retopo_target_invalid",
    );
  }
  if (target >= fromFaces) {
    throw new ChatServiceError(
      `The model already has ${fromFaces} triangles, at or below the requested ${target}; nothing to decimate`,
      409,
      "retopo_not_needed",
    );
  }

  await MeshoptSimplifier.ready;
  const budget = distribute(target, plans);
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  let sloppy = false;
  plans.forEach((plan, i) => {
    const simplified = simplifyPrimitive(plan, budget[i]!, target < UV_SAFE_FLOOR);
    if (!simplified) return;
    sloppy ||= simplified.sloppy;
    plan.primitive.setIndices(
      doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(simplified.indices)).setBuffer(buffer),
    );
  });

  await doc.transform(dedup(), prune());

  await params.onPhase?.("publishing");
  const bytes = await new NodeIO().writeBinary(doc);
  const index = nextIndex(await storage.list(dir));
  const modelPath = `${dir}/${formatIndexedName(index, params.assetSlug, "glb")}`;
  await storage.writeBytes(modelPath, bytes);

  const faces = collectPrimitives(doc).reduce((sum, plan) => sum + plan.triangles, 0);
  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: "local",
    model: "meshoptimizer",
    params: {
      source: source.path,
      target_faces: target,
      from_faces: fromFaces,
      faces,
      sloppy,
    },
    status: "succeeded",
    outputs: [{ path: modelPath }],
    createdAt: now(),
    updatedAt: now(),
  };
  await writeJson(
    storage,
    `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`,
    RequestSidecarSchema,
    sidecar,
  );

  return { model: modelPath, files: [modelPath], fromFaces, faces, target, sloppy };
}

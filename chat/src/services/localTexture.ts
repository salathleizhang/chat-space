import { NodeIO, type Document, type Primitive } from "@gltf-transform/core";
import { ChatServiceError } from "../common/errors";
import { fetchWithTimeout } from "../common/http";
import {
  formatIndexedName,
  formatRequestSidecarName,
  nextIndex,
} from "../common/indexedFiles";
import { assetDir } from "../common/libraryPaths";
import { RequestSidecarSchema, type RequestSidecar } from "../dto/library";
import type { GenerationPhase } from "../dto/tasks";
import { routeImageGenerateChannel, runImageGenerate } from "../models/images";
import { writeJson, type AssetStorage } from "./assetStorage";
import { pickHighestPolyModel } from "./localRetopo";

/**
 * 本地贴图：火山生图引擎（Seedream）出一张**无缝平铺**材质图，再用盒式投影写进 GLB。
 *
 * 为什么不是 Tripo 那种"按参考图重绘"：那需要 3D 感知的贴图模型，现在没有替代。
 * 折中方案是把材质当"瓷砖"：Seedream 只负责出一张没有阴影、没有物件、可平铺的材质，
 * 映射交给确定性算法，所以**不会把纹理画歪**，代价是图案是通用材质而不是这只沙发的花色。
 *
 * 投影规则：按顶点法线的主轴做盒式投影（X/Y/Z 三面），UV = 另两个轴的坐标 / 每张贴图覆盖的长度。
 * 接缝处会有一条拉伸带，硬表面家具（木、布、皮）可以接受；UV 展开（Hunyuan）仍留给需要精修的场景。
 */

/** 一张贴图覆盖模型最长边的几分之一。4 = 最长边上平铺 4 次。 */
export const TEXTURE_TILES = { min: 1, max: 32, default: 4 } as const;

/** 贴图生成的提示词尾巴：确保它是一张能平铺的材质图，而不是一张带场景的照片。 */
const SEAMLESS_SUFFIX =
  "Seamless tileable material texture only, flat top-down view, even lighting, no shadows, no objects, no furniture, no text, fills the entire frame, high detail, photorealistic PBR albedo";

export interface LocalTextureParams {
  projectSlug: string;
  assetSlug: string;
  /** 材质描述，例如 "warm oak wood, matte finish" */
  prompt: string;
  tiles?: number;
  volcengineApiKey: string;
  fetchFn?: typeof fetch;
  onPhase?: (phase: GenerationPhase) => Promise<void> | void;
}

export interface LocalTextureResult {
  model: string;
  files: string[];
  texture: string;
  fromFaces: number;
  tiles: number;
}

function readFloats(accessor: ReturnType<Primitive["getAttribute"]>): Float32Array | null {
  if (!accessor) return null;
  const array = accessor.getArray();
  if (!array) return null;
  if (array instanceof Float32Array && !accessor.getNormalized()) return array;
  const size = accessor.getElementSize();
  const out = new Float32Array(accessor.getCount() * size);
  const scratch: number[] = [];
  for (let i = 0; i < accessor.getCount(); i++) {
    accessor.getElement(i, scratch);
    for (let k = 0; k < size; k++) out[i * size + k] = scratch[k] ?? 0;
  }
  return out;
}

function readIndices(primitive: Primitive, vertexCount: number): Uint32Array {
  const accessor = primitive.getIndices();
  if (!accessor) {
    const sequential = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) sequential[i] = i;
    return sequential;
  }
  const out = new Uint32Array(accessor.getCount());
  for (let i = 0; i < out.length; i++) out[i] = accessor.getScalar(i);
  return out;
}

/** 模型没有法线时按面积加权累积面法线——盒式投影只需要"朝哪边"这一个信息。 */
function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    const e1x = positions[b]! - positions[a]!;
    const e1y = positions[b + 1]! - positions[a + 1]!;
    const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!;
    const e2y = positions[c + 1]! - positions[a + 1]!;
    const e2z = positions[c + 2]! - positions[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const base of [a, b, c]) {
      normals[base] = (normals[base] ?? 0) + nx;
      normals[base + 1] = (normals[base + 1] ?? 0) + ny;
      normals[base + 2] = (normals[base + 2] ?? 0) + nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    normals[i] = normals[i]! / length;
    normals[i + 1] = normals[i + 1]! / length;
    normals[i + 2] = normals[i + 2]! / length;
  }
  return normals;
}

function boundingExtent(doc: Document): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = readFloats(primitive.getAttribute("POSITION"));
      if (!position) continue;
      for (let i = 0; i < position.length; i += 3) {
        minX = Math.min(minX, position[i]!); maxX = Math.max(maxX, position[i]!);
        minY = Math.min(minY, position[i + 1]!); maxY = Math.max(maxY, position[i + 1]!);
        minZ = Math.min(minZ, position[i + 2]!); maxZ = Math.max(maxZ, position[i + 2]!);
      }
    }
  }
  if (!Number.isFinite(minX)) return 1;
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
}

/** 盒式投影 + 写入材质贴图；返回动了多少个 primitive。 */
function applyBoxTexture(doc: Document, image: Uint8Array, mime: string, tiles: number): number {
  const extent = boundingExtent(doc);
  const span = extent / tiles;
  const texture = doc.createTexture("material").setImage(image).setMimeType(mime);
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  let touched = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = readFloats(primitive.getAttribute("POSITION"));
      if (!position) continue;
      const count = position.length / 3;
      const normals =
        readFloats(primitive.getAttribute("NORMAL")) ??
        computeNormals(position, readIndices(primitive, count));
      const uv = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const nx = Math.abs(normals[i * 3] ?? 0);
        const ny = Math.abs(normals[i * 3 + 1] ?? 0);
        const nz = Math.abs(normals[i * 3 + 2] ?? 0);
        const x = position[i * 3]!;
        const y = position[i * 3 + 1]!;
        const z = position[i * 3 + 2]!;
        let u: number, v: number;
        if (nx >= ny && nx >= nz) {
          u = z; v = y;
        } else if (ny >= nz) {
          u = x; v = z;
        } else {
          u = x; v = y;
        }
        uv[i * 2] = u / span;
        uv[i * 2 + 1] = v / span;
      }
      primitive.setAttribute(
        "TEXCOORD_0",
        doc.createAccessor().setType("VEC2").setArray(uv).setBuffer(buffer),
      );

      const material =
        primitive.getMaterial() ?? doc.createMaterial(`material-${touched + 1}`);
      material.setBaseColorTexture(texture).setBaseColorFactor([1, 1, 1, 1]);
      primitive.setMaterial(material);
      touched++;
    }
  }
  return touched;
}

/** base64 → bytes：只用 `atob`（浏览器 / Bun / Node 18+ 都有），不依赖 Buffer 全局。 */
function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function imageBytes(
  ref: { url?: string; dataBase64?: string; mimeType?: string },
  fetchFn: typeof fetch,
): Promise<{ bytes: Uint8Array; mime: string }> {
  if (ref.dataBase64) {
    return {
      bytes: base64Bytes(ref.dataBase64),
      mime: ref.mimeType ?? "image/png",
    };
  }
  if (!ref.url) {
    throw new ChatServiceError("The image engine returned no image", 502, "texture_no_image");
  }
  const response = await fetchWithTimeout(fetchFn, ref.url, {}, 120_000, "texture image download");
  const buffer = await response.arrayBuffer();
  const mime =
    response.headers.get("content-type")?.split(";")[0] ??
    ref.mimeType ??
    "image/png";
  return { bytes: new Uint8Array(buffer), mime };
}

export async function runLocalTexture(
  storage: AssetStorage,
  params: LocalTextureParams,
): Promise<LocalTextureResult> {
  const dir = assetDir(params.projectSlug, params.assetSlug);
  const source = await pickHighestPolyModel(storage, dir);
  const tiles = params.tiles ?? TEXTURE_TILES.default;
  if (tiles < TEXTURE_TILES.min || tiles > TEXTURE_TILES.max) {
    throw new ChatServiceError(
      `textureScale must be within ${TEXTURE_TILES.min}–${TEXTURE_TILES.max}`,
      400,
      "texture_scale_invalid",
    );
  }
  if (!params.prompt.trim()) {
    throw new ChatServiceError("Describe the material to generate", 400, "texture_prompt_missing");
  }

  await params.onPhase?.("generating");
  const route = routeImageGenerateChannel(
    "seedream-5",
    { volcengineApiKey: params.volcengineApiKey },
    "volcengine",
  );
  const fetchFn = params.fetchFn ?? fetch;
  const { refs } = await runImageGenerate(
    route.channel,
    route.entry,
    { prompt: `${params.prompt.trim()}. ${SEAMLESS_SUFFIX}`, count: 1, canvas: "square" },
    route.apiKey,
    { fetchFn },
  );
  const ref = refs[0];
  if (!ref) throw new ChatServiceError("The image engine returned no image", 502, "texture_no_image");

  await params.onPhase?.("downloading");
  const image = await imageBytes(ref, fetchFn);

  const index = nextIndex(await storage.list(dir));
  const texturePath = `${dir}/${formatIndexedName(index, `${params.assetSlug}-texture`, "png")}`;
  await storage.writeBytes(texturePath, image.bytes);

  const doc = await new NodeIO().readBinary(source.bytes);
  const touched = applyBoxTexture(doc, image.bytes, image.mime, tiles);
  if (touched === 0) {
    throw new ChatServiceError("The model has no drawable primitive to texture", 409, "texture_no_primitives");
  }

  await params.onPhase?.("publishing");
  const modelPath = `${dir}/${formatIndexedName(index, params.assetSlug, "glb")}`;
  await storage.writeBytes(modelPath, await new NodeIO().writeBinary(doc));

  const now = () => new Date().toISOString();
  const sidecar: RequestSidecar = {
    schemaVersion: 1,
    index,
    slug: params.assetSlug,
    provider: "local",
    model: "seedream-texture",
    params: {
      source: source.path,
      texture: texturePath,
      prompt: params.prompt,
      tiles,
      from_faces: source.triangles,
    },
    status: "succeeded",
    outputs: [{ path: modelPath }, { path: texturePath }],
    createdAt: now(),
    updatedAt: now(),
  };
  await writeJson(
    storage,
    `${dir}/${formatRequestSidecarName(index, params.assetSlug)}`,
    RequestSidecarSchema,
    sidecar,
  );

  return { model: modelPath, files: [modelPath, texturePath], texture: texturePath, fromFaces: source.triangles, tiles };
}

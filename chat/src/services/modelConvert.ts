import { posix } from "node:path";
import { NodeIO, type GLTF } from "@gltf-transform/core";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ChatServiceError } from "../common/errors";
import type { ExportFormat } from "../dto/library";
import type { AssetStorage } from "./assetStorage";
import { glbToSkp } from "./skpExport";

export interface ConvertedFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  skp: "application/vnd.sketchup.skp",
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  ktx2: "image/ktx2",
};

function toDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * glb → 单文件内嵌 .gltf：buffer/贴图资源转 data URI 塞回 json，不落地外部 .bin/贴图文件。
 * 只是解包同一份 glTF 文档模型换个容器装，不经场景图重建，材质/骨骼/动画 clip 无损。
 */
async function glbToEmbeddedGltf(glbBytes: Uint8Array): Promise<Uint8Array> {
  const io = new NodeIO();
  const document = await io.readBinary(glbBytes);
  const { json, resources } = await io.writeJSON(document);
  return embedGltfResources(json, async (uri) => {
    const bytes = resources[uri];
    if (!bytes) throw new ChatServiceError(`Export is missing a resource: ${uri}`, 422, "export_resource_missing");
    return bytes;
  });
}

/** 直接替换 URI，保留原文档的扩展、动画和其他字段。已内嵌的资源不重复处理。 */
async function embedGltfResources(
  json: GLTF.IGLTF,
  readResource: (uri: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  for (const buffer of json.buffers ?? []) {
    if (buffer.uri && !/^data:/i.test(buffer.uri)) {
      buffer.uri = toDataUri(await readResource(buffer.uri), "application/octet-stream");
    }
  }
  for (const image of json.images ?? []) {
    if (image.uri && !/^data:/i.test(image.uri)) {
      const ext = image.uri.split(/[?#]/)[0]!.split(".").pop()?.toLowerCase() ?? "";
      image.uri = toDataUri(
        await readResource(image.uri),
        image.mimeType ?? IMAGE_MIME_BY_EXT[ext] ?? "application/octet-stream",
      );
    }
  }
  return new TextEncoder().encode(JSON.stringify(json));
}

async function embedLocalGltf(storage: AssetStorage, sourcePath: string): Promise<Uint8Array> {
  const json = JSON.parse(await storage.readText(sourcePath)) as GLTF.IGLTF;
  const dir = `${posix.dirname(sourcePath)}/`;
  return embedGltfResources(json, async (uri) => {
    const relative = decodeURIComponent(uri.split(/[?#]/)[0]!);
    const path = posix.normalize(`${dir}${relative}`);
    // 外部依赖只能从当前模型目录经存储层读取；导出不访问网络或任意磁盘文件。
    if (/^[a-z][a-z\d+.-]*:|^\//i.test(relative) || relative.includes("\\") || !path.startsWith(dir)) {
      throw new ChatServiceError(`Model resources must live inside the asset directory: ${uri}`, 400, "invalid_model_resource");
    }
    if (!(await storage.exists(path))) {
      throw new ChatServiceError(`Export is missing a resource: ${uri}`, 422, "export_resource_missing");
    }
    return storage.readBytes(path);
  });
}

/**
 * glb → OBJ：three.js 场景图往返（GLTFLoader 解出 Scene → OBJExporter 写出）。
 * OBJ 格式本身不支持骨骼/动画/材质贴图像素，走这条路会丢——是格式能力上限，不是实现缺陷。
 * 贴图解码在无 DOM 的 Bun 里会失败并打印一条 warning，但不影响几何导出，可以忽略。
 */
async function glbToObj(glbBytes: Uint8Array): Promise<Uint8Array> {
  const arrayBuffer = glbBytes.buffer.slice(
    glbBytes.byteOffset,
    glbBytes.byteOffset + glbBytes.byteLength,
  ) as ArrayBuffer;
  const loader = new GLTFLoader();
  const gltf = await new Promise<{ scene: Parameters<OBJExporter["parse"]>[0] }>(
    (resolve, reject) => {
      loader.parse(arrayBuffer, "", resolve, reject);
    },
  );
  const text = new OBJExporter().parse(gltf.scene);
  return new TextEncoder().encode(text);
}

function baseNameOf(logicalPath: string): string {
  return (logicalPath.split("/").pop() ?? logicalPath).replace(/\.[^.]+$/, "");
}

/**
 * 资产库内模型格式转换：只支持 glb 源（同索引优先 glb 的取舍下，绝大多数资产本就是 glb）。
 * glTF 原格式导出会内嵌外部 buffer/图片；skp 走 openskp 的三角汤写入器（带贴图与三角数准入）；
 * 其他非 glb 源不支持跨格式转换。
 */
export async function convertModel(
  storage: AssetStorage,
  sourcePath: string,
  targetFormat: ExportFormat,
): Promise<ConvertedFile> {
  const sourceExt = sourcePath.split(".").pop()?.toLowerCase() ?? "";
  const fileName = `${baseNameOf(sourcePath)}.${targetFormat}`;

  if (sourceExt === targetFormat) {
    return {
      fileName,
      mimeType: MIME_BY_FORMAT[targetFormat],
      bytes: sourceExt === "gltf"
        ? await embedLocalGltf(storage, sourcePath)
        : await storage.readBytes(sourcePath),
    };
  }
  if (sourceExt !== "glb") {
    throw new ChatServiceError(
      `Only glb source assets can be converted for export; the current asset format is ${sourceExt || "unknown"}`,
      400,
      "unsupported_conversion_source",
    );
  }

  const glbBytes = await storage.readBytes(sourcePath);
  let bytes: Uint8Array;
  if (targetFormat === "gltf") {
    bytes = await glbToEmbeddedGltf(glbBytes);
  } else if (targetFormat === "skp") {
    const result = await glbToSkp(glbBytes);
    // 减面、贴图降级这类"文件与源不完全一致"的事必须留痕，否则只能靠猜
    if (result.decimatedFrom !== undefined || result.notices.length > 0) {
      console.warn(
        `[export] ${sourcePath} → skp：写入 ${result.facesWritten} 个面` +
          (result.decimatedFrom !== undefined
            ? `（源 ${result.decimatedFrom} 三角面，超过准入后已自动减面到 ${result.triangles}）`
            : "") +
          (result.facesWithoutUv > 0 ? `；${result.facesWithoutUv} 个面 UV 退化未钉贴图` : "") +
          (result.notices.length > 0 ? `；${result.notices.join("；")}` : ""),
      );
    }
    bytes = result.bytes;
  } else {
    bytes = await glbToObj(glbBytes);
  }
  return { fileName, mimeType: MIME_BY_FORMAT[targetFormat], bytes };
}

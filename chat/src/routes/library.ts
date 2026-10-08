import { Hono } from "hono";
import JSZip from "jszip";
import { ChatServiceError } from "../common/errors";
import { ExportBatchRequestSchema, ExportFormatSchema } from "../dto/library";
import { getAssetStorage } from "../services/assetStorage";
import { convertModel, type ConvertedFile } from "../services/modelConvert";

/**
 * 资产库静态文件服务：前端（3D 视口）只读经此提供的本地资产（§5 磁盘优先）。
 * 路径即逻辑路径，越界/穿越由存储访问层统一拒绝。
 */

const CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain",
  mtl: "text/plain",
  fbx: "application/octet-stream",
  bin: "application/octet-stream",
  spz: "application/octet-stream",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  json: "application/json",
};

export const libraryRoutes = new Hono();

function contentDisposition(fileName: string): string {
  return `attachment; filename="${encodeURIComponent(fileName)}"`;
}

/** 单资产导出：?source=<逻辑路径>&format=glb|gltf|obj，同格式直接原样下载，不转换 */
libraryRoutes.get("/export", async (c) => {
  const source = c.req.query("source");
  const format = ExportFormatSchema.parse(c.req.query("format"));
  if (!source) {
    throw new ChatServiceError("缺少 source 参数", 400, "missing_source");
  }
  const storage = getAssetStorage();
  if (!(await storage.exists(source))) {
    return c.json({ error: { code: "not_found", message: `文件不存在：${source}` } }, 404);
  }
  const result = await convertModel(storage, source, format);
  return new Response(storage.readStream ? new Blob([result.bytes.buffer.slice(0) as ArrayBuffer]).stream() : result.bytes.buffer.slice(0) as ArrayBuffer, {
    headers: {
      "Content-Type": result.mimeType,
      "Content-Disposition": contentDisposition(result.fileName),
      "Cache-Control": "no-cache",
    },
  });
});

/**
 * 批量导出：多个逻辑路径统一转成同一目标格式；单个失败不拖垮整批，跳过并记录说明。
 * 只成功转出一个文件时（单选场景，也是导入按钮旁"批量导出"入口选中 1 个资产的常见情形）
 * 直接原样返回该文件，不套一层 zip——用户不用为一个文件多解压一步。
 */
libraryRoutes.post("/export-batch", async (c) => {
  const req = ExportBatchRequestSchema.parse(await c.req.json());
  const storage = getAssetStorage();
  const converted: ConvertedFile[] = [];
  const skipped: string[] = [];

  for (const source of req.sources) {
    try {
      if (!(await storage.exists(source))) {
        skipped.push(`${source}：文件不存在`);
        continue;
      }
      converted.push(await convertModel(storage, source, req.format));
    } catch (err) {
      skipped.push(`${source}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (converted.length === 0) {
    throw new ChatServiceError(
      `批量导出全部失败：${skipped.join("；")}`,
      422,
      "export_batch_all_failed",
    );
  }

  if (converted.length === 1 && skipped.length === 0) {
    const only = converted[0]!;
    return new Response(storage.readStream ? new Blob([only.bytes.buffer.slice(0) as ArrayBuffer]).stream() : only.bytes.buffer.slice(0) as ArrayBuffer, {
      headers: {
        "Content-Type": only.mimeType,
        "Content-Disposition": contentDisposition(only.fileName),
        "Cache-Control": "no-cache",
      },
    });
  }

  const zip = new JSZip();
  const usedNames = new Set<string>();
  for (const file of converted) {
    let name = file.fileName;
    let dedupe = 1;
    while (usedNames.has(name)) {
      name = `${file.fileName.replace(/\.[^.]+$/, "")}-${++dedupe}.${req.format}`;
    }
    usedNames.add(name);
    zip.file(name, file.bytes);
  }
  if (skipped.length > 0) {
    zip.file("跳过说明.txt", skipped.join("\n"));
  }

  const zipBytes = await zip.generateAsync({ type: "uint8array" });
  return new Response(storage.readStream ? new Blob([zipBytes.buffer.slice(0) as ArrayBuffer]).stream() : zipBytes.buffer.slice(0) as ArrayBuffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`export-${req.format}.zip`),
      "Cache-Control": "no-cache",
    },
  });
});

libraryRoutes.get("/*", async (c) => {
  // Hono 的 c.req.path 已经解码；再套一层 decodeURIComponent 是二次解码，且裸 % 会抛
  // URIError 被归为 500。逻辑路径只由 slug 与扩展名构成，直接用解码后的 path 即可。
  const logicalPath = c.req.path.replace(/^\/api\/library\//, "");
  const storage = getAssetStorage();
  if (!(await storage.exists(logicalPath))) {
    return c.json(
      { error: { code: "not_found", message: `文件不存在：${logicalPath}` } },
      404,
    );
  }
  const body = storage.readStream ? await storage.readStream(logicalPath) : (await storage.readBytes(logicalPath)).buffer.slice(0) as ArrayBuffer;
  const ext = logicalPath.split(".").pop()?.toLowerCase() ?? "";
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    },
  });
});

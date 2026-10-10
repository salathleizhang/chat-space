import { createAssetIdentity, AssetIdentitySchema, RequestSidecarSchema, SlugSchema } from "../../../chat/src/dto/library";
import { assetDir, assetIdentityFile, projectFile } from "../../../chat/src/common/libraryPaths";
import { glbTriangleCount } from "../../../chat/src/common/glb";
import { BrowserAssetStorage, commitLocal, localEntry } from "./storage";
import { blenderService } from "../widgets/BlenderLive/service";

type Export = { id: string; sessionId: string; bytes: number; sha256: string; triangles: number; url?: string };
/** Per-export Web Lock + one IndexedDB transaction makes multi-tab imports idempotent. */
export async function importCloudBlenderExports(project: string, sessionId: string): Promise<number> {
  SlugSchema.parse(project);
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) throw new Error("无效 Blender 会话");
  const storage = new BrowserAssetStorage();
  if (!await storage.exists(projectFile(project))) throw new Error("本地项目已不存在");
  const { session } = await blenderService<{ session: { project: string } }>(`sessions/${sessionId}`);
  if (session.project !== project) throw new Error("模型属于其他工程");
  const { exports } = await blenderService<{ exports: Export[] }>(`sessions/${sessionId}/exports`);
  let count = 0;
  for (const artifact of exports) {
    if (!/^[a-f0-9-]{36}$/.test(artifact.id) || artifact.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("模型清单无效");
    const imported = await storage.withLock(`projects/${project}/blender-import-${artifact.id}`, async () => {
      const slug = `blender-${artifact.id}`, dir = assetDir(project, slug), identityPath = assetIdentityFile(project, slug);
      const receiptPath = `projects/${project}/blender-imports/${artifact.id}.json`;
      const prior = await localEntry(receiptPath);
      if (prior && await storage.exists(identityPath)) {
        const receipt = JSON.parse(typeof prior.value === "string" ? prior.value : await prior.value.text());
        if (receipt.sha256 !== artifact.sha256) throw new Error("导出身份对应的文件已变化");
        return false;
      }
      if (await storage.exists(identityPath)) throw new Error("资产名称已被占用，已保留云端模型");
      const ticket = await blenderService<Export & { url: string }>(`exports/${artifact.id}`);
      const url = new URL(ticket.url);
      if (url.protocol !== "https:" || url.username || url.password || ticket.sha256 !== artifact.sha256 || ticket.bytes !== artifact.bytes) throw new Error("下载凭证无效");
      const response = await fetch(url, { credentials: "omit", redirect: "error" });
      if (!response.ok || !response.body) throw new Error("模型下载失败，云端作品仍保留");
      if (artifact.bytes < 20 || artifact.bytes > 256 * 1024 * 1024) throw new Error("模型超出导入大小限制");
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
          if (size > artifact.bytes) throw new Error("模型大小与清单不符"); parts.push(chunk.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (size !== artifact.bytes) throw new Error("模型文件不完整");
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2, "0")).join("");
      if (hash !== artifact.sha256 || glbTriangleCount(bytes) !== artifact.triangles) throw new Error("模型校验失败");
      const now = new Date().toISOString(), modelPath = `${dir}/0-${slug}.glb`;
      const identity = AssetIdentitySchema.parse(createAssetIdentity({ slug, kind: "model", name: `Blender ${artifact.id.slice(0, 6)}`, intent: "云端 Blender 导出", sourceImages: [] }));
      const sidecar = RequestSidecarSchema.parse({ schemaVersion: 1, index: 0, slug, provider: "blender", model: "customized-cloud", params: { sessionId, exportId: artifact.id },
        status: "succeeded", outputs: [{ path: modelPath }], createdAt: now, updatedAt: now });
      await commitLocal([
        { path: modelPath, value: new Blob([bytes], { type: "model/gltf-binary" }), updatedAt: Date.now() },
        { path: `${dir}/.0-${slug}-request.json`, value: JSON.stringify(sidecar), updatedAt: Date.now() },
        { path: identityPath, value: JSON.stringify(identity), updatedAt: Date.now() },
        { path: receiptPath, value: JSON.stringify({ exportId: artifact.id, sha256: hash, assetId: identity.id }), updatedAt: Date.now() },
      ]);
      return true;
    });
    if (imported) count++;
  }
  return count;
}

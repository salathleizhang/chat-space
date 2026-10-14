import { createHash } from "node:crypto";
import { TosClient } from "@volcengine/tos-sdk";
import { cloudBudget } from "../models/cloudBudget";
import { immutableTosPut } from "./tosRequest";
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, type: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  downloadUrl(key: string, seconds?: number): string;
}
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function objectKey(owner: string, project: string, session: string, kind: "checkpoints" | "exports", id: string, file: string): string {
  if (![owner, project, session, id].every(s => /^[A-Za-z0-9_-]{1,128}$/.test(s)) || !["scene.blend", "model.glb", "manifest.json"].includes(file)) throw new Error("Invalid object scope");
  return `blender/${owner}/${project}/${session}/${kind}/${id}/${file}`;
}
export async function boundedBody(response: Response, limit = MAX_OBJECT_BYTES): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new Error("Object transfer rejected");
  }
  if (!response.body) throw new Error("Object body missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      if (size > limit) throw new Error("Object exceeds size limit"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
/** SDK signs immutable PUT headers and scoped GET URLs; task-pump bounds transfers. */
export class TosObjects implements ObjectStore {
  constructor(private readonly client: TosClient, private readonly bucket: string, private readonly fetchFn: typeof fetch = fetch) {}
  private url(key: string, method: "GET" | "PUT", seconds = 300): string {
    if (!key.startsWith("blender/") || key.split("/").some(p => !p || p === "..")) throw new Error("Invalid TOS key");
    return this.client.getPreSignedUrl({ bucket: this.bucket, key, method, expires: seconds });
  }
  downloadUrl(key: string, seconds = 300) { return this.url(key, "GET", seconds); }
  async put(key: string, bytes: Uint8Array, type: string): Promise<void> {
    if (!bytes.length || bytes.length > MAX_OBJECT_BYTES) throw new Error("Invalid object size");
    await cloudBudget(async signal => {
      const signed = await immutableTosPut(this.client, this.bucket, key, bytes.length, createHash("md5").update(bytes).digest("base64"), type);
      const response = await this.fetchFn.call(globalThis, signed.url, { method: "PUT", redirect: "manual", signal,
        headers: signed.headers,
        body: Buffer.from(bytes) });
      await response.body?.cancel();
      if (!response.ok && response.status !== 409) throw new Error("TOS upload failed");
    }, 300_000);
    // Read-back verifies actual persisted bytes before the manifest/latest pointer is committed.
    const persisted = await this.get(key);
    if (persisted.length !== bytes.length || sha256(persisted) !== sha256(bytes)) throw new Error("TOS checksum mismatch");
  }
  get(key: string): Promise<Uint8Array> {
    return cloudBudget(async signal => boundedBody(await this.fetchFn.call(globalThis, this.url(key, "GET"), { signal, redirect: "manual" })), 300_000);
  }
}

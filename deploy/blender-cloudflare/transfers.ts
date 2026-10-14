import { createHash } from "node:crypto";
import { z } from "zod";
import { TosClient } from "@volcengine/tos-sdk";
import { cloudBudget } from "../../chat/src/models/cloudBudget";
import { objectKey, boundedBody, MAX_OBJECT_BYTES } from "../../chat/src/blenderService/objects";
import { immutableTosPut } from "../../chat/src/blenderService/tosRequest";
import type { BlenderStore, Checkpoint, Session, Operation } from "../../chat/src/blenderService/storeCore";
import type { Artifact } from "../../chat/src/blenderService/artifacts";

const integer = z.number().int().nonnegative();
const Gltf = z.object({
  buffers: z.array(z.object({ byteLength: integer, uri: z.string().optional() })),
  bufferViews: z.array(z.object({ buffer: integer, byteOffset: integer.default(0), byteLength: integer, byteStride: integer.optional() })),
  accessors: z.array(z.object({ bufferView: integer.optional(), byteOffset: integer.default(0), componentType: integer, count: integer, type: z.string(), sparse: z.unknown().optional() })),
  meshes: z.array(z.object({ primitives: z.array(z.object({ attributes: z.record(z.string(), integer), indices: integer.optional(), mode: integer.default(4), extensions: z.unknown().optional() })) })),
  images: z.array(z.object({ uri: z.string().optional(), bufferView: integer.optional() })).optional(),
});
type PositionRange = { start: number; stride: number; count: number; cursor: number };
export interface FileDigest { bytes: number; sha256: string; md5: string; triangles: number }

/** Inspect the binary stream without retaining geometry/images. JSON metadata is bounded to 2 MiB. */
export class FileInspector {
  private readonly hash = createHash("sha256");
  private readonly md5 = createHash("md5");
  private prefix = new Uint8Array();
  private tail = new Uint8Array();
  private ranges: PositionRange[] | null = null;
  private total = 0;
  private declared = 0;
  private triangles = 0;
  constructor(private readonly kind: "blend" | "glb" | "opaque") {}
  feed(chunk: Uint8Array): void {
    const offset = this.total; this.total += chunk.length;
    if (this.total > MAX_OBJECT_BYTES) throw new Error("File exceeds size limit");
    this.hash.update(chunk); this.md5.update(chunk);
    if (this.kind === "opaque") return;
    if (this.kind === "blend") {
      if (this.prefix.length < 7) this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, 7 - this.prefix.length)]);
      return;
    }
    if (!this.ranges) {
      const prefixLimit = 2 * 1024 * 1024 + 28;
      this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, Math.max(0, prefixLimit - this.prefix.length))]);
      if (this.prefix.length < 20) return;
      const view = new DataView(this.prefix.buffer, this.prefix.byteOffset, this.prefix.byteLength);
      const jsonBytes = view.getUint32(12, true);
      this.declared = view.getUint32(8, true);
      if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a ||
          jsonBytes > 2 * 1024 * 1024 || jsonBytes % 4 || this.declared > MAX_OBJECT_BYTES) throw new Error("Invalid GLB header");
      const binOffset = 28 + jsonBytes;
      if (this.prefix.length < binOffset) return;
      const binBytes = view.getUint32(20 + jsonBytes, true);
      if (view.getUint32(24 + jsonBytes, true) !== 0x004e4942 || binOffset + binBytes !== this.declared) throw new Error("Invalid GLB binary chunk");
      const gltf = Gltf.parse(JSON.parse(new TextDecoder().decode(this.prefix.subarray(20, 20 + jsonBytes))));
      if (gltf.buffers.length !== 1 || gltf.buffers[0]!.uri || gltf.buffers[0]!.byteLength > binBytes) throw new Error("GLB must be self contained");
      if (gltf.images?.some(image => image.uri && !image.uri.startsWith("data:"))) throw new Error("External GLB texture forbidden");
      this.ranges = [];
      const seen = new Set<number>();
      for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) {
        const index = primitive.attributes.POSITION, positions = index === undefined ? undefined : gltf.accessors[index];
        if (!positions || positions.componentType !== 5126 || positions.type !== "VEC3" || positions.count < 3 || positions.sparse || primitive.mode !== 4 || primitive.extensions) throw new Error("Unsupported or empty GLB geometry");
        const indices = primitive.indices === undefined ? positions : gltf.accessors[primitive.indices];
        if (!indices || indices.count < 3 || indices.count % 3) throw new Error("Invalid GLB triangles");
        this.triangles += indices.count / 3;
        if (seen.has(index!)) continue;
        seen.add(index!);
        const bufferView = positions.bufferView === undefined ? undefined : gltf.bufferViews[positions.bufferView];
        if (!bufferView || bufferView.buffer !== 0) throw new Error("Invalid GLB positions");
        const stride = bufferView.byteStride ?? 12, start = bufferView.byteOffset + positions.byteOffset;
        const end = start + (positions.count - 1) * stride + 12;
        if (stride < 12 || stride % 4 || start % 4 || end > bufferView.byteOffset + bufferView.byteLength || end > gltf.buffers[0]!.byteLength) throw new Error("GLB positions out of bounds");
        this.ranges.push({ start: start + binOffset, stride, count: positions.count, cursor: 0 });
      }
      if (!this.ranges.length || this.triangles < 1) throw new Error("GLB has no geometry");
      this.scan(this.prefix, 0);
      this.prefix = new Uint8Array();
      // A very large first chunk may have exceeded the prefix limit. Scan its remaining bytes.
      if (offset + chunk.length > prefixLimit) this.scan(chunk.subarray(Math.max(0, prefixLimit - offset)), Math.max(offset, prefixLimit));
    } else this.scan(chunk, offset);
  }
  private scan(chunk: Uint8Array, offset: number): void {
    const bytes = Buffer.concat([this.tail, chunk]), base = offset - this.tail.length;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const range of this.ranges!) {
      while (range.cursor < range.count * 3) {
        const at = range.start + Math.floor(range.cursor / 3) * range.stride + (range.cursor % 3) * 4;
        if (at + 4 > base + bytes.length) break;
        if (at < base || !Number.isFinite(view.getFloat32(at - base, true))) throw new Error("Invalid GLB position value");
        range.cursor++;
      }
    }
    this.tail = bytes.slice(Math.max(0, bytes.length - 3));
  }
  finish(): FileDigest {
    if (!this.total || this.kind === "blend" && new TextDecoder().decode(this.prefix) !== "BLENDER" ||
        this.kind === "glb" && (!this.ranges || this.total !== this.declared || this.ranges.some(r => r.cursor !== r.count * 3))) throw new Error("Invalid or truncated file");
    return { bytes: this.total, sha256: this.hash.digest("hex"), md5: this.md5.digest("base64"), triangles: this.triangles };
  }
}

async function inspect(response: Response, kind: "blend" | "glb" | "opaque"): Promise<FileDigest> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_OBJECT_BYTES) { await response.body?.cancel(); throw new Error("File transfer rejected"); }
  const reader = response.body.getReader(), inspector = new FileInspector(kind);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; inspector.feed(value); } return inspector.finish(); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Scoped signed TOS URLs; no cloud credentials enter Blender or a browser. */
export class StreamingFiles {
  constructor(private readonly store: BlenderStore, private readonly tos: TosClient, private readonly bucket: string, private readonly target: string) {
    store.db.exec("CREATE TABLE IF NOT EXISTS blender_exports (id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id),objectKey TEXT NOT NULL,manifestKey TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,triangles INTEGER NOT NULL)");
  }
  private url(key: string, method: "GET" | "PUT") { return this.tos.getPreSignedUrl({ bucket: this.bucket, key, method, expires: 300 }); }
  private headers(s: Session, token: string) {
    if (!s.instance) throw new Error("Sandbox missing");
    return { Authorization: `Bearer ${token}`, "x-faas-instance-name": s.instance, "x-chatspace-session": s.id, "x-chatspace-epoch": String(s.epoch) };
  }
  private source(s: Session, token: string, path: string, signal: AbortSignal) { return fetch(new URL(path, this.target), { headers: this.headers(s, token), signal, redirect: "manual" }); }
  private async relay(source: Response, url: string | URL, expected: FileDigest, headers: Record<string, string>, signal: AbortSignal, allowExisting = false) {
    if (!source.ok || !source.body) { await source.body?.cancel(); throw new Error("Source unavailable"); }
    const inspector = new FileInspector("opaque"), fixed = new FixedLengthStream(expected.bytes);
    const checked = source.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) { inspector.feed(bytes); controller.enqueue(bytes); },
      flush() { const actual = inspector.finish(); if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("Immutable file changed"); },
    }));
    const wire = new AbortController(), abort = () => wire.abort();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    let results: [PromiseSettledResult<void>, PromiseSettledResult<Response>];
    try {
      results = await Promise.allSettled([
        checked.pipeTo(fixed.writable, { signal: wire.signal }),
        fetch(url, { method: "PUT", headers, body: fixed.readable, signal: wire.signal, redirect: "manual" }).then(async response => {
          await response.body?.cancel(); if (!response.ok) wire.abort(); return response;
        }).catch(error => { wire.abort(); throw error; }),
      ]);
    } finally { signal.removeEventListener("abort", abort); wire.abort(); }
    const request = results[1]!;
    if (request.status !== "fulfilled") throw new Error("Upload result unknown");
    const response = request.value; await response.body?.cancel();
    if (allowExisting && response.status === 409) return;
    if (!response.ok || results[0]!.status !== "fulfilled") throw new Error("File upload failed");
  }
  private async persist(s: Session, token: string, path: string, key: string, kind: "blend" | "glb"): Promise<FileDigest> {
    return cloudBudget(async signal => {
      const digest = await inspect(await this.source(s, token, path, signal), kind);
      const put = await immutableTosPut(this.tos, this.bucket, key, digest.bytes, digest.md5, kind === "glb" ? "model/gltf-binary" : "application/octet-stream");
      await this.relay(await this.source(s, token, path, signal), put.url, digest, put.headers, signal, true);
      const persisted = await inspect(await fetch(this.url(key, "GET"), { signal, redirect: "manual" }), kind);
      if (persisted.bytes !== digest.bytes || persisted.sha256 !== digest.sha256) throw new Error("Persisted file checksum mismatch");
      return digest;
    }, 300_000);
  }
  private async manifest(key: string, value: object): Promise<void> {
    const body = JSON.stringify(value), hash = createHash("sha256").update(body).digest("hex");
    await cloudBudget(async signal => {
      const signed = await immutableTosPut(this.tos, this.bucket, key, Buffer.byteLength(body), createHash("md5").update(body).digest("base64"), "application/json");
      const put = await fetch(signed.url, { method: "PUT", body, signal, redirect: "manual", headers: signed.headers });
      await put.body?.cancel(); if (!put.ok && put.status !== 409) throw new Error("Manifest write failed");
      const bytes = await boundedBody(await fetch(this.url(key, "GET"), { signal, redirect: "manual" }), 64 * 1024);
      if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Manifest checksum mismatch");
    }, 45_000);
  }
  async save(s: Session, token: string, id: string): Promise<void> {
    const prior = this.store.db.query<Checkpoint, [string]>("SELECT * FROM checkpoints WHERE id=?").get(id);
    if (prior) { if (prior.sessionId !== s.id || prior.epoch !== s.epoch || prior.build !== s.build) throw new Error("Checkpoint identity changed"); return; }
    const sceneKey = objectKey(s.owner, s.project, s.id, "checkpoints", id, "scene.blend"), digest = await this.persist(s, token, `/control/managed/files/${id}`, sceneKey, "blend");
    const checkpoint: Checkpoint = { id, sessionId: s.id, epoch: s.epoch, build: s.build, sceneKey, bytes: digest.bytes, sha256: digest.sha256, createdAt: s.updatedAt,
      manifestKey: objectKey(s.owner, s.project, s.id, "checkpoints", id, "manifest.json") };
    await this.manifest(checkpoint.manifestKey, { version: 1, ...checkpoint, owner: s.owner, project: s.project, dependencies: "packed", compression: "none" });
    this.store.commitCheckpoint(checkpoint);
  }
  async restore(s: Session, token: string, fileId: string): Promise<void> {
    const checkpoint = this.store.checkpoint(s.checkpoint!);
    if (checkpoint.sessionId !== s.id || checkpoint.build !== s.build) throw new Error("Checkpoint lease mismatch");
    await cloudBudget(async signal => {
      const manifest = JSON.parse(new TextDecoder().decode(await boundedBody(await fetch(this.url(checkpoint.manifestKey, "GET"), { signal, redirect: "manual" }), 64 * 1024)));
      for (const [key, value] of Object.entries({ version: 1, ...checkpoint, owner: s.owner, project: s.project, dependencies: "packed", compression: "none" })) if (manifest[key] !== value) throw new Error("Checkpoint manifest mismatch");
      const digest = await inspect(await fetch(this.url(checkpoint.sceneKey, "GET"), { signal, redirect: "manual" }), "blend");
      if (digest.bytes !== checkpoint.bytes || digest.sha256 !== checkpoint.sha256) throw new Error("Checkpoint checksum mismatch");
      try {
        await this.relay(await fetch(this.url(checkpoint.sceneKey, "GET"), { signal, redirect: "manual" }), new URL(`/control/managed/files/${fileId}`, this.target), digest,
          { ...this.headers(s, token), "Content-Type": "application/octet-stream" }, signal);
      } catch {
        const persisted = await inspect(await this.source(s, token, `/control/managed/files/${fileId}`, signal), "blend");
        if (persisted.bytes !== digest.bytes || persisted.sha256 !== digest.sha256) throw new Error("Restore result unknown");
      }
    }, 300_000);
  }
  list(owner: string, id: string): Artifact[] { this.store.session(id, owner); return this.store.db.query<Artifact, [string]>("SELECT * FROM blender_exports WHERE sessionId=? ORDER BY rowid").all(id); }
  ticket(owner: string, id: string) {
    const artifact = this.store.db.query<Artifact, [string]>("SELECT * FROM blender_exports WHERE id=?").get(id);
    if (!artifact) throw new Error("Export unavailable"); this.store.session(artifact.sessionId, owner);
    return { ...artifact, url: this.url(artifact.objectKey, "GET") };
  }
  async publish(s: Session, token: string, op: Operation): Promise<void> {
    const prior = this.store.db.query<Artifact, [string]>("SELECT * FROM blender_exports WHERE id=?").get(op.id);
    if (prior) { if (prior.sessionId !== s.id) throw new Error("Export identity changed"); return; }
    const key = objectKey(s.owner, s.project, s.id, "exports", op.id, "model.glb"), digest = await this.persist(s, token, `/control/exports/${op.id}`, key, "glb");
    const artifact: Artifact = { id: op.id, sessionId: s.id, objectKey: key, manifestKey: objectKey(s.owner, s.project, s.id, "exports", op.id, "manifest.json"),
      bytes: digest.bytes, sha256: digest.sha256, triangles: digest.triangles };
    await this.manifest(artifact.manifestKey, { ...artifact, build: s.build, epoch: s.epoch, owner: s.owner, createdAt: op.createdAt });
    this.store.db.transaction(() => {
      if (this.store.session(s.id).epoch !== s.epoch) throw new Error("Stale export lease");
      this.store.db.query("INSERT OR IGNORE INTO blender_exports VALUES (?,?,?,?,?,?,?)").run(artifact.id, s.id, key, artifact.manifestKey, artifact.bytes, artifact.sha256, artifact.triangles);
    }).immediate();
  }
}

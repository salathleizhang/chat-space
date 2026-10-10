import { NodeIO } from "@gltf-transform/core";
import { glbTriangleCount } from "../common/glb";
import { objectKey, sha256, type ObjectStore } from "./objects";
import { BlenderStore, type Operation, type Session } from "./store";
export interface Artifact { id: string; sessionId: string; objectKey: string; manifestKey: string; bytes: number; sha256: string; triangles: number }
export class BlenderArtifacts {
  constructor(private readonly store: BlenderStore, private readonly objects: ObjectStore) {
    store.db.exec("CREATE TABLE IF NOT EXISTS blender_exports (id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id),objectKey TEXT NOT NULL,manifestKey TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,triangles INTEGER NOT NULL)");
  }
  list(owner: string, sessionId: string): Artifact[] {
    this.store.session(sessionId, owner);
    return this.store.db.query<Artifact, [string]>("SELECT * FROM blender_exports WHERE sessionId=? ORDER BY rowid").all(sessionId);
  }
  async commit(session: Session, operation: Operation, bytes: Uint8Array): Promise<Artifact> {
    const hash = sha256(bytes), previous = this.store.db.query<Artifact, [string]>("SELECT * FROM blender_exports WHERE id=?").get(operation.id);
    if (previous) { if (previous.sessionId !== session.id || previous.sha256 !== hash) throw new Error("Export id reused"); return previous; }
    const triangles = glbTriangleCount(bytes), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length || triangles === null || triangles < 1) throw new Error("Export has no valid geometry");
    const document = await new NodeIO().readBinary(bytes);
    let vertices = 0;
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute("POSITION");
      if (!positions) throw new Error("Export has no positions");
      const array = positions.getArray();
      if (!array) throw new Error("Export contains invalid positions");
      for (const value of array) if (!Number.isFinite(value)) throw new Error("Export contains invalid positions");
      vertices += positions.getCount();
    }
    if (vertices < 3) throw new Error("Export is empty");
    const artifact: Artifact = { id: operation.id, sessionId: session.id, objectKey: objectKey(session.owner, session.project, session.id, "exports", operation.id, "model.glb"),
      manifestKey: objectKey(session.owner, session.project, session.id, "exports", operation.id, "manifest.json"), bytes: bytes.length, sha256: hash, triangles };
    await this.objects.put(artifact.objectKey, bytes, "model/gltf-binary");
    await this.objects.put(artifact.manifestKey, new TextEncoder().encode(JSON.stringify({ ...artifact, build: session.build, epoch: session.epoch, owner: session.owner, createdAt: operation.createdAt })), "application/json");
    this.store.db.transaction(() => {
      if (this.store.session(session.id).epoch !== session.epoch) throw new Error("Stale export lease");
      this.store.db.query("INSERT OR IGNORE INTO blender_exports VALUES (?,?,?,?,?,?,?)").run(artifact.id, session.id, artifact.objectKey, artifact.manifestKey, artifact.bytes, artifact.sha256, artifact.triangles);
    }).immediate();
    return artifact;
  }
  ticket(owner: string, id: string): Artifact & { url: string } {
    const artifact = this.store.db.query<Artifact, [string]>("SELECT * FROM blender_exports WHERE id=?").get(id);
    if (!artifact) throw new Error("Artifact unavailable");
    this.store.session(artifact.sessionId, owner);
    return { ...artifact, url: this.objects.downloadUrl(artifact.objectKey) };
  }
}

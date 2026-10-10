import { randomUUID } from "node:crypto";
import { objectKey, sha256, type ObjectStore } from "./objects";
import { BlenderStore, type Checkpoint, type Session } from "./store";

export class Checkpoints {
  constructor(private readonly store: BlenderStore, private readonly objects: ObjectStore) {}
  async commit(session: Session, scene: Uint8Array, checkpointId: string = randomUUID()): Promise<Checkpoint> {
    if (new TextDecoder().decode(scene.subarray(0, 7)) !== "BLENDER") throw new Error("Invalid blend checkpoint");
    const existing = this.store.db.query<Checkpoint, [string]>("SELECT * FROM checkpoints WHERE id=?").get(checkpointId);
    if (existing) {
      if (existing.sessionId !== session.id || existing.epoch !== session.epoch || existing.build !== session.build || existing.sha256 !== sha256(scene)) throw new Error("Checkpoint id reused");
      return existing;
    }
    const id = checkpointId, sceneKey = objectKey(session.owner, session.project, session.id, "checkpoints", id, "scene.blend");
    const checkpoint: Checkpoint = { id, sessionId: session.id, epoch: session.epoch, build: session.build,
      manifestKey: objectKey(session.owner, session.project, session.id, "checkpoints", id, "manifest.json"),
      sceneKey, bytes: scene.length, sha256: sha256(scene), createdAt: session.updatedAt };
    await this.objects.put(sceneKey, scene, "application/octet-stream");
    await this.objects.put(checkpoint.manifestKey, new TextEncoder().encode(JSON.stringify({ version: 1, ...checkpoint,
      owner: session.owner, project: session.project, dependencies: "packed", compression: "none" })), "application/json");
    // File/manifest failures and stale leases leave the previous committed pointer intact.
    this.store.commitCheckpoint(checkpoint);
    return checkpoint;
  }
  async read(session: Session): Promise<Uint8Array> {
    if (!session.checkpoint) throw new Error("No committed checkpoint");
    const checkpoint = this.store.checkpoint(session.checkpoint);
    if (checkpoint.sessionId !== session.id || checkpoint.build !== session.build) throw new Error("Checkpoint ownership/build mismatch");
    const manifest = JSON.parse(new TextDecoder().decode(await this.objects.get(checkpoint.manifestKey)));
    if (manifest.version !== 1 || manifest.id !== checkpoint.id || manifest.sessionId !== session.id || manifest.project !== session.project || manifest.dependencies !== "packed" || manifest.bytes !== checkpoint.bytes || manifest.sha256 !== checkpoint.sha256 || manifest.sceneKey !== checkpoint.sceneKey || manifest.build !== session.build || manifest.owner !== session.owner) throw new Error("Checkpoint manifest mismatch");
    const bytes = await this.objects.get(checkpoint.sceneKey);
    if (bytes.length !== checkpoint.bytes || sha256(bytes) !== checkpoint.sha256) throw new Error("Checkpoint checksum mismatch");
    return bytes;
  }
}

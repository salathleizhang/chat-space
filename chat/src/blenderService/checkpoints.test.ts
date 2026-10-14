import { expect, test } from "bun:test";
import { Checkpoints } from "./checkpoints";
import type { ObjectStore } from "./objects";
import { BlenderStore } from "./store";

class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Uint8Array>(); failManifest = false;
  async put(key: string, bytes: Uint8Array) {
    if (this.failManifest && key.endsWith("manifest.json")) throw new Error("Upload interrupted");
    const old = this.values.get(key);
    if (old && Buffer.compare(Buffer.from(old), Buffer.from(bytes))) throw new Error("Immutable object mismatch");
    this.values.set(key, bytes);
  }
  async get(key: string) { const bytes = this.values.get(key); if (!bytes) throw new Error("Missing object"); return bytes; }
  downloadUrl(key: string) { return key; }
}
test("interrupted manifest upload leaves last checkpoint intact; retry uploads without remodeling", async () => {
  const store = new BlenderStore(":memory:"), objects = new MemoryObjects(), checkpoints = new Checkpoints(store, objects);
  try {
    store.create("alice", "project", "custom-build", 3_600_000);
    const allocated = store.reserveNext()!, s = store.transition(allocated.id, 1, ["allocating"], "ready", "sandbox");
    const first = await checkpoints.commit(s, new TextEncoder().encode("BLENDER-first"));
    objects.failManifest = true;
    const secondBytes = new TextEncoder().encode("BLENDER-second"), id = "00000000-0000-4000-8000-000000000002";
    await expect(checkpoints.commit(store.session(s.id), secondBytes, id)).rejects.toThrow("interrupted");
    expect(store.session(s.id).checkpoint).toBe(first.id);
    objects.failManifest = false;
    const second = await checkpoints.commit(store.session(s.id), secondBytes, id);
    expect(store.session(s.id).checkpoint).toBe(second.id);
    expect(await checkpoints.read(store.session(s.id))).toEqual(secondBytes);
    objects.values.set(second.sceneKey, new TextEncoder().encode("BLENDER-damaged"));
    await expect(checkpoints.read(store.session(s.id))).rejects.toThrow("checksum");
  } finally { store.close(); }
});
test("checkpoint restore requires same customized build and session", async () => {
  const store = new BlenderStore(":memory:"), objects = new MemoryObjects(), checkpoints = new Checkpoints(store, objects);
  try {
    store.create("alice", "project", "custom-build", 3_600_000);
    const allocated = store.reserveNext()!, s = store.transition(allocated.id, 1, ["allocating"], "ready", "sandbox");
    const c = await checkpoints.commit(s, new TextEncoder().encode("BLENDER-first"));
    await expect(checkpoints.read({ ...s, checkpoint: c.id, build: "official-blender" })).rejects.toThrow("mismatch");
    await expect(checkpoints.read({ ...s, checkpoint: c.id, id: "other-session" })).rejects.toThrow("mismatch");
  } finally { store.close(); }
});

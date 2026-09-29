import { BufferGeometry, Material, Mesh, SkinnedMesh, Texture, type Object3D } from "three";

type Resource = BufferGeometry | Material | Texture;
interface Entry { refs: number; usedAt: number; resources: Set<Resource>; clear: () => void }

/** CPU/cache estimate, deliberately separate from renderer.info GPU accounting. */
export function resourceBytes(resource: Resource): number {
  if (resource instanceof BufferGeometry) {
    const arrays = new Set<ArrayBufferLike>();
    for (const attribute of [...Object.values(resource.attributes), ...(resource.index ? [resource.index] : [])]) {
      const array = "data" in attribute ? attribute.data.array : attribute.array;
      arrays.add(array.buffer);
    }
    for (const attributes of Object.values(resource.morphAttributes)) {
      for (const attribute of attributes ?? []) arrays.add(attribute.array.buffer);
    }
    return [...arrays].reduce((total, buffer) => total + buffer.byteLength, 0);
  }
  if (resource instanceof Texture) {
    const image = resource.image as { width?: number; height?: number; data?: ArrayBufferView } | undefined;
    return image?.data?.byteLength ?? (image?.width ?? 1) * (image?.height ?? 1) * 4 * (resource.generateMipmaps ? 4 / 3 : 1);
  }
  return 0;
}

function resourcesOf(object: Object3D) {
  const resources = new Set<Resource>();
  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    resources.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      resources.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) resources.add(value);
    }
  });
  return resources;
}

/** Model loader cache ownership shared by main views, thumbnails and inspectors.
 * Only idle entries are evicted. Active assets are never disposed to hit a budget.
 */
export class ModelResources {
  private entries = new Map<Object3D, Entry>();
  private owners = new Map<Resource, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private evicted = 0;
  constructor(readonly idleBudget = 128 * 1024 * 1024, readonly maxIdleEntries = 8,
    readonly idleLifetimeMs = 30000, private readonly now = () => performance.now()) {}

  acquire(object: Object3D, clear: () => void) {
    let entry = this.entries.get(object);
    if (!entry) {
      entry = { refs: 0, usedAt: this.now(), resources: resourcesOf(object), clear };
      this.entries.set(object, entry);
      for (const resource of entry.resources) this.owners.set(resource, (this.owners.get(resource) ?? 0) + 1);
    }
    entry.refs++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.refs--;
      entry.usedAt = this.now();
      // Allow StrictMode and same-turn view transitions to reclaim their lease.
      this.schedule(1000);
    };
  }

  private schedule(delay: number) {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.sweep(); }, delay);
  }

  sweep() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) => a[1].usedAt - b[1].usedAt);
    let idleBytes = idle.reduce((total, [, entry]) => total + [...entry.resources].reduce((sum, resource) => sum + resourceBytes(resource), 0), 0);
    let count = idle.length;
    for (const [object, entry] of idle) {
      if (count <= this.maxIdleEntries && idleBytes <= this.idleBudget && this.now() - entry.usedAt < this.idleLifetimeMs) continue;
      this.entries.delete(object);
      entry.clear();
      for (const resource of entry.resources) {
        idleBytes -= resourceBytes(resource);
        const refs = this.owners.get(resource)! - 1;
        if (refs === 0) { this.owners.delete(resource); resource.dispose(); }
        else this.owners.set(resource, refs);
      }
      disposeSkeletons(object);
      count--; this.evicted++;
    }
    const remaining = [...this.entries.values()].filter((entry) => entry.refs === 0);
    if (remaining.length) this.schedule(Math.max(1, Math.min(...remaining.map((entry) => this.idleLifetimeMs - (this.now() - entry.usedAt)))));
  }

  get stats() {
    return { entries: this.entries.size, active: [...this.entries.values()].filter((entry) => entry.refs > 0).length,
      estimatedBytes: [...this.owners.keys()].reduce((sum, resource) => sum + resourceBytes(resource), 0), evicted: this.evicted };
  }
}

/** SkeletonUtils clones own their bone textures, but not source geometry/textures. */
export function disposeSkeletons(object: Object3D) {
  const skeletons = new Set<SkinnedMesh["skeleton"]>();
  object.traverse((child) => { if (child instanceof SkinnedMesh) skeletons.add(child.skeleton); });
  for (const skeleton of skeletons) skeleton.dispose();
}

export const modelResources = new ModelResources();

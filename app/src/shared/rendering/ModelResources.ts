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

function entryBytes(entry: Entry) {
  return [...entry.resources].reduce((total, resource) => total + resourceBytes(resource), 0);
}

/**
 * 驻留上限的缺省值：模型缓存（活动 + 空闲）的估算总量。
 *
 * 与 `idleBudget` 是两件事——后者管"空闲缓存可以留多少"，这个管"整个应用驻留多少"。
 * 为什么需要它：截图的准入判断要问"模型侧还剩多少"（`MemoryPressure`），没有上限就永远
 * 回答"无限"，那两本账就还是不联动。所以它取一个**保守的安全上限**，而不是画质/性能档位
 * （不在 AGENTS.md §二.3 那张名单里）：超限时只回收**空闲**条目，活动资源一律不动。
 *
 * 注意这本账**不覆盖 splat**（`GaussianSplatRenderer` 不走这里），所以它不是项目显存上限，
 * 只是一个防止解码后的模型数据无限增长的兜底。
 */
export const DEFAULT_RESIDENT_BUDGET = 512 * 1024 * 1024;

/** Model loader cache ownership shared by main views, thumbnails and inspectors.
 * Only idle entries are evicted. Active assets are never disposed to hit a budget.
 */
export class ModelResources {
  private entries = new Map<Object3D, Entry>();
  private owners = new Map<Resource, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private evicted = 0;
  private trimmed = 0;
  constructor(readonly idleBudget = 128 * 1024 * 1024, readonly maxIdleEntries = 8,
    readonly idleLifetimeMs = 30000, private readonly now = () => performance.now(),
    /** 驻留上限（活动 + 空闲的估算总量）；超过就立刻回收空闲条目 */
    readonly residentBudget = DEFAULT_RESIDENT_BUDGET) {}

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

  /** 唯一的淘汰路径：只对 `refs === 0` 的条目调用（调用方负责这个前提） */
  private evict(object: Object3D, entry: Entry) {
    this.entries.delete(object);
    entry.clear();
    for (const resource of entry.resources) {
      const refs = this.owners.get(resource)! - 1;
      if (refs === 0) { this.owners.delete(resource); resource.dispose(); }
      else this.owners.set(resource, refs);
    }
    disposeSkeletons(object);
    this.evicted++;
  }

  /** 空闲条目，最旧的在前 */
  private idleOldestFirst(): [Object3D, Entry][] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
  }

  sweep() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    const idle = this.idleOldestFirst();
    let idleBytes = idle.reduce((total, [, entry]) => total + entryBytes(entry), 0);
    let count = idle.length;
    for (const [object, entry] of idle) {
      if (count <= this.maxIdleEntries && idleBytes <= this.idleBudget && this.now() - entry.usedAt < this.idleLifetimeMs) continue;
      idleBytes -= entryBytes(entry);
      count--;
      this.evict(object, entry);
    }
    /*
      驻留总量超预算时，空闲条目立刻回收，不再等 idleLifetimeMs——大场景下"空闲"
      往往是上一批模型刚被换出去，留着它们正好把下一批挤爆。
      活动条目一律不动：宁可变慢/请求方拿到降级结果，也不能释放正在渲染的资源。
    */
    this.trimToFit(0);
    const remaining = [...this.entries.values()].filter((entry) => entry.refs === 0);
    if (remaining.length) this.schedule(Math.max(1, Math.min(...remaining.map((entry) => this.idleLifetimeMs - (this.now() - entry.usedAt)))));
  }

  /**
   * 按需腾内存：回收空闲条目（最旧的先走），直到**释放量够 `needBytes`** 且驻留落回
   * `residentBudget` 之内，或者没有空闲条目可回收。
   *
   * 与 `sweep()` 的分工：sweep 按"空闲缓存自己的阈值/寿命"回收；这个是"别人等着用内存"
   * 的按需回收，不看阈值——只看差额。`needBytes = 0` 就退化成"把驻留压回预算内"，
   * 也就是 sweep 结尾那一步。
   *
   * **绝不释放活动条目**：宁可让调用方降级，也不能抽走正在渲染的资源。
   * 返回实际释放的估算字节。
   */
  trimToFit(needBytes = 0): number {
    const before = this.residentBytes();
    const satisfied = () => {
      const resident = this.residentBytes();
      return before - resident >= needBytes && resident <= this.residentBudget;
    };
    if (satisfied()) return 0;
    for (const [object, entry] of this.idleOldestFirst()) {
      if (satisfied()) break;
      this.evict(object, entry);
      this.trimmed++;
    }
    return before - this.residentBytes();
  }

  /** 当前驻留的估算字节：按**独占的资源**算，同一份几何被两个条目引用只记一次 */
  residentBytes(): number {
    return [...this.owners.keys()].reduce((total, resource) => total + resourceBytes(resource), 0);
  }

  /**
   * 内存压力读数。与 `stats` 分开：`stats` 的字段被既有断言逐字比对，
   * 这里放"要不要降级"需要看的那几个数。
   */
  get memory() {
    const residentBytes = this.residentBytes();
    return {
      residentBytes,
      residentLimit: this.residentBudget,
      overBudget: residentBytes > this.residentBudget,
      /** 因超出驻留预算（而非空闲阈值）被回收的条目数 */
      trimmed: this.trimmed,
    };
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

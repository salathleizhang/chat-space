/** Smallest capture edge the budget degrades to before giving up. */
export const MIN_CAPTURE_SIZE = 256;

/**
 * 全应用内存压力的探针。
 *
 * 截图目标（这本账）与模型缓存（`ModelResources`）是**两本独立的账**，但抢的是同一块显存。
 * 只看自己那本会出现"截图账还有额度，而模型早就把内存占满"——分配 render target 时直接
 * 设备丢失。所以准入要同时看两边，缺额度时先请调用方腾内存再重试。
 */
export interface MemoryPressure {
  /** 当前驻留估算字节（模型缓存的活动 + 空闲） */
  residentBytes(): number;
  /** 驻留上限 */
  residentLimit(): number;
}

/** Estimated owned bytes, not a claim about free physical GPU memory. */
export class ResourceBudget {
  private used = 0;
  private peak = 0;
  private rejected = 0;
  private degraded = 0;
  private lastDegraded: { requested: number; actual: number } | null = null;
  constructor(readonly limit: number) {}
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.used) {
      this.rejected++;
      throw new Error("WebGPU resource budget exceeded.");
    }
    return this.commit(bytes);
  }

  /**
   * 本账本当前能给出的额度。带 `pressure` 时取两侧的较小值：**谁能给的少就按谁算**，
   * 这样"截图账有额度但模型已经占满"不会再被放行。缺省（不传探针）行为不变。
   */
  private availableBytes(pressure?: MemoryPressure): number {
    const own = this.limit - this.used;
    if (!pressure) return own;
    return Math.min(own, Math.max(0, pressure.residentLimit() - pressure.residentBytes()));
  }

  /**
   * Reserve a capture, degrading resolution instead of failing outright.
   *
   * Order: try the requested size, then `reclaim` (told the exact shortfall) once and
   * retry, then halve the edge down to `floor` (bytes fall quadratically per halving,
   * so usually one step is enough). Only a capture that cannot fit even at the floor
   * is rejected, and that error names the limit, the shortfall, the size it was
   * reduced to, and which of the two ledgers was binding. `reclaim` must never
   * dispose resources in use.
   *
   * `reclaim` 腾的是**全应用**的内存（模型缓存），腾不出本账本自己的额度——这里的占用者
   * 只有在途截图。重试同一尺寸之所以有意义，是因为准入看的是两本账里更紧的那一侧：
   * 模型侧让出空间后，这一侧就不再是瓶颈。
   */
  reserveCapture(
    size: number,
    samples: number,
    /** 腾内存：参数是还差多少字节。可能来自模型缓存，但不保证能腾够 */
    reclaim: (needBytes: number) => void,
    floor = MIN_CAPTURE_SIZE,
    pressure?: MemoryPressure,
  ): CaptureReservation {
    const ladder = captureSizeLadder(size, floor);
    const requested = ladder[0]!;
    let needed = captureBytes(requested, samples);
    let release = this.tryReserve(needed, pressure);
    if (!release) {
      reclaim(Math.max(0, needed - this.availableBytes(pressure)));
      release = this.tryReserve(needed, pressure);
    }
    if (release) return { size: requested, release, degraded: false };
    for (const candidate of ladder.slice(1)) {
      needed = captureBytes(candidate, samples);
      const attempt = this.tryReserve(needed, pressure);
      if (attempt) {
        this.degraded++;
        this.lastDegraded = { requested, actual: candidate };
        return { size: candidate, release: attempt, degraded: true };
      }
    }
    this.rejected++;
    const smallest = ladder[ladder.length - 1]!;
    throw new Error("WebGPU capture budget exceeded: "
      + `limit ${formatBytes(this.limit)}, in use ${formatBytes(this.used)}, need ${formatBytes(needed)} `
      + `at ${smallest}px (requested ${requested}px, floor ${floor}px). `
      + (pressure ? `${describeBinding(this, pressure)} ` : "")
      + "Reclaiming idle models was not enough; free memory or capture at a smaller size.");
  }

  private tryReserve(bytes: number, pressure?: MemoryPressure): (() => void) | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.availableBytes(pressure)) return undefined;
    return this.commit(bytes);
  }

  private commit(bytes: number) {
    this.used += bytes;
    this.peak = Math.max(this.peak, this.used);
    let active = true;
    return () => { if (active) { active = false; this.used -= bytes; } };
  }

  get stats() { return { used: this.used, peak: this.peak, rejected: this.rejected, limit: this.limit }; }

  /** Captures served below their requested resolution; `last` is the newest one. */
  get downgrades() { return { count: this.degraded, last: this.lastDegraded }; }
}

export interface CaptureReservation {
  /** Edge actually reserved; smaller than the requested size when degraded. */
  size: number;
  release: () => void;
  degraded: boolean;
}

export const captureBudget = new ResourceBudget(128 * 1024 * 1024);

/** Requested edge first, then halved down to `floor`. Never upscales. */
export function captureSizeLadder(size: number, floor = MIN_CAPTURE_SIZE): number[] {
  assertCaptureSize(size);
  assertCaptureSize(floor);
  const sizes = [size];
  while (sizes[sizes.length - 1]! > floor) {
    const next = Math.max(floor, Math.floor(sizes[sizes.length - 1]! / 2));
    if (next >= sizes[sizes.length - 1]!) break;
    sizes.push(next);
  }
  return sizes;
}

export function captureBytes(size: number, samples: number) {
  assertCaptureSize(size);
  // RGBA8 resolve + depth, multisample color/depth, padded readback and CPU RGBA.
  return size * size * (12 + 8 * Math.max(1, samples)) + Math.ceil(size * 4 / 256) * 256 * size;
}

function assertCaptureSize(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 4096) throw new Error("Unsupported capture dimensions.");
}

function formatBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

/** 卡住的是哪一侧：写清楚才知道该腾模型还是该等截图收工 */
function describeBinding(budget: ResourceBudget, pressure: MemoryPressure): string {
  const own = budget.limit - budget.stats.used;
  const models = Math.max(0, pressure.residentLimit() - pressure.residentBytes());
  return models < own
    ? `models hold ${formatBytes(pressure.residentBytes())} of ${formatBytes(pressure.residentLimit())};`
    : `captures hold ${formatBytes(budget.stats.used)} of ${formatBytes(budget.limit)};`;
}

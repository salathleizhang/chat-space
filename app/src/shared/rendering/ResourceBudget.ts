/** Estimated owned bytes, not a claim about free physical GPU memory. */
export class ResourceBudget {
  private used = 0;
  private peak = 0;
  private rejected = 0;
  constructor(readonly limit: number) {}
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit - this.used) {
      this.rejected++;
      throw new Error("WebGPU resource budget exceeded.");
    }
    this.used += bytes;
    this.peak = Math.max(this.peak, this.used);
    let active = true;
    return () => { if (active) { active = false; this.used -= bytes; } };
  }
  get stats() { return { used: this.used, peak: this.peak, rejected: this.rejected, limit: this.limit }; }
}

export const captureBudget = new ResourceBudget(128 * 1024 * 1024);

export function captureBytes(size: number, samples: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 4096) throw new Error("Unsupported capture dimensions.");
  // RGBA8 resolve + depth, multisample color/depth, padded readback and CPU RGBA.
  return size * size * (12 + 8 * Math.max(1, samples)) + Math.ceil(size * 4 / 256) * 256 * size;
}

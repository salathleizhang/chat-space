export type CapturePriority = "inspection" | "thumbnail";
interface Job {
  priority: CapturePriority;
  queuedAt: number;
  signal: AbortSignal;
  start: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  abort: () => void;
  settled: boolean;
}

const aborted = () => new DOMException("Capture cancelled", "AbortError");

/** Across all WebGPU surfaces: one readback batch, bounded backlog, aging. */
export class CaptureQueue {
  private pending: Job[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interactiveUntil = 0;
  constructor(private readonly capacity = 16, private readonly now = () => performance.now()) {}

  interaction() { this.interactiveUntil = this.now() + 120; }

  enqueue<T>(priority: CapturePriority, signal: AbortSignal, start: () => Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(aborted());
    if (this.pending.length >= this.capacity) return Promise.reject(new Error("Capture queue is full."));
    return new Promise<T>((resolve, reject) => {
      const job: Job = { priority, queuedAt: this.now(), signal, start,
        resolve: (value) => resolve(value as T), reject, settled: false, abort: () => {} };
      job.abort = () => {
        if (job.settled) return;
        job.settled = true;
        this.pending = this.pending.filter((entry) => entry !== job);
        signal.removeEventListener("abort", job.abort);
        reject(aborted());
      };
      signal.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.schedule();
    });
  }

  private schedule(delay = 0) {
    if (this.running || this.timer !== undefined || !this.pending.length) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delay);
  }

  private pump() {
    if (this.running || !this.pending.length) return;
    const now = this.now();
    // After 1.5s even an interacting user cannot starve a background request.
    const aged = this.pending.findIndex((job) => now - job.queuedAt >= 1500);
    if (aged < 0 && now < this.interactiveUntil) { this.schedule(this.interactiveUntil - now); return; }
    const inspection = this.pending.findIndex((job) => job.priority === "inspection");
    const index = aged >= 0 ? aged : Math.max(0, inspection);
    const job = this.pending.splice(index, 1)[0]!;
    this.running = true;
    // A running cancellation settles the consumer now, but retains the slot
    // until its GPU readbacks finish and dispose their targets.
    void Promise.resolve().then(() => {
      if (job.signal.aborted) throw aborted();
      return job.start();
    }).then((value) => {
      if (!job.settled) { job.settled = true; job.resolve(value); }
    }, (error: unknown) => {
      if (!job.settled) { job.settled = true; job.reject(error); }
    }).finally(() => {
      job.signal.removeEventListener("abort", job.abort);
      this.running = false;
      this.schedule();
    });
  }

  get stats() { return { pending: this.pending.length, running: this.running ? 1 : 0 }; }
}

export const captureQueue = new CaptureQueue();

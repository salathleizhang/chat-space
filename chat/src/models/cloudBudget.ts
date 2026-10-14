import { ChatServiceError } from "../common/errors";
import { withHardTimeout } from "../common/http";
import { onTaskPumpTick } from "../common/taskPump";

/** A budget covers headers AND body; an external task tick still cancels it when timers stop. */
export async function cloudBudget<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const error = () => new ChatServiceError("The cloud Blender request timed out and the outcome is unknown; check the scene before deciding whether to retry", 504, "blender_cloud_timeout");
  let rejectTick!: (error: Error) => void;
  const expired = new Promise<never>((_, reject) => { rejectTick = reject; });
  const expire = () => { controller.abort(); const e = error(); rejectTick(e); return e; };
  const unsubscribe = onTaskPumpTick(() => { if (Date.now() >= deadline) expire(); });
  try {
    return await withHardTimeout(Promise.race([work(controller.signal), expired]), timeoutMs, expire);
  } finally {
    unsubscribe();
    controller.abort();
  }
}

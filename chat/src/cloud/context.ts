import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerationTask } from "../dto/tasks";
import type { TaskExecutionContext } from "../services/tasks";

export type CloudOperation = { operation: string; input: Record<string, unknown> };
export type TaskExecutor = (context: TaskExecutionContext) => Promise<unknown>;
export interface CloudContext {
  workspace: string;
  pending: Promise<unknown>[];
  enqueue: (task: GenerationTask, operation: CloudOperation) => Promise<void>;
  /** 重新构建已有任务的执行函数；不用重新注册/提交任务。 */
  capture?: { task: GenerationTask; executor?: TaskExecutor };
  polling?: boolean;
  activeTaskIds?: () => Promise<Set<string>>;
  onSidecar?: (path: string) => Promise<void>;
}
const context = new AsyncLocalStorage<CloudContext>();
export const currentCloudContext = () => context.getStore();
export function withCloudContext<T>(value: CloudContext, operation: () => T): T {
  return context.run(value, operation);
}
export class CloudTaskPending extends Error {
  constructor(readonly delaySeconds: number) { super("等待浏览器下一次任务心跳"); }
}

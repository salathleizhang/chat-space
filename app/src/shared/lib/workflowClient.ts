import { fileToBase64 } from "./fileEncoding";
import { chatFetch, chatResponseError } from "./sse";

async function postJson(path: string, body: unknown): Promise<Response> {
  return chatFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function uploadSource(
  projectSlug: string,
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  const dataBase64 = await fileToBase64(file);
  if (signal?.aborted) throw signal.reason;
  const response = await chatFetch(`/api/projects/${projectSlug}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      fileName: file.name,
      dataBase64,
    }),
  });
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to upload source image (${response.status})`);
  }
  return ((await response.json()) as { path: string }).path;
}

/** 与 chat/src/dto/tasks.ts 对齐 */
export interface GenerationTask {
  id: string;
  workflowId: string;
  projectSlug: string;
  subject: string;
  status: "running" | "succeeded" | "failed";
  phase?:
    | "queued"
    | "generating"
    | "downloading"
    | "validating"
    | "publishing"
    | "completed"
    | "failed";
  assetSlug?: string;
  batchId?: string;
  retry?: { kind: "3d" };
  result?: unknown;
  error?: string;
  /**
   * 只读诊断，服务端在 `running` 且长时间没有进展时代入（见 chat 侧 `services/tasks.ts`
   * 的 `STALLED_TASK_WARN_MS`）：`pumpActive=false` 说明本机已经没有推进闸门照看它。
   */
  stall?: {
    silentForMs: number;
    pumpActive: boolean;
  };
}

async function postJsonOrThrow<T>(path: string, body: unknown): Promise<T> {
  const response = await postJson(path, body);
  if (!response.ok) {
    throw await chatResponseError(response, `Chat service returned ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function listTasks(projectSlug?: string): Promise<GenerationTask[]> {
  const query = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : "";
  const response = await chatFetch(`/api/tasks${query}`);
  if (!response.ok) {
    throw await chatResponseError(response, `Failed to load generation tasks (${response.status})`);
  }
  return ((await response.json()) as { tasks: GenerationTask[] }).tasks;
}

export async function retryGenerationTask(
  projectSlug: string,
  taskId: string,
): Promise<GenerationTask> {
  const body = await postJsonOrThrow<{ task: GenerationTask }>(
    `/api/tasks/${encodeURIComponent(taskId)}/retry`,
    { projectSlug },
  );
  return body.task;
}

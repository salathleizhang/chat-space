import { fileToBase64 } from "./fileEncoding";
import { chatFetch, chatResponseError } from "./sse";

async function postJson(path: string, body: unknown): Promise<Response> {
  return chatFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function uploadSource(projectSlug: string, file: File): Promise<string> {
  const response = await postJson(`/api/projects/${projectSlug}/sources`, {
    fileName: file.name,
    dataBase64: await fileToBase64(file),
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

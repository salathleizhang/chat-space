import { ChatServiceError } from "../common/errors";

/**
 * Meshy 直连客户端（api.meshy.ai，Bearer；端点路径经官方文档核实 2026-07）。
 * 统一任务协议：POST 建任务（响应 { result: taskId }）→ GET /:id 轮询
 * （PENDING / IN_PROGRESS / SUCCEEDED / FAILED / CANCELED）。
 * 模型输入支持公网 URL 或 data URI（本地优先的关键：无需上传基础设施）。
 * BYOK：key 是调用参数；fetch 可注入以便测试。
 */

const MESHY_BASE = "https://api.meshy.ai";

export const MESHY_PATHS = {
  retexture: "/openapi/v1/retexture",
  rigging: "/openapi/v1/rigging",
  animations: "/openapi/v1/animations",
  remesh: "/openapi/v1/remesh",
} as const;
export type MeshyCapabilityPath = (typeof MESHY_PATHS)[keyof typeof MESHY_PATHS];

export interface MeshyCallOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: string) => void | Promise<void>;
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function jsonOrEmpty(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function createMeshyTask(
  path: MeshyCapabilityPath,
  body: Record<string, unknown>,
  options: MeshyCallOptions,
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`${MESHY_BASE}${path}`, {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify(body),
  });
  const payload = await jsonOrEmpty(response);
  if (!response.ok) {
    throw new ChatServiceError(
      `Meshy 提交失败（${response.status}）：${JSON.stringify(payload).slice(0, 300)}`,
      502,
      "meshy_submit_failed",
    );
  }
  const taskId = payload.result;
  if (typeof taskId !== "string" || !taskId) {
    throw new ChatServiceError("Meshy 提交响应缺少任务 id", 502, "meshy_submit_failed");
  }
  return taskId;
}

/** 轮询直至 SUCCEEDED，返回完整任务对象；FAILED/CANCELED/超时抛错 */
export async function waitForMeshyTask(
  path: MeshyCapabilityPath,
  taskId: string,
  options: MeshyCallOptions,
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 10_000;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);

  for (;;) {
    const response = await fetchFn(`${MESHY_BASE}${path}/${taskId}`, {
      headers: headers(options.apiKey),
    });
    const task = await jsonOrEmpty(response);
    if (!response.ok) {
      throw new ChatServiceError(
        `Meshy 任务查询失败（${response.status}）`,
        502,
        "meshy_status_failed",
      );
    }
    const status = typeof task.status === "string" ? task.status : "UNKNOWN";
    await options.onStatus?.(status);

    if (status === "SUCCEEDED") return task;
    if (status === "FAILED" || status === "CANCELED") {
      const message =
        (task.task_error as { message?: string } | undefined)?.message ?? status;
      throw new ChatServiceError(`Meshy 任务失败：${message}`, 502, "meshy_task_failed");
    }
    if (Date.now() > deadline) {
      throw new ChatServiceError(
        `Meshy 任务超时（task_id=${taskId}，可凭侧写续查）`,
        504,
        "meshy_timeout",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

const FILE_URL_RE = /\.(glb|gltf|fbx|obj|usdz|blend|stl|3mf|png|jpe?g|webp)(\?|$)/i;

export interface MeshyFileRef {
  url: string;
  /** 来源键路径（如 model_urls.fbx / result.animation_glb_url），用于产物命名 */
  key: string;
}

/** 递归扫出任务对象里的产物 URL（Meshy 的 URL 是纯字符串值，按扩展名识别） */
export function extractMeshyFileUrls(
  value: unknown,
  prefix = "",
  found: MeshyFileRef[] = [],
): MeshyFileRef[] {
  if (Array.isArray(value)) {
    value.forEach((item, i) => extractMeshyFileUrls(item, `${prefix}${i}.`, found));
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      extractMeshyFileUrls(nested, `${prefix}${key}.`, found);
    }
  } else if (
    typeof value === "string" &&
    /^https?:\/\//.test(value) &&
    FILE_URL_RE.test(value)
  ) {
    found.push({ url: value, key: prefix.replace(/\.$/, "") });
  }
  return found;
}

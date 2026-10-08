import { chatFetch } from "./sse";
import {
  LLM_PROVIDER_IDS,
  type LlmProviderId,
} from "../storage/apiKeys";

/**
 * env Key 不会暴露给浏览器；chat 只返回已配置的厂商 id。
 * null 表示能力接口不可达或未返回厂商，此时 UI 不做破坏性的筛选；
 * 但服务故障（5xx/网络错误）会 console.warn 留痕，避免把故障伪装成「无 env 厂商」。
 */
export async function fetchEnvLlmProviders(): Promise<LlmProviderId[] | null> {
  try {
    const response = await chatFetch("/api/capabilities");
    if (!response.ok) {
      if (response.status >= 500) {
        console.warn(`Chat capabilities endpoint returned ${response.status}; no environment providers available`);
      }
      return null;
    }
    const payload = (await response.json()) as { llmProviders?: unknown };
    if (!Array.isArray(payload.llmProviders)) return null;
    return payload.llmProviders.filter(
      (value): value is LlmProviderId =>
        typeof value === "string" &&
        (LLM_PROVIDER_IDS as readonly string[]).includes(value),
    );
  } catch (err) {
    console.warn("Chat capabilities endpoint is unreachable; no environment providers available", err);
    return null;
  }
}

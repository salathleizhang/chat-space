/**
 * 「Vercel 出口 → 火山」这条腿的定时巡检（2026-10-17）。
 *
 * 为什么放在这里：全仓唯一**常驻**的定时器就是这个 Worker 的 Cron。坏掉的那一跳在
 * Vercel 函数里，所以巡检必须打网站自己的自检端点 `/api/health/llm`
 * （`chat/src/cloud/providerHealth.ts` 在那里做零成本的火山请求）——从别处测不作数，
 * 那几条路一直是通的。
 *
 * 判据是**端点自己的状态码**：200 = 可用，503 = 不通或不可用。5 分钟一次；
 * 故障期间每 30 分钟最多推一条，恢复时补一条"已恢复"（靠 Cache API 记住上一次判定，
 * 不在 Durable Object 里加状态——那会动到正在跑的池子）。
 *
 * ⚠️ **本模块不许 import `chat/` 下的任何东西，type-only 也不行。** worker 的 tsconfig
 * 会把 import 到的文件整条依赖图拉进自己的程序：2026-10-17 试过 `import type` 引
 * `chat/src/cloud/providerHealth.ts`，程序从 29 个文件涨到 68 个（一路带到
 * `config → models/tripo → … → mastra/tools/skyboxGen`），把 chat 侧几条既有类型错误
 * 带进 CI，**Vercel 构建当场失败**。这里只认"端点返回的那份 JSON"这个契约，接口自己声明。
 */

export const LLM_PROBE_CRON = "*/5 * * * *";
export const DEFAULT_LLM_HEALTH_URL = "https://www.junwei.cool/api/health/llm";
/** 同一次故障期间两条告警之间的最短间隔。 */
export const ALERT_REPEAT_MS = 30 * 60 * 1000;

declare global {
  interface Env {
    /** 自检端点；默认打正式站。 */
    LLM_HEALTH_URL?: string;
    /** 告警 webhook（Telegram / Slack 等，POST `{ "text": … }`）。留空则只写日志。 */
    LLM_ALERT_WEBHOOK?: string;
    /** 可选：`text` / `dingtalk` / `feishu`，不设则按 webhook 域名自动选。 */
    LLM_ALERT_FORMAT?: string;
  }
}

export interface ProbeState { ok: boolean; at: number }
/** `/api/health/llm` 返回体的形状（只声明这里真正读的字段）。 */
export interface LlmHealth {
  ok?: boolean;
  reachable?: boolean;
  verdict?: string;
  provider?: string;
  status?: number;
  code?: string;
  latencyMs?: number;
  detail?: string;
  checkedAt?: number;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  health?: LlmHealth;
  error?: string;
}

/** Cron 分派：分钟级那条继续唤醒资源池，五分钟那条才做链路巡检。 */
export function scheduledKind(cron: string): "llm-probe" | "pool" {
  return cron === LLM_PROBE_CRON ? "llm-probe" : "pool";
}

/** 读自检端点。**永不抛错**：连不上端点也是一种结论（网站本身挂了）。 */
export async function readLlmHealth(env: Env, fetchFn: typeof fetch = fetch): Promise<ProbeResult> {
  const url = env.LLM_HEALTH_URL ?? DEFAULT_LLM_HEALTH_URL;
  try {
    const response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const health = await response.json().catch(() => undefined) as LlmHealth | undefined;
    return { ok: response.ok && health?.ok === true, status: response.status, health };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

const STATE_URL = "https://chatspace-internal.invalid/llm-route-state";
let memoryState: ProbeState | undefined;

async function readState(): Promise<ProbeState | undefined> {
  try {
    const hit = await caches.default.match(STATE_URL);
    if (hit) return await hit.json() as ProbeState;
  } catch { /* 缓存不可用（如测试环境）时退回进程内状态 */ }
  return memoryState;
}

async function writeState(state: ProbeState): Promise<void> {
  memoryState = state;
  try { await caches.default.put(STATE_URL, Response.json(state, { headers: { "Cache-Control": "max-age=86400" } })); } catch { /* 同上 */ }
}

function describe(result: ProbeResult): string {
  if (result.error) return `自检端点不可达：${result.error}`;
  const health = result.health;
  const parts = [
    `判定 ${health?.verdict ?? "unknown"}`,
    `出口 ${health?.provider ?? "unknown"}`,
    `耗时 ${health?.latencyMs ?? "?"}ms`,
  ];
  if (health?.status) parts.push(`HTTP ${health.status}`);
  if (health?.code) parts.push(`code ${health.code}`);
  return `${parts.join(" · ")}${health?.detail ? `\n详情：${health.detail}` : ""}`;
}

function downMessage(result: ProbeResult, at: number): string {
  return [
    `⚠️ ChatSpace AI 链路不可用（${new Date(at).toISOString()}）`,
    describe(result),
    `这一跳断了，整站 AI 都会落到兜底 502（补全、图片生成都走它）；客户端重试无效。`,
    `自检：${DEFAULT_LLM_HEALTH_URL}`,
  ].join("\n");
}

function recoveredMessage(result: ProbeResult, at: number): string {
  return [`✅ ChatSpace AI 链路已恢复（${new Date(at).toISOString()}）`, describe(result)].join("\n");
}

/**
 * 告警 body 的形状：钉钉与飞书的群机器人 webhook **不认** 通用的 `{"text": …}`
 * （2026-10-17 用户机器上装的是钉钉/飞书，不是 Telegram/Slack）。默认按 webhook 域名
 * 选形状，`LLM_ALERT_FORMAT` 可以显式压过（转发/自建中转时用得上）。
 *
 * 钉钉自定义机器人的安全设置有三种（关键词 / 加签 / IP 白名单）：**关键词那一种要求
 * 消息里含设定的词**，所以文案里始终带 "ChatSpace"。加签模式需要在 URL 上再算
 * `timestamp&sign`，本模块不支持——那种配置请改用不签名的机器人或中转。
 */
export type AlertFormat = "text" | "dingtalk" | "feishu";

export function alertFormatFor(webhook: string, override?: string): AlertFormat {
  if (override === "text" || override === "dingtalk" || override === "feishu") return override;
  try {
    const host = new URL(webhook).hostname;
    if (host === "oapi.dingtalk.com") return "dingtalk";
    if (host === "open.feishu.cn" || host === "open.larksuite.com" || host === "open.larkoffice.com") return "feishu";
  } catch { /* URL 不合法时按通用形状发，交给 fetch 去报错 */ }
  return "text";
}

export function alertPayload(format: AlertFormat, text: string): string {
  if (format === "dingtalk") return JSON.stringify({ msgtype: "text", text: { content: text } });
  if (format === "feishu") return JSON.stringify({ msg_type: "text", content: { text } });
  return JSON.stringify({ text });
}

/**
 * 钉钉/飞书**拒收时也回 HTTP 200**，只在 body 里给 errcode/code —— 不看这个字段的话
 * 告警会静默消失。返回"是否被受理"。
 */
function webhookRejected(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return;
  const payload = body as { errcode?: unknown; errmsg?: unknown; code?: unknown; msg?: unknown };
  const code = payload.errcode ?? payload.code;
  if (code === undefined || code === 0) return;
  return `${String(code)} ${String(payload.errmsg ?? payload.msg ?? "")}`.trim();
}

async function sendAlert(env: Env, text: string, fetchFn: typeof fetch): Promise<boolean> {
  const webhook = env.LLM_ALERT_WEBHOOK;
  if (!webhook) { console.error("LLM route alert (no LLM_ALERT_WEBHOOK configured)", text.replace(/\n/g, " | ")); return false; }
  const format = alertFormatFor(webhook, env.LLM_ALERT_FORMAT);
  try {
    const response = await fetchFn(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: alertPayload(format, text) });
    const body = await response.clone().json().catch(() => undefined);
    const rejected = webhookRejected(body);
    if (rejected) { console.error("LLM route alert rejected by webhook", rejected); return false; }
    if (!response.ok) { console.error("LLM route alert delivery failed", `HTTP ${response.status}`); return false; }
    return true;
  } catch (error) {
    console.error("LLM route alert delivery failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}

export interface ProbeRun { alerted: "down" | "recovered" | "suppressed" | "none"; result: ProbeResult }

/**
 * 跑一次巡检并决定要不要告警。**永不抛错**（Cron 处理器抛错只会变成平台错误，
 * 而那正是我们想避免的"静默失败"）。
 */
export async function runLlmProbe(env: Env, options: { fetchFn?: typeof fetch; now?: number } = {}): Promise<ProbeRun> {
  const fetchFn = options.fetchFn ?? fetch;
  const at = options.now ?? Date.now();
  const result = await readLlmHealth(env, fetchFn);
  const previous = await readState();
  if (result.ok) {
    await writeState({ ok: true, at });
    if (previous && !previous.ok) { await sendAlert(env, recoveredMessage(result, at), fetchFn); return { alerted: "recovered", result }; }
    return { alerted: "none", result };
  }
  console.error("LLM route probe failed", JSON.stringify({ status: result.status, error: result.error, health: result.health }));
  if (previous && !previous.ok && at - previous.at < ALERT_REPEAT_MS) return { alerted: "suppressed", result };
  await writeState({ ok: false, at });
  await sendAlert(env, downMessage(result, at), fetchFn);
  return { alerted: "down", result };
}

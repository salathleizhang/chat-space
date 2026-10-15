import { z } from "zod";
import { browserErrorMessage } from "./errors";

interface Tool { description?: string; inputSchema: z.ZodType; execute: (input: any, context: any) => Promise<unknown> }
type Message = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string };

/**
 * 单次 LLM 尝试的墙钟预算。
 *
 * **必须低于 Vercel 函数的 300 秒上限**：以前这里既没有超时也没有重试，上游一旦卡住
 * （跨境链路抖动、供应商预处理很慢），唯一的结局就是等平台把函数砍掉，用户拿到一个
 * 平台生成的 504 页面（`FUNCTION_INVOCATION_TIMEOUT`），既看不懂也无法恢复。现在由
 * 应用自己先超时，再重试——失败时给出的是能读懂的、可重试的错误。
 */
export const LLM_ATTEMPT_TIMEOUT_MS = 240_000;
/** 读流期间多久没收到任何字节算卡死。推理模型的思考期是静默的，所以给得宽一些。 */
export const LLM_STALL_TIMEOUT_MS = 90_000;
/** 单步骤最多尝试次数。**只在还没吐出任何内容时重试**，否则会把同一段回复发两遍。 */
export const LLM_MAX_ATTEMPTS = 2;
const LLM_RETRY_BACKOFF_MS = 1_500;

class LlmTimeoutError extends Error {
  constructor(readonly kind: "budget" | "stalled") {
    super(kind === "stalled"
      ? "The AI provider stopped sending data and the request was cancelled"
      : "The AI request exceeded its time budget");
    this.name = "LlmTimeoutError";
  }
}

/**
 * 值不值得重试。
 *
 * **判据要窄**：这里每一次重试都是一次真实的付费调用。超时、限流、5xx 与网络层抖动
 * 值得重试；而"响应回来了但内容不合 schema / JSON 解不开"是**确定性失败**，重试只会
 * 再花一次钱拿到同样的坏结果（早期版本把这类也算了进去，回归测试钉住了这一点）。
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof LlmTimeoutError) return true;
  if (error instanceof DOMException) return false;
  const message = error instanceof Error ? error.message : String(error);
  const status = /^AI request failed \((\d{3})\)/.exec(message);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 429 || code >= 500;
  }
  if (error instanceof TypeError) return true;
  return /failed to fetch|network error|socket|connection (closed|reset)|premature/i.test(message);
}

/** 把调用方的中止信号与"单次尝试预算"合成一个信号；`dispose` 必须成对调用。 */
function attemptSignal(external: AbortSignal | undefined, budgetMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new LlmTimeoutError("budget")), budgetMs);
  const forward = () => controller.abort(external?.reason);
  external?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    /** 预算到点时浏览器把它当 abort 原因抛出来，这里还原成可判定的错误。 */
    failure(error: unknown): unknown {
      return controller.signal.aborted && controller.signal.reason instanceof LlmTimeoutError
        ? controller.signal.reason
        : error;
    },
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", forward);
    },
  };
}

/** 给"等下一个流分片"加卡死上限：连接还活着但没有数据，正是 504 之前的真实形态。 */
async function readWithStall<T>(read: () => Promise<T>, stallMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LlmTimeoutError("stalled")), stallMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function messagesForApi(messages: Message[]): Message[] {
  return messages.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map((part: any) => part.type === "image" ? { type: "image_url", image_url: { url: part.image } } : part) : message.content }));
}

export class Agent {
  constructor(private readonly options: {
    instructions: string;
    model: { modelId: string; url: string; apiKey: string };
    tools?: Record<string, Tool>;
    /** 下面三个是**测试覆盖点**，生产一律走模块上那组常量。 */
    attemptTimeoutMs?: number;
    stallTimeoutMs?: number;
    maxAttempts?: number;
    [key: string]: unknown;
  }) {}

  private get attemptTimeoutMs(): number { return this.options.attemptTimeoutMs ?? LLM_ATTEMPT_TIMEOUT_MS; }
  private get stallTimeoutMs(): number { return this.options.stallTimeoutMs ?? LLM_STALL_TIMEOUT_MS; }
  private get maxAttempts(): number { return Math.max(1, this.options.maxAttempts ?? LLM_MAX_ATTEMPTS); }

  async generate(messages: Message[], options: { structuredOutput: { schema: z.ZodType } }) {
    const schema = z.toJSONSchema(options.structuredOutput.schema, { unrepresentable: "any" });
    const body = [{ role: "system", content: this.options.instructions + "\nReturn JSON conforming to: " + JSON.stringify(schema) }, ...messages];
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const budget = attemptSignal(undefined, this.attemptTimeoutMs);
      try {
        const response = await this.call(body, false, budget.signal, { response_format: { type: "json_object" } });
        const value = await response.json() as { choices?: { message?: { content?: string } }[] };
        return { object: options.structuredOutput.schema.parse(JSON.parse(value.choices?.[0]?.message?.content ?? "")) };
      } catch (error) {
        lastError = budget.failure(error);
        // 结构化输出是"全有或全无"的：失败时没有半截结果可留下，所以这里总能安全重试。
        if (attempt >= this.maxAttempts || !isRetryable(lastError)) throw lastError;
        await sleep(LLM_RETRY_BACKOFF_MS * attempt);
      } finally {
        budget.dispose();
      }
    }
    throw lastError;
  }

  async stream(messages: Message[], options: { abortSignal?: AbortSignal; requestContext: unknown }) {
    return { fullStream: this.run(messages, options) };
  }

  private async call(messages: Message[], stream: boolean, signal?: AbortSignal, extra: Record<string, unknown> = {}) {
    const tools = Object.entries(this.options.tools ?? {}).map(([name, tool]) => ({ type: "function", function: { name,
      description: tool.description, parameters: z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any", target: "draft-7" }) } }));
    const response = await fetch(this.options.model.url.replace(/\/$/, "") + "/chat/completions", { method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.model.apiKey}` },
      body: JSON.stringify({ model: this.options.model.modelId, messages: messagesForApi(messages), stream, ...(tools.length ? { tools } : {}), ...extra }) });
    if (!response.ok) throw new Error(`AI request failed (${response.status}): ${(await response.text()).slice(0, 350)}`);
    return response;
  }

  private async *run(input: Message[], options: { abortSignal?: AbortSignal; requestContext: unknown }): AsyncGenerator<any> {
    const messages: Message[] = [{ role: "system", content: this.options.instructions +
      "\n当前运行环境是公开网站的浏览器本地版。供应商凭据由网站服务端提供；缺少服务配置时需网站管理员处理，不能让访问者在自己电脑上配置 chat/.env。" }, ...input];
    for (let step = 0; step < 12; step++) {
      if (options.abortSignal?.aborted) return;
      let text = "";
      let calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
      /*
        每一步自带"超时 + 未产出前重试"。
        重试的前提是这一步**还没有往界面上吐过任何内容**：吐过之后再重来会把同一段
        回复发两遍（正文是逐字累积到同一个气泡里的，无法去重）。
      */
      for (let attempt = 1;; attempt += 1) {
        let emitted = false;
        const budget = attemptSignal(options.abortSignal, this.attemptTimeoutMs);
        try {
          const response = await this.call(messages, true, budget.signal);
          if (!response.body) throw new Error("AI returned an empty response");
          text = "";
          calls = new Map();
          let buffer = "";
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let completed = false;
          try {
            for (;;) {
              const chunk = await readWithStall(() => reader.read(), this.stallTimeoutMs);
              if (chunk.done) { completed = true; break; }
              buffer += chunk.value;
              let end: number;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
                if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
                const data = JSON.parse(line.slice(5)) as any;
                if (data.error) throw new Error(data.error.message ?? "AI provider error");
                const delta = data.choices?.[0]?.delta;
                if (delta?.content) { emitted = true; text += delta.content; yield { type: "text-delta", payload: { text: delta.content } }; }
                /*
                  推理模型的思维链：形状对齐 Mastra 的 `reasoning-delta`，好让 chat 侧的
                  fullStream 分支一视同仁地处理两条路径。以前这里只认 `content`，思维链
                  被整段丢弃，界面上就是长时间空白——实测一个稍难的提示要 85 秒才出第一个
                  可见字符，DeepSeek Flash 甚至在 600 token 预算内一个正文字都没有。
                  `reasoning` 是部分供应商（如 DeepSeek 直连）用的字段名，一并接住。
                */
                const thinking = delta?.reasoning_content ?? delta?.reasoning;
                if (typeof thinking === "string" && thinking) { emitted = true; yield { type: "reasoning-delta", payload: { text: thinking } }; }
                for (const part of delta?.tool_calls ?? []) {
                  const call = calls.get(part.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
                  if (part.id) call.id = part.id;
                  if (part.function?.name) call.function.name += part.function.name;
                  if (part.function?.arguments) call.function.arguments += part.function.arguments;
                  calls.set(part.index, call);
                }
              }
            }
          } finally {
            // 没读到自然结束就一定要把连接拆掉，否则卡死的上游会一直挂着这条流。
            if (completed) reader.releaseLock();
            else await reader.cancel().catch(() => {});
          }
          break;
        } catch (error) {
          const failure = budget.failure(error);
          if (emitted || options.abortSignal?.aborted || attempt >= this.maxAttempts || !isRetryable(failure)) throw failure;
          await sleep(LLM_RETRY_BACKOFF_MS * attempt);
        } finally {
          budget.dispose();
        }
      }
      if (!calls.size) return;
      messages.push({ role: "assistant", content: text || null, tool_calls: [...calls.values()] });
      for (const call of calls.values()) {
        if (options.abortSignal?.aborted) return;
        const name = call.function.name, id = call.id || crypto.randomUUID();
        let result: unknown;
        try {
          const tool = this.options.tools?.[name]; if (!tool) throw new Error(`Unknown tool: ${name}`);
          const args = tool.inputSchema.parse(JSON.parse(call.function.arguments || "{}"));
          yield { type: "tool-call", payload: { toolName: name, toolCallId: id, args } };
          result = await tool.execute(args, { requestContext: options.requestContext, abortSignal: options.abortSignal, toolCallId: id });
          yield { type: "tool-result", payload: { toolName: name, toolCallId: id, result } };
          // Ask-user is a hard stop before any remaining paid tool in the same response.
          if (name === "ask-user") return;
        } catch (error) {
          result = { error: browserErrorMessage(error) };
          yield { type: "tool-error", payload: { toolName: name, toolCallId: id, error: result } };
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    throw new Error("Tool-call limit reached for this turn; continue the conversation");
  }
}

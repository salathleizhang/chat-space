import { z } from "zod";
import { browserErrorMessage } from "./errors";
interface Tool { description?: string; inputSchema: z.ZodType; execute: (input: any, context: any) => Promise<unknown> }
type Message = { role: string; content: any; tool_calls?: any[]; tool_call_id?: string };
function messagesForApi(messages: Message[]): Message[] {
  return messages.map(message => ({ ...message, content: Array.isArray(message.content)
    ? message.content.map((part: any) => part.type === "image" ? { type: "image_url", image_url: { url: part.image } } : part) : message.content }));
}
export class Agent {
  constructor(private readonly options: { instructions: string; model: { modelId: string; url: string; apiKey: string }; tools?: Record<string, Tool>; [key: string]: unknown }) {}
  async generate(messages: Message[], options: { structuredOutput: { schema: z.ZodType } }) {
    const schema = z.toJSONSchema(options.structuredOutput.schema, { unrepresentable: "any" });
    const response = await this.call([{ role: "system", content: this.options.instructions + "\nReturn JSON conforming to: " + JSON.stringify(schema) }, ...messages], false, undefined, { response_format: { type: "json_object" } });
    const value = await response.json() as { choices?: { message?: { content?: string } }[] };
    return { object: options.structuredOutput.schema.parse(JSON.parse(value.choices?.[0]?.message?.content ?? "")) };
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
      const response = await this.call(messages, true, options.abortSignal);
      if (!response.body) throw new Error("AI returned an empty response");
      let text = "", buffer = "";
      const calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += chunk.value;
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
            if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
            const data = JSON.parse(line.slice(5)) as any;
            if (data.error) throw new Error(data.error.message ?? "AI provider error");
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) { text += delta.content; yield { type: "text-delta", payload: { text: delta.content } }; }
            for (const part of delta?.tool_calls ?? []) {
              const call = calls.get(part.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
              if (part.id) call.id = part.id;
              if (part.function?.name) call.function.name += part.function.name;
              if (part.function?.arguments) call.function.arguments += part.function.arguments;
              calls.set(part.index, call);
            }
          }
        }
      } finally { reader.releaseLock(); }
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

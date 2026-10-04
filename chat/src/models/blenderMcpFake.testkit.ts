/**
 * 假 MCP server：端到端验证 `blenderMcp.ts` 的 stdio 路径，**不需要 Blender**。
 *
 * 为什么要有它：桥接层最容易出错的地方不是协议解析，而是生命周期——进程起不来、
 * 握手不完成、调用超时后连接是否还能用、进程在调用中途退出时在飞的调用有没有被拒。
 * 这些只有真的 spawn 一个进程才测得到。
 *
 * 行为由 `execute_blender_code` 的 `code` 参数驱动，保持无状态：
 *   - `hang`        → 永不回复（测超时）
 *   - `sleep:<ms>`  → 等 ms 毫秒后回复（测串行化与超时边界）
 *   - `exit`        → 立刻退出进程（测中途死亡）
 *   - 其他          → 回显收到的 arguments（测 user_prompt 注入与结果解析）
 */

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function error(id: unknown, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
  );
}

function handle(line: string): void {
  let message: {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  /*
    复刻 `uvx mcp-for-blender` 的真实形状：启动器会 fork 出真正干活的服务。
    用来验证 stop() 杀的是整棵树、而不是只杀启动器——只杀启动器会留下孤儿占着管道。
    `code === "spawn-child"` 时起一个长命孙进程，并把它的 pid 报回去。
  */
  if (
    message.method === "tools/call" &&
    typeof message.params?.arguments?.code === "string" &&
    message.params.arguments.code === "spawn-child"
  ) {
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    reply(message.id, {
      content: [{ type: "text", text: JSON.stringify({ childPid: child.pid }) }],
      isError: false,
    });
    return;
  }

  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "blenderMcpFake", version: "0.0.0" },
    });
    return;
  }

  // 通知没有 id，不需要回复
  if (message.id === undefined) return;

  if (message.method === "tools/list") {
    reply(message.id, { tools: [] });
    return;
  }

  if (message.method !== "tools/call") {
    error(message.id, `unknown method ${message.method}`);
    return;
  }

  const args = message.params?.arguments ?? {};
  const tool = message.params?.name ?? "";
  const code = typeof args.code === "string" ? args.code : "";

  /*
    复刻真机行为：Blender 没连上时，社区版**不报错**，而是返回一个成功结果、
    把"连不上"写在文本里（isError 仍是 false）。这是被测代码必须识别的形态，
    假 server 如果在这里"友好地"返回错误，就永远测不出那个假阳性。
    `FAKE_BLENDER_CONNECTED=1` 时才算连上。
  */
  if (tool === "get_addon_status" && process.env.FAKE_BLENDER_CONNECTED !== "1") {
    reply(message.id, {
      content: [
        {
          type: "text",
          text:
            "Error checking addon status: Could not connect to Blender. " +
            "Make sure the Blender addon is running.",
        },
      ],
      isError: false,
    });
    return;
  }

  void (async () => {
    if (code === "hang") return;
    if (code === "exit") {
      process.exit(1);
    }
    if (code.startsWith("sleep:")) {
      const ms = Number(code.slice("sleep:".length)) || 0;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    reply(message.id, {
      content: [{ type: "text", text: JSON.stringify({ received: args }) }],
      isError: false,
    });
  })();
}

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(line);
    index = buffer.indexOf("\n");
  }
}

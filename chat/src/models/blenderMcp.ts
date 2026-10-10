import type { FileSink } from "bun";
import { ChatServiceError, toErrorMessage } from "../common/errors";
import { withHardTimeout } from "../common/http";
import { config } from "../config";
import { BlenderCloudClient, readBlenderCloudSettings } from "./blenderCloud";

/**
 * Blender MCP 传输层：一个**最小的 MCP stdio 客户端**，只做传输与白名单，不做工具定义。
 *
 * ## 为什么自己写而不是加 `@mastra/mcp`
 *
 * 1. **我们把 MCP 当传输适配器，不当工具来源。** agent 看到的 8 个工具在
 *    `mastra/tools/blenderOps.ts` 里手写，描述是我们的路由纪律。如果直接用
 *    Mastra 的 MCP 集成把社区版的工具挂上去，agent 会看到 36 个英文工具——实测其中
 *    **30 个带一个 `user_prompt` 参数**（`get_scene_info` 还是必填），而那个参数是
 *    喂给社区版 `trajectory.py` 遥测的。模型每次调用都要编一段"用户意图"，纯噪声，
 *    并且直接损害工具选择质量（而工具选择正是本产品最在意的事）。
 * 2. **生命周期要我们控。** 这个进程是所有 Blender 操作的唯一入口，"服务重启后自愈"
 *    （见 `services/tasks.ts` 的纪律）要求桥接能被重建，而不是外部框架持有它。
 * 3. **少一个依赖。** 本仓库的 provider 都是直连 + `createTool`，没有 MCP SDK。
 *
 * ## 两件必须记住的事
 *
 * **① `user_prompt` 由本层统一注入。** 上层工具不写它、模型看不见它。传空串即可满足
 * 社区版的"必填"约束，同时不产生任何意图数据。
 *
 * **② 白名单是硬闸门，不是约定。** `call()` 对名单外的工具直接抛错——包括 Tripo /
 * Hyper3D / Hunyuan 三个生成器和 PolyHaven / Sketchfab / PolyPizza 三个资产市场。
 * 前者的理由是**重复付费**（本仓库已有那三家的完整付费管线、并发池与看门狗，从 Blender
 * 再开一个入口等于绕过全部配额）；后者的理由是**提示注入 + 绕过资产库**
 * （社区版自己的 `safe_mode.py` 文档里点名 Poly Haven / Sketchfab 的资产名与描述是
 * 注入向量，而落点正是我们敞开着的 `execute_blender_code`；且经 Blender 下载的资产
 * 落在 Blender 自己的缓存里、拿不到稳定 asset id，`scene.json` 的 transforms 按稳定 id
 * 索引，于是它根本摆不了）。
 *
 * 名单变的唯一方式是改下面这个常量——`blenderMcp.test.ts` 会钉住它排除掉哪些名字。
 */

/** 允许 agent 触及的工具。改动这个常量前先读模块文档。 */
export const BLENDER_ALLOWED_TOOLS = [
  "get_addon_status",
  "get_scene_info",
  "get_object_info",
  "get_viewport_screenshot",
  "execute_blender_code",
  "bpy_api_lookup",
  "describe_node_type",
  "export_scene",
] as const;

export type BlenderToolName = (typeof BLENDER_ALLOWED_TOOLS)[number];

const ALLOWED = new Set<string>(BLENDER_ALLOWED_TOOLS);

/**
 * 明确禁止的工具（白名单已经拦住了，这里单独列出来是为了让"我们刻意排除了什么"
 * 有唯一的出处，并让测试能钉住它）。改白名单时如果动了这里的某个名字，测试会红。
 */
export const BLENDER_BLOCKED_TOOLS = [
  // 生成器：与本仓库既有的 Tripo / Hyper3D / Hunyuan 付费管线冲突 → 重复付费
  "generate_tripo_model",
  "poll_tripo_job_status",
  "import_generated_asset_tripo",
  "generate_hyper3d_model_via_text",
  "generate_hyper3d_model_via_images",
  "poll_rodin_job_status",
  "import_generated_asset",
  "generate_hunyuan3d_model",
  "poll_hunyuan_job_status",
  "import_generated_asset_hunyuan",
  // 资产市场：提示注入面 + 绕过 `AssetStorage`（拿不到稳定 asset id ⇒ 摆不了）
  "search_polyhaven_assets",
  "download_polyhaven_asset",
  "get_polyhaven_asset_preview",
  "get_polyhaven_categories",
  "set_texture",
  "search_sketchfab_models",
  "download_sketchfab_model",
  "get_sketchfab_model_preview",
  "search_polypizza_models",
  "download_polypizza_model",
  // 遥测开关不该由模型来拧（真正的关闭在三处环境变量 + 网络策略）
  "disable_telemetry",
  "record_trajectory_feedback",
] as const;

/** 社区版把 `user_prompt` 标成必填（`get_scene_info` 就是），本层统一填这个值。 */
const USER_PROMPT_SENTINEL = "";

/** 关掉社区版遥测：三个别名全设，谁都拦得住。真正的兜底是容器不出网。 */
const TELEMETRY_OFF_ENV = {
  DISABLE_TELEMETRY: "1",
  BLENDER_MCP_DISABLE_TELEMETRY: "1",
  MCP_DISABLE_TELEMETRY: "1",
} as const;

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** 建模类调用的上限：布尔/细分级别的重活可能跑十几秒，给足但必须有顶。 */
export const BLENDER_CALL_TIMEOUT_MS = 300_000;
const STARTUP_TIMEOUT_MS = 60_000;

/**
 * 存活探测的预算与缓存时长。
 *
 * **为什么必须有这一对数字**（真机验证抓到的）：Blender 不在时，社区版 server 不会
 * 快速报错，而是**把请求挂着**——实测 `execute_blender_code` 会一直不返回，于是默认
 * 300 秒的调用预算被拖满，agent 的一轮对话在"Blender 根本没开"这种情况下冻五分钟，
 * 而错误信息还指向"某一步跑太久"，完全误导。
 *
 * 所以口径是：**「Blender 不在」要快速失败，「Blender 在思考」才慢慢等。** 前者用这里
 * 的短探测（并缓存，避免每次调用都白等一轮）；后者交给调用自己的预算。
 */
const LIVENESS_TIMEOUT_MS = 6_000;
const LIVENESS_TTL_MS = 10_000;

export interface BlenderMcpOptions {
  /** MCP server 可执行文件；默认 `mcp-for-blender`（`BLENDER_MCP_BIN` 可覆盖）。 */
  bin?: string;
  /**
   * 传给可执行文件的额外参数。
   *
   * 生产上常常需要它：用 `uvx` 拉起时是
   * `["--from", "mcp-for-blender", "blender-mcp"]`，这样连 Python 环境都不用手动准备
   * （本机系统 Python 是 3.9，而这个包要 ≥3.10——`uvx` 会自己拉一个）。
   */
  args?: string[];
  /** Blender 的 socket 地址。本地是 127.0.0.1；云端是容器暴露出来的主机。 */
  host?: string;
  port?: number;
  /** 额外的环境变量（调试用）。 */
  env?: Record<string, string>;
  /** 单次调用预算；默认 `BLENDER_CALL_TIMEOUT_MS`。 */
  callTimeoutMs?: number;
  /** 进程句柄注入点，便于测试替换成假 server。 */
  spawnFn?: typeof Bun.spawn;
}

/**
 * 社区版把「连不上 Blender」当成**成功结果**返回，失败信号只在文本里。
 *
 * 这是真机验证抓到的：`get_addon_status` 的 JSON-RPC 响应 `isError` 是 false，
 * 而 `content[0].text` 是
 * `Error checking addon status: Could not connect to Blender. Make sure the Blender addon is running.`
 *
 * 不识别这一条会有两个后果，都是静默的：
 *  1. 会话检查报告 `connected: true`（假阳性——正好是 agnet 最需要准确的那个信号）；
 *  2. 存活闸门放行 → 后续 `execute_blender_code` 挂到超时为止（实测 300 秒），
 *     而报错还说"这一步跑太久"，完全指错方向。
 *
 * 所以这里显式识别这句话。措辞将来若变，`addonStatusFromText` 的单测会红——
 * 那正是我们要的：宁可测试失败，也不要静默地报告"已连接"。
 */
export const NOT_CONNECTED_MARKER = "Could not connect to Blender";

/** 解析 `get_addon_status` 的返回：**失败看文本，不看 isError**。 */
export function addonStatusFromText(text: string): {
  connected: boolean;
  raw: string;
} {
  return { connected: !text.includes(NOT_CONNECTED_MARKER), raw: text };
}

/** 一次 `tools/call` 的结果。`text` 是社区版返回的原文，`json` 是尽力解析的结果。 */
export interface BlenderCallResult {
  tool: string;
  /** 社区版把结果放在 content[].text 里，多数是 JSON 字符串。 */
  text: string;
  /** 解析成功则是对象，否则是 null（**不要**拿 null 当"空结果"——见 wrapResult）。 */
  json: unknown;
  /**
   * MCP 协议层的 `isError`。
   *
   * ⚠️ **它不足以判断业务失败**：`get_addon_status` 在 Blender 没跑时也是 `false`。
   * 业务失败要么看文本（`addonStatusFromText`），要么看 `json` 里的引擎事实。
   */
  isError: boolean;
  ms: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  tool: string;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * 最小 MCP stdio 客户端。
 *
 * 并发：**串行化**。Blender 的 addon socket 只有一个命令队列（`_drain_command_queue`
 * 跑在主线程上），并发发出去只会互相排队，还会让超时归因变难。这里用一条 promise 链
 * 保证同一时刻只有一个在飞的调用。
 */
export class BlenderMcpClient {
  private readonly bin: string;
  private readonly args: string[];
  private readonly host: string;
  private readonly port: number;
  private readonly extraEnv: Record<string, string>;
  private readonly callTimeoutMs: number;
  private readonly spawnFn: typeof Bun.spawn;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  /** `stdin: "pipe"` 时它一定是 FileSink；Bun 的类型把它和裸 fd（number）放在一个联合里。 */
  private stdin: FileSink | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private stderrTail: string[] = [];
  /** 存活探测结果的短缓存；`null` 表示还没探过。 */
  private liveness: { ok: boolean; at: number } | null = null;

  constructor(options: BlenderMcpOptions = {}) {
    this.bin = options.bin ?? process.env.BLENDER_MCP_BIN ?? "mcp-for-blender";
    this.args = options.args ?? [];
    this.host = options.host ?? process.env.BLENDER_HOST ?? "127.0.0.1";
    this.port = options.port ?? Number(process.env.BLENDER_PORT ?? 9876);
    this.extraEnv = options.env ?? {};
    this.callTimeoutMs = options.callTimeoutMs ?? BLENDER_CALL_TIMEOUT_MS;
    this.spawnFn = options.spawnFn ?? Bun.spawn;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  /** 最近一次进程输出，用来在失败时给出可诊断的信息（而不是一句"连接失败"）。 */
  get diagnostics(): { host: string; port: number; bin: string; stderr: string[] } {
    return {
      host: this.host,
      port: this.port,
      bin: this.bin,
      stderr: this.stderrTail.slice(-20),
    };
  }

  /**
   * 启动 server 并握手。**幂等**：已经在跑就直接返回。
   *
   * 为什么握手要显式做：MCP 的 `initialize` 是协议要求的第一步，跳过它后续
   * `tools/call` 会被拒。而社区版的 server **在没有 Blender 的情况下也能启动并握手**
   * （实测：它只会往 stderr 打 "Failed to connect to Blender"，tools/list 照常可用），
   * 所以"server 起来了"和"Blender 连上了"是两件事，不要混为一谈——健康检查走
   * `get_addon_status`。
   */
  async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = this.spawnFn([this.bin, ...this.args], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ...TELEMETRY_OFF_ENV,
            BLENDER_HOST: this.host,
            BLENDER_PORT: String(this.port),
            ...this.extraEnv,
          },
        });
      } catch (error) {
        throw new ChatServiceError(
          `无法启动 Blender MCP server（${this.bin}）：${toErrorMessage(error)}`,
          503,
          "blender_mcp_spawn_failed",
        );
      }

      this.proc = proc;
      this.stdin = proc.stdin as unknown as FileSink;
      this.stderrTail = [];
      void this.pumpStdout(proc.stdout as ReadableStream<Uint8Array>);
      void this.pumpStderr(proc.stderr as ReadableStream<Uint8Array>);
      void proc.exited.then(() => this.onExit(proc));

      await withHardTimeout(
        this.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "chatspace", version: "0.1.0" },
        }),
        STARTUP_TIMEOUT_MS,
        () =>
          new ChatServiceError(
            `Blender MCP server 启动握手超时（${STARTUP_TIMEOUT_MS / 1000} 秒）`,
            504,
            "blender_mcp_handshake_timeout",
          ),
      );

      this.notify("notifications/initialized", {});
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  /**
   * 调一个白名单内的工具。
   *
   * 名单外的名字**在发出去之前**就被拒——这是硬闸门，不是提示词纪律。
   */
  async call(
    tool: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<BlenderCallResult> {
    if (!ALLOWED.has(tool)) {
      throw new ChatServiceError(
        `Blender 工具 \`${tool}\` 不在白名单内（刻意排除：生成器会与本仓库既有的付费管线` +
          `重复计费；资产市场是提示注入面且绕过资产库）。允许的是：` +
          `${BLENDER_ALLOWED_TOOLS.join(", ")}`,
        403,
        "blender_tool_not_allowed",
      );
    }

    await this.start();

    // 快速失败闸门：除健康检查本身外，任何调用之前先确认 Blender 真的在。
    // 不加这一道的后果见 LIVENESS_TIMEOUT_MS 的注释——那是一个实测出来的五分钟卡死。
    if (tool !== "get_addon_status") await this.assertAlive();

    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    const result = await withHardTimeout(
      this.enqueue(() =>
        this.request("tools/call", {
          name: tool,
          // user_prompt 只在**这一行**出现：上层工具不写、模型看不见。
          arguments: { ...args, user_prompt: USER_PROMPT_SENTINEL },
        }),
      ),
      timeoutMs,
      () =>
        new ChatServiceError(
          `Blender 工具 \`${tool}\` 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已中止等待。` +
            `Blender 可能仍在执行（视口会保持冻结直到它跑完）——请把工作拆成更小的步。`,
          504,
          "blender_call_timeout",
        ),
    );

    return { tool, ...wrapResult(tool, result), ms: Date.now() - started };
  }

  /** 健康检查：真正去问 Blender（而不是只看进程活着）。 */
  async health(): Promise<BlenderCallResult> {
    return this.call("get_addon_status", {}, { timeoutMs: 30_000 });
  }

  /**
   * 快速失败闸门。**这是"Blender 没开"和"Blender 在思考"的分界线。**
   *
   * 探测走 `get_addon_status`，短预算；结果缓存 `LIVENESS_TTL_MS`，所以连续多步调用
   * 只会多付一次探测的成本。探到的失败**不缓存太久**——用户可能刚刚把 Blender 打开。
   */
  private async assertAlive(): Promise<void> {
    const now = Date.now();
    if (this.liveness && now - this.liveness.at < LIVENESS_TTL_MS) {
      if (this.liveness.ok) return;
      throw this.notConnectedError();
    }
    try {
      const raw = await withHardTimeout(
        this.enqueue(() =>
          this.request("tools/call", {
            name: "get_addon_status",
            arguments: { user_prompt: USER_PROMPT_SENTINEL },
          }),
        ),
        LIVENESS_TIMEOUT_MS,
        () => new ChatServiceError("liveness probe timed out", 504, "blender_probe_timeout"),
      );
      // ⚠️ 关键：**不能只看"有没有抛错"**。Blender 没跑时这次调用是"成功"的，
      // 失败写在文本里（见 NOT_CONNECTED_MARKER）。只看异常会让闸门形同虚设。
      if (!addonStatusFromText(wrapResult("get_addon_status", raw).text).connected) {
        this.liveness = { ok: false, at: now };
        throw this.notConnectedError();
      }
      this.liveness = { ok: true, at: now };
    } catch (error) {
      if (error instanceof ChatServiceError && error.code === "blender_not_connected") {
        throw error;
      }
      this.liveness = { ok: false, at: now };
      throw this.notConnectedError();
    }
  }

  private notConnectedError(): ChatServiceError {
    const stderr = this.stderrTail.slice(-3).join(" | ");
    return new ChatServiceError(
      `Blender 没有响应（${this.host}:${this.port}）。Blender 多半没在跑，或者插件没启动。\n` +
        `请打开 Blender，在 3D 视口侧栏（N 键）里启动 ChatSpace Bridge 对应的插件；` +
        `容器里则确认 Blender 进程与端口暴露都就绪。\n` +
        `最近日志：${stderr || "（无）"}`,
      503,
      "blender_not_connected",
    );
  }

  /** 停掉 server。所有在飞的调用会被拒。 */
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.stdin = null;
    this.liveness = null;
    for (const [id, entry] of this.pending) {
      entry.reject(
        new ChatServiceError("Blender MCP server 已停止", 503, "blender_mcp_stopped"),
      );
      this.pending.delete(id);
    }
    if (proc) {
      // 必须先杀掉**整棵进程树**再谈别的：`uvx` 会 fork 出真正的 python 服务，
      // 只 kill uvx 会留下一个孤儿占着管道——实测后果是停掉之后进程不退出，
      // 而在长跑服务里就是"每停一次泄漏一个 Blender MCP server"。
      killProcessTree(proc.pid);
      // 管道不死，pumpStdout/pumpStderr 的 for-await 就不会结束，进程会被它们挂住。
      // 取消读端给这两条循环一个确定的结束点。
      cancelQuietly(proc.stdout);
      cancelQuietly(proc.stderr);
      // 等等它真的走；但**不无限等**——kill 已经发过了，等不到也不该把调用方挂死。
      await withHardTimeout(
        proc.exited,
        3_000,
        () => new ChatServiceError("stop timeout", 504, "blender_stop_timeout"),
      ).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  /** 串行链：保证同一时刻只有一个在飞的调用。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    // 链本身不能因为某一次失败而断掉，所以吞掉拒绝、只把结果交回调用方。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const tool = (params as { name?: string } | undefined)?.name ?? method;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, tool });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(
          new ChatServiceError(
            `向 Blender MCP server 写请求失败：${toErrorMessage(error)}`,
            503,
            "blender_mcp_write_failed",
          ),
        );
      }
    });
  }

  private notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // 通知失败不致命：握手已经完成，下一次调用会暴露真正的连接问题。
    }
  }

  private write(message: JsonRpcMessage): void {
    const stdin = this.stdin;
    if (!stdin || !this.proc) {
      throw new ChatServiceError(
        "Blender MCP server 没有在运行",
        503,
        "blender_mcp_not_running",
      );
    }
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  private async pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.handleLine(line);
          index = buffer.indexOf("\n");
        }
      }
    } catch {
      // 流断了由 onExit 统一处理
    }
  }

  private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) this.stderrTail.push(line);
          index = buffer.indexOf("\n");
        }
      }
    } catch {
      // 同上
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // 社区版把日志写到 stderr，stdout 只应有 JSON-RPC；出现别的就忽略，
      // 不要因为一行杂音把整个连接判死。
      return;
    }
    const id = typeof message.id === "number" ? message.id : null;
    if (id === null) return; // 通知/请求（server → client），当前不需要处理
    const entry = this.pending.get(id);
    if (!entry) return; // 已超时或已取消的调用，迟到的响应直接丢
    this.pending.delete(id);
    if (message.error) {
      entry.reject(
        new ChatServiceError(
          `Blender 工具 \`${entry.tool}\` 返回错误：${message.error.message ?? "未知错误"}`,
          502,
          "blender_tool_error",
        ),
      );
      return;
    }
    entry.resolve(message.result);
  }

  private onExit(proc: ReturnType<typeof Bun.spawn>): void {
    if (this.proc !== proc) return; // 已经被 stop() 换掉了
    this.proc = null;
    this.stdin = null;
    this.liveness = null;
    for (const [id, entry] of this.pending) {
      entry.reject(
        new ChatServiceError(
          `Blender MCP server 在 \`${entry.tool}\` 执行期间退出。` +
            `最近输出：${this.stderrTail.slice(-3).join(" | ") || "（无）"}`,
          503,
          "blender_mcp_exited",
        ),
      );
      this.pending.delete(id);
    }
  }
}

/**
 * 把 MCP 的 `content[]` 摊平成文本 + 尽力解析的 JSON。
 *
 * **`json === null` 的含义是"没解析出来"，不是"结果是空的"。** 调用方必须把两者分开——
 * 本仓库在别处踩过同一个坑（`common/glb.ts` 的面数 `null` 表示"不知道"，不是 0）。
 * 判"模型建出来了没有"要看 `json` 里的引擎事实，解析失败时要如实报错而不是当成成功。
 */
export function wrapResult(
  tool: string,
  result: unknown,
): { text: string; json: unknown; isError: boolean } {
  const container = result as { content?: unknown; isError?: unknown } | null;
  const isError = container?.isError === true;
  const content = container?.content;
  if (!Array.isArray(content)) {
    return { text: "", json: null, isError };
  }
  const text = content
    .map((part) => {
      const entry = part as { type?: string; text?: string };
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n");

  if (!text) return { text: "", json: null, isError };
  try {
    return { text, json: JSON.parse(text), isError };
  } catch {
    // 社区版少数工具直接回人类可读文本，解析不了是正常的——原样交回。
    void tool;
    return { text, json: null, isError };
  }
}

/**
 * 杀掉 pid 及其所有后代。
 *
 * **为什么不能只 `proc.kill()`**（真机验证抓到）：`uvx` 只是一个启动器，它会 fork 出真正
 * 的 python 服务。只杀 uvx 会留下一个**孤儿服务进程**继续占着 stdout/stderr 管道，于是：
 * 读循环永不结束 → Node/Bun 进程不退出；而在长跑服务里更糟——**每停一次泄漏一个
 * Blender MCP server**，它们还会继续尝试连同一个 addon socket。
 *
 * `pgrep -P` 在 macOS 与 Linux 上都有；容器里就是 Linux。杀不到不算错（进程可能已经走了）。
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    const probe = Bun.spawnSync(["pgrep", "-P", String(pid)]);
    if (probe.exitCode === 0) {
      for (const line of probe.stdout.toString().split("\n")) {
        const child = Number(line.trim());
        if (Number.isFinite(child) && child > 0) killProcessTree(child, signal);
      }
    }
  } catch {
    // pgrep 不在（极端精简的镜像）——退化成只杀自己
  }
  try {
    process.kill(pid, signal);
  } catch {
    // 已经退出了
  }
}

/** 取消一个流的读端；已经在关闭/已取消都不算错。 */
function cancelQuietly(stream: unknown): void {
  const cancel = (stream as { cancel?: () => Promise<void> } | null)?.cancel;
  if (typeof cancel !== "function") return;
  try {
    void (stream as ReadableStream<Uint8Array>).cancel().catch(() => undefined);
  } catch {
    // 忽略
  }
}

let shared: BlenderMcpClient | BlenderCloudClient | null = null;
/** 进程内单例。**一个 Blender 只该有一个桥接**——多个会各自 spawn 一个 MCP server，
 *  而它们连的是同一个 addon socket（社区版 backlog 只有 5），徒增超时归因难度。
 *
 * 云端使用独立 Bearer 凭据与 HTTP 实例路由，不公开原始 addon TCP。 */
export function getBlenderMcp(): BlenderMcpClient | BlenderCloudClient {
  if (!shared) {
    const cloud = readBlenderCloudSettings();
    if (cloud) return (shared = new BlenderCloudClient(cloud));
    if (process.env.BLENDER_LIVE_INSTANCE_NAME) {
      throw new ChatServiceError("云端桌面已配置，但命令凭据和工程分配尚未配置；不会操作本机 Blender", 503, "blender_cloud_not_ready");
    }
  }
  shared ??= new BlenderMcpClient({
    bin: config.blender.bin,
    args: [...config.blender.args],
    host: config.blender.host,
    port: config.blender.port,
  });
  return shared;
}

/** 仅供测试：换掉单例。 */
export function setBlenderMcp(client: BlenderMcpClient | BlenderCloudClient | null): void {
  shared = client;
}

/**
 * 停掉单例（优雅关闭用）。
 *
 * 必须有这一条：工具层走的是 `getBlenderMcp()` 那个单例，**它和调用方自己 new 出来的
 * 实例是两条独立的进程树**。服务退出时只停自己那份，单例那棵就成了孤儿——本机验证时
 * 正是踩在这个上（脚本"跑完了却不退出"，因为孤儿的管道还开着）。
 */
export async function stopBlenderMcp(): Promise<void> {
  const client = shared;
  shared = null;
  await client?.stop();
}

export { DEFAULT_CALL_TIMEOUT_MS };

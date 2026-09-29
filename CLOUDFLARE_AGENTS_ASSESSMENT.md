# ChatSpace 采用 Cloudflare Agents SDK 的技术评估

设计日期：2026-09-29。

状态：**评估结论，未实施任何改动。** 代码保持不变；本文只回答三件事：能不能用、跟现在的 Agent 框架差多少、代价是什么。

修订：**2026-09-29 前提修正。** 初稿以"本地优先、单机使用"为前提，据此得出"不建议切换"；产品方随后确认本产品是**对外提供的 web 产品**（后端由己方托管、访客用浏览器访问、用户不在自己电脑上运行服务），且**没有沙盒/不可信代码执行的概念**。第 0 节已按修正后的前提重写；第 1–3 节的事实（行数、工具清单、平台限制与计费）不受影响；第 3.2 节与第 4 节中依赖旧前提的条目已就地标注。

所有平台侧事实的核对日期与来源见 [附录 A](#附录-a-事实核对表)，未能实测的推断集中在 [第 8 节](#8-未验证项与风险) 单独列出，不与已核对事实混写。

---

## 0. 结论摘要

> 本节为 2026-09-29 前提修正后的版本。原结论（"本地优先产品，不建议在现在切换"）建立在错误前提上，已作废。

### 0.1 修正后的结论

| 问题 | 修正后的结论 |
| --- | --- |
| 跟现在的 Agent 框架（Mastra）比，框架层区别大吗？ | **不大。** 你只用了 `Agent`、`createTool`、`RequestContext` 三个 API，替换这一层约 1,000–1,500 行；两边的工具定义、zod 校验、AI SDK 消息形状基本同构。 |
| 运行时层区别大吗？ | **大，但已不再是"不可做"。** 原判断的两颗拦路钉——"工程在用户电脑上"和"密钥不能离开本机"——在 web 产品形态下自动消失。剩下的是纯技术约束：workerd 无持久磁盘、每事件 30 秒 CPU、无子进程、1 GB 状态上限。 |
| 现在该换吗？ | **不是第一优先级，但已经进入合理候选。** 正确顺序见 0.3。 |

### 0.2 前后对比：哪些理由消失了，哪些还在

| 原判断（本地优先前提） | web 产品形态下 | 说明 |
| --- | --- | --- |
| 本地工程目录是产品语义本身 | **消失** | 访客从未见过 `~/ChatSpace`；工程进 R2 是运维变化，不是产品语义变化 |
| 密钥只在本机、不上云 | **消失** | key 已是服务端 `.env` 里的己方凭证，进 Cloudflare secrets 属正常操作 |
| workerd 无磁盘 / 30 s CPU / 无子进程 | **仍在** | 需 R2 替代文件系统；CAD（openscad worker）与重 GLB 处理需要容器执行环境 |
| 长任务轮询与 DAG 自研 | **仍在** | 换 alarms / Workflows / fibers 反而比现在省心 |
| 沙盒是决策因素 | **删除** | 本产品无不可信代码执行，[Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/) 与 Code Mode 与选型无关。将来若 CAD/GLTF 原生处理要在云上跑，需要的是"执行环境"，不是"安全沙盒" |

CF Agents 的收益在 web 产品形态下才真正兑现：**一个访客/会话一个 DO** 就是天然的隔离与配额单位；空闲休眠让成本随流量而非常驻时间；可恢复流式缓解弱网；alarms 替代轮询。反过来，把现有 Bun + Hono + Mastra 部署到 VPS 或 Cloudflare Containers 也能满足需求，26 个工具一行不改。**换框架的净收益 = 会话状态 + 休眠 + 调度 + 长任务平台化；净成本 = 工具落 R2 + 前端换 WebSocket 协议。**

### 0.3 与框架选型无关、但优先级更高的一件事：对外暴露下的鉴权缺口

产品对外、key 是己方的、生成工具会花钱——"防止陌生访客消耗 token"因此是第一优先级，而它目前没有被守住（2026-09-29 代码核对）：

| 现状 | 位置 | 问题 |
| --- | --- | --- |
| 门禁答案 `"tripothon"` 硬编码 | [accessGate.ts](app/src/shared/storage/accessGate.ts:12) | 明文在前端 bundle 中，可直接读取 |
| 解锁态存 `localStorage` | [accessGate.ts](app/src/shared/storage/accessGate.ts:20) | 控制台一行即可绕过 |
| 只在浏览器判断 | [main.tsx](app/src/main.tsx:28) | 服务端无对应校验 |
| 后端仅有 CORS 白名单 | [config/index.ts](chat/src/config/index.ts:47)、[app.ts](chat/src/app.ts:24) | CORS 不是安全边界，非浏览器客户端可直接调用 |

**后果：** 知道域名的人可以直接调用后端的付费生成接口，账单由己方承担。修复与是否换框架无关，属服务端职责：入站鉴权（会话/设备令牌或 Turnstile）+ 每访客配额与速率限制 + 付费工具的前置预算校验。走 Cloudflare 时对应 Turnstile、Rate limiting rules，以及把配额计数放进 DO。

**决策顺序：** ① 先补 0.3 的鉴权与配额（与框架无关）；② 再定后端托管位置（现有 Bun 服务上 VPS / Cloudflare Containers / 重写为 Workers）；③ 只有当"会话状态、断线续传、长任务恢复"确实成为运维负担时，才用 CF Agents 替换 Mastra。

一句话：**换框架不痛，换运行时才痛；但在 web 产品形态下，最痛的那两颗钉子已经拔掉了——真正该先处理的是对外暴露下的鉴权与配额，而不是框架选型。而且"上 Workers"跟"用不用 CF Agents SDK"是两件事，Mastra 自己就有 `@mastra/deployer-cloudflare`。**

---

## 1. 现状盘点

### 1.1 当前只有两个运行部分

> 本小节描述的是**当前/开发期的部署形态**（网页在 Pages、服务在本机），不是产品的目标拓扑。按 2026-09-29 的前提修正，产品是对外提供的 web 服务，服务端位置另议（见 0.3 决策顺序第 ② 步）。

按 [PLAN.md](PLAN.md) 的目标架构：

```text
Cloudflare Pages（静态 Vite + React + R3F）
        │ 浏览器直连 HTTP / SSE
        ▼
本机服务：Bun + Hono（仅绑定 127.0.0.1:3901）
  ├─ 工程与资产文件读写、格式转换、导出
  ├─ Agent 循环、供应商调用、生成任务与失败恢复
  └─ ~/ChatSpace/projects、~/ChatSpace/sessions
```

Cloudflare 现在是纯静态托管方：按 [README.md](README.md:96) 的约定，"网页向本机服务直连，Cloudflare 不接收项目 API 请求"，API key 只在本机 `chat/.env`，浏览器只保存模型偏好。

### 1.2 代码规模（`chat/src`，2026-09-29）

| 层 | 非测试行数 | 内容 |
| --- | --- | --- |
| `mastra/` | 7,147 | 26 个 `createTool` 定义、提示词、[creator.ts](chat/src/mastra/agents/creator.ts) 的 `new Agent(...)` |
| `services/` | 2,562 | 资产存储、生成任务、SceneJob DAG、模型发布 |
| `models/` | 2,038 | 火山方舟 / Tripo3D / World Labs / 混元的协议实现 |
| `routes/` | 705 | 含 [chat.ts](chat/src/routes/chat.ts) 的 SSE、心跳与 ask-user 中止 |
| `common/` | 689 | 下载、轮询、HTTP、逻辑路径 |
| 测试 | 6,806 | `bun test` |

### 1.3 Mastra 实际承担的三件事

| 用途 | 出现位置 | 是否可替换 |
| --- | --- | --- |
| `new Agent({ instructions, tools, model })` | 仅 [creator.ts](chat/src/mastra/agents/creator.ts) | 是，等价于一个 LLM 循环 + 工具注册表 |
| `createTool({ id, inputSchema, execute })` | 26 个工具文件 | 是，AI SDK 的 `tool()` 形状几乎一致 |
| `RequestContext`（请求级 DI） | [requestContext.ts](chat/src/mastra/tools/requestContext.ts) | 是，换成 DO 的 `this.env` 或请求头注入 |

**流式语义、SSE、心跳、ask-user 中止、任务恢复全部是自己写的**——[chatService.ts](chat/src/services/chatService.ts) 499 行 + [chat.ts](chat/src/routes/chat.ts) 104 行。这既说明 Mastra 依赖很薄（换框架便宜），也说明你现在最脆弱的那段代码（最近几次提交都在修长任务可见性与恢复）是自研资产，换平台会被整体替换掉。

### 1.4 一个关键的有利事实：本地耦合已经收敛

我逐个文件核对过（非测试代码）：

| 直接依赖 | 文件 |
| --- | --- |
| `node:fs/promises` | 只有 [assetStorage.ts](chat/src/services/assetStorage.ts:18) 与 [staticApp.ts](chat/src/staticApp.ts) |
| `node:os` | 只有 [config/index.ts](chat/src/config/index.ts) |
| `Bun.*` 专有 API | 只有 [staticApp.ts](chat/src/staticApp.ts)（`Bun.file`）与 [skyboxGen.ts](chat/src/mastra/tools/skyboxGen.ts)（`Bun.file`） |
| `new Worker(...)` | 只有 [cadOps.ts](chat/src/mastra/tools/cadOps.ts:55)（CAD worker）→ [cadWorker.ts](chat/src/mastra/tools/cadWorker.ts) |

`assetStorage.ts` 里那句"workflow/tool 不直接调文件系统 API，一律经此接口（云迁移纪律 ②）"**确实是遵守了的**：26 个工具里只有 `ask-user` 完全不碰存储，其余全部经 `AssetStorage` 逻辑路径访问。这条纪律把"云迁移"的最大障碍从"到处是磁盘调用"降级成"换一个 `AssetStorage` 实现"。

同时也要看到，`AssetStorage` 接口里 `move?()` 的注释已经写明"本地同库发布用原子移动；云存储可用提交标记实现而不提供此能力"——你早就意识到对象存储不能原子 rename。这类语义差异（原子替换、独占创建、目录列举）在云上要逐个重新设计，不会因为接口收敛而消失。

### 1.5 工具清单

26 个 `createTool`，其中 23 个挂在 creator agent 上（`analyze-reference` 为条件挂载），3 个未挂载：`build-cad-model`、`get-cad-source`、`unwrap-uv`。

| 迁移类 | 工具（`id`） | 涉及模块 | 说明 |
| --- | --- | --- | --- |
| A. 无本地 IO | `ask-user` | askUser.ts (68 行) | 纯返回问题对象，可原样搬到边缘 |
| B. 只经逻辑路径 + 供应商 HTTP | `update-plan`、`generate-reference-images`、`generate-clean-plate`、`generate-skybox`(†)、`generate-texture`、`analyze-scene`、`analyze-reference`、`start-3d-batch`、`start-world-task`、`start-scene-job`、`revise-scene-job`、`retry-scene-job-nodes`、`get-scene-job`、`segment-parts`、`retopologize`、`rig-model`、`generate-character`、`identify-asset`、`inspect-asset`、`list-generation-tasks`、`resume-generation`、`repair-assets` | 第 1.2 节所列的工具文件 + `services/assetStorage.ts` + `models/*` | 换 `AssetStorage` 实现即可，但需要 R2 与"大文件不走内存"的重设计 |
| C. 依赖本机进程/原生能力 | `build-cad-model`、`get-cad-source` | cadOps.ts (435 行) + cadWorker.ts | `new Worker` + openscad wasm；workerd 无同款嵌套 worker |
| D. 长任务与持久 DAG | （被 B 类工具调用，不是工具本身） | tasks.ts (397)、sceneJobRunner.ts (447)、sceneJobs.ts、workflowRuns.ts | 需要 fibers / Workflows / Queues / alarms 重写 |
| E. 支撑模块 | — | ark3dOps、seed3dOps、seed3dOutput、imageEdit、modelPublicUrl、projectTools、worldGen、requestContext | 与工具一起迁移，`projectTools.ts`(681) 的存储调用最密集 |

(†) `generate-skybox` 同时用了 `Bun.file` 与本地路径拼装。

---

## 2. Cloudflare Agents SDK 是什么

### 2.1 运行时模型

它不是"另一个 Mastra"，而是 **Durable Objects 上的 actor 运行时**：

- 一个会话/项目 = 一个 DO，有持久身份、内置 SQLite、WebSocket 连接、alarms 调度。
- 空闲可休眠，**休眠期间不收 compute 费用**；HTTP 请求、WS 消息、定时任务把它唤醒。
- 事件之间状态持久；**内存变量、定时器、在途 fetch、闭包不持久**，重启靠 `runFiber()`/`startFiber()` 的检查点恢复。
- 官方原话："Because Agents run on Cloudflare Workers and Durable Objects"（[Testing your Agents](https://developers.cloudflare.com/agents/getting-started/testing-your-agent/)），测试走 `@cloudflare/vitest-plugin` 的 workerd 池，**没有"跑在 Bun/Node 上"这种模式**。

### 2.2 与现有能力的映射

| 你现在自己实现的 | CF Agents 的对应物 | 判断 |
| --- | --- | --- |
| 会话落盘（`sessions`）+ SSE 重连 | DO SQLite 消息持久化 + [可恢复流式](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) + WS 广播 | 平台能力更强；多标签页同步、断线续流免费拿到 |
| [chat.ts](chat/src/routes/chat.ts) 的 SSE + 心跳 | `AIChatAgent.onChatMessage()` + `useAgentChat` | 前端协议换血（见 3.3） |
| `ChatDelta` 联合类型（text / tool / tool-result + images / taskIds / plan / question） | AI SDK UI 消息 parts + **typed data parts** | 几乎一对一：data parts 正好承载 plan、question、taskIds、图片路径 |
| ask-user 卡片 + 写进 SSE 后 abort 本轮 | approvals / client tools / Workflow `waitForApproval()`（[HITL](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)） | 语义同构，但"提问之后不可能再有工具被调用"这条不变量要从你的提示词纪律 + abort 迁移成平台的 approval 语义，需要重写测试 |
| tasks.ts 轮询 + sceneJobRunner DAG 恢复 | fibers + alarms + [Queues](https://developers.cloudflare.com/agents/runtime/execution/queue-tasks/) + [Workflows](https://developers.cloudflare.com/agents/concepts/workflows/) | **这是最有价值的替换**：你的失败恢复是自己写的，平台版是原语 |
| 无 | cron/时区[调度](https://developers.cloudflare.com/agents/runtime/execution/schedule-tasks/)、sub-agents、tracing、[Think harness](https://developers.cloudflare.com/agents/harnesses/think/) | 新增能力，不是替换 |
| 无 | [Sandbox](https://developers.cloudflare.com/agents/tools/sandbox/)（容器，有真文件系统与 shell） | 逃生舱；也是路线 B/C 的成本大头 |

### 2.3 平台限制（已核对）

| 项 | 值 |
| --- | --- |
| 每 agent 每事件 CPU | 30 秒（收到新 HTTP 请求 / WS 消息 / 定时任务即刷新） |
| 单步 wall-clock | 不限（等待 LLM、数据库属此类） |
| 每 agent 状态 | 1 GB |
| 并发 agent 数 | 账号内千万级 |
| 计算环境 | workerd：无持久磁盘、无子进程、无原生模块 |

30 秒 CPU 对你的影响需要逐个工具评估，尤其 `@gltf-transform` 转换与 openscad WASM。注意这是 **CPU 时间**而非 wall-clock：等待 Tripo 轮询不烧 CPU，但解析一个大 GLB 会。

### 2.4 计费（已核对，2026-09-29）

| 项 | 免费版 | 付费版（Workers Paid $5/月） |
| --- | --- | --- |
| DO 请求（含 RPC、WS 消息、alarm） | 10 万/天 | 100 万/月，超出 $0.15/百万 |
| DO duration | 13,000 GB-s/天 | 400,000 GB-s/月，超出 $12.50/百万 GB-s |
| SQLite 行读 | 500 万/天 | 前 250 亿/月，超出 $0.001/百万行 |
| SQLite 行写 | 10 万/天 | 前 5,000 万/月，超出 $1.00/百万行 |
| SQLite 存储 | 共 5 GB | 5 GB-month，超出 $0.20/GB-month |
| Containers（Sandbox）内存 | — | 含 25 GiB-小时/月，超出 $0.0000025/GiB-s |
| Containers vCPU | — | 含 375 vCPU-分钟/月，超出 $0.000020/vCPU-s |
| Containers 出口流量 | — | 北美/欧洲 $0.025/GB（含 1 TB） |

把 Containers 换算成直觉：`basic` 实例（1 GiB 内存、1/4 vCPU）**每月包含的额度约等于 25 小时不间断运行**。你的工程文件、参考图、GLB/EXR 若放进容器，2–12 GB 磁盘和出口流量都要计入。**这部分成本现在是你自己电脑的电费，上云后是账单。**

纯 DO 侧的聊天成本可忽略：一个 10 分钟 polling 任务约占 75 GB-s（0.125 GB × 600 s），不到一分钱。

### 2.5 版本与生态兼容（已核对）

| 项 | 值 | 与你的现状 |
| --- | --- | --- |
| `agents` | 0.24.0 | — |
| `@cloudflare/ai-chat` | 0.12.0 | — |
| peer deps | `ai ^6\|\|^7`、`zod ^4`、`react ^19`、`vite >=6 <9` | zod 4 ✓、React 19.2 ✓、Vite 8 ✓ |
| `@mastra/core` 最新 | 1.71.0 | 你在 `^1.48.0`，落后若干 minor |
| `@mastra/deployer-cloudflare` | 1.2.30 | **说明 Mastra 本身也能部署到 Workers** |

最后一行是本次评估最容易被忽略的一点：**"要不要上 Cloudflare"和"要不要换掉 Mastra"是两个独立决策。** 如果最终障碍只是 Mastra，你不需要 Agents SDK。

---

## 3. 差距分析

### 3.1 框架层：确实可以换，成本可控

| 维度 | Mastra（现状） | CF Agents / AI SDK |
| --- | --- | --- |
| Agent 定义 | `new Agent({ instructions, tools, model })` | `class X extends AIChatAgent { async onChatMessage() }` |
| 工具定义 | `createTool({ id, inputSchema: z.object(...), execute })` | `tool({ inputSchema: z.object(...), execute })` |
| 循环 | `agent.stream(messages).fullStream` | `streamText(...).toUIMessageStreamResponse()` |
| 模型接入 | `providerId: "byok-openai-compatible"` + url/key | AI SDK provider，OpenAI 兼容端点直接可用 |
| 请求级注入 | `RequestContext` | `this.env`（secrets/bindings）或请求头 |

按 26 个工具 + 流式适配层估算：**框架改写约 1,000–1,500 行**，外加提示词与 zod schema 基本原样复用。这部分不构成决策障碍。

### 3.2 运行时层：四个硬约束

> 按 2026-09-29 前提修正：下列第 1、2 条在"对外 web 产品"形态下**不成立**（见 0.2）；修正后真正剩下的约束是第 3、4 条。

1. **本地工程目录是产品语义本身。** `~/ChatSpace/projects` 里的 `scene.json`、源图、参考图、模型文件、缩略图，现在是"用户的文件"。上云后它们是 R2 对象与 DO SQLite 行，用户不再拥有可打开的文件夹——这是产品定义的改变，不是重构。README 里"Cloudflare 不接收项目 API 请求"这句承诺也要一并撤销。
2. **密钥模型。** 现在"网页只读配置状态，密钥只在本机 `chat/.env`"。上云要么把火山/Tripo/World Labs/混元的 key 变成 Cloudflare secrets（托管方改变了），要么继续由本机服务持有（那就必须保留本机服务，也就回到了路线 C）。
3. **workerd 的能力缺口。** 没有持久磁盘、没有子进程、`new Worker` 无同款、原生模块不可用。你的直接暴露面其实很小（见 1.4），但 `AssetStorage` 的原子语义（`writeTextAtomic`、`createExclusive`、`move`）在 R2 上要重新设计，大文件（GLB/EXR）也不能再像现在这样直接进内存或 `Bun.file`。
4. **长任务与大文件下载。** Tripo/World Labs 的轮询、产物下载、DAG 汇总，机制上 CF 的原语更好（fibers/Workflows/Queues），但**执行体必须落在能写文件的地方**——要么 R2 + 容器，要么本机。

### 3.3 需要重写的清单（与框架无关的部分）

| 范围 | 现状 | 上云后 |
| --- | --- | --- |
| 前端流式客户端 | [chatClient.ts](app/src/shared/lib/chatClient.ts) + [sse.ts](app/src/shared/lib/sse.ts) + [useAgentChat.ts](app/src/pages/AppDashboard/useAgentChat.ts)（自研 SSE 与恢复） | `useAgentChat` + WebSocket |
| 凭据注入 | [requestContext.ts](chat/src/mastra/tools/requestContext.ts) 按请求注入用户 key | `this.env` secrets 或 Access 保护的请求头 |
| 静态托管 | [staticApp.ts](chat/src/staticApp.ts) 单进程同端口发网页 | Workers static assets |
| 测试 | 6,806 行 `bun test` | 依赖 workerd 的部分要迁到 `@cloudflare/vitest-plugin`；纯逻辑（`models/`、`common/`）可保留，前提是保持运行时无关 |
| 持久化 | `sessions`/`scene.json` 落盘 | DO SQLite + R2，需要数据模型重设计 |

---

## 4. 三条路线对比

> 按 2026-09-29 前提修正：路线 A 的前提（产品跑在用户机器上）已不成立，它降级为"开发期临时访问方案"；对外交付应在 B 与 C 之间选择，其中路线 C 的"本机"应重读为"己方后端服务器"（工具执行留在你自己的服务里，会话与循环上云）。

| | A. 本地优先 + 隧道 | B. 云端 SaaS 全量 | C. 混合：云上循环 + 本机执行工具 |
| --- | --- | --- | --- |
| 做法 | Cloudflare Tunnel + Access 暴露本机 3901；Mastra 与工程目录不动 | 后端重新平台化：R2 存储 + Sandbox 容器 + DO 会话；`AIChatAgent` 替换 chatService | 本机服务用 `AgentClient`（支持 Bun/Node）主动外连云端 DO，工具调用 RPC 回本机执行 |
| 拿到的收益 | 异地/手机可用、无需公网端口、可加访问控制 | 免安装、多用户、可恢复流式、多端同步、调度与可观测性平台化 | 云上会话记忆与多端接入，同时保留本机工程与密钥 |
| 主要成本 | 2–3 天 | 季度级重写：26 个工具的执行体几乎全改 + 前端协议换血 + 测试改挂 workerd | 自建 tool-bridge 协议；本机服务仍须在线；约 2–4 周才能对齐现状 |
| 主要风险 | 本机必须开机；弱网 SSE 体验 | 产品语义改变（文件不再属于用户）、密钥托管、容器成本、CPU 30 s 对 CAD/GLB 的实测风险 | 两处状态一致性（云 DO + 本机文件）、桥接协议成为新的故障面 |
| 何时该选 | 目标是"能用、能远程" | 目标是"免安装、多用户、可规模化交付" | 目标是"云上必须有一份会话"，同时短期无法放弃本地处理 |

**推荐顺序：先做 A。** 它以最小代价解决最可能的真实诉求（远程可用），并且不产生任何需要回滚的架构债。只有在明确要走 SaaS 时再投入 B，且 B 的第一步应该是 spike 而不是立项（[第 7 节](#7-建议的-3-天-spike)）。

---

## 5. 若走云端：工具迁移分类

按 1.5 的分类，落地顺序与工作量分布：

| 类 | 工具数 | 迁移动作 | 风险 |
| --- | --- | --- | --- |
| A | 1（`ask-user`） | 直接搬；映射到 approvals 或 data part | 低 |
| B | 22 | 写一个 R2 版 `AssetStorage`；把 `readAsDataUri` 改为从 R2 读；大文件改流式 | 中：原子语义、内存上限、30 s CPU |
| C | 2 | 移入 Sandbox 容器（自带 Dockerfile + `instance_type`），或保留在本机 | 高：容器成本与冷启动 |
| D | 任务与 DAG（非工具） | `tasks.ts` → alarms + Queues；`sceneJobRunner.ts` → Workflows/fibers；`resumeGeneration.ts` → fiber 检查点 | 中：逻辑可平移，但恢复语义要重新验证 |
| E | 支撑模块 | 随所属工具迁移 | 低至中 |

一个必须提前决策的点：**`AssetStorage` 的契约要不要为云端放宽**。现在 `writeTextAtomic` 与 `createExclusive` 是本地文件系统的保证，R2 没有等价物；要么在云实现里用"提交标记 + 版本键"模拟，要么修改上层调用方接受弱化语义。这会波及 [sceneJobs.ts](chat/src/services/sceneJobs.ts) 与 [assetStorage.ts](chat/src/services/assetStorage.ts) 的调用点，属于设计改动而非移植。

---

## 6. 决策触发条件

建议把下面任一条作为"重新评估"的信号，而不是凭感觉推进：

1. 出现**明确的多用户/免安装需求**（例如对外发布、他人使用、需要账号体系）。
2. 本机服务成为**交付瓶颈**（用户不愿装 Bun、不愿常开机器是关键投诉项）。
3. 自研的**任务恢复与可见性**再出一次线上级故障，且评估认为平台原语能根治。
4. 需要**移动端/多端同时在线**，且路线 A 的隧道方案在体验上确实不够。

反面条件（出现就别换）：用户明确要求工程文件留在自己电脑上；密钥不能离开本机；CAD 与 GLB 处理无法在 30 s CPU 内完成。

---

## 7. 建议的 3 天 spike

目标不是做原型，而是**量出真实工作量**。选择 3 个最"无状态"的工具，故意选择乐观样本以得到成本下限：

| 步骤 | 内容 | 产出 |
| --- | --- | --- |
| 1 | `npx create-cloudflare` 起一个含 `AIChatAgent` 的 Worker；把 `analyze-scene` 的 schema 原样搬成 AI SDK `tool()` | 框架改写量的实测数据（行数、无用适配） |
| 2 | 接一个 R2 版 `AssetStorage`，只实现 `readText/writeText/writeBytes/list/exists`，**故意不实现** `writeTextAtomic/createExclusive/move` | 上层调用方在弱语义下的破损清单（这是最有价值的产出） |
| 3 | 把 `start-3d-batch` 的任务轮询换成 alarm/Queue，跑通一次真实 Tripo 任务并下载产物到 R2 | 长任务迁移难度、CPU 30 s 是否触顶、出口流量成本 |
| 4 | 用 `AIChatAgent` + `useAgentChat` 替换最小聊天链路，把 `ask-user` 的卡片改成 data part + approval | 前端协议改造量、ask-user 不变量的重写成本 |
| 5 | 在 Sandbox 里跑一次 `cadWorker` 的 openscad 任务 | 类 C 工具是否必须留在本机 |

**验收标准（不是"能跑通"，而是）：** 拿到三张表——① 框架改写实际行数；② `AssetStorage` 弱语义影响的调用点清单；③ 单个生成任务在云上的 CPU/内存/流量实测值。这三张表齐了，B 路线的工作量估算就从"季度级"变成可报价的数字。

---

## 8. 未验证项与风险

以下内容本文**没有实测**，不应被当作结论使用：

1. **火山方舟从 Cloudflare 边缘的可达性与延迟未实测**（协议上只是 OpenAI 兼容 HTTPS，理论上可行；但区域、TLS、限流行为需实测）。
2. **`@gltf-transform` 在 workerd 中的内存与 CPU 表现未实测**——纯 JS 理论上可运行，但大 GLB 是否撞 30 s CPU / 128 MiB 内存未知。
3. **openscad WASM 在 Sandbox 容器中的表现未实测**（容器内存从 256 MiB 起）。
4. **Containers 冷启动与休眠策略的实际体验未验证**；`Sandbox` 的容器需要在 `wrangler` 里声明 Dockerfile 与 `instance_type`。
5. **DO SQLite 的存储计费自 2026-01 起启用**（官方目标日期 2026-01-07），本文采用的是启用后的费率；长期成本模型需按真实行读写量重算。
6. **R2 与 DO 之间的数据一致性方案未设计**（本机服务现在依赖文件系统的原子性，云上没有等价物，见第 5 节）。
7. **路线 C 的 tool-bridge 协议未验证**：`AgentClient` 官方声明支持 Bun/Node，但"云端 agent 把工具执行委托给外连的客户端进程"需要自建协议，官方文档中的 client tools 面向浏览器场景。
8. **`agents` 0.24 与 `ai` v6/v7 的 API 稳定性**：0.x 版本，升级可能带来破坏性变更（peer 范围宽也意味着组合需要锁定）。

---

## 附录 A 事实核对表

| 事实 | 值 | 来源 | 页面更新日期 |
| --- | --- | --- | --- |
| Agents 运行环境 | Workers + Durable Objects（workerd），无本地运行模式 | [Testing your Agents](https://developers.cloudflare.com/agents/getting-started/testing-your-agent/) | 2026-08-20 |
| CPU / 状态 / 并发限制 | 30 s CPU 每事件、1 GB 状态、千万级并发 | [Limits](https://developers.cloudflare.com/agents/platform/limits/) | 2026-06-03 |
| DO 请求与 duration 计费 | 免费 10 万请求/天、13,000 GB-s/天；付费 100 万/月、40 万 GB-s/月 | [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) | 2026-08-25 |
| DO SQLite 存储计费 | 读 5M/天或 250 亿/月，写 10 万/天或 5,000 万/月，存储 5 GB | 同上（2026-01-07 起启用） | 2026-08-25 |
| Containers 计费与实例类型 | 25 GiB-h/月、375 vCPU-min/月、200 GB-h/月；lite 为 1/16 vCPU + 256 MiB | [Containers Pricing](https://developers.cloudflare.com/containers/platform/pricing/) | 2026-08-28 |
| 聊天能力 | `AIChatAgent` + `useAgentChat`：消息持久化、可恢复流式、WS 同步、data parts | [Chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) | 2026-09-15 |
| 客户端 SDK 运行时 | `AgentClient` 支持浏览器 / Node.js / Deno / Bun / edge | [Client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) | 2026-09-15 |
| 包版本 | `agents@0.24.0`、`@cloudflare/ai-chat@0.12.0`；peer `ai ^6\|\|^7`、`zod ^4`、`react ^19` | npm registry，2026-09-29 查询 | — |
| Mastra Cloudflare 部署器 | `@mastra/deployer-cloudflare@1.2.30`；`@mastra/core` 最新 1.71.0 | npm registry，2026-09-29 查询 | — |

## 附录 B 本文引用的仓库数据

| 数据 | 来源 |
| --- | --- |
| 分层行数、测试行数 | `chat/src` 下 `wc -l`，排除 `*.test.ts`，2026-09-29 |
| 26 个工具与 `id` 清单 | `chat/src/mastra/tools/*.ts` 的 `createTool({ id: ... })` |
| 23 个挂载 | [creator.ts](chat/src/mastra/agents/creator.ts) 的 `tools` 映射 |
| 文件系统/原生耦合 | 全仓非测试文件中的 `node:fs/promises`、`node:os`、`Bun.*`、`new Worker` 检索结果 |

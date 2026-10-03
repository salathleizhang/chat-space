# `pascalorg/editor` 架构拆解 —— 哪些能直接搬到 ChatSpace

> 姊妹文档：[`WEBGPU_OPENSOURCE_LANDSCAPE.md`](./WEBGPU_OPENSOURCE_LANDSCAPE.md)（按"哪些仓库的代码真的能读"排序，那篇**没有**收录 Pascal）、
> [`EDITOR_PRACTICES.md`](./EDITOR_PRACTICES.md)（编辑器架构的二手资料）、[`SCENE_COMMAND_PLAN.md`](./SCENE_COMMAND_PLAN.md)（命令流计划，本文多处与它对接）。
>
> 目标读者：本仓库的渲染/编辑器开发者。当前栈 three.js 0.186.1、WebGPU-only、1/2/4 窗格、splat、gizmo、截图、GPU 时间戳，以及并行中的 PlayCanvas 迁移层。

---

## 〇、取样与核实状态（先读）

**本轮网络与上一轮不同：`git clone` 可用**（`web_fetch` 仍被 fake-IP 挡住，`github.com` 解析到 `198.18.0.x`）。
所以本文的证据等级比 `WEBGPU_OPENSOURCE_LANDSCAPE.md` 高得多：**几乎全部是 ✅ 本机已核实**，给的是可 `read` 的路径与行号。

| 项 | 值 |
| --- | --- |
| 上游 | <https://github.com/pascalorg/editor>（MIT） |
| 本机副本 | `.pc-research/pascal-editor/`（沿用你已有的 `.pc-research/<repo>` 约定；该目录在 `.gitignore:15`） |
| 快照 | commit `89e1442f4e1d077d9c14b9737bc1cbec4ffd943a`，2026-10-01，121 MB |
| 规模 | `packages` + `apps` 共 **721 444** 行 `.ts/.tsx`，其中测试文件 **221 444** 行（≈31%） |
| 包 | `apps/{editor,ifc-converter}`、`packages/{core,viewer,editor,nodes,mcp,cli,ui,ifc-converter}` |
| 栈 | React Three Fiber + **three 0.186.0（WebGPU/TSL）**、zod、zustand(+zundo)、Bun、turbo、Biome |

**证据标记**：✅ 本机已核实（给路径行号）· 🟡 高置信（读到间接证据）· ❓ 未能核实。

**一句话评价**：它不是"另一个 R3F demo"，而是把**编辑器纪律**写成了可执行的架构约束——依赖箭头由 Biome 规则 + 架构测试守住，
交互状态收敛成一个判别联合，agent 工具分三层且有一致性测试。**它的文档密度（`wiki/architecture/` 24 篇 + `DECISIONS.md` 15 条不变量）是本仓库最该学的东西，比任何一段渲染代码都值钱。**

---

## 一、结论速览（按"能不能直接抄"排序）

| # | 借鉴项 | 命中你的哪个问题 | 证据 | 成本 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | **规则从 `AGENTS.md` 拆成"入口 + 按需 wikipage + review skill"** | 你的 `AGENTS.md` **76 781 B，已被 harness 截断到 65 142 B**，被砍掉的恰好是第六节"不要假装解决" | 上游 `AGENTS.md` 全文 **2 602 B / 39 行**、`DECISIONS.md:3`、`wiki/architecture/README.md:33-37`、`.agents/skills/review-architecture/SKILL.md:13-31` | 低（纯文档搬运） | **P0** |
| 2 | **`InteractionScope` 判别联合 + `begin/update/end/endIf`** | 你的"手柄拖动 / 框选 / 漫游 / 漫游 tick 改写相机"之间靠散落布尔量与订阅顺序协调 | `packages/editor/src/lib/interaction/scope.ts:32-119`、`store/use-interaction-scope.ts:38-74` | 中 | **P0** |
| 3 | **`createDragSession` 纯编排器 + `pauseHistory/resumeHistory`** | `SCENE_COMMAND_PLAN.md` §三 缺口 #1「全仓 `undo`/`redo` 命中数为 0」 | `packages/core/src/services/drag-session.ts:10,84-150`、`single-undo-dance.test.ts:20-33` | 中（正好是你 Phase 里的下一步） | **P0** |
| 4 | **`scene-visibility`：记"理由"而不是"掩码"** | 你的 `paneRegistry.sync()` 每次重写 `camera.layers`；线框/贴图/HUD/网格多个写入者互相覆盖（`AGENTS.md` §四之二 已记录两次被这个咬） | `packages/viewer/src/lib/scene-visibility.ts:5-23,29-46` | 低 | **P0** |
| 5 | **`installEmptyDrawGuard`：零顶点 draw 毒化整个 command encoder** | 你有"某窗格闪一下 / 整块画布落到失败面板"的失败模式 | `packages/viewer/src/components/viewer/index.tsx:103-188` | 低 | **P1** |
| 6 | **`installTextureNodeNullGuard`** | three 节点材质空纹理抛错 → 整个 render pass 死（画面全黑） | `packages/viewer/src/lib/texture-node-guard.ts:1-40` | 低 | **P1** |
| 7 | **`?disable=ao,denoise,outline,postFx,draw` 剖面开关** | 你的 §5.19 交替设计很贵；这是更便宜的"逐 pass 归因" | `packages/viewer/src/components/viewer/post-processing.tsx:69-123` | 低 | **P1** |
| 8 | **`gpu-render`（时间戳）vs `gpu-queue`（背压）命名二分** | 你的 `AGENTS.md` §五 规则 5 说的就是这件事，他们把它写进了代码注释与指标名 | `post-processing.tsx:168-196` | 极低 | **P1** |
| 9 | **agent 工具三层：contract / operation / executor + parity 测试** | 你的 `chat/src/mastra/tools/*` 与 app 编辑器共享场景语义 | `wiki/architecture/agent-surfaces.md:17-29`、`packages/core/src/agent-tools/index.ts:16-30` | 中 | **P1** |
| 10 | **`AgentRefusal(code, message, details)`：拒绝是答案** | 你的 agent 工具失败时的语义不统一 | `packages/core/src/agent-tools/refusal.ts:1-14`、`agent-surfaces.md:27` | 极低 | **P1** |
| 11 | **`frameloop="never"` + 自建 `FrameLimiter`（含 `useFrame` 内 try/catch、`?disable=draw` 时改用 `setInterval`）** | 你的 demand 续帧判断（`VIEWPORT_REVIEW.md` §○ 已推翻一次）；headless/探针场景 | `packages/viewer/src/components/viewer/frame-limiter.tsx:48-60,82-133` | 低 | **P2** |
| 12 | **`NodeDefinition` 三复选框（`geometry`/`renderer`/`system`）+ capabilities 动词** | 你现在 kind→组件是手写映射；规模上未必需要，但**capabilities 作为"动词"**值得单独抄 | `wiki/architecture/node-definitions.md:11-41`、`core/src/registry/types.ts:1664+` | 高 | **P3** |
| 13 | **实时视口不开 AA、截图管线单独加 FXAA**（你的硬约束 2 说 `antialias` 必须保持 false——这条正好在你约束内把截图质量拉回来） | 你的缩略图/四视角检查图目前与视口同口径（无 AA） | `lib/snapshot-pipeline.ts:4,296-300`、`three.webgpu.js:61775` | 低 | **P1** |
| 14 | **超大截图分块 + `TILE_OVERLAP`**（每块多渲一圈，只取 `inner`），让 AO/描边/AA 在接缝处有邻域 | 任何超过一次 pass 上限的成图，直接分块会在接缝留下断裂 | `components/editor/thumbnail-generator.tsx:122-155` | 低 | **P2** |

**借不到的部分（要说清楚）**：Pascal 是**单画布单相机**，没有 1/2/4 窗格，没有 `ArrayCamera` 多视口，没有 splat，没有 PlayCanvas 迁移层。
所以你在这些方向上的积累**领先于它**，不要反过来被它带偏。

---

## 二、先说最扎心的一条：你的硬约束文档正在被截断

这不是抄不抄的问题，是你现在就在付的代价。

```
$ wc -c AGENTS.md
76781 AGENTS.md
```

harness 的工作区指令预算是 **65 536 B**，本轮实际注入的是：**`truncated AGENTS.md from 76781 to 65142 bytes`**。
于是**最后 11 639 B 从未进入任何 agent 的上下文**——而那正是：

- 第六节「已知未解问题（不要假装解决）」的**全部**；
- "已排除（**不要再提这些假设**）"的排除清单；
- "**不要再引用** 22:24 那轮 GPU-bound 结论"、"这两个倍率已被 `VIEWPORT_REVIEW.md` §○ 取代"这类**撤回指令**；
- Metal 抓帧路径的核实结论、"审计依赖一定要先确认 `import.meta.resolve` 落在哪一份"的教训。

**被截掉的正好是"防止重复踩坑"的那一半。** 一个只读到前 65 KB 的 agent，会重新提出你明确排除过的假设、重新引用你已作废的数字。

### Pascal 怎么解决

**硬数字对照**：

| | 本仓库 | Pascal |
| --- | --- | --- |
| 根 `AGENTS.md` | **76 781 B**（≈1 650 行）**→ 被截断到 65 142 B** | **2 602 B / 39 行** |
| 规则正文位置 | 就在 `AGENTS.md` 里 | `wiki/architecture/*.md`（24 篇 / 3 647 行）+ `DECISIONS.md`（15 条不变量） |
| 多 agent 入口 | — | `CLAUDE.md`、`GEMINI.md`、`.github/copilot-instructions.md` **都是指向 `AGENTS.md` 的符号链接** |

**它的 `AGENTS.md` 自我定位就一句话**（逐字）：

> **Read `DECISIONS.md` first**: what Pascal is, the architecture invariants (E-IDs), the testing rule (T-001),
> and what is explicitly delegated to you. **Everything else here is a map.**

正文只有四块：包职责表、「**Where to look**」（按边界类型指到具体 wiki 页）、命令、工作约定。
——**它把 30 倍的内容搬走，只留下"读什么、按什么顺序读"**。

三层机制，第三层是关键：

1. **`AGENTS.md` 是一页地图**，且把最高优先级的阅读顺序写死："先读 `DECISIONS.md`"。
2. **规则正文按需读**：`wiki/architecture/README.md:33-37` 给出"每次 review 必读 5 篇，其余按 diff 触及面读"的顺序；
   `AGENTS.md` 里还有一句按边界类型的分发："一个新的 kind → `node-definitions.md`、`node-schemas.md`；
   一个工具或交互 → `tools.md`、`interaction-scope.md`；`viewer` 里任何东西 → `viewer-isolation.md`、`layers.md`……"
3. **`.agents/skills/review-architecture/SKILL.md`（182 行）把"先读规则"变成流程的第一步**，并给出**按 diff 路径选择要读哪篇**的映射表：

```
If the diff touches placement / move / handle / reshape / box-select / paint or any
overlay or picking behaviour, also read interaction-scope.md
If anything looks like a new dispatch surface or registry concept, also read
DECISIONS.md E-002 and node-definitions.md
```
（`.agents/skills/review-architecture/SKILL.md:13-31`）

它还要求 reviewer **先做一次"层归属分类"再走 checklist**，并直言这是"最常见也最有害的一类违规，checklist 自己抓不住"
（同文件 `:56-60`）。这一条我认为比规则本身更重要——**它承认了 checklist 的失效模式，并为它加了专门的一道工序。**

### 给你的具体做法

- 把 `AGENTS.md` 的第六节、「已撤回清单」、「文档地图」三段整体移到独立文档（例如 `WEBGPU_INDEX.md` / `WORLD_STATE.md`），
  `AGENTS.md` 只留包/目录地图 + 一节"当前可信基准" + 硬指针（"做任何 WebGPU 断言前必读 `WEBGPU_FINDINGS.md` §1 与撤回清单"）。
- **把 `AGENTS.md` 当符号链接的唯一源**（`CLAUDE.md` / `GEMINI.md` → `AGENTS.md`），而不是维护多份入口。
- **验收判据**：`wc -c AGENTS.md` < 20 KB（Pascal 是 2.6 KB，但你有 1 000+ 行 WebGPU 结论，20 KB 是务实上限）；
  且注入预算（65 536 B）下**不再发生截断**。
- 加一个 `review-webgpu` skill，把"读 §1 可信结论 → 读撤回清单 → 再开口"写成第一步，
  并列出"按改动路径 → 必读文档"的映射表（照 `SKILL.md:13-31`），配失效检查（表里每份文档都必须真实存在）。

> 顺带一个可核对的旁证：`WEBGPU_OPENSOURCE_LANDSCAPE.md` 开头那段"本轮环境限制"（无公网、只能 web_search）
> 在这个仓库里是**标明条件**的范本；本文同样标了（见 §〇）。这种"先声明证据强度"的习惯，比结论本身更能防止后续误用。

---

## 三、编辑器架构

### 3.1 `InteractionScope`：把"用户在干什么"收敛成一个判别联合 ✅

**问题陈述（他们自己写的，逐字可读）** —— `packages/editor/src/lib/interaction/scope.ts:1-11`：

> 在这之前，"用户现在在干什么"是靠 **7 个以上独立的 `useEditor` 布尔量**（`mode`、`tool`、`movingNode`、
> `placementDragMode`、`activeHandleDrag`、`curvingWall`、`curvingFence`、`editingHole`、`movingWallEndpoint`…）
> 重新推导出来的。每个 overlay 与拾取点从**不同的子集**推导，于是这些布尔量可以漂移成**非法组合**
> （同时在移动和弯曲；拖拽结束后残留的 `movingNode`）。把它们收进一个判别联合，让这些组合**不可表达**。

联合定义在 `scope.ts:32-119`，`kind` 共 11 种：`idle` / `placing` / `moving` / `handle-drag` / `mesh-editing` /
`drafting` / `reshaping` / `box-select` / `painting` / `sculpting` / `room-divide`。
`ActiveInteractionScope = Exclude<InteractionScope, { kind: 'idle' }>`（`:117`），`idle` 不携带任何载荷。

**四个 store 方法就是全部契约**（`store/use-interaction-scope.ts:62-73`）：

| 方法 | 语义 |
| --- | --- |
| `begin(scope)` | 进入交互。已有活动 scope 时**原子替换**它（单一所有者，没有生产者竞争） |
| `update(patch)` | 只改载荷。**idle 时忽略；`kind` 与当前不同则忽略**——载荷更新不得改变"在做什么" |
| `end()` | 原子回到 idle。提交与取消**都**调它；"写还是回滚"的判断住在交互体里，不在这里 |
| `endIf(match)` | 仅当匹配时回 idle。存在的理由：scope 目前由**旧的散落 flag 清理动作被动驱动**，清一个 flag（如围栏曲线）不能踩掉无关的活动 scope（如墙体移动） |

三条我认为可以直接照搬的设计细节：

1. **`update` 不能改 `kind`。** 这条把"切换交互"与"更新交互"分成了两个不可混淆的动作，消掉了最常见的状态机 bug。
2. **`end()` 是原子且无载荷的。** `:192` 一行写回 `{ scope: IDLE_SCOPE, gesture: null, ownedSubtree: null, pendingSubtree: null }`，
   于是"过期的 `nodeId` 泄漏到 idle 之后"不可表达。
3. **`ownedSubtree`（`:45-59`）**：一次手势创建并**收养**的子树（`noteSubtreeCreation` → `adoptSubtree` → `finishSubtree`）。
   解决的是"创建即拖动"的手势里，新建节点还没进 store、无法按 id 找回的问题；`placing` scope 干脆**把草稿节点内联携带**
   （`scope.ts:52-56` 注释："在 `begin` 时设置一次，之后不再 mutate，所以它是手势的稳定引用"）。

**纯推导的附属物**（这是"收敛"真正的红利）：

- `lib/interaction/hot-set.ts`（69 行）：**"这次交互哪些物体可以被射线命中"不是逐交互手写的**，而是从节点的
  `asset.attachTo`（`wall` / `ceiling` / `surface`）加上"候选是否暴露顶面"**推**出来的。`idle → true`（交给选择管理器），
  `placing`/`moving` → 按附着类过滤，**其余活动 scope → `false`**（交互体自己的射线独占指针）。
- `lib/interaction/overlay-policy.ts`（75 行）：一个二元矩阵（`IDLE_POLICY` / `ACTIVE_POLICY`）决定
  区域标签、上下文徽章、冲突控件、场景可拾取性、活动 affordance、HUD 各自在活动交互期间如何退让。
- `lib/snapping-mode.ts`：吸附是**每上下文可见的模式**（墙面/物品/多边形三套 profile），Shift **轻按**循环模式、
  Alt **按住**强制自由——**明确禁止 `event.shiftKey` 当吸附旁路**（`DECISIONS.md:44` E-004，理由是"隐藏的按住键不可发现、也没法移植到 2D"）。

> **对你的直接映射**：你在 `paneInput.ts` 里已经做了一件同类的事——"手势一旦在某格按下就绑定那一格"，
> 以及 `isPointerClaimed` 复查打破监听器注册顺序依赖。但你现在是**分散在多个模块里的规则**：
> `pickSuppressedRef`（gizmo 拖动期间不选中）、`PaneGizmoHandle.dragging()`、
> `__PC_WALK__` 漫游 tick 每帧改写相机、G/R/S 的四道闸门（`transformKeys.ts`）。
> 这**正是** Pascal 描述的"7 个布尔量漂移成非法组合"的同型结构——你们已经踩到过它
> （`AGENTS.md` §四之二 记录的两个真 bug：漫游 tick 无条件请求指针锁定导致"其它交互全部静默失效、且时有时无"；
> 线框/贴图两个 effect 的 cleanup 顺序互相剥离）。
>
> **建议**：不要整体重写成联合（你的窗格/渲染层已经在动），只做**一条垂直切片**——
> 把"当前指针手势归属"（`idle | orbiting | panning | gizmo-drag | walk | …`）收敛成一个小联合，
> 作为**唯一写入点**，其余模块（`paneInput`、`paneGizmo`、`transformKeys`、`walkRig`）只读。
> 判据可直接照抄他们的：非法组合不可表达 + `end` 原子无载荷 + `update` 不改 kind。

### 3.2 `createDragSession`：纯编排器 + 历史暂停括号 ✅

`packages/core/src/services/drag-session.ts:10-20` 的自我描述：

> `begin → (preview → snap? → apply → cascade dirty)* → commit | cancel` 的纯编排器。
> 用 `pauseHistory()` / `resumeHistory()` 包起来，**于是整个拖动是一个撤销步**。
> React hook（`@pascal-app/editor` 的 `useDragAction`）只是给它套事件订阅；**测试直接驱动它**。

接口（`:32-48`）：`start / move / commit / cancel / getDraft / isActive / dispose`。
注意 `dispose()` 的语义被**刻意**写成"幂等清理，若活动则还原场景并恢复历史，但**不**触发 `onCancel`"，
理由是"用于 React effect 拆除——`onCancel` 会重新触发父状态机、破坏 StrictMode 的双挂载周期"（`:42-47`）。

**"一次手势一步撤销"的具体实现**是这个"舞蹈"（`core/src/services/single-undo-dance.test.ts:20-33` 逐字）：

```
action.commit:
  scene.restoreAll()       // 用快照回滚（paused → zundo 不记录）
  scene.resumeHistory()    // 恢复 zundo
  scene.update(...)        // 重放最终态 → zundo 只记录一条 diff
  return true
```

他们在 `drag-session.ts:118-150` 里也直接调 `scene.restoreAll()` 做取消回滚。

**撤销/重做的上层**（`packages/editor/src/lib/history.ts`，178 行）值得单独看三点：

1. **快照式（zundo `pastStates`/`futureStates`）+ 可插拔 delegate**。`getHistoryCommandState()` 无 delegate 时读本地 temporal，
   有 delegate 时交给协作实现（`:52-61`）；`installHistoryCommandDelegate` 返回卸载函数（`:38-50`）。
   于是"单机 / 协作"两种模式共用同一套命令入口。**你未来做协同的话，这是一个现成的接缝形状。**
2. **撤销跳转只重算真正变脏的节点**（`:87-126`）：先把 live override 合并成"有效布局"，
   与目标做 `getHistoryDirtyNodeIds` 差集，再 `markDirty`。不是整场刷新。
   `systems.md:213-215` 明说"**不存在例行整场历史刷新或批次重置**"。
3. **拖拽期间 ⌘Z 的语义是"中止我鼠标正在做的事"**，不是历史跳转（`history.ts:171-178`：指针拖拽会话在**捕获阶段**拦截它）。

### 3.3 `scene-visibility`：记"理由"，不记"掩码" ✅

这是我在这份代码里最想直接搬走的一个小文件（89 行）。

`packages/viewer/src/lib/scene-visibility.ts:5-23` 的注释把问题和解法都写清了：

> 多个特性都会通过清掉 `SCENE_LAYER` 来隐藏物体：隔离、solo 的阴影投射、墙体合批。它们**自由重叠**
> ——一堵墙可以先被缝进批次，再被 solo，再被隔离。**当每个特性各自暂存并恢复掩码时，后完成的那个会把先完成的期间改动过的掩码写回去。**

解法是 `Hold = { original: number; reasons: Set<HiddenReason> }`：**掩码只在第一个理由到来时快照一次，
在最后一个理由离开时整体归还**；中间只维护 `reasons` 集合。`hideFromScene(obj, reason)` / `showInScene(obj, reason)` 按理由幂等。
`HiddenReason` 是 `'isolated' | 'shadow-only' | 'batched' | 'wall-batched'`。

**为什么这条对你特别对味**：`AGENTS.md` §四之二 里你自己记录了两次同型事故——
"`PaneRegistry.sync()` 每次都重写 `camera.layers`，gizmo 构造时 concat 进去的层下一次同步就被抹掉"，
以及"相机 layers 只能有一个写入点"。Pascal 的方案是这套"多写入者 → 单一所有者 + 理由集合"的标准形。
**把它套到 `camera.layers` 上，比"约定只有一个写入点"这种口头纪律可靠得多**——口头纪律正是你文档里反复强调"注释里的约束没人接线就等于没有"的那种东西。

### 3.4 `NodeDefinition` 三复选框与 capability 动词 ✅

`wiki/architecture/node-definitions.md:11-41`：一个 kind 由 `NodeDefinition` 描述，**三个字段互相独立，
没有判别标签——存在即参与**：

| 字段 | 用途 | 什么时候选 |
| --- | --- | --- |
| `geometry?` | 纯构建器，返回 Object3D | 有参数化网格、`updateNode` 时要重建 |
| `renderer?` | 自定义 React 组件，自己拥有网格创建 | 需要 JSX-only 能力：`<Html>`、`useGLTF`、drei、实例化、TSL 材质 |
| `system?` | 每帧组件，`useFrame` 返回 null | 需要命令式逐帧工作：动画、透明度过渡、按名找网格改材质、跨 kind 的脏级联 |

运行时只有两个框架组件：`<NodeRenderer>` 选挂谁，`<GeometrySystem>` 消费 `dirtyNodes` 做重建
（`node-definitions.md:45-54`）。**框架里没有 `case '<kind>'`**，这条由 `DECISIONS.md:40` E-002 与注册闸门测试守住。

两个细节值得单独拎出来：

- **`GeometryContext`（`:79-98`）让构建器保持纯函数**：`{ resolve, children, siblings, parent }`。
  墙用 `siblings` 做转角斜接，门窗用 `parent` 拿宿主墙厚度，其余 kind 根本不用第二个参数。
  注释点明了动机："构建器保持纯净（不 import `useScene`、不改 store），于是可以平凡地单测"。
- **`dirtyTracking: false` + `GuardedDirtySet`（`:75-77`）**：结构性 kind（site/building/level/zone/guide）不做脏跟踪，
  而且**守卫在 `add()` 里**——`markDirty` 与直接 `dirtyNodes.add(...)` 都被覆盖，于是"盲目标记 `node.parentId`"是安全的。
  理由写得很实在："一个没有消费者的标记会赖在整个会话里，破坏每个消费者每帧的空集早退，还污染性能面板。"**这个失败模式你一定见过。**

**对你要诚实**：整体搬这套注册表模型成本很高，而你的规模（模型资产 + splat + 摆放）未必需要。
但 **"capability 用动词命名"**（`movable` / `paint` / `floorPlaced` / `cuts` / `selectable` / `batchable` / `mechanism`，
见 `core/src/registry/types.ts:1664-1760`）这一条**可以单独抄**：
你现在的 kind 判断散在各处（是不是可拾取、是不是可挂载、是不是参与线框），
把它们收敛成一组**动词能力 + 一张查表**，比 `if (kind === 'x' || kind === 'y')` 稳。

### 3.5 系统分层与帧优先级 ✅

`wiki/architecture/systems.md:11-42` 把 system 分成两处，**并且用依赖箭头强制**：

- `core/src/systems/` —— 纯数据，**没有 three、没有 `useFrame`**（墙的斜接/拓扑/顶面，板的支撑，楼梯的踏步，屋顶的跟随）。
- `viewer/src/systems/` —— 对 `sceneRegistry` 里已注册对象的 three 副作用（`GeometrySystem`、`FloorElevationSystem`、各 kind 的几何生成器）。
- **editor/集成特有的** → 留在消费方，**作为 `<Viewer>` 的 children 注入**（`:140, 223-229`）。

**帧优先级纪律（`:44-52`）**读起来像你已经写过的 `RenderSchedule` 三层 priority，但它的措辞更狠：

> 天花几何在**帧优先级 2** 消费脏标记，与 `GeometrySystem`（板）相同。节点批次在**优先级 1** 快照标记、
> 在**优先级 5** 处理成员关系，于是它在重建之后释放旧几何、收集替代品。**在优先级 2 之前没有任何消费者清标记。**

并且明确区分"组件 `def.system.priority` 的排序"与"`useFrame` 优先级"**不是一回事**——这是很容易混的一对概念。

**"初始构建特权"**（`:88-100`）也是一个漂亮的工程手法：初始建墙时 `WallSystem` 在 **8 ms 帧预算**内排空脏墙、
不施加交互期的"每帧 8 堵墙"上限；但**若连续 30 帧没有任何墙重建而脏墙仍无网格，特权被撤销**，标记保留给后续挂载重建。
——**"给冷启动开特权，但给特权一个自动失效条件"**，这比单纯的预算或单纯的上限都好用。

### 3.6 2D ↔ 3D 对等与吸附（E-006 / E-004）✅

`DECISIONS.md:48`：**"同时适用于两个视图的行为，必须在两个视图里都存在，在同一个 PR 里移植，或者说明它为什么不适用。"**
理由是一句话："平面图和 3D 视图是**同一次编辑的两种呈现**。"

`tools.md:129-153`「2D ↔ 3D behavioral parity (default expectation)」把它落到工具层，并且**把坑也写了进去**：
"2D cleanup 覆盖 3D commit"、"`useDraftNode.destroy()` 覆盖 2D commit"、
"pointermove 是全局触发的，要把 3D 画布事件视为越界"。

吸附的模型见 §3.1 末尾（Shift 轻按循环、Alt 按住强制、chip 是 scope 的、绝不读 `event.shiftKey`）。
**你现在没有 2D 视图**，所以 E-006 本身不适用；但**"同一编辑的两种呈现"这个提法**
对你正在做的 PlayCanvas 分流（`?pcViewport=1`）是同一件事：
three 视口与 PC 视口是**同一份场景的两种呈现**，行为差异必须显式记录。
你的 `AGENTS.md` 已经在做这件事（"这是与 three 侧的**有意**差异"、"两版 `aria-label` 顺序与按钮盒子逐项一致"），
**只是还没有一条不变量把"发现差异就必须记录"变成硬约束**。建议补一条 E 级或 A 级条目。

---

## 四、WebGPU 相关代码

> 这一节是本文最"能直接抄"的部分。Pascal 的 WebGPU 用法**与你的高度同构**（three 0.186 + `three/webgpu` + TSL + 后处理 + 时间戳），
> 而且它踩过的坑你**大概率迟早踩到**。
>
> 先记住一个结构性差异：**Pascal 是单画布单相机。它没有 `ArrayCamera`、没有多窗格、没有 `WebGPUView`/`paneViewports` 那一层。**
> 所以在多视口这件事上，你是超集。

### 先对齐坐标系：你们各在 three 的哪一层（**这一节防一个常见误判**）

**Pascal 和 ChatSpace 都用 three 的 WebGPU。谁都不是"原生 WebGPU"。**

| 层次 | 是什么 | 谁在 |
| --- | --- | --- |
| ① 门面 | `new WebGPURenderer()` | **Pascal**（`index.tsx:660`） |
| ② three 的底座 | `Renderer` + `new WebGPUBackend()` + `new StandardNodeLibrary()`，自己管设备与帧调度 | **ChatSpace**（`app/src/shared/rendering/webgpu.ts:5-67`） |
| ③ 原生 WebGPU | 自己写 WGSL + `device.createRenderPipeline` + bind group + command encoder | **谁都不在**（最近的是 `gaussian-splat-lite`，但它也是用 TSL 的 `.computeKernel([...])`，由 three 编译成 WGSL） |

**关键事实（本机 three 0.186.1 源码核实）：`class WebGPURenderer extends Renderer` 的类体只有 78 行，且只定义了一个 `constructor`——没有任何其他成员。**

```js
// three.webgpu.js:90410
class WebGPURenderer extends Renderer {
  constructor( parameters = {} ) {
    let BackendClass;
    if ( parameters.forceWebGL ) { BackendClass = WebGLBackend; }
    else {
      BackendClass = WebGPUBackend;
      parameters.getFallback = () => { warn(…); return new WebGLBackend( parameters ); };  // ← 唯一的实质差别
    }
    super( new BackendClass( parameters ), parameters );
    this.library = new StandardNodeLibrary();
  }
}
```

而 ChatSpace 的 `NativeWebGPURenderer` 干的是**同样三件事**，只是省掉了 `getFallback`。

**推论（决定了"该抄什么"）**：
`RenderPipeline` 与 `PassNode` 只使用标准 `Renderer` 成员 ——
`render` / `setRenderTarget` / `getRenderTarget` / `autoClear*` / `getDrawingBufferSize` / `samples` /
`toneMapping` / `outputColorSpace` / `init` / `compileAsync` / `reversedDepthBuffer` / `getMRT` / `setMRT` / `xr`
（源码核实，无一属于 `WebGPURenderer`）。
**所以换到 `new WebGPURenderer()` 只会买到一样东西：WebGL 回退——而那正是 ChatSpace 硬约束 1 禁止的。**

Pascal 用到的 TSL、`RenderPipeline`、`mrt()`、FXAA/SSGI、自建 `PassNode`，**在 `NativeWebGPURenderer` 上今天就能用**。
真正的差别不在渲染器类，而在**两条管线选择**：

| | Pascal | ChatSpace |
| --- | --- | --- |
| 后处理 | 用 three 的 `RenderPipeline` 并**在它内部**扩展（自建 `PassNode`、fork `OutlineNode`）；TSL 27 个文件 | **完全不用** `RenderPipeline`/`PostProcessing`/`pass()`；自建 `RenderSchedule`（三层 priority）+ `ArrayCamera` 逐子相机 `setViewport`/`setScissor` + layer 过滤；TSL 1 个文件（`WebGPUGrid.tsx`） |
| 多视口 | 无 | 一趟 pass 里做完 |
| WebGL 回退 | 有（`getFallback`，一整条第二代码路径） | 无 |
| compute / WGSL（自写） | 0 / 0 | 0 / 0 |

**所以"要不要用 three 的 `RenderPipeline`"是一个独立的架构决定，和"用哪个渲染器类"无关**；
而它的代价是要先回答"`pass(scene, ArrayCamera)` + 逐子相机 viewport/layer 能不能表达现在的 1/2/4 窗格"（**未核实**）。

### 总评：他们的 WebGPU 处在什么水平

一句话：**它是 three.js WebGPU 的「深度使用者」，不是 WebGPU 的「原生开发者」。** 三个维度要分开评，混起来会得出错的结论。

**（1）用了没有：用了，而且是最深的那一层 —— three 的 node / RenderPipeline 表面。**

| 表面 | 他们用了吗 | 证据 |
| --- | --- | --- |
| `three/webgpu` 入口 | ✅ 81 个文件 | 渲染器、node 材质、`RenderPipeline`、`RenderTarget`、`TimestampQuery` |
| `three/tsl` 着色器编排 | ✅ 27 个文件 | 后处理合成、天空/雾/大气、墨线、材质、工具预览盒 |
| 核心 `three`（场景图/数学/Layers） | ✅ 680 个文件 | 常规分工。**已核实这样混用是安全的**：`three.webgpu.js` 第 6 行 `import { … Vector3 … } from './three.core.js'`，即 `three` / `three/webgpu` / `three/tsl` 共用同一份 `three.core.js`，**没有重复类副本**（`three.tsl.js` 也只是 `import { TSL } from 'three/webgpu'`） |
| **自建 PassNode 插进 three 的 RenderPipeline** | ✅ `lib/layer-pass.ts`（253 行） | `class LayerPassIndex` + `LayerPassNode extends PassNode`，把 layer 单独渲一趟再手动合成 |
| **fork three 的 display node** | ✅ `lib/merged-outline-node.ts`（797 行，`@ts-nocheck`） | 用到 `TempNode` / `QuadMesh` / `NodeUpdateType` / `RendererUtils` / `SpriteNodeMaterial`，是 `OutlineNode` 的改写 |
| **MRT + 逐 attachment 语义** | ✅ `scenePass.setMRT(mrt({ output, diffuseColor, normal }))` | 且用 attachment 0 的 alpha 当几何掩码（见 §4.4） |
| **时间戳查询** | ✅ `TimestampQuery.RENDER` | 只读 render 池，见 §4.7 |
| **打后端内部的主意** | ✅ 三处 | `renderer.setRenderObjectFunction`、覆写 `backend.draw`、patch `TextureNode.prototype.update` |

**（2）没用的是什么 —— 这一栏对你更重要。**

```
自写 compute / WGSL / storage buffer / instancedArray / indirect draw：0
（全仓 `wgslFn` / `instancedArray` / `storage(` / `computeNode` / `dispatchWorkgroups` 命中为 0；
 `three/tsl` 的 import 清单里只有 1 处 `Fn`，其余全是 fragment 合成用的算子）
```

所以**没有任何 GPU 驱动的剔除、没有 GPU 侧排序、没有 compute 粒子/splat 排序**。
合批是 **CPU 侧几何合并**（`wall-batch.ts`，按材质索引切成 run）+ 一个 **`BatchedMesh` spike**（§4.9）。
→ **在 compute 这条轴上，你领先它**（你的 GSL unified 路径是每帧每相机的 GPU compute radix sort，无 CPU 回读）。

**（3）工程成熟度：这是它最强的地方，也是真正值得学的。**

它把"WebGPU 会静默失败"当成前提来写代码：零顶点 draw 毒化整个 encoder（§4.2）、空纹理抛错杀死整个 pass（§4.3）、
设备所有权与并发设备上限（§4.1）、R3F 异步 `gl` 工厂竞态（§4.1）、
`resolveTimestampsAsync` 与 `onSubmittedWorkDone` 的语义区分（§4.7）、
**一个专为截图而建的第二条管线**（§4.12）。这些**没有一条是"WebGPU 流畅"的痕迹，全是"WebGPU 难"的痕迹**——
而它们恰好是你最该抄的部分，因为你的栈和它同源。

**（4）诚实的短板。**

| 短板 | 证据 |
| --- | --- |
| **实时视口完全没有抗锯齿** | three r186 的 `WebGPURenderer` 默认 `antialias = false`（`three.webgpu.js:61775`，`this._samples = samples \|\| ( antialias === true ? 4 : 0 )` 在 `:61949`），而 Pascal **从不传 `antialias`**，也没设 `samples`；`dpr` 上限 1.5（粗指针设备 1.25）。**没有 MSAA、没有 SSAA、没有 TAA** |
| **README 声称有 TRAA，代码里没有** | `packages/viewer/README.md:21` 写 "TRAA (anti-aliasing)"；全仓 `traa` 只出现在那里与 `wiki/architecture/layers.md:32` 的顺带提及，`post-processing.tsx` 里无实现。FXAA **只存在于截图管线**（§4.12） |
| **WebXR 沉浸模式放弃 WebGPU，退回 WebGL** | `components/viewer/index.tsx:655` `forceWebGL: immersiveActive` —— 一进沉浸式 XR 就切 WebGL |
| **真实 GPU 验证设施很薄** | 全仓只有 **1** 个 `*.browser.*` 台架（`packages/viewer/tests/outline-depth.browser.ts`）。对比你有 `probe:gpu`、`gpuProbe.browser.ts`、`capture.browser.ts`、`materials.browser.ts`、`workflows.browser.tsx`、`splatLifecycle.browser.tsx` 等一整套 |
| **没有 WebGPU 能力探测的下钻** | 只 `requestAdapter({ featureLevel: 'compatibility' })` + 把 adapter 的 feature 全量当 `requiredFeatures` 要一遍（`renderer-capability.ts:73-80`），**没有按 feature 分档降级**；也没有 occlusion query、没有 `renderer.inspector` |
| **对 three 内部 API 的依赖很脆** | fork 了 `OutlineNode`、patch 了 `TextureNode.prototype`、覆写了 `backend.draw`——three 每次升级都要重新验证；他们**没有 `patches/README.md`**（这一点你的纪律比它严） |

**（5）一个可核对的对照**：他们的 `antialias` 是**默认值恰好等于你的硬约束**（false），你是**测出来的**（§5.19 交替设计：MSAA ON 的 `gpuUtilization` 是 OFF 的 1.4–1.6×）。
**同一个决定，一个靠测量、一个靠默认。** 这一栏你领先，别被"他们也没开"当成支持自己结论的证据。

### 4.1 渲染器引导：自己 `requestDevice`，把所有权拿在手里 ✅

他们**不用** `new WebGPURenderer()` 让 three 自己请求适配器，而是自己走一遍并把 `device` 传进去。
`packages/viewer/src/lib/renderer-capability.ts`：

```ts
const adapter = await gpu.requestAdapter({
  featureLevel: 'compatibility',                       // :73-76
  ...(powerPreference ? { powerPreference } : {}),
})
if (!adapter) return null
const requiredFeatures = adapter.features ? Array.from(adapter.features) : undefined
return adapter.requestDevice(requiredFeatures?.length ? { requiredFeatures } : undefined)
```

四个值得抄的点：

1. **`featureLevel: 'compatibility'`**（`:74`）。你在 `WEBGPU_FINDINGS.md` 里做的 adapter feature 对照，
   缺的就是这个维度——兼容级适配器要求的 feature 集更小，移动端/集显更可能成功。
2. **初始化加超时，并且超时后还要回收设备**（`:61-70` 的 `withTimeout`，`:36` 的 `WEBGPU_INITIALIZATION_TIMEOUT_MS = 4000`）：

   ```ts
   } catch (error) {
     capabilityError = error
     // 输掉竞态意味着设备仍可能在放弃之后到达，所以要回收它。
     // 只在这条路径上挂 handler，保证"我们返回出去的设备"的所有权无歧义。
     pending.then(releaseDevice).catch(() => {})
   }
   ```
   `releaseDevice` 的注释（`:48-54`）说明了为什么必须显式 `destroy()`：
   **"因为设备是我们自己交给 `WebGPURenderer` 的，three 视其为调用方所有、永不销毁；而 `init()` 失败时
   `Renderer.dispose()` 是 no-op。任何请求了又放弃的设备都必须在这里释放，否则它会在此后整个页面生命周期里
   占着浏览器的并发设备上限。"**
   ——这是**真机才会遇到**的 bug（反复重试 → 设备耗尽 → 再也起不来），单测测不出来。
3. **失败后 `dispose()` 必须先 `await` 再释放设备**（`:156-160`）：注释点明 "r186 起 `dispose()` 变成异步"，
   而后面要在**同一块 canvas** 上启 WebGL 回退。
4. **返回"永不 settle"的 Promise 是刻意的**（`components/viewer/index.tsx:685-691`）：

   ```ts
   // 有意永不 settle。Reject 会造成 MONOREPO-EDITOR-59：R3F 在自己的 configure()
   // 里 await 它且没有 catch，rejection 会变成 unhandled rejection。
   // Resolve 更糟——R3F 会对着一个没有 context 的 renderer 调 render()。
   // 上面的 state 更新会卸载这个 Canvas，那才是释放挂起 configure() 的东西。
   return new Promise<never>(() => undefined)
   ```

   如果你曾在 R3F 里做过 async `gl` 工厂，这条是血泪。

**还有一处与你的 `ArrayCamera` 经验直接呼应**：`WEBGPU_RENDERER_CACHE`（`index.tsx:72-86`）。
R3F 的 `<Canvas>` 的 `useLayoutEffect` 没有依赖数组，任何重渲染（主题切换、父组件重渲染、StrictMode 双挂载）
都会重新调 `configure()`；用**同步** `gl` 工厂无害，用**异步**工厂则会**两个 configure 竞态**：

> 都看到 `state.gl == null`，都建 renderer。先 resolve 的那个被 `setSize`/`setDpr`；
> 第二个覆盖 `state.gl`，但 R3F 的 store 已经持有新的尺寸/dpr，于是**新 renderer 从未被 resize，停在画布 300×150 的默认值**。

解法是 **按 canvas 缓存 in-flight 的 Promise（不只是 resolved 的 renderer）**。
——这与你 `AGENTS.md` §四 「`ArrayCamera.cameras` 长度必须恒定 / uniform buffer 按当时相机数定容且不增长」
是同一类问题（**"尺寸/容量在建时定死、之后不跟随"**），值得作为一条通用警觉。

### 4.2 `installEmptyDrawGuard`：一个空顶点缓冲会毒化整个 command encoder ✅

`packages/viewer/src/components/viewer/index.tsx:103-188`。注释说明（`:103-118`）：

> 包住逐对象渲染函数，使任何 `position` 属性 count 为 0 的几何被**跳过而不是提交**。
> 一次这样的 draw 会让 WebGPU 的 **vertex buffer slot 0** 未绑定，validator 拒绝它，
> **而它会毒化整个 command encoder**——所以一个游离的空网格（例如临时占位物，或派生的边/轮廓几何）
> 会让**整块画布闪烁**，不只是它自己。

真机看到的报错形态（`:124-126` 逐字）：

```
Vertex buffer slot 1 required by [RenderPipeline "…MeshLambertNodeMaterial…"] was not set … Draw(0, …)
```

实现是**两道闸门**（他们说得很清楚为什么一道不够）：

1. `renderer.setRenderObjectFunction(...)`（`:153-187`）—— three 文档化的 render-object 钩子，
   但它只覆盖一条漏斗；后处理 pass 与 outline node 走**别的路径**；
2. **后端自己的 `backend.draw`**（`:127-152`）—— "command encoder 之前的最后一道闸门"，
   因为"draw range 为空的几何仍能通过 position count 的检查"。

**对你的价值**：你的 `AGENTS.md` 里"整块画布落到 `3D rendering needs WebGPU` 失败面板"
（由 `ArrayCamera` uniform 容量触发）是**同类故障的另一个实例**——**一个局部的资源错误会让整张画布失效**。
这条 guard 是通用的、便宜的，而且与你已经在做的"边界守卫"是同一族。**建议照搬**，
在你 4 窗格 + 截图私有 RT 的组合下它的收益只会更大。

### 4.3 `installTextureNodeNullGuard`：节点系统的空纹理抛错 ✅

`packages/viewer/src/lib/texture-node-guard.ts`（全 40 行左右，`:1-40`）。理由逐字：

> three 的节点系统每帧通过 reference node 从材质拉取纹理 uniform，而**若干 override-material pass
> （阴影、深度/法线 prepass）会把逐对象的纹理槽拷到共享材质上**，那些材质的缓存逐网格节点图
> 对"某个槽是否存在"可能不一致。一旦不一致，`TextureNode.update` 就解引用 null 纹理，
> **异常会杀掉整个 render pass——画面全黑。** 用 1×1 黑纹替身（**跳过不够**：null 仍会到达后端的
> texture-binding WeakMap）。该槽黑一帧，reference 拉回真值后立刻恢复。

实现是 patch `TextureNode.prototype.update`，并在首次与每 5 次时 `console.warn`。

**为什么你需要它**：你用的是**全场景共享的单例线框材质**（`wireframeMaterial.ts`，"绝不 dispose"），
以及 `useAssemblyMaterials` 里合成一处的贴图覆盖——**这正是"逐对象纹理槽拷到共享材质"的同一场景**。
真机症状会是"画面全黑、零报错"，也就是你最怕的那类。**装这个补丁的成本是几十行，收益是消掉一个静默全黑类。**

### 4.4 后处理管线：layer pass 组合、alpha 当几何掩码、MRT ✅

`packages/viewer/src/components/viewer/post-processing.tsx`（837 行）是他们的渲染主干。骨架：

```ts
const layerIndex = new LayerPassIndex(scene, [ZONE_LAYER, OVERLAY_LAYER])   // :433
const scenePass  = pass(scene, camera)                                      // :435
scenePass.setLayers(sceneOnlyLayers)          // SCENE_LAYER | GRID_LAYER    // :437
const zonePass    = new LayerPassNode(layerIndex, camera, ZONE_LAYER,    scenePass)  // :438
const overlayPass = new LayerPassNode(layerIndex, camera, OVERLAY_LAYER, scenePass)  // :444
const overlayColor   = overlayPass.getTextureNode('output')
const scenePassColor = scenePass.getTextureNode('output')
```

三个关键设计：

**(a) 用 MRT 的 alpha 当"几何存在"掩码**（`:451-459`）：

```ts
// Background detection via alpha: renderer clears with alpha=0, so background pixels have
// scenePassColor.a=0 while geometry pixels have output.a=1.
// WebGPU only applies clearColorValue to MRT attachment 0 (output), so scenePassColor.a
// is the reliable geometry mask — no normals, no flicker.
const hasGeometry = scenePassColor.a
const contentAlpha = hasGeometry.max(zonePass.a)
```

**这条是一条纯 WebGPU 语义事实**（clearColorValue 只作用于 MRT 的 attachment 0），
而且它把"背景"这件事变成了**零额外成本的免费掩码**。你后面做透明背景截图或天空盒替换时会用到。

**(b) MRT 只在实际需要时构建**（`:469-482`）：`needsNormalMRT = ssgiEnabled || inkEnabled`。
不需要就不 `setMRT` —— 省掉 normal buffer 的带宽与一次编码。并且**法线用 `UnsignedByteType` 打包**（`:480-482`），
配合 `lib/tsl-compat.ts` 的 `packNormalToRGB` / `unpackRGBToNormal` 做编解码。

**(c) `LayerPassNode`（`lib/layer-pass.ts`，253 行）是一个自定义 PassNode**，它要解决一个具体问题（`:1-3`）：

> 只有一个索引可以观察一个场景，而被观察对象必须拥有自己的 `Layers`。
> **没有 `childadded` 的插入不会被观察到：之后要调 `register(subtree)`。**
> 已知成员被替换的 `Layers` 会在 `prepare()` 期间被修复；其它对象需要 `register(object)`，
> 因为**发现它们需要整场扫描**。

它的做法是**观测 `layers.mask` 的写入与子节点事件**（`:23-30` 注释 —— "R3F 的数值 `layers` prop 调 `set()`，
命令式生产者还会用 `enable()` 和直接写 mask；**不 patch `Object3D`/`Layers.prototype` 上的任何东西，detach 时还原字段**"）。

**对你的价值**：你走的是另一条路（`RenderSchedule` 三层 priority + 判据 `hasDrawableContent` + `paneViewports` 里的
`ArrayCamera` 逐子相机 `setViewport` + layer 过滤）。**在"每帧 1 个 pass"这条线上你比它强**（`startRenderPass ≈ 1`/帧）。
但 `LayerPassIndex` 的两个思想值得取：

- **"掩码写入只有一次观察者，且替换 mask 要能修复"** —— 与 §3.3 的 `scene-visibility` 是同源纪律；
- **"不 patch 原型，detach 时还原"** —— 与你 `patches/` 的纪律一致（"改的是释放路径，不是渲染/投影/排序/画质"）。
  他们连在自己的观测器里都遵守了这条。

**(d) 管线重建与资源记账**（`lib/post-processing-resources.ts` 全文 21 行）：

```ts
// RenderPipeline.dispose() only releases its fullscreen material, so the owner
// must also release the passes and scene observers on failure and teardown.
export class PostProcessingResources {
  layerIndex; readonly passes: PassNode[] = []; outline; pipeline
  dispose() { /* 逐项 dispose 并置 null */ }
}
```

**"某个对象的 `dispose()` 只释放它的一部分"** 是你已经在 `patches/` 与 `attributeDisposal.test.ts` 里
处理过的同一类问题。他们为它建了一个**显式的 owner 类**并把有限清单写在注释里——比散落的 cleanup 可靠。

还有：**管线构建失败有 3 次重试 + 500 ms 延迟**（`MAX_PIPELINE_RETRIES = 3`、`RETRY_DELAY_MS = 500`，`:128-129`），
失败则落回直接 `renderer.render(scene, camera)`（`hasPipelineErrorRef`）。**降级而不是崩**，与你 §四 的资源阶梯降级同源。

### 4.5 `MergedOutlineNode`：一次处理选中 + 悬停两组轮廓 ✅

`packages/viewer/src/lib/merged-outline-node.ts`（797 行，`@ts-nocheck`，是 three `OutlineNode` 的 fork）。
文件头（`:4-14`）逐字说明了它比上游多做了什么：

> 处理**两组**对象（primary = 选中，secondary = 悬停），在给定场景深度时复用该深度，
> 否则用**小的私有场景**渲染掩码。没有场景深度的调用方为两组共享**同一个**非选中深度 pass。
> 额外的提前退出：两组都空 → 全部跳过（0 个 pass）；只有 primary → 跳过 secondary 的掩码/边缘/模糊；只有 secondary → 反之。

它内部为**每组**分配 7 张 RT（`makeGroupTargets`，`:71-117`：maskBuffer / maskDownSample / edge×2 / blur×2 / composite），
按降采样比与半分辨率逐级缩放，并带 `dispose()`。
一处细节注释（`:72-74`）：**"保留原本的像素中心掩码覆盖。MSAA 解析后的掩码会把可见/背景采样混进隐藏边缘，这发生在边缘检测之前。"**

**对你的价值**：你的选中线框走的是另一条路（引擎的持久 line 网格 + `PRIMITIVE_LINES`，见你 `AGENTS.md` §四之二），
它在 PC 侧**已经真机验证**（亮像素 28 452 → 13 010 并可复原）。所以**不要换实现**。
可借的是那个**结构性结论**：**"选中"和"悬停"是同一个视觉通道的两种强度，应该在一次 pass 里一起算，
并对"只有一组"的情况显式提前退出**。你的 `selectionWireframe.ts` 与 hover 高亮如果现在是两条路径，
合并成"一组几何 + 两个强度"能省掉一趟。

### 4.6 `?disable=…` 剖面开关：比交替设计更便宜的逐 pass 归因 ✅

`post-processing.tsx:69-123`。URL 形如 `?disable=ao,denoise,outline,postFx`，注释把每个开关的语义写死：

| 开关 | 效果 |
| --- | --- |
| `ao` | 完全跳过 SSGI（以及 denoise，因为没东西可降噪） |
| `denoise` | 保留 SSGI，但把原始噪点 AO 直接喂给合成 |
| `outline` | 跳过 merged-outline node 及其 **14 张内部 RT** |
| `postFx` | 绕过整个 `RenderPipeline`，直接 `renderer.render(scene, camera)`——把原始场景渲染成本与任何 post-FX 开销分开 |
| `draw` | **完全不提交 draw**（帧仍在 tick：`useFrame` 系统、scene-ready），给只需要构建场景图、不需要像素的消费者 |

`draw` 的动机逐字（`:80-84`）：

> 给只需要构建好的场景图、永远不要像素的消费者：**headless bake worker 在 SwiftShader（CPU）上渲染，
> 那里逐帧的顶点/draw 成本支配整个捕获。**

**为什么这条对你值钱**：你的 `AGENTS.md` §五 规则 11 说"以帧间隔为因变量的改动必须用**交替设计 + 多轮重复**"，
规则 10 说"测量必须独占机器"。这两条都很贵（你实测过一次 `bun run check` 在过载机器上耗 2909 s）。
**开关注入法把"改代码—重跑—比较"变成"改 URL—重载—比较"，而且能一次隔离 5 个变量**，
尤其适合你现在那个**根因未定位的"≥3 个全分辨率 splat 视图塌缩"**问题：
先切 `postFx` 与 `draw`，就能立刻回答"是后处理开销还是逐帧 draw 提交"。
（注意：`outline` 那项在他们那里是 14 张 RT，你如果用，量级会不同。）

另外 `frame-limiter.tsx:48-60` 记录了配套的**真机发现**：

> `?disable=draw` 时页面不渲染真实帧，Chromium 的 no-damage 调度器随后**在 Linux 上把 `requestAnimationFrame` 节流到 1 Hz**
> （在 headless bake worker 里实测——每个 `useFrame` 系统一秒才 tick 一次，重场景要 300+ 秒才 settle）。
> **可见页面上普通定时器不会被节流**，所以什么都不画时改用 `setInterval` 驱动循环。

**这条你几乎一定会用上**——你有 4 视角检查图、缩略图、合成对照，任何"不画像素但要让帧前进"的场景都在这个坑里。

### 4.7 GPU 计时：`gpu-render` vs `gpu-queue`，以及一处需要你复核的矛盾 ✅⚠️

`post-processing.tsx:168-196` 的注释与实现：

```ts
// 每帧两个互相独立的 GPU 读数，都是 `?perf`-only：
//  - `gpu-render`: three 的 WebGPU 时间戳查询 —— 本帧 render pass 的 GPU 时长之和，
//    在设备上测。**唯一诚实的 "GPU ms"。**
//  - `gpu-queue`: submit → `onSubmittedWorkDone()` 的墙钟时间。它覆盖队列积压与
//    微任务恢复前跑掉的 CPU 工作，所以它是**背压信号，不是 GPU 时间。**
// `resolveTimestampsAsync` 在一次 resolve 在途时返回上一次 resolve 的值，
// 所以每帧调用它是安全的（而且是必须的——查询池填满时会警告一次）。
```

**这与你的 `AGENTS.md` §五 规则 5 是同一句话**（"不得把 `renderer.render()` 的 CPU 耗时当成 GPU 耗时"）。
区别在于他们把它**写进了指标名**（`gpu-render` / `gpu-queue`）而不是只写在文档里。
**把纪律编码进命名，比写进文档更难违反**——这条我认为是你文档体系可以吸收的一个小技巧。

**⚠️ 但这里有一处和你的实测直接冲突，值得你复核**：你在
`WEBGPU_PROBE_PROTOCOL.md` §5.15 实测到：

> 100% 的 `mapAsync` 都来自探针自己的 `WebGPUTimestampQueryPool._resolveQueries`；
> **每次回读等 211 ms（1 视图）/ 518 ms（4 视图），一趟 10 s 里合计 ≈8.7 s / 7.8 s**。
> 后果：**探针采样率上限约 5 Hz，每次 resolve 覆盖 2–9 个应用帧**——用 `resolveTimestampsAsync` 做不到按应用帧对齐。

而 Pascal **每帧都调** `resolveTimestampsAsync(TimestampQuery.RENDER)`（50 fps → 20 ms 间隔），
并认为"返回上一次的值所以安全"。两种可能：

1. 你的 211/518 ms 是**该 promise 从发起到 settle 的墙钟**，而它**不阻塞**渲染提交（Pascal 从不 `await` 它就继续）；
   那么两者不矛盾，"每帧调、读陈旧值"是一个**可接受的近似**，代价是读数滞后若干帧。
2. 或者它确实在队列上串行化，那 Pascal 就在为性能面板付一笔大钱（而 `PERF_OVERLAY_ENABLED` 默认关闭，所以他们**大概率从未在开启状态下做过性能结论**）。

**建议**：在可见窗口做一次小实验——`trackTimestamp` 开启、每帧调 resolve、记录 resolve 往返时间与
`presents`/`submits` 的变化。**这能同时回答两个问题**：你的 5 Hz 上限是探针的实现问题还是 three 的固有边界；
以及"能不能像 Pascal 那样把 GPU 时间戳做成常开"。判据要写进 `WEBGPU_PROBE_PROTOCOL.md`。
（另：Pascal 只读 `TimestampQuery.RENDER`，你读 render + compute **两个池**，这是你比它贵的一个明确原因。）

### 4.8 three 的补丁：他们打的和你打的是同一处 ✅

`patches/three@0.186.0.patch`（`package.json:64-66` 的 `patchedDependencies`，overrides `three: 0.186.0`、
`@types/three: 0.184.1`）。两处：

**(1) `cameraPositions` uniform array 的 `onRenderUpdate` 签名**：

```diff
- _cameraPositionArray = uniformArray( positions ).setGroup( renderGroup ).setName( 'cameraPositions' ).onRenderUpdate( ( { camera }, self ) => {
+ _cameraPositionArray = uniformArray( positions ).setGroup( renderGroup ).setName( 'cameraPositions' ).onRenderUpdate( ( frame, self ) => {
+   if ( frame === undefined ) return;
+   const { camera } = frame;
    const subCameras = camera.cameras;
    const array = self.array;
```

**这正是你在 `ArrayCamera` 上做过的战场**（`AGENTS.md` §四："three 按当时的相机数给 `cameraProjectionMatrices` 分配 uniform buffer，
之后按名字共享且不会增长；2 窗格建 `size(128)`，切 4 窗格 `WriteBuffer` 写 256 字节 → `GPUValidationError`"）。
**同一个 uniform-array 家族，两个独立团队各打了一个补丁。**
把这条加入你的"升级 three 必须复测清单"：升级时要检查这个 patch 是否已被上游修掉/是否与新版本冲突。

**(2) `WebGLState.setDrawBuffers` 的 null guard**：

```diff
- if ( renderContext.textures !== null ) {
+ if ( renderContext.textures !== null && framebuffer !== null ) {
```

（他们同时打了 `patches/iwer@2.3.0.patch` 调整 XR 手柄按钮事件顺序——与本讨论无关。）

**纪律对照**：你的 `AGENTS.md` §二 规则 13–14 要求"升级 three/@types/three/gaussian-splat-lite 必须重新验证 `patches/`
下两个补丁"并"改补丁时同步更新 `patches/README.md`"。**Pascal 没有 `patches/README.md`**——
这一点上**你的纪律比它严**，不要退。

### 4.9 合批与可见性：`BatchedMesh` 先做 spike ✅

两层：

- **他们自己写的墙面合批**（`packages/nodes/src/wall/wall-batch.ts`）：`WallBatchSource` → 按**材质索引映射**把多堵墙的
  几何合并成一个 batch，产出 `WallBatchRun`（每个材质索引一段连续的索引区间）+ `WallBatchSlice`（每堵墙贡献的顶点区间）。
  `materialIndexMap` 的注释说明了动机："调色板顺序不同但材质相同的墙通过这种方式共享一个批次；
  **映射不到任何索引的 group 直接丢弃**。" 挂接点是 §3.3 的 `hideFromScene(mesh, 'wall-batched')`（`wall-batch.ts:235-240`）。
- **`BatchedMesh` 只在 spike 里**（`components/viewer/batched-mesh-spike.tsx`，79 行，`?spike=batch` 才挂）。
  文件头逐字写了它要**证明**什么：

  > - DRAW 每 pass 只涨约 1，而不是按实例数涨；
  > - TRI 随实例离开视锥下降（`perObjectFrustumCulled` 生效）；
  > - 阴影能投能收；管线不崩。

  而 `:41-43` 的注释是重点：**"默认是 true——显式断言，因为逐实例视锥剔除是整个计划所依赖的性质。"**
  `?spike=batch&spikeGrid=70` → 4 900 个实例，默认 20×20 = 400。

**对你的价值**：你已经有 `ModelResources`（空闲 128 MiB / 8 项 / 30 s TTL + 512 MiB 总驻留上限）
与 `CaptureQueue` 这种成熟记账。Pascal 的**"先写一个 spike + 明确列出它要证明的三条 + 把关键默认值显式断言"**
是一个便宜且值得抄的**决策方法**——尤其在你正在评估"要不要给 splat/模型做合批"的时候。
它把"要不要上 BatchedMesh"从争论变成了三个可测断言。

### 4.10 `frameloop="never"` + 自建 `FrameLimiter` ✅

`components/viewer/index.tsx:647` 设 `frameloop="never"`，由 `FrameLimiter`（163 行）接管循环，默认 `maxFps = 50`（`:501`），
另有 `renderPaused`（"画布被完全覆盖，例如 studio 画廊 → 停止推进帧"，`:70-71`）。

三个值得抄的细节（都在 `frame-limiter.tsx`）：

1. **`useFrame` 里抛错在 React error boundary 之外**，所以要自己抓（`:79-91`）：
   ```ts
   // 在 useFrame 里抛错的系统跑在 React 错误边界之外：把首个失败报给宿主，并保持循环存活。
   ```
   只报第一次（`frameErrorReported`），循环继续。**你的 `RenderSchedule.draw()` 里如果某个窗格抛错，
   现在会把整块画布带走吗？** 值得核对。
2. **`createFrameClock`（`:22-46`）保证 R3F 的时钟单调，且每帧用余数对齐**——
   而不是把浏览器的进程运行时长当帧间隔。**你 `VIEWPORT_REVIEW.md` §○ 推翻"demand 续帧条件恒真"时遇到的是同一类问题**
   （帧间隔 ≠ 帧时间）。
3. **可见性/焦点恢复时主动 `kick()` 一帧**（`:114-133`）：注释说"rAF 在标签页隐藏、失焦、被遮挡时会停摆；
   默认循环已被禁用，所以恢复时强制出当前一帧"。事件是 `visibilitychange` / `focus` / `pageshow`。

### 4.11 其他 WebGPU 相关的可靠性代码

| 文件 | 做什么 | 为什么值得知道 |
| --- | --- | --- |
| `components/viewer/index.tsx:210-256` `GPUDeviceWatcher` | 监听 `device.lost` 与 `uncapturederror`，把静默的 uncaptured error 提到 `console.error` | 注释逐字："Uncaptured errors 正常是静默的（Chrome 最多 warn 一下）。把它们接到 console.error，**这样移动端的静默崩溃才能被看见**。" 你的 PlayCanvas 侧已有 `devicelost`→`devicerestored` 处理（`AGENTS.md` §四之二），three 侧建议补同样的监听 |
| `components/viewer/index.tsx:336-396` `SceneReadyTracker` | 场景就绪门：脏节点数 + 已结算帧数（2 帧）+ **放弃上限**（180 帧，或宿主给 `sceneReadyMaxWaitMs` 走墙钟） | 你的 `inspection` 截图与缩略图都需要"等到场景稳定"。注释里那条"headless bake 页的定时器驱动循环 3.6 s 跑 180 帧，比一次冷下载还快"就是"帧数上限不等于时间上限"，**和你 §五 规则 6「GPU 时间必须在可见窗口测」是同族陷阱** |
| `components/viewer/index.tsx:283-334` `isPendingSceneBuild` | 不可达节点（父节点 `children` 里没有它、又没有父节点且不是 root）**不能扣住场景就绪** | 注释记录了真机后果："prod 场景数据里两个悬空 window 让那个场景的每次 bake 都等满就绪上限。" 你 `AGENTS.md` 里"用 slug 查 `scene.json` 导致手动摆放对 agent 永远不可见"是同一类"图不变量被绕过" |
| `lib/renderer-capability.ts:110-117` | WebGPU 不可用时探测 WebGL2 只为给出**能说话的**失败面板 | 你**没有** WebGL 回退（硬约束 1），所以这条**不要抄**；但"探测能力只为把错误说清楚"这个意图可以保留 |
| `lib/tsl-compat.ts`（16 行） | 因为运行时是 three 0.185+、`@types/three` 钉在 0.184，把改名后的 `packNormalToRGB` 以**旧名字**重新导出 | 注释末尾逐字："**等 tsgo 能处理 0.185 的类型后删掉这个文件**（以及 `@types/three` 的钉版）；`typeof` 引用已删除的旧名字会让构建失败，作为提醒。" ——**"自删除 shim + 编译期提醒"** 是一个很漂亮的手法，值得进你的 `patches/` 纪律 |
| `packages/viewer/README.md:21` | **文档漂移**：声称有 "TRAA (anti-aliasing)" | 全仓 `traa` 只出现在这份 README 与 `wiki/architecture/layers.md:32` 的顺带提及，**`post-processing.tsx` 里没有实现**（`renderer` 也没传 `antialias`）。这是"文档说了、代码没做"的活样本——**正好是你 `AGENTS.md` 三令五申要避免的**，可以引以为戒 |

---

### 4.12 专为截图而建的第二条 WebGPU 管线 ✅（对你的 `CaptureQueue` 直接有用）

`packages/viewer/src/lib/snapshot-pipeline.ts`（**597 行**）是**独立于实时视口的第二条管线**，
和 `post-processing.tsx` **共用视觉常量**（`import { GRADE_PARAMS, SSGI_PARAMS } from '../components/viewer/post-processing'`，
共享 `inkedEdges`、`backdropGradient`、`edgeColorFor`）但**重新组装了一份**：

```
createSnapshotPipeline({…})        :146   ← 带后处理（SSGI/denoise + ink + FXAA）
createPlainSnapshotPipeline({…})   :524   ← 无后处理，直接 renderer.render(scene, camera)
共享 encodeCapture(…)              :385
```

**这条管线的存在本身就是一条设计结论**：视口和截图是**两次不同的渲染**，
所以"截图看起来和视口一样"必须靠**共用参数与着色器函数**来保证，而不是靠"复用同一个 pipeline 对象"。

六个可核对的工程细节：

1. **私有 RenderTarget，理由是"主循环不可能覆盖截图"**（`:303-305` 逐字）：

   > Dedicated render target — pipeline outputs here instead of the canvas, so R3F's main render loop can never overwrite our capture.

   然后 `renderer.setRenderTarget(renderTarget)` → `pipeline.render()` → **`finally { setRenderTarget(null) }`**（`:344-349`）。
   这与你的 `capture.ts` 私有 RT + `CaptureQueue` 是同一套思路；`finally` 还原这点值得核对你的实现。

2. **返回画布尺寸逐帧 resize**（`:340-342`）：`if (renderTarget.width !== captureWidth || …) renderTarget.setSize(...)`。
   —— RT 尺寸跟随画布，而不是跟随请求的导出尺寸；导出尺寸在 `encodeCapture` 里裁剪。

3. **渲染后先让出一个微任务，再开始异步回读**（`:351-353`）：

   ```ts
   // Let callers restore visibility and other capture policy immediately
   // after the render, before the asynchronous GPU readback begins.
   await Promise.resolve()
   ```
   这是一个**刻意的让步点**：调用方可以在 GPU 还在拷的时候就把"为截图临时隐藏的 gizmo/线框"还原回去，
   不必等回读完成。**你 `captureInspectionSheet` 里如果为了拍检查图而临时改了可见性，这招能省掉一段等待。**

4. **`isWebGPURenderer` 会说谎**（`:424-426` 逐字）：

   > `isWebGPURenderer` lies — it stays true even when the renderer falls back to the WebGL backend.
   > Inspect the actual backend instead (presence of a GPU device, or backend constructor name).

   ——**three 的 API 陷阱**，值得进你的"后端事实"清单（你的探针里已有读 `backend.device` 的做法，方向一致）。
   回读形状也因此要处理两种：WebGPU = 自上而下 + 256 B 行填充；WebGL2 = 紧密打包但自下而上。
   行填充算法是 `Math.ceil(actualBytesPerRow / 256) * 256`（`:416-423`）。

5. **截图相机不在场景图里 → 必须手动刷新世界矩阵**（`:327-332` 逐字）：

   > The capture camera never joins the scene graph, so its matrixWorld is only refreshed by the render itself
   > — too late for the backdrop uniforms below.
   > `captureCamera.updateMatrixWorld()`

   ——**"不在场景图里的相机会带着过期 matrixWorld"**。你的四视角检查图如果也构造"临时相机"而不加入场景，
   这是同一颗雷（你的 `entityWorldBounds` 与 `Bounds3` 那类"引擎事实"问题同族）。

6. **产物是 WebP，不是 PNG**（`:28-34`）：`SNAPSHOT_MIME = 'image/webp'`、`SNAPSHOT_QUALITY = 0.9`、
   `SNAPSHOT_MAX_EDGE = 2048`。理由逐字："截图是可重渲染的产物、不是用户原件，所以编码成 webp：
   一张 1920×1080 主图比 PNG 低约一个数量级，而 listing 与 catalog 实际就是这样传的。alpha 保留。"

   ——**你的 `CaptureQueue` 如果还在传 PNG，这是一条现成的体积优化**（他们实测约 10×；
   你 `AGENTS.md` 里记的四视角检查图是 60 528 字节 PNG，转 WebP 后会更小）。

### 4.13 超大截图要分块 + 重叠（screen-space pass 的接缝） ✅

`packages/editor/src/components/editor/thumbnail-generator.tsx:122-155`（该文件 1 226 行）里的 `tileGrid()`：

> 一张 `width × height` 的图被切成不超过 `passEdge` 的等分块，**每块向自己的内侧边界之外多渲染 `TILE_OVERLAP`**，
> 这样 screen-space 的 pass（AO、ink、FXAA）**在接缝处有自己的邻域**。图能塞进一趟时就是一块。

```ts
type Tile = {
  x: number; y: number; w: number; h: number   // 实际渲染的像素（含重叠）
  inner: { x: number; y: number; w: number; h: number }  // 它贡献给成图的像素
}
```

**为什么你要在意**：你已经有"四视角检查图"这条通路，而任何超过一次 pass 上限（纹理尺寸/RT 上限/显存预算）
的成图都会撞到同一个问题——**直接分块会在接缝上留下 AO/描边/抗锯齿的断裂**。
Pascal 的答案是"多渲染一圈重叠、只取 inner"，**代价是清晰的（重叠面积），收益是接缝不可见**。
这比"降分辨率"或"分块后拼接"都干净。

---

## 五、边界与 agent 面（我认为这是第二个最该抄的区块）

### 5.1 依赖箭头：`core → viewer → editor`，而且**机械强制** ✅

`DECISIONS.md:38`（E-001）逐字：

> **E-001 依赖箭头。** `core → viewer → editor`；`nodes`（内置插件）依赖三者，而**除宿主外没有任何东西 import `nodes`**。
> `core` 没有运行时的 Three.js/R3F import；`viewer` 不认识任何编辑器状态（`useEditor`、工具、模式、paint、floorplan）。
> · 为什么：core 要跑 headless（MCP、CLI、worker）；viewer 要能独立发布。· **由谁强制**：`biome.jsonc` 的
> `noRestrictedImports`、`packages/core/src/architecture.test.ts`、`review-architecture` skill。· 何时重审：**永不**。

强制手段是**三层叠起来**的：

**(a) Biome 规则，带可执行的错误信息**（`biome.jsonc:144-196`）：

```jsonc
"noRestrictedImports": { "level": "error", "options": { "paths": {
  "@pascal-app/nodes": "Framework packages must not import from @pascal-app/nodes — consult nodeRegistry.get(kind) instead. See DECISIONS.md E-002."
}}}
```

注意两点：**错误信息里带替代方案与决策编号**（不是"禁止导入"四个字）；以及注释 `:162-163` 说明了
一个 Biome 陷阱——**"Biome 在多个 override 命中同一文件时会替换而不是合并规则的 options，所以下面每一条都重复了 nodes 禁令。"**
（这种"工具行为陷阱写在配置里"的做法，和你 `AGENTS.md` 记录探针缺陷的风格一致。）

**(b) 架构测试，且带"防真空"断言**（`packages/core/src/architecture.test.ts:6-11, 33-60`）：

> 层级规则：core 是纯逻辑——没有 Three.js、没有渲染。**core 里一个运行时的 `three`/`@react-three/*` import
> 会在 barrel 的每个消费者里求值 R3F（进而求值 React client context），在 RSC server 条件下导致 Next.js route handler 崩溃
> （capture 上传曾经这样 500 过一次）。** 仅类型的 import 在构建时被擦除，允许。

实现用两条正则区分 `import type ... from 'three'`（允许）与 `import 'three'`（禁止），
最后一句是 **`expect(files.length).toBeGreaterThan(100)`**——注释写明"防止遍历真空通过"。
**这个"断言样本量"的习惯很值得抄**：你的探针里已经有"负对照"（"不冒出来就判红，防止判据空转"），
这里是同一思想在静态检查上的应用。

**(c) 一条**看起来**违反自己规矩的例外。** `DECISIONS.md:70`（T-001）明令"**禁止 source-grep 测试**，
用 Biome 规则代替"。而 `architecture.test.ts` 就是 source-grep。他们**显式处理**了这个张力：
T-001 末尾写明"**'内部'不是删除判据**：core 的 import 边界、writers allowlist 与迁移阈值都钉住了有外部后果的内部实现，**留下来**"。

**这一条的元价值比规则本身高**：它示范了"**规则要有明确的例外口径，并且例外必须写清为什么**"。
你的 `AGENTS.md` 里 `SEAMS` / `FROZEN_IMPORTERS` / `RENDERING_COMPONENTS_IN_FROZEN_DIRS` 三张例外表
已经在做同一件事（而且是三个**语义不同**的表，还带失效检查）——
**这一点上你和它同级，甚至更细。**

### 5.2 viewer 隔离：靠"可独立发布"当强制力 ✅

`wiki/architecture/viewer-isolation.md`。核心一句（`:9-11`）：

> **viewer 由外部控制。它暴露控制点（props、callbacks、children）。它从不反向伸进 `apps/editor`。**

机制有三条，第三条是关键：

1. **`useViewer` 只放呈现状态**（`:52-63`）：`selection`、`cameraMode`、`levelMode`、`wallMode`、`theme`、
   `showScans/showGuides/showGrid`。"**如果一份状态只在编辑器里有意义（活动工具、相位、编辑模式），它属于 `useEditor`，不属于 `useViewer`。**"
2. **编辑器特有组件作为 `children` 注入**（`:65-79`）：`<ToolManager />`、`<SelectionBoxOverlay />`、`<SnapIndicator />`
   挂在 `<Viewer>` 里 → 它们仍有 R3F context，而 viewer 对它们一无所知。
3. **`@pascal-app/viewer` 是独立发布的 npm 包**。审查清单（`:138-144`）以三个问题结尾：
   "这个功能在**只读的 viewer 路由**里说得通吗？它引用了 `useEditor`、工具状态或相位/模式吗？能不能改成 prop 或 children 传入？"

**给你的建议**：你的 `editingLayerBoundary.test.ts` 用真实模块依赖图守边界，**这是对的、而且比 Pascal 的测试更强**。
但 Pascal 有一个你**没有**的强制力：**`viewer` 是要发布出去的包**。
建议把"可独立构建"变成 CI 里的一条真实产物（哪怕只是 `bun build` 出一个不含 `pages/`、`widgets/Inspector`、
`AgentDock` 的 bundle 并断言它能在只读页面跑起来）。
**边界由"发布物"守住，比由"测试"守住更难绕过**——你自己也写过"注释里的约束没人接线就等于没有"，
测试也属于"接线"，但发布物属于"物理事实"。

### 5.3 agent 面：contract / operation / executor 三层 + parity 测试 ✅

`wiki/architecture/agent-surfaces.md:19-29` 是这套东西里最可直接搬的一页。逐字：

> 一个工具有三层，**只有最后一层可以在两个面之间不同**：
> 1. **Contract** —— 名字、描述、输入 schema —— **一个定义**在 `@pascal-app/core/agent-tools`，
>    MCP 注册它、聊天从**同一个对象**定义它。保持 zod-only：聊天在拒绝 Node 依赖包的沙箱里声明工具
>    （`contracts-purity.test.ts`）。
> 2. **Operation** —— 校验、默认值、钳制、拒绝、要创建哪些节点 —— **core 里的一个纯函数**
>    （`planWallOpening`、`verifyScene`、`duplicateLevel`…）。
> 3. **Executor** —— 应用到 store（聊天的活 store、MCP 的 bridge）与结果信封（实时同步、持久化）。
>    面相关的上下文也在这里解决（"当前楼层"就是人在聊天里看到的那个）。

四条规则（`:11-15`）：

- **能力对等**：一个面对 agent 可用的场景能力，另一个面也必须可用。**机制**可以不同（服务端 MCP handler vs 客户端聊天执行器），
  **契约**不能不同：同名或记录在案的别名、同输入 schema、描述里同含义。
- **同一次改动**：在一个面加/改能力时，同一次改动里移植到另一个面，**或者写下为什么它真的不适用**（PR 描述与 parity 表）。
- **操作只存在一次**：新能力是 `SceneApi`（`createSceneApi(store)`）上的 core 操作；每个面只适配输入输出。
- **规则住在操作里，不住在循环里**：只在一个面的 prompt 或步骤逻辑里存在的拒绝/诊断，对另一个面的 agent 就是没强制。
  "把真实感拒绝与 `check` 类诊断放在两个面都会执行的地方。"

**"编辑器是参照物"**（`:25`）也是一条好纪律：

> 人用手能做的事，就是 agent 可以做的事：操作复用编辑器工具自己的规则
> （对门窗洞口：`clampDoorToWall`、`clampWindowToWall`、`findWallChildOverlap`、**曲墙上不开洞、重叠只在 force 下允许——
> 就是编辑器的 Alt**）。**agent 独有的守卫是例外**，只在它合理且值得也给编辑器时才保留。

**"parity 破了的征兆"**（`:37-42`）是这一页最实用的部分，可以直接翻译成你的检查表：

- 一个工具只在一个面存在，parity 表里没有条目；
- 两个工具共享一个概念但 schema 不同（例如长度**只在一个面**接受 `"6 ft"`）；
- 一个面的 agent 用 `apply_patch` **手工搭**另一个面一次操作就能完成的东西；
- 聊天 prompt 里的一条规则在 agent 指南里没有对应物，或者指南与工具描述**互相矛盾**
  （原文举的例子："`apply_patch` 描述成 'batch-first is the default'，而 skill 说优先用语义工具"）。

共享契约只有 10 个工具（`core/src/agent-tools/index.ts:16-30`，`AGENT_TOOL_CONTRACTS`），
其余 MCP 工具（`packages/mcp/src/tools/` 下约 30 个文件）是面特有的会话/文件操作。**"共享的少而严，面特有的多而松"** 是一个务实的切分。

**对你的映射**：你的 `chat/src/mastra/tools/` 下有 `sceneAnalysis.ts`、`placement.ts`、`meshOps.ts`、`textureOps.ts`、`index.ts`，
而 app 侧有 `widgets/Viewport` 与场景写入路径——**这正是"同一个场景编辑被实现两次"的风险面**。
你 `AGENTS.md` 里已经记录过一次同型真 bug（`analyze-scene` 用 slug 查 `scene.json`，
而表从 v3 起按稳定 id 索引 → "手动摆放对 agent 永远不可见"）。
**那条 bug 的本质就是"operation 住了两个面里的一个"。**

**建议的最小落地**（不要一次重构）：
1. 把 chat 工具里**纯的那部分**（校验、默认、钳制、拒绝、要建哪些节点）抽成 `chat/src/scene/operations/*.ts` 纯函数，
   React/Mastra 侧只做输入输出适配。判据：这些函数不 import store、不 import mastra。
2. 给每个 operation 写一张**用例表**，三个 runner 跑同一张表（core operation / MCP 工具经真实 client / 聊天执行器在真实 store 上）。
   `agent-surfaces.md:29` 就是这个形状。
3. 加一条 parity 测试：**同一个工具的 name/description/input schema 在两个面不一致就失败**。

### 5.4 `AgentRefusal`：拒绝是答案，不是崩溃 ✅

`packages/core/src/agent-tools/refusal.ts` 全文很短，但把语义钉死了（`:1-8`）：

> 一次**合理、可预期**的 agent 操作失败：请求无法照做，而**消息说明原因以及什么能做**
> （"墙 `wall_a` 长 0.80 m，装 0.90 m 的门太短。"）。每个面用同样的方式回答它，
> `{ error, code, ...details }`，并按 `code` 计数——**拒绝是给模型的信息，不是崩溃。**

`refusalPayload(error)` 返回 `{ error: message, code, ...details }`（`:41-43`），
`code` 是稳定字符串、按 thread/按周计数（`agent-surfaces.md:27`）。

**这条成本几乎为零、收益立刻可见**：你的 agent 工具现在失败时返回的形态如果各不相同，
模型的自我修正能力会被浪费。**统一成"message 说明原因 + 什么能做、code 稳定可计数"**，
并让它出现在**两个面**（聊天与任何 MCP/API 面）上。

---

## 六、不要抄的部分 / 他们付的代价

诚实记录，避免你把它的结构当默认正确。

| 项 | 代价 | 判断 |
| --- | --- | --- |
| **221 444 行测试 / 721 444 行总量（31%）** | `DECISIONS.md:70` 自己承认："**231k 测试行（其中 82k 是 fixture）已经变成每次改动的最大成本，对人和 agent 都一样。**" 于是有了 T-001 那套禁令（禁 source-grep、禁散文钉死、禁跨包 `src/` import、禁真 sleep、重构脚手架必须在落地 PR 里删除……） | **这是本文最有价值的负面教训**。你的 `AGENTS.md` 用"每个数字点名模块"来对抗测试通胀（"引用数字时以本节点名的模块为准"），方向对，但他们已经走过一整轮膨胀再往回砍。**在你决定为某条结论加测试前，先问它保护的是"可观测结果 / 持久或线上契约 / 显式架构或性能不变量"三者中的哪一个**——T-001 的判据可以直接抄 |
| **`packages/core/src/registry/types.ts` 单文件 3 000+ 行** | capability/hosting/snapping/批处理/机制/引用全塞在一个类型文件里 | 与 E-002 的中心化是同一个决定的代价。**你的架构中心是 `SceneJob` + `RenderSchedule` + 资源账**，不必也不应该模仿这个规模 |
| **迁移处于 strangler fig 中途** | `interaction-scope.md:173-187` 明写："scope 是目标真相，但**旧的 `useEditor` flags 仍作为镜像存在**，正在逐个 reader 退役"；并列出**已知遗留**（MEP 工具的 `event.shiftKey` 旁路、屋顶/多边形/板的 `event.altKey` 对齐旁路）。规则是"**碰**到它就迁移，不许扩展遗留路径" | 这正是你 PlayCanvas 分流当下的状态（`?pcViewport=1`，默认仍 three）。**可抄的是那条规则**："碰到遗留路径的 PR 必须迁移它，不许在旁边再长一条"；而不是抄"同时维护两套" |
| **`wiki/architecture/` 24 篇 3 647 行的维护成本** | 每加一个 layer 都要更新 `layers.md`；每加一个 system 要更新 `systems.md` 的分层表 | 这是 §二 建议的代价。**折中**：先把 `AGENTS.md` 里**最容易被误用**的部分（撤回清单、证据分级）搬出去，不必一次搬完 |
| **`MergedOutlineNode` 是 three `OutlineNode` 的 fork + `@ts-nocheck`** | 797 行、上游一改就可能漂移 | 他们已经真机验证过收益，属于可接受；但**这是"fork 引擎内部"的典型成本**，你 `patches/` 的纪律（改释放路径而非渲染/画质）更保守，我不建议你扩大 fork 面 |
| **`packages/viewer/README.md:21` 声称有 TRAA、代码里没有** | 文档漂移 | 见 §4.11。**引以为戒**：你的 `AGENTS.md` 对"不要假装解决"的强调是对的 |

---

## 七、给你的落地清单

按"投入产出比"排序，每条都写了**验收判据**（照你自己的习惯，判据要能被一条会失败的测试或一次真实测量守住）。

### P0 —— 本周可做，纯文档/小重构

1. **拆 `AGENTS.md`**。把第六节、「已撤回清单」、文档地图搬到独立文档，`AGENTS.md` 只留目录地图 + 硬指针 + 当前可信基准；`CLAUDE.md`/`GEMINI.md` 改成指向它的符号链接。
   - 判据：`wc -c AGENTS.md` < 20 000（Pascal 是 2 602 B / 39 行，你的知识量更大，20 KB 是务实上限）；且注入预算（65 536 B）下**不再发生截断**。
2. **加 `review-webgpu` skill**，第一步强制"读 `WEBGPU_FINDINGS.md` §1 与撤回清单再开口"，
   并给出"按 diff 触及面选择要读哪份文档"的映射表（照 `.agents/skills/review-architecture/SKILL.md:13-31`）。
   - 判据：skill 里存在一张"路径 → 必读文档"的表；且它列出的每份文档都真实存在（失效检查）。
3. **把 `paneRegistry` 的 `camera.layers` 收敛成"单一所有者 + 理由集合"**（照 `scene-visibility.ts:5-46`）。
   - 判据：一条测试，模拟"HUD + gizmo + 天空盒三层同时挂载再逐个卸载"，最终 `camera.layers.mask` **逐位等于初始值**；
     并且**没有任何模块直接写 `camera.layers`**（除所有者）。
4. **给 `frame-limiter` 式的循环加 `try/catch`（若 three 侧没有）**，并把"可见性/焦点恢复时 kick 一帧"补上。
   - 判据：故意让某个窗格的 `draw` 抛错，其余窗格**继续出帧**，且错误只上报一次。

### P1 —— 与 `SCENE_COMMAND_PLAN` 的 Phase 对齐，一次做一条

5. **`InteractionScope` 的垂直切片**：先把"指针手势归属"收敛成判别联合 + 单一写入点（`begin/update/end/endIf` 的语义照抄，含"`update` 不改 kind"、"`end` 原子无载荷"）。
   - 判据：一批"非法组合不可表达"的测试（例如：漫游 tick 活动时 `begin('gizmo-drag')` 会原子替换且漫游被挂起；
     `end()` 后不残留 `nodeId`）；`paneInput` / `paneGizmo` / `transformKeys` / `walkRig` 变成**只读消费者**。
   - 参照你已踩过的两个真 bug（`AGENTS.md` §四之二 的漫游指针锁定、线框/贴图 cleanup 顺序）作为回归用例。
6. **`createDragSession` + `pauseHistory/resumeHistory` + "single-undo dance"**（`core/src/services/drag-session.ts` + `single-undo-dance.test.ts:20-33`）。
   - 判据：一次拖动 = **一条**撤销记录，撤销后回到拖动前状态**且不吞掉更早的创建步骤**（照他们那条回归测试的措辞）。
   - 这条直接补 `SCENE_COMMAND_PLAN.md` §三 缺口 #1。
7. **`AgentRefusal` + operation 层抽取**（§5.3/5.4）。
   - 判据：`chat/src/scene/operations/*` 不 import store / mastra（一条架构测试，照 `architecture.test.ts` 的写法，
     **带 `expect(files.length).toBeGreaterThan(N)` 防真空**）；parity 测试在同一个工具两面的 name/description/schema 不一致时失败。
8. **两个 WebGPU 守卫**（`installEmptyDrawGuard` + `installTextureNodeNullGuard`）。
   - 判据：`hasDrawableGeometry` 等价物对 `count === 0` 的 `drawRange` 返回 false；真机上**故意挂一个空几何**
     验证整块画布不闪、不落失败面板。空纹理守卫的判据是"共享材质被 override pass 覆盖后画面不黑"。

### P2 —— 测量工具与渲染细节

9. **`?disable=…` 剖面开关**（至少 `postFx` 与 `draw` 两档），
   并配套"不画帧时用 `setInterval` 而非 rAF"（`frame-limiter.tsx:48-60`）。
   - 判据：同一份代码用 URL 开关切出 2 个读数，且与你的交替设计读数量级一致。
   - **优先用于那个根因未定位的"≥3 视图塌缩"**：先切 `postFx`/`draw`，直接排除"后处理开销"与"逐帧 draw 提交"两大类。
10. **复核 §4.7 的 `resolveTimestampsAsync` 矛盾**：在可见窗口记录 resolve 往返时间、`presents`/`submits`、以及是否阻塞提交。
    - 判据：写进 `WEBGPU_PROBE_PROTOCOL.md` 的新 §；明确"每帧调是否可行"以及"5 Hz 上限是探针实现还是 three 固有"。
11. **把 GPU 计时纪律写进指标名**（`gpu-render` / `gpu-queue` 式命名），凡"不是 GPU 时间"的量一律在名字里带出来。
    - 判据：`grep` 探针字段名，不存在一个语义含混的 `gpuTime`。
12. **合批决策用 spike 方法**（`batched-mesh-spike.tsx`）：先写"这个 spike 要证明哪 3 条断言"，
    并把关键默认值（如逐实例视锥剔除）**显式断言**。
    - 判据：spike 的报告里有 3 条可判真假的读数，而不是"感觉快了"。
13. **截图管线与视口管线分开，但共用参数/着色器函数；截图侧单独开 FXAA**（§4.12）。
    你的硬约束 2 禁止改实时 `antialias`，**但截图不受那条约束**——缩略图与 agent 检查图是静态产物，
    付得起一个全分辨率中间 RT。同时核对三件事：私有 RT 还原写在 `finally` 里、
    渲染后先让一个微任务再回读、产物从 PNG 换 WebP（他们实测 1920×1080 约低一个数量级）。
    - 判据：同一场景的视口截图与检查图在**描边/AO 口径上一致**（共用常量，不靠人眼记忆），
      且检查图字节数明显下降。注意：你的 agent 检查图是走 PlayCanvas 的 `captureInspectionSheet`，
      这条要落在 PC 侧（PC 的 `Texture.read` 自己解 256 B 对齐，**不要**再移植 `unpackRGBA`）。

### P3 —— 只有在规模真的需要时才做

14. `NodeDefinition` 三复选框 + 注册表驱动分发。**不建议现在做。**
    如果要做，先只做 **capability 动词化**（把散落的 kind 判断收成"动词能力 + 查表"），不要一次上注册表。

---

## 八、一句话总结

**这个仓库对你有两类价值，而第二类比第一类大。**

第一类是**代码**：`scene-visibility`（记理由不记掩码）、`installEmptyDrawGuard` / `installTextureNodeNullGuard`
（两个静默失败守卫）、`?disable=…` 剖面开关、`gpu-render`/`gpu-queue` 的命名纪律、`createDragSession` 的
停历史括号与 single-undo dance、`AgentRefusal`。这些东西**照抄即可**，总成本以天计。

第二类是**它处理"文档与代码会漂移"这件事的方法论**：`DECISIONS.md` 每条不变量都带
「决定 · 为什么 · **由谁强制** · 何时重审」，Biome 错误信息里带替代方案与决策编号，
架构测试带防真空断言，review skill 承认 checklist 的失效模式并加一道专职工序，
T-001 明确写出"规则要有例外口径、例外要有理由"。

**而你现在的处境恰好是这两类的交叉点**：你的 `AGENTS.md` 是全仓最密集、最诚实的工程知识，
**但它已经装不下自己了**——被截掉的 11.6 KB 正是"不要再犯"的那一半。
先解决这个，剩下的都能慢慢来。

**如果只看 WebGPU**：它是 three.js WebGPU 的**深度使用者**（自建 PassNode、fork `OutlineNode`、
patch `TextureNode`、覆写 `backend.draw`、MRT + 时间戳），
但**零 compute / 零 WGSL / 零 storage buffer**——所以它是"把 three 的 WebGPU 表面用透了"，
不是"在 WebGPU 上写引擎"。它的价值不在渲染算法（那些大多来自 three 自带的 display node），
而在**一长串静默失败的手册**：那些守卫、那个"只为截图而建的第二条管线"、
那个 `isWebGPURenderer` 会说谎的记录。**你的栈和它同源，所以它的伤疤你能直接用；它的渲染技法你多半已经有了。**

# 场景层改造计划：从"直接改状态"到"命令流"

本文是 [EDITOR_PRACTICES.md](./EDITOR_PRACTICES.md) 的落地篇。那份文档回答"读什么"，这份回答"改什么、按什么顺序改、怎么算改完"。

---

## 一、那些文章的共同点

把 Figma、Our Machinery、Godot、Blender、Zoo、FreeCAD、Photoshop 的材料放在一起看，剥掉各自的语言和场景，剩下的是**同一句话**：

> **编辑器是围绕一份可序列化文档的、可撤销的命令流。文档是它的状态，界面只是它的一个视图。**

这不是修辞。上面每一家的具体做法都是这条思想的推论：

| 他们要解决的问题 | 推论出的做法 | 出处 |
| --- | --- | --- |
| 撤销重做 | 命令必须可逆 → 存"改了什么"而不是"现在是什么" | Godot `EditorUndoRedoManager` |
| 持久化 | 文档与磁盘格式解耦，能重放 | The Machinery《The Document Model》 |
| 协同 | 命令流多播，而不是同步整份状态 | Figma multiplayer |
| 引用不失效 | 命令引用**稳定 id**，不引用名字/索引 | FreeCAD 拓扑命名、The Truth 的 64 位 id |
| 增量重算 | 命令声明影响面，只重算下游 | Creation Graphs |
| 插件安全 | 插件只能发命令，所以能沙箱隔离 | Figma 插件系统 |
| 面板不手写 | 命令的参数 schema 决定 UI | Blender RNA、Writing Tools Faster |
| 能回归 | 命令流可重放，所以能测 | Figma 的实测曲线 |

外加两条支撑纪律：

- **生命周期用租约，不用所有权**：资源有引用计数、有预算、**超预算要降级而不是崩**（Photoshop 的磁盘分层、Figma 的内存优化）。
- **性能必须可测量**：有预算、有基线、有回归门槛，而不是"感觉卡"。

## 二、你已经做对的部分（计划要建立在它们之上）

读代码时最意外的收获：你不是"还没开始"，而是**已经实现了三条原则，只是没有显式命名**。

| 原则 | 你已有的实现 | 判断 |
| --- | --- | --- |
| 命令边界 | `TransformGizmo.handleMouseUp` 收集 `updates` 后调 `onCommit(updates)`；`liveTransforms` 拖拽期间走命令式直写、松手才提交 | **已经是命令的形状**，只差类型化 |
| 依赖图 + 精确失效 | `SceneJob` 有 `dependsOn` / `inputFingerprint` / `pending·stale·obsolete·succeeded`，`retrySceneJobNodes` 用 BFS 传播下游，`reviseSceneSpecAndJob` 注释写明了精确失效语义 | **Creation Graphs 的核心你有了**，缺纯函数化与测试 |
| 资源租约 | `ModelResources` 引用计数 + idle 预算 + 只淘汰空闲项（"Active assets are never disposed to hit a budget"）；`DeferredResource` 有代次守卫防 StrictMode 误释放 | **比多数公开案例更严谨** |
| 单调度器 | `RenderSchedule` 独占绘制顺序；`WEBGPU_PROBE_PROTOCOL.md` 有 GPU 时间测量协议 | 超过了这些博客的平均水准 |

所以下面的计划**不重写任何现有架构**，只做加法。

## 三、缺口清单（全部经代码检索确认）

| # | 缺口 | 证据 | 对应哪条原则 |
| --- | --- | --- | --- |
| 1 | 没有撤销重做 | 全仓 `undo`/`redo` 命中数为 0 | 命令可逆 |
| 2 | 写入是**状态覆盖**而非命令 | `writeSceneLayout` 做 `{...current, ...patch}` 按键浅合并，表达不了"撤销这一步" | 命令可逆 |
| 3 | `schemaVersion: z.literal(1)` | `chat/src/dto/library.ts` — 字面量类型意味着**改结构 = 老工程解析失败**，没有迁移路径 | 文档与格式解耦 |
| 4 | 只有 `updatedAt`，没有 `revision` | 客户端带 500ms 防抖保存，无法判断"我这次合并基于哪一版" | 并发可判定 |
| 5 | 资产身份不稳定 | `assetSlug` 既是索引键又是引用；`dropSceneEntries` / `dropTransform` 的注释自己写了"删掉 chair 再导入同名 chair 会继承旧摆放"——这是用特判绕开的问题 | 稳定 id |
| 6 | 预算超限直接抛错 | `capture.ts` 调 `captureBudget.reserve(...)`，超限 throw，截图直接失败 | 超预算要降级 |
| 7 | 属性面板手写 | `Inspector/NumberField.tsx`、`TextureChannels.tsx` 逐字段手写 | schema 驱动 UI |

第 5 条值得强调：**你已经在注释里把这个坑写清楚了，说明它已经咬过你一次。** FreeCAD 的"拓扑命名问题"就是这个问题的成熟理论框架，值得对照。

---

## 四、修改计划

### Phase 0：地基（无 UI 变化，先做，因为 Phase 2 依赖它）✅ 已完成

**0.1 给场景文档补版本迁移** ✅

- 现状：`SCENE_LAYOUT` 用 `z.literal(1)`，只能表达"恰好是 1"。
- 改动：`chat/src/dto/library.ts` 定义 `SCENE_SCHEMA_VERSION = 2`；新增 `migrateSceneLayout(raw): SceneLayout` 按版本逐级升级；所有读取路径统一走它。
- 完成条件：v1 老工程能打开且不报错；保存后落盘为 v2；有 v1→v2 的单测。

**0.2 给场景文档加 `revision`** ✅（范围比原计划收窄，见下）

- 改动：`SceneLayoutSchema` 增 `revision: z.number().int().nonnegative()`（迁移自 v1 的是 0）；`writeSceneLayout` 与 `dropSceneEntries` 在锁内自增。
- 完成条件：连续写入 revision 递增；删除资产也递增；迁移自 v1 的文档第一次被改写后是 1。

> **与原计划的差异：没有实现 `ifRevision` 前置条件。** 原计划想加一个"整份文档"的 `ifRevision`，
> 但那样会在"两个窗口先后保存**不同**资产"时误报冲突——而这正是 `writeSceneLayout` 按键浅合并
> 刻意要保住的行为（它的注释写明了这个意图）。要正确表达"同一资产被并发改过"，需要**按资产**的
> 基准版本，那是命令层的事（Phase 1.3）。所以这里只做"客户端能看见版本"，冲突判定留到命令层一起做，
> 不提前塞一个语义不对的开关。

### Phase 1：命令层与撤销重做 ✅ 已完成（范围按确认收窄为"只撤销视口里的用户操作"）

**实际做法与原计划的差异**

- **命令类型没有单独建文件、也没有做成 `type SceneCommand` 联合。** 实现里的"命令"是**一步改动**
  （`SceneStep`：`changes[].before/after` + `label`），因为一次 gizmo 松手可能同时动多个资产
  （多选拖拽），用单资产的联合类型反而要包一层数组。绝对值语义照旧保留：`before`/`after`
  存的是"设成什么"，不是"改了多少"。
- **命令类型只存在于 `app`**，服务端契约（`SaveSceneSchema`）一行没动。
- **多选拖拽是一步**：一次撤销还原全部成员。
- **只合并"输入框"来源**：`NumberField` 每敲一个能解析成数字的字符就提交一次（它的注释写了
  为什么），所以 500ms 内同资产的连续输入合并成一步；**拖拽与多选一律各占一步**——两次拖拽是
  两件事，合并会让人撤销不掉第一步。
- **1.3 的"清 pendingRef"没有做，因为不需要**：撤销发的仍是普通的 `commitTransforms` /
  `setMaterial`，走的是原来那条队列。`useSceneTransforms` 的防抖 effect 在 `local` 变化时
  会 `clearTimeout` 掉上一班车并重建 pending（并有 `pendingRef.current !== pending` 的守卫），
  所以"拖完在防抖窗口内撤销"最终只会落盘撤销后的值。这条已由测试锁定。

**接线**

| 文件 | 改动 |
| --- | --- |
| `app/src/pages/AppDashboard/useSceneHistory.ts`（新） | 撤销栈、合并规则、快捷键、`canUndo/canRedo/undoLabel/redoLabel` |
| `app/src/widgets/Viewport/TransformGizmo.tsx` | `onCommit(updates, mode)`——带上模式只为写步骤文案 |
| `app/src/widgets/Viewport/index.tsx` | `history` 可选 prop + 右下角撤销/重做按钮（空栈时禁用而不是隐藏，避免整排控件位移） |
| `app/src/pages/AppDashboard/index.tsx` | 抽出共享的 `layout`（视口/右侧栏/撤销栈共用一份生效摆放），接上历史栈 |

**边界与取舍**

- 撤销栈**不覆盖 Agent 的增删资产**：那是任务链路的产物，撤销要能回滚付费生成任务，语义对不上。
- 资产被删除后，指向它的历史步骤**跳过不写回**（否则留下孤儿记录），但仍然出栈，不会卡在栈顶。
- 拖拽进行中（`live.size > 0`）忽略撤销：那一刻画面由实时表决定，改了只会被松手时的提交再覆盖一次。
- 查不到"改之前长什么样"就不入栈：宁可有一步不能撤销，也不要记一步错的。
- 焦点在输入框/文本域里时不吃 Cmd+Z——那里的 Cmd+Z 是"撤销打字"。
- **已知的语义漂移**：撤销"某个从未落过盘的资产的首次拖拽"时，写回的是它当时的网格默认位，
  于是这个资产从"派生摆放"变成"显式摆放"。此刻画面完全一致，差别只在**将来网格重排时**它不再
  跟着动。彻底解决要等 Phase 2 的稳定身份 + 显式条目删除端点。

**验证证据**

- `app` typecheck 通过；`app` 测试 **320 passed / 0 failed**（新增 10 条历史栈测试）。
- `chat` 测试 **328 passed / 0 failed**；`bun run check` 整体通过（含 `vite build`）。
- 覆盖到的行为：拖拽撤销/重做、重做分支失效、输入框合并、两次拖拽不合并、多选一步撤销、
  换贴图撤销（首次 `before` 是默认材质）、删除资产后跳过、拖拽中忽略、查不到 before 不入栈、
  快捷键与输入框豁免。

**尚未验证**：真实浏览器里的交互（拖一下 → Cmd+Z 看画面回跳、按钮提示文案）。单测覆盖的是
状态与调用序列，画面回跳依赖 React 重渲染 + `computeSceneLayout`，建议手工过一遍。

### Phase 2：稳定身份 ✅ 已完成（范围有修正，见下）

**2.1 资产引入稳定 `assetId`** ✅

- 改动：`asset.json` 增加 `id`（UUID，经唯一的工厂 `createAssetIdentity` 发放）；
  `SceneLayout` 两张表改按稳定 id 索引（`SCENE_SCHEMA_VERSION = 3`）；迁移由服务层传入
  `slug → id` 映射完成。
- 完成条件：删除资产 → 用**同名 slug** 新建 → 新资产拿到默认网格位，且**结构上不可能**继承。
- 收益：这是把"用特判绕开的问题"变成"结构上不可能发生"，正是 FreeCAD 那篇的核心教训。

**2.2 材质引用一起走 id** ⚠️ **原判断有误，已修正**

- 原计划写的是"`materials` 的值是逻辑路径，资产改名或重生成会断，改用 id 引用"。
  **实际不是这样**：`materials` 的值指向的是**工程级源图**（`projects/<slug>/source/*.png`），
  这些路径不随资产改名/重生成变化，本来就是稳定的。真正需要换的是**键**（原来按 slug 索引），
  而那与 2.1 是同一件事，已经一起改完。
- 所以这一条没有独立改动，只在文档里留个更正，避免以后有人照着原计划去动值格式。

**实际做法与"两个特判"的处理**

计划里写的是"把 `dropSceneEntries` / `dropTransform` 删掉"。实际没有删，但改了它们的**语义**：

- `dropSceneEntries`（服务端）现在按稳定 id 摘，且注释写明它已是**纯卫生清理**，不再是正确性的依赖；
- `dropTransform` / `dropMaterial`（客户端）现在按稳定 id 摘本会话的乐观缓存。
  这个不能删——`transforms = {...remote, ...local}` 是"本地优先"，不清的话本会话那份缓存会
  一直盖住服务端返回值（这是与身份正交的另一件事，原计划把它们混为一谈了）。

**结构性由测试锁定**：`同名 slug 重建不继承旧记录：隔离来自稳定 id，不是删除时的清理` 刻意
**绕过** cleanup，只把目录换成同 slug 的新资产，断言新 id 读不到旧记录、旧记录仍在文件里。
这条测试在"靠清理保证正确"的实现下必然失败。

### Phase 3：资源从"抛错"到"降级" ✅ 已完成

**3.1 预算降级** ✅

- 实现：新增 `ResourceBudget.reserveCapture(size, samples, reclaim, floor, pressure)`：请求尺寸 →
  失败则按**差额**回收空闲模型条目（`modelResources.trimToFit(needBytes)`）后同尺寸重试 →
  仍失败按尺寸阶梯逐档减半（下限 256，绝不放大）→ 到下限才拒绝，错误信息带上 limit / 在用量 /
  需求 / 实际降到多少 px / **卡住的是哪一侧**。
- **两本账联动**：截图目标与模型缓存抢同一块显存，所以准入同时看两侧余量
  （`MemoryPressure` 探针，`min(截图侧余量, 模型侧余量)`）。此前只看截图自己那本，会出现
  "额度还有、显存已被模型占满"，分配 render target 时直接设备丢失。这也让"重试同一尺寸"
  真的有意义：模型侧让出空间后，它就不再是瓶颈。
- 模型侧新增：`ModelResources.memory`（驻留字节 / 上限 / 是否超限 / 因超限回收的条目数）、
  `trimToFit(needBytes)`（按差额回收空闲条目，**绝不释放在用项**）、以及 **512 MiB 的总驻留
  安全上限**（超出时 `sweep()` 立刻回收空闲条目，不再等 30 s TTL）。`stats` 形状与
  `reserve()` 语义一字未改（既有断言用 `toEqual` 比 `stats`，所以新读数走独立 getter）。
- 降级可见性：`captureBudget.downgrades`（`{count, last:{requested, actual}}`），返回的 canvas
  边长就是实际尺寸。
- 纪律：只淘汰 `refs === 0` 的条目；`release()` 仍只结算一次。

**3.2 大资产流式与落盘** ⏸ **前置已完成，落盘/LOD 仍未做（有意）**

- 已做的是"超出内存之前先知道、并且能腾"：驻留字节可读（`memory`）、上限可配、超限时按需回收、
  截图准入已把这本账算进去。也就是说，真出现"单场景超预算"时，需要的是接一个降级动作，
  而不是先补观测。
- **落盘（OPFS/磁盘分层）与降 LOD 没有实现，理由是**：①触发条件（真实项目里单场景超预算）
  还没出现，按 AGENTS.md §二.3 的纪律，没有测量就不该先定一个降级档位；②落盘要动
  `modelLoaders` 的解码链路，属于"改渲染路径"，而当前唯一被证实的显存风险是 **splat**——
  它根本不走 `ModelResources`，所以照这个方向做很可能修的不是真问题。
- 真要推进时的第一步（有依据，不是猜）：先把 `WEBGPU_FINDINGS.md` §6 提到的
  `long-animation-frame` 主线程归因报出来，确认那 2.8 s 缺口到底在不在资源侧，再决定
  是降 LOD、落盘，还是根本不在这条路径上。

### Phase 4：把已有的依赖图显式化 ✅ 已完成

**4.1 影响面计算抽成纯函数** ✅

- 抽出 `planNodeInvalidation(nodes, nodeIds): { pending, stale }`：不碰存储、不调 `Date.now()`、
  不改入参；直接指定的节点 → `pending`，下游 → `stale`；`obsolete` 既不失效也不向下传播；
  `touched` 去重；缺失/已废弃节点抛原有 404 与文案。
- `retrySceneJobNodes` 改为调用它；**`reviseSceneSpecAndJob` 刻意不复用**：它的状态语义相反
  （被改对象标 `stale` 而不是 `pending`）、还要写新 `inputFingerprint`、新建/废弃节点，
  复用会改变行为。补了一条测试锁定"两者的失效**范围**一致、但状态语义不同"，将来谁想强行复用会立刻红。
- 验证强度超出计划：除单测外做了差分 fuzz（内联重构前算法 + 4000 组随机 DAG，含 obsolete、
  幽灵 id、菱形），3736 个有效用例 0 mismatch，其中 1721 个抛错用例的错误码与文案也一致。

---

## 五、执行顺序与依赖

```text
0.1 ─┬─> 0.2 ──> 1.1 ──> 1.2 ──> 1.3        ✅ 已完成
     └─────────> 2.1 ──> 2.2                ✅ 已完成（2.2 修正为"无需改动"）

3.1  ✅ 已完成
3.2  待真实大场景触发
4.1  ✅ 已完成
```

粗量级（仅供参考，没做详细估算）：0.1+0.2 约 1 天；1.1~1.3 约 2~3 天；2.1 约 1~2 天；3.1 约 1 天；4.1 约 1 天。

**除 3.2 外，本计划的条目已全部落地。** 3.2 是"等真实项目里出现单场景加载超预算再做"，
不是遗漏；它的前置（租约 + 代次守卫 + 预算账本）都在。

**下一步**：本计划条目已全部落地（3.2 待触发）。后续如果要往前走，方向是"把命令流从客户端推到服务端"——
即让 `scene.json` 的写入本身变成带 revision 前置条件的命令提交，那样才能做真正的并发冲突判定与协同。
那一步的前提是 Phase 1 的命令类型与 Phase 2 的稳定身份，两者现在都在了。

## 六、明确不做的事

| 不做 | 为什么 |
| --- | --- |
| 全量快照式撤销 | 你的场景是稀疏表，快照退化快；且无法表达"撤销了哪一步" |
| 现在就做协同 | 但**现在做 Phase 1 就是在为协同铺路**——命令流一旦成立，协同就退化成"多播命令 + 冲突判定" |
| 现在就做插件沙箱 | 26 个工具都是可信代码，沙箱是纯成本，等真要开放第三方扩展 |
| 顺手重写渲染架构 | `RenderSchedule` / `ModelResources` / `DeferredResource` 的设计已经比公开案例严谨，动机不足 |
| 在 `useSceneTransforms` 之外再造状态所有者 | `PLAN.md` 阶段 4 的纪律：项目切换、对话流、任务轮询、场景保存各只有一个状态所有者 |

## 七、完成后你应该能说什么

- ✅ 场景的每一次修改都有名字、可撤销、可重做（Phase 1）
- ✅ 老工程永远打得开，格式能演进（Phase 0）
- ✅ "删掉再建同名资产继承旧状态"这类 bug **结构上不可能发生**（Phase 2）
- ✅ 资源超预算时用户看到的是降级后的画面，不是报错（Phase 3）
- ✅ 改一个对象会失效哪些下游，有一行测试说得清（Phase 4）

## 八、Phase 0 实施记录（2026-09-29）

### 改动

| 文件 | 改动 |
| --- | --- |
| `chat/src/dto/library.ts` | 新增 `SCENE_SCHEMA_VERSION = 2`、私有的 `StoredSceneLayoutSchema`（宽容旧版本）、当前 `SceneLayoutSchema`（含 `revision`）、`migrateSceneLayout()` |
| `chat/src/services/assetStorage.ts` | 抽出 `readJsonRaw()`（只解析不校验），`readJson()` 复用它 |
| `chat/src/mastra/tools/projectTools.ts` | 新增 `readSceneLayout()`（读原始值 → 迁移 → 补路径与错误码）、`nextSceneRevision()`；三处读写全部改走迁移 |
| `app/src/shared/lib/libraryApi.ts` | `SceneLayout` 增可选 `revision` |
| `chat/src/dto/library.test.ts`（新） | 7 条迁移单测 |
| `chat/src/mastra/tools/tools.test.ts` | 新增「scene.json 版本与 revision」4 条 |

### 验证证据

- `chat` typecheck 通过；`chat` 测试 **328 passed / 0 failed**（新增 11 条全绿）。
- `app` 测试 309 passed / 1 failed，失败项在 `app/src/shared/rendering/gpuProbe.test.ts`。
- **真实数据**：对 `~/ChatSpace/projects/p-mu5l6om3/scene.json`（v1，3 个资产）跑迁移 →
  `schemaVersion` 1→2、`revision` 0，`transforms` / `materials` / `updatedAt` 逐字节保留。
- 备份：改动前已把 `~/ChatSpace`（排除 `assets/` 与 `tasks/*/work/`，11 MB / 69 文件）备份到系统临时目录。

### 已知遗留（不是本次改动引入）——✅ 已按用户确认修掉

`app/src/shared/rendering/gpuProbe.test.ts` 曾有 1 条 typecheck 错误与 1 条测试失败。它们是仓库里
**尚未提交**的 WIP 文件（`git status` 显示为 `??` 未跟踪），与场景文档无关：

- 类型错误：测试的 `fakeRenderer` 返回的 `info.render` 推断类型里没有 `frameCalls`，但测试要给它赋值（`gpuProbe.ts` 自身已经声明并读取这个字段）。
- 测试失败：`a resolve with no new queries is skipped instead of replaying the last value`。

**已修**（经用户确认后）：

- 类型：给 fake 的 `render` 显式声明可选的 `frameCalls`。**只补类型、不补值**——若直接写
  `frameCalls: calls`，`captureCounters` 里 `render.frameCalls ?? render.calls` 会改走另一个分支，
  等于顺手改了运行时行为。
- 测试：断言时机错了，不是期望值错了。`wallMs` 由 `stop()` 结算，而断言写在 `stop()` 之前；
  同一文件第 100 行有个同样的断言就是先 `stop()`。改为 `expect(sampler.stop().wallMs.frames).toBe(1)`。

## 九、Phase 2 / 3 / 4 实施记录（2026-09-29）

### Phase 2：稳定身份

| 文件 | 改动 |
| --- | --- |
| `chat/src/dto/library.ts` | `AssetIdentitySchema` 增可选 `id`；新增 `createAssetIdentity()`（唯一发 id 的地方）与 `assetStableId()`；`SCENE_SCHEMA_VERSION = 3`；`migrateSceneLayout(raw, assetIdsBySlug)` 改写两张表的键；**只在 `schemaVersion < 3` 时改写**（幂等） |
| `chat/src/mastra/tools/resumeGeneration.ts`、`worldGen.ts`、`skyboxGen.ts`、`services/modelPublishing.ts` | 6 处新建 asset.json 全部改走 `createAssetIdentity` |
| `chat/src/mastra/tools/projectTools.ts` | 新增 `assetIdsBySlug()`；`readSceneLayout()` 接收映射；`getProjectState` 顺手收集映射（含会被跳过的空 model 身份）；`dropSceneEntries` 改按 id 且降级为纯清理；`deleteAsset` **先认身份再删目录** |
| `chat/src/routes/projects.ts` | `SaveSceneSchema` 的键改成 `SceneKeySchema` |
| `app/src/shared/lib/libraryApi.ts` | 新增与服务端同规则的 `assetStableId()`；`AssetState.identity` 增 `id?`；`deriveLibraryAssets` 的 `id` 从 `${projectSlug}/${slug}` 改为稳定 id |
| `app` 其余 | `scenePlacement`、`TransformGizmo`（提交键改 id）、`Viewport`、`AppDashboard`（含 `assetsBySlug` → `assetsById`）、两个保存 hook 的键与注释 |

**验证**

- 真实数据：对 `~/ChatSpace/projects/p-mu5l6om3` 跑 `getProjectState`（v1 文档 + 4 个真实资产）
  → `schemaVersion` 0→3、4 个资产的 `slug → slug:<slug>` 映射全部命中、3 条摆放与 1 条材质的
  位置逐字节保留、每个键都能对上资产。
- 结构性测试：`同名 slug 重建不继承旧记录：隔离来自稳定 id，不是删除时的清理`（绕过 cleanup）。
- 键语义测试：`computeSceneLayout` 按 id 查表不按 slug；`deriveLibraryAssets` 的 id 语义与
  "同 slug 不同身份拿到不同 id"。
- 迁移单测：v1/v2 → v3 改写、已是 v3 时幂等（用一份"错误"的映射表证明它不会被二次改写）、
  未知 slug 兜底、版本过新报错。

**已知遗留**

- tests 里没有真实 asset.json 的场景用例统一走 `sceneKey(slug) = slug:<slug>`（与服务端派生规则一致）。
- 服务端**不校验** patch 的键是否真是已知资产的 id（保持对测试夹具与旧客户端的宽容）；
  混用 slug 的风险由客户端测试兜住，而不是服务端拒绝。要更严的话可以在 `writeSceneLayout` 里
  对着 `assetIdsBySlug` 校验，代价是测试夹具都得先造资产。

### Phase 3：预算降级

| 文件 | 改动 |
| --- | --- |
| `app/src/shared/rendering/ResourceBudget.ts` | `MIN_CAPTURE_SIZE`、`captureSizeLadder()`、`reserveCapture(size, samples, reclaim, floor, pressure)`、`MemoryPressure` 探针、`downgrades` 读数；`stats` 形状与 `reserve()` 语义未动 |
| `app/src/shared/rendering/ModelResources.ts` | `memory` 读数（驻留/上限/超限/回收计数）、`trimToFit(needBytes)`、512 MiB 总驻留安全上限；`stats` 形状未动 |
| `app/src/shared/rendering/capture.ts` | 改调 `reserveCapture` 并传入 `modelPressure`；reclaim 按差额调 `trimToFit(needBytes)`；目标/读回/canvas 全用实际尺寸；`finally` 结算结构保留 |
| 测试 | `ResourceBudget.test.ts`（新）、`capture.test.ts`、`ModelResources.test.ts` 共新增 19 条 |

**验证**：`app` **343** pass / 0 fail，typecheck 通过。

**已知遗留**

- ✅ **已解决**（原先这里写的是"两本账不联动、reclaim 基本是 no-op"）：截图准入现在通过
  `MemoryPressure` 同时看模型侧余量，`trimToFit(needBytes)` 按差额回收空闲条目，因此
  "reclaim 后同尺寸重试"在模型侧是瓶颈时确实能救回全分辨率。回归测试见
  `ResourceBudget.test.ts` 的「截图准入与模型账本联动」三条。
- **512 MiB 的总驻留上限尚未在真实大场景里测量**：它是防"解码后的模型数据无限增长"的兜底，
  超限只回收空闲条目。若真实场景证明它会抖动（频繁回收→重新解码），应调高或改成按需触发。
- 未在真实 WebGPU 浏览器验证：单测对 2D context 打了桩，建议重跑 `capture.browser.ts` 与
  缩略图/四视角端到端。
- 降级是**静默**的：调用方会把 256 的图 `drawImage` 放大到 512 的格子，目前只能通过
  `captureBudget.downgrades` 察觉，没有 UI 提示。
- 这本账**不覆盖 splat**（`GaussianSplatRenderer` 不走 `ModelResources`），而已知风险恰在 splat。

### Phase 4：依赖图显式化

| 文件 | 改动 |
| --- | --- |
| `chat/src/services/sceneJobs.ts` | 抽出并导出 `planNodeInvalidation(nodes, nodeIds): {pending, stale}`；`retrySceneJobNodes` 改用它；`reviseSceneSpecAndJob` 保持原样 |
| `chat/src/services/sceneJobs.test.ts` | 新增 7 条（2 集成 + 5 纯函数） |

**验证**：`sceneJobs.test.ts` 10 pass / 0 fail；差分 fuzz 4000 组随机 DAG（含 obsolete、幽灵 id、
菱形）3736 个有效用例 0 mismatch，1721 个抛错用例的错误码与文案也一致。

**不复用 `reviseSceneSpecAndJob` 的理由**（已写进代码注释附近）：状态语义相反、要写新
`inputFingerprint`、要新建/废弃节点、对缺失节点是静默跳过而非抛错；另加一条测试锁定
"失效范围一致但状态语义不同"。

### 全量验证

`bun run check` 退出码 0：`chat` **341 pass / 0 fail**、`app` **343 pass / 0 fail**、`vite build` 通过。

**仍未验证**：真实浏览器里的交互——拖一下模型 → Cmd+Z 看画面回跳、撤销按钮提示文案、
截图降级在真机上的表现（含 512 MiB 驻留上限在真实大场景下会不会抖动）。单测覆盖的是状态与
调用序列，画面回跳依赖 React 重渲染 + `computeSceneLayout`，建议手工过一遍。

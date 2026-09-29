# 编辑器工程实践：外部资料与本项目的对应关系

本文回答一个问题：**业界那些做 3D 编辑器的公司，哪些经验对 ChatSpace 现在真的有用。**

判断依据不是"文章好不好"，而是"能不能对上仓库里已有的东西或已经暴露的空缺"。所有链接在文末标注了实测状态。

---

## 0. 一句话结论

外部资料里真正能落到 ChatSpace 上的，集中在 **5 个主题**：撤销重做、编辑器文档模型、WebGPU 渲染抽象与帧调度、大资产加载与内存分层、生成依赖图的增量重建。其余（协同编辑、参数化 CAD 内核、WebGL 调优、矢量几何结构）当前阶段可以直接跳过。

另一条同样重要的**负面结论**：Spline、Vectary、Womp、Bezi、Shapespark、Threekit 这些同类工具公司**没有可用的工程博客**（Spline 仅 2 篇，Vectary 62 篇全是教程/营销）。所以别再花时间在同行身上找架构经验——真正值得读的是 Figma（Web 编辑器）、Our Machinery（引擎编辑器）、Blender/Godot（开源编辑器）和 Zoo（约束求解）。

---

## 1. 项目现状盘点（相关性判断的依据）

| 维度 | 现状 | 对资料相关性的影响 |
| --- | --- | --- |
| 产品形态 | 对话驱动的 3D 场景生成与摆放，**不是建模/参数化 CAD** | 排除 CAD 内核类资料，只保留"引用稳定性"一条 |
| 前端 | React 19 + R3F 9 + three 0.186（两个 patch）+ Tailwind 4，83 个测试文件 | 编辑器 UI / 数据模型类资料适用 |
| 渲染 | **原生 WebGPU、无 WebGL 回退**；多窗格共享一个 renderer + 一份场景 + 多相机；`RenderSchedule` 单调度器；`CaptureQueue` 截图；`ResourceBudget` 估算账本 | WebGPU 类资料**直接对口**；WebGL 调优资料跳过 |
| 后端 | Bun + Hono + Mastra，26 个 tool，SSE + 持久任务 + SceneJob DAG | 依赖图 / 任务恢复类资料适用 |
| 数据 | `~/ChatSpace/projects/<slug>/`：project / scene / scene-spec(+revisions) / scene-jobs / tasks / assets | 文档模型类资料适用 |
| 场景落盘 | `scene.json` 两张稀疏表（`transforms`、`materials`），按 assetSlug **浅合并** | 这是当前最薄的一层，外部资料价值最高 |

### 1.1 本次实际检索确认的空缺

不是猜的，是查了代码：

1. **没有撤销重做**。全仓检索 `undo` / `redo` / 历史栈，无任何实现。目前拖动 gizmo、改材质、改变换都不可撤销。
2. **`scene.json` 没有版本与冲突语义**。写入是 `materials: { ...current?.materials, ...patch.materials }`（`chat/src/mastra/tools/projectTools.ts`），纯按键浅合并，后写覆盖先写。
3. **没有命令层 / 操作日志**。所有修改都是"直接写目标状态"，没有"改了什么"的记录，因此做不了批次撤销、审计或未来的协同。
4. **没有插件体系**。能力都以内置 tool 存在（26 个），第三方无法扩展。
5. **属性面板是手写的**。`Inspector/NumberField.tsx`、`Inspector/TextureChannels.tsx` 逐字段手写，没有 schema → UI 的自动生成。
6. 单机单用户，无协同（这是产品选择，不是缺陷）。

---

## 2. P0：现在就能用上的资料

### 2.1 撤销重做（最大的空缺）

**读什么**

- [Godot `EditorUndoRedoManager`](https://docs.godotengine.org/en/stable/classes/class_editorundoredomanager.html) — 撤销栈按场景隔离，而不是全局一个栈
- [Godot proposal #13427](https://github.com/godotengine/godot-proposals/issues/13427) — 进一步讨论"按文件独立历史"
- [The Document Model and The Machinery](https://web.archive.org/web/20180423044956if_/http://ourmachinery.com:80/post/the-document-model-and-the-machinery/) — 文档与撤销的绑定关系

**为什么对你特别有用**

你现在的 `app/src/widgets/Viewport/liveTransforms.ts` 已经是**两段式**：拖拽期间每帧写实时表（不触发 React 协调），结束时 `clear()` + commit 落盘。这正是撤销的天然切点——**在 `clear()` 之前把上一次已提交的 placement 压栈**即可，不需要重做整个交互模型。

**落地建议**

- 做 **command**（`setTransform` / `setMaterialChannel` / `setPlacement`）而不是全量快照。你的场景数据是稀疏表，快照退化很快。
- 栈要同时覆盖 `transforms` 和 `materials` 两张表——材质替换同样需要可撤销；`app/src/shared/lib/materialOverrides.ts` 的克隆逻辑会产生"派生材质"，撤销时要一并处理引用。
- 与服务端的浅合并语义对齐：撤销发出的是"反向 command"，不是"整份 scene.json 覆盖"，否则多窗格/多来源写入会互相抹掉。

### 2.2 编辑器文档模型：谁是唯一真相源

**读什么**

- [The Story behind The Truth: Designing a Data Model](https://web.archive.org/web/20220406212420/https://ourmachinery.com/post/the-story-behind-the-truth-designing-a-data-model/) — 运行时与编辑器共用一套对象模型、64 位稳定 id、原型系统
- [Bevy RFC 62: editor_data_model](https://raw.githubusercontent.com/bevyengine/rfcs/87e103b972c6d832cc51167a6bdf13ea14f220ea/rfcs/62-editor-data-model.md) — 编辑器数据模型与 ECS 的桥接
- [Machinery 博客全站镜像](https://ruby0x1.github.io/machinery_blog_archive/index.html)（原站已下线，这是唯一入口）

**为什么对你特别有用**

你现在有**三套 JSON 描述同一件事**：`scene.json`（视口摆放）、`scene-spec.json`（生成用场景事实，带 revisions）、`scene-jobs/<id>.json`（节点图）。`libraryPaths.ts` 的注释已经写明"避免两种 revision 互相污染"——这是有意识的分治，但缺一个统一的**身份与引用规则**：`assetSlug` 目前既是索引键也是引用，重命名/重生资产时没有稳定性保证。

The Truth 那篇正好讲这个：**稳定 id + 类型系统 + 原型**，且文档与磁盘序列化解耦。你可以对照检查三件事：

1. 资产身份是否稳定（slug 改名会不会打断 `transforms` / `materials` 的引用）
2. 文档状态与磁盘格式是否解耦（现在 `scene.json` 本身就是磁盘格式，没有中间层）
3. 谁有权改文档（现在路由、Agent tool、前端三方都能写 `scene.json`）

### 2.3 WebGPU 渲染抽象与帧调度（你已经在做，可做对照）

**读什么**

- [Figma Rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/) — WebGL→WebGPU 迁移、跨后端抽象层、compute shader 接替 CPU 端路径处理、批处理合并 draw call
- [Spline v2](https://blog.spline.design/spline-v2) — 渲染器重写、WebGPU 设为默认、PBR+IBL+HDR、draw overhead 与首帧优化

**为什么对你有用**

`WEBGPU_MIGRATION.md` §4.1–4.3 已经写了"一个 renderer、一份核心场景、多相机、视图脏标记、RenderTarget 缓存、静止场景不持续提交"。Figma 那篇讲的是**同一层问题**，可以作为你抽象层设计的对照与验证：他们的后端抽象怎么隔离差异、什么工作从 CPU 挪到了 compute。

**注意取舍**：Figma 的收益论证基于"超大文档 + 多人协同"，你的瓶颈在 **Splat 排序 + 多视口重复绘制**，两者不同。吸收的是抽象分层方法，不是性能结论。

### 2.4 大资产加载与内存分层

**读什么**

- [Figma 用 Rust 优化文件加载内存](https://www.figma.com/blog/supporting-faster-file-load-times-with-memory-optimizations-in-rust/) — 自定义内存布局降低分配压力，给出实测曲线
- [Figma 按页懒加载](https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/) — 先渲染可见部分，其余补齐
- [Photoshop 怎么处理超过内存的文件](https://developer.chrome.com/blog/how-photoshop-solved-working-with-files-larger-than-can-fit-into-memory) — OPFS / 磁盘缓存与内存分层
- [Photoshop on the web](https://web.dev/articles/ps-on-the-web) — C++ 上 Web 的完整路径（WASM/SIMD/多线程）

**为什么对你特别有用**

你已经有 `ResourceBudget`（估算账本 + 拒绝计数 + peak 记录）和分级队列（交互 > Agent 截图 > 缩略图）。卡在下一步：**超出预算时现在的实现是直接抛错**（`ResourceBudget.reserve` throw），而这三篇给的正是"超预算之后怎么办"——降级、分层、落盘、按需补齐。

结合你的资产类型（Splat、GLB、贴图组、World 环境），这是 M4 稳定性阶段的核心输入。

### 2.5 生成依赖图与增量重建

**读什么**

- [Creation Graphs](https://web.archive.org/web/20201215070003if_/https://ourmachinery.com/post/creation-graphs/) — 资产=依赖图，导入器即图节点，改一处增量重算下游

**为什么对你特别有用**

你的 SceneJob 已经是一个 DAG：节点记录输入指纹、尝试次数、产物、状态，支持 `revise-scene-job` 增补对象、`retry-scene-job-nodes` 只重跑 `plate` 并连带重建 World 与最终汇总。Creation Graphs 是同一思想的成熟工业化版本，**重点看它怎么定义"哪些下游被标脏"以及节点产物如何缓存复用**——你的"输入指纹"已经是这套机制的地基。

---

## 3. P1：值得提前读，但不用现在动手

| 主题 | 你的现状 | 读什么 | 什么时候读 |
| --- | --- | --- | --- |
| 属性面板自动化 | Inspector 手写逐字段 | [Writing Tools Faster](https://gdcvault.com/play/1026597/Tools-Summit-Writing-Tools-Faster)（工具热重载 + 面板数据驱动生成）、[Blender Node Interface Framework](https://developer.blender.org/docs/features/nodes/proposals/node_interface_framework/)（RNA 声明自动生成 UI） | 材质通道/资产类型再扩的时候 |
| 插件沙箱 | 26 个内置 tool，无扩展点 | [Figma 插件系统](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)（sandboxed iframe/Realms，崩溃不拖垮宿主）、[Canva Apps SDK](https://www.canva.dev/blog/engineering/how-we-built-the-canva-apps-sdk/) | 要做"用户自定义生成器/工具"时 |
| 语义化摆位 | 纯 gizmo 手摆 | [Spline v2](https://blog.spline.design/spline-v2)（near/apart/on top/facing 交给约束求解器）、[Zoo 草图约束求解器重写](https://docs.zoo.dev/blog/announcing-solver) | 想做"贴墙/贴地/并排"自动摆放时 |
| 引用稳定性 | 重跑节点会重建下游 | [FreeCAD 拓扑命名问题](https://wiki.freecad.org/Topological_naming_problem) | 当"重新生成后原有摆放丢失"成为真实抱怨时 |
| 引擎编辑器整体架构 | — | [Godot 编辑器开发简介](https://docs.godotengine.org/en/stable/engine_details/editor/introduction_to_editor_development.html)、[Unreal Slate 架构](https://dev.epicgames.com/documentation/en-us/unreal-engine/understanding-the-slate-ui-architecture-in-unreal-engine)、[PlayCanvas 编辑器前端开源](https://blog.playcanvas.com/playcanvas-editor-frontend-is-now-open-source/) | 想系统性补编辑器工程认知时 |

---

## 4. 当前可以跳过（附理由，避免反复评估）

| 资料 | 为什么跳过 |
| --- | --- |
| Figma Vector Networks | 你只摆放 GLB/Splat，不做矢量绘图 |
| KCL / CAD DSL、STEP/Parasolid、Onshape 架构建模 | 你是场景编辑，不是参数化建模 |
| Excalidraw P2P、Figma multiplayer/LiveGraph | 单机单用户，等真做多人再回来看 |
| Verge3D / Soft8Soft 的 WebGL 调优清单 | 你 WebGPU-only，无 WebGL 回退（draw call 合批思路仍通用） |
| 酷家乐 / 天猫 / 支付宝的云渲染与端上 Web3D | 他们是云渲染 + 服务端出图；你是本地 WebGPU 直渲 |
| tldraw / Excalidraw 的 2D canvas 分层 | 概念（视口裁剪、增量渲染）可参考，实现不可迁移 |
| Spline / Vectary / Womp / Bezi 博客 | 已逐类排查：无工程深度内容 |

---

## 5. 阅读顺序（对齐现有里程碑）

| 阶段 | 读 | 为什么此时读 |
| --- | --- | --- |
| **现在（M2 单视图完整编辑）** | The Document Model → The Truth → Godot UndoRedoManager → Figma WebGPU | 数据模型与撤销是同一件事的两面；渲染抽象用来对照 §4.2/4.3 |
| **M3 多视图与后台绘制** | Creation Graphs → Figma 按页懒加载 → Photoshop 大文件 | 依赖图 + 流式加载 + 内存分层 |
| **M4 稳定性与发布** | Figma Rust 内存优化 → web.dev 3D on the web → Slow Roads（LOD） | 预算、内存峰值、大场景 |
| **想省 UI 工时** | Writing Tools Faster → Blender Node Interface Framework | 属性面板自动化 |
| **未来（语义摆位 / 插件 / 协同）** | Spline v2 约束求解 → Figma 插件系统 → Figma multiplayer | 按需 |

---

## 6. 链接实测状态

本文链接于 2026-09-29 用 `curl` 实测（本会话 `web_fetch` 对所有域名失效，改用命令行）。

**全部实测 HTTP 200**：Machinery 镜像、The Document Model 与 The Truth 存档、Creation Graphs 存档、Figma（WebGPU / Rust 内存 / 插件系统 / multiplayer / Vector Networks）、Spline v2、Canva Behind the draw 与 Apps SDK、Photoshop 两篇、web.dev 3D on the web 与 Slow Roads、PlayCanvas 编辑器开源、Blender Node Interface Framework、Unreal Slate、Godot 编辑器开发简介 / `EditorUndoRedoManager` / proposal #13427、Bevy RFC 62、Zoo KCL 与约束求解器公告、FreeCAD 拓扑命名、GDC Writing Tools Faster、tldraw、Excalidraw P2P。

**限制**：链接可达性已实测，但**正文内容未逐页精读**——各条的"为什么对你有用"是基于标题、摘要与主题判断的，引用前建议先扫一遍原文。标为"存档"的链接是 archive.org 快照（ourmachinery.com 原站已下线），打开较慢但可用；日常阅读建议直接用 Machinery 全站镜像。

**已排除的误报**：搜索结果中"the tech behind Spline"指向 VALORANT 的武器皮肤 Spline，与 Spline 公司无关。

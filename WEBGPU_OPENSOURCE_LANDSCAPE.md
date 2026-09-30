# WebGPU 3D 编辑器 / 引擎 —— 开源代码landscape（面向 WebGPU-only 场景编辑器）

> 目标读者：本仓库（ChatSpace）的渲染/编辑器开发者。当前栈：three.js 0.186.1、WebGPU-only（无 WebGL 回退）、1/2/4 窗格多视口、Gaussian splat、gizmo、截图缩略图、GPU 时间戳剖析。
>
> 本文**只回答一个问题**：哪些开源仓库的**代码**真的能读，读哪些文件，能学到什么。
>
> 姊妹文档：`EDITOR_PRACTICES.md`（编辑器架构的**二手资料**：Figma / Godot / Blender / Our Machinery）。本文是它的补充，聚焦 **WebGPU 渲染层与 splat 编辑器的一手代码**，不重复其结论。

---

## 〇、核实状态说明（先读，否则会误用本文）

**本轮环境限制（实测）**：沙箱内**无公网**。

- `web_fetch` 对所有公网 URL 失败（`URL hostname "..." resolves to a non-public IP address`），`curl` 直连与经本地代理（127.0.0.1:7897）均超时。
- 所有域名（含 `github.com` / `raw.githubusercontent.com` / `deepwiki.com` / `example.com`）在本机 DNS 都解析到 `198.18.0.x`（fake-IP），因此 `web_fetch` 的 SSRF 防护一律拒绝。
- 唯一可用的外部信号是 `web_search`，且它**只返回标题 + URL，不返回正文**。

**因此本文的证据分两级，正文逐条标注：**

| 标记 | 含义 |
| --- | --- |
| ✅ **本机已核实** | 结论来自本机磁盘上的真实源码/文档，给出路径与行号，可直接打开对照 |
| 🟡 **高置信** | 我对该仓库/API 有确定认知，但**本轮无法联网逐字核对**；路径应视为"很可能是这个" |
| 🟠 **待确认** | 目录名/文件名/许可证属于回忆，**打开仓库后可能不同**，已显式标出 |
| ❓ **未能核实** | 本轮完全无法验证（仓库是否存在、是否开源、许可证），**不要据此下结论** |

**红线**：本文不发明仓库、文件、API。凡标 🟠/❓ 的，请以你打开仓库后的第一眼为准。

---

## 一、结论速览（按"能否直接借到东西"排序）

| 项目 | 与你的相关性 | WebGPU 真实性 | 许可证 |
| --- | --- | --- | --- |
| **three.js 0.186.1（本机源码）** | 你的实际栈；**自带一个 WebGPU GPU 剖析器** | ✅ 纯 WebGPU 后端可在本机逐行读 | MIT ✅ |
| **playcanvas/supersplat** | **最接近的同类：Web 端 splat 编辑器**（选区/工具/撤销/排序） | 引擎侧有 WebGPU；编辑器本身跨后端 | MIT 🟡 |
| **playcanvas/engine** | WebGPU 设备抽象 + render pass + **camera rect 多视口** + GSplat | ✅ 真实（官方发布过 WebGPU） | MIT 🟡 |
| **Orillusion/orillusion** | **唯一"WebGPU-only、无回退"的完整引擎**——与你的硬约束完全一致 | ✅ 纯 WebGPU（无 WebGL） | MIT 🟠 |
| **gaussian-splat-lite 1.1.5（本机）** | 你正在用的 splat 渲染器，**含 WebGPU compute 投影 + GPU radix sort** | ✅ 本机 docs 明写 | Apache-2.0 ✅ |
| **sparkjsdev/spark** | splat 渲染的第三种排序策略（Worker + WASM） | ❌ **2.1.0 是纯 WebGL**（本机核实） | MIT ✅（本机 LICENSE） |
| galacean/engine | WebGL/WebGPU 后端抽象（RHI）参考 | 🟠 需打开仓库确认后端目录 | MIT 🟠 |
| cocos/cocos-engine | `gfx/webgpu` 后端；**编辑器不开源** | 🟡 WebGPU 后端真实存在 | MIT 🟡 |
| needle-tools/needle-engine-support | 只有文档，**引擎源码不在此仓库** | 🟠 基于 three.js | 文档仓库 🟠 |

---

## 二、逐项详解

### 1. three.js 0.186.1 —— 你的栈本身就是最好的第一读物（✅ 全部本机已核实）

- 仓库：https://github.com/mrdoob/three.js （MIT）
- 本机权威副本：`node_modules/three` → `.bun/three@0.186.1/node_modules/three`（`node_modules/three` 已是软链，指向运行时同一份 ✅）

**WebGPU 成熟度：✅ 已核实。** `src/renderers/webgpu/WebGPUBackend.js` 3281 行，是完整的 WebGPU 后端，不是路线图。

#### 1.1 必读文件（本机路径 + 行号）

| 文件 | 行 | 读什么 |
| --- | --- | --- |
| `node_modules/three/src/renderers/webgpu/WebGPUBackend.js` | **2231–2310** | **多视口核心**：`ArrayCamera` 路径。对每个子相机 `setViewport(floor(vp.x*pr), floor(vp.y*pr), floor(vp.width*pr), floor(vp.height*pr))`，并按 `cameraIndex` bind group 逐眼切换；`object.layers.test(subCamera.layers)` 做逐窗格过滤。**一次 pass、N 次 draw** |
| 同上 | **2283** | ⚠️ **陷阱**：`GPURenderBundleEncoder` 不支持 `setViewport`，只有 `GPURenderPassEncoder` 支持。所以多视口图层走不了 render bundle，three 为**每个子相机单独建一个 bundle encoder**（`renderContextData.bundleEncoders[i]`） |
| 同上 | **1464–1481** | 分层（layer）render pass 路径：逐层 `beginRenderPass` + `setViewport`/`setScissorRect` + `executeBundles` |
| 同上 | **2581–2605** | `initTimestampQuery()`：把时间戳写进 render pass 描述符（`beginningOfPassWriteIndex` / `endOfPassWriteIndex`），**池容量硬编码 2048**（`:2592`） |
| 同上 | **298** | `this.trackTimestamp = this.trackTimestamp && this.hasFeature(GPUFeatureName.TimestampQuery)`——**必须在 device 构造时决定**，事后无法开。这正是本仓库 `?gpuTimestamps=1` 必须在 `backend` 构造时读的原因 |
| 同上 | **394** | `get hasTimestamp() { return true; }`——**WebGPU 后端恒为 true**，不做真实能力探测（真正的门在 `:298`） |
| 同上 | **1425** | 注释级陷阱：viewport texture 是 2D，每一层必须在**该层采样它之前**被抓取（跨层依赖的顺序约束） |
| `node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js` | **34–70** | querySet(`count=2048`) + `resolveBuffer`(QUERY_RESOLVE\|COPY_SRC) + `resultBuffer`(COPY_DST\|MAP_READ) |
| 同上 | **~78–90** | `allocateQueriesForContext()`：**写满就 `resolveQueriesAsync()` 并把 `currentQueryIndex` 归零**——这就是"跨池重置可能读到陈旧值"的机制本体 |
| `node_modules/three/src/renderers/common/TimestampQueryPool.js` | 全文 | `pendingResolve` 既是布尔又是 Promise（WebGPU 存 Promise）；`getTimestamp()` 对未知 uid 返回 0 并 `warn('No timestamp available for uid ...')`——**headless 读出 0 时的第一现场证据** |
| `node_modules/three/src/renderers/common/Renderer.js` | **2270–2345** | `setScissor` / `setScissorTest` / `setViewport` / `getViewport` 的公开入口（都转发给 `_canvasTarget`） |
| 同上 | **1622–1632** | viewport 在 output render target 路径上**乘 pixelRatio**；`frameBufferTarget.viewport.copy(viewport)` |
| 同上 | **1787** | `renderContext.viewport = renderContext.viewportValue.equals(_screen) === false`——**只有非全屏才置 viewport 标志**，全屏时不会多余调用 `setViewport` |
| 同上 | **3033–3041** | ⚠️ `hasFeature()` 在 `renderer.init()` 之前**抛异常**（不是返回 false）。任何"先探测能力再决定初始化参数"的写法都会踩 |
| 同上 | **3225–3229** | `readRenderTargetPixelsAsync()` → `backend.copyTextureToBuffer()`：**缩略图读回的官方路径** |
| `node_modules/three/src/renderers/webgpu/utils/WebGPUTextureUtils.js` | **812–815** | 读回时的 **256 字节行对齐**：`bytesPerRow = ceil(w*bpp/256)*256`，且 buffer size 用 `(height-1)*bytesPerRow + width*bpp`（不是 `h*bytesPerRow`）。本仓库 `capture.ts` 的"GPU 行填充解包"就是这件事 |
| `node_modules/three/src/renderers/common/RendererUtils.js` | **14–210** | `saveRendererState` / `resetRendererAndSceneState` / `restoreRendererAndSceneState`——**离屏截图与调试渲染的状态保存/还原三件套** |
| `node_modules/three/src/renderers/common/RenderList.js` | **400–404** | `sort(customOpaqueSort, customTransparentSort)`；`Renderer.setOpaqueSort/setTransparentSort`（`Renderer.js:2233/2245`）。**自定义排序的官方注入点** |
| `node_modules/three/src/renderers/common/RenderLists.js` | 全文 | render list 按 **(scene, camera, lighting) 三元组**分桶（`ChainMap`）。**含义：N 个相机 = N 份 render list / N 次投影+排序**，即使只有 1 次 `render()` |
| `node_modules/three/src/cameras/ArrayCamera.js` | 全文 | 文档明写：**"必须为每个子相机定义 `viewport` 属性"**。这就是多窗格的契约 |

#### 1.2 three 自带的 WebGPU 剖析器（**本轮最大发现**）

`node_modules/three/examples/jsm/inspector/` —— **1380 行，MIT，随 three 0.186.1 一起发布**。

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `examples/jsm/inspector/RendererInspector.js` | 589 | **完整的 GPU 时间戳剖析器**（frame → render → compute → node 四级层次） |
| `examples/jsm/inspector/Inspector.js` | 684 | 剖析器外壳/面板挂载 |
| `examples/jsm/inspector/InspectorBase.js` | 180 | 钩子契约：`begin/finish`、`beginRender/finishRender`、`beginCompute/finishCompute`、`inspect(node)`、`dispose()` |
| `examples/jsm/inspector/tabs/Performance.js` | — | UI：`Name / CPU / GPU / Total` 表格 + fps/cpu/gpu 三条曲线 |
| `examples/jsm/inspector/tabs/Timeline.js` | — | 逐帧调用时间线（可录帧） |
| `examples/jsm/inspector/ui/Profiler.js`、`ui/Graph.js`、`ui/List.js` | — | 面板组件（**与你的 `widgets/Inspector` 同层，可直接抄 UI 结构**） |
| `examples/jsm/inspector/extensions/tsl-graph/`、`color-grading/` | — | **插件式扩展的范例**（编辑器插件沙箱的参考实现） |

`RendererInspector` 里可直接搬走的四件事（均已核实）：

1. **把 resolve 推迟到下一个 rAF**，避免同步卡顿：
   ```js
   this._rAFId = requestAnimationFrame( async () => { ... await renderer.resolveTimestampsAsync(...) } );
   ```
   并且用 `_resolveTimestampPromise` 做**并发去重**（同一时刻只有一个 resolve 在飞）。
2. **render 与 compute 分开解析**：`renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE)` 与 `(TimestampQuery.RENDER)` 两次调用（`TimestampQuery` 是 three 的真实导出，含 `RENDER`/`COMPUTE`）。
3. **能力缺失时的降级**：`if (renderer.backend.hasTimestamp) {...} else { 把每帧 gpu 置 0 并标 gpuNotAvailable = true }`——**这正好对应你"headless 静默返回 0"的症状**；它把"0"显式标成"不可用"，而不是当成"很快"。
4. **overdraw 可视化**：`scene.overrideMaterial` + `MeshBasicNodeMaterial{ colorNode: vec3(0.25), blending: AdditiveBlending }` + `RendererUtils.resetRendererAndSceneState/restore...`，并在渲染前把 `toneMapping = NoToneMapping`、`outputColorSpace = LinearSRGBColorSpace` 以保证计数线性。**这与"用 override material 出一张 ID/flat 缩略图"是同一个技巧。**
5. 帧环形缓冲：`maxFrames = 512`，超出 `shift()` 并同步删 `framesLib` 条目。

**注意**：`RendererInspector` 的 CPU 时间是 `performance.now()` 包 `beginRender/finishRender`。**它是 CPU 侧提交耗时，不是 GPU 时间**——与 `WEBGPU_FINDINGS.md` §1 第 5 条同一条纪律，不要混用。

#### 1.3 可直接落到本仓库的 4 条教训

1. **多视口**：你的 `ArrayCamera` 方案与 three 内部路径完全对齐（`WebGPUBackend.js:2231`）。**要盯住的回归点是 `ARRAY_CAMERA_CAPACITY` 恒定** —— `cameraProjectionMatrices` 按建时的相机数定容，这解释了 `paneViewports.ts` 里那条不可改的约束。另外 `RenderLists.js` 的 (scene, camera, lighting) 分桶说明：**你把 N 个窗格并进一个 `ArrayCamera` 是省掉 N 份 render list 的关键**，这比"省一次 `gl.render()`"更本质。
2. **每帧命令编码开销**：three 在 array camera 下**为每个子相机各建一个 bundle encoder**（`:2283` 那条不支持 `setViewport` 的限制）。若你想给窗格加 render bundle，先确认这条路——`setViewport` 不能进 bundle。你现有的"`PaneGizmo` 用 `autoClearDepth` 把 `clearDepth` 折进 pass 的 `depthLoadOp`"方向一致：**减少 pass/encoder 数量比减少 draw 更重要**。
3. **缩略图**：直接复用 `RendererUtils.resetRendererAndSceneState/restore...`（比自己手写"存 renderTarget/override/排序状态再还原"更不容易漏），读回走 `readRenderTargetPixelsAsync`，**并确认 256 字节行对齐与 `(h-1)*bpr + w*bpp` 的 buffer size 公式**（`WebGPUTextureUtils.js:812-815`）。
4. **GPU 剖析**：**先把 `examples/jsm/inspector/` 读一遍再决定要不要自己写剖析 UI**。它已经解决了"每个 render pass 一对时间戳 + rAF 里 resolve + 并发去重 + 缺失时标不可用"这四个问题，而你的 `gpuProbe.ts` 正在独立重造。**但注意分辨率边界**：池只有 2048，写满即 resolve 并归零（`WebGPUTimestampQueryPool.js` 的 `allocateQueriesForContext`），这与你 `WEBGPU_PROBE_PROTOCOL.md` §5.15 记的"采样率上限约 5 Hz、一次 resolve 覆盖 2–9 个应用帧"是同一个硬边界。

---

### 2. playcanvas/supersplat —— 最接近的同类：Web 端 splat 编辑器

- 仓库：https://github.com/playcanvas/supersplat
- 许可证：MIT 🟡（PlayCanvas 全线 MIT；本轮未能打开 LICENSE 确认）
- 技术栈：Vite + TypeScript，构建在 PlayCanvas engine（`playcanvas` npm）之上 🟡

**WebGPU 成熟度：🟠 待确认。** 编辑器**自身**的渲染走 PlayCanvas engine，因此"是否吃 WebGPU"取决于引擎后端选择（见下一节）。我**未能核实** SuperSplat 是否暴露了 WebGPU 开关。

**⚠️ 明确纠正一个可能的期待**：据我所知 SuperSplat **不是多视口编辑器**（单一 viewport + 相机模式切换），**也没有 1/2/4 窗格**。1/2/4 窗格要参考 PlayCanvas Editor 与 drei `View`（见 §8）。**此项置信度低，请以仓库实际为准。**

#### 2.1 值得读的目录/文件（🟠 路径待确认，按主题分组）

| 主题 | 预期路径 | 为什么值钱 |
| --- | --- | --- |
| 编辑器主体 | `src/editor.ts`（`Editor` 类） | 场景、相机、选区、事件总线、撤销的汇合点 |
| 场景/数据 | `src/scene.ts`（`Scene` 类）、`src/splat.ts` | splat 数据容器的增删改，编辑操作的作用对象 |
| **撤销/历史** | `src/scene-manager.ts` 或 `src/history.ts` 🟠 | ✅ **有旁证**：DeepWiki 的 `playcanvas/supersplat` §4.3 标题就是 **"Edit History and Undo System"** 且锚点是 `scene-manager`（https://deepwiki.com/playcanvas/supersplat/4.3-scene-manager ）。**说明撤销系统真实存在，且很可能由一个 "Scene Manager" 实体拥有** |
| 编辑算子 | `src/edit/`（如 `delete-selection` / `transform-selection` / `color-selection`）🟠 | **纯函数式地作用于 splat 数组**，天然可做成"命令 + 逆命令" |
| 工具 | `src/tools/`（select / move / rotate / scale / measure / brush / flood）🟠 | 工具生命周期与 gizmo 交互的分层 |
| UI | `src/ui/`（`right-panel` / `scene-panel` / `view-panel` / `timeline-panel` / `menu` / `popup` / `shortcuts`）🟠 | 多面板 UI 的状态组织；与你的 `widgets/Inspector` 可直接对照 |
| IO | `src/io/`（`read` / `write` / `drop-handler`）🟠 | ply/sog/ksplat 读写与拖放 |
| 序列化 | `src/serialize.ts` 🟠 | 文档模型 → 文件 |

#### 2.2 排序（splat sorting）—— SuperSplat 侧的机制

🟠 **待确认细节**。高置信的部分：SuperSplat 的 splat 渲染由 **PlayCanvas engine 的 GSplat 子系统**承担，因此排序发生在引擎里（见下一节），而不是编辑器里。编辑器只负责"编辑后标脏"。

来源旁证（✅ 本机核实，`gaussian-splat-lite` README:185）：

> "The overall architecture of Gaussian Splat Lite draws on **[Spark]** and **[SuperSplat]**."

即：**你正在用的 splat 渲染器的架构就是抄 Spark + SuperSplat 的**。这条把"该读哪两个仓库"从建议变成了直接的技术血缘。

#### 2.3 可直接落到本仓库的 4 条教训

1. **编辑态与渲染态分离**：SuperSplat 的编辑算子作用在 CPU 侧 splat 数组上，渲染器只消费"当前数据 + 脏标记"（🟠 待确认，但与 engine GSplat 的分工一致）。你的 `SplatModel` 单实例服务全部窗格，**同样应该让"编辑"只写数据 + 置脏**，绝不让 UI 直接触碰 GPU 缓冲区。
2. **撤销必须记逆增量，不能记快照**：splat 的删除/改色动辄百万级元素，全量快照会瞬间打爆显存。可读形态是"**索引列表 + 改前值**"（配合 `Uint8Array` 选区掩码）。这与你 `EDITOR_PRACTICES.md` 里 Godot `EditorUndoRedoManager` 的结论互为印证：**命令对象 + 逆操作，作用域是选区而非全场景**。
3. **选区是一等公民**：删除/变换/上色都接受"同一个选区掩码"。**把选区做成 `Uint8Array(n)` 或索引 `Set` 的单一真相**，Undo 时恢复选区本身就是一步操作（用户预期撤销会连选区一起回退）。
4. **排序与编辑解耦**：编辑完成后**只标脏，不立即同步排序**。你的 GSL 1.1.5 在原生 WebGPU 路径上 `synchronousSort` 每帧排序（见 §4），编辑期间连续同步排序会把帧时间从 16.7 ms 推到 100–150 ms（你的 AGENTS.md 已确认）。**SuperSplat 的思路是"编辑完成再排"**，而不是每改一个点排一次。

---

### 3. playcanvas/engine —— WebGPU 设备抽象 + camera rect 多视口 + GSplat

- 仓库：https://github.com/playcanvas/engine
- 许可证：MIT 🟡（高置信，但本轮未打开 LICENSE）
- 旁证（web_search 命中）：官方博客 [Build WebGPU Apps Today with PlayCanvas](https://blog.playcanvas.com/build-webgpu-apps-today-with-playcanvas/)，以及 Khronos 演讲 [WebGPU PlayCanvas, July 2023 — Martin Valigursky](https://www.khronos.org/assets/uploads/developers/presentations/WebGPU_PlayCanvas_July_2023_-_Martin_Valigursky.pdf)。

**WebGPU 成熟度：🟡 高置信（真实存在，非路线图）**，且是**"同一套高层 API、双后端"**的成熟范例——与 three 的 `Renderer`/`Backend` 分层是同一思路的另一种解法。

#### 3.1 值得读的目录/文件（🟠 文件名待确认，目录 🟡）

| 主题 | 预期路径 | 为什么值钱 |
| --- | --- | --- |
| **WebGPU 设备** | `src/platform/graphics/webgpu/`（核心类 `webgpu-graphics-device.js` → `WebgpuGraphicsDevice`）🟡 | 你会看到一个**真实的 WebGPU 设备封装**要处理多少东西（adapter/device 获取、queue、limits、caps 探测、feature 协商），可直接对照你的 `WebGPUBackend` 用法 |
| WebGPU 子模块 | 同目录下 `webgpu-render-target.js` / `webgpu-vertex-buffer-layout.js` / `webgpu-bind-group-format.js` / `webgpu-upload-stream.js` / `webgpu-compute.js` / `webgpu-shader-processor.js` 🟠 | 每一项都是一个独立的适配器；**尤其 `upload-stream`（上传流）与 `bind-group-format`（管线布局缓存）值得对照你的 `Bindings`/`Pipelines`** |
| GL 后端（对照） | `src/platform/graphics/webgl/webgl-graphics-device.js` 🟡 | 抽象边界在哪：**哪些是设备无关的、哪些被迫分支** |
| 设备基类 | `src/platform/graphics/graphics-device.js` 🟡 | 后端无关基类，定义 viewport/scissor/clear/render-target 的公共契约 |
| **render pass** | `src/platform/graphics/render-pass.js`，以及 `render-pass-forward.js` / `render-pass-compose.js` 🟡 | **"pass 为一等对象"**的模型（three 里 pass 是 backend 内部实现细节）。你要控制每帧 pass 数量时，这个模型更好推理 |
| 计算 | `src/platform/graphics/compute.js` + `webgpu/webgpu-compute.js` 🟠 | compute pass 的一等封装（splat 排序会用到） |
| **GPU 计时** | `ScopeSpace` / `ScopeId`（GPU 作用域计时，`begin/end` 嵌套）🟠 | ⚠️ **待确认**。若属实，这是比 three "每 pass 一对时间戳"**更细的模型**（可嵌套作用域），对你的剖析器设计有直接参考价值 |
| **多相机视口** | `camera.rect`（**归一化 0..1 的 `Vec4`**）+ `camera.scissorRect` + `calculateAspectRatio()` 🟡 | **多视口的另一种 API 设计**（见 3.2） |
| GSplat | engine 的 GSplat 子系统（`GSplat` / `GSplatComponent` / 排序 worker）🟠 | SuperSplat 的渲染底座 |
| **gizmo** | `src/extras/gizmo/`（`transform-gizmo.js` / `translate-gizmo.js` / `rotate-gizmo.js` / `scale-gizmo.js`）🟠 | 引擎级 gizmo 的取舍：挂在引擎而不是编辑器里 |
| 编辑器本体 | https://github.com/playcanvas/editor —— **已开源** 🟡 | 旁证：官方博客 [PlayCanvas Editor Frontend is now Open Source](https://blog.playcanvas.com/playcanvas-editor-frontend-is-now-open-source/) |

#### 3.2 ⭐ 一条高价值对比：camera `rect` vs three 的 `ArrayCamera.viewport`

- **PlayCanvas**：相机自带 **归一化** `rect`（0..1）+ `scissorRect`；forward render pass 遍历相机、逐相机设 viewport/scissor，**首帧清屏一次**。
- **three**：由**你**给每个 `ArrayCamera` 子相机的 `.viewport` 赋**像素**值（`ArrayCamera.js` 文档明确要求），three 再乘 `pixelRatio` 并 `floor()`（`WebGPUBackend.js:2291-2296`）。

**教训**：**在编辑器状态里存归一化 rect，不要存像素 rect**。理由：(a) 布局切换（1/2/4 窗格）与容器 resize 只需要重算一次乘法；(b) DPR 变化不需要重算布局；(c) 归一化值可以在"窗格定义"和"渲染"之间做单一真相。像素 rect 一旦存进状态，就会出现"DPR 改了但窗格没改"的裂缝——而且 `Math.floor` 的时机不对会差一个像素。

#### 3.3 可直接落到本仓库的 4 条教训

1. **多视口**：**把窗格布局 (1/2/4) 定义成归一化 rect 的纯数据**（你已有 `paneLayouts.ts`），渲染时再乘 `drawingBufferSize` 并 floor。这与 three 的契约一致（`ArrayCamera.js` 要求 `.viewport`），同时避免 DPR/分辨率耦合。
2. **每帧编码开销**：**pass 一等化**。检查你现在的帧顺序（Clear → 核心场景 → overlay → HUD）里，**是否每个窗格的 overlay/HUD 都必须是一个独立 pass**。PlayCanvas 用"一个 forward pass 遍历相机"来表达多视口；你已有 ArrayCamera 把核心场景并成 1 趟——**overlay/HUD 是否可以按"同一 pass 内逐窗格设 viewport/scissor + 分层 draw"合并**，值得按 `render-pass-forward.js` 的思路评估。（前提：`autoClear` 组合语义要想清楚，见你 AGENTS.md 里那条"四个 flag 成套改"的警告。）
3. **splat 排序**：PlayCanvas 的 GSplat 与你的 GSL 是同一族方案。**重点读它的"编辑后排序"触发条件**（脏标记 vs 每帧），对照你 `synchronousSort` 的病根。
4. **GPU 剖析**：若 `ScopeSpace`/`ScopeId` 属实，**"可嵌套的计时作用域"比"每 pass 时间戳"更适合编辑器**——因为你要区分的是"窗格 1 的 core / overlay / HUD"这种层级，而不是扁平的 pass 列表。

---

### 4. Orillusion/orillusion —— 与你的硬约束完全一致：WebGPU-only、无回退

- 仓库：https://github.com/Orillusion/orillusion
- 许可证：🟠 待确认（很可能是 MIT）
- 官方定位（web_search 摘要原文）：*"a pure Web3D rendering engine which is fully developed based on the WebGPU standard"*
- 旁证：`Orillusion/orillusion-webgpu-samples`（samples 仓库）、`Orillusion/orillusion-web`（web_search 命中 related repos）

**WebGPU 成熟度：🟡 高置信 —— 这是"纯度"最高的一个**。它不是"支持 WebGPU"，而是**只支持 WebGPU**。**对你的价值就在这一点**：任何"WebGL 也能跑"的引擎都会把 WebGPU 特有路径藏进抽象层；Orillusion 不需要，所以它的 render graph / compute 代码是**直接暴露 WebGPU 语义**的。

#### 4.1 值得读的目录/文件（🟠 全部待确认）

| 主题 | 预期路径 | 为什么值钱 |
| --- | --- | --- |
| **WebGPU 封装** | `src/gfx/`（`WebGPUDevice` / `GPUDevice` / `RenderPass` / `ComputePass` / `CommandEncoder`）🟠 | 无回退场景下的**最小设备封装**长什么样 |
| **渲染管线** | `src/rendering/`（`Renderer`、`RenderShaderPass`、`RendererPass`、`PassType`）🟠 | **`RenderShaderPass` / `RendererPass` 的双层结构**：一个"shader pass"描述一篇着色，一个"renderer pass"描述一次提交——这是把"每帧几次 encoder/pass"变成可推理对象的模型 |
| **渲染图** | `src/rendering/renderJob/` 或 `RenderGraph` 相关 🟠 | 节点式渲染调度；**正是你"三层 priority 帧顺序"的另一种表达**（你的 `RenderSchedule.draw()` 本质是个手写 render graph） |
| **compute** | `src/gfx/` / `src/rendering/` 里的 compute pass 封装 🟠 | WebGPU compute 的一等支持（splat 排序/prepass 会用） |
| **多视图** | `View3D`（camera + viewport rect 的打包）；`Camera3D` 的 viewPort rect 🟠 | **"pane = View3D"** 的建模方式，与你的 `WebGPUView` 概念同构 |
| **GUI 到纹理** | `GUICanvas`（把 DOM/Canvas 画进纹理）🟠 | 编辑器 HUD/标签的另一种实现路径 |
| **编辑器** | `Orillusion/editor`、`Orillusion/orillusion-editor` —— ❓ **本轮完全未能核实是否存在公开仓库** | 请勿据此认为有或没有 |

#### 4.2 可直接落到本仓库的 4 条教训

1. **多视口**：把你的**"窗格"建模成对象**（camera + viewport rect + 自己的 overlay/HUD 场景），而不是"一个 ArrayCamera 加 4 个数组槽位"。你现在的 `ARRAY_CAMERA_CAPACITY = 4` 恒定槽位是 three 的约束（正确且必须保留），但**编辑器状态层不该复用这个表达**——状态层用"窗格列表"，渲染层再投影成固定容量的 ArrayCamera。Orillusion 的 `View3D` 就是这个分层。
2. **每帧编码开销**：**读它的 render graph 如何决定 pass 数量**。你的 `RenderSchedule` 是 priority 排序的三段式；render graph 的静态拓扑能在编译期就定下"哪些节点可以合进同一 pass"。**不要求你改成 render graph**，但值得看它怎么把"有可绘制对象才 render"（你的 `hasDrawableContent`）表达成图上的空节点消除。
3. **splat 排序**：无回退的引擎里，排序只能走 compute。**读它 compute pass 的 dispatch 尺寸与 buffer 复用策略**，对照你 GSL 的 `RadixSort`（§5）。
4. **GPU 剖析**：纯 WebGPU 引擎**没有 WebGL 的计时包袱**，它的时间戳集成方式（每个 pass 都带 `timestampWrites`？还是可选作用域？）可以直接借用为"每个窗格每层一对时间戳"的设计。

**⚠️ 反面提醒**：Orillusion 的**抽象层是它自己的**，与 three 的节点系统（TSL）不兼容。**读它的设计意图，不要试图移植它的代码**。

---

### 5. gaussian-splat-lite 1.1.5 —— 你正在用的 splat 渲染器（✅ 本机已核实）

- npm 包（本机）：`node_modules/.bun/gaussian-splat-lite@1.1.5+a39cd20facce8359/node_modules/gaussian-splat-lite`
- 仓库（✅ 来自 package.json + README badge）：https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite
- 许可证：**Apache-2.0 ✅**（本机 `LICENSE` 全文 + `README.md:187-189`）
- **本机只有 `dist/`（含 `.js.map`）+ `docs/`，没有 `src/`**——但 `docs/Architecture.md` 有到 `../src/...` 的链接，且文档按源码目录组织，**足以当作仓库结构的权威二手描述**。

#### 5.1 `docs/Architecture.md` 给出的渲染分层（✅ 本机已核实，逐字）

| 目录 | 职责（原文） |
| --- | --- |
| `src/rendering/` | "Shared updates, sorting handoffs, depth, captures, and stochastic resolve" |
| `src/rendering/webgl/` | "GLSL materials, texture generation, **CPU ordering uploads**, and readback" |
| `src/rendering/tsl/` | "Shared TSL generation, projection, drawing, resolve, and view uniforms" |
| **`src/rendering/webgpu/`** | "**Compute projection, projected caches, GPU sorting, and indirect drawing**" |
| `src/rendering/webgl-fallback/` | "WebGPURenderer WebGL2 raster generation and ordering uploads" |

具体文件（✅ 文档点名）：

- `src/rendering/webgpu/ProjectedSplats.ts` —— "coordinates projection and sorting"
- `src/rendering/webgpu/ProjectionCache.ts` —— "owns projected storage"
- `src/rendering/webgpu/RadixSort.ts` —— "**owns sort passes**"
- `src/rendering/webgl/OrderingTexture.ts` —— "allocation and disposal"（两个 WebGL 后端共享）

**排序策略对照（✅ 文档原文）**：

> "For sorted rendering, both WebGL backends use **asynchronous Worker/WASM sorting and retain the previous display until a matching order is ready**. **Native WebGPU keeps ordering and visible counts on the GPU and sorts before drawing**; its accumulator carries mappings and edit metadata without generating combined textures. **Stochastic rendering skips sorting.**"

**这就是你那个性能问题的机制本体**：WebGL 路径有"**旧序继续显示，等新序就绪**"的双缓冲握手，而原生 WebGPU 路径**在绘制前同步排序**。你实测的"拖动时 p50 从 16.7 ms 恶化到 100–150 ms"（AGENTS.md §六）正是后者。

#### 5.2 其他 ✅ 本机已核实的可用事实

| 事实 | 出处 | 对你的意义 |
| --- | --- | --- |
| `minSortIntervalMs` 默认 0，**"unused on native WebGPU"** | `docs/GaussianSplatRenderer.md` | **你无法用这个旋钮给 WebGPU 排序限频**。想限频只能改 GSL 源码（你已有 patch 机制）或换策略 |
| `fastSort` 默认 `true`，**"Lower-precision sorting on WebGPU and WebGL"** | 同上 | 它**在 WebGPU 上也生效**——这是一个可调的画质/性能档 |
| `sortRadial`（按距离 vs 按相机深度） | 同上 | 两种排序键 |
| `stochastic` / `autoStochastic`：**stochastic 完全跳过排序**；"Automatic switching requires `autoUpdate` and is disabled in WebXR"；"**captures use sorted rendering**" | 同上 | **这是唯一"不排序"的官方逃生门**；同时说明**截图/缩略图永远走排序路径**（缩略图会付排序成本，做队列是正确的） |
| `target: { width, height, doubleBuffer, **superXY** }`，`superXY` 1–4，**每维乘 superXY 必须 ≤ 8192**；`renderReadTarget()` 返回 RGBA `Uint8Array` | 同上 | **超采样缩略图的官方实现**：渲染 2× 再降采样，明确的上限约束 |
| "If a display renderer shares the scene, use `layers` or `visible` to keep both Splat renderers from drawing in the same pass." | 同上 | **缩略图离屏渲染器必须用 layer 隔离**，否则会重复绘制 |
| `SplatCapture`："Offscreen targets, supersampled readback, cube captures, and environment-map filtering"；"**Capture scopes restore the renderer override, render target, and sorted-render state after use.**" | `docs/Architecture.md` | 截图的状态还原是**必须**的（排序状态/override/render target 三样） |
| 资源规则："**Wait for outstanding GPU compilation before disposing the sorter; preserve compute nodes when resizing resources or changing source meshes.**" | 同上 | **解释了你 AGENTS.md §七 里"设备丢失重建/异步回调写入被取代的代次"那条**：排序器与 compute node 的生命周期必须跨 resize/换模型保留 |
| `StochasticResolvePass`：噪声抑制 + "**XR eye layout**, and renderer-state restoration"；`StochasticTAAPass.md` 有 **"ArrayCamera and WebXR"** 一节："**Each view has independent history**"；"Memory and rendering work increase with the number and resolution of views." | `docs/Architecture.md`、`docs/StochasticTAAPass.md` | **这是 GSL 官方的多视图支持说明**：每眼独立历史缓冲 → **N 个窗格 = N 份 TAA 历史**，内存与算力随视图数线性增长。这正是你 ≥3 视图塌缩要检查的地方之一（但注意：**这是 stochastic 路径，不是 sorted 路径**） |
| README:185："The overall architecture of Gaussian Splat Lite draws on **Spark** and **SuperSplat**." | `README.md:185` | 见 §2.2 |

#### 5.3 可直接落到本仓库的 4 条教训

1. **splat 排序**：**WebGL 路径的"旧序继续显示"是更好的 UX，把它移植到 WebGPU 是本仓库最值得做的一件事**。做法方向（需自行设计）：compute 排序写进 **第二块 order buffer**，与当前显示用的 buffer 交换，**绝不回读**、绝不阻塞。文档明确说 WebGL 路径就是这么做的，而 WebGPU 路径"keeps ordering on the GPU"——**你要的是两者的交集：GPU 上排序 + 双缓冲**。
2. **多视口**：**区分 sorted 路径与 stochastic 路径的多视图成本**。`StochasticTAAPass` 的"每眼独立 history"是 stochastic 特有的；sorted 路径下（你现在的 multiView 单实例）GSL 用 `cameraIndex` 在**同一条 compute 链**里逐眼排序。**排查 ≥3 视图塌缩时，先确认走的是哪条路径**——你在 `WEBGPU_PROBE_PROTOCOL.md` §5.13 的"下一步"里已经指出 motion 漏掉了多视图排序路径，方向一致。
3. **缩略图**：**`superXY` + `SplatCapture` 的状态还原是一个可以整段借鉴的模型**：(a) 离屏 renderer 用 `layers`/`visible` 与显示路径隔离；(b) 渲染在 `superXY` 倍分辨率再降采样，硬上限 8192；(c) capture 作用域结束时还原 renderer override / render target / **sorted-render 状态**。你的 `CaptureQueue` + `capture.ts` 已经有队列与老化，**缺的正是 (c) 里"排序状态"那一项**——如果排序是每帧同步的，截图时打断排序状态会很危险。
4. **GPU 剖析**：GSL 把排序拆成独立的 compute pass（`RadixSort.ts` "owns sort passes"）。**这些 pass 是你最该单独计时的地方**——但 three 的时间戳池是"每 render pass 一对"，**compute 走独立的 `TimestampQuery.COMPUTE` 池**（three 的 `RendererInspector` 就是这么分的）。所以：**你的 `gpuProbe.ts` 必须同时解析 compute 与 render 两个池**，否则排序开销根本不会被计入（这与你 `WEBGPU_PROBE_PROTOCOL.md` §5.13 里"`gpuUtilization` 现已含 compute 池，旧版只算 render，系统性偏低"完全对应——那个修正就是这个坑）。

---

### 6. sparkjsdev/spark —— splat 渲染的第三种排序策略（✅ 本机 2.1.0 已核实）

- 仓库：https://github.com/sparkjsdev/spark 🟡（web_search 命中其 raw README）
- 本机副本：`node_modules/.bun/@sparkjsdev+spark@2.1.0+f8f6383268478940/node_modules/@sparkjsdev/spark`
- 许可证：**MIT**（本机 `LICENSE` 存在，`package.json` 字段 `license: MIT` ✅）
- 构建日期：`dist/spark.module.js` 为 **2025-07-03** 构建的实际版本 **2.1.0** ✅

**⚠️ 关键核实结论：Spark 2.1.0 是纯 WebGL，零 WebGPU。**

本机实测（可复现）：

```
$ grep -o "navigator\.gpu\|WebGPU" dist/spark.module.js | wc -l
0            # ← 整个 5.1 MB bundle 里 0 次
```

- `dist/types/SparkRenderer.d.ts` 的选项类型**逐字**写着：`renderer: THREE.WebGLRenderer;` ✅ —— 连 `WebGPURenderer` 都不接受。
- `package.json` 描述：*"An advanced 3D Gaussian Splatting renderer for **THREE.js**"* ✅

**⚠️ 未能核实**：**2.1.0 之后是否加了 WebGPU**。本轮无法查 npm/GitHub 新版本。**不要假设有**；请自行 `npm view @sparkjsdev/spark version` 或看仓库 README。

#### 6.1 值得读的东西（✅ 本机可读）

`dist/spark.module.js` **未混淆**（5.1 MB，含可读类名与 WGSL-less GLSL 着色器字符串），有 `.map`。可用符号：

- **排序**：`sortSplats`（8 处）✅；**WASM**（197 处 `wasm`）✅；**`new Worker(` 5 处 + `OffscreenCanvas` 1 处** ✅ → **主线程渲染 + Worker/WASM 排序**。
- 类名（✅ 本机 `grep -o "class …"` 实测）：`SparkRenderer`、`SplatMesh`、`SplatAccumulator`、`SplatEdit`、`SplatSkinning`、`SplatPager`、`SplatGenerator`、`PackedSplats`、`ExtSplats`、`CsplatArray`、`CovSplatTransformer`、`SplatWorker`、`SparkPortals`、`SparkXr`、`Readback`，以及一整套 `Dyno*` 着色器图节点（`Dyno`、`DynoBlock`、`DynoFloat`、`DynoMat2x2`…）
- `SparkRenderer` 的 `onDirty?: () => void` ✅ —— 注释原文：*"Callback function to be called when SparkRenderer needs to re-render, for example when **splat sort order** or LoD updates complete."*
- `preUpdate` ✅ —— 注释原文：*"Controls whether to update the Gsplats before or after rendering. For WebXR this is set to false in order to complete rendering as soon as possible."*

#### 6.2 三种排序策略对照（**这是本节最大的价值**）

| 方案 | 排序位置 | 主线程阻塞 | 显示策略 | 出处 |
| --- | --- | --- | --- | --- |
| **GSL WebGL 后端** | Worker + WASM，CPU 排序 | 不阻塞 | **保留旧序直到新序就绪** | ✅ `gaussian-splat-lite/docs/Architecture.md` |
| **GSL 原生 WebGPU** | GPU（compute + `RadixSort`） | **阻塞（绘制前同步排序）** | 无双缓冲 → 拖动掉帧 | ✅ 同上 + 你的实测 |
| **Spark 2.1.0** | Worker + WASM，`onDirty` 回调驱动重绘 | 不阻塞 | 排序完成 → 回调 → 按需重绘 | ✅ 本机 dist + `.d.ts` 注释 |

#### 6.3 可直接落到本仓库的 4 条教训

1. **splat 排序**：Spark 的 **`onDirty` 回调 + `autoUpdate`** 是一个"**排序完成才重绘**"的拉模型，天然与 `frameloop="demand"` 合拍。你的编辑器本来就是 demand 语义（静态场景不该持续提交），**这个模型比"每帧同步排序"更契合**。
2. **每帧编码开销**：Spark 的 `preUpdate` 明确区分"渲染前更新"与"渲染后更新"，并说明 XR 下设为 false 以求尽快出画。**你的帧顺序也可以显式暴露这个开关**（"本帧是否允许为了出画跳过排序"），而不是把它埋在 `SplatModel` 里。
3. **多视口**：Spark 有 `SparkXr` 与 `SparkPortals`（✅ 类名实测）。`SparkPortals` 尤其值得一看——**多个"渲染视口"渲染同一份 splat 数据**，和你 1/2/4 窗格是同一类问题（同一份数据、N 个相机、N 个 viewport）。
4. **缩略图 / GPU 剖析**：Spark 有 `Readback` 类（✅）与 `SplatPager`（分页/流式）。**`Readback` 是"离屏读回"的独立抽象**——你的 `capture.ts` 把读回揉在截图流程里，**抽成独立对象**可能更好复用（缩略图、探针、测试都用得上）。

**⚠️ 注意**：切勿把 Spark 当作 WebGPU 参考。**它的价值是"排序策略与脏标记协作"的设计，不是 WebGPU 代码。**

---

### 7. 其他 splat 查看器 / 格式（按你的要求逐一给结论）

| 项目 | URL | 结论 | 置信度 |
| --- | --- | --- | --- |
| **antimatter15/splat** | https://github.com/antimatter15/splat | **WebGL**（仓库自述即 *"WebGL 3D Gaussian Splat Viewer"*，web_search 命中标题）。典范级**极简实现**：单文件 + **Web Worker 里做计数排序**，每帧上传索引缓冲。**读它是为了理解"最朴素的 splat 排序"长什么样**，不是为了 WebGPU | WebGL 🟡；文件 `main.js`/`sort.js`/`worker.js` 🟠 |
| **mkkellogg/GaussianSplats3D** | https://github.com/mkkellogg/GaussianSplats3D | three.js 系、**WebGL**；有 Worker 排序与 `SplatMesh`/多场景支持。**未核实是否有 WebGPU 分支** | WebGL 🟡；路径 🟠；WebGPU ❓ |
| **sparkjsdev/spark** | https://github.com/sparkjsdev/spark | 见 §6：**2.1.0 纯 WebGL（本机核实）** | ✅ 2.1.0 / 新版 ❓ |
| **nianticlabs/spz** | https://github.com/nianticlabs/spz | **SPZ 是压缩格式与编解码库，不是渲染器**——所以"WebGPU 支持"这个问题对它不成立。相关：格式规范文档（web_search 命中镜像 `Jackneill/spz` 的 `docs/SPZ_SPEC_v3.md`），以及 Niantic 开源 SPZ 的新闻稿 | 格式用途 🟡；**许可证 ❓** |
| **LumaAI web viewer** | npm `@lumaai/luma-web`（web_search 命中 jsDelivr 上的 README）；示例仓库 https://github.com/lumalabs/luma-web-examples | **库是"给 three.js/WebGL 项目用的播放器"，引擎不开源**。价值在于**流式加载 + LOD 的产品化做法**，不在渲染代码 | 存在 🟡；WebGPU ❓ |
| **dylanebert/gsplat.js** | https://github.com/dylanebert/gsplat.js | TypeScript splat 库，**WebGL2**，含 Worker 排序。你的 `WEBGPU_MIGRATION.md` 已提到过它。**未核实是否有 WebGPU** | WebGL2 🟡；路径 🟠 |
| **three-gpu-pathtracer** | https://github.com/gkjohnson/three-gpu-pathtracer | **不是 WebGPU**。web_search 命中其 **issue #547 "Support for WebGPU"**——**issue 的存在本身说明它没支持**（它构建在 `WebGLRenderer` + 自定义 GLSL 上）。**对你的价值：路径追踪的 progressive 采样/buffer 累积模型，与你的"多次采样后合并"需求同源** | 🟡 |
| **model-viewer** | https://github.com/google/model-viewer | three.js + **WebGL**（web_search 命中的 Khronos 演讲标题即 *"What is \<model-viewer\> … WebGL"*）。**未见 WebGPU 后端**。价值在**单画布内多视图/AR 模式切换与截图的工程化** | WebGL 🟡；WebGPU ❓ |
| **vtk.js** | https://github.com/Kitware/vtk-js | **WebGL2**（自有 `vtkOpenGLRenderWindow` 体系）。**未见 WebGPU 路径**。价值在**大体量科学数据的多视图/多渲染窗口**工程实践 | WebGL 🟡；WebGPU ❓ |
| **Mol\*** | https://github.com/molstar/molstar | **WebGL2**。**未见 WebGPU**。价值在**状态/快照（`State`/`StateSnapshot`）与插件式 UI**——与编辑器状态管理同源 | 🟡 |
| **google/filament** | https://github.com/google/filament | **C++/Vulkan/Metal/GLES 原生引擎**；`filament-js` 是 WASM 胶水，**不是 WebGPU**。**不建议作为 WebGPU 参考**（架构思想可读，代码不可移植） | 🟡 |
| **meshoptimizer 系 viewer** | https://github.com/zeux/meshoptimizer | 是**几何压缩库**（含 simplifier/LOD），**不是渲染器，也不含 WebGPU 渲染路径**。价值在**LOD/流式几何**，不在编辑器 | 🟡 |

**关于"SuperSplat 之外的 WebGPU splat 编辑器"这个问题的诚实回答**：**本轮未能核实存在**。我能核实的 WebGPU splat **渲染**路径只有两条：GSL 1.1.5 的 `src/rendering/webgpu/`（✅ 本机文档），以及 PlayCanvas engine 的 GSplat 后端（🟠）。**除此之外我没有证据表明存在第二个"开源 WebGPU splat 编辑器"。**

---

### 8. WebGPU 3D 编辑器相邻工具（含三个"待确认"的纠正）

#### 8.1 多视口补充参考：drei 的 `View` 与 r3f 的 WebGPU（✅ 本机已核实）

- 本机：`node_modules/.bun/@react-three+drei@10.7.7+8c2075bba390a53d/node_modules/@react-three/drei/web/View.js`（**MIT ✅**，`package.json` 已核实）
- `@react-three/fiber@9.6.1` 也在本机

**`web/View.js` 的做法（✅ 逐行核实）**：一个 canvas，用 `getBoundingClientRect()` 追踪 DOM 容器，每帧：

```js
state.gl.setViewport(left, bottom, width, height);
state.gl.setScissor(left, bottom, width, height);
state.gl.setScissorTest(true);
state.gl.render(children ? state.scene : scene, state.camera);   // 渲染，不 clear
// 还原：setScissorTest(false)、autoClear 复位
```

以及 `prepareSkissor` 里的 `bottom = canvasBottom - trackBottom`。

**⭐ 两条教训（这正是 §3.2 的加强版）**：

1. **`bottom = canvasBottom - trackBottom` 是 WebGL 的"左下原点"约定。WebGPU 的 viewport 原点是左上**，three 的 `WebGPUBackend.updateViewport` **不做翻转**（只有 `WebGLBackend` 做）。所以**照抄 drei 的这段数学会让窗格上下颠倒**。你 AGENTS.md 里记的"根目录那份陈旧 `node_modules/three` 带着 WebGL 那条 `height - h - y` 翻转，照它推理会把 viewport 原点判反"——**同一个坑，drei 的代码就是这个坑的活样本**。
2. **drei 用 `autoClear = false` + 每帧不 clear（只在可见性变化时 `clear()` 一次）**，与你的"统一清屏 + 各视图 pass `autoClear=false`"是同一套纪律。**它是独立演化出的同一结论**，可以作为你那条约束的外部佐证。

**r3f 的 WebGPU**：🟠 待确认具体支持形态（r3f v9 已有 WebGPU/`gl` 工厂路径的讨论），**本轮未核实**。

#### 8.2 调试 / 抓帧工具：WebGPU 侧到底是什么

| 工具 | 结论 | 置信度 |
| --- | --- | --- |
| **Spector.js** | **仅 WebGL 1/2，不支持 WebGPU。** 它靠拦截 WebGL context 工作，这套机制在 WebGPU 上不存在。web_search 命中的 `sakitam-fdd/spector-mcp` 自述也写着 *"**WebGL 1/2** debugging MCP server built on Spector.js"* | ✅ 高 |
| **three.js `examples/jsm/inspector/`** | **引擎内剖析器，本机可读**（见 §1.2）。**对你是最实际的一个** | ✅ 本机核实 |
| **`webgpu/webgpu-debugger`** | **存在**（web_search 命中仓库）。W3C WebGPU 组的官方调试器，基于 Dawn wire，需要 Chromium/Dawn 的开发者特性开关。**未核实其与 Chrome stable 的可用性** | 存在 🟡；能力 🟠 |
| **`MatusT/webgpu-debugger`** | **存在**（web_search 命中仓库）。一个 WebGPU 调试器（VS Code 方向）。**能力与维护状态未核实** | 存在 🟡；能力 ❓ |
| **"WebGPU Inspector"（Chrome 扩展）** | **存在**（Chrome Web Store id `holcbbnljhkpkjkhgkagjkhhpeochfal`）。**⚠️ 你任务里问的"by Brecht"我无法核实；作者、能力、是否含时间戳视图本轮均未核实**。请勿转述作者名 | 存在 🟡；**作者 ❓** |
| **Chrome DevTools** | 据我所知**没有** WebGPU 抓帧面板（不像 WebGL 有 Spector 类工具）。可用的是 `chrome://gpu`（adapter/feature 列表）与 Dawn 的开发者开关。**本轮未核实当前版本** | 🟠 |
| **RenderDoc** | **不支持 Metal —— 在 macOS 上完全不可用。** RenderDoc 覆盖 D3D11/12、Vulkan、OpenGL，**没有 Metal 后端**。这与 `AGENTS.md` §六 的结论一致（"Metal 上 Xcode Metal Debugger 是唯一可用的抓帧工具"） | ✅ 高 |
| **Xcode Metal Debugger** | macOS 上**唯一**可用。成本已由你在 `AGENTS.md` §六 核实并记录：需可附加调试器的 Chrome 构建、`--disable-gpu-sandbox`、`MTL_CAPTURE_ENABLED=1`、`--enable-dawn-features=use_user_defined_labels_in_backend`、附加到 **GPU 进程 PID**、**每次抓帧后浏览器必挂需重启** | ✅（你已核实） |
| **wgpu / wgpu-profiler** | Rust 原生，**与浏览器 TS 编辑器无关**。不要花时间 | ✅ 高 |

#### 8.3 从工具清单推出的 3 条教训

1. **GPU 剖析**：**WebGPU 没有 Spector 等价物**。所以"引擎内时间戳"不是可选项，而是**唯一可控的路径**。结论：**直接读 three 的 `examples/jsm/inspector/`，在上面扩展，而不是从零写**。特别是它已经解决了"每 pass 时间戳 + rAF 里 resolve + 并发去重 + 缺失时标不可用"。
2. **抓帧的可行路线只有一条**：macOS 上用 Xcode Metal Debugger，且要**给应用的资源起 `label`**（你 AGENTS.md 已核实：three 0.186.1 **不发 `pushDebugGroup`**，但**给真实渲染描述符设了 `label`**）。所以**要做的是给你自己的资源命名**（`CaptureQueue` 的 render target、探针的 buffer、GSL 的排序 buffer），不是给 three 打补丁。
3. **不要把"CPU 提交时间"当 GPU 时间**：`RendererInspector` 的 `beginRender/finishRender` 用 `performance.now()`——它是 CPU 侧。**这与你 `WEBGPU_FINDINGS.md` §1 第 5 条是同一条纪律**，而 three 自己的 inspector 恰好同时给了 CPU 和 GPU 两列（`Name / CPU / GPU / Total`），**可以当作"两个数必须分开呈现"的 UI 范例**。

---

## 9. 最值得读的 5 个仓库 + 具体文件（排序版）

> 排序依据：**能否在你当前技术栈上直接落地** > 与你的产品形态（Web splat 编辑器）的接近度 > WebGPU 代码的纯度。
> 每条都标了**可直接打开的位置**与**置信度**。

### 🥇 1. three.js 0.186.1（你已经在依赖它 —— 先读本机，别急着上网）

- 仓库：https://github.com/mrdoob/three.js （**MIT ✅**）
- 本机路径：`node_modules/three/`（权威副本 `.bun/three@0.186.1/...`）

**具体文件（✅ 全部本机核实）**：

1. `node_modules/three/examples/jsm/inspector/RendererInspector.js` —— **整套 GPU 时间戳剖析**（render/compute 双池、rAF resolve、并发去重、不可用降级、overdraw）
2. `node_modules/three/examples/jsm/inspector/tabs/Performance.js` + `ui/Profiler.js` + `ui/Graph.js` —— 剖析 UI（CPU/GPU 分列 + 曲线）
3. `node_modules/three/src/renderers/webgpu/WebGPUBackend.js:2231-2310` —— **多视口核心**（ArrayCamera 逐眼 `setViewport` + `cameraIndex`），以及 `:2283` 的 render-bundle 限制
4. `node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js` —— 池 2048、写满即 resolve 并归零（**"跨池重置读到陈旧值"的机制**）
5. `node_modules/three/src/renderers/webgpu/utils/WebGPUTextureUtils.js:812-815` —— 读回 **256 字节行对齐** + `(h-1)*bpr + w*bpp` 的 buffer 公式（**缩略图必读**）
6. `node_modules/three/src/renderers/common/RendererUtils.js:14-210` —— 截图/调试渲染的**状态保存与还原三件套**
7. `node_modules/three/src/cameras/ArrayCamera.js` —— 多窗格的契约（每子相机必须给自己的 `.viewport`）

**为什么第一**：**它是你唯一能逐行对照执行的 WebGPU 代码**，而且里面的 inspector 是你剖析器需求的现成答案。零网络成本。

---

### 🥈 2. playcanvas/supersplat —— 最接近你产品形态的开源编辑器

- 仓库：https://github.com/playcanvas/supersplat （MIT 🟡）
- **旁证（非常有用）**：DeepWiki 有 https://deepwiki.com/playcanvas/supersplat/4.3-scene-manager —— 标题即 **"Edit History and Undo System"**，说明撤销系统真实存在且很可能由一个 Scene Manager 拥有
- **血缘旁证**：`gaussian-splat-lite/README.md:185` 明写其架构取自 **Spark + SuperSplat**（✅ 本机核实）——**你正在用的库就是这两个仓库的后代**

**具体文件（🟠 路径待确认，请你打开后核对）**：

1. `src/editor.ts` —— 编辑器汇合点（场景/相机/选区/事件/撤销）
2. `src/scene-manager.ts`（或 `src/history.ts`）🟠 —— **撤销/历史**（本轮最想核实的一个）
3. `src/edit/` 🟠 —— **编辑算子（删除/变换/上色）**，看它如何做到纯函数 + 可逆
4. `src/tools/` 🟠 —— 工具（select/move/rotate/scale/measure/brush/flood）的生命周期与 gizmo 交互
5. `src/ui/` 🟠 —— 多面板 UI 的状态组织，对照你的 `app/src/widgets/Inspector/`
6. `src/scene.ts` / `src/splat.ts` 🟠 —— splat 数据容器：**编辑与渲染的分界线**

**为什么第二**：它是**唯一一个"Web 端 splat 编辑器"的完整开源实现**，撤销/选区/工具这三块正是 `EDITOR_PRACTICES.md` 里没有一手代码的部分。

---

### 🥉 3. playcanvas/engine —— WebGPU 设备抽象 + camera rect 多视口

- 仓库：https://github.com/playcanvas/engine （MIT 🟡）
- 旁证：官方博客 [Build WebGPU Apps Today with PlayCanvas](https://blog.playcanvas.com/build-webgpu-apps-today-with-playcanvas/)

**具体文件（🟠 文件名待确认，目录 🟡）**：

1. `src/platform/graphics/webgpu/`，核心 `webgpu-graphics-device.js` → **`WebgpuGraphicsDevice`** —— **真实 WebGPU 设备封装要处理什么**
2. `src/platform/graphics/graphics-device.js` —— 后端无关基类：**抽象边界画在哪**
3. `src/platform/graphics/webgl/webgl-graphics-device.js` —— 对照项：**哪些被迫分支**
4. `src/platform/graphics/render-pass.js`（+ `render-pass-forward.js`）—— **pass 一等对象**：多相机在一个 forward pass 里遍历
5. `camera.rect` / `camera.scissorRect` —— **归一化 0..1 的多视口 API**（对比 three 的像素 `viewport`）
6. `src/platform/graphics/scope-space.js` / `scope-id.js` 🟠 —— **可嵌套 GPU 计时作用域**（若属实，比 three 的扁平 pass 时间戳更适合"窗格→层"的层级）
7. `src/extras/gizmo/` 🟠 —— 引擎级 gizmo
8. https://github.com/playcanvas/editor —— **已开源的编辑器前端**（旁证：官方博客 [Editor Frontend is now Open Source](https://blog.playcanvas.com/playcanvas-editor-frontend-is-now-open-source/)）

**为什么第三**：它给你**两个 three 没有的东西**：归一化的多视口 rect 模型，以及"pass 一等化 + 作用域计时"的架构对比。

---

### 4. gaussian-splat-lite 1.1.5（你正在用）+ sparkjsdev/spark —— 三种排序策略

- GSL 仓库：https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite （**Apache-2.0 ✅** 本机核实）
  本机：`node_modules/.bun/gaussian-splat-lite@1.1.5+.../gaussian-splat-lite/`
- Spark 仓库：https://github.com/sparkjsdev/spark （**MIT ✅** 本机核实；**2.1.0 纯 WebGL ✅**）
  本机：`node_modules/.bun/@sparkjsdev+spark@2.1.0+.../@sparkjsdev/spark/`

**具体文件**：

1. GSL `docs/Architecture.md` ✅ —— **渲染分层总表**；点名 `src/rendering/webgpu/{ProjectedSplats,ProjectionCache,RadixSort}.ts`（compute 投影 / 投影缓存 / **GPU 排序**）
2. GSL `docs/Architecture.md` 的排序段落 ✅ —— **WebGL = Worker/WASM 异步排序 + 保留旧序；原生 WebGPU = GPU 上绘制前同步排序**（**你掉帧问题的机制本体**）
3. GSL `docs/GaussianSplatRenderer.md` ✅ —— `minSortIntervalMs`（**WebGPU 无效**）、`fastSort`（WebGPU 有效）、`stochastic/autoStochastic`（**跳过排序**）、`sortRadial`、`superXY`（**超采样缩略图，≤8192**）、"captures use sorted rendering"
4. GSL `docs/StochasticTAAPass.md` 的 **"ArrayCamera and WebXR"** 一节 ✅ —— "Each view has independent history"（**多视图内存/算力线性增长**）
5. GSL `docs/Architecture.md` 的资源规则 ✅ —— "**Wait for outstanding GPU compilation before disposing the sorter; preserve compute nodes when resizing resources or changing source meshes**"
6. Spark `dist/types/SparkRenderer.d.ts` ✅ —— `onDirty`、`preUpdate`、`autoUpdate` 的注释（**"排序完成才重绘"的拉模型**）
7. Spark `dist/spark.module.js`（未混淆）✅ —— `sortSplats`、WASM、`new Worker(`×5、`OffscreenCanvas`、`class Readback`、`class SparkPortals`、`class SparkXr`

**为什么第四**：**这三条排序路径是同一个问题的三种解法，而你现在正卡在中间那条（最差的那条）上**。第 1、2 项直接解释你的 100–150 ms，第 5 项解释你的资源生命周期 bug 类。

---

### 5. Orillusion/orillusion —— 唯一"WebGPU-only、无回退"的完整引擎

- 仓库：https://github.com/Orillusion/orillusion （许可证 🟠 待确认，很可能 MIT）
- 旁证：`Orillusion/orillusion-webgpu-samples`

**具体文件（🟠 全部待确认）**：

1. `src/gfx/` —— WebGPU 设备/pass/encoder 封装（**无 WebGL 分支的纯净版**）
2. `src/rendering/` —— `RenderShaderPass` / `RendererPass` / `PassType` 的**双层 pass 模型**
3. `src/rendering/renderJob/`（或 render graph 相关）🟠 —— **节点式渲染调度**，对照你的 `RenderSchedule` 三段 priority
4. `View3D` / `Camera3D.viewPort` 🟠 —— **"pane = view + camera + rect"** 的建模方式，对照你的 `WebGPUView`
5. `GUICanvas` 🟠 —— DOM/Canvas → 纹理（编辑器 HUD 的另一条路）
6. `Orillusion/editor` ❓ —— **未能核实是否存在**

**为什么第五**：你的硬约束是"WebGPU-only 没有回退"，**这是唯一一个和你约束完全相同的完整引擎**。它的价值不是代码可移植（抽象层不同），而是**"没有回退包袱时，架构会长成什么样"**。

---

### 荣誉提名（时间够再看）

| 仓库 | 一句话 |
| --- | --- |
| `@react-three/drei` （本机 `web/View.js` ✅，MIT） | **DOM 矩形驱动的多面板单画布**；但**它的 `bottom = canvasBottom - trackBottom` 是 WebGL 原点约定，WebGPU 下会翻**——当反面教材读 |
| https://github.com/webgpu/webgpu-debugger 🟡 | 官方 WebGPU 调试器 |
| https://github.com/galacean/engine 🟠 | WebGL/WebGPU 双后端 RHI 抽象；**后端目录名本轮未核实** |
| https://github.com/cocos/cocos-engine 🟡 | `cocos/gfx/webgpu/` 后端真实存在；**编辑器闭源（Electron）** |
| https://github.com/needle-tools/needle-engine-support 🟡 | **只有文档**，引擎源码不在该仓库 |

---

## 10. 本轮**未能核实**的清单（请勿当成结论）

1. **所有 GitHub 的具体文件路径与目录名**（`playcanvas/engine`、`supersplat`、`Orillusion`、`galacean`、`cocos`）—— 环境无公网，仅有 web_search 的标题级信号。**已逐条标 🟠。**
2. **SuperSplat 是否支持多视口 / 其 `splat` 排序的具体实现** —— 🟠/低置信。我倾向认为它**不是**多视口编辑器，但**未核实**。
3. **各仓库许可证的确切文本**：仅 three（✅ 本机 MIT）、GSL（✅ 本机 Apache-2.0）、Spark（✅ 本机 MIT）、drei（✅ 本机 MIT）是本机核实；PlayCanvas 全线 / Orillusion / Galacean / Cocos / spz 的许可证均为 🟡/🟠。
4. **Spark 2.1.0 之后是否加入 WebGPU** —— ❓（本机只有 2025-07-03 构建的 2.1.0）。
5. **"WebGPU Inspector" Chrome 扩展的作者**（你任务里提到的 "Brecht"）—— ❓ **未能核实，请勿转述**。
6. **`webgpu/webgpu-debugger` 与 `MatusT/webgpu-debugger` 的实际能力、维护状态、与 Chrome stable 的兼容性** —— ❓。
7. **`Orillusion/editor`、`galacean/editor` 是否存在公开仓库** —— ❓。
8. **Orillusion 的 `GUICanvas`、Galacean 的 WebGPU 后端路径、PlayCanvas 的 `ScopeSpace` 是否存在** —— 🟠。
9. **Chrome DevTools 当前是否已有 WebGPU 抓帧面板** —— 🟠。
10. **PlayCanvas engine 的 GSplat 排序实现细节**（counting sort? worker? compute?）—— 🟠。

**验证这些的最省力顺序**（网络恢复后）：
`superplats` 的 LICENSE + `src/` 目录 → `playcanvas/engine` 的 `src/platform/graphics/webgpu/` 目录 → Orillusion 的 `src/gfx` + `src/rendering` → GSL 仓库的 `src/rendering/webgpu/`（本机只有 dist，**这一步能补上 `RadixSort.ts` 的真实实现**）。

---

## 11. 与本仓库现状的 5 条直接行动建议（按性价比排序）

1. **先读 three 的 `examples/jsm/inspector/`，再决定是否继续自研 `gpuProbe` 的剖析部分**（✅ 本机，零网络成本，直接命中你 4 个已解决问题）。
2. **把"缩略图读回"改用 `readRenderTargetPixelsAsync` + `RendererUtils` 状态还原**，并核对 256 字节行对齐与 `(h-1)*bpr + w*bpp`（`WebGPUTextureUtils.js:812-815`）。你的 `capture.ts` 已经在做填充解包——**确认它的 buffer size 公式与 three 一致**。
3. **多视口的编辑器状态层改用归一化 rect**（学 PlayCanvas 的 `camera.rect`），渲染层再投影成固定容量的 `ArrayCamera`（`ARRAY_CAMERA_CAPACITY = 4` 的约束保持不变）。**这样 DPR/布局/渲染三者的耦合从两处降到一处。**
4. **splat 排序：把 GSL WebGL 路径的"保留旧序直到新序就绪"移植到 WebGPU**（order buffer 双缓冲 + 交换 + 绝不回读）。这是你 `synchronousSort` 掉帧问题**唯一不以画质为代价**的解法方向（`fastSort`/`minPixelRadius`/`stochastic` 都有画质代价，且属产品决策）。
5. **在查 ≥3 视图塌缩前，先确认 `gpuProbe` 同时解析 compute 与 render 两个时间戳池**（three 分两个池：`TimestampQuery.COMPUTE` / `TimestampQuery.RENDER`）。只算 render 会系统性低估——你 §5.13 已经修过一次这个错。

---

*本文写于无法联网的沙箱环境。所有 ✅ 标记均可用给出的本机路径与行号复现；所有 🟠/❓ 标记在打开仓库后可能被推翻。*

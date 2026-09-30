# 视口热路径审查（2026-09-29）

**结论先说：这一层已经优化到位，剩余性能不在 React 代码里。**

> ⚠️ **2026-09-30 更正：本文有一条判断被实测推翻，另有三处每帧浪费被找到并修掉。**
> 见下面第〇节。§一 表格里 `ModelMesh:305` 那一行、§二 的"但这不值得优化"与"省掉它也只是
> 省下一次空 pass 的固定开销（~0.1 ms/视图）"两句**已作废，不要再引用**。

---

## 〇、2026-09-30 更正（本节优先于下文）

### 0.1 `demand` 并没有真的生效（本文 §一 判断错误）

§一 写"没有任何无条件 `invalidate()`"，并列出 `ModelMesh:305`（仅 `hasAnimation`）作为有守卫的例子。
**那个守卫是恒真的**：`AnimatedObject` 只在 `model.animations.length > 0` 时才渲染
（`ModelMesh.tsx` 的 `ClonedAssembly` 分支），所以组件内部的 `names.length > 0` 永远成立。
后果是**只要场景里有一个带动画的模型，整块画布就永远以 vsync 重绘**，`frameloop="demand"`
形同虚设；视口、预览小窗、缩略图三个画布都会中招。

已修：续帧条件改为"片段真的在推进"（`needsAnimationFrame`，`animationLoop.ts`）。`LoopOnce`
播完后 three 会把 action 置成 `paused`/`enabled=false`，续帧自然停止；静止姿势与
`timeScale === 0` 同样不续帧。回归测试见 `animationLoop.test.ts`（6 条，同时钉住所依赖的
three 行为）。

### 0.2 每帧 `gl.render()` 的代价不是 CPU 提交时间（本文 §二 结论错误）

§二 用"单视图 CPU 提交总量 0.30 ms / 每次约 0.1 ms"论证"不值得优化"。**口径错了**：
一次多余的 `gl.render()` 的真正代价是**一次 `queue.submit`（`beginRender`/`finishRender` 各一次）
+ 一次 swapchain 取纹理 + 一次把中间 framebuffer 全屏 blit 回画布**——全部不落在 `cpuSubmitMs` 里。
而且因为 `outputColorSpace ≠ workingColorSpace`，**每一个**画布 `gl.render()` 都是
"内部 framebuffer pass + 全屏 blit"两趟，空场景也照付。

已修两处：
- **overlay 空场景不再提交**（`WebGPUView.tsx`，判据 `hasDrawableContent`，`drawableContent.ts`）；
- **HUD 的深度清屏**从独立的 `gl.clearDepth()`（独立 encoder + 空 pass + 独立 submit + 一次取纹理）
  改为写进 HUD 那一趟 pass 的 `depthLoadOp`（`PaneCamera.tsx`，靠 `autoClearDepth`；
  **颜色必须显式关掉**，否则会把窗格擦掉）。

### 0.3 另外两处每帧/每事件浪费

- `WebGPUView` 的 `scroll` 同步无条件 `setRect(新 DOMRect) + invalidate()`：`getBoundingClientRect()`
  每次返回新对象，引用必变 → React 无法 bail out。而 `scroll` 是挂在 window 上的**捕获相**监听，
  在模型列表/聊天记录里滚动也会打进来 → 每个窗格重渲染 + 多画一整帧。已改为按值比较（`sameRect`）。
- `WebGPUView` 的 `events.compute` 把 `event.target !== track.current` 的守卫排在
  `getBoundingClientRect()` **之后** → 每次 pointermove（每个窗格一次）都强制同步布局，哪怕指针
  不在视口里。已把守卫提前，语义不变。

### 0.4 实测（同会话 A/B，2026-09-30，`bun run probe:gpu`，可见窗口，每轮 `valid=true`）

> ⚠️ **本节在当天被自己修正过一次，读结论请读这一版。** 原先写的"−32%～−46%"来自一版有缺陷的
> 探针，见 §0.6。**方向成立、倍率不可引用。**

**（a）io 计数（每 rAF 帧的 render / 取纹理 / submit）——这才是可信的那一半。**

探针被修好（§0.6）之后，同一配置连续两轮给出：`renders` 7.96 / 7.94，`presents` 8.96 / 8.93，
`submits` 22.13 / 22.08 —— **离散 ±0.3%，确认结构性、不随负载变化**。这两轮是 4 窗格布局、
1.92M 真实资产、load 4.28 / 4.78。

**（b）4 窗格基线（修好的探针，load 4.28）：** `renders=7.96`、`presents=8.96`、`submits=22.13`、
`gpuUtilization=22.0%`、帧间隔 p50 **50.0 ms（3× vsync）**。

**（c）改前 / 改后（同会话 stash-pop，各 1 窗格与 4 窗格）：** 方向一致且量级明显——1 窗格
`renders` 3.65→2.45、`presents` 6.08→3.67、`submits` 13.49→8.87；4 窗格 15.67→10.63、22.20→11.96、
49.84→29.45。**但这几个数取自未修窗口的探针，分子含预热期，所以只能读作"约三分之一到一半的
下降"，不要引用具体百分比。**

**（d）全套视图数曲线（改后、稳定负载 3.98–4.34，一轮跑完三个布局）：**

| 视图 | panes | p50 | ×vsync | 历史（§5.18，未改前） |
| --- | --- | --- | --- | --- |
| 1 | 1 | **16.8 ms** | **1.0×** | 50.0 ms（3.0×） |
| 2 | 2 | **33.3 ms** | **2.0×** | 66.7 ms（4.0×） |
| 4 | 4 | **83.4 ms** | **5.0×** | 133.8 ms（8.0×） |

三个点单调同向、同一会话同一仪器，是这批改动最扎实的一条证据：**每多一个窗格 ≈ +1 个 vsync，
而 `gpuUtilization` 恒在 22–25%**。即剩下的限速在 **"提交 → 呈现 → 下一次 rAF"** 这条路上，
不在 Three 计时的 render/compute pass 里。

### 0.5 仍未做（判断为风险大于收益，留待单独评估）

`ClearFrame` 的 `gl.clear(true,true,true)` 本身也是"内部 framebuffer 清 + 一次 blit"两次提交，
理论上可以并进第一趟窗格 pass 的 `autoClear`。**不改**：这会引入"本帧没有任何窗格绘制时，
画布保留上一帧而不是清空"的行为变化，收益只有每帧 2 次提交（4 窗格下约占 4%）。

### 0.6 探针缺陷（当天发现并修掉）：`io` 计数的分子含预热期

`present` / `submit` / `render` 三个计数从**探针启动**（含 2 s 预热）就开始累加，而它们最终都除以
`attribution.wallFrames`——那个分母**只覆盖预热之后的采样窗口**。于是预热期的任何绘制都会把
"每帧"数抬高：同一配置两次运行实测给出 `renders=9.85` 与 `renders=15.76`（load 都是 4.1），
看着像结构性差异，其实只是预热窗口不同。

已修：三个钩子都加 `if (samplingWindow)` 守卫（`gpuProbe.browser.ts`），并把单测改成**显式断言
窗口外的调用不计入**（`gpuProbe.test.ts`："io 计数：present/submit/render 只在采样窗口内计数"）。
修好后同配置两轮离散 ±0.3%（见 §0.4a）。**这与此前给长帧归因加窗口是同一种错误。**

### 0.7 测量纪律的新增项：帧间隔的单对 A/B 分辨不了 1 个 vsync

同负载（4.28 / 4.78）、同配置、连续两轮：p50 分别是 **50.0 ms 与 66.6 ms**（差正好 1 个 vsync），
io 计数却几乎相同。所以**任何以帧间隔为因变量的 A/B，单对样本无效**，必须照
`WEBGPU_PROBE_PROTOCOL.md` §5.19 的**交替设计 + 多轮重复**来做。**以 io 计数为准**（它
±0.3%），帧间隔只作旁证。

### 0.8 `alpha` 实测：**不是杠杆**（2026-09-30，交替设计，已结案）

画布是 `alpha: true`，合成器每帧都要混合它——这部分代价不在 Three 的时间戳里，一度看起来很像
那"剩下的 2/3 墙钟"的候选。已按 `?msaa=1` 的成例加了可测开关 `?opaque=1` / `--opaque 1`
（`webgpu.ts`，**默认值不变**）。

前两次尝试被负载污染（load 冲到 13.6，按纪律作废）。第三次用**交替设计**做成：4 窗格、1.92M、
`--duration 6000`、A/B/A/B/A/B 六轮，**全部 `valid=true`**。

| 对 | load ON→OFF | 帧间隔 p50 ON→OFF | `gpuUtilization` ON→OFF |
| --- | --- | --- | --- |
| 1 | 3.87 → 4.06 | 33.3 → **33.3** | 35.2% → 39.3% |
| 2 | 6.00 → 4.73 | 33.5 → **33.4** | 33.7% → 39.3% |
| 3 | 4.18 → 3.50 | 33.3 → **33.4** | 35.2% → 35.6% |

**结论：帧间隔三对完全相同（33.3 vs 33.4 ms），去掉画布 alpha 什么也不改。**
"合成器每帧混合一张 alpha 画布"**不是**那 33 ms 里的成本——这条假设死掉。剩下那约 16 ms
（33.3 ms − 约 17 ms 已计时工作）不在合成器的 alpha 混合上。
（`gpuUtilization` 在 OFF 时略高，但 `pairedWall` 分母同时变小、p50 又不变，不足以支持任何结论。）

**`?opaque=1` 保留为测量开关**，但**不要再把它当优化手段**。

### 0.9 ArrayCamera：核心场景并成一趟（2026-09-30，第二批）

§0.4 的曲线显示"每多一个窗格 ≈ +1 个 vsync，而 GPU 占比恒定"，也就是说限速在**提交 → 呈现 →
下一次 rAF** 这条路上。既然结构计数与帧时间同向，最直接的杠杆就是**减少每帧的 render pass**。
核心场景是所有窗格共享的同一个 `Scene`，而 three 的 WebGPU 后端本来就支持在一个 render pass 内
逐子相机切 viewport + 逐子相机 layer 过滤——所以"每窗格一趟 `gl.render(coreScene, camera)`"
是白付的。

**改法**（新增 `paneViewports.ts`，`RenderSchedule` 增加 `registerCore`，`ProjectRenderRuntime`
注册那一趟，`WebGPUView` 的 scene pass 只留 overlay，`SplatModel` 从 4 个实例变 1 个）：

| 每 rAF 帧 | 4 窗格 改前 → 改后 |
| --- | --- |
| `renders` | 7.85 → **4.95** |
| `presents` | 8.83 → **5.94** |
| `submits` | 21.81 → **16.06** |

（2 窗格同样是 2/3 的比例：3.96→2.98、4.95→3.98、12.12→12.17。下降幅度正好等于"4 趟核心 → 1 趟"。
**计数的另一半——每个窗格各一趟 HUD——仍然在，这是下一个可捡的点。**）

**验证**：目视截图确认 1/2/4 窗格三种布局的窗格↔相机映射、逐窗格 viewport、每格轴球均正确
（`bun run probe:gpu -- --layouts 1,2,4 --shot <dir>` 新增了截图能力）；`bun run check` 全绿；
探针三轮 `valid=true`。

**踩到的坑（已变成硬约束与回归测试）**：`ArrayCamera.cameras` 的长度一变，three 的
`cameraProjectionMatrices` uniform buffer 就写不下——2 窗格建 `size(128)`，切 4 窗格写 256 字节 →
`GPUValidationError`，画布直接落到 "3D rendering needs WebGPU"。所以子相机数**恒定**
（`ARRAY_CAMERA_CAPACITY = 4`，空槽位用 `layers.mask = 0` 的空相机补齐）。见 `paneViewports.ts`
与 `paneViewports.test.ts`。

**三件 three 不会替你做、必须自己做**（都写进 `paneViewports.ts` 的注释了）：① 子相机的
`updateMatrixWorld()`（`ArrayCamera.cameras` 不是子节点，而 `FrustumArray` 与 `cameraIndex` 绑定都读它）；
② `subCamera.viewport` 用**左上原点 CSS px**（翻转只存在于 `WebGLBackend`；权威副本的
`WebGPUBackend.updateViewport` 是直传）；③ 逐子相机显式设 `layers.mask`。

**没能成立的结论（不要引用）**：这一批的**帧间隔**与 **GPU 时间**都不可比——改前那次是 load 2.53
的幸运窗口，改后 load 一直在 4.9–7.4。用**未改动的 1 窗格路径**校准，同一份代码在两次运行间
`pairedGpu` 就涨了 2.2×、p50 从 16.7 → 33.3 ms，即环境本身就解释了 2 倍以上的差异。所以
"multiView 是否比 4 个独立实例更贵"**仍未回答**，需要安静窗口上的交替设计（§0.7 的纪律）。

### 0.10 HUD 合并：做过，**已整批回退**（2026-09-30）

剩下的最大一块是每窗格一趟 HUD（4 窗格的 `renders` 里占 4 次）。按 §0.9 的同一套路实现了：
一个共享 `hudScene` + 4 个 gizmo 各占一个 layer + 一个 ArrayCamera 一趟画完，`RenderSchedule`
加 `registerPost` 阶段。**结构性计数确实降了**：4 窗格 `renders` 4.95→**1.98**、`presents`
5.94→**2.97**、`submits` 16.06→**10.15**。

**但多窗格下四个坐标轴球全部不可见。** 单窗格正常（截图确认），2/4 窗格不显示。已排除的：

- `gl.render(hudScene, hudArrayCamera)` 照常发出（包 `gl.render` 采样确认每帧就两趟：核心 + HUD）；
- 4 个 group 的 layer = 2/4/8/16、ArrayCamera mask = 31、子相机 mask = 3/5/9/17、viewport 正确；
- `_projectObject` 的两级 layer 过滤都通过（见 §0.9 的 ③）；
- 网格的世界坐标/缩放/包围球全在视口内（半径 0.402×40 = 16 单位，相机 ±367/±195）；
- **每帧 209 次 draw call 确实发生**（对比核心 33 次）；
- 控制台零报错、无未捕获的 WebGPU 校验错误、无失败面板；
- 顺手修掉了 `coordinateSystem`（见下）也**没有**改变症状。

二分线索很干净（单窗格 ✓ / 多窗格 ✗），但根因未定位。**决定回退**：让一个多窗格下的可见回归
留在仓库里，比少拿 3 趟 pass 糟得多。`RenderSchedule.ts` 里留了同一段说明，重做请从这条线索入手。

**第二轮（同日稍后）把触发条件锁定了，方法仍是"改一处 + 截图"**：

| 实验 | 结果 |
| --- | --- |
| 只保留**一个** HUD 子相机（结构与单窗格完全相同：1 真 + 3 空） | ❌ 仍不显示 → 排除"子相机数量" |
| 核心那趟改走**普通相机单窗格**路径（其余不变，HUD 仍是 4 子相机） | ✅ **轴球出现**了（出现在核心画过的那个窗格）→ 触发条件是"**核心用 ArrayCamera**" |
| HUD 那趟前显式 `gl.setViewport(非整屏)`（逼 `renderContext.viewport === true`） | ❌ 无效 → 排除"pass 默认 viewport" |
| 关掉 `trackTimestamp` 再截图（探针强制的 `?gpuTimestamps=1` 会往共用的缓存描述符写 `timestampWrites`） | ❌ 无效 → 排除"时间戳描述符污染" |

即：**HUD 那一趟本身能在多窗格下画出来**（核心走普通相机时证明了），只要核心改用 ArrayCamera 就整体失效。
机制仍未定位。已经排除的完整清单：子相机数量、gizmo 数量、两级 layer 过滤、坐标约定、
pass 默认 viewport、时间戳描述符、网格世界坐标/包围球、draw call 是否发生（209 次确实发生）、
控制台错误（零）。**重做请从"核心 pass 的 ArrayCamera 如何影响后续 pass"这条线索切。**

**这次尝试留下的两个真实发现（已保留在代码里）**：

1. **`coordinateSystem` 不会被 ArrayCamera 的子相机继承。** three 只在 `_projectObject` 里给
   **传进去的那个**相机修正它（`camera.coordinateSystem = this.coordinateSystem`），子相机它一律不碰。
   带默认 WebGL 约定的子相机，`projectionMatrix` 把物体放到**负的 NDC z**，而 WebGPU 只接受 [0,1]
   → 整个被裁掉。核心场景之所以"看起来正常"，只是因为 1 窗格布局时透视相机当过一次顶层相机。
   现在由 `paneViewports.ts` 的 `adoptCoordinateSystem()` 显式处理（**必须先改再 `updateProjectionMatrix()`**）。
2. **layers 是两级过滤，两级都要给。** `_projectObject` 先用 **ArrayCamera 自己的** mask 过滤
   （对不上就进不了 render list），`renderObject` 再用**子相机的** mask 决定这一眼画不画。
   §0.9 的实现一开始只设了子相机，HUD 的 gizmo（layer 1–4）在投影阶段就被丢掉了。


画布现在是 `alpha: true`，合成器每帧都要混合它——这部分代价不在 Three 的时间戳里。已按
`?msaa=1` 的成例加了**可测开关** `?opaque=1` / `--opaque 1`（`webgpu.ts`，**默认值不变**）。
两次尝试都被负载污染（第三次运行的 load 从 4.7 冲到 13.6），**不引用任何 alpha 结论**。
留待安静机器上用交替设计重做。**另外：跑之前必须先做一次目视检查**——天空盒资产加载失败时
窗格靠画布透明显示页面背景，改成不透明会露出清屏色。

---

本文是一次逐行审查的记录，目的是**避免以后重复做同一件事**，以及把"已知的微小结余但判断为不值得改"的项固定下来，免得它们被反复当成待办提出。

审查范围：`index.tsx`（849 行）、`PaneCamera.tsx`（615 行）、`TransformGizmo.tsx`（241 行）、`PanePicking.tsx`、`CameraRig.tsx`、`ModelMesh.tsx` 的帧循环部分。

---

## 一、逐项核对结果

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| demand 渲染是否真的生效 | ❌ **当时判断错误，已修** | 原文写"没有任何无条件 `invalidate()`"，把 `ModelMesh:305`（仅 `hasAnimation`）当成有守卫的例子；但那个条件是**恒真**的（该组件只在有片段时渲染）。见 §〇.1 |
| 是否每帧强制 reflow | ✅ **没有** | `getBoundingClientRect` 已收进共享 `ResizeObserver` + 缓存的 `useTrackedRect`（`PaneCamera.tsx:78-89`），`useFrame` 里只读内存。该文件注释记录了优化前的代价：四窗格下每帧 11 次强制 reflow |
| hover 是否每帧 / 每次 pointermove 重渲染 | ✅ **不会** | `handleHover`（`index.tsx:490-496`）在状态未变时**返回同一引用**，React 直接 bail out。`onPointerOver` 重复触发不会造成重渲染 |
| `PlacedAsset` 的 `memo` 是否被戳穿 | ✅ **没被戳穿** | 三个关键 prop 引用都稳定：`layout` 是 `useMemo(assets, transforms)`（`index.tsx:450`）、`objects` 是 `useState` 的 Map、`live` 由上层注入 |
| 是否每帧 setState | ✅ **没有** | 拖拽走 `live` 表 + 命令式写 `group.position/rotation/scale`（`index.tsx:245-253`），刻意绕开 React。注释写明了原因 |
| 资源/监听器是否成对清理 | ✅ 是 | `useTrackedRect` 的 `subscribeTrackedRect` 最后一个订阅者退出时断开 observer 并摘掉 window 监听（`PaneCamera.tsx:62-75`） |
| 拖拽期临时对象是否复用 | ✅ 是 | `PaneCamera.tsx:241-248` 预分配 `scratch`；`TransformGizmo.tsx:41-45` 模块级 `tmp*`；`PaneGizmo` 复用 `rotationMatrix` / `snapDummy`。均非每次移动 new |
| 是否有 TODO / FIXME / HACK | ✅ 全仓 0 处 | — |

---

## 二、每帧 `gl.render()` 的实际次数

这是审查中最值得记录的一个数字，因为它常被误判为浪费：

| # | 内容 | 位置 |
| --- | --- | --- |
| 1 | `coreScene`（全部模型、splat、天空、网格） | `WebGPUView.tsx:38` |
| 2 | overlay `scene`（该窗格的拾取代理 + `TransformGizmo` + 相机/controls） | 同上 |
| 3 | `hudScene`（坐标轴球，独立正交 HUD） | `PaneCamera.tsx:506`（`PaneGizmo`） |

**每视图 3 次，4 视图 = 12 次/帧。**

> ❌ **本段结论已作废（2026-09-30）。** 用 `cpuSubmitMs` 论证"不值得优化"是口径错误：多余的
> `gl.render()` 的代价是 `queue.submit` + swapchain 取纹理 + 全屏 blit，都不进 `cpuSubmitMs`。
> 见 §〇.2 与 §〇.4 的实测（1 窗格 `renders` −33%、`presents` −40%、`submits` −34%）。以下原文保留供对照。

~~**但这不值得优化。**~~ 实测 CPU 提交总量在单视图下是 **0.30 ms**（`WEBGPU_FINDINGS.md` §1，1000+ 帧），即每次 `gl.render()` 约 0.1 ms → 4 视图约 1.2 ms，而同期 GPU 是 **19.8 ms**，≥3 视图时更达 362 ms。**GPU-bound，省下几次调用不会改变任何测量结果。**

另外第 2 次（overlay）在多数时候**没有任何 draw call**：

- `PanePickTarget`（`PanePicking.tsx`）渲染的 `SharedPickProxy` 只覆写了 `raycast`，**无几何、无材质**，不产生绘制；
- 未选中任何资产时 `TransformGizmo` 直接 `return null`（`TransformGizmo.tsx:179`）。

> ✅ **2026-09-30 已改**：空场景不再提交（`hasDrawableContent`）。原文的"~0.1 ms/视图"是 CPU
> 提交口径的估计，实际省下的是"一次 `queue.submit` + 一次 swapchain 取纹理 + 一次全屏 blit"。
> 保留原文供对照。

~~即便如此，省掉它也只是省下一次空 pass 的固定开销（~0.1 ms/视图），**不值得为此改渲染架构**。~~

---

## 三、已知的微小结余（判断为"不值得改"，勿再当待办）

### 3.1 `PaneGizmo` 每帧无条件重算三样东西

`PaneCamera.tsx:485-497` 每帧都做：

```ts
cam.left/right/top/bottom = ...; cam.updateProjectionMatrix();   // 重建投影矩阵
groupRef.current.position.set(w / 2 - GIZMO_MARGIN_PX, ...);
rotationMatrix.current.copy(mainCamera.matrix).invert();          // 完整解析求逆
groupRef.current.quaternion.setFromRotationMatrix(...);
```

三者的输入（窗格 `w`/`h`、主相机姿态）只在**窗格尺寸变化**或**相机移动**时改变。相机静止、窗格静止时这些全是白做。

**修法现成**：同文件的 `OrthoZoomSync:369` 已经有"值变了才做"的守卫模式（`Math.abs(cam.zoom - desiredZoom) > 0.01`），照抄即可。

**为什么不改**：量级是微秒级，而当前瓶颈是 GPU（19.8 ms 起）。改它不会在任何探针上产生可见差异，反而增加一处状态。**若将来 CPU 侧真的成为瓶颈，这是第一个可以捡起来的点。**

### 3.2 `controls.update()` 一帧被调两次

drei 的 `OrbitControls.js:29-30` 自带：

```js
useFrame(() => { if (controls.enabled) controls.update(); });
```

而 `PaneGizmo:481` 在视角吸附动画里又调了一次 `controls.update()`。同一个 `OrbitControls` 实例在同一帧被 update 两次，`enableDamping` 下阻尼会被推进两次。

**为什么不改**：吸附动画本身就在覆盖相机姿态，双倍阻尼**视觉上不可见**。属清理级，不是 bug。

### 3.3 `SceneContents` 没有 `memo`

`index.tsx:270` 的 `SceneContents` 是普通函数组件，而 `hoveredByLayer` 作为 prop 传进去（`:282`、`:634`）。因此 hover 变化会重渲染整个 `Viewport` 子树——包括**所有窗格**的 `WebGPUView` / `PaneCamera` / `PaneGizmo` / `TransformGizmo`。

**为什么不紧急**：

- hover 已去重（见 §一），只在**跨越对象边界**时触发，不是每帧、也不是每次 pointermove；
- 子组件的关键 prop 引用稳定，重渲染的代价基本只有 React 协调；
- `hoverMask` 的计算（`index.tsx:337`）是每资产对 `hoveredByLayer` 做一次 `Object.entries().reduce()`，资产×层数规模，可忽略。

**真要改**的话，正确做法不是加 `memo`（`hoveredByLayer` 就是变化的那个 prop），而是让 hover 高亮不走 `SceneContents` 的 props——例如按资产下传，或用一个 hover store 让 `ModelMesh` 自己订阅。

---

## 四、结论：性能工作不在这里

视口这一层（调度顺序、实时变换绕开 React、矩形缓存、临时对象复用、资源清理）**没有发现可观的每帧浪费**。

真正的剩余性能问题只有两个，都与本文范围无关：

1. **≥3 视图悬崖** —— 根因未定位，已排除项见 `WEBGPU_FINDINGS.md` 第 2 节与第 4 节；
2. **拖动时 P50 100–150 ms** —— GSL 1.1.5 在原生 WebGPU 路径上每帧同步排序，属产品决策。

**下一步若要提升性能，去查这两个，不要回头翻视口代码。**

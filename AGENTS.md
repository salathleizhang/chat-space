# AGENTS.md

给在本仓库工作的 AI agent 的入口与硬约束。**先读这一份。** 它只有一页，但下面每一条"不得"都是硬约束，不是建议。

仓库有 1000+ 行 WebGPU 文档，其中**只有 `WEBGPU_FINDINGS.md` 第 1 节的 16 条是当前可信的性能结论**。不要从别处推断性能数字。

核对基准：2026-10-01，`bun run check` 退出码 0（app **675** pass / chat **371** pass）。增量来历：363 → 377 是 `VIEWPORT_REVIEW.md` §〇.1–0.3 那批回归测试（`animationLoop.test.ts` 6 条、`drawableContent.test.ts` 7 条、`WebGPUView.test.ts` 1 条）；377 → 382 是 §〇.9 的 ArrayCamera 那批（`paneViewports.test.ts` 5 条）；382 → **458** 是 PlayCanvas 迁移层带来的（边界守卫 4 条、设备/会话 18 条、窗格 19 条、材质与模型描述 20 条、截图与准入 15 条，见 §四之二）；**458 → 511** 里有 **39 条是窗格指针输入**（`playcanvas/paneInput.test.ts` 37 条 + `shared/lib/cameraRig.test.ts` 新增 2 条）；**511 → 542** 是拾取与变换 gizmo（`panePicking.test.ts` 15 条、`paneGizmo.test.ts` 9 条、`paneRegistry` 的 `extraLayerIds` 2 条、`paneInput` 的点击/让手势/聚焦口径 5 条）；**542 → 561** 里 **13 条**是 loader 身份（资源修订号）那批（`shared/lib/resourceRevisions.test.ts` 8 条、`pages/AppDashboard/useProjectState.test.ts` 4 条、`libraryApi.test.ts` 1 条）；**561 → 579** 里 **14 条**是地面网格（`paneGrid.test.ts`）；**579 → 594** 里 **13 条**是坐标轴球 HUD（`paneAxisHud.test.ts`）、**2 条**是输入层的被认领点击（`paneInput.test.ts`）；**594 → 615** 里 **10 条**是第一人称漫游（`walkRig.test.ts`）、**10 条**是相机飞行（`rigFlight.test.ts`）、**1 条**是 `animateFocus` 钩子（`paneInput.test.ts`）；**615 → 635** 里 **17 条**是多选整体变换（`selectionTransform.test.ts`，含**用 three 当真值**钉欧拉约定）、**3 条**是实体↔摆放适配（`panePlacement.test.ts`）；**635 → 653** 里 **7 条**是选中线框几何（`selectionBounds.test.ts`）、
**5 条**是线框引擎绑定（`selectionWireframe.test.ts`）、**5 条**是 G/R/S 契约（`transformKeys.test.ts`）、
**1 条**是 `entityWorldBounds` 的回归（引擎 `Vec3` 只有 x/y/z）；**653 → 659** 里 **6 条**是资产挂载器（`assetScene.test.ts`，§五.5 第一块）；**659 → 666** 里 **7 条**是"资产 → 场景规格"解析（`viewportSceneSpecs.test.ts`）；**666 → 675** 的 **9 条**
是**工作区里并行写入者**的线框材质那批（`widgets/Viewport/wireframeMaterial.test.ts`），不是本节这批改动。**chat 341 → 365** 是按参考图摆放那一步带来的（`imageSize.test.ts` 6 条、`scenePlacement.test.ts` 8 条、`groundSampler.test.ts` 8 条、`scenePlacementRun.test.ts` 2 条端到端），**365 → 371** 来自并行工作。除各条自己点名的模块外，其余零头都来自工作区里并行的未提交改动（app 与 chat 两侧都有）——**引用数字时以本节点名的模块为准**。**文档里其余 363 / 377 / 382 的旧措辞按旧基准读。**

---

## 一、环境

**`bun` 不在 PATH 上。**

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun 1.3.14
bun run check                        # typecheck + test + build
```

`bun run check | tail` 会吞掉退出码——管道的 `$?` 是 `tail` 的。要判成败必须 `set -o pipefail` 或读 `${PIPESTATUS[0]}`。

单测（`bun test` + happy-dom）**不能证明 WebGPU 可运行**。真实 GPU 行为只能在真实浏览器里验证，见第五节。

**check 在过载机器上会假失败。** 实测（2026-10-01）：一次 `bun run check` 在机器被顶到高负载时耗了 **2909 s** 并以退出码 1 结束（报 `app test: Exited with code 1`）；同一份代码单跑 `bun test` 是 **459 pass / 0 fail**，负载回落到 3.5 后重跑 `bun run check` 退出码 0。所以**看到 check 失败先 `uptime`**：负载高时先重跑一次再判代码有问题，别急着改代码。

---

## 二、硬约束

### 渲染

1. **WebGPU-only，没有 WebGL 回退。** 不得新增 `WebGLRenderer` 回退路径，也不得依赖 Three 自带的 WebGL2 兜底。无可用 adapter/device 时走 `WebGPUCanvas` 的重试面板，项目与聊天界面保持可用。
2. **`antialias` 必须保持 `false`，但依据是「约 1.5× 且无收益」，不是「数量级崩塌」。** 实测（交替设计，见 `WEBGPU_PROBE_PROTOCOL.md` §5.19）：MSAA ON 的 `gpuUtilization` 是 OFF 的 **1.4–1.6×**、4 视图 GPU 工作量约 2.4×，方向 6/6 对一致；但帧间隔仍有 15–57 fps，**未复现** 313–588 ms / 0.15 fps。默认值不变；**引用时用 §5.19 的倍率，不要再引用旧的数量级数字**。`?msaa=1` 可用于复测。
3. **不得在无测量的情况下改性能/画质默认值**：`stochastic` / `autoStochastic` / `fastSort` / `minPixelRadius` / DPR / 渲染分辨率。每一个都有画质代价，属于产品决策。
4. **降 DPR / 降分辨率是已被证伪的手段。** 像素 0.92 → 2.07 Mpx（2.25×）时 GPU 中位数 16.25 → 15.20 ms，不动。重述这条建议视为错误。

### 测量

5. **不得把 `renderer.render()` 的 CPU 耗时当成 GPU 耗时**；也不得把 rAF 帧间隔当成 GPU 时间。60 Hz vsync 会把帧间隔 p50 钉在 16.7 ms，而 GPU 实际要 19.8 ms——只看 rAF 会得出"刚好 60 fps"的错误印象。
6. **GPU 时间必须在可见窗口测。** headless 下时间戳静默返回 0，而 headless 与可见窗口的 adapter feature 列表几乎一致，**事前无法分辨**，只能按结果判定。
7. **每轮先校验 `valid === true` 且 `instanceCount` 全部 > 0。** 出现 0 即整轮作废，无论其它数字多合理——实测出现过 `inst=[0,0,0]` 却读出"合理"数字的情况。
8. **单个数字不要跨轮次比较**，除非每轮都从全新页面加载开始。Three 的时间戳查询池上限 2048（每帧 2 个），一次 25 s 采样必然跨越池重置，重置后可能读到陈旧值。
9. 记录当轮 `load average`。静机与忙机的绝对值**不可并列比较**。
10. **测量必须独占机器。** 并发跑探针、`bun run check` 或另一个 agent 的测量，会把 `load` 顶到 30+，那一轮的数字**全部作废**（实测：一边跑探针一边跑 check，`load` 从 3 升到 31）。
    `bun run probe:gpu` 用 CDP 端口 **9333** 做互斥——端口被占会直接拒绝启动并提示 `pkill`；但它挡不住探针之外的负载。开测前先 `uptime`，测完再记一次。
11. **帧间隔的单对 A/B 分辨不了 1 个 vsync。** 同负载（4.28 / 4.78）、同配置、连续两轮的 p50 实测是 **50.0 ms 与 66.6 ms**——差正好一个 vsync，而 io 计数几乎相同。所以**以帧间隔为因变量的改动必须用交替设计 + 多轮重复**（成例见 `WEBGPU_PROBE_PROTOCOL.md` §5.19），单对样本无效。
12. **`io` 计数（`renders` / `presents` / `submits`）是结构性的，但只在同会话内可复现**：修好窗口缺陷后同配置两轮离散 **±0.3%**（`VIEWPORT_REVIEW.md` §〇.6）。跨会话会因应用状态不同而变，所以**io 只能同会话前后比**。另外它原先的分子含预热期、分母不含——**任何"每帧"量都要先确认分子分母同窗口**（长帧归因踩过同一个坑）。

### 依赖与补丁

13. 锁定 three **0.186.1** / @types/three **0.186.0** / gaussian-splat-lite **1.1.5**（root `overrides` + `patchedDependencies`）。**升级任一者都必须重新验证 `patches/` 下两个补丁**，并重跑浏览器压力测试。
14. `patches/` 改的是**释放路径**，不是渲染、投影、排序或画质。改补丁时同步更新 `patches/README.md`，并跑 `app/src/shared/rendering/attributeDisposal.test.ts`。

---

## 三、文档地图：哪些能引用

| 文档 | 状态 |
| --- | --- |
| `WEBGPU_FINDINGS.md` | **只有第 1 节「可信结论」可引用。** 第 2 节是已撤回清单，第 4 节是未解决项 |
| `WEBGPU_PROBE_PROTOCOL.md` | **5.5 / 5.7 / 5.8 的中间结论已作废，不得引用。** §2–§4 的方法、§5.1 的探针可信度对照、§5.13–§5.19 的复测（含修掉的探针缺陷、呈现/提交计数、GPU→CPU 同步计数、五轮重复、数据规模对照、完整视图数曲线、MSAA 交替对照）仍有效 |
| `WEBGPU_MIGRATION.md` | **第 0 节 = 实际状态**；§1–§9 是目标设计，**不是已交付结果**（文档自己警告过这一点） |
| `WEBGPU_VALIDATION.md` | 历史记录。绝对值受时段负载影响，不可与静机数据并列 |
| `SCENE_COMMAND_PLAN.md` | 实施记录。§三「缺口清单」描述的是改造**前**的状态，勿当现状；§Phase 3「已知遗留（重要）」里"两本账不联动、reclaim 基本是 no-op"**已解决**（`ResourceBudget` 已接 `MemoryPressure`，`capture.ts:32` 改调 `trimToFit(needBytes)`），勿再照它去改 |
| `EDITOR_PRACTICES.md` / `PLAN.md` | 资料与里程碑索引，不是当前状态 |
| `README.md` / `app/README.md` | 使用说明，架构描述与代码一致 |
| `PLAYCANVAS_MIGRATION.md` | **渲染层迁移到 PlayCanvas 的权威记录**：每条结论都带文件:行号或本机实测原始读数，并区分"已核实 / 未核实"。§四–§六是各 Phase 的实际状态；**未完成项都显式标了 🔴，不要当成已交付** |
| `VIEWPORT_REVIEW.md` | 视口热路径已逐行审查完成。**但 2026-09-30 的第〇节是更正**：§一 的 demand 判断被推翻（动画续帧条件恒真），§二 的"每帧 3 次 `gl.render` 不值得优化"被推翻，并新增三处已修的每帧浪费 + 同会话 A/B 实测。**读这份文档必须先读第〇节**；第〇节之外的"勿再当待办"只对未被第〇节点名的项成立 |

---

## 四、渲染架构速查

- **一个** `NativeWebGPURenderer`（`webgpu.ts`，直接组 `WebGPUBackend` + `StandardNodeLibrary`，不注册 WebGL 回退）+ **一份**核心 `Scene`（`ProjectRenderRuntime`）。
- 每个窗格有自己的：相机、overlay `Scene`（拾取代理 + gizmo）、HUD `Scene`（坐标轴球）。1/2/4 布局定义在 `paneLayouts.ts`。**splat 不是每窗格一份**——见下面 `SplatModel` 那条。
- **帧顺序**（三层 priority，不要打乱）：
  1. `WebGPUCanvas` 的 `ClearFrame`（priority 0）——`setRenderTarget(null)`、关 scissor、**清屏一次**；
  2. `ProjectRenderRuntime`（priority 1）——`scene.updateMatrixWorld()`，期间置 `matrixWorldAutoUpdate = false`，然后 `RenderSchedule.draw(delta)`。`draw()` 的**第一步是核心场景那一趟**：所有窗格共享同一个 `Scene`，用一个 `ArrayCamera` 在**同一个 render pass** 里逐子相机 `setViewport` + layer 过滤，所以核心场景只要 1 次 `gl.render()`（改之前是每窗格一次）。实现与"三件 three 不会替你做"的细节见 `paneViewports.ts`；
  3. 每个 `WebGPUView` 的 scene pass（**现在只剩 overlay**）——设 viewport/scissor（**顶部为原点**），**有可绘制对象时才** `gl.render(overlayScene, camera)`（判据 `hasDrawableContent`，`drawableContent.ts`）。**它必须仍然返回 `true`**：返回 false 会让 `RenderSchedule` 连带跳过本窗格的 HUD pass，坐标轴球就没了；
  4. 每个 `WebGPUView` 的 hud pass（`PaneGizmo`）——设自己的 viewport/scissor 后画坐标轴球。
- **`ArrayCamera.cameras` 的长度必须恒定**（`ARRAY_CAMERA_CAPACITY = 4`，不足的槽位用 `layers.mask = 0` 的空相机补齐）。three 给 `cameraProjectionMatrices` 分配的 uniform buffer 按**当时的相机数**定容，之后按名字共享且**不会增长**：实测 2 窗格建了 `size(128)`，切 4 窗格 `Queue.WriteBuffer` 写 256 字节 → `GPUValidationError`，整块画布落到 "3D rendering needs WebGPU" 失败面板。回归测试 `paneViewports.test.ts`。**不要**把这行改成"按需变长"。
- 因为是统一清屏，**各视图 pass 里 `autoClear` 必须保持 `false`**；谁改成 `true` 谁就把其它窗格擦掉。**唯一例外是 `PaneGizmo` 的 HUD pass**：它用 `autoClear = true` + `autoClearColor = false` + `autoClearDepth = true` 把深度清屏折进那一趟 pass 的 `depthLoadOp`（替代原来独立的 `gl.clearDepth()`，省一次 encoder + 空 pass + submit）。**颜色那一项绝不能打开**，否则就是上面说的"擦掉其它窗格"；照抄这一段时四个 flag 要成套改、成套还原。
- `SplatModel` 现在只有**一个** `GaussianSplatRenderer`，服务全部窗格：three 的 `ArrayCamera` 路径把"N 个窗格"并成一趟，GSL 的投影器看到 `array.cameras` 就把所有眼放进**同一条 compute 链**、用 `cameraIndex` 取每眼排序。此前是每窗格（每 layer）一个实例——4 份 ProjectionCache / 排序器 / splat 纹理，每帧 4 次 `onBeforeRender`，当初那样做只为免去"布局切换时重编译"。顺带修掉一个真实缺陷：逐窗格时 GSL 的 `renderSize` 取的是 `getDrawingBufferSize()`（整张画布），于是 `minPixelRadius` / `clipXY` 在分屏下按整画布而不是窗格算；multiView 路径取 `camera.viewport`。
- 截图/缩略图走 `CaptureQueue`（检查图优先、交互让行、1.5 s 老化、16 上限）+ `capture.ts` 的私有 RenderTarget + 异步读回 + GPU 行填充解包。
- 资源两层账：截图目标有申请预算（`ResourceBudget`，超限走尺寸阶梯降级，缺额度时按差额回收空闲模型条目再重试同一尺寸）；模型缓存只淘汰闲置项（`ModelResources`：空闲 **128 MiB / 8 项 / 30 s TTL**，另有 **512 MiB 的总驻留安全上限**，超出时立刻回收空闲条目，绝不释放在用项）。**截图准入同时看两侧余量**（`ResourceBudget` 的 `MemoryPressure` 探针，谁能给的少按谁算）。**两者都不是整个项目的显存上限**——这本账不覆盖 splat（`GaussianSplatRenderer` 不走 `ModelResources`），而已知风险恰恰在 splat。
- **loader 身份（`?revision=N`）按资产发号，不要把工作台的 `refreshKey` 当资源代次发给所有资产。** 判据是渲染产物路径（`app/src/shared/lib/resourceRevisions.ts`：模型主产物/部件、`.mtl`、splat、环境贴图）。`refreshKey` 在**每个**后台任务落盘时都会 +1（`useTaskPolling` 完成回调 → `bumpRefresh`），绑上去就变成"生成一件新家具，场景里全部已有模型重新下载 + 重新解析 + 重新挂载"——40 MB 级的 GLB 下这是可感知的卡顿（2026-09-30 修；回归见 `resourceRevisions.test.ts` 与 `useProjectState.test.ts`）。缩略图/自检图/预览图不属于 loader 输入，落盘不该换号。
- **模型材质的写入点只有一个：`useAssemblyMaterials`（`widgets/Viewport/materialOverride.ts`）。** 贴图覆盖与线框着色模式（工具栏按钮 / `Shift+Z`，对齐 Blender 的 wireframe shading）写的是同一批 `mesh.material`，合成一次 effect 是刻意的：分成两个 effect 时 React 按声明顺序跑 cleanup，先还原的那个会把自己后面那层剥掉、后还原的再把已经被剥掉的对家材质装回去；而且贴图是异步的，晚一步解析到的覆盖会把线框顶掉（症状：**开着线框，某个模型突然变回实体**）。线框用**全场景共享的单例材质**（`wireframeMaterial.ts`，绝不 dispose），靠换材质实例触发新管线——就地改 `mesh.material.wireframe` 不会生效（管线按 render object 缓存，节点材质是构建时逐属性拷贝的）。线框材质的三个 flag 都有理由：`depthTest: false`（Blender 式透视，背面棱可见）、**`depthWrite: true` 必须开着**（否则排在透明队列的泼溅世界会整片压在线框上，看起来像"线框没生效"）、`side: DoubleSide`。它只作用于 `PlacedAsset`，**泼溅世界/天空盒/地面网格/HUD 一律照旧**；缩略图/预览小窗也不受影响，但 **agent 的整场景检查图是所见即所得**（拍的就是当前视口的画法）。真机已验证（2026-10-01，1/4 窗格 + 三材质对照：实体对照 fillRatio 0.734 / 线框立方体画成 12 棱 + 三角化对角线）。
- 诊断代码（`gpuProbe.ts` / `benchmark.browser.js` / `*.browser.ts`）**不进生产包**，只被探针和测试引用。保持这个状态。

---

## 四之二、PlayCanvas 迁移层（**并行存在，尚未接入应用**）

> **现状**：应用**仍然跑在 three 上**（§四 描述的就是它）。`app/src/shared/rendering/playcanvas/`
> 是一套**并行**的、已在本机真实浏览器里验证过的实现，通过 `app/pc-panes.html` 这个 dev 探针驱动。
> 完整计划、证据与各 Phase 状态见 **`PLAYCANVAS_MIGRATION.md`**（那份是权威）。
> 本节只收录**新代码的硬约束**——它们运行时大多**静默失败**（不报错、不崩，只是画面不对），
> 而且每一条都踩过或实测过。

### 设备与循环

- **绝不用 `createGraphicsDevice()`**。它无条件把 `WEBGL2` 与 `NULL` 追加进 `deviceTypes`
  （`graphics-device-create.js:6-12`），WebGPU 一失败就**静默给你一个 WebGL 设备**。
  必须 `new WebgpuGraphicsDevice(canvas, opts)` + `await device.initWebGpu()`（不传 glslang/twgsl），
  并断言 `isWebGPU === true && isWebGL2 === false`。`device.ts` 已封装，用 `createWebGPUDevice()`。
  ⚠️ `playcanvas/supersplat` 就是这个错法的现成例子（注释写 "requests webgpu only"、全仓库无断言）。
- **`AppOptions.componentSystems` 默认是空数组**（`app-options.js:16-17`），`AppBase.init` 只注册你列进来的。
  漏了的后果是 `entity.addComponent("camera")` **什么也不做、`entity.camera` 是 undefined、零报错**。
  显式清单**不是优化而是必需**；`app.ts` 里还加了一道 `init` 后的必需系统校验。

### 多窗格

- **每个窗格都必须清深度**（`clearDepthBuffer: true`）。多窗格共享同一个深度附件，只清第一格时
  其余窗格的深度区保留残留值 → 深度测试全灭 → **整格纯黑且零报错**（本机二分定位：同机位无效、
  每格只清深度即恢复）。**每格清屏并不阻断 pass 合并**（非满尺寸 rect 的清屏是 pass 内被 viewport
  裁剪的 quad，不是 `loadOp: clear`）。
- **`camera.rect` 是归一化、左下原点**；DOM 测量（`viewRect()`）是左上原点。
  必须 `y = 1 - (top + height) / canvasHeight`；**不要自己再翻一次**——WebGPU 后端会翻（`webgpu-graphics-device.js:1867-1891`），
  WebGL 不翻，所以 rect 语义是后端无关的。分母用**画布 CSS 尺寸**（归一化后 DPR 自然抵消）。
- **layer id 0–4 是引擎默认层的**（World/Depth/Skybox/Immediate/UI）。逐窗格 HUD 层必须**新建**
  （`new Layer({ name })` 不给 id，`layer.js:87-90` 会自动分配），不要拿 0–4 当"应用自己的层"。
- 验收看 **`startRenderPass` 是否 ≈ 每帧 1 次**（1/2/4 窗格实测都是 1）——它比 `TRACEID` 直接，
  不需要 debug 构建。

### 指针输入（`paneInput.ts`，每格各自输入）

- **不能用引擎自带的 `orbitCamera` 脚本**：它是**全局输入**（挂 `app.mouse`、对整张画布生效）。
  `paneInput.ts` 按与 `camera.rect` **同源**的 CSS px 视口命中测试，自己接指针事件；
  手势一旦在某一格按下就**绑定那一格**，指针拖到别的格子上也不改弦更张（真机断言过）。
- **拖动必须 `setPointerCapture` 且在 `window` 上收 `pointermove`/`pointerup`/`pointercancel`/`blur`**：
  只听画布自己的 `pointerup` 时，指针在画布外松手就没有 up 事件，手势**永久粘住**
  （此后每次移动都在转视角）。`pointercancel`/失焦/布局变化都要按"抬手"处理。
- **`wheel` 监听必须 `{ passive: false }`**：passive 里 `preventDefault()` 静默失效，
  滚轮会**同时**缩放页面（控制台只有一条 warning）。命中窗格时要 `preventDefault()`。
- **双击是自算的，不要挂 `dblclick`**。实测（Chrome 154，真实事件）：本层取消 `pointerdown` 默认行为后
  **`mousedown` 被抑制（0 次）**，而 `click`/`dblclick` **照旧派发**——兼容事件的生成规则是浏览器实现细节、
  而我们在扰动它，所以双击按"两次左键点击 + 位移/间隔在窗口内"自己判定。
  **推论：画布上的拾取要走指针事件，`mousedown`/`mouseup` 已经收不到。**
- **正交窗格的滚轮/缩放不动**：可见高度是产品常量 `ORTHO_VIEW_WORLD_HEIGHT`（15 世界单位），缩放会破坏它。
  俯视窗格平移要把它自己的 up（`(0,0,-1)`）传给 `panBy`，否则方向差 90°。
- **旋转/平移/中键缩放的比例尺按窗格高**，不是画布高。three 侧 `OrbitControls` 挂在整张画布上：
  4 窗格布局下它的旋转、平移、缩放全都只有**一半**响应（平移时模型不跟手）。这是与 three 侧的**有意**差异。

### 拾取与变换 gizmo（`panePicking.ts` / `paneGizmo.ts`）

- **用引擎自带的 `pc.Picker`，不要照抄 SuperSplat 的 `picker.ts`**。引擎那份已经把 ID pass + 深度 pass
  做完，而且 WebGPU 路径**自己就是** `texture.read(…, { immediate: true, renderTarget })`；SuperSplat 那份是
  **splat 编辑专用**（`prepareId(splat, 'add'|'remove'|…)`）。只借它一条**坐标约定**：
  读缓冲用**画布归一化坐标 × 缓冲尺寸**（不是窗格局部坐标）——`panePicking.toPickPixel()` 就是这条。
- **`Picker.prepare(camera, scene, layers)` 的 `layers` 必须只给共享核心层**（`[worldLayer]`）。不传就是相机的
  全部 layers，于是 HUD 坐标轴球与 gizmo 手柄也会被拾取到（症状：点空白也选中东西）。
- **splat 拾取要先 `scene.gsplat.enableIds = true`**（默认 **false**，`gsplat-params.js:142`），
  否则 splat 永远选不中而模型能选中。`MeshInstance.pick` 默认是 `true`（`mesh-instance.js:100`），不用自己开。
- **`Picker.prepare()` 是同步渲染一趟**（`RenderPass.render()` 自己 start/end pass），读回是异步的：
  **不要每帧、也不要每个 pointermove 都拾取**（悬停高亮要另想办法）；并发拾取必须串行化（同一块缓冲）。
- **变换手柄用引擎的 `TranslateGizmo`/`RotateGizmo`/`ScaleGizmo`，逐窗格各一个**。它们的射线走
  `camera.screenToWorld()`，按 `camera.rect` 换算（`camera.js:538-541`），所以指针在别格时 NDC 落在
  [0,1] 之外、本格自然不响应——**不需要**自己写逐格输入路由。
- **`Gizmo.destroy()` 不删层**（`gizmo.js` 的 `destroy()` 只摘监听 + `root.destroy()`），而
  `Gizmo.createLayer()` 把层插进了 `scene.layers`。不自己 `removeLayer` 就是每轮泄漏一层。
- **gizmo 层必须走 `PaneSpec.extraLayerIds`**：`PaneRegistry.sync()` 每次都重写 `camera.layers`，
  gizmo 在构造时 concat 进去的层下一次同步就被抹掉（症状：手柄突然不画、零报错）。相机 layers 只能有一个写入点。
- **拖手柄时必须让出指针手势**：订阅引擎自己的 `transform:start` / `transform:end` → `PaneGizmoHandle.dragging()`
  → `PaneInputHost.isPointerClaimed`。输入层还会在 `move()` 途中复查（`paneInput.ts`），所以**不依赖两边监听器的注册顺序**。
- **点击手柄不会变成"选择"**：手柄认领了那次 pointerdown，输入层就不开始手势、也就没有 `onClick`。
  这与 three 侧 `pickSuppressedRef` 的行为一致（gizmo 拖动期间不选中/不聚焦）。
  要测"点击选择"、或在手柄附近放可点物体时，必须**避开手柄**（本仓库的探针往 −X 偏了 0.45）。
- **双击聚焦有两种口径**：three 侧现行的是"**摆放位置 + 固定偏移 `[3,2,3]`**"
  （`widgets/Viewport/index.tsx:113-114,453-469`），**不是**包围球。`focusRigWithTarget()` 两种都支持
  （`{center, radius}` / `{center, offset}`）；正交窗格两种都只挪目标点。

### 网格与 HUD（`paneGrid.ts`）

- **`plane` 图元默认就在 XZ 平面、法线 +Y**（`plane-geometry.d.ts:35-41`；宽度沿 X、长度沿 Z）。
  three 的 `planeGeometry` 在 XY 平面，所以从 three 照搬来的 `rotation-x={-Math.PI/2}` 会把地面**立起来**：
  症状是"网格变成屏幕中间一条横带 + 整片均匀灰"，**零报错**。本机踩过。
- **网格必须 `pick = false`**：`MeshInstance.pick` 默认 `true`（`mesh-instance.js:100`），
  而这是一张 400×400 的平面——不关掉，每次点击都先命中地面（three 侧对应写法是 `raycast={() => {}}`）。
- **淡出圆心用逐相机的 `view_position`**（view uniform buffer 的标准 uniform，
  `UniformFormat("view_position", UNIFORMTYPE_VEC3)`）。它是**按相机**填的，所以每格各自淡出；
  换成材质参数或常量就变成"所有窗格共用一个圆心"。
- 网格间距/半径是**编译期常量**（按参数拼 `uniqueName`，改参数 = 换着色器变体）。**没做**的路线是
  把它们做成材质 uniform：引擎把非 view 集合的 uniform 塞进 `ub_mesh_ub`
  （`webgpu-shader-processor-wgsl.js` 的 `processUniforms`），那条上传路径本仓库**没验证过**，不要依赖。
- 网格挂在共享核心层、**整场景一份**就够（所有窗格都看见）。实测它**不增加 pass**：
  网格 + 变换手柄同时挂着，`startRenderPass` 仍是 240/240（每帧 1 个）。

### 坐标轴球 HUD（`paneAxisHud.ts`）

- **不要为 HUD 再开相机**：把部件放在**相机前方固定深度**、按 `worldPerPixel` 缩放就得到屏幕等大
  （透视 `2·depth·tan(fov/2)/窗格高`，正交 `2·orthoHeight/窗格高`）。多开 4 台 HUD 相机会把
  "每帧 1 个 pass" 的验收线重新搅乱。
- **`GraphNode.forward` 是看向的方向**（世界 -Z，`graph-node.js:96-101`），"相机前方"是
  `+forward×depth`；写成 `-forward` 会把部件放到相机背后（不报错、就是看不见）。
- HUD 层同样要 `clearDepthBuffer: true` 且**进 `PaneSpec.extraLayerIds`**（同 gizmo：`sync()` 会重写
  `camera.layers`）。
- **`isPointerClaimed` 会连 `onClick` 一起吞掉**：被认领的按下既不开轨道手势、也不发点击。
  所以"点一下要做事"的部件（坐标轴球）必须走 **`onClaimedClick`**；而**DOM 层要为被认领的按下
  也挂上 window 的 move/up**，否则那次 `pointerup` 收不到、回调永远不触发。
  点 gizmo 手柄**不该**选中物体，点轴球**该**吸附机位——这两件事因此是两个回调。

### 第一人称与相机飞行（`walkRig.ts` / `rigFlight.ts`）

- **请求指针锁定要挂在 `pointerdown` 上，不能挂 `mousedown`**：本层在 `pointerdown` 上
  `preventDefault()`，浏览器就不再派发兼容的 `mousedown`（§三之六实测）——挂 `mousedown` 等于**永不触发**。
  页面内合成事件抓不到这个缺陷（合成指针本来就拿不到锁定），只有可信事件那一轮能抓到。
- **本沙箱里"指针锁定权限"无法验证**：Chrome 直接拒绝，`WrongDocumentError: The root document of this
  element is not valid for pointer lock.`——自动化窗口没有 OS 级焦点，`Emulation.setFocusEmulationEnabled`
  也不够。所以真机判据只能写到"**handler 确实被触达**"（错误码就是证据），锁定之后的按键/鼠标路径
  用探针的 `forceLock` 配合**真实按键事件**与**真实鼠标移动**来验。
- **第一人称是另一份状态，不要往 `CameraRig` 里塞**：台架是 turntable（只有方位角/极角/距离），
  表达不了"站着转头再走出去"。`walkRig` 用"眼睛位置 + 偏航/俯仰"，**高度锁在 1.6**、Shift 加速（3→7）、
  单帧 `delta` 钳 0.1 s、俯仰钳 ±(π/2−0.01)；灵敏度沿用 three `PointerLockControls` 的 **0.002 rad/px**。
- **飞行是渲染循环的事**：`rigFlight` 只回答"下一帧在哪、到了没有"，由 `app.on("update")`/rAF 驱动；
  它是**可取消**的（用户一有输入就 `cancel()`），并且每帧**重新读当前台架**——所以"飞行途中再聚焦"
  会从半路重新瞄准（这是正确语义，别拿过期目标去比）。
- **探针里任何"自己摆已知机位"的自检，先 `flight.cancel()`**：飞行器每帧都会 `apply`，
  不取消就会把后面自检摆的机位拉回插值轨迹（实测让 picking/grid/hud 的像素与台架判据全挂）。

### 多选整体变换与摆放约定（`selectionTransform.ts` / `panePlacement.ts`）

- **引擎的欧拉 API 与 three 不是同一套约定，两个维度都不同**（本机实测，`selectionTransform.test.ts`
  里用 three 当真值钉住）：**单位**是角度（`quat.js:88`、`mat4.js:596` 的 DEG_TO_RAD），
  **顺序**是 **ZYX**（与 three 的 `Euler(x,y,z,'ZYX')` 差 2.7e-8，与 `'XYZ'` 差 0.43–1.73）。
  摆放（`scene.json`）是 three 的**弧度 + XYZ**。**直接互喂 `setFromEulerAngles`/`setEulerAngles`/
  `getEulerAngles` 会静默转错朝向**——不报错、只是模型转错。所以：欧拉↔四元数自己写
  （`quatFromEulerXyz` / `eulerXyzFromQuat`），实体读写**只走四元数**（`panePlacement.ts`），
  其余（乘/逆/TRS/分解）用引擎 `Mat4`。跨引擎等价性由单测钉住（同一位姿两套引擎同矩阵）。
- **引擎的 `Mat4.data` 是 `Float32Array`**（`mat4.js:11`）：往返误差 **1e-7 量级**，
  判等阈值别写 1e-9（会得到假的失败）。
- **轴心口径与 three 侧逐项一致**：单选 = 该成员自身摆放（gizmo 落在物体原点上）；
  多选 = 各成员**位置**包围盒中心 + 姿态归零 + 缩放归一（`selectionPivot`）。
- **`begin()` 冻结的是"控制器当前轴心"的相对矩阵**：摆放变了之后不先 `reset(members)` 就 `begin()`，
  冻结出来的相对矩阵对应旧轴心，成员会被摆到错的位置。
- 绕 Y 轴转 90° 的判据用解析式 **(x,y,z)→(z,y,−x)**；不要用"三维夹角≈90°"（偏移带 Y 分量时不是 90°）。
- **多选拖动必须显式接到 `PaneGizmoOptions.onDragStart/onDragEnd` 上**：引擎会拖**轴心实体**，
  但它**不会**通知你的控制器——`begin()`（冻结相对矩阵）与 `end()`（提交一次）都得自己挂。
  曾因为一次文本替换**静默没匹配上**（锚点过期 = 空操作、我又没断言），得出过"引擎拖不动实体、
  根因未定位"的错误结论；真凶是接线没生效。**探针里的接线改动要用断言过的替换，跑之前确认落地。**
- **诊断要读"实体"，不要读控制器内部状态**：`selection.pivot()` 只由 `reset/update` 写，
  拿它判断"实体动了没有"必然读到旧值（要读 `readEntityPlacement(pivotEntity)`，探针里有
  `multiPivotEntity()` 这个活口）。
- **第一人称：不要把"点画布"默认当成"进入漫游"**。探针里漫游模式一直开着，而它的 `pointerdown`
  监听**无条件**请求指针锁定——可信驱动点的第一下就是用户手势，锁定一旦成功，`pointerlockchange`
  就把 `walkLocked` 置真，**漫游 tick 从此每帧改写相机**，其它一切交互（拖动/拾取/轴球/逐格隔离）
  全部静默失效；而且**时有时无**（取决于那一下锁定批没批）。改成**显式备好**才请求
  （`__PC_WALK__.armLock(true)`），产品里第一人称本就是显式进入的模式。
- **相机实体与台架必须一致**：第一人称的 `applyWalk()` 是**直接写实体**、不走台架，于是
  "实体位置 vs `rigs`"会不一致，后面的相位建在这个不一致上就会大片假失败。驱动/自检开局要
  `resetCameraState()` 并**反复重写直到 `camera == rigPosition(rig)`**（最多 5 次）+ 断言。
- **漫游 tick 是"每帧改写相机实体"的全局写入者**：探针里跑别的交互（拖动/拾取/轴球/逐格隔离）前必须
  `__PC_WALK__.suspend()`（停 tick + 解锁 + 清键），第一人称那一段再 `resume()`。产品里这两种模式
  本就互斥，所以挂起是正常语义。
- **合成按键必须成对 `keydown`/`keyup`**：只发 `keydown` 会把按键留在集合里污染后面的自检
  （实测高亮自检的 's' 让第一人称的 `forward = w − s = 0`，"漫游一步都不走"，`steps 0`）。
  自检里最好把"按住期间/若干帧后的按键集合 + tick 步数"记进报告，症状一眼可见。

### 选中线框（`selectionBounds.ts` / `selectionWireframe.ts`）与 G/R/S（`transformKeys.ts`）

- **引擎的 `Vec3` 只有 `.x/.y/.z`，没有数字下标**。`aabb.center[0]` 会静默得到 `undefined` → 一路 NaN
  （`entityWorldBounds()` 就这么错过，选中线框完全不显示）。类型上要**如实建模**（`EngineVec3Like`），
  否则 `center[0]` 能通过编译。**测试假数据也必须用引擎形状**——两处一起错时测试照样绿
  （本机踩过：假数据写成元组 `[1,2,3]`，实现读 `center[0]`，谁都没发现）。
- **线框绝不能参与命中**（`meshInstance.pick = false`）：由指针状态产生的视觉反馈反过来参与命中，
  状态与命中区就互为因果（三侧那段长注释解释了 LineSegments 阈值撑出的隐形命中壳）。自检直接断言= 0。
- 线框用**持久 line 网格**（`Mesh.setPositions` + `PRIMITIVE_LINES`，WebGPU 后端映射到 `line-list`），
  不要用引擎的 `app.drawWireAlignedBox()`：那是立即模式，每帧都要重新提交（静止场景也跑）。
  层用 `clearDepthBuffer: true` ⇒ 等价 three 的 `material-depthTest=false`，且同样要进 `extraLayerIds`。
- **G/R/S 有四道闸门**（对齐 three 侧 `index.tsx:570-586`）：输入框/contentEditable 不抢键、
  带 meta/ctrl/alt 不管、没有选中不管、第一人称不管。世界/局部是**工具栏按钮**不是快捷键。

### 资产 → 实体（`assetScene.ts`，§五.5 的第一块）

- **GLB 用 `assets.loadFromUrlAndFilename(url, "model.glb", "container", cb)`**（引擎示例
  `viewer.example.mjs:450` 的写法）。`new Asset(name,"container",{url})` + `AssetListLoader` 拿到的
  `instantiateRenderEntity()` 是**空树**（`hasRender:false`）；而且**失败在回调的 `err` 参数里**，
  只监听 `error` 事件会漏掉真正的失败。
- **`sync(specs)` 必须幂等**：React 每次渲染都给新数组，逐项比 `id`；同一个 id 只在 **URL 变了**
  时重建（换代），否则只更新摆放与材质——否则每帧重建整个场景。
- 摆放写回仍然**只走四元数**（`panePlacement`）；splat 资产必须 SPZ v4。
- **`ViewportProps` → 场景规格**走 `viewportSceneSpecs.ts`（纯函数）：修订号**按资产发**（`resourceRevisions`），
  摆放按**稳定 id** 取（`computeSceneLayout`），**已带 query 的 URL 要用 `&revision=`**（写死 `?` 会静默 404）。
  现实里 splat 资产一律 `kind:"world"`（背景，第一切片不渲染），所以走布局那条路的只有模型；
  `skipped` 里要显式列出被跳过的资产与原因，否则"模型没出现"无从判断。

### 视口接入（`widgets/Viewport/PlayCanvasViewport.tsx`，§五.5）

- **`?pcViewport=1` 才分流**到 PlayCanvas 视口，**默认仍是 three**；`ViewportProps` 一个字段都没改
  （只把接口加了 `export`）。`pages/` 是冻结集，所以开关只能开在非冻结的 `widgets/Viewport/index.tsx` 里。
- 装配顺序：`useRendererSession`（设备/app）→ `createEnginePaneBindings` → `new PaneRegistry({...bindings})`
  → `registry.sync(specs)` → `applyRig(entity, rig, {perspective, orthographic})` → 网格/HUD/输入/拾取。
  **HUD/gizmo/线框的层必须在 `sync` 之前进 `PaneSpec.extraLayerIds`**（`sync` 每次都重写 `camera.layers`）。
- **检查图（agent 的 `inspect`）**：`inspection` 请求一来就调 `captureInspectionSheet(app, {center, radius})`
  拍四视角 PNG → `onInspectionCaptured(id, png)`；失败回 `null`（别让 agent 干等），且**同一个 id 只拍一次**
  （否则每次渲染重拍）。取景时注意形状：`entityWorldBounds()` 给**引擎 `Vec3`**，`Bounds3` 是 `{min,max}`
  元组，取中心/尺寸要用 `boundsCenter`/`boundsSize`。真机读数：60 528 字节 PNG、零错误。
- **两个静默全黑的坑**（真机踩过，都是"挂载成功、零报错、画布全黑"）：
  ① 画布/宿主的**尺寸不能只靠 Tailwind 类**——探针页没样式表时画布停在元素默认 300×150，用内联样式兜底；
  ② **`RendererSession` 不启动渲染循环**，必须调用方 `app.start()`（它只提供 `stopLoop()` 取消 rAF）。
- **gizmo/控制器的接线顺序**：`members()` 依赖**已挂上**的资产实体，而资产是**异步**挂的、
  gizmo 那个 effect 是同步跑的 → 必须在**资产就绪后再复位一次**轴心与线框（否则轴心恒为 null、拖不动）。
- **没选中时必须 `attach(null)`**：引擎的 `enabled` 只看 `nodes.length > 0 && 距离>eps`，
  "挂着但没选中"的手柄照样画、照样**抢点击**（点空白既不清空选中也不触发拾取）。
  推论：**有选中时点击被手柄认领才是对的**，判据要与"点空白清空选中"分开。
- 验证级别：**真机已跑**（`app/pc-viewport.html` + `.tmp/pc-panes/drive-viewport.mjs`）：
  空场景亮像素 7 175 / 真实 GLB 24 141；`--select` 那轮 hover 命中 +X 手柄、
  **`onTransformCommit` 收到 3 条 `{ids:["probe-model"],mode:"translate"}`**、零错误。
  驱动取样要**轮询到非黑**再抓（睡固定时长会抓到全黑 → 假失败）。
- **G/R/S 走 `transformKeys` 的契约**（输入框/meta/ctrl/alt/无选中/第一人称四道闸门），并且
  **键位表外的按键不要 `preventDefault`**（否则吃掉别的快捷键）。真机判据用**可信按键**：
  `r→s→g` 的模式序列 + 聚焦 `<input>` 后按 `r` 模式不动。
- **多窗格的逐格像素视口**：1 = 整块 / 2 = 左右各半 / 4 = 2×2 象限，**必须与 `LAYOUTS` 的 DOM 顺序
  一致**（`index % 2` 是列、`index / 2` 是行）；`camera.rect` 是按**画布 CSS 尺寸**归一化的。
  层 id（HUD/gizmo/线框）要**逐格**进 `extraLayerIds`。判据用**快照的四象限亮像素**：
  4 格实测 `[7895, 7895, 7894, 7894]`（"只画一格"或"rect 全一样"都会明显不齐）。
  未接的部分见 §三之十四。
- **正交格的 `camera.orthoHeight` 是"世界单位半高"**，真源只有 `cameraRig.ORTHO_VIEW_WORLD_HEIGHT`
  （=15，半高 7.5）。`paneRegistry` 以前默认写成**像素半高**（`pane.viewport.height`）→ 正交格
  "看得极远"、画面里只剩一个小方块（实测俯视格只剩 94 个亮像素）。已改 + 回归测试。
- **工具栏按钮按 `aria-label` 找**（与 three 侧同一套文案：`Single view` / `Two views` /
  `Four views (Blender layout)` / `Hide grid` / `Show grid` / `Undo` / `Redo`），
  探针用 CDP 可信点击驱动它。**按钮样式必须内联**——探针页没有样式表，Tailwind 类会全失效。
- **PlayCanvas 的线框不是材质标志位**：`StandardMaterial` 上**没有** `wireframe`；正确做法是
  `meshInstance.renderStyle = RENDERSTYLE_WIREFRAME`（引擎为每个 mesh 备了线框索引缓冲，
  setter 里 `mesh.prepareRenderState()` 会挑对那份）。**已真机验证**：27/27 个 mesh instance 切过去、
  亮像素 28 452 → 13 010、`Shift+Z` 关掉后**一模一样地回到 28 452**。记账表**不能覆盖原值**
  （否则第二次 apply 会把线框记成原值、关掉后永远回不去）。**判据要盯引擎事实**（状态 +
  切了几个 + 能否复原），别猜"亮像素会往哪边走"。
- **切换投影要同时改三处**：台架 `rig.projection`、相机 `applyRig`（正交还要配对 up）、
  以及 `registry.sync` 的 `projection`——**只改前两处会被 `sync` 盖回透视**（`sync` 每次都重写
  `camera.projection`）。真机判据：相机 `projection` 从 0 变 1，且切换后画面仍非空。
- **俯视格的 up 必须传 `ORTHO_UP.top = [0,0,-1]`**：正上方时视线与默认 up `(0,1,0)` 共线，
  `lookAt` 退化 → 那一格几乎全空（症状与上一条很像，但根因不同：一个是朝向垃圾、一个是看得极远）。

### Splat

- engine GSplat 用默认的 **`unified = true`**（WebGPU 上 = GPU compute radix sort，每帧每相机、
  **无 CPU 回读也无同步等待**）。**不要设 `false`**：legacy 路径 `gsplat-instance.js:137` 硬编码
  `cameras[0]`，多视图排序**是错的**（不是慢，是错）。2.22.6 的默认值也已核实是 `true`。
- **资产必须是 SPZ v4**。解析器只认 version 4；本项目原有的四份 `.spz` 全是 legacy（头部 `1f8b` = gzip），
  必须用 `@playcanvas/splat-transform` 转（实测 1.92M 约 2.5 s）。已转好的在 `.tmp/pc-assets/`
  （`world-150k-v4.spz` / `world-full-res-v4.spz`），探针用 `asset=/@fs/<绝对路径>` 加载。
- **splat 拾取的判据要写成负对照**："开着 `enableIds` 能选中、关掉选不中"（同一投影点）。
  只测"能选中"的话，把 `enableIds` 写成恒真也能过。实测两个真实资产：默认 **false**、
  开着命中 `kind:"gsplat"`、关掉 `null`。
- **ZSTD 解码器要自己 vendor**：它在引擎仓库的 `examples/assets/wasm/zstd/` 下、
  **不在 npm 包的 `files` 白名单里**。胶水是 IIFE（靠 `window.ZstdDecoderModule` 注册），
  不能当模块打进来——用 Vite 的 `?url`。见 `playcanvas/vendor/` 与 `splat.ts`。

### 截图与模型描述

- **不要移植 three 侧的 `unpackRGBA`**。three 的读回带 256 字节行对齐所以要手工解；
  PlayCanvas 的 `Texture.read` **自己**解（`webgpu-texture.js` 里 `roundUp(bytesPerRow, 256)` 后逐行拷贝）。
  实测判据：返回的 `bytes` **恰好等于 `w*h*4`**。
- **`Texture.read` 在帧外必须 `immediate: true`**，否则会在拷贝执行前 map staging buffer、读到零值。
- **`Texture.getSource()` 返回的就是 level，而对 GLB 贴图这个 level 本身就是 `ImageBitmap`**——
  图像**不在** `level.source` 上（证据：引擎 `releaseImageSources()` 直接判 `level instanceof ImageBitmap`）。
  按 `.source`/`.img`/`.data` 找会全落空，症状是"尺寸读得到、缩略图全 null"。
- `RenderTarget` **没有 `width`/`height`/`colorFormat` 选项**——尺寸与格式来自你给的那张纹理。
- **`CaptureQueue` / `ResourceBudget` / `useCaptureResult` / `ModelResources` 的纯逻辑部分不要重写**：
  它们与引擎无关（优先级、老化、尺寸阶梯降级、两本账取更紧一侧）。只有底层"渲染进私有 RT + 读回"要换。
- **设备丢失不是终态**：引擎自己会重建设备（`handleDeviceLost` → `fire('devicelost')` → `createDevice()` →
  `fire('devicerestored')`）。不要一丢就判死、也不要在释放时忘了退订。

### 编辑层边界（这是迁移的前提）

- `app/src/pages/`、`widgets/Inspector`、`AgentDock`、`Sidebar`、`SettingsDialog`、**`widgets/ModelList`**、
  `shared/storage` 是**冻结集**：渲染层换引擎时它们**不得改**。
- `app/src/pages/editingLayerBoundary.test.ts` 用真实模块依赖图守这条线（规则 A/B/C）。
  它有三张例外表，**语义各不相同，不要合并**（规则 D 会拦住重叠）：
  `SEAMS`（跨集目标）、`FROZEN_IMPORTERS`（集内直接导入渲染库，属**待消除的越界**）、
  `RENDERING_COMPONENTS_IN_FROZEN_DIRS`（**本来就不属于编辑层**的 3D surface，两条规则都豁免）。
  三张表都有**失效检查**：某条不再被触达时测试会失败要求删除。
  **不要为了让测试过而把表清空或乱塞**；新增条目必须写清"为什么允许"与"迁移时怎么处理"。
- 渲染层要告诉编辑层"这个模型有哪些通道"时，走 **`shared/lib/modelDescription.ts`**（按稳定 id `asset.id`
  索引的模块级 store），**不要**让编辑层自己挂载模型加载器去遍历引擎对象——那正是已经消除掉的越界。

### 真实业务页面怎么验（PlayCanvas 分流）

`node .tmp/pc-panes/drive-app.mjs <baseUrl> <slug>` → 打开 `/app/<slug>?pcViewport=1`。
**门禁必须开局就调**（`gpu-probe.mjs` 的配方），而且它会 `location.reload()`：重载后第一次 evaluate
必然失败，要**吞掉再轮询**。（踩过：写成"只有读不到状态时才解锁"，而门禁页读得到状态 → 永远不解锁。）
项目数据在 `~/ChatSpace/projects/*`、chat 服务在 `127.0.0.1:3901`。
**真实页面上抓到过、探针掩盖掉的三条**（前两条已修）：① 资产 URL 必须过应用的 `libraryUrl()`
（逻辑路径直接 fetch 会拿到 `index.html`，引擎报 `found 0x6f64213c`＝`<!do`）；
② 资产 effect 不能依赖每次渲染换身份的 `props.assets`（否则反复重建、永远挂不上）；
③ ✅ **加载器必须带超时**（引擎 container 加载在某些响应下既不回调也不报错 → `await sync` 悬死；
`assetScene.withTimeout` 就是这条，超时按 `onError` 报、原错误照原样透传）。
另外真实项目的 world 是 **legacy SPZ**，引擎只认 v4 → 世界要显示得先转产物（资产产物侧的事）。
**判据取样时机**：资产 sync 是异步的（失败资产还要等超时），驱动必须**轮询到规格列表出现**再判，
否则会把"还没加载完"读成"资产没挂上"（本机踩过：读成 `0`，修好后是**挂上 10 件**）。
实测：视口挂载、画布 1470×715、**挂上 10 件真实模型资产**、PC 工具栏在页面上、零 JS 错误
（§三之十四 第 14 条）。

### 拾取 → 选中（`PlayCanvasViewport` 的 `onClick`）

- **命中的实体要按"身份"解析，不要按"名字"比**：`Picker` 给的是引擎实体（`container` 实例化出来的
  根名可能是文件名/"model.glb"），拿它去比 `asset.id`/`assetSlug` 比不中 → 把"点中模型"当成
  "点空白"而**清空选中**，症状是**怎么点都选不中**（真机扫 28 个点全落空，本机踩过）。
  正确做法：从命中实体沿**已挂载树**往上找（`assets.entry(id).entity` 是同一棵树，`isDescendantOf` 两边都试）。
- 真机判据：探针页点击回调应该是 `["select:probe-model"]`（不是 `["clear"]`）；
  真实页面 `--interact` 里 `membersAfterClick` 必须 ≥ 1，**有选中之后**再验 `r/s/g` 换模式
  （没选中时"不抢键"是契约要求，判据要相应放宽）。

### 默认光照（`sceneLighting.ts`）

- **PC 视口必须自己接光**：引擎 `scene.ambientLight` 默认就是 `(0,0,0)`（`scene.js:29`），
  而 Tripo 的 GLB **不带灯** → 所有受光项为 0，症状是"挂载成功、贴图也挂上了、画面上只有黑色剪影"
  （真机读数：`findComponents("light") = []`、亮像素 7104）。`createSceneLighting()` 按 three 侧
  **同一份数值**（ambient 0.6 + 两盏 directional 1.4 / 0.4）建，方向用 `setPosition` + `lookAt(0,0,0)`
  表达（引擎平行光是实体 −Z，**不要**手写欧拉角）。
- **这条探针测不出来**：`panes.browser.ts` 的台架自己加了一盏平行光——改光照相关代码必须**在真实业务
  页面**上验（`.tmp/pc-panes/inspect-lighting.mjs` 读的是引擎事实，不是组件自述）。
- **环境贴图必须有无条件兜底**：本项目产物 `metalness: 1`，金属几乎没有漫反射项——没有 `envAtlas`
  时贴图只剩高光，看着就像"贴图没显示"。兜底是 **`/env/sky.jpg`**（引擎认的 equirect）；
  **不要用 three 侧的 `/env/sky.exr`**（引擎只认 img/dds/basis/hdr）。候选表按"项目产物 → 兜底"
  顺序试，第一个成功的生效。

### skybox / 环境贴图

`scene.envAtlas`（IBL）+ `scene.skybox`（可见天空）都收 `Texture`。**两条已知阻塞**：
① ⚠️ **引擎 2.22.6 不认 `.exr`**（贴图解析器只有 `img`/`dds`/`basis`/**`hdr`**，全仓库无 `exr`）。
天空盒产物是 EXR 时**那一条候选必然失败**，视口会落到默认 `/env/sky.jpg`——所以画面不会黑，
但**项目自己的天空盒用不上**；要真正用上得换产物格式。
② ✅ **修复方式（已真机验证）**：**不能把 equirect 的 2D 贴图直接喂 `envAtlas`/`skybox`**——引擎**静默丢弃**
（赋值后 `scene.envAtlas` 仍是 null、Sky 层 0 个 mesh、开/关天空盒像素逐位相同）。要走引擎自带管线：
`EnvLighting.generateSkyboxCubemap(equirect)` → **cubemap** 给 `scene.skybox`；
`EnvLighting.generateLightingSource` → `EnvLighting.generateAtlas` → 给 `scene.envAtlas`。
真机：清掉前读引擎状态 `{skyLayerInstances:1, hasSkybox:true, hasEnvAtlas:true}`、A/B 均值 **62.174 → 19.951**。
**两条纪律**：① **诊断读引擎状态，不要读自己的记账**（`applied:true` 是自述）；
② **A/B 先确认被改的字段就是驱动该现象的字段**（可见天空是 `Sky` 网格用 `texture_envAtlas` 画的，
`playcanvas.mjs:37328-37342`；只清 `skybox` 会得到"逐位相同"的假结论）。
另：每格相机的 `layers` 需要含 Skybox 层 2（`PaneRegistryOptions.sharedLayerIds`）。
③ 🔴 **仍未解**：EXR 天空盒产物在引擎侧仍然不可用（现在靠默认 `/env/sky.jpg` 顶着，不是项目那张）；
要可用得换产物格式（`.hdr` / equirect 图 / cubemap）。

### 第一人称（组件里）

`PlayCanvasViewport` 的「第一人称」按钮：进入即 `setLayoutMode(1)`、从当前台架派生眼位（**高度锁 1.6**）
与朝向；**指针锁定挂在 `pointerdown` 上**；每帧 `app.on("update")` 从 `walkRig` 算下一步并**直接写相机实体**；
退出时 `applyRig` 把相机还给台架并**清空按键**。真机验过：真实 `W` → `steps 90`、z 9.67→5.18、高度 1.6；
可信鼠标 → 偏航 0.058→0.850。沙箱拿不到真锁，判据走 `__PC_VIEWPORT_FORCE_LOCK__` + 真实键鼠。

### 诊断口（`viewportDebug.ts`）

10 个 `window.__PC_VIEWPORT_*` 活口**只在开发构建 + `?pcDebug=1` 时**才装（原先无条件装、
真实业务页面也被装上 ✗）。探针/驱动的 URL 都显式带 `pcDebug=1`（`PC_DEBUG=0` 可关，用来验开关本身）。
**纪律**：① 组件内部要用这些能力，必须走**本地 ref**（`transformApiRef`），**绝不能绕 `window` 上那个钩子
回调自己**——一加开关，生产路径就读不到它、静默失效（本机踩过：`syncSelection()` 不跑 → gizmo 拖不动）；
② 新增诊断口要加进 `VIEWPORT_DEBUG_NAMES`（卸载时按名单清）。

### 探针怎么跑

`bun run dev:web` 起 dev server（注意别和用户已有的 5173 抢），然后
`node .tmp/pc-panes/drive.mjs <baseUrl> <panes> [extraQuery]`。两个环境陷阱（都会读出**假的 0**）：

1. 应用有**访问门禁**。规范做法是调应用自己的 `passAccessGate()`（照 `app/scripts/gpu-probe.mjs:232-247`），
   **不嗅探 DOM 文案、不硬编码口令**。
2. **解锁只写 localStorage，已渲染的门禁页不会因此重渲染**——必须**解锁后重载页面**；
   重载又会销毁执行上下文，所以要带重试。

`pc-panes.html` 这个渲染层探针没有门禁。**像素判据必须先怀疑采集时机，再怀疑状态**：
在 rAF 之外读 WebGPU 画布会读到**全黑**（尤其在某次帧外 pass 例如 `Picker.prepare()` 之后），
于是"挂上/摘掉"的像素签名比较会假阴性——探针现在统一 `settle()` 等若干帧、**在 rAF 回调里**抓快照，
各像素辅助函数只读快照。踩到过的症状：每个模式单独跑都过，组合起来 grid 的 `mean` 全是 0。

另有这些入口（**指针输入必须走真机，单测证明不了**）：

| 命令 | 覆盖 |
| --- | --- |
| `drive.mjs <baseUrl> <panes> "input=1&picking=1&gizmo=1"` | 页面内**合成事件**自检：轨道/滚轮/平移/双击 + 多窗格隔离 + 画布外松手不粘住 + 投影点拾取/空白对照 + gizmo 逐格像素隔离 |
| `drive.mjs <baseUrl> <panes> "grid=1"` | 地面网格自检：**每一格**都看见、两级都真的在画（俯视机位下比"网格线像素数"）、淡出生效、**逐相机**淡出、不可拾取、pass/帧 |
| `drive.mjs <baseUrl> <panes> "grid=1&gridLook=1"` | 同上，但**结束时停在俯视机位**（诊断截图用） |
| `drive.mjs <baseUrl> <panes> "hud=1"` | 坐标轴球 HUD 自检：逐格隔离、**屏幕等大**（已知机位下 ±X/±Y 间距应为 80 px，退远 3 倍不变）、轴球随相机转、命中与吸附、pass/帧 |
| `drive.mjs <baseUrl> <panes> "input=1&picking=1&gizmo=1&grid=1&hud=1"` | 五套自检一起跑（1/2/4 窗格都过）——**改探针后先跑这个** |
| `drive.mjs <baseUrl> <panes> "input=1&picking=1&gizmo=1&grid=1&hud=1&flight=1&walk=1"` | 七套一起跑（1/2/4 窗格都过）：另加**聚焦飞行**（逐帧收敛/到位/输入即取消）与**第一人称**（WASD/Shift/高度锁定/转头/解锁即停） |
| `drive.mjs <baseUrl> <panes> "asset=<spz>&picking=1"` | **真实 splat 拾取**：`asset` 用 `/@fs/<绝对路径>.spz`（真实 SPZ v4）；判据是**负对照**——开着 `enableIds` 必须命中 `gsplat`、关掉必须选不中，两个资产实测（150k / 1.92M，默认 false） |
| `drive.mjs <baseUrl> <panes> "...&highlight=1"` | 选中线框自检：盒=实体世界盒外扩 2%、**可拾取=0**、像素变化、悬浮 0.35/选中 1、G/R/S 换模式、输入框里不抢键 |
| `node .tmp/pc-panes/drive-multi.mjs <baseUrl> <panes>` | 多选整体变换的可信复测（**9 条断言全过**）：三个成员**同位移** Δ=3.620、一次提交带三个成员、相机不动 |
| `node .tmp/pc-panes/drive-input.mjs <baseUrl> <panes>` | CDP **可信**事件复测（**35 条断言，连续三轮 35/35、退出码 0**）；≥2 窗格）：真实 `pointerId`（`setPointerCapture` 真的成功）、真实 wheel、浏览器自己生成的 click/dblclick、可信点击拾取、**可信拖动手柄**、**可信点轴球**（吸附且不选中）、**可信双击触发飞行并逐帧收敛**、**真实按键 WASD/Shift + 真实鼠标转头** |

---

## 五、真实 GPU 验证怎么做

在**可见窗口**打开带 `?gpuTimestamps=1` 的开发服务器（`trackTimestamp` 在 backend 构造时读取，事后无法开启）：

```bash
cd <repo> && ~/.bun/bin/bun run dev:web
# 浏览器打开 http://localhost:<port>/?gpuTimestamps=1
```

然后在控制台按需调用（完整步骤见 `WEBGPU_PROBE_PROTOCOL.md` §4）：

| 入口 | 用途 |
| --- | --- |
| `gpuProbe.browser.ts` → `startGpuFrameProbe(store, opts)` | GPU 时间 / 帧间隔 / CPU 提交 |
| `capture.browser.ts` → `verifyWebGPUCapture()` | 截图方向、alpha、色调映射、状态恢复 |
| `materials.browser.ts` → `verifyWebGPUMaterials()` | 合成 GLB 材质与骨骼动画 |
| `workflows.browser.tsx` → `verifyWebGPUWorkflows(slug, asset)` | 真实缩略图 / 四视角 |
| `splatLifecycle.browser.tsx` → `verifySplatLifecycle(...)` | Splat 生命周期与资源换代 |
| `syntheticSplat.browser.ts` → `runSyntheticSplatProbe(...)` | 合成点云对照 |
| `benchmark.browser.js` → `startRenderBenchmark(store, opts)` | 帧间隔基线（与历史数据对照） |

**自动化入口：`bun run probe:gpu`**（`app/scripts/gpu-probe.mjs`，零依赖：起可见窗口 Chrome + CDP + 解锁门禁 + 逐布局跑探针，退出码 0/2 表示每轮 `valid` 是否成立）。其余 `*.browser.ts` 仍是手工控制台脚本。任何"已验证"的说法都要指明是哪一种：单测 / 类型检查 / 真实浏览器 / 真实资产。**合成 fixture 只能验证链路可用，不能作为性能结论**（合成云 0.26 ms vs 真实 SPZ 20.97 ms，同样的 1.92M，差 80 倍）。

---

## 六、已知未解问题（不要假装解决）

**≥3 个全分辨率 splat 视图会塌缩。** 1 视图 19.4 ms → 2 视图 27.7 ms（健康）→ 3 视图 362.6 ms → 4 视图 382.8 ms。**根因未定位。**

已排除（**不要再提这些假设**）：点数阈值、排序缓冲绑定上限、排序器编译未完成、显存总量、multiView 缺失、SH 系数、编码密度、`maxStorageTexturesPerShaderStage`、renderer 实例数（2 视图时 4 个实例全在且健康）。合成对照在同样条件下完全线性，所以**是数据相关的，不是点数相关的**。

**未解释的缺口（待重新推导）**：历史上记过"3 视图下 GPU 362 ms 无法解释 3183 ms 的帧间隔，中间约 2.8 s 既不是 GPU 也不是 CPU 提交"。**不要在重新测之前引用它**：那个读数取自探针有两处缺陷的时期（`GpuFrameSampler` 丢了 `traverse` 的 receiver，每帧抛错；`motion` 在 `frameloop="demand"` 上不索要帧），而且长帧归因与 wall/gpu 不同窗口。修好后用**窗口配对**口径复测（2026-09-29，load 5.8–13.8，`bun run probe:gpu`）：**未复现该缺口**，而且上一轮的读法要撤回——**GPU 并没有饱和**：`gpuUtilization`（**已含 compute 池**）在 **22%–33%**（≈100% 才算 GPU-bound）。所以 4 视图塌缩**不是 GPU 算力被吃满**，限速在别处。

> ⚠️ 别再引用我 22:24 那轮"GPU-bound（207 > 118 > 115）"的结论：那三个数是**混合分母**的。
> 另外 `mainThread*` 也**不能**当作"主线程 CPU 工作"用来定限速方：Long Animation Frame 的 `duration` 本身就是**该长帧的持续时间**，与帧间隔几乎同义，所以它只会重复帧间隔。要真正拆分，需要采集 `scripts[].duration` 之和（脚本时间）——那是下一步，见 `WEBGPU_PROBE_PROTOCOL.md` §5.13。详见 `WEBGPU_FINDINGS.md` §1 第 10/11 条与 `WEBGPU_PROBE_PROTOCOL.md` §5.13。**山崖本身（1→4 视图帧率塌）仍然成立且根因未定位。**

**排查工具的方向**（`WEBGPU_FINDINGS.md` §6 提到 RenderDoc，**那在本平台不成立**）：

- Metal 上 Xcode Metal Debugger 是**唯一**可用的抓帧工具，RenderDoc 不支持 Metal。
- Xcode 路径成本很高：需要能附加调试器的 Chrome 构建（标准 Chrome 的签名会阻止附加）、`--disable-gpu-sandbox`、`MTL_CAPTURE_ENABLED=1`、`--enable-dawn-features=use_user_defined_labels_in_backend`，附加到 **GPU 进程** PID，而且**每次抓帧后浏览器必然挂死，需重启**。参考 [Profiling WebGPU with Xcode's Metal Debugger](https://toji.dev/webgpu-profiling/xcode)。
- **✅ 已核实并更正（2026-09-30）**：Three 0.186.1 **不发 `pushDebugGroup`（0 处）**，**但确实给 GPU 资源设了 `label`**（bundle 内 60 处 `.label =`，约 23 处在真实渲染描述符上：buffer 用 `BufferAttribute.name`、texture 用 `Texture.name`、pipeline 是 `` `renderPipeline_${material.name||material.type}_${material.id}` ``、bind group / command encoder / query set 也都有）。原句"也不给 GPU 资源设 `label`"作废。**抓帧要可用的话，正确做法是"给应用自己的资源起名字"，而不是"再加一个补丁打标签"**——label 只在 `--enable-dawn-features=use_user_defined_labels_in_backend` 下进后端，而 swapchain 纹理本身由浏览器持有、无法命名。
- **✅ 已修（2026-09-30）：仓库根那份陈旧的 `node_modules/three` 已重指到运行时副本。** 之前根目录的 `node_modules/three` 是一个**不同 revision** 的实体目录（09-27、无 `typeof` guard），而且它的 `WebGPUBackend.updateViewport` **带着 WebGL 那条 `height - h - y` 翻转**——照它推理会把 viewport 原点判反（实际那份在权威副本里只存在于 `WebGLBackend`）。现已 `rm -rf` 后改指 `node_modules/.bun/three@0.186.1/node_modules/three`，根目录解析与 grep 都落到权威副本。**教训：审计依赖一定要先确认 `import.meta.resolve` 落在哪一份。**
- **更便宜的第一步已经做完了**：`long-animation-frame` 归因现在有了报告入口 `formatProbeReport(result)`（`WEBGPU_PROBE_PROTOCOL.md` §4.1），并已在可见窗口实测（§5.13）。做这件事时发现探针本身有两处缺陷（见上），修好后**没有复现**那个缺口——所以现在没有理由为此上 Metal 抓帧。
- **同一分母也已经做完了**：探针改为**窗口配对**。Three 的查询池在 `_resolveQueries` 入口就快照并清空，所以一次 resolve 返回的是"自上次 resolve 以来"的**区间总和**；探针现在在发起 resolve 的同一刻对 wall 做快照，于是 `paired(ms)` 与 `gpuUtilization=` 是同分母的比较（字段与口径见 `WEBGPU_PROBE_PROTOCOL.md` §4.2）。**读报告只用 `paired` 行**——`means` 行与 `unexplained` 仍是混合分母，不要拿它们下结论。
- **✅ 已用新口径重跑**（`bun run probe:gpu`，见 §5.13/§5.14）：**`gpuUtilization` 现已含 compute 池**（旧版只算 render，系统性偏低），修正后 **22%–33%** —— **GPU 没饱和**。
- **✅ 脚本时间也已采集**（`scripts[].duration` 之和，报告里的 `scripts(ms)` 行；字段与口径见 §5.13 第四次复测）：4 视图下 `shareOfWall` **1.9%**，2 视图的长帧脚本时间为 0 —— **JS 不是限速方**。
- **⏭ 下一步（两条，缺一不可）**：
  1. **修 motion**：它只旋转透视相机，而 4 视图布局里三个正交视图完全静止；GSL 排序是脏标记驱动的，所以本轮很可能**漏掉了多视图排序路径**——本轮数字不能用来支持或反驳"≥3 视图塌缩"。
  2. **✅ 重复实验已做**（`motion 0/1` × 3 次 × 1/4 视图 = 12 轮，全部 `valid`，见 §5.13 第六次）。
     站得住的是：**帧间隔永远是 vsync 的整数倍**（12 轮只出现 2/3/6/7/8/9×，无例外）；
     **GPU 从未饱和**（`gpuUtilization` 全程 20.8–48.6%）；**JS 基本不是限速方**（`scriptShare` 中位 0–7.1%）。
     站不住的是：**"精确等于 `vsync × 视图数` 是巧合**，已作废；`scriptShare` 还有个 **43.7% 的离群点未解释**。
  3. **✅ 呈现计数已做，并否掉了一个假设**（`WEBGPU_PROBE_PROTOCOL.md` §5.14）：每帧 `renders≈4×视图数`、
     `submits≈3.5×视图数`，**而且与 motion 策略无关**（结构性）。相邻呈现间隔 **p50 0.4–0.6 ms**，
     远小于一个 vsync（16.7 ms）→ **"每个视图各等一次呈现"已证伪**；要等的时间在**帧与帧之间**。
     另一处修正：`gpuUtilization` 以前只算 render 池，现已含 compute；修正后是 **22%–33%**（结论不变）。
     > ⚠️ **`renders≈4×视图数` / `submits≈3.5×视图数` 已被 `VIEWPORT_REVIEW.md` §〇 的改动取代**。修好探针
     > （§〇.6：io 计数的分子原先含预热期）之后，4 窗格、1.92M 的稳定读数是 `renders=7.96`、
     > `presents=8.96`、`submits=22.13`（同配置两轮离散 ±0.3%）。这一段里"呈现成堆发生"的定性结论
     > 仍然成立，**但不要再引用这两个倍率**。
  4. **✅ 同步计数已做，结果出乎意料但很干净**（`WEBGPU_PROBE_PROTOCOL.md` §5.15）：
     包住 `mapAsync` / `onSubmittedWorkDone` 并记调用方指纹后发现——**100% 的 `mapAsync` 都来自探针自己的
     `WebGPUTimestampQueryPool._resolveQueries`**，应用侧一次都没有；`onSubmittedWorkDone` 0 次。
     每次回读等 211 ms（1 视图）/ 518 ms（4 视图），一趟 10 s 里合计 ≈8.7 s / 7.8 s。
     两个后果：①"每帧同步排序"没有以这种形式出现（不等于排序不花钱，但排除了这一机制）；
     ②**探针采样率上限约 5 Hz，每次 resolve 覆盖 2–9 个应用帧**——用 Three 的 `resolveTimestampsAsync`
     做不到按应用帧对齐，这是硬边界。
  5. **✅ 五轮重复已做**（§5.16，`motion=all`、每轮全新页面加载、load 6.7–20.2）：1 视图 p50 **50.0 ms（3.0× vsync）**、
     `gpuUtilization` **25.7%**；4 视图 p50 **115.1 ms（6.9× vsync）**、**25.6%**。离散极小（24–28% / 24–26%）。
     **最强的一条：帧时间涨 2.3× 而 GPU 占比不变**——每帧约 3/4 墙钟 GPU 空闲，且比例与视图数无关。
  6. **✅ 数据规模对照已做**（§5.17；经用户同意临时改名 SPZ，`finally` 还原并校验清单一致）：
     1 视图 p50 中位 **17 / 17 / 50 ms**（150k/500k/1.92M），4 视图 **50 / 67 / 115 ms**；
     `gpuUtilization` 1→4 视图：150k **34.0%→17.8%**、500k **32.5%→21.2%**、1.92M **25.7%→25.6%**。
     **多出来的视图带来的帧时间多于它带来的 GPU 工作量。**
  7. **✅ 完整视图数曲线已做**（§5.18，新增 `--views n` 构造「4 窗格 + n 个可见 splat」）：
     1.92M 世界的帧间隔 p50 中位是 **50 / 67 / 67 / 134 ms**（1/2/3/4 视图）——
     **台阶在 4 视图，2→3 是持平的**；`gpuUtilization` 全程 22.7%–27.1%；
     **`render/帧` 在 3 视图就翻倍（7.9→15.8）而帧时间没变**。
  8. **⚠️ 与历史第 6 条的差异现在更尖锐**：历史说悬崖在 **2→3**（2 视图 27.7 ms → 3 视图 362.6 ms），
     本轮构造下 3 视图与 2 视图一样快。但「3 视图」有歧义——本轮是「4 窗格 3 可见」，
     历史可能指「**3 个窗格**」（视口 1/3 画布、每帧 3 个 pass），几何完全不同，UI 构造不出来。
     **在弄清历史构造之前，既不能说第 6 条错，也不能说新曲线取代它。**
  9. **按负载分层后收敛到 5 条**（§5.13 第六次补充）：帧间隔永远是 vsync 整数倍；
     **1 视图静止 = 3× vsync**（3/3 复现，load 7–30 都成立）；**GPU 从未超过 50%**；JS 不是限速方
     （43.7% 离群点仍未解释）；**本组数据里 `load` 与帧间隔看不到相关**。
     上一版"静止比运动慢 3 倍"已作废——那是跨不同负载比较出来的。
     这**不动** §二.9/§二.10：要改纪律，得做"人为加压 × 固定条件"的对照。
- **边界**：窗口配对做到的是"GPU 与 wall 同分母"，粒度是一次 resolve 覆盖的区间（本次 1 视图平均 7.8 个 rAF 样本、4 视图 7.4 个），该区间仍可能含多个应用帧；要按应用帧对齐得在应用侧每帧打单调标记，目前没有。

**拖动时 P50 从 16.7 ms 恶化到 100–150 ms**：根因已确认——锁定的 GSL 1.1.5 在原生 WebGPU 路径上**每帧绘制前同步排序**（`synchronousSort`），`minSortIntervalMs` 在该路径无效。可调档位（`fastSort` / `minPixelRadius` / `stochastic`）都有画质代价，**未改默认值，属产品决策**。

---

## 七、改动前的检查清单

- [ ] 我引用的性能数字来自 `WEBGPU_FINDINGS.md` 第 1 节，或是本轮新测的（并写明了测量条件）。
- [ ] 我没有新增 WebGL 回退，没有动 `antialias` 默认值，没有无测量地改画质参数。
- [ ] 涉及 GPU 资源生命周期的改动考虑了 StrictMode 双挂载、设备丢失重建、异步回调写入被取代的代次。
- [ ] 新增的每帧工作问过一遍"静态场景下它还跑吗"（静止场景不应持续提交绘制/排序）。
- [ ] 我区分了"单测通过"和"真实浏览器验证过"。
- [ ] 我更新了受影响的文档，并且没有把作废结论重新写回。
- [ ] 若我动了 `app/src/shared/rendering/playcanvas/`：先读 §四之二，并复核 `PLAYCANVAS_MIGRATION.md` 里该项的验证级别。**那里大多数约束是"静默失败"型的**（不报错、只是画面不对）。

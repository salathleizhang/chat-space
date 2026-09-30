# ChatSpace 渲染层迁移到 PlayCanvas —— 核实报告与实施计划

状态：**调研与可行性验证完成；渲染层尚未开始改写**。本文只写**已核实的结论**，逐条给证据。
所有证据来自本机磁盘上的真实源码/产物，不引用未验证的二手说法。

调研日期：2026-09-30 · 环境：macOS 26.5.1 / Apple M5（10 核 GPU，Bus: **Built-In**）/ Chrome 154 / Node 24.14.1

## 〇、证据分级与可复现性

| 标记 | 含义 |
| --- | --- |
| ✅ **本机核实** | 结论来自本机磁盘上的源码/产物，给出路径与行号，可直接打开对照 |
| 🧪 **本机实测** | 我在本机真实运行得到的读数（可见窗口 Chrome / Node CLI），给出原始输出 |
| ⚠️ **未核实** | 明确标注，不作为决策依据 |

**本机资产（本机核实）**

| 仓库/包 | 位置 | 版本 |
| --- | --- | --- |
| playcanvas/engine | `.pc-research/engine`（浅克隆） | `2.23.0-beta.24`（`55ce8a4`） |
| playcanvas/supersplat | `.pc-research/supersplat` | `3.5.0`（`7d0cc68`） |
| playcanvas/editor | `.pc-research/editor` | 840 文件 / 18.1 万行 |
| npm `playcanvas` | `/tmp/pc-npm/x/package`（tarball 解包） | **`2.22.6`** ← 落地版本 |
| 冒烟测试 | `.tmp/pc-smoke/` | 见 §三 |

> `.pc-research/` 已加入 `.gitignore`（约 990MB）。三个仓库均为 MIT。

---

## 一、结论速览

**可以迁移**，核心链路已在本机跑通。但有 **三处与最初设想不同**，其中两处会改变实施方式：

| # | 最初设想 | 核实结果 |
| --- | --- | --- |
| 1 | 用 `@playcanvas/react` 替代 R3F | ❌ **不可行**（§二.1）→ 自研约 100 行薄封装 |
| 2 | `createGraphicsDevice({deviceTypes:['webgpu']})` 即得 WebGPU-only | ❌ **不成立**（§二.2）→ 必须 `new WebgpuGraphicsDevice` |
| 3 | `.spz` 资产可直接加载 | ❌ **需离线转换**（§二.3）→ v1–3 不被支持 |

**对两个已知病症的前景**

| 病症 | 前景 | 依据 |
| --- | --- | --- |
| **病 1**：拖动时 P50 16.7→100–150ms（GSL 每帧**同步**排序） | ✅ **机制上不存在，且实测运动无代价**：1.92M 资产下静止/运动 p50 = 16.7/16.7（1 窗格）、17.0–17.1/17.1–17.3（4 窗格），两轮一致（§三之五） | unified 路径在 WebGPU 上走 GPU compute radix sort，**无 CPU 排序、无同步等待**（§二.4） |
| **病 2**：≥3 个全分辨率视图塌缩（根因未定位） | 🟢 **裸栈实测未复现塌缩**：1/2/4 窗格 = 16.6 / 17.1 / **18.0 ms**，且 4 窗格合并成 **1 个 GPU render pass**（§三之二）。**但**是裸栈、单轮、非交替、负载不空 → **不能宣布已解决**，须在完整编辑器上复测 | PlayCanvas 是"每相机一份 work buffer"，成本**随视图数线性**；真正的额外杠杆是 octree LOD + `splatBudget`，属**资产管线**改动（§二.5） |

---

## 二、已核实的关键事实

### 2.1 `@playcanvas/react` 0.11.7 无法承载本项目的渲染层 ✅🧪

调研方式：装在 `/tmp/pcreact-study`（**未触碰本仓库**），从 sourcemap 的 `sourcesContent` 还原 63 个原始 TS 文件（6469 行），并用 jsdom + React 19 **真实挂载断言**。

**决定性缺陷：`camera.layers` 不能用 prop 设置。**
根因：`src/utils/validation.ts:278-285` 把数组 `{...[0,1]}` 摊成对象，导致 `:491` 的 `Array.isArray(value)` 分支成为**死代码**。实测：

```
camera fov via prop: 60                       ← 生效
camera layers via prop: 0,1,2,4,3             ← 传了 [0,1]，被静默丢弃
camera layers via imperative ref: 0,1         ← 命令式赋值才行
```

而本项目分屏的核心机制正是**逐窗格 layer 过滤 + 逐窗格 setViewport**（`app/src/widgets/Viewport/paneViewports.ts`）。同样被丢弃的还有 `camera.framePasses` / `camera.renderPasses` / `render.meshInstances` / `materialAssets`。
**更危险的是类型系统会骗你**：`CameraProps` 让 `layers` 通过 TS 检查，运行时静默无效。

其它已核实的坑：

- **无法注入 graphicsDevice**（实测 prop 被丢弃，`internalCreateGraphicsDevice` 未导出）→ 无法保证 WebGPU-only（见 2.2）。
- **卸载顺序陷阱**：`Application` 的清理用 `useLayoutEffect`（`src/Application.tsx:142`），子的 `useEffect` cleanup 在 `app.destroy()` **之后**才跑，此时 `app.root === null`。实测撞到。
- **每次 React render 无条件重写全部 props**（`use-component.tsx:43-57` 无依赖数组），实测 10 次重渲染 = 10 次 setter 调用。
- `Container.tsx:45` 依赖数组引用了**未声明的 `parent`** → 非浏览器环境 `ReferenceError`（实测 SSR 抛错）。
- **无 `app.stop()`**（2.22.6）；接管循环要自己 `cancelAnimationFrame(app.frameRequestId)`（实测有效）。
- 两年仍停在 0.x，`0.11.3`(2026-01-06) → `0.11.4`(2026-06-10) **停发 5 个月**。对照 `playcanvas` 本体每天发 beta。

**决定**：不用 `@playcanvas/react` 做渲染层，改为 **`playcanvas` 本体 + 自研薄封装**（canvas → device → app 挂载 hook、StrictMode 守卫、卸载定序、失败重试面板）。引擎侧能力全部是稳定公开 API 且**命令式可设**（`camera.layers` / `framePasses` / `render.meshInstances` / `new Application(canvas, { graphicsDevice })`）。
→ 这**降低了**迁移风险，但也意味着 R3F 那套声明式心智要整体换成命令式；这一步的工作量需计入。

### 2.2 WebGPU-only 必须自建设备 ✅🧪

`createGraphicsDevice()` **无条件**把 `WEBGL2` 与 `NULL` 追加进 `deviceTypes`，**并就地修改调用方传入的数组**：

```js
// playcanvas@2.22.6 build/playcanvas/src/platform/graphics/graphics-device-create.js:6-12
const deviceTypes = options.deviceTypes ?? [];
if (!deviceTypes.includes(DEVICETYPE_WEBGL2)) { deviceTypes.push(DEVICETYPE_WEBGL2); }
if (!deviceTypes.includes(DEVICETYPE_NULL))   { deviceTypes.push(DEVICETYPE_NULL); }
```

→ `createGraphicsDevice(canvas, { deviceTypes: ['webgpu'] })` 在 WebGPU 失败时会**静默返回 WebGL2 设备**。

**⚠️ 这同时是对"参考实现"的一处纠正**：`playcanvas/supersplat` 的 `src/main.ts:128` 注释写着 "the graphics device requests webgpu only"，但它就是这么调的，**且全仓库没有任何 `isWebGPU` 断言**（`grep` 只命中渲染分支与压缩导出处）。它只在启动失败时用 `navigator.gpu` 是否存在来决定提示文案（`src/index.ts:22`）——**那是前置能力探测，不是设备保证**。所以"SuperSplat 是 WebGPU-only"这个说法**不成立于代码层面**，不能照抄。

**正确做法（本机实测通过）**：

```js
const device = new WebgpuGraphicsDevice(canvas, {
  antialias: false, alpha: false, stencil: false,
  powerPreference: 'high-performance',
  xrCompatible: false,      // 装了 WebXR 的 Chrome 默认会设 true，可能挑到 XR 友好而非最强的适配器
});
await device.initWebGpu();  // 不传 glslang/twgsl：内置 shader 已是 WGSL，不需要转译器
```

实测输出：

```
device: { constructorName: "WebgpuGraphicsDevice", isWebGPU: true, isWebGL2: false, samples: 1 }
adapter: { vendor: "apple", architecture: "metal-3" }   features: 23（含 timestamp-query、subgroups、core-features-and-limits）
adapterSameForBothPreferences: true
```

**适配器选择的真相**：`GraphicsDevice` 源码里 `powerPreference` 默认**已经是** `'high-performance'`（`graphics-device.js:734`；`graphics-device-create.js` 的 JSDoc 却写 `'default'`，**文档与实现不一致**）。本机 `high-performance` 与默认取到**同一个适配器**（M5 只有一块 GPU，符合预期）。`requiredFeatures` 由 `_applyFeatures(adapter.features)` 推导，`requiredLimits` 是 adapter 全量拷贝——**用户无法自定义**。
→ 对"兼容外部 GPU"的含义：`createGraphicsDevice` 那条路会**同时**带来 WebGL 回退与不可控的 limits；自建 `WebgpuGraphicsDevice` 才能把设备选择收进自己手里。

### 2.3 既有 `.spz` 资产必须离线转换 ✅🧪

PlayCanvas 的 `SpzParser` **只支持 SPZ version 4**：

```js
// engine/scripts/esm/parsers/spz-parser.mjs:431-443
const version = dv.getUint32(4, true);
// legacy versions (1-3) store the gzipped header + streams, so the file starts with the gzip magic
if (...) throw new Error('Unsupported spz file: legacy gzip based version, only version 4 is supported');
if (version !== 4) throw new Error(`Unsupported spz version ${version}, only version 4 is supported`);
```

**本机实测**：项目里四份资产全部是 legacy：

| 资产 | 头部魔数 | 实际格式 |
| --- | --- | --- |
| `0-world-2-100k.spz` | `1f8b0800` | gzip → SPZ v1–3 |
| `0-world-2-150k.spz` | `1f8b0800` | 同上 |
| `0-world-2-500k.spz` | `1f8b0800` | 同上 |
| `0-world-2-full-res.spz` | `1f8b0800` | 同上 |
| （对照）engine 示例 `biker.spz` | `4e475350` | `NGSP` → v4 |

浏览器里第一次加载直接失败，错误原文：

```
error: Unsupported spz file: legacy gzip based version, only version 4 is supported
```

**可行的转换路径（本机实测）**：`@playcanvas/splat-transform` CLI（`3.8.0`，依赖 `@adobe/spz@0.2.3`，MIT）能读 legacy 并写出 v4：

```
$ splat-transform -w 0-world-2-full-res.spz out.spz
  · 1.92M gaussians · 0 SH bands
  · out.spz (29.5MB)          done in 2.559s
$ head -c 4 out.spz | xxd -p
4e475350                      ← v4 NGSP
```

**顺带否掉一个假设**：四份资产全部是 **0 SH bands**。这与我方仓库既有记录一致（`getNumSh() === 0`），也意味着 —— 我在调研中提出的"PlayCanvas 每相机 SH 颜色重烘导致塌缩"这条**在真实资产上不成立**（`hasSphericalHarmonics` 为假 → 该路径不编译）。**不要再引用这个假设。**

> 注意：这不是"格式琐事"。它说明**迁移包含一条资产管线改动**，而且这条管线同时是病 2 的解法入口（见 2.5）。

### 2.4 病 1 的机制在 PlayCanvas 侧不存在 ✅

引擎里有**两条独立的 GSplat 路径**，默认走哪条决定一切：

| 路径 | 目录 | 触发 | WebGPU 下排序 |
| --- | --- | --- | --- |
| **A. unified（默认）** | `src/scene/gsplat-unified/`（14025 行） | `GSplatComponent#unified = true` | **GPU compute radix sort** |
| B. legacy | `src/scene/gsplat/` | `unified = false` | CPU Worker 排序 |

**默认值在本机核实过，且 2.22.6 与 2.23.0-beta.24 一致**：

```
# playcanvas@2.22.6 build/playcanvas/src/framework/components/gsplat/component.js:27
_unified = true;
```
（`gsplat-unified` 目录在 2.22.6 里同样存在。）

unified 在 WebGPU 上：

- 排序走 compute（`gsplat-hybrid-renderer.js:462-565`：`intervalCompaction.dispatchCompact` → `projector.dispatch` → `gpuSorter.sortIndirect`），**全程 compute、无 CPU 读回**（该目录 `grep mapAsync|readTexture|getPixels` → 0 命中）。
- **每帧每相机都重排**（源码注释明说 "The GPU path runs every frame"）。
- GPU-only 证据：compute chunk **只有 WGSL** 没有 GLSL，且有显式断言
  `gsplat-projector.js:224` `Debug.assert(device.supportsCompute, 'GSplatProjector requires compute shader support (WebGPU)');`

对照病 1 的病根（GSL 1.1.5 在原生 WebGPU 上**每帧绘制前同步排序**）：**PlayCanvas 路径上没有"绘制前同步排序"这个环节**，也没有 `synchronousSort` / `minSortIntervalMs` 这类概念（全库 grep 0 命中）——**因此也不存在"某个旋钮在该路径无效"的问题**。

CPU 排序路径（仅 `unified=false` 或 WebGL）也是非阻塞的：Worker + **transferable** ArrayBuffer（全库 `SharedArrayBuffer` 0 命中）、**单 job 在飞**（`jobsInFlight`）、双缓冲 **latest-wins**（`pendingSorted`）、脏标记驱动（相机旋转 epsilon 0.001）。且**引擎不提供时间间隔节流**。

**不要在 multi-view 场景用 legacy**：`gsplat-instance.js:137` 硬编码 `const camera = this.cameras[0];` 并带 `TODO: extend to support multiple cameras` → N 个视图共用同一份 order，**排序是错的（不是慢）**。

### 2.5 病 2（≥3 视图塌缩）的前景：线性，不是悬崖 ✅

unified **没有单相机假设**：`GSplatDirector` 为每个 `(camera, layer)` 建独立 `GSplatManager`，各有自己的 `GSplatWorld`、**work buffer**、sorter/renderer；相机在 manager 构造时捕获，全程不变（`gsplat-manager.js:221-233`）。

**代价是显式的每视图复制**（1.92M、`GSPLATDATA_COMPACT` = 20 B/splat）：

| 量 | 增长方式 |
| --- | --- |
| work buffer 显存 ≈ 38 MB | × 视图数 |
| GPU sort：projector + radix dispatch | × **每帧** × 视图数 |
| （仅 CPU 路径）每 worker centers 拷贝 23 MB | × 视图数 |
| （仅 CPU 路径）distances + countBuffer ≈ 12 MB | × 视图数 |

→ 这是**视图数相关的线性放大**，与我方"合成对照完全线性"的观测同向。**所以不能承诺"换引擎就解决塌缩"**。

**引擎原生支持的真正杠杆是 octree LOD**：

- `lod-meta.json` + `GSplatOctree` + `GSplatOctreeInstance` + `GSplatBudgetBalancer`
- `splatBudget` 默认 **1,000,000**（`gsplat-unified/constants.js:12`），按视距选 LOD、跨视图平衡、零引用冷却卸载
- `gsplat-octree.resource.js:57-71` 明说 `numSplats` 是"全细节点数，**运行时不全驻留**"
- **源文件在 octree 层共享**（引用计数），因此每视图只加载/烘自己那一档

**而 `splat-transform` 正好能输出 `lod-meta.json`**（见 §三 CLI 的 SUPPORTED OUTPUTS）。这把"病 2"从"引擎选型问题"变成"**资产管线 + 预算配置**问题"——这是本轮最有决策价值的一条。

> 源码里**没有**任何 ">1M 会变慢"的注释或阈值；全库唯一百万量级数字就是 `splatBudget` 的默认值。**不要**把它当性能阈值引用。

### 2.6 多视口：机制不同，但能做到 1 个 GPU render pass ✅

**没有 three `ArrayCamera` 的等价物**。PlayCanvas 的做法：一个 `LayerComposition` + N 个相机（每个 layer 的 `cameras` 都含这 N 个），用 `priority` 排序。

`camera.rect` 的语义（**这是最容易踩的坑**）：

- `Vec4(x, y, w, h)`，**归一化 0..1**，**原点在左下**（GL 约定）
- 换算成像素**只有一处**：`src/scene/renderer/renderer.js:426-448`（`Math.floor(rect.x * pixelWidth)` 等）
- WebGPU 后端在写 `setViewport` 时**把 y 翻成左上**（`webgpu-graphics-device.js:1867-1891`：`y = this.renderTarget.height - y - h`）；WebGL 后端**不翻**
- scissor 同样翻转，**且额外对 RT 边界 clamp**（`:1893-1931`）

→ **迁移配方：`camera.rect = new Vec4(x, 1 - y - h, w, h)`，只填 rect，绝不自己再翻一次 y。**
→ 附带好处：`rect` 自动参与宽高比（`camera.js:696-712`，注释明说 "important for split-screen"），不用手工改 aspect。

**pass 合并（这条最反直觉，也是好消息）**：`FrameGraph.compile()` 会把**相邻、同 render target、不请求 pass 级清屏**的 pass 合并（`frame-graph.js:159-192` 置 `_skipStart/_skipEnd`）。
而分屏窗格的 `rect` 不是 `(0,0,1,1)` → `camera.fullSizeClearRect === false`（`camera.js:298-304`）→ `updateClears` **根本不设置** `colorArrayOps.clear` → **合并条件自动满足**。

调研中已用**引擎真实的 `FrameGraph.compile()`** 在 Node 里跑 stub pass 验证：

| 场景 | `_skipStart` | GPU render pass |
| --- | --- | --- |
| 4 相机，各带 pass 级 clear | `[false,false,false,false]` | 4 |
| **4 相机，无 pass 级 clear** | `[false,true,true,true]` | **1** |
| 4 相机 + 夹 shadow pass（异 RT） | 全 `false` | 不合并 |

→ **4 个窗格可以合并成 1 个 GPU render pass**，清屏以 pass 内全屏 quad 的形式裁剪到各自 viewport。
→ **但 CPU 侧不会省**：每相机的 culling、layer 排序、view UBO/bind group 仍按相机跑。这与 three 的 ArrayCamera 一样，**不要期待 CPU 数字变好**。
→ 会打断合并的来源：方向光阴影（`render-pass-forward.js:152-180`，且按相机判断）、grab pass、后处理、CameraFrame 的 before/afterPasses。**带方向光的场景必须实测**。

**清屏（🧪 本机实测，纠正了本节初稿的错误建议）**

`loadOp: clear` 与 `fullSizeClearRect` 硬绑定，源码里**没有**公开的 clear-only render pass 类。初稿据此写了"只留第一个窗格的 clear flag"——**实测这是错的，而且会让后面每个窗格整格变黑**。

实测（`.tmp/pc-smoke`，2 窗格，1.92M）：

| 配置 | 窗格 0 | 窗格 1 | GPU pass |
| --- | --- | --- | --- |
| 只第一格清屏（初稿建议） | 0.1499 | **0（纯黑）** | 1 |
| 所有相机同一机位（排除机位因素） | 0.1465 | **0（纯黑）** | 1 |
| **每格都清颜色+深度** | 0.1499 | **0.1447 ✅** | 1 |
| **每格只清深度**、颜色只第一格清 | 0.1499 | **0.1368 ✅** | 1 |

**根因（已二分定位）**：多个窗格**共享同一个深度附件**。只清第一个窗格时，其余窗格的深度区域保留未定义的残留值 → 它们的**深度测试全部失败** → 该格一个像素都不写。"纯黑"而不是清屏色，正是"从未写入"的特征。同机位测试排除了机位/视锥因素。

**迁移配方（已实测可用）**：**每个窗格的相机都必须 `clearDepthBuffer = true`**；颜色可按窗格清（推荐，让每格有确定的背景色）或只由全局清一次。相机与 layer 两级清屏 flag 要成套改、成套还原（`layer-render-step.js:61-65`；layer 级默认值也会参与，Skybox 等层自带 clear）。

**关键：每格清屏并不阻断 pass 合并。** 因为非满尺寸 rect 的清屏不会变成 `loadOp: clear`，而是 pass 内被 viewport 裁剪的全屏 quad。实测 `startRenderPass` 在 1/2/4 窗格下**恒为 1**（见 §三）。只有 rect 恰为 `(0,0,1,1)` 的满屏清屏才会产生 `loadOp: clear` 并阻断合并。

### 2.7 GPU 计时：与 three 的模型不同，且**丢失窗格粒度** ✅

**纠正一处此前的推测**：`ScopeSpace` / `ScopeId` **不是 GPU 计时作用域，是 uniform 变量作用域**（`scope-space.js:8-40`、`scope-id.js:11-55`）。不要拿它做剖析。

真正的 GPU 计时是 `GpuProfiler` + `timestamp-query`：

- `webgpu-gpu-profiler.js:14-18`：`maxCount = 1024`，`new WebgpuQuerySet(device, true, 2 * this.maxCount)`
- `webgpu-graphics-device.js:1564-1585`：每个 pass 挂 `timestampWrites`（**每 pass 两个槽**），槽位超限**告警并静默丢弃**
- `gpu-profiler.js:143-164` `_parsePassName` 去掉 `RenderPass` 前缀 → `RenderPassForward` 归成 `Forward`
- **`:189-196` 按 pass 名累加**

→ **4 个窗格的耗时会被加总成一行 `Forward`，分不出单个窗格。**
→ 迁移 `app/src/shared/rendering/gpuProbe.ts` 时，本项目的"每窗格归因"能力**会丢**，除非自己改 `_parsePassName` 或上外部抓帧。这条必须写进计划，不能当成"探针平移一下就行"。
→ `:175-179` 还警告 per-pass 时间戳在流水线 GPU 上会重叠、求和会高估（引擎自己用"首个 begin 到末个 end 的跨度"作为 `frameTime`）。

另外 **`renderPassIndex` 计的是 CPU 侧 FramePass 数**（合并后仍是 4），不是 GPU pass 数。要看真实 GPU pass 数，用 `TRACEID_RENDER_PASS` 下被合并 pass 的 `++` 前缀（`render-pass.js:421-425`）。

### 2.8 资源生命周期的保护边界 ✅

引擎有五重保护：引用计数延迟释放（`GSplatResourceCleanup`）、零引用冷却（`cooldownTicks` 默认 100 帧）、跨 world 共享资源不强卸、`pendingReleases` 延到状态换代后才 decRef、设备丢失/恢复等待（`gsplat-sog-data.js:513-558`）。

**但"等 GPU 编译完成再释放"没有** —— `_actualDestroy()` 只看 `refCount === 0`，无 compile/pipeline-ready 判定（`grep` 0 命中）。
→ 本仓库 `patches/` 下两个补丁改的正是**释放路径**（`AGENTS.md` §二.14）。迁移后这两条约束的等价物**不存在于引擎里**，需要自己在应用侧补（或至少验证不需要）。

### 2.9 已核实的旋钮对照（不要顺手改默认值）

GSL 的名字在 PlayCanvas 里**不存在**（`fastSort` / `superXY` / `minPixelRadius` / `synchronousSort` 全库 0 命中）。对照：

| GSL | PlayCanvas | 默认值 |
| --- | --- | --- |
| `minPixelRadius` | `scene.gsplat.minPixelSize` | `2.0` |
| `sortRadial` | `scene.gsplat.radialSorting` | `false` |
| `stochastic` | `scene.gsplat.stochastic` | `false`（**仅 WebGPU GPU-sort 路径**） |
| `minSortIntervalMs` | **无对应物** | — |
| （新增）| `splatBudget` | `1000000` |
| （新增）| `alphaClipForward` | `1/255` |
| （新增）| `colorUpdateAngle` | `10`（SH 重烘角度阈值） |

按 `AGENTS.md` §二.3，`alphaClipForward` / `minPixelSize` **有画质代价，属产品决策**，迁移时不要顺手改。

---

## 三、里程碑一：真实资产已在 PlayCanvas + WebGPU 上跑通 🧪

**产物**：`.tmp/pc-smoke/`（已 gitignore），自包含、可重跑。

组成：单文件 `index.html` + vendor 到本地的 `playcanvas.mjs`(3.6M) 与 `spz-parser.mjs`(19K) + `zstd.wasm.js`/`zstd.wasm.wasm` + 转换后的 28M 资产；`run.mjs` 是零依赖驱动（静态服务 + 可见窗口 Chrome + CDP 取回 `window.__SMOKE__` + 截图）。

驱动里刻意**不复用** `app/scripts/gpu-probe.mjs`——那个探针要求页面存在本应用的 store 与 gpuProbe，而这里验证的是**裸 PlayCanvas 栈**，耦合会互相污染结论。

**✅ 全项通过（`result.json`，`ok=true`，原始读数）**

```
device   : WebgpuGraphicsDevice  isWebGPU=true  isWebGL2=false  samples=1
adapter  : apple / metal-3   features=23（含 timestamp-query、subgroups）
asset    : GSplatSpzResource   numSplats = 1,920,000   加载 416 ms
包围盒    : center=[4.643,-5.417,3.5]  radius=19.586
帧间隔    : p50 16.7 ms（min 15.4 / max 17.8，300 帧）= 1.0× vsync
画布校验  : 亮度均值 22.17、非背景像素占比 7.46%  → renderedSomething = true
```

截图目视确认：真实世界资产的 splat 正常着色渲染（机位偏低，看到的是世界侧缘）。

**这证明了什么**：`new WebgpuGraphicsDevice` + `initWebGpu()` 是本机可用的 WebGPU-only 路径；SPZ v4 经 zstd 解码后 1.92M splat 能在 416 ms 内加载并渲染；`antialias:false` 下 `samples=1`。

**⚠️ 这不能证明什么**（按 `AGENTS.md` §二.9/§二.10/§二.11 的口径）：

- 测时 `load average` **4.36 → 6.50，机器不空**，绝对值不可与文档里的静机基线并列。
- 这是**裸 PlayCanvas 栈**（无 overlay/HUD/探针、相机静止、无每帧工作），不是完整编辑器。
- 只有**单轮**、且不是交替设计 —— 而 §二.11 明确"帧间隔的单对 A/B 分辨不了 1 个 vsync"。

**因此只记一个有方向的信号，不下结论**：本机三栈基线里，静机 1 视图 1.92M 是 **p50 50.0 ms（3.0× vsync）**（`WEBGPU_FINDINGS.md` §1 第 11 条），本轮裸栈是 **1.0× vsync**。方向值得追，但要定论必须做**交替设计 + 多轮重复 + 同负载**，且必须在**完整编辑器**上做。

---

## 三之二、里程碑二：多窗格对照 —— 对病 2 的直接答案 🧪

同一份 1.92M 资产，每格都清颜色+深度（§2.6 的配方），串行四轮（`node run.mjs --panes N --q allclear=1`）：

| 窗格数 | **GPU render pass** | drawCalls | 帧间隔 p50 | 逐格像素校验 |
| --- | --- | --- | --- | --- |
| 1 | **1** | 1 | 16.6 ms | 1/1 通过 |
| 2 | **1** | 4 | 17.1 ms | 2/2 通过 |
| **4** | **1** | 8 | **18.0 ms** | **4/4 通过** |

**结构性结论（最扎实的一条）**：`startRenderPass` 在 1/2/4 窗格下**恒为 1**，即 **4 个窗格被合并成 1 个 GPU render pass**。这不是推测——是直接包住 `device.startRenderPass` 数出来的（比 `TRACEID` 更直接，不需要 debug 构建）。

**对病 2 的含义**：本仓库记录的塌缩是 1 窗格 50.0 ms → 4 窗格 115.1–133.8 ms（6.9–8× vsync），**根因始终未定位**。PlayCanvas 侧本轮是 **16.6 → 17.1 → 18.0 ms（1.0× → 1.0× → 1.08× vsync）**，**没有出现塌缩**。

**⚠️ 诚实的边界**（这些限制决定了上面这行不能当结论用）：

- 测时 `load average` **6.6–10.4，机器不空**；按 §二.9/§二.10，绝对值不可与静机基线并列。
- 这是**裸栈**：无 overlay / HUD / gizmo / 缩略图 / 截图队列，**相机静止、无每帧工作**。而本仓库的基线是 `motion=all` 的完整编辑器。
- 只有**单轮**、**非交替设计**；§二.11 明确"帧间隔的单对 A/B 分辨不了 1 个 vsync"。
- 只有 rAF 间隔，**没有 GPU 时间戳**（裸栈没接 `GpuProfiler`）；因此无法回答"多出来的时间在不在 GPU 上"。
- 单一资产、无 SH、四个窗格看同一个世界。

**结论的强度**：足以支持**继续迁移**并把它列为"病 2 的头号候选解法"，**不足以**宣布病 2 已解决。要定论必须上完整编辑器 + 交替设计 + 多轮 + GPU 时间戳。

**踩到并修掉的两个驱动缺陷**（记下来免得重犯）：

1. **Chrome 在本沙箱必须加 `--no-sandbox --disable-gpu-sandbox`**，否则它自己的沙箱初始化失败（`Failed to initialize sandbox: Operation not permitted`）→ **渲染进程直接崩溃**，CDP 侧只看到连接断开。仓库的 `app/scripts/gpu-probe.mjs:456-464` 已记录过这一条。
2. **CDP 客户端在 WebSocket 关闭时必须 reject 挂起的请求**，否则 Chrome 一崩，轮询永久挂起（实际发生过，整轮卡死）。

**尚未取到的读数**：帧间隔与"是否真的画出东西"的像素校验 —— 见 §五待办第 1 条。

---

## 三之三、Phase 2 的真实浏览器验证 🧪

dev 探针 `app/pc-panes.html`（Vite dev server）+ `.tmp/pc-panes/drive.mjs`（可见窗口 Chrome + CDP），
用的是**应用自己的模块**（`createWebGPUDevice` → `createPlayCanvasApp` → `createEnginePaneBindings` → `PaneRegistry`），
不是裸栈。场景是四个不同高度的盒子 + 平行光；每个窗格一个不同方位角。

| 窗格数 | `startRenderPass` | drawCalls | p50 | 逐格非背景占比 |
| --- | --- | --- | --- | --- |
| 1 | **240 / 240 帧** | 4 | 16.7 ms | 0.0363 |
| 2 | **240 / 240 帧** | 10 | 16.7 ms | 0.0648 / 0.0795 |
| 4 | **240 / 240 帧** | 20 | 16.7 ms | 0.0242 / 0.0323 / 0.0397 / 0.0474 |

**三条结论**：

1. **`startRenderPass` 恰好等于帧数 → 每帧 1 个 GPU render pass，与窗格数无关。** pass 合并生效，§2.6 的预测在应用自己的模块上复现。
2. **每一格都画出了东西**（逐格像素校验全过，截图目视确认 2×2 四格朝向正确、`rect` 的 y 翻转没写反）。
3. 帧间隔 **1× vsync 且不随窗格数变化**——但测时 `load average` **18.6–25.4，机器很忙**，按 §二.9/§二.10 这只是方向性信号，不是结论。

**这次验证修正了什么**：它抓出了 `AppOptions.componentSystems` 默认空数组那个静默失败（见 Phase 2 一节）——只跑单测和类型检查是发现不了的。

## 三之四、Phase 4 的真实资产验证（1.92M splat × 1/2/4 窗格）🧪

同一套应用自己的模块（`createWebGPUDevice` → `createPlayCanvasApp` → `registerSplatParsers` → `PaneRegistry`），
资产是**真实的 `0-world-2-full-res.spz`**（经 `@playcanvas/splat-transform` 转成 v4 后由带 CORS 的静态服务提供）。

| 窗格 | splats | 加载 | `startRenderPass` | drawCalls | p50 | max | 逐格非背景 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1,920,000 | 415 ms | 241 | 1 | **16.8 ms** | 18.3 | 0.0742 |
| 2 | 1,920,000 | 452 ms | 242 | 4 | **17.2 ms** | 49.2 | 0.15 / 0.145 |
| 4 | 1,920,000 | 471 ms | 244 | 8 | **17.6 ms** | 71.2 | 0.0866 / 0.0752 / 0.074 / 0.0681 |

（150k 那份同样跑过：加载 61–137 ms、`startRenderPass` ≈ 1/帧、逐格全过。）

**三条结论**：

1. **1.92M 的 splat 在 4 个窗格下没有塌缩**：16.8 → 17.2 → 17.6 ms（1.0× → 1.05× vsync）。对照本仓库 three/GSL 的记录值（1 窗格 50.0 ms = 3× vsync，4 窗格 115–134 ms = 6.9–8× vsync），方向差异很大。
2. **`startRenderPass` 仍约等于每帧 1 次**（241/242/244 对 240 帧）→ splat 在场时 pass 合并依然生效。
3. **每一格都画出了东西**，截图目视确认四格从不同方位角渲染同一个世界。
4. **SPZ v4 + ZSTD + engine GSplat 的接线可用**：加载 415–471 ms（29 MB 源文件）。

**⚠️ 必须声明的边界**（决定了上面第 1 条不能当结论用）：

- 测时 `load average` **50.25 → 28.09**，机器极忙。按 §二.9/§二.10，**绝对值不可与静机基线并列**。
- 相机**静止**、无拖动排序、无 overlay/HUD/gizmo/拾取/截图队列。本仓库的基线是 `motion=all` 的完整编辑器。
- **单轮、非交替设计**；§二.11 明确单对样本分辨不了 1 个 vsync。
- 只有 rAF 间隔，**没有 GPU 时间戳**——无法回答"多出来的时间在不在 GPU 上"。

**因此**：足以支持"PlayCanvas 路径下 1.92M × 4 窗格可用"这个方向，**不足以宣布病 1/病 2 已解决**。定论需要在**完整编辑器**上做交替设计 + 多轮 + GPU 时间戳。

## 三之五、病 1（拖动排序）的对照实测 🧪

**背景**：本仓库记录的病 1 是"拖动时 P50 从 16.7 ms 恶化到 100–150 ms"，根因已确认——
GSL 1.1.5 在原生 WebGPU 路径上**每帧绘制前同步排序**（`synchronousSort`），且 `minSortIntervalMs` 在该路径无效。

**对照条件**：同一份 1.92M 资产，`?motion=1` 让每个窗格的相机持续环绕（机位在引擎的 `update` 事件里推进，
保证发生在 `render` 之前）。静止与运动各跑两轮，**交错**执行以减小漂移。

| 轮 | 窗格 | 静止 p50 | **运动 p50** | 运动 max | `startRenderPass` |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 16.7 ms | **16.7 ms** | 18.5 | 241 |
| 2 | 1 | 16.7 ms | **16.7 ms** | 18.7 | 241 |
| 1 | 4 | 17.0 ms | **17.3 ms** | 36.7 | 244 |
| 2 | 4 | 17.1 ms | **17.1 ms** | 31.6 | 244 |

**结论：相机运动测不出代价**——静止与运动的差 ≤0.3 ms，落在轮间离散之内，两轮方向一致。
这与架构预测吻合：`unified` 路径在 WebGPU 上把 projector + radix sort 全放在 GPU、每帧执行、
**没有 CPU 回读也没有同步等待**（§二.4）。也就是说机位变化只增加 GPU 工作量，不阻塞主线程，
帧节奏稳定在 1× vsync。

**两组条件的可比性**：本探针在两种条件下都**连续渲染**（没有 `frameloop="demand"` 语义），
所以"静止 16.7"的含义是"连续渲染但机位不动"——这正是隔离"机位运动代价"所需的对照。
另外 GPU sort 在两种条件下都每帧执行，所以静止那组并不"免费"。

**⚠️ 边界**：load 5.87–6.48（非静机）；裸探针（无 overlay/HUD/gizmo/拾取/缩略图，无真实编辑交互）；
只有 rAF 间隔、**没有 GPU 时间戳**。所以：**足以支持"病 1 的机制在 PlayCanvas 路径上不存在"**，
但要在**完整编辑器**上做交替设计 + 多轮 + GPU 时间戳才能钉死。

## 三之六、Phase 2 余项（窗格指针输入）的真实浏览器验证 🧪

新增 `playcanvas/paneInput.ts`（无引擎依赖，**37 条单测**）：把 DOM 指针事件**路由到某一个窗格**的
相机台架。引擎自带的 `orbitCamera` 脚本是**全局输入**（挂在 `app.mouse` 上、对整张画布生效），
多窗格下每格要各自输入，所以那套脚本不能用。映射与 three 侧 `OrbitControls` 的**按键**一致：
左键轨道、**中键**缩放、右键平移、滚轮乘性缩放、双击聚焦。

验证分两级，**都在真实浏览器里**（dev server `127.0.0.1:5199`，可见窗口 Chrome 154，load 6–10）：

### 第一级：页面内合成事件（`drive.mjs <url> <panes> input=1`）

走真实 DOM 事件路径（命中测试 → 手势路由 → 台架 → `applyRig` → 引擎实体 → 渲染），
但事件由 `dispatchEvent` 合成（`isTrusted === false`，且 `setPointerCapture` 对不存在的 pointerId 会抛错）。

| 步骤 | 读数（2 窗格） | 断言 |
| --- | --- | --- |
| 左键拖动 80×20 px | 方位角 0 → **−0.9212**，距离 11.0708 不变 | 轨道旋转、不改变距离 |
| 拖动中在**画布外**抬手 | `handle.active() === null` | 手势收掉了（不粘住） |
| 滚轮 −100 px | 距离 11.0708 → **8.8566**（×0.8000） | 乘性缩放；`defaultPrevented === true` |
| 右键拖动 30×20 px | 目标点动、距离仍 8.8566 | 平移只动目标点 |
| 双击（两次点击，1 px 内） | 目标点 → **[0, 0.8, 0]**（包围球心），距离 → **11.6913** = `fitDistance(5, 60)` | 聚焦正确 |
| 全程 | 窗格 0 的画面像素签名**变了**；窗格 1 的 rig 与实体位置**一动没动** | 输入真的驱动了渲染、且多窗格互不串味 |

`startRenderPass` 仍是 **240/240 帧**（每帧 1 个 GPU pass）——加输入监听不影响 pass 合并。

### 第二级：CDP **可信**事件（`.tmp/pc-panes/drive-input.mjs`）

用 `Input.dispatchMouseEvent` 派发浏览器**真实生成**的指针事件：真实 `pointerId`
（`setPointerCapture` 真的成功）、真实 wheel、浏览器自己生成的 click/dblclick。
读数从 `window.__PC_INPUT__`（`inputHoldMs` 模式）取。**2 窗格与 4 窗格各跑过**（这一级需要至少 2 格，
因为它要断言"拖过另一格上方不改弦更张"），4 窗格下 **15 条断言全过**、退出码 0：

| 断言 | 4 窗格读数 |
| --- | --- |
| pointerdown 命中的窗格 | `pane-0`（`active()` 给出 `{paneId:"pane-0", pointerId:1, kind:"orbit"}`） |
| 左键拖动（**跨过窗格边界拖进 pane-1 再松手**） | pane-0 方位角 Δ=−13.0058 rad；`cam0` 由 `[-6.6964,2.05,8.7269]` → `[-8.4613,6.444,4.3719]` |
| 其余 3 格 | rig 与 camera **都比对未变**（手势绑定在**按下的那一格**，不随指针位置改弦更张） |
| 真实 pointerup 之后 | `active() === null` |
| 滚轮 −100 | 距离 11.0708 → 8.8566（比值 **0.8000**） |
| 右键拖动 40×24 | \|Δtarget\| = **1.3344**（= `hypot(40,24) × 2·8.8566·tan30° / 357.5`，与"1 px ↔ 目标平面上的世界单位"1:1 换算一致） |
| 双击（真实两次点击，`clickCount` 1→2） | 目标点回到 `[0, 0.8, 0]`、距离 11.6913 = `fitDistance(5, 60)` |

### 这一轮修掉的**一个错误判断**（值得记下来）

初版 `paneInput.ts` 的注释写的是"取消 `pointerdown` 会让浏览器不再派发
`mousedown`/`mouseup`/`click`/`dblclick`，所以原生 `dblclick` **永远不触发**，双击必须自算"。
**前半句是错的。** 实测（真实事件路径，画布上挂计数器）：

```
compatEvents = { "click": 3, "dblclick": 1 }        ← mousedown 一次都没有（被抑制）
```

即：取消 `pointerdown` 在 Chrome 上**只抑制 `mousedown`（以及部分 `mouseup`）**，
`click` / `dblclick` 照旧派发。所以：

- **双击自算**这个设计保留——但它现在的理由是"不依赖兼容事件"（那是浏览器实现细节，
  而我们正在扰动它；自算还顺带覆盖触摸双击、并能明确忽略"拖动之后紧跟的点击"），
  不再是"原生 dblclick 不可用"。
- **新推论（写给 §五.2 的拾取）**：画布上的 `mousedown`/`mouseup` 实测被抑制，
  所以**拾取必须走指针事件**，不能挂鼠标事件。

### 与 three 侧一处**有意**的比例差异（不是 bug）

three 把 `OrbitControls` 挂在整张画布上，所以它的 `rotateLeft(2π·dx/element.clientHeight)` 与
`panLeft(dx·worldHeight/element.clientHeight)` 用的都是**画布高**。4 窗格布局下每格只有画布一半高，
于是旋转、平移、中键缩放全都只有**一半**的响应：平移时模型不跟手（光标走 40 px，世界只挪一半）。
本实现按**窗格高**算：每格"拖满自己的高度 = 一整圈"，平移在世界平面上与光标 1:1，
且与几宫格布局无关。上表 4 窗格那行 `|Δtarget|` 的读数就是这条换算的实测证据。

**⚠️ 边界**：合成事件那一级不是可信事件（所以才有第二级）；CDP 那一级只覆盖 Chrome 154 / macOS。
**没做的**：阻尼/惯性、双击聚焦的缓动飞行（都要每帧推进，属渲染循环）、捏合缩放、
按被点中的部件聚焦（要拾取）。这些都不影响"每格各自输入"这一条。

## 三之七、Phase 2/3 余项（拾取与变换 gizmo）的真实浏览器验证 🧪

新增两个模块：`playcanvas/panePicking.ts`（无引擎依赖的换算 + `Picker` 绑定，**15 条测试**）与
`playcanvas/paneGizmo.ts`（逐窗格 gizmo 宿主，**9 条测试**）。§五.2 要求"先评估自带 gizmo 能否直接用"，
下面把评估结论与实测读数列在一起。

### 评估结论：两样都用**引擎自带的**，不重复造

| 要的能力 | 采用 | 依据（本机源码） |
| --- | --- | --- |
| 屏幕点 → 物体 | `pc.Picker` | 它已经把 ID pass + 深度 pass 做完（`framework/graphics/picker.js`），WebGPU 路径**自己就用** `texture.read(…, { immediate: true, renderTarget })`（`picker.js` 的 `_readTexture`）；`RenderPass.render()` 自己 `startRenderPass`/`endRenderPass`，所以可以在帧外按需 `prepare()` |
| 多窗格拾取 | 同一个 `Picker`，每次按窗格 `prepare(camera, scene, layers)` | `prepare` 是**按相机**的，里面走 `renderForwardLayer` → `setupViewport`（`forward-renderer.js:511`、`renderer.js:187`），那一格的画面落在与真实帧**同一段归一化区域**，其余是白色（`prepare` 把清屏色设成 `Color.WHITE`，`decodePixels` 把全 1 当"没命中"） |
| 平移/旋转/缩放手柄 | `TranslateGizmo` / `RotateGizmo` / `ScaleGizmo` | 构造签名是 `(cameraComponent, layer)`，会把层加进**那一台**相机（`gizmo.js:60`）；手柄射线走 `camera.screenToWorld()`，它按相机 `rect` 换算（`camera.js:538-541` 的 `(x - rx*cw)/(rw*cw)`）→ **指针在别格时 NDC 落在 [0,1] 之外，本格 gizmo 自然不响应**。所以"逐窗格各建一个"就够，不需要自己接输入 |
| 拖动开始/结束信号 | 引擎自己的 `transform:start` / `transform:end` | `transform-gizmo.js:65-110`；`dragging()` 就是这个信号，喂给输入层的 `isPointerClaimed` |
| splat 拾取 | 同上（需 `scene.gsplat.enableIds = true`） | `gsplat-params.js:142` 默认 **false**；不开时 `RenderPassPicker` 不会把 gsplat 放进 mapping |

**不照抄 SuperSplat 的 `src/picker.ts`**：那份是**专门给 splat 编辑**写的（`prepareId(splat, 'add'|'remove'|'set'|'intersect')` + `projectedSplatRenderer.preparePick`），通用选择用不上。值得借的只有一条**坐标约定**：它读 ID 缓冲用的是**画布归一化坐标 × 缓冲尺寸**（`picker.ts` 的 `readIds`：`Math.floor(x * rt.width)`，注释还写明"buffer 的第 0 行是请求矩形的第一行"）。本实现的 `toPickPixel()` 就是这条。

### 实测（可见窗口 Chrome 154，`127.0.0.1:5199`，load 2.5–4.4）

**第一级·页面内合成事件**（`drive.mjs <url> <n> "input=1&picking=1&gizmo=1"`，1/2/4 窗格各一轮，全部 `ok=true`）：

| 读数 | 1 窗格 | 2 窗格 | 4 窗格 |
| --- | --- | --- | --- |
| `startRenderPass` / 帧数（**gizmo 挂着的状态下**） | 240/240 | 240/240 | 240/240 |
| `picking.buffer` | 1400×757 | 1400×757 | 1400×757 |
| 投影点拾取命中 | `pick-target` | `pick-target` ×2 | `pick-target` ×4 |
| 空白角阴性对照 | `null` | `null` ×2 | `null` ×4 |
| `picking.rigUnchanged`（拾取是只读的） | true | true | true |
| `gizmo.layerInCamera` | true | true | true |
| 挂上/摘掉手柄：**本格**像素签名变了 | true | true | true |
| 挂上/摘掉手柄：**其它格**像素签名未变 | —（只有一格） | true | true |

**"gizmo 挂上后仍是每帧 1 个 GPU pass"这条要单独说**：gizmo 层是 `Gizmo.createLayer` 建的，带
`clearDepthBuffer: true`；实测它**没有**把 pass 拆开（240/240），与"每格清屏不阻断 pass 合并"一致。
凡是要验收"每帧 1 pass"的改动，都得在这种"层更多了"的状态下再量一遍，不能只量裸场景。

**第二级·CDP 可信事件**（`.tmp/pc-panes/drive-input.mjs`，4 窗格，**24 条断言全过、退出码 0**），
新增与拾取/gizmo 有关的读数：

| 断言 | 读数 |
| --- | --- |
| 可信点击 → 拾取（`onClick` → `Picker`） | `{"paneId":"pane-0","name":"pick-target","kind":"mesh"}` |
| 拾取是只读的 | 拾取前后 `azimuth` 都是 −12.9387 |
| 空白处点击 | `name: null` |
| 在 X 手柄上找到命中点（用**引擎自己的 hover 判定**） | `fraction=0.2 hover=head:x`（`node.name` 的 `:x` 就是 `TransformGizmo._getAxis` 的规则） |
| 按在手柄上：相机手势**没开始**、gizmo 报告正在拖 | `{"dragging":true,"starts":1,"ends":0}` 且 `active()===null` |
| 拖手柄期间相机台架没动 | `azimuth −12.9387 → −12.9387` |
| 物体沿 +X 移动（Y/Z 基本不动） | `Δ=(1.969, 0.000, 0.000)` |
| start/end 事件成对且已收尾 | `{"dragging":false,"starts":1,"ends":1}` |

### 这一轮实测修正的两处判断

1. **点击手柄不会变成"选择"**——第一版把驱动器的点击点放在靶子盒子的投影中心，结果拾取到的是
   隔壁 `box` 而不是 `pick-target`。原因不是拾取错了：**手柄会认领那次 pointerdown**
   （引擎的 `transform:start`），被认领的点击在输入层里连手势都不开始，自然没有 `onClick`。
   这与 three 侧 `pickSuppressedRef`（gizmo mouseDown 置位、mouseUp 延后释放，期间不选中/不聚焦）
   是同一个产品行为。驱动器现在把点击点往 −X 偏 0.45（盒半宽 0.6）**避开手柄**。
2. **双击聚焦的口径与 three 侧不同**（这是行为差异，不是 bug，但必须显式选一个）：
   three 侧的聚焦是"**摆放位置 + 固定偏移 `FOCUS_CAMERA_OFFSET = [3,2,3]`**"（`widgets/Viewport/index.tsx:113-114,453-469`），
   **不是**包围球；而迁移层原先只有"包围球 + fov"一种口径。现在 `focusRigWithTarget()` **两种都支持**：
   `{center, radius}` 走 `fitDistance`，`{center, offset}` 走"距离 = |offset|、方位角/极角由偏移方向给出"。
   正交窗格两种口径都只挪目标点（three 侧的双击飞行只挂透视窗格，`PaneCamera.tsx:630`）。

### 仍然没做的（属集成层，不是本模块）

- **多选整体变换**：three 侧挂的是不参与渲染的 **pivot**（单选=摆放；多选=各成员位置的包围盒中心 + 单位姿态），
  按下瞬间冻结 `pivot⁻¹·member`，拖动时用 `pivot.matrix·relative` 还原（`TransformGizmo.tsx:128-207`）。
  现在是把 gizmo 直接挂在**一个实体**上（单选口径）。多选那套纯数学要照搬，别重新发明。
- **拖动的实时表与提交**：three 侧拖动中只写 `LiveTransforms`（每帧）、松手才 `onCommit(updates, mode)` 进撤销栈
  （`useSceneHistory.ts` 契约不变）；以及"拖动中忽略撤销"、"一步一条"这些。
- **选中/悬浮的视觉**：线框包围盒（`ModelMesh.tsx` 的 `localBounds` + `Box3Helper`，`depthTest=false`）、
  按窗格记的悬浮、`cursor: pointer`。
- **UI 与快捷键**：`G`/`R`/`S` 切模式、world/local 开关（缩放模式强制 local）、右下角面板。
- **splat 拾取的真机读数**：源码已核实需要 `scene.gsplat.enableIds = true`，本轮**没有**在真实 splat 上跑
  （盒子场景的读数不能替代它）。

## 四、实施计划

### Phase 0 —— 冻结接缝 ✅ **已完成**

编辑层与渲染层的界线**已经存在**，是 `ViewportProps`（`app/src/widgets/Viewport/index.tsx:63-106`）：进 10 个 prop，出 `onTransformCommit` / `onSelectAsset` / `onClearSelection` / `onFocusAsset` / `onImportModel`。

**做法：不靠约定，靠一个会失败的测试。** 新增 `app/src/pages/editingLayerBoundary.test.ts`，对一个真实的模块依赖图跑三条规则：

| 规则 | 判据 |
| --- | --- |
| **A** | 冻结集（`pages/` / `widgets/Inspector` / `AgentDock` / `Sidebar` / `SettingsDialog` / `shared/storage`）里任何文件**不得直接 import 渲染库** |
| **B** | 冻结集里**除 `pages/*.tsx` 组合根以外**的文件，不得**传递地**依赖渲染库 |
| **C** | 两层的**数据契约模块**（`liveTransforms` / `scenePlacement` / `transformMode` / `libraryApi` / `materialSchema`）必须保持纯数据 |

规则 B 区分"逻辑"与"UI 组合"是有实测依据的：`pages/AppDashboard/index.tsx` 渲染 `<Viewport>` / `<ModelList>` / `<ModelPreviewWindow>` 是正常架构；而 `Inspector` 的 `.tsx` **不豁免**——它是纯编辑面板，没有理由伸手进渲染层的场景图。

两张白名单（`SEAMS` 跨集目标、`FROZEN_IMPORTERS` 集内直接导入）都带**失效检查**：某条不再被触达时测试会失败，要求删除，避免豁免腐烂。守卫本身也做过反向验证——注入一处 `import * as THREE` 后规则 A 立刻失败，还原后恢复 4 pass。

**审计找出的 5 处真实耦合**（比最初估计的多）：

| # | 耦合 | 处理 |
| --- | --- | --- |
| 1 | **`pages/AppDashboard/useSceneHistory.ts`（撤销栈）** 从 `shared/lib/materialOverrides.ts` 取纯常量 `DEFAULT_MATERIAL`，**却因此把 three 拉进了撤销栈** | ✅ **已修**：拆出纯模块 `shared/lib/materialSchema.ts`（`SLOT_LABELS` / `DEFAULT_MATERIAL` / `isDefaultMaterial` / `normalizeMaterial`），导入方改指它 |
| 2 | `widgets/Inspector/index.tsx` 同样只为 `DEFAULT_MATERIAL` / `normalizeMaterial` 而拉进 three | ✅ **已修**：同上 |
| 3 | **`TransformMode` 住在 `TransformGizmo.tsx`（three 实现）里**，而 `AppDashboard` 与 `useSceneHistory` 都要用它 | ✅ **已修**：抽成纯模块 `widgets/Viewport/transformMode.ts`；`TransformGizmo.tsx` 保留再导出以便迁移期不中断 |
| 4 | **`Inspector/TextureChannels.tsx` 直接渲染 `Viewport/ModelMesh` 的 `LoadedAssetObject`**，用 render-prop 拿 `Object3D` 遍历材质通道；并直接用 `Object3D`/`Material` 类型 | ✅ **已消除**：改成消费渲染层发布的"模型描述"（`shared/lib/modelDescription.ts`），生产方是 `widgets/Viewport/publishModelDescription.tsx`，已在真实编辑器页面端到端验证 |
| 5 | `useAgentChat.ts` 从 `ModelPreviewWindow` 取 `InspectionRequest` **类型** | ✅ **已消除**：类型挪进纯模块 `shared/lib/inspection.ts` |

第 4 条是**真正的边界破口**，也是这次审计最有价值的产出：Inspector 今天靠"自己挂载视口那份 loader 组件、再遍历 three 对象"来回答"这个模型支持哪些贴图通道、每通道是什么图"。迁移后 three 对象不存在，这条路径必然断——**它必须在 Phase 3 变成跨层的数据契约，而不是一个可以照搬的接口**。

**验收（已通过）**：`bun run check` 全绿；边界测试 4 pass；`pages/` 下的编辑逻辑与三个纯契约模块均无渲染库依赖。

> 注：`AGENTS.md` 记的基线是 app 382 pass；实际基线是 **383**（多的一条来自本仓库此前未提交的改动）。Phase 0 后为 **387**（新增 4 条边界测试）。

### Phase 1 —— 设备与循环（WebGPU-only by construction）✅ **引导层已完成并单测通过**

新增 `app/src/shared/rendering/playcanvas/`：

| 文件 | 职责 |
| --- | --- |
| `device.ts` | **保证是 WebGPU** 的设备创建。`new WebgpuGraphicsDevice` + `await initWebGpu()`（不传 glslang/twgsl → 跳过转译器），显式 `antialias:false` / `alpha:false` / `stencil:false` / `powerPreference:'high-performance'` / `xrCompatible:false`，并用 **`isWebGPU === true && isWebGL2 === false` 硬断言**拒绝任何非 WebGPU 后端 |
| `app.ts` | 把设备接到 `AppBase`：`AppOptions` + `Mouse`/`TouchDevice` + `FILLMODE_FILL_WINDOW`/`RESOLUTION_AUTO`。`stopLoop()` 用 `cancelAnimationFrame(app.frameRequestId)`（**2.22.6 没有 `app.stop()`**） |
| `session.ts` | 租约与生命周期状态机（纯对象，无 React）：StrictMode 的"卸载→立刻重挂"、晚到的初始化、重试、**恰好一次清理** |
| `useRendererSession.ts` | React 薄适配（`useLayoutEffect` + `useSyncExternalStore`），替代 `@playcanvas/react` |

**三条本机核实的失败分支都被转成可展示的信息**（引擎自己给的不清楚）：`!navigator.gpu` 会抛错、**adapter 为 null 时引擎会在 `gpuAdapter.features` 上 TypeError**、Imagination PowerVR（`info.vendor === 'img-tec'`）**返回 null 而不抛**。

**为什么不用 `@playcanvas/react`**（§二.1）在这里落地成了具体做法，并写成使用约定：**需要摘除 3D 资源的子组件请用 `useLayoutEffect` 做清理**——React 卸载时子组件的 layout 清理先于父组件，那时引擎还活着；passive 清理排在所有 layout 清理之后，`app` 已被销毁（这正是该库会让调用方踩到的那个坑）。

**测试**：18 条（`device.test.ts` 7 + `session.test.ts` 11），覆盖 WebGPU-only 参数、三条失败分支、拒绝回退、StrictMode 不重建不泄漏、真正卸载恰好释放一次、初始化未完成即释放、装配失败时设备也要释放、重试、以及**设备丢失三态**。真正的 GPU 行为仍只能在可见窗口里验证（§三）。

**设备丢失：与 three 侧完全不同的一条（本机核实）**

`webgpu-graphics-device.js:333-343` 的 `handleDeviceLost`：

```js
async handleDeviceLost(info) {
  if (info.reason !== "destroyed" && !this._destroyed) {
    super.loseContext();  this.fire("devicelost");
    await this.createDevice();          // ← 引擎自己重建设备
    super.restoreContext(); this.fire("devicerestored");
  }
}
```

**引擎自己会恢复**（three 侧要应用自己处理）。所以会话**不能**在 `devicelost` 时判死，只把它作为可自愈状态暴露（`SessionSnapshot.deviceLost`）；硬失败面板留给真正收不到 `devicerestored` 的情况，那时 `retry()` 仍可用。`reason === 'destroyed'`（主动销毁）被引擎忽略，与既有 three 侧逻辑一致。测试覆盖：丢失只置位不判死、恢复后清除、**释放时退订**（否则设备销毁后回调仍持有会话，StrictMode 下会累积）、丢失后 retry **先释放旧的再重建**。

> 一处自查修正：`retry()` 的第一版会**泄漏旧资源**（新建设备而旧的还挂着）。已重构成释放路径只有 `teardownResources()` 一条，并加了回归测试。

> 注：`playcanvas` 用**动态导入**，且目前没有代码路径引用它，所以构建产物**未变大**（`vite build` 输出与迁移前一致）。
> `AppBase` 的 component system / resource handler 白名单暂未收窄——先用引擎默认集合跑通，收窄留到 Phase 6（过早收窄会以"某个组件静默不工作"的形式炸）。

### Phase 2 —— 窗格与相机（✅ 纯核心 + 接入 + 指针输入，均在真实浏览器验证）

新增 `app/src/shared/rendering/playcanvas/paneCamera.ts`（无引擎依赖，9 条测试），把**四条静默失败的约束**固化下来：

| # | 约束 | 依据 |
| --- | --- | --- |
| ① | `camera.rect` 归一化、**左下原点**；DOM 测量是左上原点 → 必须 `y = 1 - (top+height)/canvasHeight` | `camera.js:107`；`element-input.js:1029-1035` 注解 "origin is bottom left of window" |
| ② | **只填 rect，不要自己再翻 y** | 归一化→像素只有一处（`renderer.js:426-448`），WebGPU 后端自己翻（`webgpu-graphics-device.js:1867-1891`），WebGL 不翻 → rect 语义后端无关 |
| ③ | 分母用**画布 CSS 尺寸**，DPR 自然抵消 | 归一化后 `CSS px/CSS 尺寸` 与 `buffer px/buffer 尺寸` 相等 |
| ④ | **每格都必须清深度** | 共享深度附件，残留值让后面每格深度测试全灭 → 整格黑（§2.6 二分定位） |

另外两条实测过的取舍也写进了代码注释：**每格清屏不阻断 pass 合并**（非满尺寸 rect 的清屏是 pass 内被 viewport 裁剪的 quad，不是 `loadOp: clear`）；越界 rect 会**钳到 [0,1]**（WebGPU 的 `setViewport` 不钳制，越界即验证错误），另给 `isRectInBounds` 让布局 bug 可见。

**接入已完成并在真实浏览器验证**（见 §三之三）：

| 文件 | 职责 |
| --- | --- |
| `paneRegistry.ts` | 窗格**增量同步**（按 id 保持身份、只建缺的、只销毁多余的）+ layer/清屏/优先级策略；引擎调用留在注入工厂后面（10 条测试） |
| `enginePanes.ts` | 引擎绑定：建相机实体、建逐窗格 HUD layer、落 rect/layers/priority/clear/projection。**很薄**——所有判断都在上面两层 |
| `cameraRig.ts` | 台架状态 → 引擎实体（5 条测试 + §三之三 的真实浏览器签名比对） |
| `paneInput.ts` | 每格各自的 DOM 指针输入：命中测试 + 手势路由 + 台架换算，**无引擎依赖**（42 条测试 + §三之六 的两级真机验证） |
| `panePicking.ts` | 窗格拾取：`pc.Picker` 绑定 + 画布归一化坐标换算，**无引擎依赖的部分可单测**（15 条测试 + §三之七 真机） |
| `paneGizmo.ts` | 逐窗格变换 gizmo 宿主：层生命周期、模式/坐标系/挂点、拖动信号（9 条测试 + §三之七 真机） |
| `panes.browser.ts` + `app/pc-panes.html` | dev 探针（沿用仓库 `*.browser.ts` 约定，不进生产包）；`input=1` 跑输入自检，`inputHoldMs=` 暴露 `window.__PC_INPUT__` 给 CDP 可信事件复测 |

**两条新踩到的引擎事实**：

1. **`AppOptions.componentSystems` 默认是空数组**（`app-options.js:16-17`），`AppBase.init` 只注册你列进来的（`app-base.js:228`）。漏了某个系统 → `entity.addComponent("camera")` **什么也不做、`entity.camera` 是 undefined、零报错**。这是我在文档里警告过的"静默失败"，**我自己踩了**。所以显式清单**不是优化而是必需**（引擎自带 `AppBase` 示例也都显式列，只有 `Application` 才带默认集合）。现在 `app.ts` 里还加了一道校验：`init` 后逐个检查必需系统，缺谁报谁。
2. **layer id 不用自己找**：`layer.js:87-90` 里不传 `id` 时 `this.id = layerCounter++`。默认层是显式 id 建的，所以自动分配从 5 开始——本应用"layer 0=核心、1–4=各窗格 HUD"与引擎默认层撞号的问题由此解决。

**仍未做**：正交-透视**切换**（`applyRig` 已支持两种投影，缺的是 UI 入口）、屏幕等大坐标轴球。
"谁来改机位"已经解决——`paneInput.ts`（§三之六）按窗格命中测试接指针事件，台架是唯一真值。


### Phase 3 —— 模型与材质（第一步：数据契约已抽出）

**已做**：把 `shared/lib/modelTextures.ts` 切成两半——

| 一半 | 去向 | 为什么 |
| --- | --- | --- |
| 通道表（18 项）+ 缩略图生成与缓存 + 数据类型 `TextureEntry` / `ChannelTexture` + 尺寸读取 | ✅ **纯模块** `shared/lib/textureSlots.ts`（5 条测试） | 完全引擎无关；换引擎时**不动** |
| 遍历引擎场景图取材质贴图 | 留在 `modelTextures.ts`（three） | 只有这一半需要为 PlayCanvas 重写 |

⚠️ 一处容易混淆的地方，已写进代码注释与测试：`textureSlots.TEXTURE_SLOTS`（**18** 项）是**发现**
（模型自带材质可能填了哪些通道，用于预览），而 `materialSchema.MATERIAL_TEXTURE_SLOTS`（**7** 项）是
**覆盖**（用户能手动换图的通道）。混用会让右侧栏出现换不了的通道、或让悬浮卡漏报模型实际带的贴图。

抽出后 `modelTextures.ts` 只剩遍历，是 Inspector 那处待消除破口的三分之二所在。

**已做（第二、三步）**

- **槽位映射表**（纯模块 `textureSlots.ts`）：规范通道 → 各引擎材质属性名。属性名取自引擎 d.ts 的
  `@property {Texture}` 列表。表里有**两张必须显式声明的语义旗标**，因为照搬属性名会静默给出错误标注：
  `roughnessMap` → `glossMap`（**取反**：three 越白越粗糙，PlayCanvas 越白越光滑）、
  `displacementMap` → `heightMap`（仅近似）、`clearcoat*` → `clearCoat*`（大小写）。`bumpMap` 显式声明
  **PlayCanvas 没有对应物**，而不是随便指一个属性。`missingBindings()` 把"加了通道却忘了配映射"变成一条测试失败。
- **PlayCanvas 侧生产者** `shared/rendering/playcanvas/modelTextures.ts`：用**窄结构接口**遍历场景图，
  产出 `TextureEntry[]` / `ChannelTexture`。窄接口是刻意的——它让遍历逻辑能在**不加载 3.6MB 引擎**的前提下
  被 9 条单测覆盖，且引擎属性名不完整时（`StandardMaterial` 在 d.ts 里是 `@property` 注释风格）
  用防御式读取比写死一条路径更稳。

**✅ 已在真实网格模型上验证**（`ClearCoatTest.glb`：19 材质 / 6 贴图 / 对象树 27 个 render 组件）：

```
诊断: entitiesWithRender=27  meshInstanceCount=27  materials=19
发现通道: CC, Base Color, Alpha, Metal, Rough, CC Rough, Normal, CC Normal, Emissive
贴图: 6 张（256/512/1024），合并标注正确 —— Base Color/Alpha、Metal/Rough/CC Rough、Normal/CC Normal
```

**映射表被真实材质印证**（引擎打印的属性名）：`_diffuseMap` / `_opacityMap` / `_glossMap` /
`_clearCoatMap` / `_clearCoatGlossMap` / `_clearCoatNormalMap` / `_metalnessMap` / `_aoMap` /
`_emissiveMap` / `_specularMap` / `_heightMap` / `_lightMap` / `_sheenMap` … —— 三处易错项
（roughness→gloss、alpha→opacity、clearcoat→clearCoat）**全部存在于真实材质上**。

**✅ 缩略图也已通过**（6/6）：`hasThumb = [true × 6]`，尺寸 256/512/1024 正确。

修的是一个我判断错的地方：`Texture.getSource(mipLevel = 0)` 返回的就是 `this._levels[mipLevel]`，
而对 GLB 贴图**这个 level 本身就是 `ImageBitmap`**——图像**不在** `level.source` 上。
我先按 `level.source` / `.img` / `.data` 找，三条全落空，症状是"尺寸读得到、缩略图全 null"
（尺寸走的是 level 自己的 `width`/`height`，所以掩盖了图像那一步的错误）。

**证据在引擎源码里**：`releaseImageSources()` 直接判 `level instanceof ImageBitmap`；
实测转储到的 `levelProtoKeys` 正是 `["width","height","close"]`——`ImageBitmap` 的原型。

**顺带澄清一个我原先的**错误假设**：一度以为 GLB 贴图会释放 CPU 图像（因为转储里有
`releaseSourceAfterUpload` 字段）。实际上该标志**默认 false**，全库只有
`gsplat-sog-resource.js` 打开它（SOG splat 的纹理，不是模型贴图）。

**过程中两次自己踩的坑（都靠真实浏览器暴露）**：
1. 先用了 `new Asset(...)` + `AssetListLoader` 加载容器 → 空树。改用引擎示例的写法
   `app.assets.loadFromUrlAndFilename(url, filename, 'container', cb)`，并且发现**只监听 `error`
   事件会漏掉真正的失败**——那个回调的 `err` 参数才是权威。
2. **测试资产一度选错**：`biker.glb` 是 **splat GLB**（`extensionsUsed: ['KHR_gaussian_splatting']`，
   1 mesh / 1 node / **0 materials / 0 images**），所以"0 材质 0 贴图"是**正确行为**。换成真正的
   网格模型后立刻通过。**教训：验证生产者必须先确认资产里有材质。**

**已做（第三·五步）：契约已建立并测试** —— `shared/lib/modelDescription.ts`

渲染层 → 编辑层的"模型描述"契约：按资产 slug 存储 `{ status, supportedSlots, channels }`，
生产方是渲染层（它本来就把模型加载进了场景），消费方是 Inspector。4 条测试。

**为什么是模块级 store 而不是 React context**：生产方在 `Viewport` 子树里、消费方在 `Inspector`
子树里，两者是**兄弟**。用 context 就得让 `pages/AppDashboard` 加 Provider——那正是
`editingLayerBoundary.test.ts` 要守住的"编辑层零改动"。模块级 store 让双方各自改自己的导入即可。

**一个只在"同一模型被替换"时才出现的静默 bug（写的时候自己踩到）**：快照最初用 `size`，
于是用同一个 slug 重新 publish（模型换代）时 size 不变 → 订阅者收不到通知 → Inspector 停在旧缩略图上。
已改成**版本号**，并有一条专门的测试钉住"size 不变也必须通知"。

**✅ 已完成（原子地一起做完了，不是半截）**

1. **生产方**：`widgets/Viewport/publishModelDescription.tsx`，挂在 `ModelMesh` 的**真实渲染路径**上
   （模型加载完成处），不再让编辑层自己挂第二份模型。键用 `asset.id`（**稳定 id**）而不是
   `assetSlug`——后者是目录名，删掉同名资产重建会复用，描述就会串到新资产上；
   scene.json 的 transforms / materials 两张表同样按稳定 id 索引。
   发布的是**原始事实**（材质真正声明了哪些通道、每通道挂的是哪张图），显示策略留给消费方。
2. **消费方**：`Inspector/TextureChannels.tsx` 改为 `useModelDescription(asset.id)`，
   删掉了 `LoadedAssetObject` / `collectSupportedSlots` / `collectChannelTextures` 三个导入，
   连 `Suspense` 一起（不再有异步加载要等）。空态也分了两种：**描述尚未发布**（"Loading…"）
   与**模型确实没有可换通道**（"do not declare any replaceable texture channel"）——
   合并成一种会让"还没加载"显示成"不支持"。
3. **白名单收窄**：`SEAMS` 从 4 条降到 1 条，`FROZEN_IMPORTERS` 清零。
   **这一步是守卫测试自己报出来的**：失效检查列出 `ModelMesh.tsx` /
   `materialOverrides.ts` / `modelTextures.ts` 三条已不再被触达，要求删除——机制按设计生效了。
   （一处自纠：我先把整张表清空了，但守卫只报了 3 条失效，说明 `ModelPreviewWindow` 那条
   **仍在被触达**，于是恢复。**信守卫的报告，不要凭印象清表。**）

**✅ 生产方已在真实编辑器页面端到端验证**（`.tmp/pc-e2e/drive.mjs`，可见窗口 Chrome + CDP，
目标 `http://127.0.0.1:5176/app/p-mu5l6om3`）：

```
assetId: slug:black-cat   status: ready
supportedSlots:   [map, normalMap, roughnessMap, metalnessMap, aoMap, emissiveMap, alphaMap]
channelSlots:     [map, normalMap, roughnessMap, metalnessMap]
channelsWithThumb: 4          ← 4 个通道的缩略图全部产出
```

即视口加载模型后确实发布了描述，且 Inspector 渲染每一行所需的四要素（支持的通道、通道列表、
每通道的自带贴图、缩略图）**全部就位**。**验证方式**：读模块级 store 的 `listModelDescriptions()`
（生产方是否真的发布过，只有从页面里读它才知道），而不是靠肉眼点开面板。

**这一步排掉的两个环境陷阱**（都不是代码问题，但会让探针读出假的 0）：
1. 页面被**访问门禁**挡住 → 编辑器根本没加载模型。仓库的规范做法是调应用自己的
   `passAccessGate()`（`app/scripts/gpu-probe.mjs:232-247`），**不嗅探 DOM 文案、不硬编码口令**。
2. **解锁只写 localStorage，已渲染的门禁页不会因此重渲染** —— 实测停在
   "Answer a question to continue"、`canvases: 0`。必须**解锁后重载页面**。
   重载还会销毁执行上下文（"Execution context was destroyed"），所以要带重试。

**✅ 全部完成**：`SEAMS` 与 `FROZEN_IMPORTERS` **两张白名单当前都为空**，守卫 4 条规则全过。
（这三条越界是**守卫的失效检查自己报出来的**——它列出已不再被触达的条目要求删除，机制按设计生效。）

⚠️ 已知尚未纳入守卫的同类越界：`widgets/ModelList/AssetTextureStrip.tsx` 仍用 `LoadedAssetObject`
（`ModelList/` 不在冻结集里）。ModelList 迁移时应一并处理，并把它加进冻结集。

### Phase 4 —— Splat（加载链路已完成并验证）

`app/src/shared/rendering/playcanvas/splat.ts`：注册 `SpzParser` + `WasmModule.setConfig('ZstdDecoderModule', ...)`。
**ZSTD 解码器必须 vendor 到本仓库**——它在 `examples/assets/wasm/zstd/` 下，**不在 npm 包的 `files` 白名单里**
（白名单只有 `build/playcanvas*` / `scripts` / `README*.md`）。已放进 `vendor/`，经 Vite 的 `?url` 走资源管线
（胶水是 IIFE、靠 `window.ZstdDecoderModule` 注册，不能当模块打进来）。`spz-parser.mjs` 没有 `.d.ts`，
按实际用法在 `app/src/types/playcanvas-scripts.d.ts` 里给了最小声明。

engine GSplat 用默认的 `unified = true`（**不要设 `false`**，§二.4）。**资产必须先转 v4**（§二.3），
已验证 1.92M × 4 窗格可用（§三之四）。

**✅ 病 1 已实测**（§三之五）：1.92M 资产下静止/运动 p50 = 16.7/16.7（1 窗格）、17.0–17.1/17.1–17.3（4 窗格），
两轮交替一致——相机运动测不出代价（对照 three/GSL 的 100–150 ms）。

**仍未做**：与 `SplatModel.tsx` 的**编辑交互**对齐（选中/变换/撤销）。

### Phase 5 —— 截图（已完成并验证）/ 缩略图 / 资源账

**已做**：`shared/rendering/playcanvas/capture.ts`。三处与 three 侧不同，都是必要的而不是风格差异：

| 差别 | 依据 |
| --- | --- |
| **不要移植 `unpackRGBA`** | three 的 `readRenderTargetPixelsAsync` 返回**带 256 字节行对齐**的 buffer，所以要手工解；PlayCanvas 的 `Texture.read` **自己**在 `webgpu-texture.js` 里 `roundUp(bytesPerRow, 256)` 后逐行 `subarray` 拷贝，应用侧只给紧凑 `Uint8Array`。搬过来会把已紧凑的数据再解一遍 |
| **`RenderTarget` 没有 `width`/`height`/`colorFormat`** | `render-target.js` 只看 `colorBuffer` / `colorBuffers` / `depthBuffer` / `samples` / `depth`——尺寸与格式来自你给的那张纹理 |
| **读回必须 `immediate: true`** | 帧外没有东西 submit 共享 command encoder，延迟读会在拷贝真正执行前 map staging buffer、读到零值（SuperSplat 在三处源码都写了这条） |

另外遵守 three 侧那条纪律：**设置与还原之间不 await**；且只改这一台相机自己的 `renderTarget`，
不去动全局目标尺寸。

**✅ 真实浏览器验证**（1.92M 资产，256×256）：

```
1 窗格: bytes=262144  (= 256×256×4 恰好紧凑)  亮度 28.68  非背景 0.146  不透明 1.0
4 窗格: bytes=262144                          亮度 34.22  非背景 0.170
主渲染 pass 计数不变（241/244）→ 截图不干扰帧路径
```

`bytes` **恰好等于 `w*h*4`** 就是"引擎已解完行填充"的直接证据。

**✅ 准入层接线已完成并验证**：`captureViaQueue.ts` 把三个已有的件编排起来
（`CaptureQueue` 排队 → `ResourceBudget` 预约/降级 → `captureScenePixels` → 释放），
**一行纯 TS 的准入逻辑都没重写**。

```
入队（准入 + 背压）→ 预约预算（可能降级）→ 渲染进私有 RT + 读回 → 释放预约
```

`pressure` / `reclaim` 是**注入**而非导入 `ModelResources`：后者仍绑在 three 上，直接导入会把 three
拖进来；"两本账取更紧一侧"这条语义留在应用装配处，不藏进截图模块。

**✅ 真实浏览器验证（走队列，1.92M 资产）**：

| 窗格 | splats | 主 pass | 截图读数 |
| --- | --- | --- | --- |
| 1 | 1,920,000 | 241 | 256×256 bytes=262144 **queuedMs=53** degraded=false |
| 4 | 1,920,000 | 244 | 256×256 bytes=262144 **queuedMs=63** degraded=false |

像素读数（亮度 28.68 / 34.22、非背景 0.146 / 0.1704）与**直连路径完全一致** → 排队没有改变结果；
主 pass 计数不变（241/244）→ 截图不干扰帧路径。

**单测 8 条**覆盖：跑通并回报 `queuedMs`、预算不足时**降级**（而非抛错）、预算连最小档都放不下时抛错、
**预约在读回之后才释放**、abort 直接拒绝、优先级经队列传递、待办队列满时拒绝。

> 写这 8 条时我自己错了三处（忘了注入假 capture、用 `w*h*4` 手算预算、误解 `capacity` 限的是待办队列），
> 其中一处暴露出**我的模块测试性不足**——它直接用模块级 `captureBudget` 单例，导致"降级"根本测不到，
> 已把 `budget` 也改成可注入。

**✅ 四视角检查图已完成并验证**

把两样**引擎无关**的东西抽进纯模块 `shared/lib/inspectionSheet.ts`（4 条测试）：
`INSPECTION_VIEWS`（视角语义：标签/朝向/上方向/投影）与 `composeInspectionSheet`（2×2 版式 + 标注）。
**three 侧也改用它**——两个引擎共用同一份版式，而不是各写一遍（`ModelPreviewWindow` 里那段
内联 canvas 代码已被替换掉）。

引擎相关的只剩"把相机摆到某个视角"这一步：`playcanvas/inspectionCapture.ts`。
相机数学逐项对齐 three 侧：`fitDistance = (radius / tan(fov·π/360)) × 1.35`、
正交半高 `radius × 1.35`、TOP 的上方向 `(0,0,-1)`。用一台**专用**相机（只挂 world 层），
不改用户相机的投影/机位。

**✅ 真实浏览器验证**（`ClearCoatTest.glb`，四格各 128px）：

| 视角 | 亮度 | 非背景占比 |
| --- | --- | --- |
| ISO（透视） | 94.66 | 0.844 |
| FRONT（正交） | 54.45 | 0.724 |
| RIGHT（正交） | 34.20 | 0.212 |
| TOP（正交） | 37.10 | 0.232 |

**`唯一签名数 = 4`** —— 四格的像素签名互不相同，证明相机真的摆到了四个视角（而不是拍了同一张四次）；
`pngBase64Length = 44124` 说明确实产出了 PNG。签名是对**合成后的检查图**逐格重算的，
所以版式与标注也被一起走到了。

> 顺带修掉一个实现缺陷（由测试发现）：`sheetToBase64` 原先用 `slice(indexOf(",")+1)`，
> 当 `toDataURL` 没有逗号时会 `slice(0)` 把**整串**（含 `data:image/png;base64`）当 base64 返回，
> 上层会把一段非 base64 文本当图片上传。现在没有逗号就返回空串。

**仍未做**：把检查图接到**应用里的 `ModelPreviewWindow`**。PlayCanvas 侧的拍摄已实现且经探针验证，
合成器也已与 three 版共用同一份（`shared/lib/inspectionSheet.ts`）；缺的是"在应用里由谁触发"——
那属于 Phase 6 的整体切换。

> ⚠️ **新增的整场景检查只在 three 侧实现（2026-10-01）**：`inspect` 工具的 `target="scene"`
> 由主视口按一个机位拍整张场景图（`widgets/Viewport/SceneInspectionCapturer.tsx`），
> 检查图落盘在项目级 `inspections/`，回传文案是 `[Scene check]`。
> `inspectionCapture.ts` 目前只有"一个资产、四个视角"这一种口径，**迁移到 PlayCanvas 时要一并补上
> 场景级取景**（取景对象是 `asset:` 摆放组，编辑器网格与天空背景球不参与——见
> `SceneInspectionCapturer` 的 `sceneContentBox`）。

 / 探针

- `capture.ts`(91) / `CaptureQueue.ts`(78) / `ModelResources.ts`(194) / `ResourceBudget.ts`(154) / `gpuProbe.ts`(869)。
- **不要照抄 SuperSplat 的 `startOffscreenMode`**：它靠改全局 `targetSizeOverride` + 四组 enabled 标志，并发截图互相踩。本仓库的 `CaptureQueue` + 私有 RenderTarget + 尺寸阶梯是更正确的形态，保留。
- 读回：engine 的 `Texture.read` **自己做 256 字节行对齐与解包**（`webgpu-texture.js:628-692`），应用侧只给紧凑 `Uint8Array(width*height*4)`。**单像素/单次读回必须 `immediate: true`**——SuperSplat 在 `render.ts`/`picker.ts`/`equirect-renderer.ts` 三处都写了注释强调，理由是"帧外没有东西 submit 共享 command encoder，延迟读会读到零"。
- `gpuProbe`：改用 `GpuProfiler` + `timestamp-query`；**接受窗格粒度丢失**（§二.7），或自建归因。

### Phase 6 —— 真实浏览器验证 + 文档

- 重跑：多视口正确性、1.92M splat、拖动排序、截图方向/alpha/色调映射、状态恢复。
- 按 `AGENTS.md` §五 的口径区分"单测 / 类型检查 / 真实浏览器 / 真实资产"。
- **重写 `AGENTS.md`**：§二.1–§二.14 大量条目是 three 专属（`antialias` 的依据、`three`/`@types/three`/`gsl` 锁定、`patches/`、`ArrayCamera.cameras` 容量约束、`autoClear` 四 flag 成套改…）。受影响还有 `VIEWPORT_REVIEW.md`、`WEBGPU_FINDINGS.md`、`WEBGPU_PROBE_PROTOCOL.md`。

### 迁移面清单（本机核实）

48 个文件 / **6699 行**含 `three` 或 `@react-three` 导入；`app/src/shared/rendering/` 另有若干不含 three 但属渲染层的文件（`CaptureQueue` / `ResourceBudget` / `ModelResources` / `gpuProbe` / `initializeRenderer`）。最大单文件：`Viewport/index.tsx` 844 行、`PaneCamera.tsx` 634、`ModelMesh.tsx` 466。

---

## 五、剩余工作（按依赖顺序，每条都写了下一步动作）

> 现状一句话：**PlayCanvas 层是一套并行实现 + 探针验证过的模块，应用还没切过去。**
> 真正的集成风险（替换 `Viewport` 时的耦合）都还在下面这些条目里。

### 必须先做（否则后面会返工）

1. **相机交互**（Phase 2 余项）——**已完成并在真实浏览器验证（指针输入那一半见 §三之六）**：
   - ✅ `shared/lib/cameraRig.ts`（**10** 条测试）：轨道状态 → 机位、乘性缩放 + 钳制、
     平移（像素→世界，方向"画面跟着手走"）、聚焦（包围球 + fov）、极角钳制（避免与 up 共线滚转）。
     平移现在可以传**窗格自己的 up**——俯视窗格是 `(0,0,-1)`，按世界 +Y 算会让方向差 90°（新增 2 条测试）。
   - ✅ `playcanvas/cameraRig.ts`（5 条测试）+ **真实浏览器验证**：方位角 0°/90° 拍到的
     像素签名不同（1670783485 / 376317171），证明相机真的动了。
   - ✅ **`playcanvas/paneInput.ts`（37 条测试）+ 两级真实浏览器验证（§三之六）**：
     每格各自的 DOM 指针事件 → 轨道旋转 / 滚轮缩放 / 右键平移 / 双击聚焦。
     拖动期间必须 `setPointerCapture` + 在 `window` 上收 move/up（否则指针移出画布就**永久粘住**）；
     `wheel` 必须 `{ passive: false }`（否则 `preventDefault` 静默失效、页面跟着滚）；
     双击**自算**而不依赖 `dblclick`（实测取消 `pointerdown` 只抑制 `mousedown`，但兼容事件不该被依赖）；
     正交窗格滚轮不动（可见高度是产品常量 `ORTHO_VIEW_WORLD_HEIGHT`）。
   - 🔴 **剩**：屏幕等大坐标轴球（`PaneGizmo`）——和下面第 3 条一起做。
   - **刻意未做**（记在这里，免得被当成漏做）：阻尼/惯性、双击聚焦的缓动飞行（两者都要每帧推进，
     属渲染循环而不是输入层）、捏合缩放（只处理指针事件，触摸=单指轨道）、按部件聚焦（要先有拾取）。

   **一处净删代码**：three 侧因为 drei 把正交视锥按**像素**重设，必须每帧 `zoom = 窗格像素高 / 15`
   反推（`PaneCamera.tsx` 的 `OrthoZoomSync`）。PlayCanvas 的 `camera.orthoHeight` 本身就是
   **世界单位半高**，所以直接 `orthoHeight = 7.5` 就满足"竖直恒定可见 15 个世界单位"——
   **那一整段没有了**，宽高比交给 `camera.rect`。
2. **拾取与变换 gizmo**——**引擎侧已完成并真机验证（§三之七）**，剩集成层：
   - ✅ **拾取**：`playcanvas/panePicking.ts`（15 条测试）。用引擎自带的 `pc.Picker`，**不要**照抄
     SuperSplat 那份 splat 编辑专用的 picker；坐标是**画布归一化 × 缓冲尺寸**；`layers` 只给共享核心层；
     splat 要先开 `scene.gsplat.enableIds`。真机：1/2/4 窗格都能从投影点拾到靶子、空白角落空、且不改台架。
   - ✅ **变换 gizmo**：`playcanvas/paneGizmo.ts`（9 条测试）。用引擎自带的
     `TranslateGizmo`/`RotateGizmo`/`ScaleGizmo`，逐窗格各一个（手柄射线自带 `camera.rect` 换算，
     不需要自己接输入）。真机可信拖动：物体 `Δ=(1.969,0,0)`、相机台架不动、`transform:start/end` 成对。
   - 🔴 **剩（都在集成层）**：多选整体变换（pivot = 位置包围盒中心 + 冻结相对矩阵）、
     拖动写 `LiveTransforms` + 松手 `onCommit` 进撤销栈、选中/悬浮线框、`G/R/S` 与 world/local 面板、
     以及**在真实 splat 上**验证 `gsplat.enableIds` 那条路径。
3. **网格与坐标轴 HUD**：`WebGPUGrid.tsx`（TSL：两级网格 + 导数抗锯齿 + 距离淡出）与 `PaneGizmo`。
   ⚠️ 这两块**目前没做**，而且网格需要写成 PlayCanvas 的 WGSL chunk（SuperSplat 的
   `infinite-grid-shader.ts` 是全屏 quad + ray/plane 求交，与这里的 400×400 平面写法不同，不能照抄）。
4. **第一人称模式**：`FirstPersonRig.tsx` / `CameraRig.tsx`。

### 然后（集成）

5. **把 PlayCanvas 渲染层真正接进应用**：用新的 `Viewport` 实现替换 three 版，`ViewportProps` 保持不变。
   建议**先单窗格 + 模型**跑通，再打开 1/2/4 与 splat——一次全开的话出问题很难二分。
6. **把检查图接到应用里的 `ModelPreviewWindow`**：PlayCanvas 侧拍摄与合成器都已就绪
   （`inspectionCapture.ts` + 共享的 `inspectionSheet.ts`），缺的是"应用里由谁触发"。
7. **`AssetTextureStrip.tsx`**（`widgets/ModelList/`）仍在用 `LoadedAssetObject`——同类越界，
   但 `ModelList/` 不在冻结集里，守卫覆盖不到。迁移 ModelList 时一并处理并把它加进冻结集。

### 定论（Phase 6）

8. **在完整编辑器上做交替设计 + 多轮 + GPU 时间戳**，把 §三之二 的"4 窗格 1 GPU pass / 无塌缩"
   从方向性信号变成结论。**前置障碍**：§二.7 记录的"`passTimings` 按 pass 名累加会丢失窗格粒度"，
   要做窗格级归因必须先解决它。
9. **测 octree 路径**：用 `splat-transform` 生成 `lod-meta.json`、设 `splatBudget`，
   看能否把"每视图全量"进一步降下来（这是病 2 唯一引擎原生支持的杠杆）。
10. **重跑 `AGENTS.md` §五 里那张浏览器验证表**（截图方向/alpha/色调映射、材质、缩略图、四视角、
    splat 生命周期），确认迁移后逐项仍成立。

### 尚未落成测试的约束

- **多窗格"每格必须清深度"**：现在只有 `paneCamera.test.ts` 断言了 `paneClearFlags` 的返回值，
  **没有**能捕获"整格黑"这个真实症状的回归测试。真实症状只能在浏览器里看逐格像素。
- `enginePanes.ts` / `capture.ts` / `inspectionCapture.ts` 对引擎 API 的调用**只在探针里验证过**，
  没有单测（这是刻意的：它们是薄适配层，单测只会重复实现）。

## 六、未核实（勿当结论）

- **PlayCanvas 在别的厂商 GPU 上的行为**：本机只有 Apple M5，`system_profiler` 显示 `Bus: Built-In`，
  **没有任何独显或外接 GPU**。所以"兼容外部 GPU"这一条**本机无法验证**；能保证的只是
  "设备选择权收进自己手里（`powerPreference: 'high-performance'` + `xrCompatible: false`）+ 无 WebGL 回退"
  在**代码层面**成立，且断言 `isWebGPU && !isWebGL2` 会在拿到非 WebGPU 设备时硬失败。
- `@playcanvas/react` 的测试数量/覆盖率/CI 状态（github.com 在本沙箱不可达）。已核实的是它的
  props 反射会丢弃 `camera.layers` 等结构化句柄（实测），所以本方案不用它。
- 2.22.6 与 2.23.0-beta.24 的其余差异（浅克隆只有单 commit）。已核实的是 `unified` 默认值与
  `createGraphicsDevice` 无条件追加回退这两条。

## 七、边界声明

- **已改动的生产代码**：`app/src/shared/rendering/playcanvas/`（新目录；本轮在其中新增
  `paneInput.ts`、`panePicking.ts`、`paneGizmo.ts`（各带测试），并给 `panes.browser.ts` 加了输入/拾取/gizmo
  自检与 `__PC_INPUT__` 活口）、
  `app/src/shared/lib/{cameraRig,textureSlots,modelDescription,inspectionSheet,inspection,materialSchema}.ts`、
  `app/src/widgets/Viewport/{transformMode.ts,publishModelDescription.tsx,ModelMesh.tsx}`、
  `app/src/widgets/Inspector/TextureChannels.tsx`、`app/src/shared/lib/modelTextures.ts`、
  `app/src/widgets/ModelPreviewWindow/index.tsx`、`app/src/pages/{AppDashboard/index.tsx,AppDashboard/useSceneHistory.ts,AppDashboard/useAgentChat.ts,editingLayerBoundary.test.ts}`、
  `app/package.json`（加 `playcanvas@2.22.6`）。
  > `shared/lib/cameraRig.ts` 这一轮只做了一处**加法**：`panBy` 多一个可选的 `worldUp`（默认世界 +Y，
  > 俯视窗格传 `(0,0,-1)`）。原行为不变——不传时的结果与旧实现逐位相同（旧测试一字未改）。
  > `paneRegistry.ts` 加了 `PaneSpec.extraLayerIds`（gizmo 层的唯一写入点）与 `cameraLayers()` 的去重；
  > `paneInput.ts` 加了 `onClick` / `isPointerClaimed` / `focusRigWithTarget`（两种聚焦口径）。
- **编辑层的改动量**：只有 3 处 import 改指向纯模块（各 1 行）——
  `AppDashboard/index.tsx` 的 `TransformMode`、`useSceneHistory.ts` 的 `TransformMode` + `DEFAULT_MATERIAL`、
  `useAgentChat.ts` 的 `InspectionRequest`。**业务逻辑一行未动。**
- 声明为"通过"的只有本机**实测**的输出（§三系列），并逐条注明了测量条件与边界。其余为源码级核实。
- **未进生产包**：`app/pc-panes.html`、`playcanvas/panes.browser.ts`（vite build 只以 `index.html` 为入口）。
- **不在生产代码里**：探针驱动 `.tmp/pc-panes/drive.mjs`（合成事件自检）与
  `.tmp/pc-panes/drive-input.mjs`（CDP 可信事件复测）。后者是本轮新增的**可复现入口**。

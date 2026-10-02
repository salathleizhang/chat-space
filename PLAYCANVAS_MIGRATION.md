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

## 三之八、§五.3 前半（编辑器地面网格）的真实浏览器验证 🧪

新增 `playcanvas/paneGrid.ts`（**14 条测试**）：两级网格（细线 0.5 / 粗线 5 世界单位）+ 屏幕空间导数
抗锯齿 + 以相机为圆心的 40 单位淡出，公式逐项照搬 three 侧 `widgets/Viewport/WebGPUGrid.tsx`（TSL），
改写成 PlayCanvas 的 WGSL。

**不照抄 SuperSplat 的 `infinite-grid-shader.ts`**（这是 §五.3 明确点到的分歧）：那份是**全屏 quad +
射线/平面求交**（`infinite-grid.ts` 的 `QuadRender` + `preRenderLayer`，WGSL 里自己 `intersectPlane`、
还算光线的屏幕导数）。本项目是**有限的 400×400 平面**，几何完全不同。从它那里只借了"怎么在
PlayCanvas 里写 WGSL"：`ShaderMaterial({ uniqueName, attributes, vertexWGSL, fragmentWGSL })`，
着色器里自己声明 `attribute vertex_position: vec4f;` / `uniform matrix_model, matrix_viewProjection`。

### 三个坑（都会静默失败，且都在这一轮踩到了）

1. **`plane` 图元默认就躺在 XZ 平面、法线 +Y**（`plane-geometry.d.ts:35-41` 的原话），
   宽度沿 X、长度沿 Z。照 three 的习惯再转 `-90°`（`rotation-x={-Math.PI/2}`）会把它**立起来**，
   症状是"网格变成屏幕中间一条横带 + 整片均匀灰"、零报错。本机先看到这条横带，才回头去读图元文档。
2. **网格必须 `pick = false`**：`MeshInstance.pick` 默认 `true`（`mesh-instance.js:100`），
   而这是一张 400×400 的平面——不关掉，每次点击都先命中地面（three 侧对应写法是 `raycast={() => {}}`）。
   自检里直接断言"可拾取的 mesh instance 数 === 0"。
3. **淡出圆心必须用逐相机的 `view_position`**（view uniform buffer 里的标准 uniform，
   `UniformFormat("view_position", UNIFORMTYPE_VEC3)`），不能用材质参数或常量：
   `view_position` 是**按相机**填的，所以 4 窗格各自以**自己**的相机位置淡出。自检里有一条专门测它：
   把 pane-0 相机退到 500 单位外（平面只有 ±200、加上 40 的淡出半径，最近的平面点也在 300 单位外），
   那一格必须整片空掉——若这个 uniform 恒为 0，网格会一直亮在原点周围，这条就会挂。

> ⚠️ 一处**未核实**要记下来：这三个间距/半径现在是**编译期常量**（按参数拼 `uniqueName`，改参数 =
   换一份着色器变体），实测改参数确实会改变画面。最初观察到"建好材质后再 `material.setParameter()`
   改它们不生效"，但**那批读数是在第 1 条（地面立起来）的状态下取的**，所以"参数不生效"这个结论
   **没有被独立复核**。已知的是：引擎把非 view 集合的 uniform 塞进 `ub_mesh_ub`
   （`webgpu-shader-processor-wgsl.js` 的 `processUniforms`），那条上传路径本仓库**没有验证过**，
   所以本轮**不依赖**它。要把间距做成 uniform 的话，先补这一条验证。

### 实测（可见窗口 Chrome 154，`127.0.0.1:5199`，load 2.5–4.4）

`drive.mjs <url> <n> "grid=1"`，1/2/4 窗格各一轮，**全部 `ok=true`**：

| 断言 | 1 窗格 | 2 窗格 | 4 窗格 |
| --- | --- | --- | --- |
| 挂上/摘掉 → **每一格**像素签名都变（整场景一份、每格都看见） | true | true | true |
| 两级都真的在画（俯视机位下"只留细线"/"只留粗线"都与默认不同） | true | true | true |
| 淡出半径压到 0.5 → 网格整片消失 | true | true | true |
| 相机退到 500 单位外 → 网格整片消失（**逐相机淡出**生效） | true | true | true |
| 可拾取的 mesh instance 数 | **0** | **0** | **0** |
| `startRenderPass` / 帧数（网格 + 手柄都挂着） | 240/240 | 240/240 | 240/240 |
| p50 帧间隔 | 16.7 ms | 16.7 ms | 16.6 ms |

**"两级都真的在画"这条判据本身踩过一次假阴性**：探针默认机位是贴着地面的掠射角，在那个角度下
粗线一个像素都不贡献，于是"只留细线"和默认的像素统计完全相同。改成**换一个俯视机位**再比，
并同时记录"网格线像素数"与整格平均亮度（可读数字，不只是哈希）之后才成立：

| 俯视机位下 | 1 窗格 | 2 窗格 | 4 窗格 |
| --- | --- | --- | --- |
| 两级都在（线像素数 / 平均亮度） | 5279 / 27.25 | 2982 / 40.79 | 2592 / 27.22 |
| 只留细线 | 68864 / 29.11 | 36586 / 42.89 | 17187 / 29.06 |
| 只留粗线 | 68864 / 27.48 | 36585 / 41.05 | 17187 / 27.45 |

（三行数字互不相同 → 两级各自都在画；同机位比较才有效，跨机位比像素是无效判据——这一条也是踩过的。）

### 🔴 还没做的：屏幕等大坐标轴球（`PaneGizmo`）与网格 HUD

§五.3 的后半——three 侧 `PaneCamera.tsx` 的 `CameraAxes`/`PaneGizmo`：三根轴向色条 + 轴球、
以窗格右上角为锚点、**屏幕等大**（`GIZMO_SCALE = 40` / `GIZMO_MARGIN_PX = 64`）、点击轴球把机位吸附过去、
拖轴球簇做 trackball 自由旋转。现在**只有网格**，HUD 没做。已知的设计要点（下一轮直接用）：

- **不要为 HUD 再加一台相机**：可以用"把部件放在相机前方固定深度、按 `tan(fov/2)` 缩放"的办法得到
  屏幕等大效果（引擎自带 gizmo 的 `_updateScale` 就是 `tan(0.5*fov)*depth*0.3`），这样每帧 1 个 pass
  的验收线不用重新谈；否则要多 4 台 HUD 相机，pass 合并要重新量。
- HUD 层要 `clearDepthBuffer: true`（永远画在世界之上），并且**要进 `PaneSpec.extraLayerIds`**
  （见 §三之七：`sync()` 会重写 `camera.layers`）。
- 点击吸附是**屏幕空间命中**（把 6 个轴球世界位置投影回屏幕，按像素半径判），比射线求交简单且可单测。
- **trackball 自由旋转依赖"带滚转的台架"**（相机 up 可变），而当前 `CameraRig` 是 turntable（az/polar），
  所以这一条要么先扩台架模型、要么就只做点击吸附——这是与 three 侧的一处**有意**差异，别当成漏做。

## 三之九、§五.3 后半（屏幕等大坐标轴球 HUD）的真实浏览器验证 🧪

新增 `playcanvas/paneAxisHud.ts`（**13 条测试**）：三根轴向色条 + 六个轴球，钉在窗格右上角
（`MARGIN_PX = 64`）、**屏幕等大**（`HALF_SIZE_PX = 40` ⇒ 直径 80 px，对应 three 侧 `GIZMO_SCALE`），
点击轴球把机位吸附到那一侧。对应 three 侧 `PaneCamera.tsx` 的 `CameraAxes` / `PaneGizmo`。

### 实现路线：**不加相机**（与 three 侧不同，这是有意的）
three 侧给每格再开一台"像素正交相机"、把 HUD 组放在 `(w/2-64, h/2-64)`。PlayCanvas 里那样做要多 4 台
HUD 相机，"每帧 1 个 pass"的验收线得重新谈。这里改成把部件放在**相机前方固定深度**、按
`worldPerPixel` 缩放：

```
透视：worldPerPixel = 2·depth·tan(fov/2)/窗格高      正交：2·orthoHeight/窗格高
位置 = camPos + right·(dx·worldPerPixel) + up·(dy·worldPerPixel) + forward·depth
缩放 = worldPerPixel × 40          朝向 = 不旋转（世界轴，相机绕它转）
```

注意 `GraphNode.forward` 是**看向的方向**（世界 -Z，`graph-node.js:96-101`），所以"相机前方"是
`+forward×depth`（第一版写成 `-forward` 把部件放到了相机背后）。

### 四条约束
① HUD 层要 `clearDepthBuffer: true`（永远画在世界之上）并且**进 `PaneSpec.extraLayerIds`**（同 gizmo）。
② 命中用**屏幕空间**：把 6 个轴球用 `camera.worldToScreen()` 投回屏幕、按 22 px 半径判（可单测）。
③ **点击轴球必须先于拾取、且不能被"认领"吞掉**：输入层在按下时被 HUD 认领（不开轨道手势），
   但"点一下"这个动作要靠新的 **`onClaimedClick`** 回调——`isPointerClaimed` 让 `start()` 返回 null，
   而返回 null 时本层既不开手势也不发 `onClick`。与 gizmo 的区别是刻意的：**点手柄不该选中物体，
   点轴球该吸附机位**。
④ **DOM 层必须为"被认领的按下"也挂上 window 的 move/up**：否则那次 `pointerup` 收不到、
   `onClaimedClick` 永远不触发（本机踩到：点轴球不吸附，而"没有轨道手势"那条却是通过的——
   单看那一条会以为已经接通）。

### 实测（可见窗口 Chrome 154，`127.0.0.1:5199`）

**第一级·页面内自检**（`hud=1`，1/2/4 窗格；与 input/picking/gizmo/grid 一起跑也全绿）：

| 断言 | 1 | 2 | 4 |
| --- | --- | --- | --- |
| HUD 层在**每一格**相机的 layers 里 | ✓ | ✓ | ✓ |
| 只摘 pane-0 的 HUD：本格像素变、其它格不变 | ✓ | ✓ | ✓ |
| ±X / ±Y 轴球屏幕间距（已知机位，**期望 80 px**） | 80 / 80 | 80 / 80 | 80 / 80 |
| 相机退远 3 倍后 ±X 间距（**屏幕等大**） | 80 | 80 | 80 |
| 方位角 +90° 后 +Z 轴球的屏幕位移 | 84 px | 84 px | 84 px |
| 命中：落在轴球上 → 该轴；偏 100 px → null | ✓ | ✓ | ✓ |
| 吸附：距离/目标点不变、方位角按轴 | ✓ | ✓ | ✓ |
| `startRenderPass` / 帧数 | 240/240 | 240/240 | 240/240 |

**第二级·CDP 可信事件**（`.tmp/pc-panes/drive-input.mjs`，4 窗格，**27 条断言全过、退出码 0**）新增：

| 断言 | 读数 |
| --- | --- |
| 点轴球：没有开始相机轨道手势（HUD 认领了指针） | `{"active":null,"dragging":false}` |
| 点轴球：机位吸附到该轴（+X ⇒ π/2），距离不变 | `azimuth −13.6603 → 1.5708`，`distance 11.6913` 不变 |
| 点轴球不会变成选中物体 | `lastPick` 前后一致（`name: null`） |

### 这一轮的方法论坑（**比产品代码更值钱**，已写进 AGENTS 的探针小节）

组合自检（`input=1&picking=1&gizmo=1&grid=1&hud=1`）一开始大面积假阴性：grid 的 `mean` 读数是 **0**、
HUD 的逐格隔离失败、gizmo 的"本格变了"失败，而**每个模式单独跑都通过**。根因不是状态耦合，是
**在 rAF 之外读 WebGPU 画布会读到全黑**——尤其在某次帧外 pass（`Picker.prepare()`）之后。
修法是探针统一改成"`settle()` 等若干帧 → **在 rAF 回调里**抓一份快照 → 各像素辅助函数只读快照"。
在此之前我按"状态耦合"改了三处自检（给 grid/HUD 各自设已知机位、试过给 gizmo 加 framing 机位），
其中给 gizmo 加 framing 的那次**把单独跑通过的一条改坏了**——所以这条经验是：**像素判据先怀疑采集时机，
再怀疑状态**。

**同类教训还有一条**：判据本身要选对观测量。网格"两级都参与"最初用掠射角下的像素哈希比，粗线在那个
角度一个像素都不贡献；改成俯视机位 + "网格线像素数 + 平均亮度"之后才成立（§三之八）。

### 刻意没做
- **trackball 自由旋转**（three 侧 `GizmoTrackballHandle`）：要绕任意轴转、相机会带滚转，而当前台架是
  turntable（只有方位角/极角）。要做得先扩台架模型——**有意差异**。
- **轴球上的字母**（three 画在 canvas 纹理上）与**吸附动画**（`SNAP_TURN_RATE` 缓动）：只做颜色区分与立即到位。

## 三之九之二、修正：坐标轴 HUD 的"层"写错了 —— 4 窗格下能看见**别格**的坐标轴 🧪

**症状（用户报的）**：PlayCanvas 视口右上角的坐标轴看着像"3D 空间里的东西"，而且开 4 窗格时
**从一个视角能看到另一个视角的坐标轴**。它本该是**纯 UI 覆盖层**（three 侧就是单独一个场景 +
自己的正交相机）。

**根因（一句话）**：`entity.layers = [layer.id]` 在 PlayCanvas 里是**静默 no-op**——
`GraphNode`/`Entity` **根本没有** `layers`，层归属只由 **`render` 组件**决定（`_layers`，
默认 `[LAYERID_WORLD]`，注册路径是 `addMeshInstances/removeMeshInstances`）。
于是 12 个部件全留在 **World 层**，而**每一格相机都含 World 层** ⇒ 每格都把 4 个窗格的坐标轴画一遍。

```
$ node -e "const pc=require('playcanvas'); ..."      # 本机实测（2.22.6）
Entity.prototype    有 layers? false
GraphNode.prototype 有 layers? false
RenderComponent.prototype 有 layers? true
e.layers=[7] → 读得回来 [7]（所以"赋值成功"不能当"层生效了"的证据），但它只是自有属性
```

**为什么现有判据全绿却没抓到**（两条，都值得记）：
1. 像素判据跑在**默认机位**下，而每格部件钉在自己相机前方 1 单位、正交格相机离原点只有 12 世界单位 ——
   别格的视锥**通常够不着**，于是"只摘 pane-0：本格变、其它格不变"真的通过了。
2. 但**真实 4 窗格布局里它会露出来**：正交格的部件物理尺寸是 `worldPerPixel × 40`，而
   `worldPerPixel = 15/窗格高` 很大 ⇒ 部件半边长 ≈ **1.9 世界单位**，还被推到离自己相机轴
   **12 世界单位**处（`(窗格宽/2 − 64) px × wpp`，实测世界坐标 ≈ `(12, 5.6, 11)`）。
   那正好落在**透视格**的视野里、占几十个像素 ⇒ 用户看到"别格的坐标轴"。透视格的部件只有
   0.15 世界单位大，别格几乎看不见——所以这条串味是**单向的**（正交格 → 透视格）。

**修法（4 处，都改成引擎自己的写法）**：

| 位置 | 旧（no-op） | 新 |
| --- | --- | --- |
| `paneAxisHud.ts` 的部件工厂 | `root.layers = [id]` + `addComponent("render", { type })` | `addComponent("render", { type, layers: [id] })` |
| `selectionWireframe.ts` | `entity.layers = [id]` | `addComponent("render", { layers: [id] })` |
| `paneGrid.ts`（潜在同类） | `entity.layers = [options.layerId]` | 组件数据里带 `layers`；`GridEntityLike` 里**删掉** `layers` 声明 |
| 相机 layers | **循环逐格 `registry.sync`**（后一格把前一格的层抹掉） | `syncPaneLayers()`：一次写全部窗格（HUD + gizmo + 线框 + 逐格投影） |

`addComponent("render", { ..., layers })` 是**引擎自己的写法**（`extras/gizmo/mesh-line.js`：
`entity.addComponent("render", { meshInstances, layers: [layer.id] })`），而且属性顺序帮了忙：
`RenderComponentSystem._properties7` 里 `type` 排在 `layers` 前，先造 meshInstances 再换层。

**修第 4 处是必须的**：它以前被这个 bug **掩盖**着。真实视口（`PlayCanvasViewport`）里
`for (const id of paneIds) registry.sync(...)` 逐格重写 `camera.layers`，最终只有**最后一格**留着
HUD/gizmo/线框层；以前"每格都看得见坐标轴"是因为部件在 World 层。**不修它，改对层归属之后
3 个格子会直接不画坐标轴**（resize 与投影切换那两个 sync 点也只补 HUD 层，同样会抹掉 gizmo/线框）。

**顺带修掉的两处连带缺陷**：
- **线框层是懒建的**（第一次 `set()` 才建），调用方建句柄时 `layerId()` 还是 `null` ⇒ 该层**从来没进过
  任何相机的 layers**。以前只因为"线框留在 World 层"才看得见。新增 `onLayerCreated` 钩子，
  层一建好就补一次 `sync`（`selectionWireframe.test.ts` 钉住"建层那一刻回调一次、且只回调一次"）。
- 探针里 `highlight=1` 单独跑时选中的是写死的 `"member-0"`（那个 id 只在 `multi=1` 时存在）⇒
  像素/盒匹配断言**静默假阴性**（实测 `像素变了=false`）。改成用靶子自己的 id。

### 实测（可见窗口 Chrome 154，`127.0.0.1:5199`，load 5.4）

**页面内自检**（`input=1&picking=1&gizmo=1&multi=1&highlight=1&grid=1&hud=1`，**1/2/4 窗格全绿、零错误**）：

| 断言 | 1 | 2 | 4 |
| --- | --- | --- | --- |
| 每格 HUD 层里的 mesh 数（引擎事实，**期望 12**） | 12 | 12,12 | 12,12,12,12 |
| 建 HUD 没有往 World 层加东西 | ✓ | ✓ | ✓ |
| 层在**每一格**相机里 / 只摘 pane-0 时其它格不变 | ✓ | ✓ | ✓ |
| ±X/±Y 间距（期望 80 px）、退远 3 倍仍 80 | 80/80 | 80/80 | 80/80 |
| **轴色像素：隔离 vs 串层负对照**（见下） | 884/884（不适用） | 884/1258 | 208/628 |
| `startRenderPass` / 帧数 | 1 | 1 | 1 |

**负对照（证明这条像素判据不是空转）**：把 pane-1..n 摆成**正视正交**、pane-0 摆成透视并且
**先摘掉它自己的 HUD**，然后 ① 量 pane-0 的轴色像素数；② 临时把**别格的 HUD 层**塞进 pane-0 的相机
（= 层写错时发生的事）再量一次。实测 **4 窗格：0 → 420**（2 窗格 884 → 1258，差值同样是别格部件），
也就是说"别格的坐标轴出现在本格"这件事被**量化复现**了；修好之后隔离那一次是 **0**。
探针把这条写成**硬判据**（`leakDetectable`）：两次差不开就判红，防止这条检查退化成空转。
轴色判据用"最强通道 > 次强通道 × 1.5"而不是"通道极差"——米色模型 `(180,140,80)` 与青色成员
`(115,199,191)` 的极差都很大，极差判据会把它们算进来（本机踩到：隔离时也读出 855 px，全是场景几何）。

**新增单测 5 条**：`paneAxisHud.test.ts` 里"真实部件工厂：12 个 render 部件每个都带 `layers:[本格层 id]`、
且**没有任何一处写 `entity.layers`**"（假引擎把"写实体 layers"也如实记一笔，断言为 0）
与"换一层就落在新层"；`engineEntityLayers.test.ts` 3 条把上面那组**引擎事实**钉住（引擎升级时会红，
提醒重新确认"层归谁管"，而不是顺手删断言）。

## 三之十、§五.4（第一人称漫游 + 相机飞行）的真实浏览器验证 🧪

两个纯模块 + 两个接线点：

| 模块 | 内容 | 测试 |
| --- | --- | --- |
| `walkRig.ts` | 第一人称的**纯数学**：偏航/俯仰 + WASD 平移 + 高度锁定（对应 three 侧 `FirstPersonRig.tsx`：`WALK_SPEED=3` / `RUN_SPEED=7` / `EYE_HEIGHT=1.6` / Shift 加速 / 单帧 delta 钳 0.1 s） | 10 条 |
| `rigFlight.ts` | 飞行动画：指数阻尼（`DAMP_LAMBDA=4`，与 three `MathUtils.damp` 同式）+ 到位判据（`ARRIVE_DISTANCE_SQ=0.0004`）+ 位姿↔台架互转 | 10 条 |
| `paneInput.animateFocus` | 让宿主接管"聚焦"的写入（否则就是立即到位）——飞行就是靠它挂上去的 | 1 条 |

### 为什么第一人称是**另一份状态**，不往 `CameraRig` 里塞
`CameraRig` 是 turntable（目标点 + 方位角/极角/距离、`up` 固定），表达不了"站在原地转头再走出去"。
第一人称需要**眼睛位置 + 朝向**，所以是 `WalkState`；而 three 侧进入这个模式时本来就不渲染多窗格
（也没有拾取/gizmo），所以它是**全局**的，不像其它输入那样按窗格路由。

### 实测（可见窗口 Chrome 154，`127.0.0.1:5199`）

**页面内自检**（`walk=1` / `flight=1`；与 input/picking/gizmo/grid/hud 一起跑，**1/2/4 窗格全绿**）：

| 断言 | 读数 |
| --- | --- |
| WASD 真的位移、眼睛高度锁 1.6 | 走 **1.00** 单位，`y=1.6` |
| Shift 加速 | 跑 **2.32** 单位（≈2.3×，与 7/3 速度比一致） |
| 鼠标转头（灵敏度 0.002 rad/px，同 three `PointerLockControls`） | +200 px ⇒ yaw **−0.4000** |
| 俯仰钳制 | 猛推 100000 px 后仍 `|pitch| < π/2` |
| 解锁即停且清键 | 通过 |
| 飞行：逐帧收敛、单调、到位 | 采样 **14.039 → 0.021**（单调）→ 吸附到目标；**方位角漂移 0** |
| 飞行途中输入 | 滚轮一下即取消 |
| `startRenderPass` / 帧数 | **240/240**（每帧 1 个 pass，飞行/漫游都不额外开 pass） |

**CDP 可信事件**（`.tmp/pc-panes/drive-input.mjs`，4 窗格，**34 条断言全过、退出码 0**）新增：

| 断言 | 读数 |
| --- | --- |
| 真实双击 → **逐帧收敛** | 到目标误差 **8.282 → 1.710 → 0.0000**（91 步） |
| 飞行最终落到 `fitDistance` 且自己收手 | `distance=11.6913`（期望 11.6913） |
| 真实按键 W 前进 / Shift+W 更快 | 走 **1.550** vs 跑 **3.497**（2.26×，与 7/3 一致） |
| 真实鼠标移动转头 | yaw **−0.4000 → −1.0800**（340 px × 0.002 = 0.68 rad，逐位吻合） |
| 退出锁定后按键不再移动相机 | 通过 |

### 两个新踩到的点（都写进 AGENTS 了）

1. **指针锁定必须挂在 `pointerdown` 上，不能挂 `mousedown`**：本层在 `pointerdown` 上
   `preventDefault()`，浏览器就不再派发兼容的 `mousedown`（§三之六实测过）——挂 `mousedown`
   等于**永不触发**。这个缺陷页面内自检抓不到（合成事件本来就拿不到锁定），是可信事件那一轮抓到的。
2. **本沙箱里指针锁定无法验证**：Chrome 直接拒绝，`WrongDocumentError: The root document of this
   element is not valid for pointer lock.`——自动化开的窗口没有拿到 OS 级焦点（
   `Emulation.setFocusEmulationEnabled` 让 `document.hasFocus()` 为真也不够）。
   所以可信那一轮的判据改成"**handler 确实被触达**"（失败原因本身就是证据），锁定之后的按键/鼠标
   路径用探针的 `forceLock` 走真实按键事件 + 真实鼠标移动来验。**"锁定权限本身"在这个环境里未核实。**

### 探针方法论再补一条
**自检之间会互相打架，接线动画时尤其明显**：输入自检的双击会起一条飞行动画，而飞行器每帧都会
`apply`——后续每个"自己摆已知机位"的自检都会被它拉回插值轨迹（实测让 picking/grid/hud 的像素与
台架判据全挂）。现在的约定是：**任何要摆已知机位的自检，先 `flight.cancel()`**；输入自检结束时也取消
它自己起的那条。另一条相关但**不是缺陷**：`focus()` 的目标位姿是从**当前**台架算的，所以"飞行途中再聚焦"
会从半路重新瞄准——第一版自检拿一个过期的目标去比，位置误差永远停在 1.4。

### 🔴 没做的
- **模式的进入/退出**（three 侧由 `Viewport` 的 state 切换、进入时不渲染窗格/拾取/gizmo）：属于 §五.5 集成。
- 锁定失败的 UI 提示（three 侧靠 `PointerLockControls` 的 selector，没有额外提示）。
- 碰撞与重力：three 侧也没有（就是高度锁定的自由漫游）。

## 三之十一、§五.2 集成层余项（多选整体变换）的真实浏览器验证 🧪

三个新模块 + 一处接线改动：

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `playcanvas/selectionTransform.ts` | 多选**集成层数学**：轴心口径、冻结 `pivot⁻¹·member`、`pivot.matrix·relative` 还原、拖拽生命周期状态机 | 17 条 |
| `playcanvas/panePlacement.ts` | 实体 ↔ 摆放适配（只走四元数） | 3 条 |
| `paneInput.animateFocus`（上一项） | — | — |

### ⚠️ 这一节最重要的一条：**引擎的欧拉 API 与 three 不是同一套约定**（两个维度都不同）

本机实测（`selectionTransform.test.ts` 里用 **three 当真值**逐元素钉住）：

| | three（`scene.json` 里摆放的约定） | PlayCanvas 引擎 |
| --- | --- | --- |
| 单位 | **弧度** | **角度**（`quat.js:88` 的 `mulScalar(RAD_TO_DEG)`；`Mat4.setFromEulerAngles` 里 `ex *= DEG_TO_RAD`） |
| 顺序 | **XYZ** | **ZYX**（`pc.Mat4.setFromEulerAngles(x·RAD2DEG, …)` 与 three 的 `Euler(x,y,z,'ZYX')` 差 **2.7e-8**，与 `'XYZ'` 差 **0.43–1.73**） |

结论：**拿摆放三元组直接喂 `setFromEulerAngles` / `setEulerAngles` / `getEulerAngles`，一定会静默转错朝向**
（不报错、不崩，只是模型转错了；两个维度都错，所以连"看起来差不多"都不会）。所以这一层：

- 欧拉 ↔ 四元数**自己写**（`quatFromEulerXyz` / `eulerXyzFromQuat`，three 的公式）；
- 实体读写只用四元数（`panePlacement.ts`：`getRotation()` → `eulerXyzFromQuat`；`quatFromEulerXyz` → `setRotation`）；
- 其余（乘、逆、TRS、分解、点变换）用引擎的 `Mat4`/`Quat`/`Vec3`，不重复造矩阵库；
- 单测把**同一位姿在两套引擎里必须得到同一个矩阵**钉住（阈值 1e-6）。

另一条精度事实：**引擎的 `Mat4.data` 是 `Float32Array`**（`mat4.js:11`），往返误差 **1e-7 量级**，
所以判等阈值不能写 1e-9（第一版就是这么假失败的）。

### 轴心口径（与 three 侧逐项一致）
- **单选**：pivot = 该成员自身的摆放（位置/旋转/缩放）⇒ gizmo 落在物体原点上、相对矩阵是单位阵。
- **多选**：pivot.position = 各成员**位置**的包围盒中心，旋转归零、缩放归一（一组朝向各异的对象
  没有共同的"自身轴"）。

### 实测（页面内自检，1/2/4 窗格全绿）

| 断言 | 读数 |
| --- | --- |
| 轴心 = 各成员位置包围盒中心 | ✓ |
| 单选时轴心落在物体自身摆放上 | ✓ |
| 一次整体平移：三个成员**同一位移** | Δ=**1.5, −0.75, 0**（与下达值逐位一致） |
| 画面确实变了（写进了实体） | ✓ |
| 一次拖拽**只提交一次**、带三个成员 | ✓（1 次 / 3 项） |
| 松手后实时表清空、控制器收手 | ✓ |
| 绕轴心整体旋转 90°（Y） | ✓ 每个成员相对轴心的偏移满足 (x,y,z)→(z,y,−x) |
| 引擎 gizmo 确实挂在**轴心实体**上 | ✓ |
| `startRenderPass` / 帧数 | **240/240** |

### 两处踩到的坑（自检自己的，记下来免得重犯）
1. **`begin()` 冻结的是"控制器当前轴心"的相对矩阵**：平移之后不 `reset()` 就直接 `begin()`，
   冻结出来的相对矩阵对应的是旧轴心，成员会被摆到错的位置（第一版整体旋转判据就是这么假失败的）。
2. 绕 Y 轴旋转的判据不能用"三维夹角 ≈ 90°"：成员的偏移带 Y 分量，绕 Y 转时那部分不变，
   三维夹角根本不是 90°。要用解析式 (x,y,z)→(z,y,−x)。

### ✅ 可信驱动里的"指针 → 手柄 → 轴心 → 成员"这条链（**先红的，已修正**）

先记下这一段的**错误结论与真正的原因**（免得以后有人去找不存在的引擎 bug）：

- 第一版我写的是"引擎报 `dragging: true`、`attached: true`，但**轴心实体位置不动**，根因未定位"。
  **两条都是我的错**：
  1. **接线根本没生效**：我用来把控制器接到 `onDragStart/onDragEnd` 的那次文本替换**静默没匹配上**
     （`str.replace` 锚点过期就是个空操作，我没有断言）。于是引擎确实在拖轴心实体，而
     `selection.begin()` 从未被调用 → 控制器不 active → 成员不跟随、也不提交。
  2. **诊断读错了对象**：`api.multiPivot()` 返回的是**控制器内部那份** `pivot()`（只由 `reset/update` 写），
     拿它当"实体动了没有"的证据必然读到旧值。要读**实体**（`readEntityPlacement(pivotEntity)`）。
     这一条已经补成 `multiPivotEntity()` 活口。
  ≤教训：**探针里的接线改动要用断言过的替换，并在跑之前确认改动真的落地**；诊断量要选"能证伪的那一个"。≥

修好之后（`.tmp/pc-panes/drive-multi.mjs`，4 窗格，**9 条断言全过、退出码 0**）：

| 断言 | 读数 |
| --- | --- |
| 手柄能被引擎自己的 hover 命中 | `fraction=0.2 hover=head:x` |
| 拖动时引擎确实在拖轴心实体、输入层让出手势 | `dragging=true, attached=true, starts=1`，`active=null` |
| **三个成员一起走且位移相同** | Δ=**3.620/0.000/0.000**（三个成员完全一致） |
| **一次拖拽只提交一次、带三个成员** | 提交 2 → 3，`{"mode":"translate","ids":["member-0","member-1","member-2"]}` |
| 拖手柄期间相机台架没动 | `azimuth −0.6545 → −0.6545` |

### 第一人称相位会污染后面的相位（已修，值得记）

`walk` 在**探针建立时**就调 `applyWalk()` 把 pane-0 的**相机实体**搬到漫游起点，而它不走台架——
于是"实体位置 vs `rigs`"不一致，后面的可信相位（拖动改方位角、拾取命中、轴球命中）全部失效
（实测主驱动 **10 条红**，第一人称自检在 2 窗格还偶发假失败）。修法是**漫游自检结束时按台架把相机写回去**
（`rigFefore = rigs.get("pane-0")` → 结束时 `applyRig`）。修好后主驱动 **34/34、退出码 0**，
八套自检一起跑 1/2/4 窗格全绿。

## 三之十二、选中/悬浮线框 + G/R/S（§五.2 余项）🧪

| 文件 | 内容 | 测试 |
| --- | --- | --- |
| `selectionBounds.ts` | 线框纯数学：三态、外扩 2%、单位立方体 12 棱、任意盒顶点 | 7 条 |
| `selectionWireframe.ts` | 引擎绑定：持久 line 网格 + 独立层（`clearDepthBuffer` 等价 `depthTest=false`）+ **不可拾取** | 5 条 |
| `transformKeys.ts` | G/R/S 纯契约（四道闸门，与 three 侧 `index.tsx:570-586` 逐条对齐） | 5 条 |

### 与 three 侧逐项对齐的语义
- **三态只影响线框**：none 不画、hover 透明 0.35、selected 实（不碰模型自身材质）。
- **白色 `#ffffff` + 外扩 2% 最大边长**（避免与模型共面 z-fighting）。
- **线框不参与命中**：three 侧那段长注释解释得很清楚（LineSegments 的 `Raycaster.params.Line.threshold`
  会沿 12 条棱各撑出一层隐形命中壳 → 悬浮进出不是同一条边界、相邻模型的点击被截走）。
  这里对应的是 `meshInstance.pick = false`，自检直接断言"可拾取实例数 = 0"。
- **G/R/S 四道闸门**：① 输入框/contentEditable 里不抢键；② 带 meta/ctrl/alt 不管；
  ③ 没有选中不管；④ 第一人称不管。世界/局部不是快捷键，是工具栏按钮（`toggleSpace`）。

### 实测（`drive.mjs <url> <n> "...&highlight=1"`，1/2/4 窗格）
| 断言 | 读数 |
| --- | --- |
| 盒 = 被选实体世界包围盒外扩 2% | ✓ 逐分量吻合 |
| **可拾取实例数** | **0** |
| 可见时画面真的变了（像素） | ✓ |
| 悬浮/选中的透明度 | 0.35 / 1 |
| G/R/S → 模式 | `rotate, scale, translate`（按 r/s/g 顺序） |
| 在 `<input>` 上派发 keydown 不抢键 | ✓ |
| `startRenderPass` / 帧数 | 240/240 |

### 顺带修掉一个**真 bug**（之前没有被任何代码调用到）
`panePicking.entityWorldBounds()` 读的是 `aabb.center[0]`，而引擎的 `Vec3` **只有 `.x/.y/.z`、没有数字下标**——
一路静默成 `undefined`/`NaN`（选中线框因此完全不显示）。两处一起错所以一直没暴露：
① 实现读 `center[0]`；② **测试里的假数据也写成元组** `[1,2,3]`，于是测试通过、真机必错。
修法：实现读 `.x/.y/.z`；`MeshInstanceLike` 的 aabb 类型**如实建模成 `EngineVec3Like`**（只有 x/y/z），
这样以后写 `center[0]` 会直接编译不过；两处假数据改成引擎形状，并加"每个分量都是有限数"的断言。

### 主可信驱动的回归：**已解决**（两层原因都在探针/自检这侧）

第一版记的是"未定位"，现在查清并修好了，**两条原因都不是引擎缺陷**：

1. **探针把每次点画布都当成"进入第一人称"**：漫游模式一直开着，它的 `pointerdown` 监听**无条件**
   请求指针锁定。可信驱动点的第一下就是**用户手势**，锁定一旦被批准，`pointerlockchange` 就把
   `walkLocked` 置真，**漫游 tick 从此每帧改写相机** → 后面所有相位（拖动/拾取/轴球/逐格隔离）全废。
   这也解释了**时有时无**：这个沙箱平时拒绝锁定（`WrongDocumentError`），偶尔批准，就把整轮打成 20/24。
   修法：① 探针改成**显式备好**才请求（`__PC_WALK__.armLock(true)`）——产品里第一人称本就是显式进入的模式；
   ② 驱动开工时 `suspend()` 漫游（停 tick + 解锁 + 清键），只在第一人称那一段 `resume()`。
2. **自检里合成的 `keydown` 没配对 `keyup`**：高亮自检按 G/R/S 验证模式切换，只发 `keydown`，
   于是 's' 一直留在按键集合里；后面的第一人称自检里 `forward = w − s = 0`，表现为
   **漫游一步都不走**（`走 0`、`steps 0`）。诊断读数 `keys=['r','s','g','w']` 直接坐实。
   修法：合成按键**成对发**，并在 walk 自检里把"按住期间/若干帧后的按键集合 + tick 步数"记进报告。

另外驱动开局加了一条**前置断言**：`resetCameraState()` + **反复重写直到 `camera == rigPosition(rig)`**
（最多 5 次），不再让十几个相位建在"相机实体与台架不一致"的状态上。

**结果：连续三轮 `35/35`、退出码 0**（34 条原有断言 + 新增的"开局一致"断言）。
多选那条 `drive-multi.mjs` 也仍是 **9/9**。同轮 9 套自检一起跑，1/2/4 窗格**全绿**。

## 三之十三、真实 splat 上的拾取（`gsplat.enableIds`）🧪

`playcanvas/panePicking.ts` 的注释里一直写着"splat 要先 `scene.gsplat.enableIds = true`"，
但那条**只在合成/模型路径上验证过**。这一轮补上真实资产。

### 判据为什么必须是**负对照**，而不是"能选中"
只测"能选中"的话，把 `enableIds` 写成恒真也能过。所以自检比对**同一投影点**在
"开着 / 关掉"两种状态下的结果：**开着必须是 gsplat 命中，关掉必须选不中**。

### 实测（`drive.mjs <url> 1 "asset=<spz>&picking=1"`，真实 SPZ v4）

| 资产 | 点数 | `enableIds` 默认值（实测） | 开着 | 关掉 | pass/帧 |
| --- | --- | --- | --- | --- | --- |
| `.tmp/pc-assets/world-150k-v4.spz` | 150 000 | **false** | `{name:"world", kind:"gsplat"}` | `null` | 1.004 |
| `.tmp/pc-assets/world-full-res-v4.spz` | **1 920 000** | **false** | `{name:"world", kind:"gsplat"}` | `null` | 1.004 |

两点值得记下来：
- **`enableIds` 的默认值 `false` 是实测的**（不是从注释抄的）——这正是"splat 永远选不中"那个静默失败的根。
- 载入真实 splat 时场景里没有那几个盒子/靶子，所以 **mesh 那条拾取自检不适用**；
  `pickingOk` 在这种模式下由 `splatReport` 接管（否则会整体假失败）。

## 三之十四、§五.5 第一块：资产 → 实体（`assetScene.ts`）🧪

`§五.5`（把渲染层真正接进应用）缺的第一块**可复用件**：此前"加载 GLB / 加载 splat"的写法
只存在于 dev 探针 `panes.browser.ts` 里，应用侧要复用它必须先有人把它抽出来。

`playcanvas/assetScene.ts`（**6 条测试**）：一件资产一个实体，`sync(specs)` 幂等对齐
（新增的加载、缺的销毁、已有的**只更新摆放不重建**、URL 变了才重建）；摆放只走四元数
（`panePlacement`）；单件失败不打断其它；`dispose` 之后不再复活。三条约束都来自既有踩坑记录：

- **GLB 用 `assets.loadFromUrlAndFilename(url, "model.glb", "container", cb)`**（引擎示例
  `viewer.example.mjs:450` 的写法）：`new Asset(name,"container",{url})` + `AssetListLoader`
  拿到的 `instantiateRenderEntity()` 是**空树**；而且**失败在回调的 `err` 里**，只监听 `error` 事件会漏。
- splat 走 `Asset(..., "gsplat", { url })` + `AssetListLoader` + `gsplat` 组件（资产必须是 SPZ v4）。
- 摆放写回**只用四元数**（引擎欧拉是角度 + ZYX，摆放是弧度 + XYZ）。

### 实测
| 断言 | 读数 |
| --- | --- |
| 单测（幂等/移除/换代/失败隔离/销毁/摆放矩阵一致） | **6/6** |
| 真机：同一份真实 **150k SPZ** 通过它挂一遍 | 挂上 `["probe-splat"]`、**摆放逐分量一致**、dispose 后 `entry()` 为空 → `ok:true` |
| 真实 splat 拾取（§三之十三）同轮 | 150k 与 1.92M 均通过（负对照） |

### §五.5 的进度与下一步（按依赖顺序）

**增量 1 —— 代码已落地，真机验证待做**：
1. ✅ **`widgets/Viewport/PlayCanvasViewport.tsx`**：接受**同一份 `ViewportProps`**（`index.tsx` 里
   只把接口加了 `export`，**字段一个没改**）＋可选 `layout`。内部用本层模块拼装：
   `useRendererSession`（设备/app 生命周期）+ `createEnginePaneBindings` + `PaneRegistry`
   + `cameraRig.applyRig`（台架 → 相机）+ `paneGrid` + `paneAxisHud` + `paneInput` + `panePicking`
   + `assetScene`/`viewportSceneSpecs`（模型资产）。
   **单窗格 + 模型**这条最小可用路径：轨道/滚轮/右键平移/双击聚焦、点击拾取 → `onSelectAsset` /
   `onClearSelection`。层 id 按约定进 `PaneSpec.extraLayerIds` 再 `sync`；资源清理在
   `useLayoutEffect` 里配对释放（见 `useRendererSession` 文件头）。
2. ✅ **切换开关**：`widgets/Viewport/index.tsx` 是**非冻结**的（`pages/` 才是冻结集），
   现在按 `?pcViewport=1` 在组件顶部整体分流到 PlayCanvas 版；**默认仍是 three**，
   `pages/AppDashboard` 一行没动。
3. ✅ **真机验证已做**（专用探针页 `app/pc-viewport.html` + `viewport.browser.tsx`，同 `*.browser.ts` 那批、
   **不进生产包**；驱动 `.tmp/pc-panes/drive-viewport.mjs`）。判据：挂载成功 / 无致命覆盖层 /
   画布非黑 / 拖动改变像素 / 点击走到拾取回调 / 零 JS 错误。

   | 轮次 | 画布 | 亮像素（>14 亮度） | 拖动后 | 点击 | 错误 |
   | --- | --- | --- | --- | --- | --- |
   | 空场景 | 1400×715 | **7 175** | 7 512 ✓ 变 | `clear` ✓ | 0 |
   | 真实 GLB（`ClearCoatTest.glb`） | 1400×715 | **24 141** | 44 183 ✓ 变 | `clear` ✓ | 0 |

   模型那一行是关键：空场景与挂模型**亮像素差 3.4×**，说明 `assetScene` 那条路真的把模型加载并渲染出来了。
   **没确认的**：点击**选中模型**（只证到"点击 → 回调"，选中/清空共用同一条回调路径；
   拾取本身的正确性在探针里有大量断言）。
4. 🐛 **真机抓到的两个装配缺陷（都已修，值得记）**：
   - **关键尺寸不能依赖宿主 CSS**：组件原来只用 Tailwind 的 `h-full w-full`，探针页没引入样式表 →
     画布停在元素默认的 **300×150**，整屏黑、零报错。改成**内联样式**兜底（宿主 CSS 只负责外观）。
   - **`RendererSession` 不会启动渲染循环**：它只建/销毁设备与 app（提供 `stopLoop()` 取消 rAF），
     **必须调用方 `app.start()`**——漏了的症状同样是"挂载成功、无报错、画布全黑"。
5. ✅ **增量 2（变换 gizmo + 多选整体变换 + `live` + `onTransformCommit` + 选中线框）也已真机验证**：
   同一驱动加 `--select`（探针入口按 `?select=1` 把资产全部选中）：

   | 断言 | 读数 |
   | --- | --- |
   | 轴心投影到屏幕（`pivotScreen`） | (700.0, 416.9) |
   | **引擎自己的 hover 判定**找到 +X 手柄 | `{x:720, y:419.9, axis:"x"}` |
   | 拖动后像素变化 | 25 188 → 25 873 |
   | **`onTransformCommit` 收到提交** | **3 条，每条 `{ids:["probe-model"], mode:"translate"}`** |
   | JS 错误 | 0 |

   也就是说"**可信指针 → 手柄 → 控制器（冻结相对矩阵）→ 成员实体 → 写 `live` → 松手提交一次**"
   整条链在真实组件里跑通了；提交的键是**资产稳定 id**、模式是 gizmo 的 mode（撤销栈文案要用）。
   **没确认的**：`live` 被右侧栏订阅后"数字跟着手走"（需要业务页面里的栏），以及撤销/重做按钮（UI 在应用工具栏）。

6. 🐛 **增量 2 又踩到两个坑（都已修）**：
   - **资产是异步挂上的，而 gizmo/控制器那个 effect 同步跑在它前面**：那一刻 `members()` 还是空集
     → 轴心为 null → 手柄无处可挂（症状：`pivotScreen()` 恒为 null、怎么拖都不动）。
     修法：**资产就绪后再复位一次**轴心与线框。
   - **没选中东西时 gizmo 仍然挂着**（引擎的 `enabled` 只看 `nodes.length > 0 && 距离>eps`）→
     手柄照样画、照样**抢点击**（症状：点空白既不清空选中也不触发拾取）。修法：`attach(null)` 摘掉。
     推论：**有选中时点击被手柄认领是正确行为**（"点手柄不该变成选中"），所以驱动在有选中那轮
     不该要求"点击走到拾取回调"。
   - 驱动器本身也踩了一次时序坑：**睡固定时长后抓快照会抓到全黑**（首帧/资产加载耗时不定），
     改成"**轮询到非黑**再取样"。

7. ✅ **增量 3（G/R/S 切变换模式）也已真机验证**（`transformKeys` 的四道闸门按契约接进组件）：

   | 断言 | 读数 |
   | --- | --- |
   | 真实按键 `r`→`s`→`g` 的模式序列 | `translate → rotate → scale → translate` |
   | **打字闸门**（聚焦 `<input>` 后按 `r`） | 模式**不动**（仍是 `translate`） |
   | 同轮 gizmo 拖动 | 仍提交（2 条）、+X 手柄 hover 命中、零错误 |

   用的是 CDP **可信按键**（`Input.dispatchKeyEvent`），不是页面内合成事件；键位表外的按键**不
   `preventDefault`**（否则会把别的快捷键吃掉）。

8. ✅ **增量 4（1/2/4 多窗格）也已真机验证**：逐格像素视口（1 = 整块 / 2 = 左右各半 / 4 = 2×2 象限，
   与 `LAYOUTS[4]` 的 DOM 顺序一致）+ 逐格相机/台架/HUD 层/gizmo（层 id 逐格进 `extraLayerIds`）。
   判据是**快照的四象限亮像素**（每格都必须各自有内容）：

   | 布局 | 总亮像素 | 四象限 | 点击 | 错误 |
   | --- | --- | --- | --- | --- |
   | 1 格 | 24 141 | `[11894, 5598, 3678, 2971]` | `clear` ✓ | 0 |
   | 2 格 | 43 686 | `[16810, 16810, 5033, 5033]`（左右**对称**） | `clear` ✓ | 0 |
   | **4 格** | 31 578 | **`[7895, 7895, 7894, 7894]`**（四格几乎完全相同） | `clear` ✓ | 0 |

   四格那一行是最强证据：**4 台相机各自渲染出同样内容的 1/4 画面**，说明逐格 rect、逐格相机与
   逐格 HUD 层都真的生效了（只画一格、或 rect 全一样，这一行都会明显不齐）。

9. ✅ **增量 5（逐格机位预设）也已真机验证**：`paneRigPresets.ts` 把 `CameraKind` 映成台架
   （`top` / `front` / `right` 是**正交轴测机位**，`perspective` 是总览机位），轴向约定由
   **5 条单测钉住**（`rigDirection` 的解析式：front → +Z、right → +X、top → +Y）。

   | 断言 | 读数 |
   | --- | --- |
   | 逐格相机状态（诊断口 `__PC_VIEWPORT_CAMERAS__`） | `top(0,12.8,0) ortho 7.5` / `persp(6.98,5.7,8.44) persp` / `front(0,0.8,12) ortho 7.5` / `right(12,0.8,0) ortho 7.5` |
   | 4 格四象限 | `[2263, 7921, 8516, 633]`（**各格机位不同**：没接预设时是 `[7895,7895,7894,7894]`） |
   | 俯视格（网格正面）亮像素 | **2263**（> 1500 的判据） |
   | 1 格回归 | `ok: true`（透视格不受影响） |

10. 🐛 **增量 5 抓到的两个真缺陷（都已修）**：
   - **俯视格的 up 必须传 `[0,0,-1]`**：正上方时视线与默认 up `(0,1,0)` 共线，`lookAt` 退化
     → 相机朝向是垃圾 → 那一格几乎全空（实测只剩 **94** 个亮像素，看着像"这一格坏了"）。
     `cameraRig` 早就导出 `ORTHO_UP`，接的时候漏了。
   - **`paneRegistry` 的 `orthoHeight` 默认值是像素半高**（`pane.viewport.height`），
     与 `cameraRig` 的"世界单位半高 7.5"是**两套约定**：正交格会"看得极远"（15 世界单位变成
     357.5/715），画面里只剩一个小方块。实测俯视/前视/右视三格分别只有 94/672/62 个亮像素。
     改成 `orthoHalfHeight()` 后是 2263/8516/633。**已加回归测试**（13 条，含"显式给值仍按给的"）。
     这条也说明：`camera.orthoHeight` 的**单位**在本仓库只有一个真源（`cameraRig.ORTHO_VIEW_WORLD_HEIGHT`）。

11. ✅ **增量 6（最小工具栏）也已真机验证**：`PlayCanvasViewport` **自带**一个工具栏
   （布局 1/2/4、网格开关、撤销/重做），用的是与 three 侧**同一套 `aria-label` 文案**，
   按钮用**内联样式**（探针页没有样式表——增量 1 的教训）。

   为什么长在组件里而不是抽公共组件：**布局与网格显隐是视口自己的状态**，这样三处都不必动
   three 分支那一大段 hooks 与 JSX——**默认路径零风险**。

   | 断言（CDP 可信点击） | 读数 |
   | --- | --- |
   | 点「Four views (Blender layout)」 | `fourClicked: true`，四象限 `[2263, 7921, 8516, 864]`（各格有内容，含逐格预设） |
   | 点「Hide grid」 | `gridDropped: true`（亮像素真的变少） |
   | 点「Single view」 | `oneClicked: true`（切回单格） |
   | 同轮 gizmo 提交 / G/R/S | 仍各 2 条提交、模式序列正确、**零错误** |

12. ✅ **增量 7（透视/正交切换）也已真机验证**：单窗格时工具栏出现「投影」按钮（与 three 侧
   同 `aria-label`）。切换要**同时改三处**——台架（`rig.projection`）、相机（`applyRig`，正交时
   还要配对 up）、以及 `registry.sync`（`sync` 会重写 `camera.projection`，只改前两处会被它盖回去）。

   | 断言（可信点击） | 读数 |
   | --- | --- |
   | 相机 `projection` | **`[0, 1]`**（透视 → 正交） |
   | 切换后画面亮像素 | 28 452（仍非空） |
   | 同轮其余（4 格切换 / 网格开关 / 回单格 / gizmo / G-R-S） | 全过，**零错误** |

13. ✅ **增量 8（线框着色 / `Shift+Z`）已真机验证**。一条**引擎行为发现**是这次的关键：
   **PlayCanvas 的线框不是材质标志位**——`StandardMaterial` 上**没有** `wireframe`，要走
   `meshInstance.renderStyle = RENDERSTYLE_WIREFRAME`（引擎为每个 mesh 备了线框索引缓冲，
   setter 里 `mesh.prepareRenderState()` 会挑对那份）。纯逻辑在 `wireframeShading.ts`
   （遍历实体树 + 记账换/还，**5 条单测**，其中一条专门钉"连开两次再关"的记账陷阱——
   不守住原值的话关掉后就永远回不去）。

   | 断言（可信点击 + 可信 `Shift+Z`） | 读数 |
   | --- | --- |
   | 开：状态与引擎事实 | `wireframe: true, found: 27, applied: 27, styles: [1,1,1,1]` |
   | 亮像素（线框把实体面换成棱） | **28 452 → 13 010**（掉到 46%） |
   | `Shift+Z` 关 | 样式全回 `0`，亮像素**一模一样地回到 28 452** |
   | 按钮文案 | `Wireframe shading (Shift+Z)` ↔ `Solid shading (Shift+Z)` |
   | 同轮其余 | 全过，**零错误** |

   **一次假失败值得记**：第一版判据写成"亮像素必须降"，而且"点回去"那一下没落到按钮上
   （`wireframeClickedBack: false`）→ 整条报 false。**判据要盯引擎事实**（状态 + 有多少个 mesh
   真的被切了 + 关掉后能否复原），而不是猜像素往哪边走；关的动作改用 `Shift+Z` 顺带把快捷键也验了。

14. ✅ **增量 9：真实业务页面验收通过**（这是最强的一条——前面八轮验的都是"同一组件 + 探针合成 props"，
   这一轮走的是**应用的页面、门禁、真项目数据与真 props**）。

   驱动：`.tmp/pc-panes/drive-app.mjs <baseUrl> <slug>`（照 `gpu-probe.mjs` 的配方**开局就调应用自己的
   `passAccessGate()`**，然后容忍一次重载、轮询到视口出现）。命令：
   `node .tmp/pc-panes/drive-app.mjs http://127.0.0.1:5199 p-muo3u17c`
   （项目数据在 `~/ChatSpace/projects/*`，chat 服务在 `127.0.0.1:3901`）。

   | 断言 | 读数 |
   | --- | --- |
   | URL | `/app/p-muo3u17c?pcViewport=1`（`?pcViewport=1` 分流生效） |
   | PlayCanvas 视口挂载 | ✓ `[data-pc-viewport="1"]`，画布 1470×715 |
   | 画面非黑 | mean 13.819、**7 424** 个亮像素 |
   | **PC 工具栏在真实页面上** | 页面文本含 `1 2 4 投影 线框 网格 撤销 重做` |
   | 应用自己的面板与资产列表 | `Default skybox` / `花岗岩花盆紫粉色兰花 GLB · model` / …（真项目资产） |
   | 致命覆盖层 / JS 错误 | **无 / 0** |

   **这一轮也踩了一个自己的坑**：驱动第一版把解锁写成"只有读不到状态时才调门禁"，
   而门禁页**读得到**状态（`pc:false`）→ 那一步从没执行 → 三轮空转。
   正确写法是**开局就调**（幂等），再容忍重载、轮询视图。

   **仍未在真实页面上验的**：交互（选择/gizmo/拖拽/快捷键）只在探针页验过；截图/检查图/材质覆盖/第一人称这条分支还没有。

   ### 增量 9 后续：真实页面上抓到三个缺陷（两个已修，一个未决）

   这一轮把"资产真的能加载"当作判据之后，探针合成 props 掩盖的东西立刻现形——**三条都只在真实页面上出现**：

   1. ✅ **资产 URL 必须过应用自己的 `libraryUrl()`**。`LibraryAsset.modelPath` / `spzPath` 是**逻辑路径**，
      直接 fetch 会命中 Vite 的 SPA 回退、拿到 `index.html`；引擎报的原话是
      `Invalid magic number found in glb header. Expected 0x46546C67, found 0x6f64213c`
      ——**那四个字节就是 `<!do`**（`<!doctype html>`）。修法：`viewportSceneSpecs` 收一个
      `urlFor(logicalPath)`（调用方传 `libraryUrl`），纯函数仍旧不认识应用 API。已加单测
      （"urlFor 必须作用于每一个规格，模型与世界都算"）。
   2. ✅ **资产 effect 不能依赖"每次渲染都换身份"的 props**。`props.assets` 每渲染可能是新数组，
      放进依赖 → effect 每渲染重跑 → 每次新建再 dispose 上一个 → 网络稍慢就**永远挂不上**
      （真机症状：`ids: []`）。修法：按内容算一个稳定签名（id + 路径 + 修订号 + 世界 + 摆放），
      effect 只依赖它。
   3. ✅ **加载器会永久挂起 → 已加超时**。真实页面上 `sync` **卡在第一个模型**上——引擎的 container
      加载在那种响应下**既不给回调也不报错**，`await sync` 永不返回（诊断里 `ids`/`specIds` 一直缺席）。
      修法：`assetScene.ts` 给两处加载都套 `withTimeout`（`LOAD_TIMEOUT_MS = 8_000`，超时按
      `onError` 报出来，`sync` 才能继续处理别的资产）；原始错误**照原样透传**，超时不掩盖真错误。
      4 条单测：正常返回 / 一直不回调必超时 / 原错误透传 / `sync` 把超时当 `onError` 且其余照旧。
   4. 🐛 **驱动自己也有一个坑（值得记）**：资产 `sync` 是异步的（每件失败资产还要等 8 s 超时），
      而驱动在**视口一挂载就读** `ids`/`specIds` → 读出 `0` / 缺席，看着像"资产根本没挂"。
      改成**轮询到规格列表出现**再报之后，真实页面立刻给出真相：**挂上 10 件**（项目的真模型资产）。

   **修好 1–3 之后的真实页面读数**：视口挂载 ✓、**挂上 10 件真实模型资产** ✓、零 JS 错误 ✓；
   `errors` 里**只剩一条**，就是下面那条世界资产的阻塞（不是视口的锅）。

   ### 🔴 另一条阻塞（不是视口的问题，是资产产物）

   真实项目的 world 是 **legacy SPZ**（`0-world-500k.spz` 头部 `1f 8b 08 00` = gzip），而引擎解析器
   **只认 v4**。修好 URL 之后真机给的原话是：
   `No parser found for resource: http://127.0.0.1:3901/api/library/projects/p-muo3u17c/assets/world/0-world-full-res.spz`。
   **所以"真实业务页面能看见世界"这件事，卡在资产产物必须转成 v4**（`@playcanvas/splat-transform`，
   文档早写过），不是视口侧能解决的。探针里用转好的 `.tmp/pc-assets/*-v4.spz` 是能加载并拾取的（§三之十三）。

15. ✅ **增量 10（检查图 / agent 的 `inspect`）已真机验证**：`ViewportProps.inspection` 一来就调
   `captureInspectionSheet(app, {center, radius})` 拍一组四视角 PNG，回传 `onInspectionCaptured(id, png)`；
   失败回 `null`（**别让 agent 干等**）。**同一个请求 id 只拍一次**（否则每次渲染重拍、agent 收到一堆重复图）。

   取景：`asset` 用选中资产的世界包围盒；`scene` 用所有已挂资产的并集（空场景退化成原点 + 最小半径）。

   | 断言（探针 `--inspect`） | 读数 |
   | --- | --- |
   | 回调回传 | `{id:"probe-inspect", bytes: **60528**}`（四视角合成图，PNG base64） |
   | JS 错误 | 0 |

   又踩了一次**同一个形状陷阱**（文档里早有）：`entityWorldBounds()` 返回的是**引擎 `Vec3`**（`.x/.y/.z`），
   而 `Bounds3` 是 `{min, max}` 元组、取中心/尺寸要用 `boundsCenter`/`boundsSize`——两种形状混读必然编译不过
   （这次是 TypeScript 拦住的，不是运行时）。

16. ✅ **增量 11（材质覆盖 / `props.materials`）**：`materialOverride.ts`（**6 条单测** + 引擎侧贴图加载器）
   把右侧栏改过的贴图槽位写进模型材质。两处**语义不同、同名互喂必然画错**的槽位（引擎已核实）：
   - `roughnessMap` → **`glossMap` + `glossInvert = true`**：引擎的 gloss 是光滑度（roughness 的补），
     glTF 导入的材质会把 `glossInvert` 置真表示"glossMap 里存的是 roughness"（`playcanvas.d.ts:17666-17670`）；
     不置这个标志，粗糙/光滑对调（有光照才看得出）。
   - `alphaMap` → `opacityMap` + **`opacityMapChannel = "g"`**（three 默认读绿通道，引擎默认读 alpha）。
   记账表**只记第一次的原值**（同线框那条陷阱），还原时连附加标志一起还。

   **又踩了同一族第三次**：材质 effect（同步）跑在资产 effect（异步）前面，那时 `ids()` 还空——
   "什么都没做、也不报错"（实测 `ledger: 0`）。修法：加一个 `mountedIds` 状态，挂载完成后置上，
   依赖它的 effect 再跑一次（**gizmo 轴心、线框、材质覆盖都是这一族**，已写进硬约束）。

   | 断言（探针 `--material`，覆盖 `map` → `/env/sky.jpg`） | 读数 |
   | --- | --- |
   | 记账的材质数 / **真的被改的材质数** | **19 / 19**（GLB 的 19 个材质全写上了覆盖） |
   | 画面亮像素 | 44 183 | 
   | JS 错误 | 0 |

17. ✅ **增量 12（第一人称）已真机验证**。机制在探针里早验过（`walkRig` 10 条单测 + 驱动漫游相位），
   这一轮把它接进产品组件。三条约束：
   - **请求指针锁定挂在 `pointerdown` 上**（本层 `preventDefault` 会抑制兼容 `mousedown` → 挂 `mousedown` 永不触发）；
   - 每帧从 `walkRig` 算下一步并**直接写相机实体**（不走台架：台架只有方位/极角/距离，表达不了"站着转头"）；
   - 退出时**把相机还给台架**（`applyRig`）并**清空按键**（否则"锁定时按住的 W"解锁后还在走）。
   进入时从当前台架派生人的位置与朝向（眼高 1.6）；灵敏度沿用 three `PointerLockControls` 的 0.002 rad/px。

   | 断言（探针 `--walk`，可信点击/按键/鼠标） | 读数 |
   | --- | --- |
   | 工具栏进入 / 退出 | `entered: true` / `exited: true` |
   | 真实按住 `W` | **`steps: 90`**，位置 z **9.67 → 5.18**，高度落在 **1.6**（眼高锁） |
   | 可信鼠标移动转头 | 偏航 **0.0584 → 0.8504** |
   | JS 错误 | 0 |

   **沙箱限制照旧**：拿不到真的指针锁定（自动化窗口没有 OS 焦点），所以判据用探针的 `forceLock`
   （`__PC_VIEWPORT_FORCE_LOCK__`）配合**真实按键与真实鼠标**——与 §四之二 那条"handler 被触达 + forceLock"口径一致。

18. ✅ **增量 13（skybox / 环境贴图）已真机验证**。已做：
   `props.currentSkybox` → 按 slug 找天空盒资产 → 取它的 `hdrPath` → 载成纹理 →
   `scene.envAtlas`（IBL）+ `scene.skybox`（可见天空）；换/卸载时清掉。
   真机读数：`{url:"/env/sky.jpg", applied:true, error:null}`、零 JS 错误。

   **根因是"喂错了格式"，改走引擎自己的 `EnvLighting` 管线后通过。** 完整证据链：
   - **equirect 的 2D 贴图直接喂 `envAtlas`/`skybox` 会被静默丢弃**：赋值后读引擎状态
     `{hasEnvAtlas:false, hasSkybox:false, skyLayerInstances:0}`（清掉**之前**读的），
     而同会话 A/B（开 → 清 → 再拍）**3/3 逐位相同**——天空从没进过画面。
   - **层过滤已排除**：每格相机 `layers = [0, 2, 5, 7]`，**含引擎 Skybox 层 2**
     （`PaneRegistryOptions.sharedLayerIds` 那条接线生效）。
   - **正确路径**（引擎自带）：
     `EnvLighting.generateSkyboxCubemap(equirect)` → **cubemap** 给 `scene.skybox`（可见天空）；
     `EnvLighting.generateLightingSource` → `EnvLighting.generateAtlas` → 给 `scene.envAtlas`（IBL 预过滤）。
   - **改正后真机读数**（探针 `--skybox`，一进一出同会话对照）：

     | 断言 | 读数 |
     | --- | --- |
     | 清掉**之前**读引擎状态 | `{skyLayerInstances: **1**, hasSkybox: **true**, hasEnvAtlas: **true**}` |
     | 天空开着 / 清掉后的画面均值 | **62.174 / 19.951**（A/B 决定性翻转） |
     | `ok` | **true** |

   **两条教训（都写进硬约束了）**：
   ① **诊断要读引擎状态，不要读自己的记账**——我先前那句 `applied: true` 只是写进 ref 的自述，
     与 `scene.envAtlas` 是否为 null 无关。
   ② **A/B 之前先确认被改的字段就是驱动该现象的字段**：可见天空是 `Sky` 网格用 `texture_envAtlas`
     画的（`playcanvas.mjs:37328-37342`），第一次我只清 `scene.skybox` → 得到"逐位相同"的**假**结论。

   ### 🔴 仍未解：天空盒**产物格式**（引擎不认 `.exr`）
   **引擎 2.22.6 完全不认 `.exr`**：贴图解析器只有 `img`（png/jpg/webp…）、`dds`、`basis`、**`hdr`**
   （`build/playcanvas.mjs:102231-102236`，全仓库 grep 不到 `exr`）。而本项目的天空盒资产是 EXR
   （three 侧的硬编码回退就是 `/env/sky.exr`）→ 真实项目里这一条会**加载失败**（会经 `onError` 报出来）。
   要真正用上，天空盒产物得换成引擎认的格式（`.hdr` 或 equirect 图 / `.dds` cubemap / `.ktx2`）。
   与 legacy SPZ 同一类问题：**卡在资产产物，不是视口侧**。

19. ✅ **增量 14：真实业务页面上的交互验收通过**（此前所有交互只在探针页验过）。
   驱动：`node .tmp/pc-panes/drive-app.mjs <baseUrl> <slug> --interact`，全部走**可信事件**。

   | 断言 | 读数 |
   | --- | --- |
   | 可信拖动（轨道） | 亮像素 **7104 → 7688** |
   | **可信点击 → 选中模型** | **`membersAfterClick: 1`** |
   | 真实 `r`/`s`/`g` → gizmo 模式 | **`["translate","rotate","scale","translate"]`**、`gatesOk: true` |
   | 挂上的真资产 / JS 错误 | 10 件 / 0 |

   **这一轮修掉一个一直没被验到的真缺陷：点击 → 选中从来没成功过。**
   拾取命中的是**引擎实体名**（`container` 实例化出来的根名可能是文件名），而我拿它去比
   `asset.id`/`assetSlug`——比不中就把"点中模型"当成"点空白"**清空选中**。症状：
   **怎么点都选不中**（真机上扫 28 个点全落空）。修法：**按实体身份**沿已挂载树解析
   （`assets.entry(id).entity` 是同一棵树，`isDescendantOf` 两边都试）。修完探针页的点击回调
   立刻从 `["clear"]` 变成 **`["select:probe-model"]`**。
   **教训：拾取的返回值要按"身份"用，不要按"名字"用**——名字来自引擎、与应用的稳定 id 没有契约。

20. ✅ **增量 15：工具栏抽成组件**（§五.5 最后一项）。新增
   `widgets/Viewport/ViewportToolbar.tsx`（**纯展示**：状态与副作用都留调用方；样式**一律内联**——
   探针页没有样式表，Tailwind 类会全失效）与 `historyTypes.ts`（让工具栏不必依赖 three 侧那一版）。
   PC 分支那 115 行内联 JSX 换成 `<ViewportToolbar … />`，`aria-label` 与样式一个字没改。

   **抽完必须真机复验**（它正是探针驱动的那部分），读数与抽之前**逐项一致**：

   | 断言（可信点击 `aria-label`） | 读数 |
   | --- | --- |
   | 四窗格 | 象限 `[2263, 7921, 8516, 864]`、`fourOk: true` |
   | 隐藏网格 / 单窗格 | 都生效（`gridDropped: true`） |
   | 投影切换 | 相机 `projection [0, 1]` |
   | 线框 | 27/27 切过去、亮像素 **28452 → 13010 → 28452** |
   | 组件暴露的 aria-label | `Single view` / `Two views` / `Four views (Blender layout)` / `Enter first-person view` / `Toggle perspective/orthographic view` / `…shading (Shift+Z)` / `Hide grid` |
   | `ok` / JS 错误 | **true** / 0 |

   **three 侧当时暂未改用**（那会把产品工具栏的观感从"带图标/提示的 Tailwind 面板"换成内联样式版）。
   ⚠️ **2026-10-02 更正**：这一版的接线**并没有留在工作区里**——`ViewportToolbar.tsx` 后来跟着
   意外删除一起被"按会话日志重放"恢复成了**没人 import 的死文件**（`f25ba6e` 只带回了文件本体，
   没有带回那处替换），PC 分支实际跑的仍是自己那 115 行内联 JSX。**该文件在增量 17 里被
   `ViewportChrome.tsx` 取代并删除**（见下）。

21. ✅ **增量 16：把散落的诊断口收敛成一个开关**（`shared/rendering/playcanvas/viewportDebug.ts`，4 条单测）。
   原先 10 个 `window.__PC_VIEWPORT_*` 活口是**无条件**装的——**真实业务页面也被装上** ✗。
   现在只在该装时装：**开发构建 + URL 带 `pcDebug=1`**（名单集中在 `VIEWPORT_DEBUG_NAMES`，
   卸载时按名单清干净）。两个驱动显式带 `pcDebug=1`（`PC_DEBUG=0` 可关，用于验证开关本身）。

   改这件事时**发现并修掉一个纯生产缺陷**：组件里有**两处"资产就绪后再复位轴心"是绕 `window` 上那个
   钩子回调自己**的（`(window…).__PC_VIEWPORT_TRANSFORM__?.syncSelection()`）。一旦加开关，
   生产路径（不带 `pcDebug`）就读不到它 → `syncSelection()` 静默不跑 → **轴心恒 null、gizmo 拖不动**。
   改成**本地 ref 为权威**，`window` 只是给探针的发布口。

   **开关两面都真机验过**：

   | 断言 | 读数 |
   | --- | --- |
   | **不带** `pcDebug=1`（探针页） | 钩子读数是 `null` → 判据失败（说明确实没装） |
   | **带** `pcDebug=1`（探针页） | `{url:"/env/sky.jpg", applied:true}`、A/B 翻转、`ok: true` |
   | **不带** `pcDebug=1`（**真实页面**） | 挂载 ✓、轨道拖动像素变（7104→7688）、**点选后像素变（选中线框）** ✓、`ok: true`；`modes` 全 `null`＝钩子确实没装 |
   | **带** `pcDebug=1`（真实页面） | 10 件资产、`membersAfterClick: 1`、`modes` 四段序列 ✓ |

22. 🔴 增量 1–16 **刻意没接**（**工具栏那条已在增量 17 归零**）：**逐格的机位预设**
   （`CameraKind` 的 top/front/right 正交机位：现在所有格都是同一份透视默认机位）、
   skybox / world 背景 splat、**地形参照层（world collider）**、材质覆盖、检查图、第一人称——
   **"能渲染"不等于"已迁移"**。
23. ✅ **增量 17：视口 chrome 两版合一**（2026-10-02，用户报"PC 模式右下角 UI 跟别处不一样"）。

   **做了什么**
   - 新增 `widgets/Viewport/ViewportChrome.tsx`：**three 侧原来那段右下角 chrome 的原样搬家**
     （撤销/重做面板 + 变换工具面板 + 视图控制面板 + 底部徽章 + 第一人称提示），纯展示、无引擎依赖。
   - three 分支（`index.tsx`）与 PC 分支（`PlayCanvasViewport.tsx`）**都用它**；
     PC 那 115 行内联样式 JSX 与死文件 `ViewportToolbar.tsx` 一起删掉。
   - PC 补上此前只有快捷键、没有按钮的东西：**变换模式（G/R/S → 三个按钮）**、**世界/局部参考系**
     （`gizmos.setSpace`，缩放模式下禁用——与 three 侧 `TransformControls` 同款口径）、
     **底部徽章**（`N objects` / `Selected: n` / `Wireframe`）、第一人称提示条。
   - PC 的变换模式/参考系**改为 React 状态是权威**（新增 2b-2 effect 统一推给引擎，
     `transformStateRef` 供 gizmo 异步创建那一刻读取）：以前只有 G/R/S 一条路直接写引擎，
     工具栏没有按钮可点、也没有地方读"现在是哪个模式"。
   - PC 新增 `mountedAssets` 状态（**真实挂载结果**：id + kind + 是否 world），
     chrome 的物件数/选中/点云徽章、以及第一人称按钮的可见性都读它——不再拿 `props.assets` 数数。
   - `viewportDebug` 的 transform 活口补 `space()`（判据要能读引擎事实）。

   > 增量 9 里"页面文本含 `1 2 4 投影 线框 网格 撤销 重做`"那条判据**就此作废**：
   > 工具栏改成与 three 侧同一套图标 + `aria-label` 之后，页面上不再有这些中文文案，
   > 驱动要按 `aria-label` 找按钮（`drive-app.mjs` 本来只判"工具栏在不在"，不受影响）。

   **真机 A/B 判据**（`.tmp/chrome-parity/probe.mjs`，1500×950、真实项目 `p-muo3u17c`、
   同一次会话里先 three 后 `?pcViewport=1`，逐项读 DOM + 引擎事实）：

   | 断言 | three 分支 | PC 分支 |
   | --- | --- | --- |
   | 按钮 `aria-label` 顺序 | `Undo, Redo, Single/Two/Four views, 投影, Hide grid, 线框, 地形, 第一人称` | 同前，**少"地形"**（PC 没有这条渲染路径） |
   | 按钮盒子 `[left,top,w,h]` | 32×32、`top=662`、右端对齐 `right-4` | **同**（32×32、`top=662`；少一个 38px 宽的地形按钮） |
   | 徽章 | `10 objects` + `Gaussian splat background` | `10 objects`（**没有**点云徽章：世界是 legacy SPZ，PC 没画） |
   | 可信点击线框按钮 | — | 引擎 `wireframe=true`、**10/10 个 mesh 切过去**、再点回 `false` |
   | 可信点击"四窗格/单窗格" | — | `aria-pressed` 跟着走、四象限亮像素 `[2594,3913,994,633]` |
   | 可信点击网格/投影 | — | `Hide grid`↔`Show grid` 文案与 `aria-pressed` 跟着走；投影切换后画面变 |
   | 选中后出现的变换面板 | 三个模式 + 参考系 | 同；可信点击参考系 → 引擎 `space: world → local` |
   | 键盘 `G/R/S` | — | 引擎 `mode` `translate → scale`（与按钮走同一条状态→引擎路径） |
   | JS 错误 | 0 | 0 |

   单测：`widgets/Viewport/ViewportChrome.test.ts` **13 条**（顺序与文案、`null` 控件不出现、
   `aria-pressed`、徽章、`data-pc-toolbar` 钩子、点击回调参数、缩放模式禁用参考系按钮）。

   **两处仍然不同，且都故意不假装相同**
   - 🔴 **地形参照层按钮**：three 挂 `WorldColliderMesh`（world 的 collider GLB，100% 透明、
     一个像素都不画），PC 这条渲染路径不存在。传 `null` ⇒ 按钮不出现，
     而不是留一个点了没反应的按钮。要它有，得先决定 PC 要不要也下一份几十万面的 collider。
   - 🔴 **`Gaussian splat background` 徽章**：PC 还没画世界泼溅（真实项目的世界是 legacy SPZ，
     引擎只认 v4——见 §Splat）。徽章只在**真的挂上了点云**时才出现，不描述不存在的背景。

   **验证时发现的既有问题（已修；与本次改动无关，两版同病）**：1500 px 宽的窗口下，
   应用外壳输入框那排的容器（`pointer-events-none absolute inset-x-0 bottom-5 z-10`）与视口控制簇
   **同为 `z-10`**，而它在 DOM 里排在视口**之后**——平级 z-index 后来者赢，于是
   `document.elementFromPoint()` 在 `Move (G)`/`Rotate (R)`/`Scale (S)`/`Undo`/`Redo` 的按钮中心
   返回的是外壳的 DIV，**这几个按钮点不动**（参考系/布局/网格/线框/第一人称在外壳之外，一直正常；
   两版位置同源，所以 three 分支当时同样点不动）。
   修法：把控制簇抬到 **`z-20`**（`ViewportChrome.tsx`，回归测试钉住"高于 10、低于 40"）。
   真机复验：同一批按钮的 `topIsButton` 从 `Move/Rotate = False` 变成**全 True**，
   可信点击 `Rotate (R)` 之后引擎 `mode` 由 `translate` 变成 **`rotate`**（修之前纹丝不动）；
   代价是重叠的那 ~11 px 从"发送"按钮底边换成控制簇，发送按钮**中心**仍是它自己（可点）。

24. ✅ **增量 18：默认光照 + 环境贴图兜底**（2026-10-02，用户报"`?pcViewport=1` 打开项目场景是黑的、
   贴图也显示不出来"）。

   **根因是"没有光"，不是"贴图没加载"**——读引擎事实（`.tmp/pc-panes/inspect-lighting.mjs`，
   真实业务页面 `/app/p-muo3u17c?pcViewport=1`）：

   - `app.root.findComponents("light")` = **`[]`**；`scene.ambientLight` = **`(0,0,0)`**
     （引擎默认就是黑：`scene.js:29`、d.ts 原话 "Defaults to black (0,0,0)"）；
   - `scene.envAtlas` / `scene.skybox` 都是 **false**（连 IBL 都没有）；
   - 而模型材质是 `useLighting: true` + **`diffuseMap: true`** + `metalness: 1`
     ——**贴图早就挂上了**，只是所有受光项乘 0，所以"贴图显示不出来"与"场景黑"是同一个根因。

   **为什么探针一直没抓到**：探针台架自己加了一盏平行光（`panes.browser.ts:480-484`），
   而且探针用的天空盒是 `.jpg`；真实页面上这两样都没有。

   **两处缺口（都补了）**

   - **光源**：three 侧一直有 `ambientLight 0.6` + 两盏 `directionalLight`（1.4 / 0.4，
     `index.tsx:265-267`），PC 侧一行都没有。新增 `playcanvas/sceneLighting.ts` 的
     `createSceneLighting()`：写 `scene.ambientLight` + 逐盏建平行光实体挂到 `app.root`，
     **方向用 `setPosition` + `lookAt(0,0,0)` 表达**（引擎的平行光是实体 −Z；不要手写欧拉角——
     引擎欧拉是角度 + ZYX，与 three 的弧度 + XYZ 不是一套）。在 `PlayCanvasViewport` 的装配
     effect 里建、清理时 `dispose()`（`Entity.destroy()` 会摘组件 + 摘父节点，`entity.js:157-170`）。
   - **环境贴图兜底**：原代码是 `if (!path) return;`——"项目没选天空盒 / 列表里那个占位资产的
     `hdrPath` 是 null"时**连 IBL 都没有**；three 侧有 `/env/sky.exr` 兜底，而那份引擎**不认**
     （解析器只有 img / dds / basis / hdr）。改成候选表：项目产物 → **`/env/sky.jpg`**
     （引擎认的 equirect，2048×1024，与 `sky.exr` 同目录），按顺序试、第一个成功的生效；
     项目产物是 EXR 时自然落到默认那张。

   **真机读数**（同一条取样脚本；两次会话，只作定性对照）：

   | 断言 | 修前 | 修后 |
   | --- | --- | --- |
   | `findComponents("light")` | `[]` | `[{directional,1.4},{directional,0.4}]`（都 `enabled`） |
   | `scene.ambientLight` | `(0,0,0)` | `(0.6,0.6,0.6)` |
   | `envAtlas` / `skybox` / Sky 层 mesh | `false` / `false` / 0 | **`true` / `true` / 1**（`p-muo3u17c` 没选天空盒 → 走 `/env/sky.jpg` 兜底） |
   | 亮像素 | **7104**（全是黑剪影） | **15888** |
   | 画面 | 家具全黑、只剩轮廓 | `.tmp/pc-panes/lighting-fixed-p-muo3u17c.png`（家具与贴图都在） |
   | JS 错误 | 0 | 0 |

   另一个项目 `p-mu5l6om3`（**自己就有 jpg 天空盒**）复验：`envAtlas: true`、亮像素 8228 → **10366**、
   控制台**没有**兜底告警（说明项目产物优先、兜底没被误用）。

   单测：`playcanvas/sceneLighting.test.ts` **9 条**——与 three 侧的数值契约（0.6 / 1.4 / 0.4 与两个位置）、
   注入假实体后的建灯参数与方向、`dispose` 逐盏销毁且幂等、候选表的优先级/去重/空表。

   **仍未解（不是视口侧）**：两个项目的 world 产物都是 **legacy SPZ**（头部 `1f8b` = gzip），
   引擎只认 v4 → 控制台稳定报 `No parser found for resource`，房间/背景仍不渲染；
   要修得换产物格式（`@playcanvas/splat-transform`）。
   → **已在增量 19 解决**（而且真凶不止"格式"一条）。

25. ✅ **增量 19：世界泼溅真的画出来了**（2026-10-02，接增量 18 的"世界仍不渲染"）。
   三条**独立**的原因，缺一条都黑：

   **① 产品路径从来没注册 SPZ 解析器**（这条最隐蔽，也是"错误信息会骗人"的典型）。
   引擎的 `gsplat` handler 内置只有 `ply`/`sog`/`lod-meta.json`；SPZ 要
   `loader.getHandler('gsplat').addParser(new SpzParser(app))`，ZSTD 解码器还要先
   `WasmModule.setConfig('ZstdDecoderModule', …)`（`playcanvas/splat.ts` 把两件事封在一起）。
   探针一直在调（`panes.browser.ts:431`），`PlayCanvasViewport` **没调**——
   于是控制台稳定报 `No parser found for resource: …spz`，**换成 v4 也一样报**。
   ⚠️ **教训**：那句话只说明"没有解析器"，不说明产物格式不对；我先前照着它把根因归到"legacy 格式"，
   只对了一半。修法：装配 effect 里在 `setReady(true)` **之前** `await registerSplatParsers(app)`。

   **② 上游产物是 legacy**：World Labs 下发 v2/v3（整段 gzip），引擎只认 v4。
   在**入库**这一步统一转（`chat/src/common/spz.ts` + `downloadSpzToLibrary`，首次生成与续跑两条路都接；
   补下载缺失产物那条路也接）：已经是 v4 就不动、是 legacy 才转、**转不了就保留原样并告警**（资产不能丢）。
   three 侧（`gaussian-splat-lite`）两种都读，所以不需要按引擎各存一份。
   历史项目补转：`bun run --cwd chat spz:to-v4`（8 件实测全部成功，1.92M 点约 1.9 s/件；
   原文件备份进 `.spz-legacy/`，点开头 ⇒ 资产库不列出，转换后校验 `numPoints`/`shDegree` 一致才替换）。

   **③ 世界的坐标语义没读**：World Labs 的坐标系 **+Y 朝下**，照原样画是**倒的**。
   three 侧一直翻（`widgets/Viewport/worldTransform.ts`：`flipY` ⇒ 绕 X 转 π、`metricScaleFactor`、
   `groundPlaneOffset`），PC 侧完全没读 `worldSemantics`。新增 `playcanvas/worldPlacement.ts`
   （语义 ∘ 用户摆放；合成用 **three 当真值**钉住，含"`Quat.mul` 是就地修改"那个坑——
   先算位置再合成旋转，否则位置会被多转一次）。真实项目的值**不是**默认的 1/0：
   实测 `p-muo3u17c` 是 scale **1.8169396**、offset **1.0635998**，所以必须读字段。
   规格链路：`viewportSceneSpecs` 透传 `worldSemantics` → `assetScene` 在写实体时合成
   （记账里仍是**用户摆放**，gizmo 写回不被污染）。

   **真机读数**（`.tmp/pc-panes/inspect-lighting.mjs`，真实业务页面 `/app/p-muo3u17c?pcViewport=1`）：

   | 断言 | 修前 | 修后 |
   | --- | --- | --- |
   | 控制台 | `No parser found for resource: …0-world-full-res.spz` | **零错误、零告警** |
   | 引擎里的 gsplat 组件 | 无 | `{enabled: true, numSplats: **1920000**}`（就是 full-res 的点数） |
   | 该实体的局部变换 | — | `rotation [1,0,0,0]`（绕 X π）、`position.y 1.0636`、`scale 1.8169`（＝项目自己的语义值） |
   | 亮像素 | 15956 | **1053533**（房间铺满画面） |
   | JS 错误 | 0 | 0 |

   截图：`.tmp/pc-panes/splat-fixed-p-muo3u17c.png`（远景）与 `.tmp/pc-panes/world-oriented-p-muo3u17c.png`；
   同项目 **three 分屏对照** `.tmp/pc-panes/three-branch-p-muo3u17c.png`
   ——两版的默认机位都落在房间内部（这是项目本身的世界尺度 + 默认机位决定的，不是朝向 bug）。

   单测：`worldPlacement.test.ts` **7 条**（默认语义、三值各自生效、缺字段不猜、单位摆放、
   gizmo 挪过世界的解析式、与 three 矩阵分解逐项一致、不翻转那条路）、
   `assetScene.test.ts` +2（语义叠加进实体、老数据不翻）、`viewportSceneSpecs.test.ts` +1（透传/null）、
   `chat/src/common/spz.test.ts` **11 条**（头判定、降级四态、**真工具往返**：现造 v3 夹具 → 转 v4 点数不变）、
   `chat/src/mastra/tools/assetRepair.test.ts` **1 条**（下载 legacy → 落盘 v4，端到端接线）。

3. 接 `live` + `onTransformCommit`（`selectionTransform` 的回调已就位）+ history 按钮；
   选中/悬浮接 `selectionWireframe`；G/R/S 接 `transformKeys`。
4. 之后再补：skybox / world splat / 材质覆盖 / 检查图（`inspectionCapture`）/ 第一人称。
5. 验收照 `AGENTS.md` §七 的清单：先 `bun run check`，再用应用的**真实页面**（不是探针）
   逐项对照 three 版的行为差异。

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
| `paneGrid.ts` | 编辑器地面网格：自定义 WGSL 材质（两级线 + 导数抗锯齿 + 逐相机淡出），参数烘进源码（14 条测试 + §三之八 真机） |
| `paneAxisHud.ts` | 逐窗格屏幕等大坐标轴球 HUD：放在相机前方固定深度、屏幕空间命中、点击吸附（13 条测试 + §三之九 真机） |
| `walkRig.ts` | 第一人称漫游的纯数学：偏航/俯仰 + WASD + 高度锁定（10 条测试 + §三之十 真机） |
| `rigFlight.ts` | 聚焦飞行动画：指数阻尼 + 到位判据 + 位姿↔台架互转（10 条测试 + §三之十 真机） |
| `selectionTransform.ts` | 多选整体变换：轴心口径 + 冻结相对矩阵 + 还原 + 拖拽生命周期（17 条测试，**用 three 当真值**钉欧拉约定 + §三之十一） |
| `panePlacement.ts` | 实体 ↔ 摆放适配：只走四元数（3 条测试），避开引擎"角度 + ZYX"的欧拉 API |
| （真实 splat 拾取） | `panePicking` 的 `enableIds` 前提在 **150k / 1.92M 真实 SPZ v4** 上用**负对照**验证（§三之十三） |
| `selectionBounds.ts` | 选中线框纯数学：三态 / 外扩 2% / 单位立方体 12 棱（7 条测试 + §三之十二 真机） |
| `selectionWireframe.ts` | 线框引擎绑定：持久 line 网格 + 独立层 + 不可拾取（5 条测试 + §三之十二 真机） |
| `transformKeys.ts` | G/R/S 纯契约（四道闸门，对齐 three 侧）（5 条测试 + §三之十二 真机） |
| `assetScene.ts` | 资产 → 实体：幂等 `sync`（新增/更新/销毁/换代）+ 引擎加载器（GLB container / gsplat）（6 条测试 + 真实 SPZ 真机，§三之十四） |
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
   - ✅ **多选整体变换的集成层数学 + 页面内真机验证（§三之十一）**：`playcanvas/selectionTransform.ts`
     （17 条，含**用 three 当真值**钉住欧拉约定）、`playcanvas/panePlacement.ts`（3 条）。
     轴心口径、冻结相对矩阵、`pivot.matrix·relative` 还原、拖拽生命周期（一次拖拽一次提交）都对；
     三个成员同位移 Δ=(1.5,−0.75,0)、整体旋转满足 (x,y,z)→(z,y,−x)、实时表松手清空。
     **这一项顺带挖出一个静默陷阱**：引擎的欧拉 API 是**角度 + ZYX**，而摆放是 three 的**弧度 + XYZ**——
     直接互喂会静默转错朝向（两个维度都错），详见 §三之十一。
   - ✅ **可信驱动那条链也通了**（§三之十一 末尾）：`.tmp/pc-panes/drive-multi.mjs`
     **9 条断言全过、退出码 0**——三个成员同位移 Δ=3.620、一次提交带三个成员、相机不动。
     （第一版记的"引擎拖不动实体、根因未定位"**是我的接线与诊断问题，不是引擎缺陷**，已在文档里更正。）
   - ✅ **选中/悬浮线框 + G/R/S 已完成并页面内真机验证（§三之十二）**：`selectionBounds.ts`（7 条）、
     `selectionWireframe.ts`（5 条）、`transformKeys.ts`（5 条）。三态、白线、外扩 2%、
     **不可拾取**、G/R/S 四道闸门都与 three 侧逐项对齐；1/2/4 窗格自检全绿。
     顺带修掉 `entityWorldBounds()` 读引擎 `Vec3` 用数字下标的**真 bug**（测试假数据也一起错，所以一直没暴露）。
   - ✅ **可信驱动已恢复并稳定**：连续三轮 **35/35、退出码 0**（§三之十二 末尾记了两层原因：
     探针默认抢指针锁定 + 自检合成 keydown 没配对 keyup）。
   - ✅ **真实 splat 拾取已验证（§三之十三）**：150k 与 **1.92M 全分辨率**两个真实 SPZ v4 上，
     "开着 `enableIds` 能选中 gsplat、关掉选不中"（负对照），`enableIds` 默认 `false` 也是实测的。
   - 🔴 **剩**（都属 §五.5 集成层）：① 拖动写**应用那张** `LiveTransforms` + `onCommit` 进撤销栈
     （数学与回调已就位，缺应用侧接线）；② world/local 的**面板**（`toggleSpace` 已就位，UI 属应用）。
3. **网格与坐标轴 HUD**：`WebGPUGrid.tsx`（TSL：两级网格 + 导数抗锯齿 + 距离淡出）与 `PaneGizmo`。
   - ✅ **网格已完成并真机验证（§三之八）**：`playcanvas/paneGrid.ts`（14 条测试），两级 0.5/5、
     导数抗锯齿、逐相机 40 单位淡出；1/2/4 窗格每格都看见、两级都参与、淡出生效、**不可拾取**、
     `startRenderPass` 仍 240/240（每帧 1 个 pass）。**不要照抄** SuperSplat 的全屏 quad + 射线求交；
     注意 `plane` 图元本身就在 XZ 平面（别再转 -90°）。
   - ✅ **坐标轴球 HUD 也已完成并真机验证（§三之九）**：`playcanvas/paneAxisHud.ts`（13 条测试），
     屏幕等大（已知机位下 ±X/±Y 间距**恰好 80 px**、退远 3 倍不变）、逐格隔离、命中与吸附、
     可信点击吸附到 π/2 且不选中；`startRenderPass` 仍 240/240。
     **不加相机**（放在相机前方固定深度 + `worldPerPixel` 缩放）、HUD 层走 `extraLayerIds`、
     点击走 `onClaimedClick`（`isPointerClaimed` 会吞掉 `onClick`）。
   - 🔴 **剩**：trackball 自由旋转（需要带滚转的台架）与字母/吸附动画——见 §三之九 末尾。
4. **第一人称模式**——**纯数学 + 接线 + 真机验证已完成（§三之十）**：
   - ✅ `playcanvas/walkRig.ts`（10 条测试）：偏航/俯仰 + WASD + 高度锁定（`EYE_HEIGHT=1.6`）、
     Shift 加速（3→7）、单帧 delta 钳 0.1 s、俯仰钳制；灵敏度沿用 three `PointerLockControls` 的 0.002 rad/px。
   - ✅ `playcanvas/rigFlight.ts`（10 条测试）：聚焦**飞行**（`DAMP_LAMBDA=4`、到位阈值同 three）；
     通过新的 `PaneInputHost.animateFocus` 挂到双击聚焦上，用户一有输入即取消。
   - 🔴 **剩**：模式的**进入/退出**与锁定失败提示（属 §五.5 集成）；**指针锁定权限本身在本沙箱无法验证**
     （Chrome 因窗口没有 OS 焦点直接拒绝，见 §三之十）。

### 然后（集成）

5. **把 PlayCanvas 渲染层真正接进应用**——**已开始**：第一块可复用件 `playcanvas/assetScene.ts`
   （资产 → 实体，6 条测试 + 真实 SPZ 真机验证）见 §三之十四，那一节末尾列了按依赖排序的下一步。
   用新的 `Viewport` 实现替换 three 版，`ViewportProps` 保持不变；**先单窗格 + 模型**跑通，
   再打开 1/2/4 与 splat——一次全开的话出问题很难二分。
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
  `paneInput.ts`、`panePicking.ts`、`paneGizmo.ts`、`paneGrid.ts`、`paneAxisHud.ts`、`walkRig.ts`、`rigFlight.ts`、
  `selectionTransform.ts`、`panePlacement.ts`（各带测试），
  并给 `panes.browser.ts` 加了输入/拾取/gizmo/网格/坐标轴球自检与 `__PC_INPUT__` 活口）、
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

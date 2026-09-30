# Babylon.js / Babylon Editor 的 WebGPU 实现调研

> 面向：WebGPU-only 的 three.js 3D 编辑器（多视口 ArrayCamera + GPU 时间戳 + 离屏截图 + Gaussian splat / 点云大资产）

**调研时间**：2026-09-30
**调研条件（必读）**：本次执行环境**没有公网**——`web_fetch` 对所有公网 URL 均失败（DNS 解析到 `198.18.0.x`），`curl` 超时。因此：

- **A 级证据**：本地可读、可给行号的源码。只有 three.js 0.186.1（`node_modules/three`，权威副本）。本报告所有 three 的引文与行号都来自 A 级。
- **B 级证据**：`web_search` 的**返回 URL 列表**（只有标题 + URL，无正文）。用途仅限于**证明某个类/文档页/文件路径存在**，以及**证明某个名字不存在**（搜不到是有信息的）。B 级只能证明"存在"，不能证明"内容"。
- **C 级证据**：我的既有知识。**每条都标了置信度（高/中/低）**，凡无法核实的文件路径一律写"路径需自行确认"，**没有编造任何行号**。

**没有拿到 Babylon 的 tag / commit sha**（无法访问 GitHub API）。所以本报告给的是**仓库路径**，不是带 sha 的 permalink。凡是已用**版本化 CDN URL**（unpkg / jsdelivr）确认过的路径，我会标注它对应的 `@babylonjs/core` 版本号——这比 `blob/master` 更接近 permalink 的作用。

---

## 0. 先纠正任务描述里的一个路径

任务描述里同时写了 `packages/dev/core/src/Engines/WebGPU/` 和 `packages/dev/core/src/Engines/webgpuEngine.ts`。**后者才对**——`webgpuEngine.ts` 不在 `WebGPU/` 子目录里：

- B 级证据：[`app.unpkg.com/@babylonjs/core@9.12.0/files/Engines/webgpuEngine.js.map`](https://app.unpkg.com/@babylonjs/core@9.12.0/files/Engines/webgpuEngine.js.map) —— 构建产物在 `Engines/webgpuEngine.js`，**不在** `Engines/WebGPU/` 下。
- 对比：[`app.unpkg.com/@babylonjs/core@9.16.1/files/Engines/WebGPU/webgpuCacheRenderPipeline.js.map`](https://app.unpkg.com/@babylonjs/core@9.16.1/files/Engines/WebGPU/webgpuCacheRenderPipeline.js.map)、[`@babylonjs/core@9.6.2/Engines/WebGPU/webgpuCacheBindGroups.js.map`](https://app.unpkg.com/@babylonjs/core@9.6.2/files/Engines/WebGPU/webgpuCacheBindGroups.js.map)、[`cdn.jsdelivr.net/npm/@babylonjs/core@9.13.0/Engines/WebGPU/webgpuCacheBindGroups.js.map`](https://cdn.jsdelivr.net/npm/@babylonjs/core@9.13.0/Engines/WebGPU/webgpuCacheBindGroups.js.map) —— 这两个**在** `Engines/WebGPU/` 下。

**由此可确认的源码路径（B 级，高）**：

| 源码路径 | 确认依据 |
| --- | --- |
| `packages/dev/core/src/Engines/webgpuEngine.ts` | unpkg @9.12.0 构建产物路径 |
| `packages/dev/core/src/Engines/WebGPU/webgpuCacheRenderPipeline.ts` | unpkg @9.16.1 |
| `packages/dev/core/src/Engines/WebGPU/webgpuCacheBindGroups.ts` | unpkg @9.6.2 + jsdelivr @9.13.0 |

**以下路径我无法核实，路径需自行确认（C 级）**：`webgpuDynamicBuffer.ts`、`webgpuDataBuffer.ts`、`webgpuTimestampQuery.ts`、`webgpuSnapshotRendering.ts`、`thinEngine.ts`、`abstractEngine.ts`、`engine.ts`。它们的**类名**我可以确认（见下），但**文件名/目录**请在拿到网络后用 §10 的命令核实。

---

## 1. Babylon 的 WebGPU 引擎架构

### 1.1 类层次：AbstractEngine → ThinEngine → WebGPUEngine

**置信度：高（语义）/ 中（文件位置）**

Babylon 的引擎层是三层：

- `AbstractEngine` —— 与图形 API 无关的引擎骨架：渲染循环、`runRenderLoop`、`isReady()` / `whenReadyAsync()`、`registerView` / `views`、`onContextLostObservable` / `onContextRestoredObservable`、`getRenderWidth/Height`、性能计数器（`_drawCalls`、`_gpuFrameTimeCounter` 等）、`snapshotRenderingMode` 接口。WebGL 和 WebGPU 都继承它。
- `ThinEngine extends AbstractEngine` —— WebGL 时代的"薄引擎"：资源创建（texture / effect / vertexBuffer / indexBuffer）、状态设置的**具体实现**、`_releaseTexture`、`_internalTexturesCache`。
- `Engine extends ThinEngine` —— 完整 WebGL 引擎（`Engine` 是 WebGL 专属）。
- `WebGPUEngine extends ThinEngine` —— WebGPU 实现，**历史包袱**：它继承 `ThinEngine` 而不是 `AbstractEngine`，所以像 `registerView` 这种放在 `AbstractEngine` 里的能力，`WebGPUEngine` 历史上是缺的。这正是下面这条论坛帖的主题。

B 级证据（"WebGPUEngine 缺 registerView"确有其事）：[Support for WebGPUEngine: Register View in Abstract Engine Missing](https://forum.babylonjs.com/t/support-for-webgpuengine-register-view-in-abstract-engine-missing/50815/1)

> 这条对本项目的直接含义：**"引擎继承链把多视图能力放在了错误的层"是一个真实发生过的架构事故**。如果本项目将来要把"多视口"抽象成引擎级能力（而不只是 `Renderer` 上的一个函数），要避免同样的层级错配。

其他架构性 B 级证据：
- [Engine Architecture (Multi-Backend) | DeepWiki](https://deepwiki.com/BabylonJS/Babylon.js/3.1-engine-capabilities-and-features#1)
- [WebGPU-Specific Features | DeepWiki](https://deepwiki.com/BabylonJS/Babylon.js/7.2-webgpu-specific-features#1)
- [WebGPU Internals - Overview](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUOverview)
- [Porting Babylon.js for WebGPU (Khronos)](https://www.khronos.org/developers/linkto/porting-babylon.js-for-webgpu-microsoft) —— 这是 Babylon 团队自己写的移植回顾，是**唯一一篇我确认存在的一手移植叙述**（B 级；正文未读到）。

### 1.2 `WebGPUEngine.CreateAsync` 与 `WebGPUEngineOptions`

**置信度：高（API 存在）/ 中（细节）**

- B 级：[Interface WebGPUEngineOptions](https://doc.babylonjs.com/typedoc/interfaces/BABYLON.WebGPUEngineOptions)
- B 级：[Interface WebGPUEngineOptions（_babylonjs_core 命名空间版本）](https://doc.babylonjs.com/typedoc/interfaces/_babylonjs_core.WebGPUEngineOptions)

WebGPU 的 `GPUDevice` 请求是**异步**的，所以 Babylon 的 WebGPU 引擎入口是静态异步工厂 `WebGPUEngine.CreateAsync(canvas, options)`——不是 `new WebGPUEngine(...)`。

> **对本项目**：本项目同样面对"异步拿 device"的问题，且已经落到了 `WebGPUCanvas` 的重试面板 + `NativeWebGPURenderer.init()`（`app/src/shared/rendering/webgpu.ts:69`）。两者形状一致，无需改。

### 1.3 Snapshot rendering（**多视口编辑器最相关**）

**置信度：高（机制与语义）/ 低（具体数字、Fast 模式的实现细节）**

B 级证据：
- 官方文档页：[WebGPU Snapshot Rendering](https://doc.babylonjs.com/setup/support/webGPU/webGPUOptimization/webGPUSnapshotRendering)
- API 页：[Class SnapshotRenderingHelper](https://doc.babylonjs.com/typedoc/classes/BABYLON.SnapshotRenderingHelper)
- 提交：[`3dc3559` "WebGPU: fix fast snapshot rendering mode + add support for it to fram…"](https://github.com/BabylonJS/Babylon.js/commit/3dc355967856da60fe1ab54d05118b2fa1ea1084)
- PR：[#18293 "fix: snapshot rendering crash with clustered lighting"](https://github.com/BabylonJS/Babylon.js/pull/18293)

**它解决的问题**：一帧内把**同一个场景**渲染多次时，CPU 侧重复做"决定要下发什么状态、什么 draw"的那部分 JS 工作。典型触发场景就是：**多视口/多相机**、反射探针、阴影贴图、以及需要同一场景多张图的任何后处理。

**机制（置信度 高，但无行号）**：
1. 第一帧处于**录制模式**。`SnapshotRenderingHelper` 把引擎收到的状态设置调用（viewport、scissor、depth/stencil、blend、alphaMode、剔除、当前渲染目标、draw 的参数……）记录下来，落到一组"命令缓冲"里。
2. 之后每帧**直接重放**记录好的命令，跳过重新计算的 JS 分支。
3. `engine.snapshotRenderingMode` 是模式开关，取值 `Disabled / Standard / Fast`（`0 / 1 / 2`）。**Fast 模式**记录得更激进、并配合 WebGPU render bundle / frame graph 执行——上面的 commit `3dc3559` 正是"把 fast 模式接进 frame graph"。
4. 经典注意事项：录制之后场景必须**静态**。几何、材质、相机、渲染目标任何一项变了，都必须让 helper 重新录制（否则画面错乱）。PR #18293（fast 模式在 clustered lighting 下崩溃）说明 fast 模式与光照子系统存在耦合。

**为什么它对本项目是"看起来最香、实际上最不该照搬"的一条**：
- 收益正比于「**同一帧内同一场景被渲染的次数**」。1 视图时收益≈0，甚至多一层录制开销。
- 本项目的编辑器场景**每帧都在变**（gizmo、选择高亮、相机、splat 排序脏标记）。快照渲染要求静态，所以它只适用于「某一类内容每帧被画 N 次且内容不变」的子集——例如**背景环境图/参考网格/静态建筑**在 4 个视口里都要画的那部分。
- **对 splat 尤其危险**：GSL 的排序是脏标记驱动的，快照会绕过这套判断（`AGENTS.md` §六已确认拖动时排序是主要成本）。

**数字（必须诚实说明）**：官方 doc 页面存在，但**我无法读取正文，因此本报告不引用任何具体倍数**。任何"snapshot rendering 提升 X 倍"的说法，请拿到网络后从 [该文档页](https://doc.babylonjs.com/setup/support/webGPU/webGPUOptimization/webGPUSnapshotRendering) 自行抄录并注明场景（视图数、机器、分辨率）——脱离视图数的倍数没有意义。

### 1.4 WebGPU 子模块清单（**除已确认的 3 个路径外，都需自行确认**）

| 类 / 文件 | 作用 | 置信度 |
| --- | --- | --- |
| `WebGPUCacheBindGroups` | bind group 缓存（`Engines/WebGPU/webgpuCacheBindGroups.ts`，**路径已确认**） | 高 |
| `WebGPUCacheRenderPipeline` | 完整渲染管线状态树 + `GPURenderPipeline` 懒创建缓存（**路径已确认**） | 高 |
| `WebGPUDynamicBuffer` | 共享大 buffer + 对齐的动态偏移分配器 | 类名中；路径待确认 |
| `WebGPUTimestampQuery` | GPU 时间戳查询封装 | 类名中；路径待确认 |
| `SnapshotRenderingHelper` | 快照渲染录制/重放 | 类名高；路径待确认 |
| `WebGPUDrawContext` | 单次 draw 的 WebGPU 侧上下文 | 高（B 级：[typedoc](https://doc.babylonjs.com/typedoc/classes/_babylonjs_core.WebGPUDrawContext)） |

B 级：[WebGPU Internals - Bind Group Cache](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUCacheBindGroup/#cache-implementation)、[WebGPU Internals - Render Pipeline Cache](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUCacheRenderPipeline/)

---

## 2. 多视图 / 多画布

### 2.1 Babylon 的三条路径

**置信度：中高**

B 级证据：
- [Using Multiple Canvases](https://doc.babylonjs.com/features/featuresDeepDive/scene/multiCanvas#multi-scenes)（`engine.registerView(canvas, camera)`、`engine.views`、`engine.inputElement`；同页还有"多 scene"）
- [MultiViews Part 2](https://doc.babylonjs.com/features/featuresDeepDive/cameras/multiViewsPart2/#example-pg--4JXV32)
- [Support for WebGPUEngine: Register View in Abstract Engine Missing](https://forum.babylonjs.com/t/support-for-webgpuengine-register-view-in-abstract-engine-missing/50815/1)

三条路径，用途完全不同：

1. **`camera.viewport` + `scene.activeCameras`**（**分屏用这条**）。`Viewport(x, y, w, h)` 是**归一化 [0,1]** 坐标，映射到渲染目标尺寸。`scene.render()` 对 `activeCameras` 里的每个相机各跑一次 `_renderForCamera`。这是 4 窗格布局的正统做法。
2. **`engine.registerView(canvas, camera)` + `engine.views`**（**多 canvas 用这条**）。一个 engine 驱动多个 canvas。这个能力**在 `AbstractEngine` 上**，而论坛帖证明 `WebGPUEngine` 曾经缺它——**WebGPU 路径与 WebGL 路径在"多视图"上的历史差异就出在这里**，不是出在渲染本身。
3. **`camera.layerMask`** 做内容过滤（Babylon 的 layer 机制）。

**关键差异（置信度 中）**：WebGL 时代 `engine.views` 是"多画布"的标准答案；WebGPU 下更稳的是 ①（`camera.viewport` + `activeCameras`），因为它不依赖 `engine.views` 在每个 backend 上的实现完整度。**这一点我没有一手代码证据，属 C 级推断，请以 §10 的核实为准。**

> **对本项目的映射**：本项目用 three 的 `ArrayCamera` + 子相机 `viewport`，语义上**最接近 Babylon 的路径 ①**，但**执行形态不同**——Babylon 是"每个相机一趟 `_renderForCamera`"，本项目是"一趟 render pass 内 per-sub-camera `setViewport`"。这是本项目比 Babylon 更激进的地方，也是下面第 8 节所有缺口的来源。

### 2.2 WebGPU 与 WebGL 在 viewport/scissor 上的实测差异（**A 级，本地可验证**）

这是本报告里我**唯一能给出确定性行号**的一组对照，而且直接命中 `AGENTS.md` §四里"顶部为原点"那条：

**WebGPU：不翻转（左上原点）**

`node_modules/three/src/renderers/webgpu/WebGPUBackend.js:1659-1680`：

```js
	updateViewport( renderContext ) {

		const { currentPass } = this.get( renderContext );
		const { x, y, width, height, minDepth, maxDepth } = renderContext.viewportValue;

		currentPass.setViewport( x, y, width, height, minDepth, maxDepth );

	}

	updateScissor( renderContext ) {

		const { currentPass } = this.get( renderContext );
		const { x, y, width, height } = renderContext.scissorValue;

		currentPass.setScissorRect( x, y, width, height );

	}
```

**WebGL：翻转 `height - height - y`**

`node_modules/three/src/renderers/webgl-fallback/WebGLBackend.js:709-711`（以及 `:725` 的 scissor）：

```js
		const { x, y, width, height } = renderContext.viewportValue;

		state.viewport( x, renderContext.height - height - y, width, height );
```

ArrayCamera 的 per-sub-camera 路径同样翻转，`WebGLBackend.js:1329-1334`：

```js
						state.viewport(
							Math.floor( x ),
							Math.floor( renderContext.height - height - y ),
							Math.floor( width ),
							Math.floor( height )
						);
```

**结论**：三条 viewport 下发点，WebGL 全翻转、WebGPU 全不翻转。本项目是 WebGPU-only，所以"左上原点 + CSS px + 乘 pixelRatio"应作为唯一约定固化，并加一条防回归（防止有人从 WebGL 示例抄代码）。这与 `app/src/widgets/Viewport/paneViewports.ts:58-61` 的注释一致。

### 2.3 viewport / scissor **没有状态缓存**（A 级，重要缺口）

**WebGPU 的 pass 级 viewport/scissor 无条件下发**：`WebGPUBackend.js:1659-1680` 里没有任何 `if (cached !== value)` 判断——每次调用都真的调 `setViewport` / `setScissorRect`。

不过 three 有一层**粗粒度**保护。`node_modules/three/src/renderers/common/Renderer.js:1787` 与 `:1790`：

```js
		renderContext.viewport = renderContext.viewportValue.equals( _screen ) === false;

		renderContext.scissorValue.copy( scissor ).multiplyScalar( pixelRatio ).floor();
		renderContext.scissor = canvasTarget._scissorTest && renderContext.scissorValue.equals( _screen ) === false;
```

即：**viewport 等于整屏时直接不发**（`WebGPUBackend.js:1115-1125` 只在 `renderContext.viewport` 为真时调 `updateViewport`）。对 ArrayCamera 的分屏场景，`renderContext.viewportValue` 是整画布，所以**pass 级 viewport 根本不发**；每窗格裁剪只能靠 draw 里的子相机 viewport。

**真正的问题在这里** —— `WebGPUBackend.js:2264-2297`：

```js
			for ( let i = 0, len = cameras.length; i < len; i ++ ) {

				const subCamera = cameras[ i ];

				if ( object.layers.test( subCamera.layers ) ) {

					const vp = subCamera.viewport;

					let pass = renderContextData.currentPass;
					let sets = renderContextData.currentSets;
					const isBundleEncoder = renderContextData.bundleEncoders !== undefined;

					if ( isBundleEncoder ) {

						const bundleEncoder = renderContextData.bundleEncoders[ i ];
						const bundleSets = renderContextData.bundleSets[ i ];
						pass = bundleEncoder;
						sets = bundleSets;

					}
					// GPURenderBundleEncoder does not support setViewport, only GPURenderPassEncoder does

					if ( vp && ! isBundleEncoder ) {

						pass.setViewport(
							Math.floor( vp.x * pixelRatio ),
							Math.floor( vp.y * pixelRatio ),
							Math.floor( vp.width * pixelRatio ),
							Math.floor( vp.height * pixelRatio ),
							context.viewportValue.minDepth,
							context.viewportValue.maxDepth
						);

					}
```

**逐对象 × 逐子相机无条件下发 `setViewport`**。而**同一个循环里紧邻的 `cameraIndex` bind group 是有缓存的**（`WebGPUBackend.js:2300-2311`）：

```js
					if ( indexPos !== - 1 && cameraData.indexesGPU ) {

						const cameraIndexGPU = cameraData.indexesGPU[ i ];

						if ( sets.bindingGroups[ indexPos ] !== cameraIndexGPU ) {

							pass.setBindGroup( indexPos, cameraIndexGPU );
							sets.bindingGroups[ indexPos ] = cameraIndexGPU;

						}

					}
```

**这是一个明确的不对称**：`cameraData.indexesGPU` 只在长度变化时重建（`:2237-2258`），bind group 有 `!==` 缓存，**viewport 没有**。

再对照 `_draw`（`WebGPUBackend.js:2019-2100` 区间）：pipeline（`:2028`）、bind group（`:2050`）、index buffer、vertex buffer（`currentSets.attributes`）、stencil ref、blend constant **全都有缓存**——**viewport / scissor 是这套缓存里唯一的例外**。

**量级（可自行验证的检查项）**：4 视口 + N 个可绘制对象的核心场景，`pass.setViewport` 调用次数是 **N × 4**，而理论下限是 **4**。对本项目当前形态（核心场景 1 次 `gl.render` + splat 单个 draw）影响很小；但**一旦"可绘制对象数"上去（大量 GLB 网格、点云分块、实例化前的多 mesh）**，这就是 N×4 次 JS→native 调用。

> **Babylon 的对照**：`WebGPUCacheBindGroups` / `WebGPUCacheRenderPipeline` 的存在说明 Babylon 把"任何会改变 GPU 状态的东西"都纳入缓存键。**Babylon 是否单独缓存 viewport 我无法核实（B/C 级缺失）**，但"状态缓存要覆盖 viewport/scissor"这条原则是 Babylon 明确写在文档里的（[Bind Group Cache](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUCacheBindGroup/#cache-implementation)、[Render Pipeline Cache](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUCacheRenderPipeline/)）。

---

## 3. 绑定组、渲染管线缓存与 uniform 对齐

### 3.1 Babylon 侧（**C 级，标注意外**）

**置信度：中（机制）/ 低（API 细节与默认值）**

- `WebGPUCacheBindGroups`（**路径已确认**）：以「材质上下文 + effect + 绑定内容」为键缓存 `GPUBindGroup`；缓存键必须把**动态偏移**考虑进去，否则同一个 UBO 在不同偏移处会被误判为同一个绑定组——这正是"bind group 缓存 + dynamic offset"这条路线最容易出错的地方。
- `WebGPUCacheRenderPipeline`（**路径已确认**）：把完整管线状态（depth/stencil、blend、光栅化、顶点布局、拓扑……）组织成一棵**状态树**，每个叶子懒创建 `GPURenderPipeline`。文档页存在即证明这是官方设计的核心（B 级）。
- **对齐**：WebGPU 规定 `minUniformBufferOffsetAlignment`（规范原文 B 级：[W3C WebGPU §19](https://www.w3.org/TR/2026/CRD-webgpu-20260310/#19)）。Babylon 的做法（置信度 中）是把从 device limits 读到的对齐值用于一个**共享大 buffer** 的偏移分配——`WebGPUDynamicBuffer` 就是这个分配器：`create(size)` 返回 `{buffer, offset, size}`，内部把偏移向上取整到对齐值，帧末统一 `writeBuffer` 刷出；并用**双缓冲**规避"本帧写入 / 上帧仍在读"的 hazard（双缓冲这一条置信度 中低）。
- **12/16 字节**：任务描述里的"12/16 字节对齐"要区分两件事——(a) `minUniformBufferOffsetAlignment` 是 **device limit**（常见 256，最小允许 32），不是固定 12/16；(b) WGSL 的 **uniform 地址空间布局规则**（`vec3<f32>` 占 16 字节、数组元素 stride 必须 16 的倍数）才是"12 被抬成 16"的来源。这两者叠加：**每个 uniform 块的槽位步长 = align(max(structSize, …), minUniformBufferOffsetAlignment)**。
  - 置信度：中高。**这是一个可自行验证的结论**（见 §8 第 3 条的建议检查项）。

**无法核实**：`_useUbo` 之类的开关、每个材质一个 `GPUBuffer` vs 共享大 buffer + dynamic offset 的**默认值**。不要引用"Babylon 默认用 X"。核实方法见 §10。

### 3.2 three 侧（**A 级，本地可验证**）

three 0.186.1 的 WebGPU 后端**没有** `dynamicOffset` / `minUniformBufferOffsetAlignment` 的处理：

```bash
grep -rn "dynamicOffset\|hasDynamicOffsets" node_modules/three/src/renderers/webgpu/ node_modules/three/src/renderers/common/
# → 无输出
grep -rn "OffsetAlignment" node_modules/three/src/renderers/
# → 无输出
```

（两条 grep 都在本机执行过，均无命中。这是"不存在"的证据，比"搜不到文档"强。）

**含义**：three 的 uniform 走"整块 buffer 绑定 + 应用侧按偏移写"的路线，**alignment 责任在 three 内部的 UniformBuffer 分配逻辑里，而不是显式读 device limit**。这意味着如果本项目将来自己往共享 uniform buffer 里塞数据（例如给 splat 传自定义参数），**必须自己按 `device.limits.minUniformBufferOffsetAlignment` 对齐**，不能指望 three 帮忙。

---

## 4. 资源生命周期、device lost、异步编译

### 4.1 three 的查询池生命周期（A 级，**本项目探针直接相关**）

`node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js` 是理解本项目 GPU 归因能力的**唯一权威**。

**池容量固定 2048，每次分配 2**（`:27`、`:71-87`）：

```js
	constructor( device, type, maxQueries = 2048 ) {
		...
	allocateQueriesForContext( uid ) {

		if ( ! this.trackTimestamp || this.isDisposed ) return null;

		if ( this.currentQueryIndex + 2 > this.maxQueries ) {

			this.resolveQueriesAsync();

			this.currentQueryIndex = 0;
			this.queryOffsets.clear();

		}
```

**溢出时是"丢掉并清空"，不是"阻塞等待"**。清空 `queryOffsets` 意味着溢出前那批 query 的 uid→offset 映射没了——**这就是 `AGENTS.md` §二.8「跨轮次不要比单个数字」和 §5.15「一次 resolve 覆盖 2–9 个应用帧」的代码级根因**。

**返回的是"最后一帧的总和"**（`:207-237`）：

```js
			for ( const [ uid, baseOffset ] of currentOffsets ) {

				const match = uid.match( /^(.*):f(\d+)$/ );
				const frame = parseInt( match[ 2 ] );

				if ( frames.includes( frame ) === false ) {

					frames.push( frame );

				}

				if ( framesDuration[ frame ] === undefined ) framesDuration[ frame ] = 0;

				const startTime = times[ baseOffset ];
				const endTime = times[ baseOffset + 1 ];
				const duration = Number( endTime - startTime ) / 1e6;

				this.timestamps.set( uid, duration );

				framesDuration[ frame ] += duration;

			}

			// Return the total duration of the last frame
			const totalDuration = framesDuration[ frames[ frames.length - 1 ] ];
```

**粒度结论（A 级，硬边界）**：uid 形如 `<prefix>:<id>[:f<frame>]`，而 `prefix` 含 `renderer.info.render.frameCalls`（`common/Backend.js:475-502`）。**一次 `renderer.render(scene, arrayCamera)` 只产生一个 render context → 一对 query**。所以：

> **three 0.186.1 的公开 API 无法给出"4 个视口各自"的 GPU 耗时。** 一趟 ArrayCamera 渲染 = 一个时间戳对 = 一个总时长。

要按视口拆分，只有两条路：(a) 每窗格一次 `gl.render()`（**放弃 ArrayCamera 合批**，退回 4 个 render pass）；(b) 自己建 query set / `timestampWrites`，绕开 three 的池。这是一个需要显式决策的取舍，建议在报告之外做一次专项评估。

**防重入**（`:104-108`、`:142-146`、`:177-181`）：`pendingResolve` 去重 + `mapState !== 'unmapped'` 早退 + 复制后的二次检查。

```js
		if ( this.pendingResolve ) {

			return this.pendingResolve;

		}
```
```js
			if ( this.resultBuffer.mapState !== 'unmapped' ) {

				return this.lastValue;

			}
```

`dispose()`（`:260-327`）会先 await `pendingResolve`、再 `unmap()`、最后 `destroy()` 三个 GPU 对象——**这是"StrictMode-safe"在 three 侧的正确答案：卸载时必须等 pending resolve 落地，否则 `mapAsync` 的 promise 会在 device 已销毁后 resolve**。

### 4.2 device lost（A 级，本项目 + B 级，Babylon）

本项目当前实现 `app/src/shared/rendering/webgpu.ts:75-78`：

```ts
      const backend = this.backend as typeof this.backend & { device: { lost: Promise<{ reason: string; message: string }> } };
      void backend.device.lost.then((info) => {
        if (info.reason === "destroyed" && !this.lifetime.signal.aborted) {
          this.onDeviceLost({ api: "WebGPU", message: info.message || "GPU device was destroyed.", reason: info.reason, originalEvent: info });
```

**注意**：这里只处理 `reason === "destroyed"`（自己 dispose 掉的情况）。WebGPU 规范里 `GPUDeviceLostReason` 只有 `"unknown"` 和 `"destroyed"` 两个值——**真正的 GPU 掉卡/驱动重置是 `"unknown"`**，当前不会被上报。

Babylon 侧（**C 级 + B 级存在性**）：
- B 级：[Module: Device-Lost Recovery（Babylon-Lite）](https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/refs/heads/master/docs/lite/architecture/50-device-lost-recovery.md)
- B 级：[WebGPU Breaking Changes](https://doc.babylonjs.com/setup/support/webGPU/webGPUBreakingChanges)
- C 级（置信度 中）：`WebGPUEngine` 监听 `device.lost`，置内部 lost 标志、通过 `onContextLostObservable` 通知，并尝试重建 device 与全部 GPU 资源；`onContextRestoredObservable` 在恢复后触发。**具体字段名（`_deviceLost` 等）与实现路径需自行确认**——我没有核实，不编造。

### 4.3 异步管线编译不 stall 首帧

**置信度：中**（这是一个**被确证存在**的问题，但 Babylon 的解法我无法读到代码）

B 级证据（问题真实存在的强证据）：
- [Dramatic increase in WebGPU startup time (whenReady) — Babylon.js 论坛](https://forum.babylonjs.com/t/dramatic-increase-in-webgpu-startup-time-whenready/63620/4)
- [Module: Async ShaderMaterial Pipeline Compilation（Babylon-Lite）](https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/refs/heads/master/docs/lite/architecture/53-async-shader-pipeline-compilation.md)
- [Wait for compute shaders to be ready — 论坛](https://forum.babylonjs.com/t/wait-for-compute-shaders-to-be-ready/40851)
- [EngineInstrumentation（含 `captureShaderCompilationTime`）](https://doc.babylonjs.com/typedoc/classes/BABYLON.EngineInstrumentation#captureshadercompilationtime) —— Babylon 有**专门的 instrument 来量 shader 编译时间**，说明他们把编译时间当成一等性能指标。

Babylon 的通用形态（置信度 中）：`engine.isReady()` / `scene.isReady()` 返回"能否出正确画面"；`whenReadyAsync()` 等它变真；材质在 effect/pipeline 未就绪时**跳过绘制而不是阻塞提交**，编译在后台推进（`createRenderPipelineAsync`）。Babylon-Lite 有一篇专门的 async pipeline compilation 文档，说明这套东西在下一代引擎里被重做了——**这是"原实现不够好"的间接证据**。

**Babylon-Lite 值得本项目关注**：`BabylonJS/Babylon-Lite` 是一个**明确按文档化架构重写**的轻量引擎，其 docs 目录结构本身就是一份设计清单：
- [22-engine.md](https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/5866c28478c137abcd33f315c8eed5cea8664598/docs/lite/architecture/22-engine.md)
- [Device-Lost Recovery](https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/refs/heads/master/docs/lite/architecture/50-device-lost-recovery.md)
- [Async Shader Pipeline Compilation](https://raw.githubusercontent.com/BabylonJS/Babylon-Lite/refs/heads/master/docs/lite/architecture/53-async-shader-pipeline-compilation.md)

（这三篇是 raw markdown，但本次 `web_fetch` 打不开——**B 级，仅存 URL**。拿到网络后应优先读这三篇，它们比 Babylon.js 主仓的代码更适合对照设计。）

---

## 5. Babylon.js Editor

### 5.1 结论先行

**`BabylonJS/Editor` 是否显式使用 WebGPU：我无法核实。** 本次环境读不到仓库，`web_search` 也只能给 URL。**因此本报告不声称编辑器用了或没用 WebGPU。** 请在拿到网络后按 §10 第 6 条核实。

可确认的是：Editor 的预览面板用的是 Babylon 的 `EngineFactory`，而 `EngineFactory.CreateAsync` 支持在 options 里选择 backend：

- B 级：[Class EngineFactory](https://doc.babylonjs.com/typedoc/classes/_babylonjs_core.EngineFactory)

**这是"编辑器可能可以切 WebGPU，但需要确认默认值"的证据，不是"它用了 WebGPU"的证据。** 区别很重要。

### 5.2 结构（**B 级，只有章节标题可证**）

DeepWiki 上 Editor 的目录结构（这些页面存在，说明对应代码模块存在，但**具体文件路径我无法核实**）：

| DeepWiki 页面 | 可推断的模块 |
| --- | --- |
| [1-overview](https://deepwiki.com/BabylonJS/Editor/1-overview#1) | 仓库总览 |
| [2.1-package-ecosystem](https://deepwiki.com/BabylonJS/Editor/2.1-package-ecosystem#1) | 包结构（monorepo / 多包） |
| [3.1-editor-core](https://deepwiki.com/BabylonJS/Editor/3.1-editor-core#1) | 编辑器核心 |
| [6-editor-ui-components](https://deepwiki.com/BabylonJS/Editor/6-editor-ui-components#1) | UI 组件（React） |
| [6.2-preview-panel](https://deepwiki.com/BabylonJS/Editor/6.2-preview-panel#1) | **预览面板 = 视口** |
| [6.3-tools-toolbar](https://deepwiki.com/BabylonJS/Editor/6.3-tools-toolbar#1) | 工具栏 |
| [14-glossary](https://deepwiki.com/BabylonJS/Editor/14-glossary#1) | 术语表 |

- 技术栈（置信度 中）：React + TypeScript + Redux；编辑器应用在 `src/editor/`，可复用工具库在 `src/tools/`。**这两个路径是 C 级，路径需自行确认。**
- 许可（置信度 中）：Apache-2.0。

### 5.3 仍未核实的具体机制（**不要引用**）

以下我**知道有这类能力但无法核实 Editor 的具体实现**，全部标"需自行确认"，本报告不给文件路径、不给行号：

- **视口**：预览面板里 Babylon 侧多视口（单视图 / 四视图切换）——是否有、怎么切，未核实。
- **Gizmo**：Babylon 的 `GizmoManager` / `PositionGizmo` / `RotationGizmo` / `ScaleGizmo` + utility layer。Editor 用它还是自研，未核实。
- **选择描边**：Babylon 有 `HighlightLayer`、`OutlineRenderer`；Editor 用哪个，未核实。
- **缩略图 / 截图**：Babylon 的官方 API 是 `CreateScreenshotUsingRenderTarget` / `Tools.CreateScreenshot`（B 级：[typedoc](https://doc.babylonjs.com/typedoc/functions/BABYLON.CreateScreenshotUsingRenderTarget)、[Render Scenes To .png Files](https://doc.babylonjs.com/features/featuresDeepDive/scene/renderToPNG#gif-creation)）。Editor 的资产缩略图很可能走这条，**但未核实**。
- **撤销/重做**：Editor 有一个 `Undo` 栈抽象。未核实。
- **资产加载**：Editor 有 asset browser + 本地/云端资产库。未核实。

### 5.4 即使 Editor 只用 WebGL，仍然可迁移的部分（**这部分是安全的**）

以下结论不依赖 Editor 的源码，只依赖 Babylon 引擎本身的公开 API 存在性（B 级）与本项目已核对过的 three 行为（A 级）：

1. **"视口 = 相机 + viewport 矩形 + layer mask"这个三元组**是跨引擎成立的抽象。Babylon 的 `camera.viewport` / `camera.layerMask` 与本项目的 `subCamera.viewport` / `subCamera.layers.mask` 语义同构。
2. **离屏截图必须用独立 RenderTarget + 异步读回，不能同步等待**。Babylon 的 `CreateScreenshotUsingRenderTarget` 与 three 的 `copyTextureToBuffer` + `mapAsync` 是同一个形状；本项目的 `CaptureQueue` + `capture.ts` 私有 RenderTarget 已经在这条路上。
3. **工具层与引擎层分离**（gizmo / 选择 / 撤销 / 资产缓存不依赖渲染后端）是 Editor 的结构性选择，也是本项目 `overlay Scene` / `HUD Scene` 分离做法的同构物。
4. **GPU 时间不能靠 CPU 测**——Babylon 有 `EngineInstrumentation` + `PerformanceMonitor` + 专门的 timestamp 类，说明这是业界共识而非本项目特例。

---

## 6. 性能剖析工具

### 6.1 Babylon 侧

| 工具 | 证据 | 置信度 |
| --- | --- | --- |
| `PerformanceMonitor`（`sampleFrame` / `averageFrameTime` / `averageFPS` / `addCustomMetric`） | [Class PerformanceMonitor](https://doc.babylonjs.com/typedoc/classes/_babylonjs_core.PerformanceMonitor) | 高（存在） |
| `EngineInstrumentation`，含 `captureShaderCompilationTime` | [Class EngineInstrumentation](https://doc.babylonjs.com/typedoc/classes/BABYLON.EngineInstrumentation#captureshadercompilationtime) | 高（存在） |
| GPU 帧时间计数器 | [PR #16159 `NativeEngine captureGPUFrameTime + getGPUFrameTimeCounter`](https://github.com/BabylonJS/Babylon.js/pull/16159) | 中——**注意这是 React Native 的 `NativeEngine`**，不能直接当作 Web 端 API |
| `WebGPUTimestampQuery` | 类名（C 级）；**路径与 API 未核实** | 中低 |
| Inspector 里的 GPU 时间 | **未核实**。Inspector 的 Performance 页基于 `PerformanceMonitor`，但它是否显示 GPU 时间、以及从哪取，我没有证据 | 低 |

### 6.2 ⚠️ 关于 `engine.getGPUTimeMs()` —— **这个 API 我没能证实存在**

任务描述里写了 `engine.getGPUTimeMs()`。我做了专门的搜索：

```
web_search "Babylon.js getGPUTimeMs engine method"
```

**没有返回任何直接命中**（返回的都是 `EngineInstrumentation`、`WebGPUEngineOptions`、`WebGPUDrawContext`、`PerformanceMonitor`、Babylon-Lite 的 engine 文档）。搜索无命中**不能证明它不存在**，但足以要求：

> **在引用 `engine.getGPUTimeMs()` 之前必须自行核实。本报告不对它做任何断言。**
> 更可能存在的 API 是 `EngineInstrumentation.captureGPUFrameTime` + `getGPUFrameTimeCounter`（PR #16159 的标题）与 `WebGPUTimestampQuery`。

这条对**本项目有直接价值**：本项目的 GPU 时间归因已经踩过"API 不存在/粒度不对"的坑（`AGENTS.md` §二.5–§二.12），凡是没在本地代码里验证过的 API 名，都不该进文档。

---

## 7. 官方文档与最佳实践（**B 级：页面存在，正文未读**）

**WebGPU 性能/最佳实践**
- [WebGPU Snapshot Rendering](https://doc.babylonjs.com/setup/support/webGPU/webGPUOptimization/webGPUSnapshotRendering) —— **多视图性能的首选参考**，请优先读正文
- [WebGPU Support](https://doc.babylonjs.com/setup/support/webGPU/)
- [WebGPU Breaking Changes](https://doc.babylonjs.com/setup/support/webGPU/webGPUBreakingChanges)

**WebGPU 内部实现（设计文档，对标本项目的缓存策略）**
- [Internals - Overview](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUOverview)
- [Internals - Bind Group Cache](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUCacheBindGroup/#cache-implementation)
- [Internals - Render Pipeline Cache](https://doc.babylonjs.com/setup/support/webGPU/webGPUInternals/webGPUCacheRenderPipeline/)

**多视图**
- [Using Multiple Canvases](https://doc.babylonjs.com/features/featuresDeepDive/scene/multiCanvas#multi-scenes)
- [MultiViews Part 2](https://doc.babylonjs.com/features/featuresDeepDive/cameras/multiViewsPart2/#example-pg--4JXV32)

**截图 / 性能 API**
- [Render Scenes To .png Files](https://doc.babylonjs.com/features/featuresDeepDive/scene/renderToPNG#gif-creation)
- [CreateScreenshotUsingRenderTarget](https://doc.babylonjs.com/typedoc/functions/BABYLON.CreateScreenshotUsingRenderTarget)
- [Class PerformanceMonitor](https://doc.babylonjs.com/typedoc/classes/_babylonjs_core.PerformanceMonitor)
- [Class WebGPUEngineOptions](https://doc.babylonjs.com/typedoc/interfaces/BABYLON.WebGPUEngineOptions)

**移植回顾（一手叙述）**
- [Porting Babylon.js for WebGPU（Khronos）](https://www.khronos.org/developers/linkto/porting-babylon.js-for-webgpu-microsoft)

**关于"官方 blog 里的 snapshot rendering 具体数字"**：我**没有**找到可确认的 blog 页。官方 doc 页存在，但**数字必须从正文抄**，本报告不转述、不估算。第三方学术来源（如 [his.diva-portal.org 的 WebGL/WebGPU/three 对比论文](https://his.diva-portal.org/smash/get/diva2:1984179/FULLTEXT01.pdf)）在搜索里反复出现，但**其方法与机器条件不明，不建议引用其数字**。

---

## 8. 本项目可直接对照的 A 级事实清单

这一节是本报告**唯一全部可本地验证**的部分。每条都给了文件和行号，可用 `read` 直接复核。

| # | 事实 | 位置 |
| --- | --- | --- |
| 1 | WebGPU 的 `updateViewport` / `updateScissor` **无输入缓存**，每次都下发 | `WebGPUBackend.js:1659-1680` |
| 2 | WebGPU 的 viewport **不翻转 Y**；WebGL 的 `updateViewport`/`updateScissor` 与 ArrayCamera 子相机路径**都翻转** | `WebGPUBackend.js:1664,1678`；`webgl-fallback/WebGLBackend.js:711,725,1329-1334` |
| 3 | viewport 等于整屏时**不发** pass 级 viewport | `common/Renderer.js:1787`；`WebGPUBackend.js:1115-1125` |
| 4 | ArrayCamera 分支**逐对象 × 逐子相机**无条件 `pass.setViewport` | `WebGPUBackend.js:2264-2297` |
| 5 | 同循环里的 `cameraIndex` bind group **有**缓存；`cameraData.indexesGPU` 仅在相机数变化时重建 | `WebGPUBackend.js:2237-2258, 2300-2311` |
| 6 | `_draw` 缓存 pipeline / bind group / index / vertex buffer / stencil ref / blend constant——**不含 viewport/scissor** | `WebGPUBackend.js:2019-2100` 区间（`:2028`、`:2050` 为判据行） |
| 7 | 时间戳池 2048、每次 2 个；溢出时 `resolve` 并**清空 offsets** | `utils/WebGPUTimestampQueryPool.js:25-27, 71-87` |
| 8 | resolve 返回**最后一帧**的总和，并按 `frame` 分组累加 | `utils/WebGPUTimestampQueryPool.js:207-237` |
| 9 | uid = `prefix:id:f<frame>`，prefix 含 `render.frameCalls` → **一次 `render()` 一对 query** | `common/Backend.js:475-502`；`WebGPUBackend.js:943, 2585-2605` |
| 10 | resolve 防重入：`pendingResolve` 去重 + `mapState !== 'unmapped'` 早退 | `utils/WebGPUTimestampQueryPool.js:104-108, 142-146, 177-181` |
| 11 | `dispose()` await pending、unmap、再 destroy | `utils/WebGPUTimestampQueryPool.js:260-327` |
| 12 | three 的 WebGPU 后端**不处理** `dynamicOffset` / `minUniformBufferOffsetAlignment` | `grep -rn "dynamicOffset\|OffsetAlignment" node_modules/three/src/renderers/` → 无命中 |
| 13 | three 有完整的 **render bundle** 路径，但**只对 layered array depth** 生效（要求 `depthTexture.isArrayTexture && camera.isArrayCamera`）；且 bundle **不支持 `setViewport`** | `WebGPUBackend.js:503-509, 1086-1100, 1167-1193, 1401-1423, 1464-1482, 2284` |
| 14 | 本项目 device lost 只处理 `reason === "destroyed"` | `app/src/shared/rendering/webgpu.ts:75-78` |

**第 13 条值得单独强调**：three **已经有** GPU render bundle 这个"把命令编码离线化"的机制——这正是 Babylon snapshot rendering 的同类原语。但它的启用条件是 `depthTexture.isArrayTexture === true`（`WebGPUBackend.js:507`）：

```js
	_isRenderCameraDepthArray( renderContext ) {

		const camera = renderContext.camera;

		return renderContext.depthTexture && renderContext.depthTexture.isArrayTexture === true && camera !== null && camera.isArrayCamera === true;
```

也就是说：**画布多视口（本项目现在的形态）走不到 bundle 路径**；只有"渲染到一个分层纹理（array layer per 视口）"才走得到。而且 bundle 内**不能 `setViewport`**（`:2284` 的注释 + `:2286` 的 `! isBundleEncoder`），bundle 路径的 viewport 只能来自每层的 render pass（`:1464-1469`），用的是 `renderContext.viewportValue`（整画布）。

> **这是一个真实的、可选择的架构分叉**：如果本项目要为多视口拿回 GPU 侧的编码摊销，路径是"**每个窗格渲染到分层纹理的一层，然后用 bundle 重放**"——代价是 4 个视口的结果落在 array texture 里，要额外一次合成才能上屏。**在动手前必须先测量**：当前瓶颈不是"编码开销"（`AGENTS.md` §六已证 JS `shareOfWall` 中位 0–7.1%、GPU 利用率 22%–33%），所以这条大概率**不是**当前该走的路。

---

## 9. 对本项目的可操作结论

> 前置声明：`AGENTS.md` §六 已确认「≥3 个全分辨率 splat 视图塌缩」**根因未定位**，且已排除 GPU 饱和（`gpuUtilization` 22%–33%）与 JS 限速（`scriptShare` 中位 0–7.1%）。**下面的建议不得被解读为"能修掉那个塌缩"**；它们只针对可独立验证的局部问题。每条都给了可执行的检查动作。

**① 先量 `setViewport` 的真实调用次数，再决定要不要动它**
现状（A 级，§8 第 4 条）：`WebGPUBackend.js:2264-2297` 对每个可绘制对象 × 每个子相机无条件 `pass.setViewport`。
检查动作：在 `gpuProbe.browser.ts` 的采样窗口里 monkey-patch `GPURenderPassEncoder.prototype.setViewport` 计数，4 视口下与 `renderer.info.render.calls` 对照。**预期是 `calls × 视图数`**。若 N 很小（当前核心场景 1 draw + splat 1 draw），**结论会是"不值得改"**——那就写进文档，避免下次重复讨论。
风险：改 three 需要补丁，而 `AGENTS.md` §二.14 规定 `patches/` 只碰**释放路径**。**所以这条建议的默认结论是"只记录，不修"。**

**② 不要试图从 three 现有 API 里拆出"每窗格 GPU 时间"**
A 级硬边界（§8 第 9 条）：一次 `render()` 只有一对 query。任何"4 个视口各自 GPU 时间"的读数在当前架构下**不可能来自 `resolveTimestampsAsync`**。
检查动作：确认 `gpuProbe.ts` 里没有把某个 resolve 结果标注成"per-viewport"。若需要 per-viewport，必须先决策"是否放弃 ArrayCamera 合批换 4 个 pass"——**这是一个 A/B 实验，不是顺手改**。

**③ splat 的自定义 uniform 必须自己对齐**
three 的 WebGPU 后端不读 `minUniformBufferOffsetAlignment`（§8 第 12 条）。
检查动作：若 `SplatModel` 或 GSL 侧往共享 buffer 里写 per-view 数据（每眼参数），把偏移按 `renderer.backend.device.limits.minUniformBufferOffsetAlignment` 向上取整，并加一条断言。**注意 WGSL uniform 地址空间的 16 字节规则与 device limit 是两件事，取两者之最大值。**

**④ 把 `reason === "unknown"` 纳入 device lost 处理**
现状（§8 第 14 条）：只处理 `"destroyed"`。
检查动作：`app/src/shared/rendering/webgpu.ts:76` 的判断改为对真实掉卡也上报，并明确"重建 device 时哪些对象必须一起重建"——至少包括：`ARRAY_CAMERA_CAPACITY`（`paneViewports.ts:15`）、时间戳查询池、`capture.ts` 的私有 RenderTarget。**这是 StrictMode 双挂载之外的第二条重建路径，目前没有测试覆盖。**

**⑤ 卸载时必须 await pending timestamp resolve**
three 自己在 `dispose()` 里 await（§8 第 11 条）。检查动作：确认本项目的探针/渲染器 dispose 路径没有在 `pendingResolve` 未落地时销毁 device（否则 `mapAsync` 的 promise 在 device 销毁后 resolve，属未定义行为）。本项目已有 dispose 顺序审查（`VIEWPORT_REVIEW.md` §〇），把这条作为一项加进去。

**⑥ 视图port 原点约定固化为函数 + 单测**
A 级（§8 第 2 条）：WebGL 翻转、WebGPU 不翻转，**三条下发点都不同**。检查动作：`paneViewports.ts` 里对 viewport 的赋值应只有一个出口；加一条测试直接断言"WebGPU 路径没有 `height - h - y`"。这条防的是**未来有人从 WebGL 示例抄代码**——比现在的 bug 更可能发生。

**⑦ 不要照搬 Babylon 的 snapshot rendering 到交互帧**
机制要求场景静态（§1.3）。检查动作：如果要做，只对"每帧渲染多次且内容不变"的子集（例如背景网格/环境）启用，并且**明确排除 splat**（排序是脏标记驱动）。同时：**不要引用任何未抄录原文的倍数**。

**⑧ 首帧不 stall：先确认 three 用不用 `createRenderPipelineAsync`**
检查动作（一条命令）：
```bash
grep -rn "createRenderPipelineAsync\|createComputePipelineAsync" node_modules/three/src/
```
如果**没有**命中，说明 three 0.186.1 的管线创建是同步的 → 首帧/首次材质加载会 stall。对应的缓解是"预编译/预热到缓存"，可以复用 repo 已有的 `ModelResources` 预热钩子。Babylon 论坛那篇 [`Dramatic increase in WebGPU startup time (whenReady)`](https://forum.babylonjs.com/t/dramatic-increase-in-webgpu-startup-time-whenready/63620/4) 是这个问题真实性的外部佐证。
**若 grep 有命中，则本条的优先级立刻下降**——所以先 grep，再决定。

**⑨ 把"分层纹理 + render bundle"记为一个明确的、暂缓的架构选项**
A 级（§8 第 13 条）：three 的 bundle 路径**存在但只在 layered array depth 下可达**，且 bundle 内不能 `setViewport`。
检查动作：不要现在实现。写一条待评估项，触发条件是"实测显示命令编码/`setViewport` 成为瓶颈"。**当前测量（GPU 22%–33%、JS 0–7.1%）不支持这个触发条件。**

**⑩ 给文档加一条"不可引用的 API 名"清单**
本次调研的教训：`engine.getGPUTimeMs()` 无法证实（§6.2）。检查动作：在 `WEBGPU_FINDINGS.md` 里加一节"未经本地/一手来源核实的 API 名"，第一条就是它。**这直接落实 `AGENTS.md` 第七节检查清单的最后一条——不要把作废/未核实的结论写回文档。**

---

## 10. 拿到网络后的核实清单（按优先级）

1. **读 Babylon 的 snapshot rendering 正文并抄录数字 + 场景条件**
   `https://doc.babylonjs.com/setup/support/webGPU/webGPUOptimization/webGPUSnapshotRendering`
2. **读 Babylon-Lite 三篇架构文档**（raw markdown，比主仓代码更适合对照设计）
   `.../docs/lite/architecture/22-engine.md`、`50-device-lost-recovery.md`、`53-async-shader-pipeline-compilation.md`
3. **确认 WebGPU 侧子模块的真实路径**（先 clone 再 grep，一次搞定）：
   ```bash
   git clone --depth 1 https://github.com/BabylonJS/Babylon.js /tmp/bjs
   cd /tmp/bjs && ls packages/dev/core/src/Engines/ packages/dev/core/src/Engines/WebGPU/
   grep -rn "class WebGPUDynamicBuffer\|class WebGPUTimestampQuery\|class SnapshotRenderingHelper" packages/dev/core/src/
   grep -n "minUniformBufferOffsetAlignment" -r packages/dev/core/src/Engines/
   grep -n "createRenderPipelineAsync\|createComputePipelineAsync" -r packages/dev/core/src/Engines/WebGPU/
   grep -rn "getGPUTimeMs" packages/dev/core/src/     # 验证 §6.2
   ```
4. **给 `WebGPUEngine` 的 device lost 找准确入口**
   ```bash
   grep -n "device.lost\|_deviceLost\|onContextLostObservable\|onContextRestoredObservable" packages/dev/core/src/Engines/webgpuEngine.ts packages/dev/core/src/Engines/abstractEngine.ts
   ```
5. **确认 `registerView` / `views` 在 WebGPU 下的现状**
   ```bash
   grep -rn "registerView\|_views\b\|get views" packages/dev/core/src/Engines/abstractEngine.ts packages/dev/core/src/Engines/webgpuEngine.ts
   ```
6. **确认 Editor 是否用 WebGPU、以及各功能模块的真实路径**
   ```bash
   git clone --depth 1 https://github.com/BabylonJS/Editor /tmp/bje
   cd /tmp/bje && ls src/ && grep -rn "EngineFactory\|WebGPU" src/editor/ --include=*.ts --include=*.tsx | head -40
   grep -rln "GizmoManager\|HighlightLayer\|CreateScreenshot" src/ | head -20
   ```
7. **把上面所有 A 级行号对应的 three 上游 permalink 补齐**（用 `r186` tag 或 `0.186.1` 对应 sha 逐条核对行号后再写进文档）。

---

## 附：本报告的证据分级索引

| 级别 | 含义 | 可复核方式 |
| --- | --- | --- |
| A | 本地源码，有文件 + 行号 | `read node_modules/three/...` 或直接 grep |
| B | `web_search` 返回 URL，页面/文件存在性可证 | 点开 URL（需网络） |
| C | 我的既有知识，**逐条标了置信度** | §10 的核实命令 |

**本报告没有编造任何 Babylon 的行号。** 凡是 B/C 级的内容，都给的是路径或类名 + 置信度标注 + 核实方法。

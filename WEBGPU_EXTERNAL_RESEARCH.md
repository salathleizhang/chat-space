# WebGPU 性能与 macOS/Metal 帧节奏诊断（收敛版）

调研日期：2026-10-01 · three 0.186.1 / macOS Apple Silicon / Chrome / 多视口 / Gaussian splats

## 〇、方法与标记
本轮网络全断（国际域名解析到 `198.18.0.x`；`web_fetch` 被策略拒绝；bash 无国际出口；`web_search` 只回标题+URL，无正文）。
**没有任何一条英文原始页面正文被读取。** 标记：✅本地源码（本机 three，给行号）· ⚠️本仓库文档已核实记录（非我独立复现）· ❌未能验证（我的知识，附置信度，勿当已证事实）。

## 一、来源（仅保留确认存在的链接，正文均未读 ❌）
1. https://toji.dev/webgpu-profiling/xcode
2. https://toji.dev/webgpu-profiling/timestamp-queries
3. https://toji.dev/webgpu-best-practices/buffer-uploads.html
4. https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
5. https://developer.chrome.com/blog/new-in-webgpu-141
6. https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgpu/gpu_supported_features.idl ← 核对 Metal 支持哪些 GPUFeatureName 的权威文件
7. https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/debugging_chrome_gpu_with_xcode.md
8. https://chromium.googlesource.com/chromium/src/+/3be046eb366f53a6609f93ed05fd7f7b6f85f945/components/viz/common/switches.cc ← 核对帧率/vsync 类 switch 的位置
9. https://webgpufundamentals.org/ （源码 https://github.com/webgpu/webgpufundamentals ）
10. https://keith.github.io/xcode-man-pages/gpucapture.1.html
11. https://chromewebstore.google.com/detail/webgpu-inspector/holcbbnljhkpkjkhgkagjkhhpeochfal
12. https://gpuweb.github.io/gpuweb/

未确认：toji 仓库**页面清单无法枚举**；`pipeline-caching`/`debugging`/`canvas-sizing`/`timestamp-queries`(.md) 未核实；"All of the cores, none of the canvas"/"Subgroups"/"Buffer Mapping" 的 URL **未找到（不编造）**；Apple/MS/Intel 的 WebGPU 性能指南**未能证实存在**。

## 二、Timestamp queries（✅ 本机源码，本节最可靠）
- **2048 是 three 的选择**，非规范/GPU 限制：`WebGPUBackend.js:2592`（上行注释 `// TODO: Variable maxQueries?`）；基类默认 256（`common/TimestampQueryPool.js:15`）。**render 与 compute 各一池**（`:2589-2592`，调用点 `:943` / `:1866`）——即此前 `gpuUtilization` 漏算 compute 池的原因。
- 每 pass 2 个 query：`:2598-2604`（begin/end write index）。用 **pass descriptor `timestampWrites`（baseline）**，**不用** `timestamp-query-inside-passes`。
- **重置后果**（我们踩过的坑）：`WebGPUTimestampQueryPool.js:71-78` 在 `currentQueryIndex+2 > maxQueries` 时调 `resolveQueriesAsync()`（**未 await**）后归零并 `queryOffsets.clear()` → ①上一批未 resolve 的时间戳**永久丢失**；②`_resolveQueries` 开头 `mapState!=='unmapped'` 时**静默返回陈旧值**（`:142`），对应 `WEBGPU_FINDINGS.md:38`；③返回值是**这一批最后一个 frame 的求和**（`:231`），而 `timestamps` 含该批所有帧（`:224`）→ `getTimestamp(uid)` 可能更早。2048÷2=1024 pass/池，4 窗格 ≈128 帧一次重置。
- **每帧读回必 stall**：`resolveQuerySet → copyBufferToBuffer → submit → await mapAsync`（`:158-184`）。⚠️实测每次等 **211 ms（1 视图）/ 518 ms（4 视图）**，~5 Hz 采样上限（`WEBGPU_FINDINGS.md:28` 第 12 条）。→ 用 three 做不到按应用帧对齐，**不要试图优化这条**。
- 门控：`:298` 需 `timestamp-query` feature；但 `get hasTimestamp()` **恒 true**（`:394-398`），别当探测用；构造期决定（`app/src/shared/rendering/webgpu.ts:19`，`?gpuTimestamps=1`）。
- ❌ **Metal 是否支持 `timestamp-query-inside-passes` 未核实**（可查链接 6 与 gpuweb `proposals/timestamp-query-inside-passes.md`，后者路径存在 → feature 名真实，但实现/Metal 支持未核实，低置信）。

## 三、macOS 工具
- ⚠️ Xcode Metal Debugger（唯一抓帧器，`AGENTS.md:123-127` + 链接 1）：需**可附加调试器的 Chrome 构建**、`--disable-gpu-sandbox`、`MTL_CAPTURE_ENABLED=1`、`--enable-dawn-features=use_user_defined_labels_in_backend`、**attach GPU 进程 PID**、**抓完浏览器必挂需重启**。three **不发 pushDebugGroup（0 处）但设了 label**（~23 处在真实渲染描述符上）→ 给应用自己的资源命名，别打引擎补丁；swapchain 纹理无法命名。
- ⚠️ **RenderDoc 不支持 Metal**（`AGENTS.md:125`；我的知识中—高置信）。对照物 Pix（Windows/D3D12）。
- ✅ `gpucapture` CLI 文档存在（参数 ❌未核实，低—中置信）。
- ❌ **Chrome DevTools WebGPU 面板未能验证存在**（倾向"没有"）；可验证的是 WebGPU Inspector 扩展。❌ Perfetto `gpu` track 的 WebGPU 明细粒度未核实。❌ **Instruments/Metal System Trace 能否 attach Chrome GPU helper 进程未核实（低置信）**。

## 四、帧节奏 / vsync 整数倍（出处与推断分开）
⚠️ 本仓库证据（不依赖外部页面）：12 轮（motion 0/1 × 3 × 1/4 视图，全 valid）帧间隔**只出现 2/3/6/7/8/9× vsync，无例外**；`gpuUtilization` 20.8–48.6%；`scriptShare` 中位 0–7.1%。同会话三点曲线 1/2/4 窗格 = **16.8/33.3/83.4 ms（1/2/5× vsync）** 而 GPU 恒 22–25% → **每多一窗格 ≈ +1 vsync，GPU 只多干几 ms**（`WEBGPU_FINDINGS.md:31`）。"每视图各等一次呈现"**已证伪**（相邻呈现 p50 0.4–0.6 ms）→ **等待在帧与帧之间**（`:45`）。

- **有出处（仅 URL 佐证）**：`desiredMaximumFrameLatency` 在 wgpu 侧真实存在（https://github.com/gfx-rs/wgpu-native/issues/401 ）；Chromium 的帧率/vsync 类 switch 位于链接 8。
- **我的推断，无出处**：错过一次 vsync 边界即需等下一次，连续错过 N 次 → N× vsync 整数台阶；叠加交换链队列背压 → "整数倍 vsync + GPU 空闲"。
- 旋钮：`configure({alphaMode})` ✅`WebGPUBackend.js:354-366`（且 `webgpu.ts:39-41` 指出 **alpha canvas 的合成器混合成本不进 three 的 timestamp**）；`desynchronized`(WebGPU) ❌未核实（中置信：`GPUCanvasConfiguration` 无此成员）；`--enable-unsafe-webgpu` ❌未核实（中—高置信存在）；**`--disable-frame-rate-limit` ❌存在性低—中置信，勿用**；device descriptor three 只传 `requiredFeatures`+`requiredLimits`，且 `requiredFeatures` **等于适配器全部 feature**（`:231-250`）→ 无法调优。

## 五、命令编码 / draw 开销（✅ 本机源码）
- bind group 与多视口相机索引绑定**均已去重**（`:2050-2055`、`:2300-2311`）。
- **bundle 与多视口冲突**：源码注释 `GPURenderBundleEncoder does not support setViewport, only GPURenderPassEncoder does`（`:2284`）→ 只能"每窗格一 bundle + pass 上设 viewport"；`isBundleGroup` 才启用（`Renderer.js:3338`）。
- **无 staging ring**：全库 `copyBufferToBuffer` 仅 3 处（`:1555`、`WebGPUTimestampQueryPool.js:166`、`WebGPUAttributeUtils.js:463`）→ 上传全走 `queue.writeBuffer`。
- uniform 路径**合并相邻 updateRanges**（`WebGPUBindingUtils.js:220-247`）；**attribute 路径不合并**，每 range 一次 writeBuffer（`WebGPUAttributeUtils.js:241-268`）。大缓冲用 `mappedAtCreation`（`:161-172`）。
- three **完全不用 dynamic offsets**（5 处 `setBindGroup` 均 2 参）。
- ❌ toji `buffer-uploads` 具体建议未核实（我的印象：小/一次性用 writeBuffer，高频大数据用 staging ring；置信度中）。

## 六、异步 / 管线编译（✅ 本机源码）
默认**同步**（`promises===null` → `createRenderPipeline`，`WebGPUPipelineUtils.js:260-262`）；**异步仅**在 `compileAsync()`（`:291` / `:448`，`Pipelines.js:399-402` 注释）。两路径都包 error scope（`:252/266`、`:405/423`）。`getCompilationInfo` **仅在错误路径**调用（`:511-535`）→ **成功时拿不到 warning**。**`pipelineCache` 在 three 中 0 命中**；❌规范是否有 `GPUPipelineCache`、Chrome/Dawn 是否有磁盘缓存，均未核实。

## 七、对本项目的可操作结论
1. **优先做 `?opaque=1`（`alphaMode:'opaque'`）交替 A/B**：直接改合成器混合路径，而同口径证据指向"提交→呈现→下一次 rAF"（`webgpu.ts:39-52` + `FINDINGS:31`）。
2. **以 `presents` 为改动准入门槛**：只降 `submits` 不降 `presents` 不可能改善帧间隔（4 窗格基线 renders 7.96 / presents 8.96 / submits 22.13）。
3. bundle 能压 `submits`、**不能**压 `presents`；且 viewport 必须在 pass 上设（`:2284`）。
4. **绝不每帧 resolve 时间戳**（211/518 ms、~5 Hz）；要按帧粒度只能换 instrument。
5. timestamp 只读 `paired` 行、每轮全新页面加载（2048 池约 128 帧重置）。
6. 首帧/切布局用 `renderer.compileAsync()` 预热；别指望 three 报编译 warning。
7. 把 attribute 的 updateRanges 连续化以减少 `writeBuffer`（uniform 已自动合并）。
8. 剖析显示上传瓶颈时**必须自建** staging ring，引擎不提供。
9. Metal 抓帧放最后（4 flag + attach GPU 进程 + 抓完必挂重启）；先用尽 window-paired / io 计数 / `scripts[].duration`。
10. **元结论**：核实权威事实只有四处 —— feature 名→链接 6；vsync switch→链接 8；Dawn toggle→Dawn `docs/dawn/debugging.md`；规范成员→链接 12。所有 ❌ 条目须经此复核才能进代码或文档。

## 八、未能验证（勿当已证）
英文原始页面正文（全部）；toji 仓库页面清单及 4 个 .md 文件名；3 篇 toji 文章的 URL；Apple/MS/Intel 指南是否存在；`--enable-unsafe-webgpu` 与 `--disable-frame-rate-limit` 的有效性；`desynchronized`(WebGPU) 与 `desiredMaximumFrameLatency`(规范/Chrome)；Metal 的 `timestamp-query-inside-passes`；DevTools WebGPU 面板；Perfetto gpu track 粒度；Instruments attach Chrome GPU 进程；`gpucapture` 参数；整数倍 vsync 的**外部**权威解释（§四为我的推断）。

# ChatSpace WebGPU 全面迁移设计

设计日期：2026-09-26。实施记录更新：2026-09-28。

状态：**WebGPU-only 后端迁移已进入真实资产回归阶段；整份架构优化和发布验收尚未完成。** 下方第 1–9 节保留目标设计，不能将其中的目标读成已交付结果。以本节实施记录为准。

## 0. 实施记录与设计差异

### 已落实的代码

| 范围 | 实际实现 |
| --- | --- |
| 固定版本 | Three.js 0.186.1、@types/three 0.186.0、Gaussian Splat Lite 1.1.5；移除直接 Spark 依赖，更新 lockfile |
| 所有 3D surface | 主视口、模型预览、缩略图均使用 `WebGPUCanvas`；通过 Three 的公共 Renderer + WebGPUBackend + StandardNodeLibrary 组装，不注册 WebGL fallback |
| 初始化与错误 | 安全上下文与 GPU 检查、15 秒初始化超时提示、设备丢失提示与手动重建；StrictMode 下复用初始化，卸载后释放设备；超时的不可取消请求完成后释放迟到设备，失败初始化不会在 dispose 中再次启动 |
| Splat | GSL 原生 WebGPU，当前世界生命周期内保留四个独立视图 renderer/排序状态（非当前布局的 renderer 隐藏但不销毁），引用计数共享解码源；世界卸载时统一释放；源 URL 纳入资源代次；失败重试有限次 |
| collider GLB | 与 Splat 共用 `worldTransform` 的 flipY/scale/offset；**100% 透明——挂载但不绘制**（`WorldColliderMesh` 的 `COLLIDER_VISIBLE = false`，走 three `_projectObject` 的 `visible === false` 子树早退，零绘制提交）、不参与拾取；不释放 loader 缓存共享几何 |
| 多视图与控件 | WebGPU 顶部起点的 viewport/scissor；1/2/4 视图；TSL 网格；主视口和预览坐标轴不依赖 WebGL capabilities |
| 共享核心场景 | 单份 SceneContents、模型实例、动画更新、SplatMesh 和 collider；视图只保留相机、拾取代理、Gizmo/HUD 与独立高斯排序器；布局切换不重建核心资产 |
| 统一调度 | ProjectRenderRuntime 统一执行各视图 scene→HUD；CaptureQueue 跨 renderer 串行调度截图批次，检查图优先、交互短暂让行、1.5 秒老化防饥饿、16 个待处理上限、取消与一次结算 |
| 截图资源保护 | 128 MiB 估算申请预算，读回与目标释放后归零；拒绝非法/超大尺寸；此预算不代表整个项目显存预算 |
| 模型缓存 | 主场景、collider、缩略图和预览共用资源租约；闲置缓存按 128 MiB / 8 项 / 30 秒 TTL 淘汰，共享几何/材质/纹理最后一个所有者释放后才销毁；使用中的资产不强制淘汰，尚无全项目准入预算 |
| 天空盒资源换代 | 主视口背景/IBL 与天空盒缩略图统一使用含 resourceRevision 的 URL，避免原位修复后复用旧纹理；保持 HDR/EXR/图片 loader 分派和共享租约 |
| 依赖释放修补 | 固定 Three.js 的计算属性 dispose 监听，以及 GSL 的编译占位纹理释放；Bun patchedDependencies 保存可复现补丁，见 patches/README.md |
| 截图 | 私有 RenderTarget、异步读回、GPU 行填充解包；读回前恢复显示渲染状态；输出 pass 色调映射与 sRGB 只执行一次 |
| 四视角自检 | 四个相机在同一 JS 任务内提交，随后并行等待读回，避免中途动画/编辑变化；保留 PNG/base64 协议和标签 |
| 许可证 | GSL LICENSE、NOTICE、THIRD_PARTY_LICENSES.md 原样随静态构建发布 |

collider 只是地形参照（最初渲染成线框 → 半透明实体 → 现按用户口径 **100% 透明**：挂载但不绘制），**不是已接入的角色物理碰撞系统**。此次迁移没有新增 Rapier 或 GPU 碰撞求解，也没有改变项目文件语义。WebGPU-only 指统一 3D 渲染后端，不代表 React、加载解码或业务计算都在 GPU 上执行。

### 技术选择与执行顺序的调整

- 未采用主候选 Three r186 原生 GaussianSplat：安装后检查该固定版本投影实现，其协方差投影使用透视 Jacobian，缺少当前四视图所需的正交分支。采用设计中的 GSL 备选，真实 SPZ 的透视/正交画面已运行验证。没有声称原生候选完成了所有对照测试。
- 首轮先替换后端；第二轮已改为单份核心场景和统一主视口调度。动画组件不再按窗格重复挂载；合成 GLB 骨骼动画已通过真实 GPU 测试，复杂用户动画/FBX 与多视图动画更新次数的专项回归仍待补齐。
- 预览和缩略图仍是独立 WebGPU renderer，已共用截图优先级队列；没有整合成单画布，不假定跨设备共享 GPU 资源。
- 没有先完成 M0 全场景旧版性能采样；后续已补同项目混合场景在原生窗口/DPR 1.5 与 1080p/DPR 1 的前台 30 秒 × 3 段初测。前者 WebGPU 持续运动帧间隔中位数反而高于固定旧版，后者两边长尾均恶化，不能声称性能收益。普通模型、纯 Splat、四视图和设备矩阵仍缺。

### 已有验证证据

- 本机 Chromium/Ego 浏览器、localhost：实际 backend 为 WebGPU。真实 World Labs SPZ + collider GLB + 三个普通 GLB 能共同绘制，四视图包括三个正交相机；线框和 Splat 的世界变换保持一致。
- 单视图中穿过 collider 参照层点选普通模型成功；独立模型预览含坐标轴成功。
- `workflows.browser.tsx` 挂载真实 ThumbnailRenderer / ModelPreviewWindow（StrictMode），用现有 GLB 生成 256×256 缩略图和 1024×1024 四视角检查图，完成回调成功；图片已人工检查。该探针仅返回 PNG，不上传或修改项目。
- 可复跑的 `capture.browser.ts`：65×65 图片验证 GPU 行填充、上下方向、透明 alpha；屏幕与截图的灰色像素均为 `[151,151,151,255]`，蓝色像素均为 `[0,0,228,255]`；无 GPU 错误。
- 实际 WebGPUCanvas 在 StrictMode 中模拟无 adapter：只请求一次，显示一个失败提示，无 unhandled rejection，无 WebGL fallback。
- 实际调用当前 GPUDevice.destroy() → 可点击的重试面板 → 新 GPUDevice 创建成功，三个普通模型、Splat 和 collider 恢复，已检查画面；此项不等同于真实驱动故障认证。第一人称/轨道模式及 collider 显隐切换未触发渲染错误。
- 应用与 chat 类型检查、生产构建通过；应用测试 276 通过、0 失败（42 个文件），chat 测试 317 通过、0 失败（38 个文件）。包含读回/状态恢复/失败清理、多视口坐标、共享拾取、队列、模型缓存租约、天空盒代次和初始化超时/迟到清理测试。
- `materials.browser.ts` 从合成资产导出 18,636 字节 GLB 后重新加载，覆盖 PBR、unlit、transmission/clearcoat、alpha test、半透明双面和两骨骼动画；透视/正交画面已检查，动画前后改变 6,093 个像素，无 GPU 错误。它不证明 Splat 与玻璃的一般排序正确，也不替代真实 FBX/复杂动画回归。
- 第二轮真实 GPU 回归：四视图共用三个 GLB 实例和一份 1,920,000 点的高斯源，顶视图拾取正常；1/2/4 视图与第一人称切换保留对象身份。
- 20 轮「1/2/4 布局切换 + 真缩略图 + 真预览四视角图」持续 231.971 秒，无 GPU 错误。修补前存储缓冲和占位纹理逐轮增长；修补后存储属性恒为 48、纹理恒为 390，读回缓冲为 0，截图预算每轮归零。Three 资源账本约 1,087,688,931 字节，后期仅 shader 程序字符串计数增加 16 字节，不是物理显存读数。该测试不等同于 30 分钟验收。
- 最新模型缓存改动后的另一次 20 轮真实循环完成，历时 257.688 秒：三模型对象身份不变，四视角图与缩略图每轮返回，队列及截图预算每轮归零，读回缓冲始终为 0。闲置缓存项在 5/6 项间波动并被淘汰 19 次。GPU 账本在布局切换时明显波动：存储属性 48–168、末轮 48，纹理 41–390、末轮 379。第 3–12 轮的存储属性大小只有约 0.9–1.7 KiB，而第 1 轮约 147 MiB。之后的专项复查证实这是用户可见故障：四视图高斯投影可连续 30 秒保持 0 绘制实例，画面只剩 collider 与普通 GLB。截图批次单轮约 1.9–35 秒，不把循环成功等同于响应速度合格。
- 修复后当前世界预建并保留四个 GSL WebGPU renderer，布局仅切换可见性，避免每轮销毁/重编译。真实 192 万点世界的四视图首次切换就绪约 218 ms；单视图闲置 32 秒后重进约 188 ms。连续 20 轮 1→2→4 切换中四个 renderer 身份不变，每轮各为 192 万活跃点/15,000 绘制实例，存储属性总大小保持 153,840,752 字节，读回缓冲为 0；末轮画面人工检查有高斯与 collider。代价是单视图也保留已分配的四视图 GPU 资源；这不是全项目内存准入预算已完成的证据。
- 2026-09-29 回读了上一轮发出但没读完的源代次生命周期探针：同一真实 SPZ 的 20 个 URL 代次，在 StrictMode 下每轮四视图各 `activeSplats=1,920,000`、`instanceCount=15,000`，四个 renderer UUID 全程不变，storage attribute 恒为 48、纹理 371，账本总量平在 464.6 MB，结束时 `deviceReleased=true`。它证明的是资源代次替换，不是 20 个不同世界或项目切换。
- 2026-09-29 补齐组合场景帧时间矩阵（1920×1080、DPR 1，各 3 秒预热 + 3×30 秒，五个场景全部 `valid=true` 且逐场景核对高斯活跃点数）：混合单视图 P50 117–119 ms、纯 Splat 100–117 ms、仅普通模型 65–67 ms、混合四视图 283–301 ms；CPU 提交只有 0.5–3.9 ms，帧时间几乎全在 GPU 侧。当天机器有 3–5 的 load average，绝对值不能与清晨静机行并列，细节与边界见 `WEBGPU_VALIDATION.md`。
- 2026-09-29 同机同期对照：用同一份无应用依赖的探针注入固定旧版 WebGL/Spark 页面，同协议下旧版 P50 150 ms/P95 300–350 ms，当前 WebGPU P50 117 ms/P95 152–183 ms。方向与清晨静机结论相反，说明时段负载的方差大于两个后端的差异；性能结论保持不变，不承诺提速，静机重跑仍在待办。
- 2026-09-29 找到了“动起来才卡”的直接解释：锁定的 GSL 1.1.5 自带文档写明原生 WebGPU 路径在绘制前同步排序（`synchronousSort` 为真），`minSortIntervalMs` 在原生 WebGPU 上无效。真实指针拖动实测：静止时单视图 P50 16.7 ms（约 60 fps），拖动中 P50 100–150 ms（6–10 fps），停手并预热后回到 32–33 ms。可调档位只有会造成明显颗粒的 `stochastic`/`autoStochastic` 与 `fastSort`/`minPixelRadius` 这类精度档，本轮没有改动默认值。
- 2026-09-29 完成 30.0 分钟连续稳定性：116 次采样、178 个动作（含 30 次 1/2/4 布局切换、6 轮预览开关）。可见窗格始终 192 万活跃点/15,000 绘制实例，没有一次“0 绘制实例”；截图队列始终 0/0；`readbackBuffers` 0、`storageAttributes` 48、`indirectStorageAttributes` 20 全程不变；存储与纹理字节在首次四视图后固定为 153,840,752 / 806,287,933 并保持 27 分钟零斜率，账本总量在 1.0834–1.0848 GB 之间随窗格数波动，**不是随时间泄漏**。
- 2026-09-29 修掉一个我们自己引入的缺陷：Three 补丁在 `Attributes.update()` 里无条件 `addEventListener('dispose', …)`，而 `Geometries` 会把不是 `EventDispatcher` 的交错属性送进同一条路径，于是每次模型预览开关都抛 `Uncaught TypeError: attribute.addEventListener is not a function`（浏览器栈指向 `Geometries.updateAttributes`）。现已改成双向守卫（只在属性可监听时才登记/反登记），`patches/README.md` 记录原因，回归测试扩到 2 例，app 测试 286 通过。

### 尚未完成，不能视为发布通过

本轮补上了 30 分钟连续稳定性与组合场景帧时间矩阵（含同机同期旧版对照），但仍缺：静机条件下的新旧同质量全矩阵（含四视图与后台截图）、全项目资源准入预算与超大资产处理、复杂透明/玻璃与 Splat 的前后穿插排序、真实 FBX/装配/材质覆盖与完整导入/编辑/保存/重开回归、跨浏览器与跨显卡设备矩阵（Safari、Windows、集显/独显）、以及项目/世界切换各 20 次（本轮只完成 20 轮预览开关与一次源代次 20 轮的资源换代）。已完成的布局/预览/稳定性循环不替代这些项目。

有一个本轮新发现的体验缺口需要产品决策，而不是继续测：真实拖动相机时 P50 会从静止的 16.7 ms 恶化到 100–150 ms，原因是原生 WebGPU 每帧绘制前同步重排 192 万点；质量档位（`fastSort`、`minPixelRadius`）或颗粒化路径（`stochastic`）都涉及画质取舍，本轮未改默认值。当前仍不承诺帧率改善或提速倍数。

性能诊断：旧版基线固定在 `8e86799`，使用独立 checkout 和端口。初次新旧页面均出现约 1Hz 的 rAF，而空白页正常；此前 1Hz 采样作废。随后同一真实混合项目、相机轨迹、2175×1224 画布/DPR 1.5 的前台 30 秒 × 3 段初测：WebGPU P50 均约 66.6 ms、P95 约 116–133 ms；旧版 WebGL/Spark P50 约 33.3 ms，P95 从 66.7 恶化到 483.3 ms。1920×1080/DPR 1 下 WebGPU P50 为 33.4/34.5/65.7 ms、P95 为 50/85/151.5 ms；旧版 P50 均约 33.4 ms、P95 为 135/301/301 ms。两档位均未达体验目标，长尾随持续运行恶化；不据此宣称 WebGPU 更快。GSL 运动免排序可降中位间隔但有明显颗粒，未作为默认画质。完整数据、复跑方式和证据边界见 `WEBGPU_VALIDATION.md`。

重启前的一次缓存集成循环因 adapter 请求不响应及页面超时作废。用户重启测试浏览器后独立 adapter 请求恢复，随后完成上方新的 20 轮循环。初始化超时保护已补齐；前台混合场景性能初测虽已取得，但**未达性能目标**，完整性能矩阵和长时间稳定性仍未通过。

## 1. 已确定的方向

产品最终统一使用浏览器 WebGPU。继续使用 React、React Three Fiber（R3F）和 Three.js，围绕 WebGPURenderer 改造渲染层。本文中的 WebGPU 不指引入 Rust 的 wgpu 框架，也不要求重写产品 UI 或后端。

迁移覆盖普通模型、Gaussian Splat 世界、单/双/四视图、预览、缩略图和 Agent 四视角截图。发布版本不静默回退到 WebGL。迁移期间旧实现作为基准和整版本回滚点，最终移除旧渲染路径与 Spark 依赖。

性能验证用于选择实现、排查退化和决定上线时间；WebGPU 的长期方向已经确定。没有实测前，不承诺提速倍数或迁移工期。

## 2. 迁移前实现与证据（设计基线）

以下来自本仓库代码检查，不是运行时性能结论。

| 位置 | 当前行为 | 迁移意义 |
| --- | --- | --- |
| `app/package.json` | Three.js ^0.185.1、R3F ^9.6.1、Drei ^10.7.7、Spark ^2.1.0 | 需要选择并锁定兼容版本组合 |
| `app/src/widgets/Viewport/index.tsx` | 按需渲染，DPR 上限 1.5；每个 Drei View 分别挂载 SceneContents | 保留按需策略；整合核心场景，重做视口调度 |
| `app/src/widgets/Viewport/SplatModel.tsx` | 共享解码后的 PackedSplats，各窗格有自己的 SparkRenderer | 替换 WebGL 专用渲染路径；保留资源共享和失败隔离语义 |
| `app/src/widgets/Viewport/ModelMesh.tsx` | 每个挂载点克隆模型；动画独立更新；模型缓存复用 | 主场景每个资产只推进一次动画；预览仍可有独立实例 |
| `app/src/widgets/Viewport/PaneCamera.tsx` | 手动设置 viewport/scissor、清深度、绘制 HUD | 将多视口和 HUD 的绘制顺序纳入统一调度 |
| `app/src/widgets/Viewport/materialOverride.ts` | 克隆原材质并覆盖纹理通道 | 保留 PBR、unlit、OBJ 等材质语义与覆盖隔离 |
| `app/src/widgets/ModelList/ThumbnailRenderer.tsx` | 独立 Canvas，同步渲染后转 PNG，检查 WebGL context lost | 改为离屏目标与异步读取；迁移设备丢失处理 |
| `app/src/widgets/ModelPreviewWindow/index.tsx` | 独立 Canvas；依次绘制四相机，再从画布拼图 | 使用独立截图目标和确定的场景快照 |
| `app/src/shared/lib/envTexture.ts` | HDR/EXR/图片加载、共享纹理租约 | 保留引用计数，补充设备代次和环境预处理生命周期 |
| `app/vite.config.ts` | 将 Three.js 收拢到共享 chunk | 检查 webgpu/tsl/addons 的模块解析和重复打包 |

现有代码已经包含资源共享、按需绘制、拖拽避开 React 每帧更新等优化。四个视口仍需各自绘制，但不能由此推断总耗时必然为单视口四倍。尚未采集帧耗时、GPU 时间或内存基线。

## 3. Splat 技术选型

### 3.1 新的可用基础

Three.js r186 已加入原生 Gaussian Splat 渲染与加载支持。本地安装的 Three.js addon 中尚没有 GaussianSplat/SPZLoader。优先验证 r186 或后续经测试的稳定版本，并同步锁定类型、R3F 和 Drei 的兼容组合；不使用自动跟随 latest 的策略。[r186 发布说明](https://github.com/mrdoob/three.js/releases/tag/r186)

官方 GaussianSplat 面向 WebGPURenderer，提供按相机更新排序及球谐颜色的接口；SPZLoader 提供 SPZ 加载。官方将 GaussianSplat 定位为最小渲染实现，不能据此假定已达到 Spark 的完整能力。[GaussianSplat](https://threejs.org/docs/pages/GaussianSplat.html)、[SPZLoader](https://threejs.org/docs/pages/SPZLoader.html)

### 3.2 决策顺序

| 方案 | 定位 | 必须验证的缺口 | 决策 |
| --- | --- | --- | --- |
| Three.js 原生 GaussianSplat + SPZLoader | 主候选，与现有引擎直接集成 | 真实 SPZ 版本、坐标/球谐一致性、正交投影、混合透明、多视口、大世界容量 | 先做真实资产验证；满足门槛即采用 |
| Gaussian Splat Lite | 同引擎备选 | 锁定版本后的多相机行为、深度近似、设备兼容、资源释放、维护与许可依赖 | 原生方案出现实质缺口时对照测试 |
| 自研局部适配 | 弥补有限缺口 | 修改规模、可维护性与上游合入可能 | 优先局部修补，不默认承担整套 Splat 引擎研发 |

Gaussian Splat Lite 的仓库声明支持 WebGPU、SPZ、深度渲染和 RAD/SOG 流式 LOD，要求 Three.js >=0.186.0。这些是候选能力声明，尚未在 ChatSpace 中验证。引入前检查固定版本的许可证、NOTICE、WASM 与间接依赖，并保留应有署名。[候选仓库](https://github.com/WilliamLiu-1997/Gaussian-Splat-Lite)

候选库即便自身提供 WebGL 后端，产品也只启用并验证其原生 WebGPU 路径。不同 Splat 实现通过薄适配层隔离，项目数据和 UI 不引用候选库的专属对象。

### 3.3 Splat 必过测试

1. 真实 World Labs SPZ：核对文件版本、比例、坐标方向、透明度、颜色与球谐效果；以现有正确画面及源资产为参考。
2. 模型混合：模型位于世界前方、内部、后方，以及相互穿插时，确认不透明深度与透明合成正确。
3. 透明材质：玻璃/transmission、alpha test 和半透明边缘单独测试，不把“共用深度缓冲”当成完全解决透明排序。
4. 透视、顶/前/右正交相机均验证投影；快速旋转、平移、缩放和相机近裁剪不能闪烁或丢世界。
5. 四视图验证每台相机的排序和视角相关颜色，不允许复用错误相机的结果。
6. 资源换代、切换世界、失败重试和设备重建后能恢复；超大资产不能无限制申请显存。
7. 主视图、离屏目标和四视角截图得到一致结果；加载/排序未就绪时不提交空白图。

特别注意：r186 原生材质采用透明混合、depthTest=true、depthWrite=false。这不能证明一般混合透明场景已正确；也不能直接打开 depthWrite 来“修复”，否则透明 Splat 会产生过度遮挡。根据测试决定是否需要专用深度代理或额外合成 pass，并记录近似边界。[固定版本源码](https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/jsm/objects/GaussianSplat.js)

SPZ 文件能被加载也不代表自动获得流式 LOD。如果后续选择 RAD/SOG 等派生格式，另行建立可重建的转换缓存，保留原始 SPZ；首轮迁移不修改供应商生成链路。

## 4. 目标渲染架构

### 4.1 责任分工

| 模块（拟新增职责，不限定最终文件名） | 负责内容 |
| --- | --- |
| RenderRuntime | WebGPU 能力检查、renderer 初始化、设备生命周期、统一调度 |
| AssetResources | 解码缓存、纹理/几何租约、设备资源代次、容量预算与淘汰 |
| ProjectScene | 项目核心场景、资产实例、变换、材质和一次性的动画更新 |
| ViewRegistry | 各视图 DOM 区域、相机、投影、画质、脏标记、专属排序状态 |
| SplatAdapter | Splat 加载、就绪状态、视图准备、渲染接入、资源释放 |
| CaptureQueue | 缩略图、Agent 截图的快照、队列、取消、异步读回与编码 |

保留 R3F 管理场景对象和交互，绘制顺序由单一调度器负责；不让多个独立 useFrame 回调争相修改渲染目标与清屏状态。Drei 中依赖旧 shader 或手动绘制的组件逐项适配或替换，不一次性重写所有 Drei 功能。

### 4.2 共享边界

主编辑区采用一个 WebGPURenderer、一份核心场景、多台相机。每帧先更新动画和实时变换，再按视图绘制；悬浮框、变换控件和 HUD 为视图专属覆盖层，避免一个窗格的反馈污染其他窗格。

共享场景不消除每台相机的绘制成本。Splat 源数据可共享，排序、投影、球谐颜色与 LOD 可见集必须按相机管理。允许经验证的临时缓冲复用，但必须保证 GPU 提交顺序正确；不能在某视图消费结果前被另一视图覆盖。

模型预览使用独立小场景和实例，复用几何/纹理等不可变资源。预览应用当前材质覆盖；列表缩略图保持资产原始材质。不可将同一个 Object3D 同时挂到多个父节点，也不可为了共享而破坏现有材质隔离。

预览优先作为统一画布上的独立显示区域，由 ViewRegistry 跟踪 DOM 矩形和裁剪。原型必须覆盖浮窗拖拽、滚动、缩放、面板遮挡及坐标拾取。如果布局要求无法可靠满足，可使用额外 WebGPU 显示 surface，但仍共用资源和调度策略；不同 renderer 间不假定 GPU 资源自动共享。

### 4.3 帧调度

- 相机变化只标记对应视图；世界、材质、变换或动画变化标记所有受影响视图。
- 需要只更新部分视图时，使用持久的视图 RenderTarget 缓存再合成。不能依赖 swapchain 画布自动保留上一帧其他区域。
- 动画按项目时间推进一次；截图冻结自己的时间快照，不推进主场景时间。
- 静止场景不持续提交绘制/排序；加载完成、LOD 更新、控件阻尼等显式请求后续帧。
- 用户交互优先，Agent 截图其次，缩略图最低；队列有并发上限、取消和防饥饿策略。不要把等待 GPU 完成的全局同步放进每帧路径。

### 4.4 材质、光照与依赖

传统 ShaderMaterial、RawShaderMaterial、onBeforeCompile 定制不能直接迁入 WebGPURenderer，需要节点材质/TSL 适配。内置材质逐项验证，避免简单统一成一种 PBR 材质而丢失原模型效果。[Three.js 迁移指南](https://threejs.org/manual/pages/webgpurenderer)

重点验证 GLB/GLTF、OBJ+MTL、FBX、蒙皮与动画、分段装配、贴图色彩空间、法线方向、透明、clearcoat/transmission、unlit、双面及材质覆盖回退。天空 HDR/EXR 的背景与 IBL 保留现有视觉语义；网格改用 TSL，HUD 和选择框纳入明确的 pass 顺序。

Three.js、webgpu、tsl 和 addons 的入口统一治理，验证应用与依赖不会重复打包不兼容的 Three.js 实例。升级时固定 lockfile 和类型版本，验证 R3F 异步初始化在重渲染、StrictMode 和卸载时不会泄漏 renderer。[R3F Canvas 文档](https://r3f.docs.pmnd.rs/api/canvas)

## 5. 资源、截图与异常恢复

缓存身份包含项目/资源身份及 resourceRevision。引用计数覆盖主场景、预览和后台任务；最后释放时同时处理 GPU buffer、纹理、排序缓冲和 RenderTarget。旧代次的异步回调不能写入新项目。

解码与图像编码中适合并行的工作放到 Worker；GPU 上传分批提交。WebGPU 不会自动把 GLTF/FBX/SPZ 解码、React 更新或 CPU 拾取转移到 GPU，相关长任务单独治理。

GPU 内存没有可跨浏览器可靠读取的总量，使用资源尺寸账本估算，并记录峰值申请、预算拒绝和释放数量。按能力上限、画质档和测得的容量制定预算；不要声称能准确读取“剩余显存”。

截图流程：固定资源代次、材质/变换和动画时间 → 等待资源与渲染准备完成 → 绘制独立目标 → 异步读回 → 核对颜色/方向/alpha → 编码 → 按请求 ID 返回。保留现有 PNG/base64 API、取景与四视角标签，不改变 Agent 协议。取消、失败及资源换代必须只结算一次；后台页面按既有暂停语义恢复，不能产生空图。

设备丢失时暂停 GPU 队列并使旧代次失效，保留 CPU 项目状态。重新初始化后按需重建资源；反复失败进入明确的恢复提示，不无限重试，也不转入 WebGL。加载失败仍按单资产隔离。

## 6. 支持设备策略

首发验收建议以桌面为主：macOS Apple Silicon 上的 Chrome、Safari，Windows 上的 Chrome/Edge，至少覆盖集成显卡和独立显卡。Firefox、Linux、移动设备逐步补齐验证；未测平台明确标注未验证，不等同于 API 必然不可用。

准入以运行能力为准：安全上下文、navigator.gpu、adapter/device 可用、实际 backend 为 WebGPU，以及所需 features/limits。仅检查浏览器名称、navigator.gpu 存在或 WebGPURenderer 构造成功都不够；Three.js 自带的 WebGL2 fallback 必须被产品准入逻辑识别并拒绝。[Three.js backend 说明](https://threejs.org/manual/pages/webgpurenderer)

能力不足时保留可用的项目管理与聊天界面，在 3D 区域显示可执行的设备/浏览器提示。不让用户进入静默空白画布。常规 HTTP 局域网部署需要特别检查安全上下文；localhost 和正式 HTTPS 分别验收。[WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)

性能测量中的 timestamp-query 是可选能力；缺少时报告 CPU 提交时间和帧间隔，标注 GPU 时间不可用。不能把 JS render 调用耗时当成 GPU 耗时。

## 7. 里程碑与交付物

| 里程碑 | 范围 | 完成证据 |
| --- | --- | --- |
| M0 基线与版本锁定 | 固定真实项目样本、操作轨迹、旧版基线和候选版本 | 可复测的测试清单、设备/资产清单；记录样本规模与缺失数据 |
| M1 Splat 选型 | 同一真实世界 + 普通模型；透视/正交、四视角、离屏截图 | 主候选/备选的功能差异与测量结果；确定实现和已知限制 |
| M2 单视图完整编辑 | RenderRuntime、材质、光照、选择、变换、第一人称 | 功能回归与设备初始化/恢复验证；项目存储兼容 |
| M3 多视图与后台绘制 | 共享场景、视图调度、预览、缩略图、Agent 截图 | 相机结果隔离正确；后台任务不污染用户画面和材质 |
| M4 稳定性与发布 | 内存预算、设备矩阵、长时间操作、发布检查 | 验收报告；移除 Spark/旧渲染代码；更新运行要求 |

M1 未满足需求时调整 Splat 实现或补足能力，WebGPU 方向保持不变。M1 结束后再估算剩余工期，避免在排序、透明混合和大场景成本尚不明确时给出虚假精确排期。

## 8. 验收标准

### 功能门槛

原有项目可打开，变换和材质覆盖持久化一致；资产导入、分段装配、动画、天空、选择、多选、变换、双击聚焦、第一人称、正交/透视和 1/2/4 视图通过。PNG 缩略图和 Agent 四视角图方向、尺寸、颜色及完成回调正确。主视口关闭预览后不丢资源。

Splat 不要求和 Spark 逐像素相同，但不能出现坐标偏移、明显颜色丢失、排序闪烁或不可接受的遮挡错误。透明边缘差异需有明确解释和评审样本。普通材质使用固定相机参考图比较并人工复核。

### 性能门槛（初始建议，M0 固定设备与样本后冻结）

- 同设备、电源模式、浏览器、画质、分辨率、DPR、相机轨迹比较。固定 1080p/DPR=1 作为一种基准，另测原生窗口尺寸；不以降画质冒充后端收益。
- 覆盖普通多模型、Splat 世界、混合场景，以及四视图 + 预览 + 截图队列。冷加载与预热后分别记录；预热后每段至少 30 秒、重复 3 次。
- 记录帧间隔 P50/P95/P99、超过 50ms 的卡顿次数、交互响应、首个可用画面时间、CPU 长任务、GPU 时间（若可测）、资源账本峰值和截图完成时间。
- 初始体验目标：代表性中等场景单视图接近 60fps，P95 帧间隔不高于 20ms；四视图或声明的大场景预算档 P95 不高于 33.3ms。目标不是实测结论，场景规模与参考设备必须同时记录。
- 相同质量下相对旧版 P95 退化超过 10% 的代表性场景必须调查并形成发布前处理结论；该阈值用于阻止无解释退化，不用于重新表决技术方向。
- 静止后不持续提交无意义的绘制/排序。暂停刷新产生的长帧间隔不纳入运动场景 FPS 统计；输入到首个新画面的等待单独统计。

### 稳定性门槛

连续工作至少 30 分钟；重复切换项目、世界、布局、打开/关闭预览各 20 次。资源计数在清理与缓存稳定后收敛，不能随循环单调增长。模拟设备丢失、资源加载失败、取消截图、后台恢复、窗口缩放和 StrictMode 重挂。

必须在真实浏览器/GPU 上验收，现有 DOM 单测和类型检查不能证明 WebGPU 可运行。工程构建与已有相关回归测试仍需通过。

## 9. 发布与回滚

迁移开发期间保留旧版固定基线及可发布构建，不把双后端长期维护作为产品方案。切换前核对项目数据兼容和缓存可重建；出问题时回滚整个前端版本，避免运行中跨后端切换资源。

最终检查：所有产品渲染 surface 实际走 WebGPU；主依赖移除 Spark；没有遗留 WebGL context 检测、preserveDrawingBuffer 截图依赖或静默 fallback；文档明确设备门槛。第三方依赖包含兼容代码不代表产品正在调用 WebGL，审计以实际路径为准。

## 10. 设计时拟定的实施起点（历史记录）

执行 M0/M1：先选择一个真实 SPZ 世界、一个带不透明和透明材质的模型、一个骨骼动画模型，建立固定视角与操作轨迹。验证官方 GaussianSplat 的完整使用路径，再用相同样本补测备选。输出版本组合、验收差异和 Splat 选型记录后，进入主产品迁移。

以上为设计时的计划。实施中的选型、验证与尚未完成项以第 0 节为准；性能矩阵和目标设备认证仍未完成。

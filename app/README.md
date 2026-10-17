# app

ChatSpace 的 Vite + React + R3F 客户端。

访问网站会直接进入页面，无需回答入口问题；首次访问和刷新均不依赖旧的答题解锁记录。

```bash
bun run dev
bun run build
bun run start
```

默认连接 `http://127.0.0.1:3901` 的本机 chat 服务；可用 `VITE_CHAT_URL` 覆盖。

Blender 浮窗的放大按钮（或双击标题栏）将画面放大到约 1.5 倍，保留工作台边缘与底部操作区；再次操作恢复之前的大小和位置。放大后仍可拖动标题栏或右侧尺寸手柄，不会进入全屏。

编辑器未保存模型偏好时，默认选择 DeepSeek V4.1 Flash（聊天）、Tripo P2（3D）和 Seedream 5.0（图片）。手动选择会在浏览器中保存，再次进入时沿用，包括显式选择的 Auto；聊天模型仍按服务端已激活的供应商筛选。

首页顶部导航复用 `Panel variant="liquid"` 的 OpenDesign 同源玻璃滤镜，搭配半透明白底、内侧高光与柔和阴影，滚动时吸顶。Safari / Firefox 使用组件自带的 CSS 毛玻璃效果。
项目入口 `/app` 与新建弹窗沿用同一套浅色玻璃表面，页面使用与首页一致的渐隐天空背景；样式由 `shared/ui/skyGlass.css` 共享。
两页顶部导航的宽高、内边距、品牌字体与创建按钮尺寸也由这份样式统一，包含手机端规则。

3D 渲染仅使用原生 WebGPU，需要 HTTPS/localhost 和可用的 GPU adapter/device。依赖升级后重启 Vite，必要时用 `bun run dev --force` 重建预打包缓存，避免混用旧版 Three.js。

渲染层固定为 Three.js 0.186.1、Gaussian Splat Lite 1.1.5。Splat 与 collider GLB 使用同一份世界变换；collider 当前是**不可拾取、也不绘制的地形参照层**——`WorldColliderMesh.tsx` 的 `COLLIDER_VISIBLE = false` 让 three 遍历时整棵子树早退，一次绘制都不提交（**100% 透明**，不是 `opacity: 0`；GLB 仍照旧加载并挂在场景里）。想让地形参照显示回来就把那个常量翻成 `true`，用的是半透明实体材质（浓淡旋钮 `COLLIDER_OPACITY`）。它不是新增的物理碰撞引擎。第三方许可证及 NOTICE 随构建发布在 `/licenses/gaussian-splat-lite/`。

测试：`bun run typecheck`、`bun run test`、`bun run build`。真实 GPU 的截图回归测试可以在开发页面控制台执行：

```js
await (await import('/src/shared/rendering/capture.browser.ts')).verifyWebGPUCapture()
```

它验证 65×65（带 GPU 行填充）截图的方向、透明度、屏幕/离屏色调映射一致性和渲染状态恢复，不读取或修改项目资产。迁移状态和待完成的发布验收见根目录 `WEBGPU_MIGRATION.md`。

完整缩略图/四视角组件探针（读取指定项目资产，返回 PNG，不上传）：

```js
const images = await (await import('/src/shared/rendering/workflows.browser.tsx'))
  .verifyWebGPUWorkflows('项目 slug', '模型资产 slug')
// images.thumbnail / images.inspection 是不含 data: 前缀的 PNG base64。
```

合成 GLB 材质与骨骼动画探针（不需要项目资产）：

```js
const materials = await (await import('/src/shared/rendering/materials.browser.ts'))
  .verifyWebGPUMaterials()
// 检查 materials.perspective / materials.orthographic；均为 PNG data URL。
// changedPixels 证明动画改变图像，不代表所有材质视觉语义均已自动判定。
```

性能探针与验收结果见根目录 `WEBGPU_VALIDATION.md`。探针只供开发环境使用；不能将 `render()` 的 CPU 耗时解释为 GPU 耗时，也不能将后台/未展开测试空间的帧间隔当成用户帧率。

## 手势模式（摄像头 + MediaPipe）

右下角工具条的「Enable hand tracking」开启摄像头，MediaPipe `HandLandmarker` 追踪双手。捏合拇指与食指可抓取：第一人称走 rapier 球形关节，第三人称走与 gizmo 相同的实时摆放与提交。

### 完整库迁移

手部骨骼由 [bandinopla/three-mediapipe-rig](https://github.com/bandinopla/three-mediapipe-rig) 的完整 `HandsTracker` 驱动，固定版本 0.1.41、提交 `3ab212719826cb762d08b27cd987dba41d96701c`。完整上游归档 119 个文件及逐项 SHA-256 保存在仓库，完整公共 API、编辑器入口和 meshcap 均已构建。目录、差异和重建方法见 [迁移说明](../vendor/three-mediapipe-rig/README.md)。

实际通路：`useHandTracking.ts`（现有摄像头检测）→ `handDetections.ts`（物理手身份）→ `libraryHandModel.ts`（接收原始三维关键点）→ 上游 `Tracker.updateLandmarks / HandsTracker.bind / binding.update / syncHandBones / syncFinger / lookAt / Ghost.lerp`。掌面、拇指全部三节、四指和插值都使用完整上游类。旧掌面求解、绑定轴校准、铰链限位及程序化手模兜底已删除。

物理手分配优先采纳置信度 ≥ 0.8 且该帧没有重复标签的分类，禁止历史画面位置覆盖它。标签重复、缺失或置信度不足时才使用时序位置关联。诊断 `pose()` 同时报告 `reportedHandedness / handednessConfidence / identitySource / physicalHand / displayedHand`，区分分类、槽位分配与模型选择。

手模改用作者配套的 `hands.glb`，逐字节复制到 `/models/three-mediapipe-rig/hands.glb`，装配时移除黑色胳膊网格，只显示白色手套，保留作者的骨架、顶点、绑定矩阵、权重与材料。左右手共享图元按三角形分开，以放到各自屏幕位置。资产说明见 [模型说明](public/models/three-mediapipe-rig/README.md)。

编辑器在相机挂点外层绕 Y 旋转 180°，以实现相反观察方向。显示骨架按 `displayedHandFor()` 选择；当前约定下真实右手使用作者右手骨架、真实左手使用左手骨架，抓取仍关联物理手身份。库按自身约定转换原始关键点；`projectHand()` 只用于屏幕摆放与距离，不参与骨骼朝向求解。

上游唯一源码改动是增加默认关闭的 `allowAllDirections` 开关；编辑器开启它以解除部分朝向停止更新的限制，见 [EDITOR.patch](../vendor/three-mediapipe-rig/EDITOR.patch)。更新调用将 delta 限制到 `0..1/8`，防止作者的 `delta × 8` 插值在长帧超出范围。完整库的摄像头、人体、面部、录制及 meshcap API 已迁入，但应用只启用手部绑定，沿用现有摄像头生命周期与交互入口。

### 使用与诊断

### 资产从哪来（同源，第三方只兜底）

- MediaPipe JS 固定 `0.10.17`。**wasm 与模型都随产物同源发出**（`/mediapipe/0.10.17/...`，`vercel.json` 给这条路径配了 `immutable` 长缓存），不再默认从 jsDelivr / Google bucket 下载——模型那个 URL 实测**不压缩且只缓存 1 小时**（7.82 MB 每次过期都重下），是"开启手势模式要等很久"的最大一项。版本号、两个 sha256 钉子与兜底地址集中在 `src/widgets/Viewport/handAssets.ts`。
- wasm **不入库**：`app/scripts/sync-hand-assets.ts` 在 `dev` / `build` 之前从 `node_modules/@mediapipe/tasks-vision/wasm/` 复制（只复制 SIMD 那一套），并校验依赖版本与 sha256。模型 `hand_landmarker.task`（7.82 MB）**提交进仓库**；来源、更新步骤与"升级时要改哪几处"见 [资产说明](public/mediapipe/README.md)。
- 同源加载失败（资产漏部署、非 SIMD 环境下的 404）会**自动兜底**到 jsDelivr 的 wasm + Google 的模型；面板上的 `source` 显示的是**实际**生效的那一份。`?handWasm=<目录>&handModel=<URL>` 仍可显式指定来源，显式指定时**不**兜底。Three 保持项目固定版本与 WebGPU-only 渲染器。

### 预热与委托（GPU 是刻意的）

开启手势模式时要等一段（面板显示 `Loading hand model…`）——那是 `detectForVideo` 的**第一次调用**在编译 wasm 的着色器。实测（2026-10-17，load≈5.8，探针 `.tmp/hand-verify/warmup-when-quiet.mjs` + `warmup-delegate.mjs`，读数 `.tmp/hand-verify/warmup-report-20261017.json`）：

| | GPU（现用） | CPU（兜底） |
| --- | --- | --- |
| 冷启动（本次页面第一次，含 wasm 下载/编译） | 建任务 2.1–2.3 s + 首帧 **6.5–9.9 s** | — |
| 热启动（再开一次）首帧 | **1.0–2.6 s**（同代码两次跑差 2.4×） | **66–190 ms** |
| 稳态每帧（640×640） | **7–10 ms**（100–143 fps） | **49 ms（≈20 fps）**，同步阻塞主线程 |

**所以维持 GPU**：换 CPU 只省掉热启动那 1–2.6 s（冷启动那次是一次性的），代价是每帧 49 ms——摄像头本身 30 fps，检测会跟不上，手会明显发粘。`delegate: "CPU"` 仍然是 GPU 建不起来时的兜底路径（显卡被占用 / 无头容器）。

旧注释里的"8–52 秒"只有**冷启动**那一次成立，热启动不是；引用时别再用那个数。复测机器必须安静（`load` < 8 连续三次）——`warmup-when-quiet.mjs` 就是干这个的。
- 开启时切单窗格。图像关键点确定手的屏幕位置和距离，骨骼姿态取原始三维关键点。
- 手模与抓取射线每帧跟随实际交互相机：第三人称从透视窗格的 OrbitControls 读取当前相机，第一人称使用根画布相机。更新排在相机移动之后、核心场景渲染之前；切换投影时读取新相机，屏幕范围计入相机 zoom。
- 预览叠加 2D 关键点与检测帧数，用于区分摄像头、检测与显示问题。
- 开发构建加 `?handDebug=1` 后，`window.__HAND__` 提供 `status / inject / pose / pointer / pump / detectOnImage`。`pose()` 报告 `driver: "three-mediapipe-rig/HandsTracker.bind"`、实际模型 URL、物理/显示手身份、外层旋转及三个拇指骨四元数。诊断注入与摄像头帧互斥。

本次库构建、应用类型检查、生产构建及原始源码/模型一致性核对通过；未运行测试或实时摄像头动作验证，不能据此宣称穿模、扭曲等实际效果已消除。

资源管理分为两层：截图目标有 128 MiB 申请预算；模型缓存只淘汰闲置项（128 MiB、最多 8 项、30 秒 TTL），不销毁正在使用的模型。两者均不是整个项目的显存上限。依赖中的计算缓冲/占位纹理释放修补由根目录 `patchedDependencies` 和 `patches/README.md` 管理，升级依赖时必须重新验证。

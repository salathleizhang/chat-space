# app

ChatSpace 的 Vite + React + R3F 客户端。

```bash
bun run dev
bun run build
bun run start
```

默认连接 `http://127.0.0.1:3901` 的本机 chat 服务；可用 `VITE_CHAT_URL` 覆盖。

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

- MediaPipe JS 固定 `0.10.17`，WASM 使用同版本 CDN 路径，模型使用 Google 官方地址；可用 `?handWasm=<目录>&handModel=<URL>` 覆盖。Three 保持项目固定版本与 WebGPU-only 渲染器。
- 开启时切单窗格。图像关键点确定手的屏幕位置和距离，骨骼姿态取原始三维关键点。
- 预览叠加 2D 关键点与检测帧数，用于区分摄像头、检测与显示问题。
- 开发构建加 `?handDebug=1` 后，`window.__HAND__` 提供 `status / inject / pose / pointer / pump / detectOnImage`。`pose()` 报告 `driver: "three-mediapipe-rig/HandsTracker.bind"`、实际模型 URL、物理/显示手身份、外层旋转及三个拇指骨四元数。诊断注入与摄像头帧互斥。

本次库构建、应用类型检查、生产构建及原始源码/模型一致性核对通过；未运行测试或实时摄像头动作验证，不能据此宣称穿模、扭曲等实际效果已消除。

资源管理分为两层：截图目标有 128 MiB 申请预算；模型缓存只淘汰闲置项（128 MiB、最多 8 项、30 秒 TTL），不销毁正在使用的模型。两者均不是整个项目的显存上限。依赖中的计算缓冲/占位纹理释放修补由根目录 `patchedDependencies` 和 `patches/README.md` 管理，升级依赖时必须重新验证。

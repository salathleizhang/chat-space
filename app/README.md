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

资源管理分为两层：截图目标有 128 MiB 申请预算；模型缓存只淘汰闲置项（128 MiB、最多 8 项、30 秒 TTL），不销毁正在使用的模型。两者均不是整个项目的显存上限。依赖中的计算缓冲/占位纹理释放修补由根目录 `patchedDependencies` 和 `patches/README.md` 管理，升级依赖时必须重新验证。

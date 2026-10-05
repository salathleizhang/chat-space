# three-mediapipe-rig 完整本地迁移

来源：[bandinopla/three-mediapipe-rig](https://github.com/bandinopla/three-mediapipe-rig)，版本 0.1.41，提交 `3ab212719826cb762d08b27cd987dba41d96701c`。

## 目录

- `upstream/`：该提交 GitHub 源码归档的全部 119 个文件，原样保留。包括 TrackerManager、Hand/Pose/FaceTracker、骨骼映射、录制、meshcap、演示、GLB、视频、Blender 工程和原始锁文件。
- `UPSTREAM.json`：原始文件逐项 SHA-256 和提交身份。
- `runtime/src/`：完整运行源码副本。只有 HandTracker 的一处编辑器兼容改动，见 `EDITOR.patch`。
- `runtime/library.ts`：上游完整公共 API。
- `runtime/editor.ts`：导出完整公共 API 与 Hand/Pose/FaceTracker；`EditorHandsTracker` 只公开已有关键点输入，继承整个上游手部实现。
- `compiled/`：完整公共 API、编辑器入口、meshcap 的 ESM 与声明。Three/MediaPipe 仍使用项目固定版本。
- `dependencies/fflate-0.8.2/`：meshcap 所需 fflate 的完整 v0.8.2 源码归档，保留其许可证；构建使用其官方浏览器 Worker 分支。
- `build.ts`：离线重建脚本，不安装或升级项目依赖。

重建：`~/.bun/bin/bun vendor/three-mediapipe-rig/build.ts`。

上游 TypeScript 按其原始约定生成声明；宿主应用另行类型检查。完整原始演示只作为参考保留，没有替换应用的 WebGPU-only 渲染器。

## 应用实际调用链

`现有 HandLandmarker 结果 → EditorHandsTracker.acceptLandmarks() → Tracker.updateLandmarks() → HandsTracker.bind(hands-rig, defaultBoneMap) → binding.update(delta) → syncHandBones() → syncFinger()/lookAt()/Ghost.lerp()`。

掌面使用作者的点 9/13 中点、腕与指根侧向参考；左右手使用作者的 ±X pole；指节、拇指、父子坐标处理和插值均由完整上游类执行。没有项目自写的 palmQ、方向框架、骨骼轴偏移、铰链角求解或拇指掌部修正。

应用只启用手部骨架绑定；完整库的摄像头/人体/面部/录制/meshcap API 一并迁入并构建，但不重复启动它们。现有摄像头、物理手身份和抓取逻辑作为输入/交互边界保留。

输入身份分配中，置信度 ≥ 0.8 且该帧无重复的左右手标签决定槽位；仅在标签不明确时按历史位置关联。原始分类、分配来源和所选骨架均由开发诊断口报告。

三维关键点不经过旧输入滤波，直接交给库；缺少有效 worldLandmarks 时隐藏对应手模。图像关键点的平滑只服务屏幕摆放与捏合判据。

## 作者配套模型

应用改用 `upstream/public/hands.glb`，构建时逐字节复制到 `app/public/models/three-mediapipe-rig/hands.glb`。外观为作者演示中的白色手套及前臂。

`libraryHandModel.ts` 对共享蒙皮图元按左右手权重选择三角形以分别摆放，装配时移除 `arms` 材质的黑色胳膊网格，只显示白色手套。原始顶点、权重、骨架、绑定矩阵与材料不改；不通过负缩放制造另一只手。此层只计算显示尺寸、挂点平移和抓取指尖位置。

上游 README/package.json 声明 MIT，配套资产未见单独来源/授权说明；保留完整原始材料，不另行声称其资产有独立的 MIT 授权。

## 明确的集成改动

1. `EditorHandsTracker` 接收现有已识别的原始关键点，使用上游自己的尺度和 Y/Z 坐标转换。它不创建第二个检测器，也不重新按人体手腕分配身份。
2. `HandRig` 只在相机挂点外层绕 Y 转 180°，按编辑器现有显示手性选择作者的对应骨架。
3. `allowAllDirections` 默认 false 保留上游行为；编辑器设 true，解除上游向下方向点积大于 0.8 时停止更新的门槛。这没有更改掌面或指节算法。
4. 更新调用把 delta 钳到 `0..1/8`，避免上游 `delta × 8` 在长帧时超过 1；初次出现按 `1/8` 初始化。没有增加第二层姿态平滑。
5. 模型释放时销毁实例的克隆几何、骨骼纹理及 Tracker 标记资源。模型未加载或绑定失败时不运行旧求解器兜底。

## 验证范围

本次重建库的全部三个入口，宿主应用类型检查与生产构建通过；上游 119 个文件的哈希均匹配，运行源码差异仅为 `EDITOR.patch`，模型逐字节一致。Vite 将 Three/MediaPipe peer 从宿主去重解析，版本保持不变。没有运行测试或实时摄像头动作验证；不能据此宣称扭曲、穿模等实际效果已消除。

# 手势模式的同源资产（MediaPipe）

这里是"手势模式"（摄像头 + MediaPipe `HandLandmarker`）运行时需要的两样东西，
以前两者都从第三方下载，现在都随产物同源发出——第二次打开是 0 字节，也不再看
jsDelivr / `storage.googleapis.com` 的脸色。

| 文件 | 来源 | 是否入库 | 大小 |
| --- | --- | --- | --- |
| `0.10.17/wasm/vision_wasm_internal.{js,wasm}` | `node_modules/@mediapipe/tasks-vision/wasm/`（SIMD 那一套） | **不入库**（构建时由脚本复制，`.gitignore` 忽略） | 9.7 MB |
| `0.10.17/hand_landmarker.task` | Google 官方 bucket（float16 / version 1） | **入库**（7.82 MB 二进制） | 7.82 MB |

路径里的版本号是刻意写进 URL 的：`vercel.json` 给 `/mediapipe/*` 配了
`Cache-Control: public, max-age=31536000, immutable`，而"可以 immutable"的前提就是
**换内容必然换 URL**。

## 为什么不入库 wasm

它就在 npm 包里，`app/scripts/sync-hand-assets.ts` 在 `dev` / `build` 之前复制过去。
这样零网络、零 git 体积，而且 wasm 的版本天然跟着 `@mediapipe/tasks-vision` 走
（以前靠一条单测盯 CDN 字符串，现在由脚本直接对比依赖版本，不一致就拒绝构建）。

只复制 **SIMD** 那一套。npm 包里另有一套 `vision_wasm_nosimd_internal.*`（9.38 MB），
但本应用是 WebGPU-only，能跑到这里的浏览器必然支持 wasm SIMD。真正不支持的环境
由 CDN 兜底接住（CDN 目录里两套都在）。

## 为什么模型要入库

npm 包里没有它，而且**没有更好的地方放**：Google bucket 那个 URL 既不压缩
（7.82 MB 原样传）又只缓存 1 小时，正是"打开手势模式要等很久"的最大一项。
所以按用户 2026-10-16 的决定提交进仓库。

重新取一份（只有在升级 MediaPipe 版本时才需要）：

```bash
curl -o app/public/mediapipe/0.10.17/hand_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

## 升级 MediaPipe 时改哪几处（顺序别省）

1. `app/package.json` 的 `@mediapipe/tasks-vision` 与 `app/src/widgets/Viewport/handAssets.ts`
   的 `HAND_ASSET_VERSION` 一起改成新版本；
2. 按新版本重新取模型文件，放到 `app/public/mediapipe/<新版本>/hand_landmarker.task`
   （**注意**：模型自身的发布版本不一定跟着 npm 版本走，换版本后必须真机验"能检测出手"）；
3. 更新 `handAssets.ts` 里的两个 sha256 钉子（`HAND_WASM_SHA256` / `HAND_MODEL_SHA256`）——
   脚本会告诉你实际值；
4. 旧的 `app/public/mediapipe/<旧版本>/` 连同里面的模型一起删掉（它已无人引用，
   留着就是白占部署体积）。

授权：`hand_landmarker.task` 是 Google MediaPipe 的独立发布物（Apache-2.0）；
wasm 随 `@mediapipe/tasks-vision`（Apache-2.0）发布。

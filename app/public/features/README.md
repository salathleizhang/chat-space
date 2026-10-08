# Homepage feature media

The seven MP4 demos below are converted from the supplied GIF recordings. Each
matching JPG is the recording's first frame and serves as its video poster.
Conversion preserves the full 1138 × 640 frame, 10 fps and original duration;
the homepage displays each video without cropping, muted and looping.

| Supplied GIF | Homepage asset stem |
| --- | --- |
| 模型文本编辑.gif | model-generation |
| 世界生成.gif | world-generation |
| 3D批量生成.gif | batch-editing |
| 贴图编辑.gif | shader-editing |
| 云端Blender沙盒.gif | remote-blender |
| 第一人称编辑.gif | first-person-editing |
| 手势追踪编辑.gif | gesture-control |

To replace a recording, convert its GIF with FFmpeg:

```sh
ffmpeg -ignore_loop 1 -i source.gif -an -c:v libx264 -preset slow -crf 20 \
  -pix_fmt yuv420p -movflags +faststart feature.mp4
ffmpeg -ignore_loop 1 -i source.gif -frames:v 1 -update 1 -q:v 2 feature.jpg
```

Feature order, copy and asset URLs live in `app/src/pages/homeShowcase.ts`.
Features without supplied recordings retain their existing static JPGs.

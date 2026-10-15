# Homepage feature media

The seven MP4 demos below are converted from the supplied GIF recordings. Each
matching JPG is retained as the recording's original first-frame preview.
Conversion preserves the full 1138 × 640 frame, 10 fps and original duration;
the homepage displays each video without cropping, muted and looping while
requested. Videos do not autoplay or preload by default.

Each feature initially shows the supplied poster artwork over a sky background
with a 60% white wash. Mouse/pen hover starts the corresponding video; leaving
pauses it, rewinds it and restores the cover. Touch or keyboard users can toggle
playback with the media button. The cover stays visible until the video emits
`playing`, and playback failure restores it. Leaving the viewport, switching
away from the page or losing window focus also stops playback. The two features
without recordings show static covers without a play control.

| Cover artwork | Used for |
| --- | --- |
| Input panel + cursor | Model generation |
| Red chair → green chair on blue sky (25% white wash) | Texture editing |
| Living-room hand interaction artwork | First-person editing |
| Gloved hands and table | Gesture control |
| Generated lounge world thumbnail | World generation |
| Batch material editing before / after on blue sky | Batch editing |
| Dense mesh → simplified mesh chair comparison | Retopology |
| Six model windows | Remote Blender |
| Dragon skeleton → walking pose comparison | Animation |

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

Feature order, English copy and asset URLs live in `app/src/pages/homeShowcase.ts`.
Chinese copy and browser language selection live in `app/src/pages/homeCopy.ts`.
Original JPG previews remain in the repository; displayed cover assignments
are defined by each feature's `cover` field (with optional `coverImage` override).
Rendering and playback are in
`app/src/pages/HomeFeatureMedia.tsx`, with scoped styles in `home.css`.
Feature copy consists of a title and tagline; detailed paragraphs and bullet
lists have been removed from all nine homepage features.

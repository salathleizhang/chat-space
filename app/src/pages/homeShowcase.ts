/**
 * 首页「精选世界」与「产品特性」两段的全部文案与素材地址。
 *
 * **纯数据、零 import**：编辑层冻结集里的 `pages/*.ts` 不得传递依赖渲染库
 * （`editingLayerBoundary.test.ts` 规则 B），所以这里只有类型和字面量。
 *
 * 改文案 / 换素材只动这一个文件：
 *
 * - `SHOWCASE_WORLDS` —— 搜索框下面的 4 张世界缩略图。`projectSlug` 有值就是真实世界，
 *   点击进入该世界的项目工作台（视口会把该世界作为当前世界渲染）；缺省表示占位项，
 *   点击回到项目列表。**把真实 slug 填上就接上了**，别的地方都不用改。
 * - `PRODUCT_FEATURES` —— 特性按顺序左右交替排版。已提供的 GIF 录屏转成
 *   `.mp4` 接在 `video` 上，`image` 是同一录屏的首帧 poster；其余项仍用静态图。
 */

export interface ShowcaseWorld {
  id: string;
  /** 卡面上的世界名 */
  name: string;
  /** 右上角短标签：室内 / 室外 / 尺度 */
  setting: string;
  /** 3:2 缩略图，`app/public/` 下的绝对路径 */
  thumbnail: string;
  /**
   * 这个世界的项目 slug。有值 → 点击进入 `/app/<slug>`。
   * 缺省 → 占位世界，点击回到项目列表（`/app`）。**接真实世界就是填这一行。**
   */
  projectSlug?: string;
}

export interface ProductFeature {
  id: string;
  title: string;
  /** 标题下面那行小字 */
  tagline: string;
  body: string;
  bullets: string[];
  /** 静态预览图；有录屏时是同一录屏的首帧 poster */
  image: string;
  /** 动态素材（mp4/webm）。填上后组件优先渲染它，无需改组件 */
  video?: string;
}

/**
 * 4 个精选世界。
 *
 * ⚠️ 现在只有前两个（`lounge` / `meadow`）是本机真实生成出来的世界，缩略图就是
 * Marble 产物；后两个（`atrium` / `coast`）是**占位图**、没有 `projectSlug`，
 * 等你有真实世界后把图换掉、把 slug 填上即可。
 */
export const SHOWCASE_WORLDS: ShowcaseWorld[] = [
  {
    id: "lounge",
    name: "Light-luxe living room",
    setting: "Interior",
    thumbnail: "/worlds/lounge.webp",
    projectSlug: "p-muo3u17c",
  },
  {
    id: "meadow",
    name: "Sunset meadow",
    setting: "Landscape",
    thumbnail: "/worlds/meadow.webp",
    projectSlug: "p-mu5l6om3",
  },
  {
    id: "atrium",
    name: "Sunlit atrium",
    setting: "Interior",
    thumbnail: "/worlds/atrium.jpg",
  },
  {
    id: "coast",
    name: "Cliff coast",
    setting: "Landscape",
    thumbnail: "/worlds/coast.jpg",
  },
];

/**
 * 产品特性按展示顺序排列；组件按索引奇偶决定图像在左还是在右。
 *
 * 图像两张一组交替，所以列表顺序就是页面上的阅读顺序。
 */
export const PRODUCT_FEATURES: ProductFeature[] = [
  {
    id: "model-generation",
    title: "Model generation & editing",
    tagline: "Text or image in, textured mesh out.",
    body: "Describe a prop, or drop in a reference photo. ChatSpace generates the geometry, materials and textures, then puts the asset straight into your scene. Select a model and describe the changes you want to make.",
    bullets: [
      "Started from a prompt or a reference image",
      "Textured materials assigned on arrival",
      "Lands in the shared scene, ready to place",
    ],
    image: "/features/model-generation.jpg",
    video: "/features/model-generation.mp4",
  },
  {
    id: "world-generation",
    title: "World generation",
    tagline: "Turn a reference into a world you can build in.",
    body: "Start from an image or a description to generate an environment. Ask for the furniture separately, then arrange the generated models inside your world.",
    bullets: [
      "Start from an image or a prompt",
      "Generate the environment and individual models",
      "Explore and arrange everything in one workspace",
    ],
    image: "/features/world-generation.jpg",
    video: "/features/world-generation.mp4",
  },
  {
    id: "batch-editing",
    title: "Batch generation & editing",
    tagline: "Generate a whole set, then edit it together.",
    body: "Describe several models in one request and let ChatSpace generate the set. Multi-select assets to move, rotate, scale or re-material them together, with one undo step for each batch transform.",
    bullets: [
      "Multi-select transform on one shared gizmo",
      "One undo step per batch",
      "Generate multiple models in one request",
    ],
    image: "/features/batch-editing.jpg",
    video: "/features/batch-editing.mp4",
  },
  {
    id: "auto-retopology",
    title: "Automatic retopology",
    tagline: "Editable topology from a dense scan.",
    body: "Turn a photogrammetry-grade mesh into a clean cage you can rig, animate and UV — without a manual retopo pass in another tool.",
    bullets: [
      "Clean, animation-ready edge flow",
      "UVs and materials carry over",
      "Replaces the heavy source mesh in place",
    ],
    image: "/features/auto-retopology.jpg",
  },
  {
    id: "auto-animation",
    title: "Automatic animation",
    tagline: "Rig it, then just ask for the motion.",
    body: "Skeletons are inferred from the mesh, and animation is generated from plain language — walk cycles, idles, one-off gestures — then previewed in the viewport.",
    bullets: [
      "Skeletons inferred from geometry",
      "Describe the motion in words",
      "Re-roll until it reads the way you want",
    ],
    image: "/features/auto-animation.jpg",
  },
  {
    id: "shader-editing",
    title: "Texture & shader editing",
    tagline: "Materials you can actually author.",
    body: "Inspect and edit the material graph of any asset: swap texture channels, drive roughness and metalness, or author your own node setup and watch it update live.",
    bullets: [
      "Per-channel texture overrides",
      "Live viewport preview while you edit",
      "Wireframe and shading modes for inspection",
    ],
    image: "/features/shader-editing.jpg",
    video: "/features/shader-editing.mp4",
  },
  {
    id: "remote-blender",
    title: "Remote Blender control",
    tagline: "A Blender machine you never have to open.",
    body: "Run Blender on a remote host and drive it from the workspace — by hand or by the agent. Watch the live viewport stream while a scripted operation is running.",
    bullets: [
      "Remote session with a live viewport",
      "Scriptable by the agent, auditable by you",
      "Nothing to install on your own machine",
    ],
    image: "/features/remote-blender.jpg",
    video: "/features/remote-blender.mp4",
  },
  {
    id: "first-person-editing",
    title: "First-person editing",
    tagline: "Step into your scene and place things directly.",
    body: "Explore the scene at eye level with mouse and keyboard controls. Grab a model, move it into place and release it; its placement is saved once it settles.",
    bullets: [
      "Mouse look and WASD movement",
      "Grab and reposition models from inside the scene",
      "Settled placements saved to undo history",
    ],
    image: "/features/first-person-editing.jpg",
    video: "/features/first-person-editing.mp4",
  },
  {
    id: "gesture-control",
    title: "Gesture control",
    tagline: "Reach in and move things with your hands.",
    body: "In first-person mode, grab and place assets with tracked hands or VR controllers. Grabbing selects, releasing drops, and the new placement is saved once the object settles.",
    bullets: [
      "Hand and controller tracking",
      "Grab and click share one selection model",
      "Settles, then commits to undo history",
    ],
    image: "/features/gesture-control.jpg",
    video: "/features/gesture-control.mp4",
  },
];

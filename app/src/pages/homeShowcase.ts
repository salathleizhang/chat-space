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
 * - `PRODUCT_FEATURES` —— 10 个特性，左右交替排版。现在 `image` 是静态占位图；
 *   等录屏做好，把 `video` 填上（`.mp4` / `.webm`），组件会自动优先渲染 `<video>`，
 *   `image` 退化成 poster，不用改组件。
 */

export interface ShowcaseWorld {
  id: string;
  /** 卡面上的世界名 */
  name: string;
  /** 右上角短标签：室内 / 室外 / 尺度 */
  setting: string;
  /** 卡面下的一句话介绍 */
  description: string;
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
  /** 静态占位图；录屏接上后它变成 `<video>` 的 poster */
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
    description:
      "An empty modern living room generated from a single reference photo. Walk it in first person, then furnish it with generated models.",
    thumbnail: "/worlds/lounge.webp",
    projectSlug: "p-muo3u17c",
  },
  {
    id: "meadow",
    name: "Sunset meadow",
    setting: "Landscape",
    description:
      "A wide, obstacle-free pasture — flat ground and an unobstructed horizon make it an easy stage for placing props and characters.",
    thumbnail: "/worlds/meadow.webp",
    projectSlug: "p-mu5l6om3",
  },
  {
    id: "atrium",
    name: "Sunlit atrium",
    setting: "Interior",
    description:
      "A four-storey glass atrium with polished floors and tall planters. Long shadows and reflective ground for material studies.",
    thumbnail: "/worlds/atrium.jpg",
  },
  {
    id: "coast",
    name: "Cliff coast",
    setting: "Landscape",
    description:
      "Golden-hour sea cliffs with wind-brushed grass in the foreground and a long open horizon for large-scale exteriors.",
    thumbnail: "/worlds/coast.jpg",
  },
];

/**
 * 10 个产品特性，按展示顺序排列；组件按索引奇偶决定图像在左还是在右。
 *
 * 图像两张一组交替，所以列表顺序就是页面上的阅读顺序。
 */
export const PRODUCT_FEATURES: ProductFeature[] = [
  {
    id: "model-generation",
    title: "Model generation",
    tagline: "Text or image in, textured mesh out.",
    body: "Describe a prop, or drop in a reference photo. ChatSpace generates the geometry, materials and textures, then puts the asset straight into the scene you are already looking at.",
    bullets: [
      "Started from a prompt or a reference image",
      "Textured materials assigned on arrival",
      "Lands in the shared scene, ready to place",
    ],
    image: "/features/model-generation.jpg",
  },
  {
    id: "batch-editing",
    title: "Batch editing",
    tagline: "Operate on the whole set, not one asset at a time.",
    body: "Multi-select any number of assets and move, rotate, scale or re-material them together. The whole batch is committed as a single step, so one undo rewinds all of it.",
    bullets: [
      "Multi-select transform on one shared gizmo",
      "One undo step per batch",
      "Mixes assets from different generations",
    ],
    image: "/features/batch-editing.jpg",
  },
  {
    id: "auto-uv",
    title: "Automatic UV unwrap",
    tagline: "Clean UV islands without leaving the conversation.",
    body: "Every generated model arrives already unwrapped. Re-unwrap any asset on demand, and the new layout flows straight into the texture pipeline.",
    bullets: [
      "Unwrapped automatically on generation",
      "Re-unwrap any asset on demand",
      "Islands published for texture generation",
    ],
    image: "/features/auto-uv.jpg",
  },
  {
    id: "auto-decimation",
    title: "Automatic decimation",
    tagline: "Pick a polygon budget, keep the silhouette.",
    body: "Derive multiple levels of detail from a single asset. Worlds ship with a full ladder of resolutions so the viewport stays interactive at every zoom level.",
    bullets: [
      "Multiple LOD levels per asset",
      "Percent-based reduction, never a rebake",
      "Level of detail stays under your control",
    ],
    image: "/features/auto-decimation.jpg",
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
    title: "Shader editing",
    tagline: "Materials you can actually author.",
    body: "Inspect and edit the material graph of any asset: swap texture channels, drive roughness and metalness, or author your own node setup and watch it update live.",
    bullets: [
      "Per-channel texture overrides",
      "Live viewport preview while you edit",
      "Wireframe and shading modes for inspection",
    ],
    image: "/features/shader-editing.jpg",
  },
  {
    id: "blender-bridge",
    title: "Blender bridge",
    tagline: "Round-trip through real Blender.",
    body: "Send an asset — or the whole scene — to Blender and pull the result back into the same slot. Identity, placement and materials survive the handoff.",
    bullets: [
      "Asset and whole-scene handoff",
      "Placement preserved on return",
      "No re-import, no duplicate in the outliner",
    ],
    image: "/features/blender-bridge.jpg",
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
  },
];

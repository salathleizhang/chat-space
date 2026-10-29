/**
 * 首页「精选世界」与「产品特性」两段的英文文案与共享素材地址。
 *
 * **纯数据、零 import**：编辑层冻结集里的 `pages/*.ts` 不得传递依赖渲染库
 * （`editingLayerBoundary.test.ts` 规则 B），所以这里只有类型和字面量。
 *
 * 英文文案 / 共享素材在这里维护；中文文案与浏览器语言判定见 `homeCopy.ts`：
 *
 * - `SHOWCASE_WORLDS` —— 搜索框下面的 4 张世界缩略图。`projectSlug` 有值就是真实世界，
 *   点击进入该世界的项目工作台（视口会把该世界作为当前世界渲染）；缺省表示占位项，
 *   点击回到项目列表。**把真实 slug 填上就接上了**，别的地方都不用改。
 * - `PRODUCT_FEATURES` —— 特性按顺序左右交替排版。已提供的 GIF 录屏转成
 *   `.mp4` 接在 `video` 上，`image` 保留原始预览；默认展示由 `cover` 指定的海报素材。
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

/**
 * 海报上的三段式标题：黑字主标 → 灰字副标 → 黑底白字点睛句。
 *
 * 点睛句是易拉宝最显眼的记号（「一句话搞定」「同时为你工作」「全部可交互」），
 * 只给中文文案配；英文版仍是普通标题 + 灰色副标。
 */
export interface FeaturePoster {
  /** 灰色副标，数组里每一项单独占一行 */
  sub?: readonly string[];
  /** 黑底白字横条（海报里的「一句话搞定」「不用鼠标键盘」） */
  knock?: string;
  /** 横条排在第一行副标之前（手势那段就是「黑条 → 灰字」） */
  knockFirst?: boolean;
}

export interface ProductFeature {
  id: string;
  title: string;
  /** 标题下面那行小字 */
  tagline: string;
  /** 海报式三段标题；缺省时退回 title + tagline 的普通排版 */
  poster?: FeaturePoster;
  /** 原始预览素材存档；有录屏时是同一录屏的首帧，展示封面由 cover 指定 */
  image: string;
  /** 天空静态封面上叠加的海报素材；录屏只在交互时播放。 */
  cover: "composer" | "models" | "scene" | "hands" | "providers" | "texture" | "batch";
  /** 可按功能覆盖封面图，保留同一套天空底图与版式。 */
  coverImage?: string;
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
    tagline: "Text or image in, textured mesh out",
    image: "/features/model-generation.jpg",
    cover: "composer",
    video: "/features/model-generation.mp4",
  },
  {
    id: "world-generation",
    title: "World generation",
    tagline: "Turn a reference into a world you can build in",
    image: "/features/world-generation.jpg",
    cover: "scene",
    coverImage: "/worlds/lounge.webp",
    video: "/features/world-generation.mp4",
  },
  {
    id: "batch-editing",
    title: "Batch generation & editing",
    tagline: "Generate a whole set, then edit it together",
    image: "/features/batch-editing.jpg",
    cover: "batch",
    video: "/features/batch-editing.mp4",
  },
  {
    id: "auto-retopology",
    title: "Automatic retopology",
    tagline: "Editable topology from a dense scan",
    image: "/features/auto-retopology.jpg",
    cover: "models",
    coverImage: "/landing/retopology.png",
  },
  {
    id: "auto-animation",
    title: "Automatic animation",
    tagline: "Rig it, then just ask for the motion",
    image: "/features/auto-animation.jpg",
    cover: "models",
    coverImage: "/landing/animation.png",
  },
  {
    id: "shader-editing",
    title: "Texture & shader editing",
    tagline: "Materials you can actually author",
    image: "/features/shader-editing.jpg",
    cover: "texture",
    video: "/features/shader-editing.mp4",
  },
  {
    id: "remote-blender",
    title: "Remote Blender control",
    tagline: "A Blender machine you never have to open",
    image: "/features/remote-blender.jpg",
    cover: "models",
    video: "/features/remote-blender.mp4",
  },
  {
    id: "first-person-editing",
    title: "First-person editing",
    tagline: "Step into your scene and place things directly",
    image: "/features/first-person-editing.jpg",
    cover: "scene",
    video: "/features/first-person-editing.mp4",
  },
  {
    id: "gesture-control",
    title: "Gesture control",
    tagline: "Reach in and move things with your hands",
    image: "/features/gesture-control.jpg",
    cover: "hands",
    video: "/features/gesture-control.mp4",
  },
];

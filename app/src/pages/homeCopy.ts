import { PRODUCT_FEATURES, SHOWCASE_WORLDS } from "./homeShowcase";

export type HomeLocale = "en" | "zh-CN";
export const HOME_LOCALE_KEY = "chatspace.homeLanguage:v1";

export function savedHomeLocale(): HomeLocale | null {
  try {
    const saved = localStorage.getItem(HOME_LOCALE_KEY);
    return saved === "en" || saved === "zh-CN" ? saved : null;
  } catch {
    return null;
  }
}

export function saveHomeLocale(locale: HomeLocale): void {
  try {
    localStorage.setItem(HOME_LOCALE_KEY, locale);
  } catch {
    // The in-memory choice still works when browser storage is unavailable.
  }
}

/** Honor browser preference order; other languages fall back to English. */
export function resolveHomeLocale(languages: readonly string[]): HomeLocale {
  for (const language of languages) {
    const primary = language.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === "zh") return "zh-CN";
    if (primary === "en") return "en";
  }
  return "en";
}

export function browserHomeLocale(): HomeLocale {
  if (typeof navigator === "undefined") return "en";
  return resolveHomeLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export const HOME_COPY = {
  en: {
    mainNavigation: "Main navigation",
    languageSelection: "Language",
    projects: "Projects",
    createProject: "Create project",
    imageProject: "Image project",
    dropImage: "Drop to upload image",
    removeImage: (name: string) => `Remove image ${name}`,
    imagesQueued: (count: number) => `${count} ${count === 1 ? "image" : "images"} will be sent after the project is created.`,
    uploadHint: "Upload an image to start creating",
    uploadImage: "Upload image",
    projectName: "Project name",
    projectNameOptional: "Project name (optional)",
    projectPlaceholder: "Name your new project…",
    creatingProject: "Creating project",
    createWithImages: "Create project and send images",
    createFromName: "Create project from name",
    enterWithImages: "Press Enter to create your project and send the images",
    enterToCreate: "Press Enter to create your project",
    projectHint: "Name your project or add an image to start building in ChatSpace.",
    heroPrefix: "Say it,",
    heroSuffix: " it",
    heroAccessible: "Say it, Model it",
    heroTagline: "",
    mascotAlt: "A yellow dragon striking the Blender logo with a sword",
    worldsTitle: "Featured worlds",
    placeholder: "Placeholder",
    browseWorld: (name: string) => `Browse projects (${name} is a placeholder world)`,
    enterWorld: (name: string) => `Enter world ${name}`,
    preview: (name: string) => `${name} preview`,
    demo: (name: string) => `${name} demo`,
    playDemo: (name: string) => `Play ${name} demo`,
    pauseDemo: (name: string) => `Pause ${name} demo`,
    featuresTitle: "What you can do",
    casesTitle: "Cases",
    casesCount: "0 total",
    noCases: "No cases yet",
    casesHint: "Cases made with ChatSpace will appear here when they are added.",
  },
  "zh-CN": {
    mainNavigation: "主导航",
    languageSelection: "语言选择",
    projects: "我的项目",
    createProject: "创建项目",
    imageProject: "图片项目",
    dropImage: "松手，上传图片",
    removeImage: (name: string) => `移除图片 ${name}`,
    imagesQueued: (count: number) => `项目创建后，将发送这 ${count} 张图片。`,
    uploadHint: "上传参考图，开始创作",
    uploadImage: "上传图片",
    projectName: "项目名称",
    projectNameOptional: "项目名称（可选）",
    projectPlaceholder: "给你的新项目起个名字…",
    creatingProject: "正在创建项目",
    createWithImages: "创建项目并发送图片",
    createFromName: "创建这个项目",
    enterWithImages: "按回车，创建项目并发送图片",
    enterToCreate: "按回车，开始创作",
    projectHint: "起个名字，或放入一张参考图，让想法变成现实。",
    heroPrefix: "会说话，",
    heroSuffix: "",
    heroAccessible: "会说话，就会建模",
    heroTagline: "言出法随，一句话搞定",
    mascotAlt: "黄色奶龙挥剑击中 Blender 标志",
    worldsTitle: "一句话，生成一个世界",
    placeholder: "示例占位",
    browseWorld: (name: string) => `浏览项目（${name}为示例占位）`,
    enterWorld: (name: string) => `进入世界：${name}`,
    preview: (name: string) => `${name}预览`,
    demo: (name: string) => `${name}演示`,
    playDemo: (name: string) => `播放${name}演示`,
    pauseDemo: (name: string) => `暂停${name}演示`,
    featuresTitle: "会说，就会做",
    casesTitle: "创作案例",
    casesCount: "共 0 个",
    noCases: "更多作品，即将登场",
    casesHint: "用 ChatSpace 创作的案例，将在这里与你见面。",
  },
};

export type HomeCopy = typeof HOME_COPY.en;

export const HOME_ACTIONS = {
  en: ["Model", "Unwrap", "Retopo", "Texture", "Rig", "Animate"],
  "zh-CN": ["建模", "展 UV", "拓扑", "贴图", "绑骨", "动画"],
};

const ZH_FEATURE_COPY: Record<string, { title: string; tagline: string }> = {
  "model-generation": { title: "言出法随", tagline: "一句话，建模、编辑全搞定" },
  "world-generation": { title: "一句话生成一个世界", tagline: "场景里的道具，生成后随手摆放" },
  "batch-editing": { title: "一整套，同时开工", tagline: "批量生成，一起移动、旋转、换材质" },
  "auto-retopology": { title: "拓扑，一句话搞定", tagline: "复杂模型，理出清晰结构" },
  "auto-animation": { title: "绑骨、动画，开口就行", tagline: "让这个小人，走起来" },
  "shader-editing": { title: "换张贴图，换个模样", tagline: "材质怎么改，你说了算" },
  "remote-blender": { title: "云端沙盒", tagline: "Blender 在云端，为你工作" },
  "first-person-editing": { title: "走进你创造的世界", tagline: "拿起、摆好，场景里的道具亲手放" },
  "gesture-control": { title: "伸手，就能摆放", tagline: "手势追踪，VR 里也能用" },
};

const ZH_WORLD_COPY: Record<string, { name: string; setting: string }> = {
  lounge: { name: "轻奢客厅", setting: "室内" },
  meadow: { name: "落日草甸", setting: "自然" },
  atrium: { name: "日光中庭", setting: "室内" },
  coast: { name: "悬崖海岸", setting: "海岸" },
};

// Localize only copy; stable IDs, project routes and media stay shared.
export const HOME_FEATURES = {
  en: PRODUCT_FEATURES,
  "zh-CN": PRODUCT_FEATURES.map((feature) => ({ ...feature, ...ZH_FEATURE_COPY[feature.id] })),
};
export const HOME_WORLDS = {
  en: SHOWCASE_WORLDS,
  "zh-CN": SHOWCASE_WORLDS.map((world) => ({ ...world, ...ZH_WORLD_COPY[world.id] })),
};

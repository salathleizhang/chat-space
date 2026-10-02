/**
 * 默认场景光照 + 环境贴图兜底——让 PlayCanvas 分支的画面与 three 分支一致的两件**必需**事。
 *
 * ### 为什么这两件事放在同一个文件里
 * 它们治的是同一个症状（"场景全黑、贴图看不见"），而且对**本项目这批产物**必须成对出现：
 *
 * ① **引擎没有默认光**：`scene.ambientLight` 默认就是 `(0, 0, 0)`
 *    （`scene.js:29`；d.ts 原话 "Defaults to black (0,0,0)"），而 Tripo 出的 GLB **不带任何灯**。
 *    不接线的话所有 `StandardMaterial` 的受光项恒为 0 → 画面上只剩剪影。
 *    three 侧一直有光（`widgets/Viewport/index.tsx`：`ambientLight 0.6` + 两盏
 *    `directionalLight` 1.4 / 0.4），这里的数值就是照它抄的。
 * ② **这批产物是金属**：实测材质 `metalness: 1`（glTF `metallicFactor: 1`）。金属几乎没有
 *    漫反射项，颜色主要来自**环境反射**——只补灯只有高光，贴图仍然"看不见"。所以
 *    `scene.envAtlas`（IBL）必须同时有。three 侧靠 drei 的 `<Environment map={…}>`，
 *    PC 侧**没有任何默认环境贴图**：此前只在"项目选了天空盒**且**产物有 `hdrPath`"时才建，
 *    于是没选天空盒的项目连 IBL 都没有——`DEFAULT_ENVIRONMENT_URL` 就是补这个兜底。
 *
 * ### 真机读数（2026-10-02，`/app/p-muo3u17c?pcViewport=1`，读的是引擎事实）
 * 修前：`lights: []`、`ambientLight: (0,0,0)`、`envAtlas: false`、亮像素 **7104**（全黑剪影）。
 * 修后见 `PLAYCANVAS_MIGRATION.md` §三之十四 增量 18（含 A/B 截图与读数）。
 *
 * ⚠️ 引擎 API 的调用**只有真实浏览器里才算验证过**；单测覆盖的是"注入了假实体之后，
 * 我们确实按 three 侧那份数值建了灯、方向用 `lookAt` 表达、dispose 真的销毁了它们"。
 */

/** 环境光颜色（对齐 three 侧 `ambientLight intensity={0.6}`；引擎按 sRGB 解释该颜色）。 */
export const DEFAULT_AMBIENT_LIGHT: readonly [number, number, number] = [0.6, 0.6, 0.6];

export interface DirectionalLightSpec {
  intensity: number;
  /** 世界坐标下的位置；方向 = 该点指向原点（引擎平行光的方向是实体的 **−Z**）。 */
  position: readonly [number, number, number];
}

/**
 * 两盏平行光，逐项对齐 three 侧（`widgets/Viewport/index.tsx`）：
 * `position=[4,6,4] intensity=1.4` 与 `position=[-4,2,-3] intensity=0.4`。
 *
 * three 的平行光指向它自己的 target（默认原点）；引擎的平行光方向是实体的 −Z，所以用
 * `setPosition(position)` + `lookAt(0, 0, 0)` 表达同一个方向。**不要手写欧拉角**：引擎的欧拉
 * 是角度 + ZYX，和 three 的弧度 + XYZ 不是一套（`selectionTransform.ts` 文件头有实测）。
 */
export const DEFAULT_DIRECTIONAL_LIGHTS: readonly DirectionalLightSpec[] = [
  { intensity: 1.4, position: [4, 6, 4] },
  { intensity: 0.4, position: [-4, 2, -3] },
];

/** 只取本模块真正用到的引擎侧接口（窄结构便于单测注入假实体）。 */
export interface LightEntityLike {
  addComponent(type: string, data?: Record<string, unknown>): unknown;
  setPosition(x: number, y: number, z: number): void;
  lookAt(x: number, y: number, z: number): void;
  /** `Entity.destroy()` 会依次禁用并摘除组件、再从父节点上摘掉自己（`entity.js:157-170`）。 */
  destroy(): void;
}

export interface LightingAppLike {
  scene: { ambientLight: unknown };
  root: { addChild(child: unknown): void };
}

export interface SceneLightingOptions {
  /** 覆盖环境光（测试用）。 */
  ambient?: readonly [number, number, number];
  /** 覆盖平行光表（测试用）。 */
  lights?: readonly DirectionalLightSpec[];
  /** 测试注入点：默认 `new Entity(name)`。 */
  createEntity?(name: string): LightEntityLike;
  /** 测试注入点：默认 `new Color(r, g, b)`。 */
  createColor?(r: number, g: number, b: number): unknown;
}

export interface SceneLightingHandle {
  ambient(): readonly [number, number, number];
  /** 已建的灯（诊断/自检用）；`dispose()` 之后为空表。 */
  entities(): readonly LightEntityLike[];
  dispose(): void;
}

async function defaultEntityFactory(): Promise<(name: string) => LightEntityLike> {
  const { Entity } = await import("playcanvas");
  return (name) => new Entity(name) as unknown as LightEntityLike;
}

async function defaultColorFactory(): Promise<(r: number, g: number, b: number) => unknown> {
  const { Color } = await import("playcanvas");
  return (r, g, b) => new Color(r, g, b);
}

/**
 * 建默认光照：写 `scene.ambientLight` + 逐条建平行光实体挂到 `app.root`。
 * 幂等性由调用方负责（每个 app 只建一次，卸载时 `dispose()`）。
 */
export async function createSceneLighting(
  app: LightingAppLike,
  options: SceneLightingOptions = {},
): Promise<SceneLightingHandle> {
  const ambient = options.ambient ?? DEFAULT_AMBIENT_LIGHT;
  const lights = options.lights ?? DEFAULT_DIRECTIONAL_LIGHTS;
  const createColor = options.createColor ?? await defaultColorFactory();
  const createEntity = options.createEntity ?? await defaultEntityFactory();

  app.scene.ambientLight = createColor(ambient[0], ambient[1], ambient[2]);

  const created: LightEntityLike[] = [];
  for (const [index, spec] of lights.entries()) {
    const entity = createEntity(`viewport-light:${index}`);
    entity.addComponent("light", {
      type: "directional",
      color: createColor(1, 1, 1),
      intensity: spec.intensity,
    });
    entity.setPosition(spec.position[0], spec.position[1], spec.position[2]);
    entity.lookAt(0, 0, 0);
    app.root.addChild(entity);
    created.push(entity);
  }

  return {
    ambient: () => [...ambient] as [number, number, number],
    entities: () => [...created],
    dispose() {
      for (const entity of created) entity.destroy();
      created.length = 0;
    },
  };
}

/**
 * 环境贴图的默认兜底：**引擎能解析的** equirect 图。
 * 不能沿用 three 侧那份 `/env/sky.exr`——引擎 2.22.6 的贴图解析器只有 img / dds / basis / hdr
 * （`build/playcanvas.mjs:102231-102236`，全仓库 grep 不到 exr），喂给它只会走到 catch 里。
 * `app/public/env/sky.jpg` 是同一片天空的 2048×1024 版本（与 `sky.exr` 同一个 `env/` 目录），
 * 引擎按 `img` 解析——实测能走通 `EnvLighting` 那条管线（见 §三之十四 增量 18）。
 */
export const DEFAULT_ENVIRONMENT_URL = "/env/sky.jpg";

/**
 * 环境贴图的候选表：**按顺序试，第一个成功的生效**——项目产物 → 默认兜底。
 * `primary` 为 null/空串（项目没选天空盒，或占位资产的 `hdrPath` 是 null）时只剩默认那张。
 *
 * 传进来的必须是**已经可 fetch 的 URL**（逻辑路径要先过 `libraryUrl`），本函数不做任何路径改写。
 */
export function environmentCandidates(
  primary: string | null | undefined,
  fallback: string = DEFAULT_ENVIRONMENT_URL,
): string[] {
  const candidates: string[] = [];
  for (const url of [primary, fallback]) {
    if (typeof url === "string" && url.length > 0 && !candidates.includes(url)) candidates.push(url);
  }
  return candidates;
}

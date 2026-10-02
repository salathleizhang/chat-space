/**
 * 编辑器地面网格：**两级网格 + 屏幕空间导数抗锯齿 + 以相机为圆心的距离淡出**，
 * 公式逐项照搬 three 侧 `widgets/Viewport/WebGPUGrid.tsx`（TSL），这里改写成 PlayCanvas 的 WGSL。
 *
 * ### 不要照抄 SuperSplat 的 `infinite-grid-shader.ts`
 * 那份是**全屏 quad + 射线/平面求交**（`infinite-grid.ts` 里 `QuadRender` + `preRenderLayer`，
 * WGSL 里自己解 `intersectPlane`、还算光线的屏幕导数）。本项目的场景是**有限的 400×400 平面**
 * （与 three 侧一致），所以这里就是一个平面 mesh + 自定义 WGSL 材质——几何与 superplat 完全不同。
 * 从它那里只值得借"**怎么在 PlayCanvas 里写 WGSL**"：`ShaderMaterial({ uniqueName, attributes,
 * vertexWGSL, fragmentWGSL })`，着色器代码里自己声明 `attribute vertex_position: vec4f;` 与
 * `uniform matrix_model/matrix_viewProjection`（照 .pc-research/engine 的示例）。
 *
 * ### 三条实测/源码约束
 * ① **相机世界位置用引擎的标准 uniform `view_position`**（`UNIFORMTYPE_VEC3`，
 *    `forward-renderer.js` 的 view uniform buffer，见 bundle 里 `UniformFormat("view_position", …)`）。
 *    它是**按相机**填的，所以每个窗格各自算自己的淡出——这一点必须用逐相机 uniform，
 *    不能用材质参数（否则 4 窗格会共用最后一次写入的值）。
 * ② **网格必须 `pick = false`**。`MeshInstance.pick` 默认是 `true`（`mesh-instance.js:100`），
 *    而这是一张 400×400 的平面：不关掉它，每次点击都会先命中地面（three 侧对应的写法是
 *    `raycast={() => {}}`）。拾取只给共享核心层，地面也在核心层里，所以这条必须在网格侧关。
 * ③ **`uniqueName` 可以固定**：着色器按 `uniqueName` 缓存在**每设备**的 program library 里
 *    （`get-program-library.js` 用 device 作键），所以设备重建后不会拿到旧设备的着色器。
 *
 * ⚠️ 本文件对引擎 API 的调用**只在真实浏览器里才算验证过**；单测覆盖的是 `gridLineMask()` /
 * `gridFade()` 这两个与 WGSL 同式的参考实现（着色器里的公式必须与它们逐项一致）。
 */

/** 平面边长（世界单位）。与 three 侧一致；改变它是几何参数，不是材质参数。 */
export const GRID_SIZE = 400;
/** 细线间距（世界单位）。 */
export const GRID_CELL_SIZE = 0.5;
/** 粗线间距（世界单位）。必须是细线的整数倍，否则两组线会互相踩。 */
export const GRID_SECTION_SIZE = 5;
/** 淡出半径（世界单位，XZ 平面内以相机为圆心）。 */
export const GRID_FADE_DISTANCE = 40;

export interface GridParams {
  cellSize: number;
  sectionSize: number;
  fadeDistance: number;
}

export const DEFAULT_GRID_PARAMS: GridParams = {
  cellSize: GRID_CELL_SIZE,
  sectionSize: GRID_SECTION_SIZE,
  fadeDistance: GRID_FADE_DISTANCE,
};

/**
 * 一组平行线的覆盖度（0..1）。**与 WGSL 里的 `gridLine()` 同式**：
 * `p = xz / size`，`d = |fract(p - 0.5) - 0.5| / max(fwidth(p), 1e-5)`，
 * 再 `1 - min(min(d.x, d.y) + (1 - thickness), 1)`。
 *
 * `derivative` 就是 `fwidth(p)`（屏幕空间里一个像素对应多少"格"）——传进来是为了让它可单测；
 * 着色器里由 GPU 的 `fwidth()` 直接给。
 */
export function gridLineMask(
  x: number,
  z: number,
  size: number,
  thickness: number,
  derivative: number,
): number {
  if (!(size > 0)) return 0;
  const p = [x / size, z / size];
  const d = Math.max(derivative, 1e-5);
  const distanceToLine = [
    Math.abs(fract(p[0]! - 0.5) - 0.5) / d,
    Math.abs(fract(p[1]! - 0.5) - 0.5) / d,
  ];
  return 1 - Math.min(Math.min(distanceToLine[0]!, distanceToLine[1]!) + (1 - thickness), 1);
}

/** 距相机的淡出系数（0..1）：`pow(clamp(1 - d / fade, 0, 1), 1.5)`，与 WGSL 里同式。 */
export function gridFade(distance: number, fadeDistance: number): number {
  if (!(fadeDistance > 0)) return 0;
  const clamped = Math.min(Math.max(1 - distance / fadeDistance, 0), 1);
  return clamped ** 1.5;
}

/** `fract()` 的 JS 版（JS 的 `%` 对负数取负，WGSL/GLSL 的 `fract` 不是）。 */
function fract(value: number): number {
  return value - Math.floor(value);
}

/**
 * 顶点着色器：把世界坐标与裁剪坐标都算出来。**不要**在这里做网格计算——网格是屏幕空间
 * 导数相关的，只能在片元里算（顶点里算会得到"顶点级"的分辨率，线会断）。
 */
export const GRID_VERTEX_WGSL = /* wgsl */ `
attribute vertex_position: vec4f;
uniform matrix_model: mat4x4f;
uniform matrix_viewProjection: mat4x4f;
varying vWorldPosition: vec3f;

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPosition = uniform.matrix_model * input.vertex_position;
    output.vWorldPosition = worldPosition.xyz;
    output.position = uniform.matrix_viewProjection * worldPosition;
    return output;
}
`;

/**
 * 片元着色器：两级线 + 淡出。颜色 `#1a1a1a` / `#333333`、透明度
 * `(cells + sections) * fade * mix(0.75, 1, sections)` 都与 three 侧逐项一致。
 *
 * ### 为什么三个间距/半径是**编译期常量**而不是 uniform
 * 它们在这张着色器里进了 **mesh uniform buffer**（`ub_mesh_ub`）：引擎把"不在标准 view 集合里"
 * 的 uniform 全塞进那个 UB（`webgpu-shader-processor-wgsl.js` 的 `processUniforms`，并把
 * `uniform.X` 重写成 `ub_mesh_ub.X`）。实测**建材质之后再用 `material.setParameter()` 改它们不生效**
 * （`uCellSize`/`uSectionSize` 改了画面一动不动；`view_position` 这种 view UB 里的才跟着相机走）。
 * 而这三个值本来就是产品常量，所以直接烘进着色器源码、按参数拼 `uniqueName`——
 * 改参数 = 换一份着色器（引擎按 uniqueName 缓存），既不依赖那条 UB 上传路径，也更快。
 */
export function gridFragmentWgsl(params: GridParams): string {
  return /* wgsl */ `
uniform view_position: vec3f;
varying vWorldPosition: vec3f;

const CELL_SIZE: f32 = ${formatFloat(params.cellSize)};
const SECTION_SIZE: f32 = ${formatFloat(params.sectionSize)};
const FADE_DISTANCE: f32 = ${formatFloat(params.fadeDistance)};

// 与 paneGrid.ts 的 gridLineMask() 同式：先算"离最近一条线多少格"，再用屏幕空间导数归一化，
// 得到"离最近一条线多少像素"。这样线宽在任何距离/机位下都稳定在一个像素左右。
fn gridLine(xz: vec2f, size: f32, thickness: f32) -> f32 {
    let p = xz / max(size, 1e-4);
    let distanceToLine = abs(fract(p - vec2f(0.5)) - vec2f(0.5)) / max(fwidth(p), vec2f(1e-5));
    return 1.0 - min(min(distanceToLine.x, distanceToLine.y) + (1.0 - thickness), 1.0);
}

@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
    var output: FragmentOutput;
    let xz = input.vWorldPosition.xz;
    let cells = gridLine(xz, CELL_SIZE, 0.5);
    let sections = gridLine(xz, SECTION_SIZE, 1.0);
    // 淡出圆心是**这一台相机**的位置：view_position 是逐相机的标准 uniform（在 view UB 里）
    let fade = pow(clamp(1.0 - distance(xz, uniform.view_position.xz) / max(FADE_DISTANCE, 1e-4), 0.0, 1.0), 1.5);
    let base = vec3f(0.10196078, 0.10196078, 0.10196078);
    let sectionColor = vec3f(0.2, 0.2, 0.2);
    let rgb = mix(base, sectionColor, sections);
    let alpha = (cells + sections) * fade * mix(0.75, 1.0, sections);
    output.color = vec4f(rgb, alpha);
    return output;
}
`;
}

/** 默认参数下的片元着色器（探针/测试/文档引用用）。 */
export const GRID_FRAGMENT_WGSL = gridFragmentWgsl(DEFAULT_GRID_PARAMS);

/** WGSL 里的 f32 字面量：必须带小数点，`1e6` 这种写成 `1000000.0` 才稳。 */
function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  const text = value.toFixed(6).replace(/0+$/, "");
  return text.endsWith(".") ? `${text}0` : text;
}

/** 参数指纹：进 `uniqueName`，保证不同参数是不同的着色器变体。 */
export function gridParamsKey(params: GridParams): string {
  return `${formatFloat(params.cellSize)}_${formatFloat(params.sectionSize)}_${formatFloat(params.fadeDistance)}`;
}

/** 材质的最小接口（引擎 `ShaderMaterial` 满足），测试与探针都只依赖这些。 */
export interface ShaderMaterialLike {
  blendType: number;
  depthWrite: boolean;
  cull: number;
  setParameter(name: string, value: unknown): void;
  update(): void;
  destroy(): void;
}

/** 网格实体的最小接口（引擎 `Entity` 满足）。 */
export interface GridEntityLike {
  render?: { meshInstances?: { pick: boolean }[]; material?: unknown } | null;
  layers?: number[];
  enabled?: boolean;
  addComponent(type: string, options?: unknown): void;
  setLocalScale(x: number, y: number, z: number): void;
  setEulerAngles(x: number, y: number, z: number): void;
  destroy(): void;
}

export interface EditorGridOptions {
  /** 平面边长，默认 `GRID_SIZE`。 */
  size?: number;
  params?: Partial<GridParams>;
  /** 放在哪个层；默认不加（跟着 `app.root` 走默认 World 层）。 */
  layerId?: number;
  /** 测试注入点。 */
  createMaterial?: (params: GridParams) => ShaderMaterialLike;
  /** 测试注入点：建网格实体。 */
  createEntity?: (name: string) => GridEntityLike;
}

export interface EditorGridHandle {
  entity: unknown;
  /** 网格的 mesh instance 数（探针用来断言 `pick === false`）。 */
  meshInstanceCount(): number;
  /** 还有几个 mesh instance 是可拾取的（**必须是 0**）。 */
  pickableMeshInstanceCount(): number;
  /** 改参数会**换一份烘好常量的材质**，所以是异步的（首次还要等 playcanvas 动态导入）。 */
  setParams(params: Partial<GridParams>): Promise<void>;
  /** 材质被重建过几次（诊断：改参数到底有没有换材质）。 */
  materialVersion(): number;
  params(): GridParams;
  /** 显隐（引擎侧就是 `entity.enabled`）。探针用它做"挂上/摘掉"的逐格像素对比。 */
  setVisible(visible: boolean): void;
  visible(): boolean;
  dispose(): void;
}

/**
 * 建一份网格。整个场景**一份就够**（与 three 侧一致）：它在共享核心层上，所有窗格都看得见，
 * 而淡出圆心来自逐相机的 `view_position`，所以每格各自淡出。
 */
export async function createEditorGrid(app: unknown, options: EditorGridOptions = {}): Promise<EditorGridHandle> {
  const size = options.size ?? GRID_SIZE;
  let current: GridParams = { ...DEFAULT_GRID_PARAMS, ...options.params };

  const buildMaterial = async (params: GridParams): Promise<ShaderMaterialLike> => {
    if (options.createMaterial) return options.createMaterial(params);
    const { ShaderMaterial, SEMANTIC_POSITION, CULLFACE_NONE, BLEND_NORMAL } = await import("playcanvas");
    const created = new ShaderMaterial({
      // 参数烘进源码，所以 uniqueName 必须带参数指纹（否则会命中别的变体）
      uniqueName: `editor-grid:${gridParamsKey(params)}`,
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexWGSL: GRID_VERTEX_WGSL,
      fragmentWGSL: gridFragmentWgsl(params),
    }) as unknown as ShaderMaterialLike;
    // 与 three 侧一致：透明、不写深度、双面（从下方也看得见）
    created.blendType = BLEND_NORMAL;
    created.depthWrite = false;
    created.cull = CULLFACE_NONE;
    created.update();
    return created;
  };
  let materialVersion = 1;
  let material: ShaderMaterialLike = await buildMaterial(current);

  const entity: GridEntityLike = options.createEntity
    ? options.createEntity("editor:grid")
    : await (async () => {
      const { Entity } = await import("playcanvas");
      return new Entity("editor:grid") as unknown as GridEntityLike;
    })();
  entity.addComponent("render", { type: "plane" });
  // ⚠️ **不要**照搬 three 的 `rotation-x={-Math.PI/2}`：PlayCanvas 的 `PlaneGeometry` 默认
  // 就躺在 XZ 平面、法线是 +Y（`plane-geometry.d.ts:35-41` 的原话），再转 -90° 会把地面**立起来**，
  // 症状是"网格变成屏幕中间一条横带"而且零报错（本机踩过）。宽度沿 X、长度沿 Z，直接缩放即可。
  entity.setLocalScale(size, size, 1);
  if (entity.render) {
    entity.render.material = material as never;
    // ② 必须关掉拾取：400×400 的平面会把所有点击都吃掉
    for (const instance of entity.render.meshInstances ?? []) instance.pick = false;
  }
  if (options.layerId !== undefined) entity.layers = [options.layerId];
  const root = (app as { root: { addChild(child: unknown): void } }).root;
  root.addChild(entity);

  /** 改参数 = 换一份烘好常量的材质（见文件头：这条 UB 上传路径实测不生效）。 */
  const applyParams = async (params: GridParams) => {
    const previous = material;
    material = await buildMaterial(params);
    materialVersion += 1;
    if (entity.render) entity.render.material = material as never;
    // 旧材质此时已经没有人引用了，直接销毁（它的着色器变体留在引擎的缓存里，按 uniqueName 复用）
    if (previous !== material) previous.destroy();
  };

  const meshInstances = () => entity.render?.meshInstances ?? [];

  return {
    entity,
    meshInstanceCount: () => meshInstances().length,
    pickableMeshInstanceCount: () => meshInstances().filter((instance) => instance.pick).length,
    async setParams(params) {
      const next = { ...current, ...params };
      // 参数没变就不重建
      if (gridParamsKey(next) === gridParamsKey(current)) return;
      current = next;
      await applyParams(current);
    },
    params: () => ({ ...current }),
    materialVersion: () => materialVersion,
    setVisible(visible) { entity.enabled = visible; },
    visible: () => entity.enabled !== false,
    dispose() {
      entity.destroy();
      material.destroy();
    },
  };
}

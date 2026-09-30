import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * 守住"编辑层不依赖渲染库"这条不变量。
 *
 * 背景：渲染层要从 three.js/R3F/drei 全量迁移到 PlayCanvas。迁移的前提是
 * **编辑层（撤销栈、选中、摆放、材质、落盘、Inspector 的 UI）不用改**。一旦编辑层直接或间接
 * 依赖了渲染库，迁移就会被迫改动它——而这**在编译期与运行期都看不出来**（类型检查会过、
 * 测试也会过），只有迁到一半才发现。
 *
 * 判据分三条，刻意区分"逻辑"与"UI 组合"：
 *
 * - **规则 A（直接导入）**：冻结集里任何文件都不得直接 import 渲染库。
 *   直接导入意味着有人在编辑层里写渲染代码。
 * - **规则 B（传递依赖）**：冻结集里除"页面组合根"以外的文件不得**传递地**依赖渲染库。
 *   这一条抓到过真实 bug：useSceneHistory.ts（撤销栈）从 materialOverrides.ts 取一个纯常量，
 *   却因此把 three 拉进了撤销栈。
 *   **唯一豁免是 pages/ 下的 .tsx**：页面就是组合根，它渲染 <Viewport> / <ModelList> /
 *   <ModelPreviewWindow> 是正常架构。但 widgets/Inspector 的 .tsx **不豁免**——Inspector 是纯编辑
 *   面板，它没有理由去组合 3D surface，更不该伸手进渲染层的场景图。
 * - **规则 C（契约纯净）**：编辑层与渲染层之间的数据契约模块必须保持纯数据。
 *
 * 任何跨出冻结集的、传递依赖渲染库的目标都必须在 SEAMS 里**逐条声明理由**；
 * 两张表都是**活的 TODO 清单**——某条不再被触达时测试会失败，要求删掉，避免豁免腐烂。
 */

const SRC = resolve(import.meta.dir, "..");

/** 依赖这些包的模块属于"渲染层"。 */
const RENDERER_PACKAGES = [/^three$/, /^three\//, /^@react-three\//, /^gaussian-splat-lite$/];

/** 冻结集：渲染层迁移时这些必须一行不改。渲染层自己（widgets/Viewport、shared/rendering…）不在其内。 */
const FROZEN_PREFIXES = [
  "pages/",
  "widgets/Inspector/",
  "widgets/AgentDock/",
  "widgets/Sidebar/",
  "widgets/SettingsDialog/",
  "widgets/ModelList/",
  "shared/storage/",
];

/**
 * 接缝白名单：规则 B 允许冻结集里的逻辑模块碰到的、且传递依赖渲染库的目标。
 * 每条都必须写清"为什么允许"以及"迁移时怎么处理"。
 */
const SEAMS: Record<string, string> = {
  /*
    ✅ **本表当前为空。** Phase 3 把编辑层对渲染层的三处越界全部消除：
      - Inspector 的贴图通道查询 → 消费"模型描述"（`shared/lib/modelDescription.ts`）
      - `LoadedAssetObject` / `collectSupportedSlots` / `collectChannelTextures` 三条 SEAMS
      - `InspectionRequest` 类型 → 纯模块 `shared/lib/inspection.ts`
    **任何新越界都必须在这里逐条声明理由**；失效检查会强制删掉不再需要的条目。
  */
  "shared/lib/modelTextures.ts":
    "🔴 待消除（随 ModelList 迁移）：仅剩 `widgets/ModelList/AssetTextureStrip.tsx` 在用它（three 场景图遍历）。",
  "widgets/Viewport/ModelMesh.tsx":
    "🔴 待消除（随 ModelList 迁移）：仅剩 `AssetTextureStrip.tsx` 在用它的 `LoadedAssetObject`。",
  /*
    ✅ Phase 3 已消除的三条（曾在这张表里）：
      - `widgets/Viewport/ModelMesh.tsx`
      - `shared/lib/materialOverrides.ts`
      - `shared/lib/modelTextures.ts`
    Inspector 的贴图通道查询已从"自己挂载 loader 组件遍历 three 对象"改成"消费渲染层发布的
    模型描述"（`shared/lib/modelDescription.ts`）。**任何新越界都必须在这里逐条声明理由**，
    失效检查会强制删掉不再需要的条目。

    ⚠️ 已知尚未纳入本守卫的同类越界：`widgets/ModelList/AssetTextureStrip.tsx` 仍用
    `LoadedAssetObject`（`ModelList/` 不在 FROZEN_PREFIXES 里）。等 ModelList 迁移时应一并处理，
    并把它加进冻结集。
  */
};

/**
 * 规则 A 的例外：冻结集内部**自己就 import 了渲染库**的文件。
 * 与 SEAMS（跨出冻结集）是两回事，必须分别声明，不能靠不开规则来放过。
 */
const FROZEN_IMPORTERS: Record<string, string> = {
  "widgets/ModelList/AssetTextureStrip.tsx":
    "🔴 待消除（**不要顺手改**）：它现在是「自己挂载加载器 → 遍历 three 对象」；改成消费 modelDescription 后，**只有视口加载过的资产**才有贴图——对「悬停一个不在场景里的资产」是可见的功能退化。消除它需要先决定这个产品行为（接受退化，或给模型库一条不拉全量的贴图来源）。",
};

/**
 * **冻结目录里的渲染组件**：它们不是编辑逻辑，而是住在冻结目录里的 3D surface
 * （与 `widgets/Viewport` 同类）。两条规则都豁免——它们依赖渲染层是本分。
 *
 * 与 `FROZEN_IMPORTERS` 的区别：那张表是"编辑层的文件不该导入渲染库"的例外（本身是待消除的越界），
 * 这张表是"这个文件本来就不属于编辑层"。语义不同，不能合并。
 */
const RENDERING_COMPONENTS_IN_FROZEN_DIRS: Record<string, string> = {
  "widgets/ModelList/ThumbnailRenderer.tsx":
    "缩略图 3D surface，由 `pages/AppDashboard` 渲染；props 即冻结契约，内部随渲染层迁移到 PlayCanvas。",
};

/** 编辑层与渲染层之间的数据契约：必须保持纯数据，迁移时不动。 */
const PURE_CONTRACT = [
  "widgets/Viewport/liveTransforms.ts",
  "widgets/Viewport/scenePlacement.ts",
  "widgets/Viewport/transformMode.ts",
  "shared/lib/libraryApi.ts",
  "shared/lib/materialSchema.ts",
  // 贴图通道表 + 缩略图 + 数据类型：渲染层换引擎时这一半不动（只有遍历那一半要重写）
  "shared/lib/textureSlots.ts",
  // 渲染层 → 编辑层的"模型描述"契约。**不得**导入 three / playcanvas：
  // 它同时被编辑层（Inspector 消费）与渲染层（Viewport 生产）引用。
  "shared/lib/modelDescription.ts",
  // "视觉自检"的请求/结果契约：编辑层与渲染层之间，必须是纯数据
  "shared/lib/inspection.ts",
  // 检查图的视角定义与 2×2 合成器：两个引擎共用同一份版式，不得依赖任一引擎
  "shared/lib/inspectionSheet.ts",
  // 相机台架的纯数学（轨道/缩放/平移/聚焦/正交可见高度）：两个引擎共用同一份状态机
  "shared/lib/cameraRig.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 抓出 import / export ... from、副作用 import、动态 import 的模块说明符。 */
function specifiers(code: string): string[] {
  const found = new Set<string>();
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']/g, /\bimport\s+["']([^"']+)["']/g];
  for (const re of patterns) {
    for (const match of code.matchAll(re)) found.add(match[1]!);
  }
  return [...found];
}

/** 必须是**文件**：existsSync 对目录也返回 true，会把 widgets/Viewport 解析成目录而不是 index.tsx。 */
const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const candidates = (base: string) => [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base];

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // 包名不是本仓库文件
  return candidates(resolve(dirname(fromFile), spec)).find(isFile) ?? null;
}

const FILES = walk(SRC);
const CODE = new Map(FILES.map((file) => [file, readFileSync(file, "utf8")]));
const EDGES = new Map(
  FILES.map((file) => {
    const deps = new Map<string, string>();
    for (const spec of specifiers(CODE.get(file)!)) {
      const target = resolveSpecifier(file, spec);
      if (target) deps.set(target, spec);
    }
    return [file, deps];
  }),
);

const memo = new Map<string, boolean>();
/** 该文件是否（传递地）依赖任何渲染库。 */
function dependsOnRenderer(file: string, seen = new Set<string>()): boolean {
  const cached = memo.get(file);
  if (cached !== undefined) return cached;
  if (seen.has(file)) return false; // 环：由环外那一层决定
  seen.add(file);
  const direct = specifiers(CODE.get(file) ?? "").some((spec) => RENDERER_PACKAGES.some((re) => re.test(spec)));
  const result = direct || [...(EDGES.get(file)?.keys() ?? [])].some((target) => dependsOnRenderer(target, seen));
  memo.set(file, result);
  return result;
}

const isFrozen = (file: string) => FROZEN_PREFIXES.some((prefix) => relative(SRC, file).startsWith(prefix));
/**
 * 规则 B 的适用范围：冻结集里除"页面组合根"以外的所有文件。
 * pages/ 下的 .tsx 是组合根（渲染 3D surface 是本分）；pages/ 下的 .ts 是逻辑（必须与渲染无关）；
 * widgets/Inspector 之类的编辑 UI 不豁免。
 */
const subjectToRuleB = (file: string) => {
  if (!isFrozen(file)) return false;
  // 冻结目录里的渲染组件不是编辑逻辑（见 RENDERING_COMPONENTS_IN_FROZEN_DIRS）
  if (RENDERING_COMPONENTS_IN_FROZEN_DIRS[relative(SRC, file)]) return false;
  return !(relative(SRC, file).startsWith("pages/") && file.endsWith(".tsx"));
};

test("规则 A：编辑层不得直接导入渲染库（已声明的例外除外）", () => {
  const violations: string[] = [];
  const reached = new Set<string>();
  for (const file of FILES) {
    if (!isFrozen(file)) continue;
    const key = relative(SRC, file);
    // 冻结目录里的渲染组件不是编辑逻辑，两条规则都豁免（见 RENDERING_COMPONENTS_IN_FROZEN_DIRS）
    if (RENDERING_COMPONENTS_IN_FROZEN_DIRS[key]) continue;
    for (const spec of specifiers(CODE.get(file)!)) {
      if (!RENDERER_PACKAGES.some((re) => re.test(spec))) continue;
      if (FROZEN_IMPORTERS[key]) { reached.add(key); continue; }
      violations.push(`${key} 直接导入 "${spec}"`);
    }
  }
  expect(violations).toEqual([]);
  expect(Object.keys(FROZEN_IMPORTERS).filter((key) => !reached.has(key))).toEqual([]);
});

test("规则 B：编辑层（除页面组合根外）不得传递依赖渲染库", () => {
  const violations: string[] = [];
  const reached = new Set<string>();
  for (const file of FILES) {
    if (!subjectToRuleB(file)) continue;
    for (const [target, spec] of EDGES.get(file) ?? []) {
      // 冻结集内部互相引用不算跨界；那些由被引用者自己的检查兜住。
      if (isFrozen(target) || !dependsOnRenderer(target)) continue;
      const key = relative(SRC, target);
      if (SEAMS[key]) { reached.add(key); continue; }
      violations.push(`${relative(SRC, file)} → "${spec}" (${key}) 传递依赖渲染库`);
    }
  }
  expect([...new Set(violations)].sort()).toEqual([]);
  expect(Object.keys(SEAMS).filter((key) => !reached.has(key))).toEqual([]);
});

test("规则 D：两张例外表不得重叠（一张是「本就不属于编辑层」，一张是「待消除的越界」）", () => {
  const overlap = Object.keys(FROZEN_IMPORTERS).filter((key) => RENDERING_COMPONENTS_IN_FROZEN_DIRS[key]);
  expect(overlap).toEqual([]);
});

test("规则 C：数据契约模块必须保持纯净", () => {
  for (const p of PURE_CONTRACT) {
    const file = resolve(SRC, p);
    expect({ module: p, exists: existsSync(file) }).toEqual({ module: p, exists: true });
    expect({ module: p, impure: dependsOnRenderer(file) }).toEqual({ module: p, impure: false });
  }
});

test("两张声明表里的路径都真实存在", () => {
  for (const key of [...Object.keys(SEAMS), ...Object.keys(FROZEN_IMPORTERS), ...Object.keys(RENDERING_COMPONENTS_IN_FROZEN_DIRS)]) {
    expect({ key, exists: existsSync(resolve(SRC, key)) }).toEqual({ key, exists: true });
  }
});

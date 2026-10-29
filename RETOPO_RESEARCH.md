# 不用 Tripo 的低模/拓扑方案（2026-10-29 调研）

目标：`retopologize` 不再调 Tripo `/mesh/decimate`，改由火山那三个 3D 模型 + 本地/开源手段承接。

## 结论先说

1. **Hyper3D（影眸 Rodin）本身就能直接出四边面低模，不需要任何重拓扑。**
   `--mesh_mode Quad` + `--quality 8000`，官方预设 4K / 8K / 18K / 50K / 100K / 200K 四边面。
   这是唯一"零新增依赖、零额外耗时、带贴图"的路子。
2. **Seed3D 与 Hi3D 都下不去 10 万面**（Seed3D `--subdivisionlevel low` = 10 万；Hi3D `face_count` 区间
   100 000–2 000 000），只能靠本地减面。原来 `skpExport` 里那套 `weld + simplify` 就能用，
   1.5 M 面 → 2 万面约 0.9–1.5 s，UV/贴图不丢。
3. **浏览器端能跑的真·四边面重拓扑只有一个：`quadrs`（Rust，Instant Meshes 的移植）。**
   它没有 npm 包，需要自己编到 wasm —— 我用 wasm32-unknown-unknown 编出来是 **262 KB**、
   **零 import**，`WebAssembly.instantiate(bytes, {})` 直接跑，Worker 里就能用。
   4/4 真实资产全部成功、输出 100% 四边面，15 万三角面输入约 **3.3–4.0 s**（400k 输入 15.6 s）。
   质量是"实验级"：均匀各向同性四边面，硬表面（圆柱、棱边）会走形，且**不生成 UV**。
4. npm 上唯一的四边面 wasm —— `@autoremesher/wasm@0.2.0`（MIT，1.1 MB）——在同样的资产上
   **4/4 失败**，见下。`instantmeshes.com` 那个网页版不是库，它的 "quad" 只是把相邻三角形配对。

## 实测数据

机器：本机 Bun 1.3.14，单线程 wasm。被测资产是本机 `~/ChatSpace/projects` 里 Tripo 3.1 的产物
（约 149 万三角面 / 45 MB）。

| 资产 | 输入三角面 | meshopt 减到 2 万 | meshopt 减到 5 千 | `@autoremesher/wasm` |
| --- | --- | --- | --- | --- |
| cream-sofa | 1 487 850 | 891 ms | 7 698 面 / 1 130 ms | ✗ 失败（18 s） |
| black-cat | 1 483 936 | 20 000 面 / 0.7 s | 4 990 面 / 885 ms | ✗ 失败 |
| wooden-stool | 1 475 573 | 20 000 面 / 0.8 s | 5 000 面 | ✗ 失败 |
| gold-lattice-side-table | 1 493 294 | 20 000 面 / 0.99 s | 10 746 面 | ✗ 空网格（155–266 s） |

AutoRemesher 的失败不是配置问题：把清理（weld/sanitize/winding）、最大壳、长宽比归一化、
预减面到 25 万都做齐，仍然报
`invalid topology: 127 degenerate triangles; 80 duplicate triangles; 141 non-manifold edges`，
或者直接 "produced an empty mesh"。直接用底层 `runNativeRemesh` 绕过它自己的校验，
sofa 能出 20 115 个四边面，但耗时 **77 s**，且输出仍带 141 条非流形边。

`simplifyWithAttributes`（带 UV 属性 + `LockBorder`）可以精确命中面数目标，1.0–1.1 s，
这是本地减面应该走的入口；`@gltf-transform/functions` 的 `simplify()` 只按位置简化
（`meshopt_simplifier.js` 里直接调 `simplifier.simplify`），UV 接缝处会被合掉。

图：`output/retopo-research-20261029/decimate-vs-quad.png`
（左上原始、右上 weld+simplify 2 万、左下 weld+simplify 5 千、右下 AutoRemesher 2 万四边面）。

## 三条路

### A. 让生成器直接给低模（推荐，先做这个）

`chat/src/models/ark3d.ts` 的 `hyper3dCommand()` 现在写死 `--mesh_mode Raw`：

```diff
-  "--mesh_mode Raw",
+  `--mesh_mode ${options.quad ? "Quad" : "Raw"}`,
+  ...(options.quad ? [`--quality ${options.quadQuality ?? "low"}`] : []),
```

Quad 模式的 `quality` 映射：`high` 50000、`medium` 18000、`low` 8000、`extra-low` 4000；
`quality_override` 在 Quad 下上限 20 万。官方文档：
<https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5>。

接入面：`THREE_D_MODELS` 里给每个模型加 `topology`（quad/triangle）与默认面数，
下拉菜单（`app/src/shared/storage/apiKeys.ts` 的 `THREE_D_MODEL_PRESETS`）同步；
`retopologize` 在这类产物上直接返回"已经是低模"，不再产生付费任务。

**未验证**：火山方舟的影眸接口是否透传 `--mesh_mode Quad`。方舟侧现在是命令行式开关
（`--mesh_mode Raw`、`--quality_override` 已经在用），大概率支持，但需要一次真机 smoke 确认。

### B. 本地减面，给 Seed3D / Hi3D 兜底

复用 `chat/src/services/skpExport.ts` 的 `weld + simplify`，或直接用
`MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, uvs, 2, [1,1], null, target*3, error, ["LockBorder"])`。
产物写成一个新的 generation（沿用现有 `runAndPublishGeneratedModel` 的形状），
`retopologize` 增加一个不需要任何 key 的 `local` 分支。

质量边界：100k → 20k（5:1）可用；1.5 M → 5k（300:1）会塌，图上左下就是。

### C. 真·重拓扑（要四边面流线时）

**能进网页的：`quadrs` → wasm（本机已编通并实测）**

- 源码：<https://github.com/vidstige/quadrs>，MIT，纯 Rust，唯一依赖 `glam`；
  `RemeshTarget::FaceCount(n)` / `EdgeLength(l)`，`RemeshOptions { seed, mode, ... }`。
- 产物：`262 026 B` wasm、**零 import**（`WebAssembly.Module.imports() === []`），
  浏览器 / Worker / Bun / Node 同一份二进制。
- 实测（15 万三角面输入，本机 Bun 单线程）：

  | 资产 | 目标 faces | 耗时 | 输出 | 结果 |
  | --- | --- | --- | --- | --- |
  | cream-sofa | 1 250 | 3.99 s | 5 043 四边面，0 三角 | ✅ |
  | wooden-stool | 1 250 | 3.54 s | 5 039 四边面 | ✅ |
  | black-cat | 1 250 | 3.26 s | 4 914 四边面 | ✅ |
  | gold-lattice-side-table | 1 250 | 4.00 s | 3 347 四边面 | ✅ |
  | cream-sofa | 20 000 | 16.8 s | 81 368 四边面 | ✅ |
  | cream-sofa（40 万面输入） | 1 250 | 15.6 s | 5 124 四边面 | ✅ |

- **`FaceCount` 目标会放大约 4×**（要 5 000 四边面就传 1 250），按 4 换算即可。
- 边界：源模型本身就不封闭（cream-sofa：134 个壳、38 864 条边界边），所以输出也带边界洞
  （约 58 个小环），这是继承来的，不是算法新造的；要做封闭网格得自己补洞。
- **不产出 UV**：贴图要么按最近点投影转移 UV，要么从高模重新烘焙。这是它和
  meshoptimizer 最大的差别（后者 UV 原样保留，不需要任何烘焙）。
- 质量：图 `output/retopo-research-20261029/compare4-sofa.png` / `compare4-stool.png`
  （右下角是 quadrs 约 5 000 四边面）。有机形体干净，硬表面的圆柱/棱边会走形，
  README 自己也写着 "Experimental"。

编法（已把源码留在 `output/retopo-research-20261029/quadrs-wasm/`，含我写的 C ABI 包装）：

```bash
rustup target add wasm32-unknown-unknown
cd quadrs-wasm && cargo build --release --target wasm32-unknown-unknown
# → target/wasm32-unknown-unknown/release/quadrs_wasm.wasm
```

JS 侧只有三个导出：`alloc_bytes` / `run(vp, vn, ip, tn, targetFaces, seed)` / `out_ptr`+`out_len`，
缓冲区格式是 `u32 nverts, f32×3n, u32 nfaces, (u32 count, u32×count)*`。

**服务端原生**（质量更好，但不是"网页一体化"）：`huxingyi/autoremesher` CLI、
Blender `quadriflow_remesh`、QuadWild-BiMDF（质量最好，依赖重）。都是分钟级、丢 UV、要烘焙。

## 能降到 100 面吗

可以，但**不是靠四边面重拓扑**，而是靠 `meshoptimizer` 的 `simplifySloppy`（不保拓扑、不保 UV 的
暴力减面）。1.49 M 面输入，实测（Bun，单线程，浏览器同一份 wasm）：

| 资产 | 目标面数 | 实际 | 耗时 | 边界边 | 结果 |
| --- | --- | --- | --- | --- | --- |
| cream-sofa | 100 | 82 | 35 ms | 0（闭合） | 块面化 proxy，仍认得出沙发 |
| wooden-stool | 100 | 92 | 33 ms | 0 | 四条腿塌成尖刺 |
| black-cat | 100 | 94 | 37 ms | 0 | 团块 |
| cream-sofa | 300 | 291 | 45 ms | 0 | 明显好转 |
| cream-sofa | 60 | 28 | 86 ms | 0 | 只剩一个盒子 |

图：`output/retopo-research-20261029/100-faces-sofa.png`、`100-faces-stool.png`
（左上原始、右上目标 100 面、左下目标 300 面、右下 quadrs 约 5 000 四边面）。

**quadrs 到不了这个量级。** 15 万面输入下给 `FaceCount(45)` 能输出 116 个四边面，但那是散落的碎片；
703 / 1177 / 1754 四边面仍然有破面，**可用下限大约 3 000–5 000 四边面**。
预先把输入降到 2 000 三角面再 remesh 也一样碎（96 四边面 = 几片飘着的面）。
低于 `FaceCount(20)` 会直接输出 0 个面。

结论：100 面是 **LOD / 代理体**的问题，不是重拓扑的问题。这个量级下 UV 和贴图没有意义
（该用纯色或按面烘一张小图），且细长结构（桌腿、椅腿、把手）必然塌成尖刺。
真要"100 面还像样"，得上体素化 / 盒体拟合 / 凸分解那一类算法，或者人工 blockout。

**"还是原来那个模型"的下限（单件家具，实测）**：
1 500 面勉强、500–1 000 面结构还在、250–300 面开始走形、100 面已经不是同一个东西。
根因是这些 AI 资产本身由 **94–142 个互不相连的小壳**组成（wooden-stool 94 壳、black-cat 142 壳、
cream-sofa 134 壳），100 面摊到每个壳不到 1 个三角形，任何减面算法都只能把零件糊成一团。
图：`output/retopo-research-20261029/identity-floor-stool.png`（254 / 532 / 951 / 2 470 面）。

## 已落地（2026-10-29）

`retopologize` 不再调 Tripo：

- `chat/src/services/localRetopo.ts` —— 本地减面。优先 `simplifyWithAttributes`（TEXCOORD_0 参与误差 + `LockBorder`），
  压不下去才退 `simplifySloppy`；产物写 `N-slug.glb` + 侧写（provider `local`），原高模保留。
- 源模型取**面数最多的那一代**，不是最新一代——所以能反复换目标（200 → 600 → 2 000），
  不会出现"在 400 面上再减到 800"这种死路。
- `targetPolycount` 可省略：默认 `min(2000, max(300, round(sqrt(三角面数) * 3)))`，由 Agent 自己决定。
- 实测（1.49 M 面的 cream-sofa）：2 000 面 1.06 s（保 UV）、500 面 2.26 s（实际 614 面、保 UV）、
  400 面 4.09 s（实际 362 面、走 sloppy）。
- 同步改了 `chat/src/mastra/tools/meshOps.ts`（工具描述）、`chat/src/mastra/prompts/creator.ts`（卡片口径）、
  `chat/src/cloud/operations.ts`（浏览器本地版分支）、`README.md`；回归 `localRetopo.test.ts` 6 条。

## 顺带提醒

Tripo 的积分同时支撑着 `generate-texture`（`/models/texture`）、`rig-model`（`/animations/rig`）、
`generate-animation`（`/animations/retarget`）、`segment-parts`（`/mesh/segment`）。
换掉生成和减面并不会让这些恢复——它们要各自找替代（影眸自己有 texture/rigging 接口，
方舟是否开放需要再确认）。

# AGENTS.md

给在本仓库工作的 AI agent 的入口与硬约束。**先读这一份。** 它只有一页，但下面每一条"不得"都是硬约束，不是建议。

仓库有 1000+ 行 WebGPU 文档，其中**只有 `WEBGPU_FINDINGS.md` 第 1 节的 14 条是当前可信的性能结论**。不要从别处推断性能数字。

核对基准：2026-09-29，`bun run check` 退出码 0（app **363** pass / chat **341** pass）。

---

## 一、环境

**`bun` 不在 PATH 上。**

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun 1.3.14
bun run check                        # typecheck + test + build
```

`bun run check | tail` 会吞掉退出码——管道的 `$?` 是 `tail` 的。要判成败必须 `set -o pipefail` 或读 `${PIPESTATUS[0]}`。

单测（`bun test` + happy-dom）**不能证明 WebGPU 可运行**。真实 GPU 行为只能在真实浏览器里验证，见第五节。

---

## 二、硬约束

### 渲染

1. **WebGPU-only，没有 WebGL 回退。** 不得新增 `WebGLRenderer` 回退路径，也不得依赖 Three 自带的 WebGL2 兜底。无可用 adapter/device 时走 `WebGPUCanvas` 的重试面板，项目与聊天界面保持可用。
2. **`antialias` 必须保持 `false`，但依据是「约 1.5× 且无收益」，不是「数量级崩塌」。** 实测（交替设计，见 `WEBGPU_PROBE_PROTOCOL.md` §5.19）：MSAA ON 的 `gpuUtilization` 是 OFF 的 **1.4–1.6×**、4 视图 GPU 工作量约 2.4×，方向 6/6 对一致；但帧间隔仍有 15–57 fps，**未复现** 313–588 ms / 0.15 fps。默认值不变；**引用时用 §5.19 的倍率，不要再引用旧的数量级数字**。`?msaa=1` 可用于复测。
3. **不得在无测量的情况下改性能/画质默认值**：`stochastic` / `autoStochastic` / `fastSort` / `minPixelRadius` / DPR / 渲染分辨率。每一个都有画质代价，属于产品决策。
4. **降 DPR / 降分辨率是已被证伪的手段。** 像素 0.92 → 2.07 Mpx（2.25×）时 GPU 中位数 16.25 → 15.20 ms，不动。重述这条建议视为错误。

### 测量

5. **不得把 `renderer.render()` 的 CPU 耗时当成 GPU 耗时**；也不得把 rAF 帧间隔当成 GPU 时间。60 Hz vsync 会把帧间隔 p50 钉在 16.7 ms，而 GPU 实际要 19.8 ms——只看 rAF 会得出"刚好 60 fps"的错误印象。
6. **GPU 时间必须在可见窗口测。** headless 下时间戳静默返回 0，而 headless 与可见窗口的 adapter feature 列表几乎一致，**事前无法分辨**，只能按结果判定。
7. **每轮先校验 `valid === true` 且 `instanceCount` 全部 > 0。** 出现 0 即整轮作废，无论其它数字多合理——实测出现过 `inst=[0,0,0]` 却读出"合理"数字的情况。
8. **单个数字不要跨轮次比较**，除非每轮都从全新页面加载开始。Three 的时间戳查询池上限 2048（每帧 2 个），一次 25 s 采样必然跨越池重置，重置后可能读到陈旧值。
9. 记录当轮 `load average`。静机与忙机的绝对值**不可并列比较**。
10. **测量必须独占机器。** 并发跑探针、`bun run check` 或另一个 agent 的测量，会把 `load` 顶到 30+，那一轮的数字**全部作废**（实测：一边跑探针一边跑 check，`load` 从 3 升到 31）。
    `bun run probe:gpu` 用 CDP 端口 **9333** 做互斥——端口被占会直接拒绝启动并提示 `pkill`；但它挡不住探针之外的负载。开测前先 `uptime`，测完再记一次。

### 依赖与补丁

11. 锁定 three **0.186.1** / @types/three **0.186.0** / gaussian-splat-lite **1.1.5**（root `overrides` + `patchedDependencies`）。**升级任一者都必须重新验证 `patches/` 下两个补丁**，并重跑浏览器压力测试。
12. `patches/` 改的是**释放路径**，不是渲染、投影、排序或画质。改补丁时同步更新 `patches/README.md`，并跑 `app/src/shared/rendering/attributeDisposal.test.ts`。

---

## 三、文档地图：哪些能引用

| 文档 | 状态 |
| --- | --- |
| `WEBGPU_FINDINGS.md` | **只有第 1 节「可信结论」可引用。** 第 2 节是已撤回清单，第 4 节是未解决项 |
| `WEBGPU_PROBE_PROTOCOL.md` | **5.5 / 5.7 / 5.8 的中间结论已作废，不得引用。** §2–§4 的方法、§5.1 的探针可信度对照、§5.13–§5.19 的复测（含修掉的探针缺陷、呈现/提交计数、GPU→CPU 同步计数、五轮重复、数据规模对照、完整视图数曲线、MSAA 交替对照）仍有效 |
| `WEBGPU_MIGRATION.md` | **第 0 节 = 实际状态**；§1–§9 是目标设计，**不是已交付结果**（文档自己警告过这一点） |
| `WEBGPU_VALIDATION.md` | 历史记录。绝对值受时段负载影响，不可与静机数据并列 |
| `SCENE_COMMAND_PLAN.md` | 实施记录。§三「缺口清单」描述的是改造**前**的状态，勿当现状；§Phase 3「已知遗留（重要）」里"两本账不联动、reclaim 基本是 no-op"**已解决**（`ResourceBudget` 已接 `MemoryPressure`，`capture.ts:32` 改调 `trimToFit(needBytes)`），勿再照它去改 |
| `EDITOR_PRACTICES.md` / `PLAN.md` | 资料与里程碑索引，不是当前状态 |
| `README.md` / `app/README.md` | 使用说明，架构描述与代码一致 |
| `VIEWPORT_REVIEW.md` | 视口热路径已逐行审查完成。**结论是这一层没有可观的每帧浪费，不要重复审查**；文中列出的微小结余已被判断为"不值得改"，勿再当待办 |

---

## 四、渲染架构速查

- **一个** `NativeWebGPURenderer`（`webgpu.ts`，直接组 `WebGPUBackend` + `StandardNodeLibrary`，不注册 WebGL 回退）+ **一份**核心 `Scene`（`ProjectRenderRuntime`）。
- 每个窗格有自己的：相机、overlay `Scene`（HUD/Gizmo）、`GaussianSplatRenderer`（按 `VIEW_LAYERS` 分层）。1/2/4 布局定义在 `paneLayouts.ts`。
- **帧顺序**（三层 priority，不要打乱）：
  1. `WebGPUCanvas` 的 `ClearFrame`（priority 0）——`setRenderTarget(null)`、关 scissor、**清屏一次**；
  2. `ProjectRenderRuntime`（priority 1）——`scene.updateMatrixWorld()`，期间置 `matrixWorldAutoUpdate = false`，然后 `RenderSchedule.draw(delta)`；
  3. 每个 `WebGPUView` 的 scene pass——设 viewport/scissor（**顶部为原点**），`gl.render(coreScene, camera)` 再 `gl.render(overlayScene, camera)`。
- 因为是统一清屏，**各视图 pass 里 `autoClear` 必须保持 `false`**；谁改成 `true` 谁就把其它窗格擦掉。
- `SplatModel` **恒定保留 4 个** `GaussianSplatRenderer`（对应 4 个 layer），布局切换只切 `visible`，不销毁重建——因为原生 WebGPU 的排序器重编译在 1.9M 点上可能超过一分钟。代价是单视图也持有四视图的显存。
- 截图/缩略图走 `CaptureQueue`（检查图优先、交互让行、1.5 s 老化、16 上限）+ `capture.ts` 的私有 RenderTarget + 异步读回 + GPU 行填充解包。
- 资源两层账：截图目标有申请预算（`ResourceBudget`，超限走尺寸阶梯降级，缺额度时按差额回收空闲模型条目再重试同一尺寸）；模型缓存只淘汰闲置项（`ModelResources`：空闲 **128 MiB / 8 项 / 30 s TTL**，另有 **512 MiB 的总驻留安全上限**，超出时立刻回收空闲条目，绝不释放在用项）。**截图准入同时看两侧余量**（`ResourceBudget` 的 `MemoryPressure` 探针，谁能给的少按谁算）。**两者都不是整个项目的显存上限**——这本账不覆盖 splat（`GaussianSplatRenderer` 不走 `ModelResources`），而已知风险恰恰在 splat。
- 诊断代码（`gpuProbe.ts` / `benchmark.browser.js` / `*.browser.ts`）**不进生产包**，只被探针和测试引用。保持这个状态。

---

## 五、真实 GPU 验证怎么做

在**可见窗口**打开带 `?gpuTimestamps=1` 的开发服务器（`trackTimestamp` 在 backend 构造时读取，事后无法开启）：

```bash
cd <repo> && ~/.bun/bin/bun run dev:web
# 浏览器打开 http://localhost:<port>/?gpuTimestamps=1
```

然后在控制台按需调用（完整步骤见 `WEBGPU_PROBE_PROTOCOL.md` §4）：

| 入口 | 用途 |
| --- | --- |
| `gpuProbe.browser.ts` → `startGpuFrameProbe(store, opts)` | GPU 时间 / 帧间隔 / CPU 提交 |
| `capture.browser.ts` → `verifyWebGPUCapture()` | 截图方向、alpha、色调映射、状态恢复 |
| `materials.browser.ts` → `verifyWebGPUMaterials()` | 合成 GLB 材质与骨骼动画 |
| `workflows.browser.tsx` → `verifyWebGPUWorkflows(slug, asset)` | 真实缩略图 / 四视角 |
| `splatLifecycle.browser.tsx` → `verifySplatLifecycle(...)` | Splat 生命周期与资源换代 |
| `syntheticSplat.browser.ts` → `runSyntheticSplatProbe(...)` | 合成点云对照 |
| `benchmark.browser.js` → `startRenderBenchmark(store, opts)` | 帧间隔基线（与历史数据对照） |

**自动化入口：`bun run probe:gpu`**（`app/scripts/gpu-probe.mjs`，零依赖：起可见窗口 Chrome + CDP + 解锁门禁 + 逐布局跑探针，退出码 0/2 表示每轮 `valid` 是否成立）。其余 `*.browser.ts` 仍是手工控制台脚本。任何"已验证"的说法都要指明是哪一种：单测 / 类型检查 / 真实浏览器 / 真实资产。**合成 fixture 只能验证链路可用，不能作为性能结论**（合成云 0.26 ms vs 真实 SPZ 20.97 ms，同样的 1.92M，差 80 倍）。

---

## 六、已知未解问题（不要假装解决）

**≥3 个全分辨率 splat 视图会塌缩。** 1 视图 19.4 ms → 2 视图 27.7 ms（健康）→ 3 视图 362.6 ms → 4 视图 382.8 ms。**根因未定位。**

已排除（**不要再提这些假设**）：点数阈值、排序缓冲绑定上限、排序器编译未完成、显存总量、multiView 缺失、SH 系数、编码密度、`maxStorageTexturesPerShaderStage`、renderer 实例数（2 视图时 4 个实例全在且健康）。合成对照在同样条件下完全线性，所以**是数据相关的，不是点数相关的**。

**未解释的缺口（待重新推导）**：历史上记过"3 视图下 GPU 362 ms 无法解释 3183 ms 的帧间隔，中间约 2.8 s 既不是 GPU 也不是 CPU 提交"。**不要在重新测之前引用它**：那个读数取自探针有两处缺陷的时期（`GpuFrameSampler` 丢了 `traverse` 的 receiver，每帧抛错；`motion` 在 `frameloop="demand"` 上不索要帧），而且长帧归因与 wall/gpu 不同窗口。修好后用**窗口配对**口径复测（2026-09-29，load 5.8–13.8，`bun run probe:gpu`）：**未复现该缺口**，而且上一轮的读法要撤回——**GPU 并没有饱和**：`gpuUtilization`（**已含 compute 池**）在 **22%–33%**（≈100% 才算 GPU-bound）。所以 4 视图塌缩**不是 GPU 算力被吃满**，限速在别处。

> ⚠️ 别再引用我 22:24 那轮"GPU-bound（207 > 118 > 115）"的结论：那三个数是**混合分母**的。
> 另外 `mainThread*` 也**不能**当作"主线程 CPU 工作"用来定限速方：Long Animation Frame 的 `duration` 本身就是**该长帧的持续时间**，与帧间隔几乎同义，所以它只会重复帧间隔。要真正拆分，需要采集 `scripts[].duration` 之和（脚本时间）——那是下一步，见 `WEBGPU_PROBE_PROTOCOL.md` §5.13。详见 `WEBGPU_FINDINGS.md` §1 第 10/11 条与 `WEBGPU_PROBE_PROTOCOL.md` §5.13。**山崖本身（1→4 视图帧率塌）仍然成立且根因未定位。**

**排查工具的方向**（`WEBGPU_FINDINGS.md` §6 提到 RenderDoc，**那在本平台不成立**）：

- Metal 上 Xcode Metal Debugger 是**唯一**可用的抓帧工具，RenderDoc 不支持 Metal。
- Xcode 路径成本很高：需要能附加调试器的 Chrome 构建（标准 Chrome 的签名会阻止附加）、`--disable-gpu-sandbox`、`MTL_CAPTURE_ENABLED=1`、`--enable-dawn-features=use_user_defined_labels_in_backend`，附加到 **GPU 进程** PID，而且**每次抓帧后浏览器必然挂死，需重启**。参考 [Profiling WebGPU with Xcode's Metal Debugger](https://toji.dev/webgpu-profiling/xcode)。
- 而且 Three 0.186.1 **不发 `pushDebugGroup`，也不给 GPU 资源设 `label`**，抓下来会是一片无法辨认的 `Dawn_Buffer_*`。要让它可用，得先加第三个补丁给 buffer/texture 打标签。
- **更便宜的第一步已经做完了**：`long-animation-frame` 归因现在有了报告入口 `formatProbeReport(result)`（`WEBGPU_PROBE_PROTOCOL.md` §4.1），并已在可见窗口实测（§5.13）。做这件事时发现探针本身有两处缺陷（见上），修好后**没有复现**那个缺口——所以现在没有理由为此上 Metal 抓帧。
- **同一分母也已经做完了**：探针改为**窗口配对**。Three 的查询池在 `_resolveQueries` 入口就快照并清空，所以一次 resolve 返回的是"自上次 resolve 以来"的**区间总和**；探针现在在发起 resolve 的同一刻对 wall 做快照，于是 `paired(ms)` 与 `gpuUtilization=` 是同分母的比较（字段与口径见 `WEBGPU_PROBE_PROTOCOL.md` §4.2）。**读报告只用 `paired` 行**——`means` 行与 `unexplained` 仍是混合分母，不要拿它们下结论。
- **✅ 已用新口径重跑**（`bun run probe:gpu`，见 §5.13/§5.14）：**`gpuUtilization` 现已含 compute 池**（旧版只算 render，系统性偏低），修正后 **22%–33%** —— **GPU 没饱和**。
- **✅ 脚本时间也已采集**（`scripts[].duration` 之和，报告里的 `scripts(ms)` 行；字段与口径见 §5.13 第四次复测）：4 视图下 `shareOfWall` **1.9%**，2 视图的长帧脚本时间为 0 —— **JS 不是限速方**。
- **⏭ 下一步（两条，缺一不可）**：
  1. **修 motion**：它只旋转透视相机，而 4 视图布局里三个正交视图完全静止；GSL 排序是脏标记驱动的，所以本轮很可能**漏掉了多视图排序路径**——本轮数字不能用来支持或反驳"≥3 视图塌缩"。
  2. **✅ 重复实验已做**（`motion 0/1` × 3 次 × 1/4 视图 = 12 轮，全部 `valid`，见 §5.13 第六次）。
     站得住的是：**帧间隔永远是 vsync 的整数倍**（12 轮只出现 2/3/6/7/8/9×，无例外）；
     **GPU 从未饱和**（`gpuUtilization` 全程 20.8–48.6%）；**JS 基本不是限速方**（`scriptShare` 中位 0–7.1%）。
     站不住的是：**"精确等于 `vsync × 视图数` 是巧合**，已作废；`scriptShare` 还有个 **43.7% 的离群点未解释**。
  3. **✅ 呈现计数已做，并否掉了一个假设**（`WEBGPU_PROBE_PROTOCOL.md` §5.14）：每帧 `renders≈4×视图数`、
     `submits≈3.5×视图数`，**而且与 motion 策略无关**（结构性）。相邻呈现间隔 **p50 0.4–0.6 ms**，
     远小于一个 vsync（16.7 ms）→ **"每个视图各等一次呈现"已证伪**；要等的时间在**帧与帧之间**。
     另一处修正：`gpuUtilization` 以前只算 render 池，现已含 compute；修正后是 **22%–33%**（结论不变）。
  4. **✅ 同步计数已做，结果出乎意料但很干净**（`WEBGPU_PROBE_PROTOCOL.md` §5.15）：
     包住 `mapAsync` / `onSubmittedWorkDone` 并记调用方指纹后发现——**100% 的 `mapAsync` 都来自探针自己的
     `WebGPUTimestampQueryPool._resolveQueries`**，应用侧一次都没有；`onSubmittedWorkDone` 0 次。
     每次回读等 211 ms（1 视图）/ 518 ms（4 视图），一趟 10 s 里合计 ≈8.7 s / 7.8 s。
     两个后果：①"每帧同步排序"没有以这种形式出现（不等于排序不花钱，但排除了这一机制）；
     ②**探针采样率上限约 5 Hz，每次 resolve 覆盖 2–9 个应用帧**——用 Three 的 `resolveTimestampsAsync`
     做不到按应用帧对齐，这是硬边界。
  5. **✅ 五轮重复已做**（§5.16，`motion=all`、每轮全新页面加载、load 6.7–20.2）：1 视图 p50 **50.0 ms（3.0× vsync）**、
     `gpuUtilization` **25.7%**；4 视图 p50 **115.1 ms（6.9× vsync）**、**25.6%**。离散极小（24–28% / 24–26%）。
     **最强的一条：帧时间涨 2.3× 而 GPU 占比不变**——每帧约 3/4 墙钟 GPU 空闲，且比例与视图数无关。
  6. **✅ 数据规模对照已做**（§5.17；经用户同意临时改名 SPZ，`finally` 还原并校验清单一致）：
     1 视图 p50 中位 **17 / 17 / 50 ms**（150k/500k/1.92M），4 视图 **50 / 67 / 115 ms**；
     `gpuUtilization` 1→4 视图：150k **34.0%→17.8%**、500k **32.5%→21.2%**、1.92M **25.7%→25.6%**。
     **多出来的视图带来的帧时间多于它带来的 GPU 工作量。**
  7. **✅ 完整视图数曲线已做**（§5.18，新增 `--views n` 构造「4 窗格 + n 个可见 splat」）：
     1.92M 世界的帧间隔 p50 中位是 **50 / 67 / 67 / 134 ms**（1/2/3/4 视图）——
     **台阶在 4 视图，2→3 是持平的**；`gpuUtilization` 全程 22.7%–27.1%；
     **`render/帧` 在 3 视图就翻倍（7.9→15.8）而帧时间没变**。
  8. **⚠️ 与历史第 6 条的差异现在更尖锐**：历史说悬崖在 **2→3**（2 视图 27.7 ms → 3 视图 362.6 ms），
     本轮构造下 3 视图与 2 视图一样快。但「3 视图」有歧义——本轮是「4 窗格 3 可见」，
     历史可能指「**3 个窗格**」（视口 1/3 画布、每帧 3 个 pass），几何完全不同，UI 构造不出来。
     **在弄清历史构造之前，既不能说第 6 条错，也不能说新曲线取代它。**
  9. **按负载分层后收敛到 5 条**（§5.13 第六次补充）：帧间隔永远是 vsync 整数倍；
     **1 视图静止 = 3× vsync**（3/3 复现，load 7–30 都成立）；**GPU 从未超过 50%**；JS 不是限速方
     （43.7% 离群点仍未解释）；**本组数据里 `load` 与帧间隔看不到相关**。
     上一版"静止比运动慢 3 倍"已作废——那是跨不同负载比较出来的。
     这**不动** §二.9/§二.10：要改纪律，得做"人为加压 × 固定条件"的对照。
- **边界**：窗口配对做到的是"GPU 与 wall 同分母"，粒度是一次 resolve 覆盖的区间（本次 1 视图平均 7.8 个 rAF 样本、4 视图 7.4 个），该区间仍可能含多个应用帧；要按应用帧对齐得在应用侧每帧打单调标记，目前没有。

**拖动时 P50 从 16.7 ms 恶化到 100–150 ms**：根因已确认——锁定的 GSL 1.1.5 在原生 WebGPU 路径上**每帧绘制前同步排序**（`synchronousSort`），`minSortIntervalMs` 在该路径无效。可调档位（`fastSort` / `minPixelRadius` / `stochastic`）都有画质代价，**未改默认值，属产品决策**。

---

## 七、改动前的检查清单

- [ ] 我引用的性能数字来自 `WEBGPU_FINDINGS.md` 第 1 节，或是本轮新测的（并写明了测量条件）。
- [ ] 我没有新增 WebGL 回退，没有动 `antialias` 默认值，没有无测量地改画质参数。
- [ ] 涉及 GPU 资源生命周期的改动考虑了 StrictMode 双挂载、设备丢失重建、异步回调写入被取代的代次。
- [ ] 新增的每帧工作问过一遍"静态场景下它还跑吗"（静止场景不应持续提交绘制/排序）。
- [ ] 我区分了"单测通过"和"真实浏览器验证过"。
- [ ] 我更新了受影响的文档，并且没有把作废结论重新写回。

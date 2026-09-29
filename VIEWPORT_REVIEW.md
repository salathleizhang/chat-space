# 视口热路径审查（2026-09-29）

**结论先说：这一层已经优化到位，剩余性能不在 React 代码里。**

本文是一次逐行审查的记录，目的是**避免以后重复做同一件事**，以及把"已知的微小结余但判断为不值得改"的项固定下来，免得它们被反复当成待办提出。

审查范围：`index.tsx`（849 行）、`PaneCamera.tsx`（615 行）、`TransformGizmo.tsx`（241 行）、`PanePicking.tsx`、`CameraRig.tsx`、`ModelMesh.tsx` 的帧循环部分。

---

## 一、逐项核对结果

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| demand 渲染是否真的生效 | ✅ **生效** | 全部 `useFrame` 回调都有早退守卫：`index.tsx:247`（`live.size === 0`）、`CameraRig:44`（`!animating.current`）、`TransformGizmo:175`（未拖拽）、`PaneCamera:365`（非正交）、`ModelMesh:305`（仅 `hasAnimation`）。**没有任何无条件 `invalidate()`** |
| 是否每帧强制 reflow | ✅ **没有** | `getBoundingClientRect` 已收进共享 `ResizeObserver` + 缓存的 `useTrackedRect`（`PaneCamera.tsx:78-89`），`useFrame` 里只读内存。该文件注释记录了优化前的代价：四窗格下每帧 11 次强制 reflow |
| hover 是否每帧 / 每次 pointermove 重渲染 | ✅ **不会** | `handleHover`（`index.tsx:490-496`）在状态未变时**返回同一引用**，React 直接 bail out。`onPointerOver` 重复触发不会造成重渲染 |
| `PlacedAsset` 的 `memo` 是否被戳穿 | ✅ **没被戳穿** | 三个关键 prop 引用都稳定：`layout` 是 `useMemo(assets, transforms)`（`index.tsx:450`）、`objects` 是 `useState` 的 Map、`live` 由上层注入 |
| 是否每帧 setState | ✅ **没有** | 拖拽走 `live` 表 + 命令式写 `group.position/rotation/scale`（`index.tsx:245-253`），刻意绕开 React。注释写明了原因 |
| 资源/监听器是否成对清理 | ✅ 是 | `useTrackedRect` 的 `subscribeTrackedRect` 最后一个订阅者退出时断开 observer 并摘掉 window 监听（`PaneCamera.tsx:62-75`） |
| 拖拽期临时对象是否复用 | ✅ 是 | `PaneCamera.tsx:241-248` 预分配 `scratch`；`TransformGizmo.tsx:41-45` 模块级 `tmp*`；`PaneGizmo` 复用 `rotationMatrix` / `snapDummy`。均非每次移动 new |
| 是否有 TODO / FIXME / HACK | ✅ 全仓 0 处 | — |

---

## 二、每帧 `gl.render()` 的实际次数

这是审查中最值得记录的一个数字，因为它常被误判为浪费：

| # | 内容 | 位置 |
| --- | --- | --- |
| 1 | `coreScene`（全部模型、splat、天空、网格） | `WebGPUView.tsx:38` |
| 2 | overlay `scene`（该窗格的拾取代理 + `TransformGizmo` + 相机/controls） | 同上 |
| 3 | `hudScene`（坐标轴球，独立正交 HUD） | `PaneCamera.tsx:506`（`PaneGizmo`） |

**每视图 3 次，4 视图 = 12 次/帧。**

**但这不值得优化。** 实测 CPU 提交总量在单视图下是 **0.30 ms**（`WEBGPU_FINDINGS.md` §1，1000+ 帧），即每次 `gl.render()` 约 0.1 ms → 4 视图约 1.2 ms，而同期 GPU 是 **19.8 ms**，≥3 视图时更达 362 ms。**GPU-bound，省下几次调用不会改变任何测量结果。**

另外第 2 次（overlay）在多数时候**没有任何 draw call**：

- `PanePickTarget`（`PanePicking.tsx`）渲染的 `SharedPickProxy` 只覆写了 `raycast`，**无几何、无材质**，不产生绘制；
- 未选中任何资产时 `TransformGizmo` 直接 `return null`（`TransformGizmo.tsx:179`）。

即便如此，省掉它也只是省下一次空 pass 的固定开销（~0.1 ms/视图），**不值得为此改渲染架构**。

---

## 三、已知的微小结余（判断为"不值得改"，勿再当待办）

### 3.1 `PaneGizmo` 每帧无条件重算三样东西

`PaneCamera.tsx:485-497` 每帧都做：

```ts
cam.left/right/top/bottom = ...; cam.updateProjectionMatrix();   // 重建投影矩阵
groupRef.current.position.set(w / 2 - GIZMO_MARGIN_PX, ...);
rotationMatrix.current.copy(mainCamera.matrix).invert();          // 完整解析求逆
groupRef.current.quaternion.setFromRotationMatrix(...);
```

三者的输入（窗格 `w`/`h`、主相机姿态）只在**窗格尺寸变化**或**相机移动**时改变。相机静止、窗格静止时这些全是白做。

**修法现成**：同文件的 `OrthoZoomSync:369` 已经有"值变了才做"的守卫模式（`Math.abs(cam.zoom - desiredZoom) > 0.01`），照抄即可。

**为什么不改**：量级是微秒级，而当前瓶颈是 GPU（19.8 ms 起）。改它不会在任何探针上产生可见差异，反而增加一处状态。**若将来 CPU 侧真的成为瓶颈，这是第一个可以捡起来的点。**

### 3.2 `controls.update()` 一帧被调两次

drei 的 `OrbitControls.js:29-30` 自带：

```js
useFrame(() => { if (controls.enabled) controls.update(); });
```

而 `PaneGizmo:481` 在视角吸附动画里又调了一次 `controls.update()`。同一个 `OrbitControls` 实例在同一帧被 update 两次，`enableDamping` 下阻尼会被推进两次。

**为什么不改**：吸附动画本身就在覆盖相机姿态，双倍阻尼**视觉上不可见**。属清理级，不是 bug。

### 3.3 `SceneContents` 没有 `memo`

`index.tsx:270` 的 `SceneContents` 是普通函数组件，而 `hoveredByLayer` 作为 prop 传进去（`:282`、`:634`）。因此 hover 变化会重渲染整个 `Viewport` 子树——包括**所有窗格**的 `WebGPUView` / `PaneCamera` / `PaneGizmo` / `TransformGizmo`。

**为什么不紧急**：

- hover 已去重（见 §一），只在**跨越对象边界**时触发，不是每帧、也不是每次 pointermove；
- 子组件的关键 prop 引用稳定，重渲染的代价基本只有 React 协调；
- `hoverMask` 的计算（`index.tsx:337`）是每资产对 `hoveredByLayer` 做一次 `Object.entries().reduce()`，资产×层数规模，可忽略。

**真要改**的话，正确做法不是加 `memo`（`hoveredByLayer` 就是变化的那个 prop），而是让 hover 高亮不走 `SceneContents` 的 props——例如按资产下传，或用一个 hover store 让 `ModelMesh` 自己订阅。

---

## 四、结论：性能工作不在这里

视口这一层（调度顺序、实时变换绕开 React、矩形缓存、临时对象复用、资源清理）**没有发现可观的每帧浪费**。

真正的剩余性能问题只有两个，都与本文范围无关：

1. **≥3 视图悬崖** —— 根因未定位，已排除项见 `WEBGPU_FINDINGS.md` 第 2 节与第 4 节；
2. **拖动时 P50 100–150 ms** —— GSL 1.1.5 在原生 WebGPU 路径上每帧同步排序，属产品决策。

**下一步若要提升性能，去查这两个，不要回头翻视口代码。**

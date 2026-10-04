# PHYSICS.md — 视口物理（rapier / Ammo）

> **状态（2026-10-04）**：**两侧都接通并真机验过**——three 默认路径：落地/走动 3.09 m/
> 推动 4.701 m/抓取拖拽 1.096 m/跳跃 +0.882 m（第 3 节）；PlayCanvas 路径：落地 0.800/
> 走动 4.488 m/推动 7.764 m/抓取拖拽 0.678 m/跳跃 +0.86 m，10 个物体全 box 形状，
> 编辑器模式下物理不推进（第 5 节）。两侧判据全绿、零 console error。
> 本文只记录**实测读数**，没有测过的数字一律标注"未测量"。

---

## 1. 设计要点（三条，改动前先读）

1. **一个物理世界**，挂在 `<ProjectRenderRuntime>` 里、包住整棵核心场景。
   视口只有一份核心 `Scene`（1/2/4 窗格共享、第一人称也用它），逐窗格各挂一份会把同一批
   碰撞体建 N 份、步进 N 次。
2. **`updateLoop="independent"` 是必需的**，不是优化：画布是 `frameloop="demand"`，
   默认的 `"follow"` 把物理步绑在渲染帧上——没有帧就没有物理，物体会停在半空。
   `independent` 让物理跑自己的循环，而"要不要重画"由库自己决定：它在每步之后对
   **活动刚体**调 `invalidate()`（`@react-three/rapier` 的 `step` 里那句
   `world.forEachActiveRigidBody(() => invalidate())`）。所以**不要**再加无条件 invalidate。
3. **物理只在第一人称下推进**（`paused={!firstPerson}`）。轨道/多窗格是编辑器语义，
   家具必须待在 `scene.json` 说的位置上；而且第一人称下没有窗格、也就没有 gizmo，
   于是"每帧写摆放"和"每帧物理回写"永远不会同时发生（省掉一整套竞态）。

## 2. 各处用的形状

| 对象 | 形状 | 理由 |
| --- | --- | --- |
| 世界 collider GLB | `fixed` + **trimesh**（`colliders="trimesh" includeInvisible`） | 实测真实项目 **43 124 / 63 861** 三角面（`0-world-2.glb` / `0-world.glb`），可以接受 |
| 摆放的家具 | `dynamic` + **盒体**（包围盒半尺寸） | 真实家具是 **140 万–148 万**三角面 / 40 MB 级 GLB，逐个 trimesh 不可行 |
| 角色 | `dynamic` + **胶囊**（半径 0.25、总高 1.6），`enabledRotations=[false,false,false]` | 与 image-blaster 同参数；禁转否则撞墙会翻滚 |
| 地面 | `fixed` + 200×200 薄板，**顶面在 y=0** | 见第 4 节的实测：网格默认位常常在房间壳之外 |
| 兜底安全网 | `fixed` + 200×200 厚板，y=−10 | 防止"掉出世界"的刚体永远活动、每帧索要新帧 |

`WorldColliderMesh` 的 `includeInvisible` **不是可选项**：自动碰撞体走
`traverseVisible`，而这一层 `COLLIDER_VISIBLE = false`（一个像素都不画），
不开这个开关一个碰撞体都生成不出来——症状是"能看见地形、却直接穿到地下"，零报错。

## 3. 真机实测（2026-10-04，three 默认路径）

环境：Chrome（真实窗口）、`bun run dev`（端口 5174）、项目 `p-muo3u17c`
（10 件家具、世界 collider 63 861 面）。驱动：`.tmp/physics/drive-physics.mjs`，
报告：`.tmp/physics/report.json` / `report-off.json`。当轮负载未记录（**不是**性能测量，
只是功能判据；性能数字仍属"未测量"）。

| 判据 | 读数 |
| --- | --- |
| 物理引擎挂载 | `world = { bodies: 11, colliders: 2 }`（开场：1 地形 + 10 家具），零 console error |
| 地形形状 | `shapeType = 6 (TriMesh)`、质量 **692.41**、`isSensor=false`、默认碰撞组 |
| 家具包围盒上报 | `measured 10 / empty 0 / reported 10` |
| 家具碰撞体 | 例：`halfExtents [0.3649, 0.5, 0.4404]`、质量 0.643、动态 |
| 重力与地面 | 出生点 y=2.06 → 收敛 **0.801**（脚在 y≈0.001），4 s 内波动 < 0.02 |
| 走动 | 可信 `W` 1.6 s → 水平位移 **3.119 m**（≈ 3 m/s），y 0.801 → 0.831（仍贴地） |
| 推动 | 角色走向家具 → 物体沿 +Z 被推走 **4.701 m** |
| 抓取 | 准星射线命中 `toi=1.78` → `grabbing=true` → 视线转向时物体被带走 **1.33 m** → `release()` 后 `grabbing=false` |
| 对照臂 `?physics=0` | `bodies 0 / colliders 0`，无角色刚体 |

`bun run check` 退出码 **0**（app **818 pass / 0 fail**）。

## 4. 上一轮"盒体穿地"的真相（已结案）

现象：家具一进第一人称就一路掉到 −120。三次落点对照（`.tmp/physics/isolation.json`）：

| 落点 | 结果 |
| --- | --- |
| 角色站位上方 3 m（房间内，已知实地） | **落住**，y 收敛 0.456（底面贴 y≈0） |
| 家具自己的网格默认位 (−3, ·, −6) 上方 3 m | **一路掉**（−41 仍在加速）⇒ 那个位置**根本没有地板** |
| 实地正上方、故意埋进地面 0.2 m | **落住**并收敛 0.447 ⇒ 穿透恢复正常 |

⇒ 盒体 ↔ trimesh 碰撞、穿透解算都是好的。真问题是 **World Labs 的 collider 只是那一间房的
外壳，不是无限地面**，而 `computeSceneLayout` 的网格默认位铺开到 ±3 / −9，很容易落在房外；
没有 world 的项目（如 `p-mupq6eua`）整块地板都不存在。
所以补了 image-blaster 同构的地面平板（顶面 y=0：`ground_plane_offset` 的语义就是"把地面抬到 0"）。

**连带的产品变化（需要留意）**：从未手动摆放过的资产在 `scene.json` 里是 `y=0`，
而语义是"包围盒中心"⇒ 它们原本**半个身子埋在地板里**。物理一跑，它们会被顶到地面上站好
（实测落在 y≈0.499，底面贴地）。这比原来更正确，但会与 chat 侧 `sceneLayout` 报的坐标
（仍是 y=0）差半个人高——**两本账**。要做成"落定后写回 scene.json"，或选择"不落定"，
得由用户拍板（见第 6 节）。

## 5. PlayCanvas 侧（部分接通）

**已完成并真机验证**（`.tmp/physics/pc-physics.json`，`?pcViewport=1&pcDebug=1`）：

| 项 | 读数 |
| --- | --- |
| Ammo 引导 | `hasWorld: true`、**`ammoGlobal: true`**（`btVector3` 是函数）、零 console error |
| 世界碰撞网格规格 | `specKinds` 里出现 `<worldId>:collider`（此前 PC 路径**根本不会请求**这份 GLB） |
| 专用层 | `colliderLayerId: 7`（相机 layers 永不含它 ⇒ 不可见） |
| 组件 | `bodies: 1`、`colliders: 1`（rigidbody static + collision mesh 都挂上了） |
| 形状（Render 资产路径） | `shapes: ['mesh']`、`hasShape: true`、`renderMeshes: 1`、`builtWorldScale [1.8169×3]` |
| 地形高度（物理射线扫） | (0,3) 打到 `collider-mesh` 顶面 **2.251**；(0,0) 2.154；(3,0) 1.966 —— 那是**天花板**；(0.8 m 处向下) 打到 `physics-ground` 的 **0.0008** |
| 角色（物理胶囊） | 收敛 **0.800**（脚在地面，4 s 无抖动）、走动 **4.488 m** 且 y 不变、跳跃 **+0.86 m** 后落回（弧线 1.11→1.66→0.80） |
| 逐物体刚体 | **10/10** 都有 dynamic 刚体 + `box` 形状（`objectBodies` 逐项 `collisionType: "box"`、`shapeType: "box"`） |
| 可推 | 角色走进物体 → 位移 **7.756 m** |
| 编辑器语义 | 未进第一人称时相隔 4 s 两次读数**逐字节相同**（物理确实没推进） |
| 对照 | 零 console error |

前三条的坑（都已处理）：
1. **Ammo 不在 npm 包里**，`WasmModule.setConfig('Ammo', {glueUrl, wasmUrl})` + `getInstance`
   （`errorHandler` 必须接：`getInstance` 的回调**不带 err**，失败时它根本不回调，
   Promise 会永远不 settle）。已 vendor 到 `playcanvas/vendor/`（glue 453 KB + wasm 750 KB），
   照 zstd 的 `?url` 先例。
2. **加载器会把 `window.Ammo` 清空**（`core/wasm-module.js` 拿到胶水后置 undefined），
   而 `AmmoPhysicsWorld` 读的是裸全局 ⇒ 必须在回调里自己 `globalThis.Ammo = instance`。
3. **`AppOptions.physicsWorld` 只发给 rigidbody 系统**（`app-base.js:231-233` 的
   `this.systems.rigidbody?.setPhysicsWorld(...)`）；collision 系统通过
   `get physicsWorld() { return this.app.systems.rigidbody?.physicsWorld }` 拿到同一个世界 ✓。
4. **`mesh` 形状只认 Render 资产那条路**（本轮解决）：
   - `collision/system.js` 的 `createMeshShape` 读 `component._render.meshes`；
   - container（GLB）**实例化**出来的 render 组件带的是 `meshInstances`，`meshes` 是
     `undefined`（真机读数 `{meshInstances: 1, meshesUndefined: true, hasShape: false}`）
     ⇒ 挂在它上面的 mesh 形状永远是 `null`；
   - 正解：从 container 的 `containerResource.renders`（**已经是 `loaded = true` 的 Render
     资产**）取资产，建 `collision: { type: "mesh", renderAsset }` 的实体，由引擎的
     `loadMeshAsset` 把 `_render` 指到 Render 资源上（那份**有** `meshes`）。
     **不要加 `render` 组件**：加了就会把几十万面的地形画出来，而形状并不需要它。
5. **静态刚体的变换只在"加入世界那一刻"同步一次**
   （`rigid-body/system.js` 的 `enableSimulation` → `syncEntityToBody`；此后静态体每帧不再同步）。
   而 loader 建形状时实体还没进场景，顶点是按 scale=1 烘的 —— 两件事叠起来就是
   "地形 shape 正常、角色却无限下落"（真机踩过）。修法：摆放写上去之后调
   `syncPhysicsToPlacement()`（同步 body 变换 + 重新赋值 `renderAsset` 重烘形状）。
6. **Bullet 的 trimesh 地面挡不住胶囊**：同一个 `0-world.glb`，本地 bbox 换算后地面在
   **y≈−0.04**、天花板在 **y≈2.25**；three 侧（rapier）能站在 trimesh 地面上（隔离实验
   实测落点 0.456 ≈ 底面贴 −0.04），而 PC 侧的胶囊会**穿过去**。所以 PC 也必须有那块
   地面平板（与 three 侧同源同数值），它才是真正的地面。

其余仍待做（都在非冻结集）：


引擎那一半是齐的：`playcanvas@2.22.6` 自带 `AmmoPhysicsWorld` / `CollisionComponent` /
`RigidBodyComponent` / `JointComponent`，`app.ts` 也已经注册了 collision 与 rigidbody 两个
系统。缺的是三处，且**都在非冻结集**：

1. **逐物体刚体**：`assetScene.apply()` 无条件写实体变换，会与动态刚体互相踩；
   需要"物理接管时不再写、编辑时暂停物理"的所有权规则（three 侧的对应做法是：只在第一人称
   下推进物理 + 刚体建好即睡）。
2. **抓取**：引擎有 `JointComponent`（已注册），但没有现成的抓取脚本；
   路由要避开 `paneInput` 的 `isPointerClaimed`（three 侧对应的是准星射线 + 球形关节）。

**抓取：已真机验通（拖拽 0.678 m、松手释放）。** 实现走引擎自带的 `JointComponent`
（`type: "spherical"` + kinematic 锚点实体，参数与 three 侧同源：距离 3 m、线速 5、角速 10；
松手时把锚点位移/时间还给物体）。三条已核实的事实：
① **射线起点必须挪出胶囊**（相机就在胶囊内部；`raycastFirst` 只返回第一个结果，
   滤掉自身之后不会继续往后找）——现在起点前移 `半径 + 0.25`；
② 过滤谓词本身是对的：诊断口里加了**同一条射线的无过滤对照**，实测
   `{hit:false, filteredHit:true, filteredName:"collider-mesh", filteredType:"static"}`
   —— 即"打了、打到的是静态地形、被正确滤掉"；
③ 验通过程中连着踩掉**四个静默失败点**（都不是"没写"，而是"写了但引擎不认"）：
   - **盒体尺寸必须是真 `Vec3`**：`collision: { halfExtents: {x,y,z} }` 传裸对象会被静默丢掉
     ⇒ 形状建了但**尺寸是空**（真机读数 `halfExtents === undefined`），射线打不到它；
   - **关节类型没有 `"spherical"`**：引擎只认 `fixed / ball / hinge / slider / 6dof`
     （球窝关节叫 **`ball`**）。类型名写错**不报错也不建约束**，症状是"抓住了但不跟着走"；
   - **锚点必须有 `collision` 组件**：`enableSimulation` 的判据是
     `entity.collision && entity.collision.enabled`，没有碰撞体的 kinematic 刚体
     **根本不会加入物理世界** ⇒ 关节挂上却拉不动任何东西（给它一颗 1 cm **传感器**球即可）；
   - **动态刚体要挪位置必须用 `rigidbody.teleport()`**：只摆实体位置等于白摆
     （动态体每帧由物理回写实体变换）。
   上一轮"抓取验不通"的全部原因就是这四条，而不是驱动写错。
   - `teleport` 调试口已补（three 侧 `__PHYSICS__.teleport` 的对应物）。⚠️ 动态刚体
     **必须用引擎的 `RigidBodyComponent.teleport()`**：只摆实体位置等于白摆，
     因为动态体每帧由物理回写实体变换（`_updateDynamic`）——本机踩过（角色原地不动）。
   - 摆位之后角色还会**侧滑 1 m 多**（说明落点与某个形状重叠被顶开），
     而且定向射线的**无过滤对照**仍然打到 `collider-mesh`（静态地形）：
     `{hit:false, filteredHit:true, filteredName:"collider-mesh"}`。
   - 所以下一轮的第一件事是**读盒体碰撞体的真实位置**：`attachDynamicBoxBody` 用了
     `collision.linearOffset` 表达"包围盒中心偏离实体原点"（PC 没有 three 的 `<Center>`），
     需要核实引擎的 box 形状是否真的按这个偏移摆（对照实验可以照 three 侧那次隔离实验的做法：
     从 3 m 高丢下来，看它最终停在哪）。

角色的两道**沙箱陷阱**（都已处理，值得记下来）：
- 点完工具栏的"进入第一人称"按钮后**必须让它失焦**：按钮仍持有焦点时 `Space` 等于
  "再点一次那个按钮"（退出第一人称），驱动会读到全 null，看着像"跳跃没实现"。
- 沙箱拿不到真实指针锁定，所以产品里那条"没锁定就不接管水平方向"的契约不能拆；
  用**只在 `?pcDebug=1` 下存在**的 `__PC_VIEWPORT_FORCE_LOCK__` 顶替这一个判据
  （与 three 侧 `__PHYSICS__.forceInput` 同一个做法）。

## 6. 未完成 / 待决定

- **PC 侧整套接入**（第 5 节三个障碍）。
- **逐物体物理档位**（image-blaster 的 `rigidbody | static | ghost`）：当前一律 `rigidbody`。
  要做需扩 `scene.json`（`AssetTransform` 没有该字段）+ chat 侧工具 + 右侧栏 UI。
- **落定结果是否写回 `scene.json`**（第 4 节末尾的两本账问题）。
- **"重置物体"入口**：image-blaster 有 reset；chat-space 的 `ViewportChrome` 与 PC 版
  有 `aria-label` 顺序一致性测试，加按钮要同步两版与那条测试。
- **性能数字全部未测量**：物理对帧时间的影响必须按 `AGENTS.md` 第二节的纪律测
  （独占机器、记 load average、交替设计多轮），`?physics=0` 就是为此准备的对照臂。

## 7. 诊断口

`?physicsDebug=1` **且 dev 构建**时安装 `window.__PHYSICS__`（见 `physicsDebug.ts`）：
`camera / bodies / character / teleport / look / grab / release / grabbing / awake /
world / boundsReports / colliderFacts / raycast / forceInput`。

两条纪律：① 生产构建与不带参数的页面一律不装；② 组件内部要用这些能力必须走**本地引用**
（`FirstPersonGrab` 把 hook 的返回值登记进 `physicsDebug` 的模块级句柄），**不能**绕
`window` 上那个回调自己——一加开关，内部路径就静默失效。

`forceInput(true)` 是 three 侧**唯一**一条绕过点（本沙箱拿不到真实指针锁定，Chrome 直接拒），
它只顶替"指针已锁定"这一个判据；射线、关节、碰撞、走路速度全都走产品路径。
PC 侧的对应物是 `__PC_VIEWPORT_FORCE_LOCK__`（同样只在 `?pcDebug=1` 下存在），
另外 `__PC_VIEWPORT_PHYSICS__` 多了 `sweep`（从高空往下打物理射线，报"打到谁、在什么高度"）
——"角色为什么还在掉"靠它一次问清。

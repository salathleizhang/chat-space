import * as THREE from "three";

/**
 * 视口的**线框着色模式**：像 Blender 的 wireframe viewport shading 那样，把场景里的模型
 * 只留边线、不画贴图与光照。
 *
 * 引擎侧的支持是现成的，不需要自建 `LineSegments` 叠加层：three 的 WebGPU 后端在
 * `WebGPUUtils.getPrimitiveTopology()` 里把 `material.wireframe === true` 的网格映射成
 * `LineList`，索引由 `Geometries.getIndex()` 按三角形边生成（`a,b,b,c,c,a`），绘制范围在
 * `RenderObject` 里按 ×2 展开；节点材质又会按 `object.isSkinnedMesh` / `morphAttributes` /
 * `isInstancedMesh` 自动接上蒙皮、变形与实例化。所以"线框"就只是**换一份材质**。
 *
 * 为什么是换材质而不是就地改 `mesh.material.wireframe = true`：非节点材质是**在构建
 * pipeline 时被 `NodeLibrary.fromMaterial()` 逐属性拷成一份节点材质**的，而图元拓扑取自
 * `renderObject.material` 且管线按 render object 缓存——改原材质的属性既不会重建管线，
 * 也不会回头改那份拷贝。换实例则会让 `RenderObjects.get()` 判定材质变了并重建，和
 * `materialOverride.ts` 里已经在跑（并被真实浏览器验证过）的做法是同一条路。
 *
 * 三个 flag 各有理由，不要随手改：
 * - `wireframe: true`：就是这件事本身。
 * - `depthTest: false`：Blender 的线框模式是**透视的**（背面的棱也看得见），否则模型只剩
 *   一个前向的壳。线框不参与遮挡判断。
 * - `depthWrite: true`：**必须开**。写深度是为了让**半透明的泼溅背景别盖住线**——
 *   泼溅在透明队列、排在所有不透明物体之后，而它按深度测试决定是否落笔；线框不写深度的话，
 *   世界背景会整片压在线框上（画面看起来像"线框没生效"）。
 * - `side: DoubleSide`：线拓扑本身不受背面剔除影响，显式写出来是为了让 cullMode 明确为 None
 *   （`WebGPUPipelineUtils._getPrimitiveState`），也免去"到底剔没剔"的猜测。
 */

/** 线框颜色对齐 `index.css` 的 `--color-accent`：本产品是单色 chrome，没有品牌色 */
const WIREFRAME_COLOR = 0xffffff;

/**
 * 造一份线框材质。导出只为单测：运行时一律用下面那份单例。
 */
export function createWireframeMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: WIREFRAME_COLOR,
    wireframe: true,
    depthTest: false,
    depthWrite: true,
    side: THREE.DoubleSide,
    // 线框是"诊断视图"，颜色不该再被色调映射改一遍（与 HighlightBox 同理）
    toneMapped: false,
  });
}

let shared: THREE.MeshBasicMaterial | undefined;

/**
 * 全场景共用的那一份线框材质。
 *
 * 做成模块级单例而不是每次挂载新建，是因为库里的教训（见 `WebGPUGrid`）：`useMemo` 建 +
 * `useEffect(() => () => material.dispose(), [material])` 在 StrictMode 回放里会 dispose 掉
 * **已经提交、正在用**的那一份。它没有任何参数，逐挂载重建本来也没有好处。
 * 它随进程存活、不参与释放账，所以 `restoreWireframe` **绝不能** dispose 它。
 */
export function wireframeMaterial(): THREE.MeshBasicMaterial {
  return (shared ??= createWireframeMaterial());
}

export interface AppliedWireframe {
  meshes: { mesh: THREE.Mesh; original: THREE.Material | THREE.Material[] }[];
}

/**
 * 把整棵克隆体上每个网格的材质换成线框材质，返回还原所需的一切。
 *
 * 只碰网格：选中高亮的包围盒是 `LineSegments`（它自己就是线，不该被再换一次），
 * `Points`/`Sprite` 也不在模型资产里，但一并排除。
 */
export function applyWireframe(
  root: THREE.Object3D,
  material: THREE.Material = wireframeMaterial(),
): AppliedWireframe {
  const applied: AppliedWireframe = { meshes: [] };
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    applied.meshes.push({ mesh, original: mesh.material });
    // 多材质网格（geometry.groups）整份换成这一份线框材质，还原时把原数组整体还回去
    mesh.material = material;
  });
  return applied;
}

/**
 * 还原成原材质。**不 dispose 线框材质**（它是共享单例）。
 *
 * 还原前确认网格上挂的还是我们那份：材质写入点虽然只有本模块与 `materialOverride.ts`
 * （两者由 `useAssemblyMaterials` 串成一次 effect），但"只在还是自己的时候才还"这条守卫让
 * 还原**幂等且不会覆盖别的写入方**——顺序反过来也安全。
 */
export function restoreWireframe(
  applied: AppliedWireframe,
  material: THREE.Material = wireframeMaterial(),
): void {
  for (const { mesh, original } of applied.meshes) {
    if (mesh.material === material) mesh.material = original;
  }
}

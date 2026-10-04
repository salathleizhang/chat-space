/**
 * 视口诊断口的**唯一开关**。
 *
 * 为什么需要它：探针与驱动依赖一批 `window.__PC_VIEWPORT_*` 活口（相机、变换、线框、资产、
 * 材质、天空盒、第一人称…）。它们原先**无条件**装到 `window` 上——包括真实业务页面
 * （`/app/<slug>?pcViewport=1`）✗。诊断口不该跟着产品页面走（本仓库的既有纪律：
 * 诊断代码不进生产包），而且它们是**全局可变状态**，装在别人的页面上是不该有的副作用。
 *
 * 口径：**只有开发构建 + URL 带 `pcDebug=1` 才装**。生产构建一律不装（`import.meta.env.DEV` 为假）。
 * 名字集中在这里，新增诊断口要加进 `VIEWPORT_DEBUG_NAMES`（便于卸载与自检）。
 */
export const VIEWPORT_DEBUG_FLAG = "pcDebug";

/** 所有诊断口的名字。新增一个就在这里加一行。 */
export const VIEWPORT_DEBUG_NAMES = [
  "__PC_VIEWPORT_CAMERAS__",
  "__PC_VIEWPORT_TRANSFORM__",
  "__PC_VIEWPORT_WIREFRAME__",
  "__PC_VIEWPORT_ASSETS__",
  "__PC_VIEWPORT_MATERIALS__",
  "__PC_VIEWPORT_SKYBOX__",
  "__PC_VIEWPORT_SKYBOX_OFF__",
  "__PC_VIEWPORT_SKY_MESH__",
  "__PC_VIEWPORT_WALK__",
  "__PC_VIEWPORT_FORCE_LOCK__",
  "__PC_VIEWPORT_PHYSICS__",
] as const;

export type ViewportDebugName = (typeof VIEWPORT_DEBUG_NAMES)[number];

/** 该不该装诊断口：开发构建 + `?pcDebug=1`。 */
export function viewportDebugEnabled(
  search: string | undefined | null,
  dev: boolean | undefined = (import.meta as { env?: { DEV?: boolean } }).env?.DEV,
): boolean {
  if (dev === false) return false;
  if (!search) return false;
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  return params.get(VIEWPORT_DEBUG_FLAG) === "1";
}

/** 按名字卸掉诊断口（真实页面/生产路径上不该留）。 */
export function clearViewportDebug(target: Record<string, unknown> = globalThis as never): void {
  for (const name of VIEWPORT_DEBUG_NAMES) delete target[name];
}
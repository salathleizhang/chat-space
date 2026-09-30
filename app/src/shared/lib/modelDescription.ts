import { useSyncExternalStore } from "react";
import type { ChannelTexture } from "./textureSlots";

/**
 * 渲染层 → 编辑层的**"模型描述"契约**。
 *
 * ### 它解决什么
 * 在此之前，Inspector 的贴图通道表为了回答"这个模型支持哪些通道、每通道现在是什么图"，
 * **自己挂载了一份模型加载器**（`LoadedAssetObject`），拿 render-prop 里的 `Object3D`
 * 去遍历 three 材质。那是渲染层的内部访问路径：渲染层换引擎后 three 对象不存在，这条路径必然断。
 *
 * 现在改成：**渲染层产出纯数据、编辑层消费**。描述按资产 slug 存在这里，
 * 生产方是渲染层（它本来就把模型加载进了场景），消费方是 Inspector。
 *
 * ### 为什么是模块级 store 而不是 React context
 * 生产方在 `Viewport` 子树里、消费方在 `Inspector` 子树里，两者是**兄弟**。
 * 用 context 就得让上层（`pages/AppDashboard`，业务层）加一个 Provider —— 那正是
 * `pages/editingLayerBoundary.test.ts` 要守住的"编辑层零改动"。
 * 模块级 store 让生产/消费双方各自改自己的导入即可，业务层不动。
 *
 * ### 边界
 * 本模块**不得**导入 three / playcanvas：它同时被编辑层与渲染层引用。
 * 唯一的依赖是 React（`useSyncExternalStore`）。
 */

export type ModelDescriptionStatus = "loading" | "ready" | "error";

export interface ModelDescription {
  status: ModelDescriptionStatus;
  /**
   * 模型自带材质**真正声明过**的通道（`materialSchema` 的覆盖表与之的交集由此收窄）。
   * 用数组而不是 Set：它要跨模块边界、且常常被当作不可变值比较。
   */
  supportedSlots: string[];
  /** 通道 → 当前模型自带贴图。`Map` 的键是通道 key（如 `map` / `normalMap`）。 */
  channels: Map<string, ChannelTexture>;
  /** `status === "error"` 时给用户看的原因。 */
  error?: string;
}

/**
 * 描述的数量上限。单个描述里可能有几十张贴图缩略图（每张是 96px PNG dataURL），
 * 长会话里反复导入/删除模型不能无界累积。
 */
const MAX_DESCRIPTIONS = 32;

const descriptions = new Map<string, ModelDescription>();
const listeners = new Set<() => void>();

/**
 * 每次 publish / clear 自增。**必须用版本号而不是 `size` 当快照**：
 * 用同一个 slug 重新 publish（模型换代）时 size 不变，用 size 会让订阅者收不到通知、
 * Inspector 停留在旧缩略图上——这是个只在"同一个模型被替换"时才出现的静默 bug。
 */
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** 只用于测试：清空 store，避免用例之间互相污染。 */
export function resetModelDescriptions(): void {
  descriptions.clear();
  emit();
}

export function publishModelDescription(assetId: string, description: ModelDescription): void {
  // Map 保持插入顺序：重新 publish 已有 slug 时先删再插，使它变成"最近使用"，
  // 否则反复查看同一个模型反而会先被淘汰。
  descriptions.delete(assetId);
  descriptions.set(assetId, description);
  while (descriptions.size > MAX_DESCRIPTIONS) {
    const oldest = descriptions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    descriptions.delete(oldest);
  }
  emit();
}

/** 模型从场景卸载时移除描述，避免 Inspector 显示一个已经不存在的模型的通道。 */
export function clearModelDescription(assetId: string): void {
  if (descriptions.delete(assetId)) emit();
}

export function getModelDescription(assetId: string): ModelDescription | undefined {
  return descriptions.get(assetId);
}

/**
 * 列出当前全部描述。
 * 给测试与**诊断探针**用：生产方是否真的在视口加载模型后发布了描述，只能从页面里读这个才知道
 * （模块级 store 不在 `window` 上）。
 */
export function listModelDescriptions(): { assetId: string; description: ModelDescription }[] {
  return [...descriptions].map(([assetId, description]) => ({ assetId, description }));
}

export function subscribeModelDescriptions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshotVersion(): number {
  return version;
}

/**
 * 订阅某个资产的模型描述。渲染层 publish 之后，Inspector 会自动重渲染。
 *
 * 用 `useSyncExternalStore`：读的是 React 之外的模块级状态，这是 React 19 要求的正规方式
 * （避免撕裂与"渲染期间读外部可变状态"的告警）。`getSnapshot` 直接返回 Map 里的对象引用——
 * publish 时整对象替换，所以引用变化即"有更新"。
 */
export function useModelDescription(assetId: string | undefined): ModelDescription | undefined {
  // 订阅版本号即可：任何 publish / clear 都会让它变化，从而重渲染并重新读 Map。
  useSyncExternalStore(subscribeModelDescriptions, snapshotVersion, snapshotVersion);
  return assetId ? descriptions.get(assetId) : undefined;
}

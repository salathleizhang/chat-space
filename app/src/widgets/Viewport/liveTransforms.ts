import type { AssetPlacement } from "./scenePlacement";

/**
 * 拖拽期间的实时摆放表。
 *
 * **为什么不是 React state**：gizmo 拖拽时每帧都会算出新的摆放，写进 state 就等于每帧把整棵
 * 场景树（分屏时还要 ×4）重新协调一遍，必卡。所以场景那一侧是**命令式**读它——`PlacedAsset`
 * 在自己的 `useFrame` 里把值直接 apply 到 group 上，全程零渲染。
 *
 * **那右侧栏怎么办**：它要的是"数字跟着手走"，而这只能靠渲染。于是同一份数据额外开一条
 * 订阅通道：右侧栏用 `useSyncExternalStore` 订阅，每帧重渲染的范围就收在那一小块输入格上，
 * 不波及场景树。两条路径读的是同一份真相，所以视口里模型的位置和栏里的数字不会各说各话。
 *
 * 空表 = 当前没有人在拖。`clear()` 之后订阅方会回落到已提交的摆放（scene.json 那份），
 * 而 `TransformGizmo` 是在同一个事件里先清表再 commit 的，两者会被 React 批到同一次渲染，
 * 所以看不到回跳。
 */
export interface LiveTransforms {
  /** 正在被拖的资产数；0 表示没人拖 */
  readonly size: number;
  /** 按资产 id（`projectSlug/assetSlug`）取实时摆放 */
  get(assetId: string): AssetPlacement | undefined;
  set(assetId: string, placement: AssetPlacement): void;
  clear(): void;
  /** 订阅变更，返回退订函数；签名直接对齐 `useSyncExternalStore` */
  subscribe(listener: () => void): () => void;
}

export function createLiveTransforms(): LiveTransforms {
  const entries = new Map<string, AssetPlacement>();
  const listeners = new Set<() => void>();

  const notify = () => {
    // 迭代副本：订阅方在回调里退订（组件卸载）不该影响这一轮的其余订阅者
    for (const listener of [...listeners]) listener();
  };

  return {
    get size() {
      return entries.size;
    },
    get: (assetId) => entries.get(assetId),
    set: (assetId, placement) => {
      entries.set(assetId, placement);
      notify();
    },
    clear: () => {
      // 本来就空时不通知：拖拽结束与卸载清理都会无条件调一次，
      // 无谓的通知会让订阅方白重渲染一轮
      if (entries.size === 0) return;
      entries.clear();
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

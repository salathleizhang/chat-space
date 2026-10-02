import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../widgets/AgentDock";

export interface ReferenceImageSurfacingOptions {
  /**
   * 会话是否已经恢复/落定。恢复请求返回前消息列表还是空的，
   * 那时判断不了"这是历史会话还是新对话"，基线会判错。
   */
  ready: boolean;
  /**
   * 项目状态是否已经成功扫过一遍。同样是为了基线：扫描完成前 `referenceImages`
   * 恒为空，此时定基线会把"还没读到"当成"项目里本来没有图"。
   */
  loaded: boolean;
  /** 项目里已落盘的参考图（新→旧），来自项目状态的 generatedReferences。 */
  referenceImages: string[];
  /** 当前会话的消息；既是要挂图的目标，也是本 effect 的触发条件。 */
  messages: ChatMessage[];
  /** 触发一次 React 提交；只用来把参考图挂到已有消息上。 */
  updateMessage: (id: string, updater: (message: ChatMessage) => ChatMessage) => void;
}

/**
 * 参考图落盘即进对话。
 *
 * 参考图有三条产出路径：对话里的 generate-reference-images（工具结果经 SSE 带回
 * `images`）、**用户中止那一轮但服务端仍跑完**的调用（SSE 已经没人接）、以及
 * SceneJob 后台节点里生成的。后两条没有任何事件能送到界面，所以"参考图生成了，
 * 对话里却看不到"不是偶发——只要那一轮被中止就必然丢失（2026-10-02 实测：16 张
 * 参考图全部落盘、侧写都是 succeeded，对话里一张都没有，因为用户在生成途中点了停止）。
 *
 * 这里不依赖 SSE，而是用项目状态里那份 `generatedReferences`（由请求侧写推导，
 * 与前端连接无关）做对账：会话里还没出现过的参考图，补挂到最近一条助手消息上。
 * 于是"落盘"就是唯一判据，中止、后台任务、正常返回三条路径共用同一套口径。
 *
 * 基线口径（`surfacedRef` 首次观测）分两种，理由是两者要防的东西相反：
 * - 空会话（新对话/新项目）：把进入工作台时**已经存在**的参考图算作"早就有的"，
 *   否则每开一条新对话都会把项目历史上的参考图整套倒进对话里；
 * - 恢复出来的历史会话：反过来，历史里没有出现过的参考图正是当初丢掉的那些，要补上。
 *
 * 定基线前必须等两件事都落定：会话恢复完（`ready`）与项目状态扫过一遍（`loaded`）。
 * 少任何一个，"消息是空的 / 参考图列表是空的"都读不出是"本来就没有"还是"还没到"。
 */
export function useReferenceImageSurfacing({
  ready,
  loaded,
  referenceImages,
  messages,
  updateMessage,
}: ReferenceImageSurfacingOptions): void {
  const surfacedRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!ready || !loaded) return;
    const paths = referenceImages;
    if (surfacedRef.current === null) {
      const hasHistory = messages.length > 0;
      surfacedRef.current = new Set(hasHistory ? [] : paths);
      if (!hasHistory) return;
    }
    const surfaced = surfacedRef.current;
    const shown = new Set(messages.flatMap((message) => message.images ?? []));
    // SSE 已经投递过的图在这里被 shown 挡住，所以两条路径不会贴出重复的两份。
    const fresh = paths.filter((path) => !surfaced.has(path) && !shown.has(path));
    if (fresh.length === 0) {
      for (const path of paths) surfaced.add(path);
      return;
    }
    // 挂到最近一条助手消息上：它通常就是发起这次生成的那一轮。还没有可挂的消息
    // （例如项目状态先到、这一轮还没开始）时什么都不记，下一次触发再补。
    const target = [...messages].reverse().find((message) => message.role === "assistant");
    if (!target) {
      const freshSet = new Set(fresh);
      for (const path of paths) if (!freshSet.has(path)) surfaced.add(path);
      return;
    }
    for (const path of paths) surfaced.add(path);
    updateMessage(target.id, (message) => ({
      ...message,
      // `paths` 是新→旧，反过来贴才与生成顺序一致；与 SSE 路径的追加语义也一致。
      images: [...new Set([...(message.images ?? []), ...fresh.reverse()])],
    }));
  }, [loaded, messages, ready, referenceImages, updateMessage]);
}

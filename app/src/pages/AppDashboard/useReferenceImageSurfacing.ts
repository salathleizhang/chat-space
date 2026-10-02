import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../widgets/AgentDock";
import type { GeneratedReference } from "../../shared/lib/libraryApi";

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
  referenceImages: GeneratedReference[];
  /**
   * 当前会话开始的时刻（epoch ms）。**这是"这张图属不属于本会话"的唯一判据**，
   * 由 useSessionPersistence 给出：新建会话是按下按钮的那一刻，恢复出来的会话是
   * 它的 `createdAt`。`undefined` 表示还判不了（历史会话文件没有 createdAt），
   * 此时按"全部算历史"处理——宁可少贴，不可把上一轮的图倒进新会话。
   */
  sessionStartedAt?: number;
  /** 当前会话的消息；既是要挂图的目标，也是本 effect 的触发条件。 */
  messages: ChatMessage[];
  /** 触发一次 React 提交；只用来把参考图挂到已有消息上。 */
  updateMessage: (id: string, updater: (message: ChatMessage) => ChatMessage) => void;
}

/**
 * 允许的时钟偏差。参考图的 `generatedAt` 与 `sessionStartedAt` 可能来自两个时钟
 * （服务端侧写 vs 浏览器会话），而两侧都是同一台机器、同一套系统时钟，所以偏差
 * 通常只有毫秒级；留一点余量是为了兜住"先起会话、后写侧写"的正常先后。
 */
const CLOCK_SKEW_MS = 1000;

/** 侧写时间缺省/损坏时按"会话开始"算：晚于基线的图宁可多贴一张，也不能整批丢掉。 */
function generatedAtMs(reference: GeneratedReference, fallback: number): number {
  const parsed = Date.parse(reference.generatedAt);
  return Number.isFinite(parsed) ? parsed : fallback;
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
 * **归属判据是时间，不是"第一次观测"。** 早先的版本只看首次观测到的清单：空会话把
 * "此刻已经存在的"算作历史，恢复出来的会话把"清单里有、消息里没有的"算作丢失后补。
 * 那个口径有个洞——它假设"第一次观测到的清单就是项目历史全貌"，而项目状态会在每个
 * 后台任务落盘时重扫（`refreshKey`），于是只要基线恰好落在"还没读到图"的窗口里，
 * 基线就是空集，之后任何一张历史参考图都会被当成新图贴进当前会话（2026-10-02 实测：
 * 新建会话 → 发第一句话 → 助手回复 → 旧参考图被挂到那条新回复上）。请求失败时
 * `useProjectState` 还会保留上一份快照，所以 `loaded` 也不等于"这份清单是完整的"。
 *
 * 现在改成与会话开始时间比：只有 `generatedAt` 晚于本会话开始的图才进对话。这个判据
 * 与"什么时候看到清单、看到几次、顺序如何"全都无关，因此：
 * - 新建会话：上一轮的图 `generatedAt` 早于会话开始，一律不贴——即使项目状态此刻
 *   还没扫到它们，或后来又扫出更多；
 * - 恢复历史会话：当中止丢掉的那批图晚于会话开始，照旧补得回来；
 * - 页面刷新：会话的 `createdAt` 不变，补挂结果稳定。
 *
 * 定基线前必须等两件事都落定：会话恢复完（`ready`）与项目状态扫过一遍（`loaded`）。
 * 少任何一个，"消息是空的 / 参考图列表是空的"都读不出是"本来就没有"还是"还没到"。
 */
export function useReferenceImageSurfacing({
  ready,
  loaded,
  referenceImages,
  sessionStartedAt,
  messages,
  updateMessage,
}: ReferenceImageSurfacingOptions): void {
  /** 已经处理过的参考图（贴过、或判定过属于项目历史）。 */
  const settledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready || !loaded) return;
    const paths = referenceImages;
    const baseline = sessionStartedAt ?? Number.POSITIVE_INFINITY;
    const settled = settledRef.current;

    const shown = new Set(messages.flatMap((message) => message.images ?? []));
    const fresh: string[] = [];
    for (const reference of paths) {
      if (settled.has(reference.path)) continue;
      // 早于会话开始的图属于项目历史（上一轮的产物），只记账不贴。
      if (generatedAtMs(reference, baseline) < baseline - CLOCK_SKEW_MS) {
        settled.add(reference.path);
        continue;
      }
      if (shown.has(reference.path)) {
        settled.add(reference.path);
        continue;
      }
      fresh.push(reference.path);
    }
    if (fresh.length === 0) return;

    // 挂到最近一条助手消息上：它通常就是发起这次生成的那一轮。还没有可挂的消息
    // （例如项目状态先到、这一轮还没开始）时什么都不记，下一次触发再补。
    const target = [...messages].reverse().find((message) => message.role === "assistant");
    if (!target) return;
    for (const path of fresh) settled.add(path);
    updateMessage(target.id, (message) => ({
      ...message,
      /*
        `paths` 是新→旧，`fresh` 继承了这个顺序，反过来贴才与生成顺序一致；
        与 SSE 路径的追加语义也一致。注意 reverse 就地改数组，所以只对 fresh 做。
      */
      images: [...new Set([...(message.images ?? []), ...fresh.reverse()])],
    }));
  }, [loaded, messages, ready, referenceImages, sessionStartedAt, updateMessage]);
}

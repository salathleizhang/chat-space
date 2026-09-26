/** 跟帧贴底需要的最小面：真实 DOM 元素天然满足。 */
export interface ScrollTarget {
  scrollTop: number;
  scrollHeight: number;
  isConnected: boolean;
}

/**
 * 逐帧把 scrollTop 贴到内容底部，直到内容高度连续两帧不变。
 *
 * 计划卡展开是动画长高的，只跟第一帧会把后半段展开留在容器外；也不能只跟固定时长——
 * 帧率低或浏览器降频时，动画还没开始跟帧窗口就过期了。所以判据是「高度不再变」，
 * `maxMs` 只是防止内容一直变（比如同时还在流式输出）时无限跟下去的上限。
 *
 * 时钟与调度都由调用方注入，便于用假帧测住这个时序。
 */
export function followScrollToBottom(
  node: ScrollTarget,
  scheduleFrame: (callback: () => void) => void,
  now: () => number,
  maxMs: number,
): void {
  const started = now();
  let lastHeight = -1;
  let stableTicks = 0;
  const step = () => {
    if (!node.isConnected) return;
    const height = node.scrollHeight;
    if (height === lastHeight) stableTicks += 1;
    else {
      lastHeight = height;
      stableTicks = 0;
    }
    node.scrollTop = height;
    if (stableTicks < 2 && now() - started < maxMs) scheduleFrame(step);
  };
  scheduleFrame(step);
}

/** One owner for scene/HUD draw ordering. Updates remain outside draw passes. */
export class RenderSchedule {
  private views = new Map<string, { scene?: (delta: number) => boolean; hud?: (delta: number) => void }>();
  /** 所有窗格共享的核心场景这一趟；必须排在任何窗格 pass 之前。 */
  private core: ((delta: number) => void) | undefined;

  register(id: string, phase: "scene", draw: (delta: number) => boolean): () => void;
  register(id: string, phase: "hud", draw: (delta: number) => void): () => void;
  register(id: string, phase: "scene" | "hud", draw: (delta: number) => boolean | void) {
    const entry = this.views.get(id) ?? {};
    Object.assign(entry, { [phase]: draw });
    this.views.set(id, entry);
    return () => {
      if (entry[phase] !== draw) return;
      delete entry[phase];
      if (!entry.scene && !entry.hud && this.views.get(id) === entry) this.views.delete(id);
    };
  }

  /**
   * 注册"核心场景"这一趟，先于全部窗格执行。
   *
   * 为什么它必须是独立的一趟、而不是塞进某个窗格的 scene pass：核心场景是所有窗格共享的同一个
   * `Scene`，用一个 `ArrayCamera` 就能在**同一个 render pass** 里把每个窗格那份画进各自的 viewport
   * （见 `paneViewports.ts`）。窗格的 overlay/HUD 必须叠在它上面，所以顺序是"先全部核心，再逐窗格
   * overlay + HUD"，而不是"逐窗格 core + overlay + HUD"——因为窗格在屏幕上是互不相交的矩形，
   * 两种顺序在视觉上等价。
   */
  registerCore(draw: (delta: number) => void): () => void {
    this.core = draw;
    return () => { if (this.core === draw) this.core = undefined; };
  }

  /*
    注意：**没有** "共享 HUD" 那一趟。2026-09-30 两次尝试把 4 个窗格的坐标轴球并成一个共享 Scene +
    一趟 ArrayCamera pass（结构性计数确实从 4 次 HUD render 降到 1 次：`renders` 4.95→1.98），
    但**多窗格下四个轴球全部不可见**，单窗格正常。第二轮把触发条件锁定到了"**核心那趟用
    ArrayCamera**"（把核心改回普通相机单窗格路径，轴球立刻出现；只减少 HUD 子相机数、强制非整屏
    viewport、关掉 trackTimestamp 都无效），但机制未定位。**已整批回退**——宁可少拿 3 趟 pass，
    也不要一个多窗格可见回归。详见 `VIEWPORT_REVIEW.md` §0.10。
  */

  draw(delta: number) {
    this.core?.(delta);
    for (const entry of this.views.values()) {
      if (entry.scene?.(delta)) entry.hud?.(delta);
    }
  }

  get size() { return this.views.size; }
}

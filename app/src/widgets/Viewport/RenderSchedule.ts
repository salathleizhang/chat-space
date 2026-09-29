/** One owner for scene/HUD draw ordering. Updates remain outside draw passes. */
export class RenderSchedule {
  private views = new Map<string, { scene?: (delta: number) => boolean; hud?: (delta: number) => void }>();

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

  draw(delta: number) {
    for (const entry of this.views.values()) {
      if (entry.scene?.(delta)) entry.hud?.(delta);
    }
  }

  get size() { return this.views.size; }
}

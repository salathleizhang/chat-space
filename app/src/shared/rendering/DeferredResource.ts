/** An effect-owned resource, retained only across same-turn StrictMode replay.
 * Constructing this holder has no external side effects. Each lease releases
 * once; a stale cleanup cannot dispose a newly acquired generation.
 */
export class DeferredResource<T extends { dispose(): void }> {
  private entry?: { value: T; refs: number; timer?: ReturnType<typeof setTimeout> };

  constructor(private readonly create: () => T) {}

  acquire() {
    const entry = this.entry ??= { value: this.create(), refs: 0 };
    clearTimeout(entry.timer);
    entry.refs++;
    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        if (--entry.refs !== 0) return;
        entry.timer = setTimeout(() => {
          if (entry.refs !== 0 || this.entry !== entry) return;
          this.entry = undefined;
          entry.value.dispose();
        }, 0);
      },
    };
  }
}

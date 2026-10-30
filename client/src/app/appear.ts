/**
 * Tracks which shapes have just appeared, so they can pop in instead of
 * blinking into existence. Only shapes that show up AFTER the board has first
 * loaded animate: the shapes that were already there when you arrived are not
 * "new", and 300 of them all popping at once would look like a glitch.
 */

export const APPEAR_DURATION_MS = 220;

export class AppearTracker {
  private known: Set<string> | null = null;
  private readonly startedAt = new Map<string, number>();

  /**
   * Call once per frame with the ids on the board. `loaded` says whether the
   * board has received its initial state; until then nothing animates.
   * Returns progress (0 to 1) for the shapes still popping in.
   */
  update(ids: readonly string[], now: number, loaded: boolean): Map<string, number> {
    const progress = new Map<string, number>();
    if (!loaded) return progress;

    if (this.known === null) {
      this.known = new Set(ids);
      return progress;
    }
    for (const id of ids) {
      if (this.known.has(id)) continue;
      this.known.add(id);
      this.startedAt.set(id, now);
    }
    const present = new Set(ids);
    for (const [id, started] of this.startedAt) {
      const t = (now - started) / APPEAR_DURATION_MS;
      if (!present.has(id) || t >= 1) {
        this.startedAt.delete(id);
        continue;
      }
      progress.set(id, Math.max(0, t));
    }
    return progress;
  }

  /** Whether any shape is still popping in, so the caller knows to keep drawing frames. */
  isAnimating(): boolean {
    return this.startedAt.size > 0;
  }
}

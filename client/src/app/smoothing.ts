import type { RemoteCursor } from "../sync/sync-engine";

/**
 * Remote cursors arrive a few times a second, at the sender's throttle rate.
 * Drawing each one where it was last reported makes it jump. Instead the
 * drawn position chases the reported one, a fixed fraction of the remaining
 * distance per unit of time, so motion looks continuous at any frame rate.
 */

/**
 * Moves `current` toward `target`. After `halfLifeMs` the remaining distance
 * has halved, regardless of how the elapsed time was split into frames:
 * stepping 16 ms twice lands in the same place as stepping 32 ms once.
 */
export function approach(current: number, target: number, dtMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0 || dtMs <= 0) return halfLifeMs <= 0 ? target : current;
  const fraction = 1 - Math.pow(0.5, dtMs / halfLifeMs);
  return current + (target - current) * fraction;
}

export type SmoothedCursor = RemoteCursor;

/** Closer than this to its target, a cursor snaps there so the animation can end. */
const SNAP_DISTANCE = 0.25;

export class CursorSmoother {
  private readonly shown = new Map<string, SmoothedCursor>();

  constructor(private readonly halfLifeMs: number = 45) {}

  /** Advances every cursor toward its target by `dtMs` and returns where to draw them. */
  step(targets: readonly RemoteCursor[], dtMs: number): SmoothedCursor[] {
    const present = new Set<string>();
    const result: SmoothedCursor[] = [];

    for (const target of targets) {
      present.add(target.clientId);
      const previous = this.shown.get(target.clientId);
      // A cursor seen for the first time appears where it is; it does not fly in from the corner.
      const x = previous ? approach(previous.x, target.x, dtMs, this.halfLifeMs) : target.x;
      const y = previous ? approach(previous.y, target.y, dtMs, this.halfLifeMs) : target.y;
      const settled = Math.abs(x - target.x) < SNAP_DISTANCE && Math.abs(y - target.y) < SNAP_DISTANCE;
      const next: SmoothedCursor = { ...target, x: settled ? target.x : x, y: settled ? target.y : y };
      this.shown.set(target.clientId, next);
      result.push(next);
    }

    for (const clientId of [...this.shown.keys()]) {
      if (!present.has(clientId)) this.shown.delete(clientId);
    }
    return result;
  }

  /** True while any cursor has not reached its target, so the caller knows to keep animating. */
  isAnimating(targets: readonly RemoteCursor[]): boolean {
    return targets.some((target) => {
      const shown = this.shown.get(target.clientId);
      return shown === undefined || shown.x !== target.x || shown.y !== target.y;
    });
  }
}

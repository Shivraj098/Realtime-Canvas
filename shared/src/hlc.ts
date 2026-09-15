/**
 * Hybrid Logical Clock (HLC).
 *
 * Problem: to resolve conflicting edits from different clients, we need a
 * total order over events. Wall-clock timestamps look like they'd work,
 * but client clocks drift and skew relative to each other — two browsers
 * can genuinely disagree on what time it is by seconds, so "the edit with
 * the later Date.now() wins" is silently wrong under real network
 * conditions. A pure logical clock (Lamport clock: just an incrementing
 * counter) fixes ordering but throws away wall-clock meaning entirely —
 * you can no longer ask "roughly when did this happen."
 *
 * An HLC keeps both: a physical time component that stays close to real
 * wall-clock time, and a logical counter that only advances to break ties
 * when events are too close together (or when clocks disagree) to be
 * ordered by physical time alone. This is the same mechanism CockroachDB
 * and MongoDB use to order distributed transactions without perfectly
 * synchronized clocks.
 *
 * Reference: Kulkarni et al., "Logical Physical Clocks and Consistent
 * Snapshots in Globally Distributed Databases" (2014).
 */

export type HlcTimestamp = {
  /** Milliseconds since epoch, from the clock that produced this tick. */
  physical: number;
  /** Tie-breaker counter — only increments when physical time doesn't
   * distinguish two events. */
  logical: number;
  /** Origin of this timestamp, used as the final tie-break so ordering is
   * total even if physical+logical are identical. */
  nodeId: string;
};

/**
 * Compares two HLC timestamps. Returns <0 if `a` happened-before `b`,
 * >0 if after, 0 if identical.
 */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a.physical !== b.physical) return a.physical - b.physical;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

export class HybridLogicalClock {
  private physical = 0;
  private logical = 0;

  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Call when producing a new local event. Advances the clock and
   * returns the timestamp to attach to that event. */
  tick(): HlcTimestamp {
    const physicalNow = this.now();
    if (physicalNow > this.physical) {
      this.physical = physicalNow;
      this.logical = 0;
    } else {
      this.logical += 1;
    }
    return { physical: this.physical, logical: this.logical, nodeId: this.nodeId };
  }

  /**
   * Call when receiving a remote event's timestamp. Merges it into local
   * clock state so the local clock never falls behind a remote clock it
   * has observed — this is what makes the ordering causally consistent.
   * Returns the timestamp to assign to the receive event itself.
   */
  update(remote: HlcTimestamp): HlcTimestamp {
    const physicalNow = this.now();
    const newPhysical = Math.max(this.physical, remote.physical, physicalNow);

    let newLogical: number;
    if (newPhysical === this.physical && newPhysical === remote.physical) {
      newLogical = Math.max(this.logical, remote.logical) + 1;
    } else if (newPhysical === this.physical) {
      newLogical = this.logical + 1;
    } else if (newPhysical === remote.physical) {
      newLogical = remote.logical + 1;
    } else {
      newLogical = 0;
    }

    this.physical = newPhysical;
    this.logical = newLogical;
    return { physical: this.physical, logical: this.logical, nodeId: this.nodeId };
  }
}
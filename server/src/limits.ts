/**
 * Every ceiling the server enforces, in one place. They exist because the
 * server is reachable by anyone who has a room link (there are no accounts),
 * so each resource a stranger can make it spend - memory, disk, CPU,
 * connections - needs an upper bound. The defaults suit a small public demo
 * on a single small machine.
 */
export type Limits = {
  /** Open WebSocket connections across the whole server. */
  maxConnections: number;
  /** Rooms held in memory at once. Idle rooms are evicted, so this bounds concurrent activity, not total rooms. */
  maxRooms: number;
  maxClientsPerRoom: number;
  /** Shapes a room may ever contain. Deleted shapes count: they stay as tombstones. */
  maxShapesPerRoom: number;
  /** Ops a room may store. */
  maxOpsPerRoom: number;
  /** Ops stored across all rooms: the bound on disk use. */
  maxTotalOps: number;
  /** Sustained ops per second one connection may send, and the burst it may spend at once. */
  opsPerSecond: number;
  opsBurst: number;
  /** The same for cursor and drag-preview traffic. */
  ephemeralPerSecond: number;
  ephemeralBurst: number;
  /** Rule violations (over-limit or malformed messages) tolerated in a burst before the connection is closed. */
  violationsBeforeClose: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxConnections: 500,
  maxRooms: 500,
  maxClientsPerRoom: 50,
  maxShapesPerRoom: 2000,
  maxOpsPerRoom: 20_000,
  maxTotalOps: 500_000,
  opsPerSecond: 20,
  opsBurst: 40,
  ephemeralPerSecond: 90,
  ephemeralBurst: 180,
  violationsBeforeClose: 100,
};

/** How fast a connection's violation allowance recovers, per second. */
export const VIOLATION_RECOVERY_PER_SECOND = 5;

/**
 * A token bucket: holds up to `capacity` tokens, refilled continuously at
 * `refillPerSecond`; each action spends one. A well-behaved client that
 * stays under the sustained rate never notices it, and a short burst (a
 * flurry of edits) is allowed because the bucket starts full. A client
 * above the sustained rate runs the bucket dry and is refused until it
 * slows down.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Spends one token if there is one. Returns whether the action is allowed. */
  tryTake(): boolean {
    const current = this.now();
    // A clock that steps backwards must not hand out free tokens.
    const elapsedSeconds = Math.max(0, current - this.lastRefill) / 1000;
    this.lastRefill = Math.max(this.lastRefill, current);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

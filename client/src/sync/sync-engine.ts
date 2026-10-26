import {
  applyOp,
  compareHlc,
  getShape,
  HybridLogicalClock,
  isDeleted,
  liveShapes,
  PROTOCOL_VERSION,
  SHAPE_FIELD_KEYS,
  type ErrorCode,
  type GeometryChanges,
  type HlcTimestamp,
  type JoinRoom,
  type Op,
  type OpAck,
  type OpRejectReason,
  type RoomState,
  type ServerMessage,
  type ShapeChanges,
  type ShapeFields,
} from "@realtime-canvas/shared";

/**
 * The client's state machine. No sockets, no timers, no DOM: it is fed
 * server messages and local edits and holds the resulting state, so every
 * rule here is testable by calling methods.
 *
 * The model is "confirmed state plus a pending queue":
 *
 *  - `confirmed` is built ONLY from the server's snapshots and acks,
 *    folded through the same `applyOp` the server uses. It is, by
 *    construction, what the server has.
 *  - `pending` is the queue of local ops the server has not acknowledged
 *    yet (sent or not: offline edits wait here too).
 *  - The view the user sees is derived: `confirmed` with every pending op
 *    applied on top. Because it is derived, there is nothing to undo when
 *    the server rejects an op - dropping it from the queue is the
 *    rollback - and a server ack never has to be reconciled against
 *    half-applied optimistic state.
 *
 * Pending ops are applied to the view as if they came AFTER everything
 * confirmed. That is what will really happen: the server stamps ops in
 * arrival order, so an op it has not seen yet will be stamped later than
 * every op it has. Using the op's own client-side timestamp for this would
 * make the user's edit visibly lose to a concurrent remote edit until the
 * ack arrived, and then flip back.
 */

export type SyncEngineOptions = {
  roomId: string;
  clientId: string;
  now?: () => number;
  newId?: () => string;
  /** Most un-acknowledged ops kept. Further local edits are refused until the queue drains. */
  maxPending?: number;
  /** How long a remote drag preview is shown without an update. */
  previewTtlMs?: number;
  /** Only tests override this. */
  protocolVersion?: number;
};

export type LocalRejectReason = "unknown_shape" | "shape_exists" | "empty_changes" | "queue_full";
export type LocalResult = { ok: true; op: Op } | { ok: false; reason: LocalRejectReason };

export type PresenceEntry = { clientId: string; color: string };
export type RemoteCursor = { clientId: string; x: number; y: number; color: string };
export type RemotePreview = {
  clientId: string;
  shapeId: string;
  changes: GeometryChanges;
  receivedAt: number;
};

/** What the caller needs to react to after feeding the engine a message. */
export type ReceiveEffect = {
  /**
   * The server refused an op. `wasPending` is false if the engine no longer held it.
   * `retryable` means the refusal was about timing, not about the op: the op is STILL
   * queued and the caller should send it again after a pause.
   */
  rejected?: { opId: string; reason: OpRejectReason; wasPending: boolean; retryable: boolean };
  error?: { code: ErrorCode; message: string };
  /** An ack skipped a sequence number: reconnect and resume from `lastSeq`. */
  resyncNeeded?: boolean;
};

/** Rejections that are about timing rather than about the op, so the op is kept and sent again. */
const RETRYABLE_REJECTIONS: readonly OpRejectReason[] = ["rate_limited"];

const DEFAULT_MAX_PENDING = 1000;
const DEFAULT_PREVIEW_TTL_MS = 2000;
const DEFAULT_COLOR = "#7fd8b0";
const ZERO_HLC: HlcTimestamp = { physical: 0, logical: 0, nodeId: "" };

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

function cleanChanges(changes: ShapeChanges): ShapeChanges {
  const cleaned: ShapeChanges = {};
  for (const key of SHAPE_FIELD_KEYS) {
    const value = changes[key];
    if (value !== undefined) (cleaned as Record<string, unknown>)[key] = value;
  }
  return cleaned;
}

export class SyncEngine {
  readonly roomId: string;
  readonly clientId: string;

  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxPending: number;
  private readonly previewTtlMs: number;
  private readonly protocolVersion: number;
  private readonly clock: HybridLogicalClock;

  private confirmed: RoomState = {};
  private lastSeq = 0;
  private confirmedMax: HlcTimestamp = ZERO_HLC;
  private pending: Op[] = [];

  private presence: PresenceEntry[] = [];
  private cursors = new Map<string, RemoteCursor>();
  private previews = new Map<string, RemotePreview>();

  private viewCache: RoomState | null = null;
  private liveCache: RoomState | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(options: SyncEngineOptions) {
    this.roomId = options.roomId;
    this.clientId = options.clientId;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? defaultNewId;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.clock = new HybridLogicalClock(options.clientId, this.now);
  }

  // ---- reading state -------------------------------------------------

  /** Server-confirmed state only, tombstones included. */
  getConfirmed(): RoomState {
    return this.confirmed;
  }

  /** What the user sees: confirmed state with pending ops applied, tombstones included. */
  getView(): RoomState {
    if (!this.viewCache) {
      const base = this.confirmedMax;
      this.viewCache = this.pending.reduce(
        (state, op, index) =>
          applyOp(state, {
            ...op,
            hlc: { physical: base.physical, logical: base.logical + 1 + index, nodeId: this.clientId },
          }),
        this.confirmed,
      );
    }
    return this.viewCache;
  }

  /** The shapes to render: the view without tombstones. */
  getLiveShapes(): RoomState {
    this.liveCache ??= liveShapes(this.getView());
    return this.liveCache;
  }

  /** Highest op sequence number applied; what `join_room.sinceSeq` carries. */
  getLastSeq(): number {
    return this.lastSeq;
  }

  /** Ops waiting for an ack, oldest first. */
  getPending(): readonly Op[] {
    return this.pending;
  }

  /** One entry per clientId, even when a person has several tabs open. */
  getPresence(): readonly PresenceEntry[] {
    return this.presence;
  }

  getCursors(): RemoteCursor[] {
    return [...this.cursors.values()];
  }

  getPreviews(): RemotePreview[] {
    return [...this.previews.values()];
  }

  /** The colour the server assigned this connection, for the cursor this client sends. */
  getSelfColor(): string {
    return this.presence.find((entry) => entry.clientId === this.clientId)?.color ?? DEFAULT_COLOR;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- local edits ---------------------------------------------------

  createShape(fields: ShapeFields, shapeId: string = this.newId()): LocalResult {
    if (this.pending.length >= this.maxPending) return { ok: false, reason: "queue_full" };
    if (getShape(this.getView(), shapeId)) return { ok: false, reason: "shape_exists" };
    return this.enqueue({
      type: "create_shape",
      shapeId,
      roomId: this.roomId,
      fields: { ...fields },
      hlc: this.clock.tick(),
      opId: this.newId(),
    });
  }

  updateShape(shapeId: string, changes: ShapeChanges): LocalResult {
    const cleaned = cleanChanges(changes);
    if (Object.keys(cleaned).length === 0) return { ok: false, reason: "empty_changes" };
    if (this.pending.length >= this.maxPending) return { ok: false, reason: "queue_full" };
    if (!this.isLiveInView(shapeId)) return { ok: false, reason: "unknown_shape" };
    return this.enqueue({
      type: "update_shape",
      shapeId,
      roomId: this.roomId,
      changes: cleaned,
      hlc: this.clock.tick(),
      opId: this.newId(),
    });
  }

  deleteShape(shapeId: string): LocalResult {
    if (this.pending.length >= this.maxPending) return { ok: false, reason: "queue_full" };
    if (!this.isLiveInView(shapeId)) return { ok: false, reason: "unknown_shape" };
    return this.enqueue({
      type: "delete_shape",
      shapeId,
      roomId: this.roomId,
      hlc: this.clock.tick(),
      opId: this.newId(),
    });
  }

  // ---- connection lifecycle ------------------------------------------

  /** The message to send first on every (re)connection. */
  buildJoin(): JoinRoom {
    return {
      type: "join_room",
      protocolVersion: this.protocolVersion,
      roomId: this.roomId,
      clientId: this.clientId,
      sinceSeq: this.lastSeq,
    };
  }

  /** The connection dropped: what the server told us about other people is now stale. Pending ops stay. */
  onDisconnected(): void {
    if (this.presence.length === 0 && this.cursors.size === 0 && this.previews.size === 0) return;
    this.presence = [];
    this.cursors.clear();
    this.previews.clear();
    this.notify();
  }

  /** Drops remote drag previews that have not been refreshed within the TTL. Call it from the render loop. */
  expirePreviews(now: number = this.now()): void {
    let removed = false;
    for (const [key, preview] of this.previews) {
      if (now - preview.receivedAt >= this.previewTtlMs) {
        this.previews.delete(key);
        removed = true;
      }
    }
    if (removed) this.notify();
  }

  // ---- server messages -----------------------------------------------

  receive(message: ServerMessage): ReceiveEffect {
    switch (message.type) {
      case "sync_snapshot":
        if (message.roomId !== this.roomId) return {};
        this.applySnapshot(message.shapes, message.latestSeq);
        return {};
      case "op_ack":
        if (message.roomId !== this.roomId) return {};
        return this.applyAck(message);
      case "op_reject": {
        // "Too fast" says nothing about the op itself. Dropping it would throw
        // away the user's work for sending it at the wrong moment, so it stays queued.
        if (RETRYABLE_REJECTIONS.includes(message.reason)) {
          const stillPending = this.pending.some((op) => op.opId === message.opId);
          return {
            rejected: {
              opId: message.opId,
              reason: message.reason,
              wasPending: stillPending,
              retryable: stillPending,
            },
          };
        }
        const wasPending = this.removePending(message.opId);
        if (wasPending) this.changed();
        return { rejected: { opId: message.opId, reason: message.reason, wasPending, retryable: false } };
      }
      case "error":
        return { error: { code: message.code, message: message.message } };
      case "presence":
        if (message.roomId === this.roomId) this.applyPresence(message.clients);
        return {};
      case "cursor":
        if (message.roomId === this.roomId && message.clientId !== this.clientId) {
          const { clientId, x, y, color } = message;
          this.cursors.set(clientId, { clientId, x, y, color });
          this.notify();
        }
        return {};
      case "drag_preview":
        if (message.roomId === this.roomId && message.clientId !== this.clientId) {
          const key = JSON.stringify([message.clientId, message.shapeId]);
          this.previews.set(key, {
            clientId: message.clientId,
            shapeId: message.shapeId,
            changes: message.changes,
            receivedAt: this.now(),
          });
          this.notify();
        }
        return {};
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  // ---- internals -----------------------------------------------------

  private enqueue(op: Op): LocalResult {
    this.pending = [...this.pending, op];
    this.changed();
    return { ok: true, op };
  }

  private isLiveInView(shapeId: string): boolean {
    const shape = getShape(this.getView(), shapeId);
    return shape !== undefined && !isDeleted(shape);
  }

  private removePending(opId: string): boolean {
    const next = this.pending.filter((op) => op.opId !== opId);
    if (next.length === this.pending.length) return false;
    this.pending = next;
    return true;
  }

  private applySnapshot(shapes: RoomState, latestSeq: number): void {
    // Copy: the message object must not be shared with state we later replace.
    this.confirmed = { ...shapes };
    this.lastSeq = latestSeq;
    this.confirmedMax = ZERO_HLC;
    for (const shape of Object.values(this.confirmed)) {
      for (const key of SHAPE_FIELD_KEYS) this.trackMax(shape.lastHlc[key]);
      if (shape.deletedAt) this.trackMax(shape.deletedAt);
    }
    if (this.confirmedMax.physical > 0) this.clock.update(this.confirmedMax);
    this.previews.clear();
    this.changed();
  }

  private applyAck(message: OpAck): ReceiveEffect {
    const { seq, op } = message;

    // At or below what we have already applied: a replay or a re-ack of a
    // retry. The op is already in `confirmed`; all that is left is to stop
    // waiting for it.
    if (seq <= this.lastSeq) {
      if (this.removePending(op.opId)) this.changed();
      return {};
    }
    // A gap means a message was lost somewhere. Applying past it would make
    // `confirmed` silently wrong, so ask for a resync instead.
    if (seq !== this.lastSeq + 1) return { resyncNeeded: true };

    this.confirmed = applyOp(this.confirmed, op);
    this.lastSeq = seq;
    this.trackMax(op.hlc);
    this.clock.update(op.hlc);
    this.removePending(op.opId);
    this.dropPreviewsFor(op.shapeId);
    this.changed();
    return {};
  }

  private applyPresence(clients: readonly PresenceEntry[]): void {
    const seen = new Set<string>();
    this.presence = clients.filter((entry) => {
      if (seen.has(entry.clientId)) return false;
      seen.add(entry.clientId);
      return true;
    });
    for (const clientId of [...this.cursors.keys()]) {
      if (!seen.has(clientId)) this.cursors.delete(clientId);
    }
    for (const [key, preview] of this.previews) {
      if (!seen.has(preview.clientId)) this.previews.delete(key);
    }
    this.notify();
  }

  private dropPreviewsFor(shapeId: string): void {
    for (const [key, preview] of this.previews) {
      if (preview.shapeId === shapeId) this.previews.delete(key);
    }
  }

  private trackMax(hlc: HlcTimestamp): void {
    if (compareHlc(hlc, this.confirmedMax) > 0) this.confirmedMax = hlc;
  }

  /** Confirmed or pending state changed: drop derived caches, then notify. */
  private changed(): void {
    this.viewCache = null;
    this.liveCache = null;
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

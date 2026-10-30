import type {
  GeometryChanges,
  OpRejectReason,
  ShapeChanges,
  ShapeFields,
  ShapeKind,
} from "@realtime-canvas/shared";
import { RoomSocket, type BackoffOptions, type SocketStatus } from "./net/room-socket";
import {
  globalWebSocketConstructor,
  realScheduler,
  type Scheduler,
  type WebSocketConstructor,
} from "./net/types";
import { SyncEngine, type LocalResult } from "./sync/sync-engine";

/**
 * What the UI talks to: one room, one connection, one state.
 *
 * It wires the three pieces together and owns the rules that span them:
 *  - on every (re)connection, send `join_room` with the last sequence number
 *    applied, then re-send every op that has not been acknowledged. Re-sending
 *    is safe because the server de-duplicates by `opId`. The re-send is PACED
 *    (a few ops at a time) so a long offline queue cannot exceed the server's
 *    rate limit, and it keeps the original order: an update must never reach
 *    the server before the create it depends on;
 *  - if the server says "too fast" (`rate_limited`), keep the op and send it
 *    again after a pause: nothing is wrong with the op itself;
 *  - feed every server message to the sync engine;
 *  - if the engine reports a gap in the op stream, reconnect to resync;
 *  - when the connection drops, forget presence (it is stale) but keep edits.
 */

export type RoomClientOptions = {
  url: string;
  roomId: string;
  /** Identifies this client in the room. Defaults to a fresh id per RoomClient, i.e. per browser tab. */
  clientId?: string;
  WebSocket?: WebSocketConstructor;
  scheduler?: Scheduler;
  random?: () => number;
  backoff?: Partial<BackoffOptions>;
  now?: () => number;
  newId?: () => string;
  maxPending?: number;
  previewTtlMs?: number;
  /** Ops re-sent per pause when catching up after a reconnect. The defaults stay under the server's default rate limit. */
  flushBatchSize?: number;
  flushIntervalMs?: number;
  /** How long to wait before re-sending an op the server refused as too fast. */
  retryDelayMs?: number;
  /** Only tests override this. */
  protocolVersion?: number;
};

export type RoomClientEvent =
  /** `retryable`: the op was kept and will be sent again, so this is a notice, not a rollback. */
  | { type: "op_rejected"; opId: string; reason: OpRejectReason; retryable: boolean }
  | { type: "server_error"; code: string; message: string }
  | { type: "resync_requested" };

export class RoomClient {
  readonly engine: SyncEngine;
  private readonly socket: RoomSocket;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: RoomClientEvent) => void>();
  private readonly scheduler: Scheduler;
  private readonly flushBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly retryDelayMs: number;
  /** Ids of pending ops not yet sent on this connection, oldest first. */
  private unsent: string[] = [];
  private flushTimer: unknown = null;

  constructor(options: RoomClientOptions) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.flushBatchSize = options.flushBatchSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 600;
    this.retryDelayMs = options.retryDelayMs ?? 1500;
    this.engine = new SyncEngine({
      roomId: options.roomId,
      clientId: options.clientId ?? (options.newId ?? (() => globalThis.crypto.randomUUID()))(),
      ...(options.now && { now: options.now }),
      ...(options.newId && { newId: options.newId }),
      ...(options.maxPending !== undefined && { maxPending: options.maxPending }),
      ...(options.previewTtlMs !== undefined && { previewTtlMs: options.previewTtlMs }),
      ...(options.protocolVersion !== undefined && { protocolVersion: options.protocolVersion }),
    });

    this.socket = new RoomSocket(
      {
        url: options.url,
        WebSocket: options.WebSocket ?? globalWebSocketConstructor(),
        ...(options.scheduler && { scheduler: options.scheduler }),
        ...(options.random && { random: options.random }),
        ...(options.backoff && { backoff: options.backoff }),
      },
      {
        onStatus: () => this.notify(),
        onOpen: () => this.handleOpen(),
        onMessage: (message) => {
          const effect = this.engine.receive(message);
          if (effect.rejected) {
            const { opId, reason, retryable } = effect.rejected;
            this.emit({ type: "op_rejected", opId, reason, retryable });
            if (retryable) this.queueRetry(opId);
          }
          if (effect.error) this.emit({ type: "server_error", ...effect.error });
          if (effect.resyncNeeded) {
            this.emit({ type: "resync_requested" });
            this.socket.reconnectLater();
          }
        },
        onClose: () => {
          // A new connection starts the catch-up again from the pending queue.
          this.unsent = [];
          this.clearFlushTimer();
          this.engine.onDisconnected();
        },
      },
    );

    this.engine.subscribe(() => this.notify());
  }

  get clientId(): string {
    return this.engine.clientId;
  }

  getStatus(): SocketStatus {
    return this.socket.getStatus();
  }

  connect(): void {
    this.socket.start();
  }

  disconnect(): void {
    this.socket.stop();
  }

  /**
   * For "the network is back" signals (the browser's `online` event, the tab
   * becoming visible): if a reconnect is waiting out its backoff, try now.
   * Does nothing on a healthy connection.
   */
  retryNow(): void {
    this.socket.retryNow();
  }

  /** Called on any change to state or connection status. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rejected ops, server errors, resync requests. */
  onEvent(listener: (event: RoomClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ---- edits: applied locally at once, sent now if online, otherwise when the connection returns

  createShape(kind: ShapeKind, fields: ShapeFields, shapeId?: string): LocalResult {
    return this.send(this.engine.createShape(kind, fields, shapeId));
  }

  updateShape(shapeId: string, changes: ShapeChanges): LocalResult {
    return this.send(this.engine.updateShape(shapeId, changes));
  }

  deleteShape(shapeId: string): LocalResult {
    return this.send(this.engine.deleteShape(shapeId));
  }

  // ---- ephemeral: dropped when offline, never queued

  sendCursor(x: number, y: number): boolean {
    return this.socket.send({
      type: "cursor",
      roomId: this.engine.roomId,
      clientId: this.engine.clientId,
      x,
      y,
      color: this.engine.getSelfColor(),
    });
  }

  sendDragPreview(shapeId: string, changes: GeometryChanges): boolean {
    return this.socket.send({
      type: "drag_preview",
      roomId: this.engine.roomId,
      clientId: this.engine.clientId,
      shapeId,
      changes,
    });
  }

  private send(result: LocalResult): LocalResult {
    if (!result.ok) return result;
    if (this.unsent.length > 0) {
      // Older ops are still waiting to go out. This one may depend on them
      // (an update on a shape whose create has not been re-sent yet), so it
      // joins the queue instead of overtaking it.
      this.unsent.push(result.op.opId);
      this.ensureFlushScheduled(this.flushIntervalMs);
    } else {
      this.socket.send(result.op);
    }
    return result;
  }

  private handleOpen(): void {
    this.socket.send(this.engine.buildJoin());
    // Everything not yet acknowledged goes out again, oldest first, a few at a
    // time. The server answers ops it already has with the stored ack and
    // ignores them.
    this.unsent = this.engine.getPending().map((op) => op.opId);
    this.flush();
  }

  /** Sends the next batch of waiting ops, then schedules the following one if any remain. */
  private flush(): void {
    this.clearFlushTimer();
    if (this.socket.getStatus() !== "open") return;
    const pending = this.engine.getPending();
    for (const opId of this.unsent.splice(0, this.flushBatchSize)) {
      // An op acknowledged in the meantime is no longer pending: nothing to send.
      const op = pending.find((candidate) => candidate.opId === opId);
      if (op) this.socket.send(op);
    }
    if (this.unsent.length > 0) this.ensureFlushScheduled(this.flushIntervalMs);
  }

  /** The server refused an op as too fast: put it back in line, in its original place, and try again after a pause. */
  private queueRetry(opId: string): void {
    if (!this.unsent.includes(opId)) this.unsent.push(opId);
    const order = new Map(this.engine.getPending().map((op, index) => [op.opId, index]));
    this.unsent.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    this.ensureFlushScheduled(this.retryDelayMs);
  }

  private ensureFlushScheduled(delayMs: number): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = this.scheduler.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    this.scheduler.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private emit(event: RoomClientEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }
}

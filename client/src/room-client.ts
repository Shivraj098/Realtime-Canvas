import type { GeometryChanges, Op, OpRejectReason, ShapeChanges, ShapeFields } from "@realtime-canvas/shared";
import { RoomSocket, type BackoffOptions, type SocketStatus } from "./net/room-socket";
import { globalWebSocketConstructor, type Scheduler, type WebSocketConstructor } from "./net/types";
import { SyncEngine, type LocalResult } from "./sync/sync-engine";

/**
 * What the UI talks to: one room, one connection, one state.
 *
 * It wires the three pieces together and owns the rules that span them:
 *  - on every (re)connection, send `join_room` with the last sequence number
 *    applied, then re-send every op that has not been acknowledged. Re-sending
 *    is safe because the server de-duplicates by `opId`;
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
  /** Only tests override this. */
  protocolVersion?: number;
};

export type RoomClientEvent =
  | { type: "op_rejected"; opId: string; reason: OpRejectReason }
  | { type: "server_error"; code: string; message: string }
  | { type: "resync_requested" };

export class RoomClient {
  readonly engine: SyncEngine;
  private readonly socket: RoomSocket;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: RoomClientEvent) => void>();

  constructor(options: RoomClientOptions) {
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
            this.emit({ type: "op_rejected", opId: effect.rejected.opId, reason: effect.rejected.reason });
          }
          if (effect.error) this.emit({ type: "server_error", ...effect.error });
          if (effect.resyncNeeded) {
            this.emit({ type: "resync_requested" });
            this.socket.reconnectLater();
          }
        },
        onClose: () => this.engine.onDisconnected(),
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

  createShape(fields: ShapeFields, shapeId?: string): LocalResult {
    return this.send(this.engine.createShape(fields, shapeId));
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
    if (result.ok) this.socket.send(result.op);
    return result;
  }

  private handleOpen(): void {
    this.socket.send(this.engine.buildJoin());
    // Everything not yet acknowledged goes out again, oldest first. The
    // server answers ops it already has with the stored ack and ignores them.
    for (const op of this.engine.getPending() as readonly Op[]) this.socket.send(op);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private emit(event: RoomClientEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }
}

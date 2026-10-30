import type { WebSocket } from "ws";
import {
  applyOp,
  getShape,
  isDeleted,
  type Op,
  type RoomState,
  type ShapeKind,
} from "@realtime-canvas/shared";
import type { Logger } from "./app";
import type { StoredOp, StoredSnapshot } from "./op-log";

const PRESENCE_COLORS = ["#7fd8b0", "#d98e3d", "#7aa6d9", "#c97fd8", "#d97f7f"];

export type Client = {
  clientId: string;
  socket: WebSocket;
  color: string;
};

/**
 * Holds the live, in-memory view of one room: who is connected and the
 * current materialized shape state (every op folded through `applyOp`).
 * The SQLite op log is the durable source of truth; this is a cache
 * rebuilt by replaying the log when the room is first opened, then kept
 * current by applying each new op as it arrives.
 *
 * Connections are tracked by *socket*, not by clientId. A client that
 * reconnects quickly (or has two tabs open) can briefly have two live
 * sockets with the same clientId. Keyed by clientId, the old socket's
 * "close" event would delete the new connection's entry and silently stop
 * it receiving broadcasts. Keyed by socket, each connection's lifecycle
 * is independent, so that class of bug cannot happen.
 */
export type RoomInit = {
  /** State to start from before `existingOps` are applied: a loaded snapshot. */
  baseState?: RoomState;
  /** Highest sequence number stored for the room. */
  latestSeq?: number;
  /** Sequence number the last saved snapshot covers. */
  snapshotSeq?: number;
  /** When the room was loaded, for idle tracking. */
  now?: number;
};

export class Room {
  readonly id: string;
  private readonly clients = new Map<WebSocket, Client>();
  private currentState: RoomState;
  private latest: number;
  private snapshotted: number;
  private emptySince: number | null;

  constructor(id: string, existingOps: Op[] = [], init: RoomInit = {}) {
    this.id = id;
    this.currentState = init.baseState ?? {};
    this.latest = init.latestSeq ?? 0;
    this.snapshotted = init.snapshotSeq ?? 0;
    // A room that nobody has joined yet counts as idle from the moment it loaded.
    this.emptySince = init.now ?? 0;
    for (const op of existingOps) {
      this.currentState = applyOp(this.currentState, op);
    }
  }

  /** Highest op sequence number stored for this room. */
  get latestSeq(): number {
    return this.latest;
  }

  /** Sequence number the last saved snapshot covers (0 for none). */
  get snapshotSeq(): number {
    return this.snapshotted;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** When the last connection left (or the room loaded with nobody in it); null while someone is connected. */
  get idleSince(): number | null {
    return this.emptySince;
  }

  /** How many shapes the room has ever had, deleted ones included. */
  shapeCount(): number {
    return Object.keys(this.currentState).length;
  }

  noteAppended(seq: number): void {
    this.latest = Math.max(this.latest, seq);
  }

  noteSnapshotted(seq: number): void {
    this.snapshotted = Math.max(this.snapshotted, seq);
  }

  /** Every shape ever created in the room, including deleted ones (tombstones). */
  get state(): RoomState {
    return this.currentState;
  }

  /** Whether the shape was ever created here - deleted shapes count, since ids are never reused. */
  hasShape(shapeId: string): boolean {
    return getShape(this.currentState, shapeId) !== undefined;
  }

  /** Whether the shape exists and has not been deleted. */
  isLive(shapeId: string): boolean {
    const shape = getShape(this.currentState, shapeId);
    return shape !== undefined && !isDeleted(shape);
  }

  /** The kind of a live shape, or undefined if there is no such live shape. */
  liveKind(shapeId: string): ShapeKind | undefined {
    const shape = getShape(this.currentState, shapeId);
    return shape !== undefined && !isDeleted(shape) ? shape.kind : undefined;
  }

  addClient(clientId: string, socket: WebSocket): Client {
    this.emptySince = null;
    const usedColors = new Set([...this.clients.values()].map((client) => client.color));
    const color =
      PRESENCE_COLORS.find((candidate) => !usedColors.has(candidate)) ??
      PRESENCE_COLORS[this.clients.size % PRESENCE_COLORS.length]!;
    const client: Client = { clientId, socket, color };
    this.clients.set(socket, client);
    return client;
  }

  /** Removes exactly this connection. Returns whether it was present. `now` starts the idle clock if the room is now empty. */
  removeClient(socket: WebSocket, now: number = Date.now()): boolean {
    const removed = this.clients.delete(socket);
    if (removed && this.clients.size === 0) this.emptySince = now;
    return removed;
  }

  applyAndCache(op: Op): void {
    this.currentState = applyOp(this.currentState, op);
  }

  /** Sends `payload` to every open connection, optionally skipping the sender's socket. */
  broadcast(payload: string, exceptSocket?: WebSocket): void {
    for (const [socket] of this.clients) {
      if (socket === exceptSocket) continue;
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  presenceList(): { clientId: string; color: string }[] {
    return [...this.clients.values()].map(({ clientId, color }) => ({ clientId, color }));
  }
}

/** What the manager needs from storage. `OpLog` provides it; tests can provide a fake. */
export type RoomSource = {
  loadSnapshot(roomId: string): StoredSnapshot | null;
  saveSnapshot(roomId: string, seq: number, state: RoomState): void;
  since(roomId: string, sinceSeq: number): StoredOp[];
  latestSeq(roomId: string): number;
};

export type RoomManagerOptions = {
  /** Save a snapshot once this many ops have been stored since the last one. */
  snapshotEvery?: number;
  now?: () => number;
  logger?: Pick<Logger, "warn" | "info">;
};

const DEFAULT_SNAPSHOT_EVERY = 500;

/**
 * Loads rooms on demand and drops them again when they go quiet.
 *
 * A room in memory is a cache of its log. Loading one costs a replay of
 * the log, so a snapshot of the folded state is kept and only the ops
 * AFTER it are replayed ("snapshot plus tail"). Idle rooms are evicted so
 * memory is bounded by how many rooms are active at once, not by how many
 * exist; the next visitor simply loads it again.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly snapshotEvery: number;
  private readonly now: () => number;

  constructor(
    private readonly source: RoomSource,
    private readonly options: RoomManagerOptions = {},
  ) {
    this.snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    this.now = options.now ?? Date.now;
  }

  /** Rooms currently held in memory. */
  get size(): number {
    return this.rooms.size;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  get(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.load(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Records that op `seq` was stored in `room`, and saves a snapshot if enough ops have piled up. */
  noteAppended(room: Room, seq: number): void {
    room.noteAppended(seq);
    if (seq - room.snapshotSeq >= this.snapshotEvery) this.snapshot(room);
  }

  /** Saves a snapshot of every room that has ops past its last one. Used on shutdown. */
  snapshotAll(): void {
    for (const room of this.rooms.values()) this.snapshot(room);
  }

  /** Drops rooms nobody has been in for `idleMs`. Returns how many were dropped. */
  evictIdle(idleMs: number): number {
    const now = this.now();
    let evicted = 0;
    for (const [roomId, room] of this.rooms) {
      if (room.clientCount > 0 || room.idleSince === null) continue;
      if (now - room.idleSince < idleMs) continue;
      // Save before dropping, so the next load replays almost nothing.
      this.snapshot(room);
      this.rooms.delete(roomId);
      evicted += 1;
    }
    return evicted;
  }

  private snapshot(room: Room): void {
    if (room.latestSeq <= room.snapshotSeq) return;
    try {
      this.source.saveSnapshot(room.id, room.latestSeq, room.state);
      room.noteSnapshotted(room.latestSeq);
    } catch (error) {
      // A snapshot is an optimisation. Failing to save one must never fail a room.
      this.options.logger?.warn(`[rooms] could not save a snapshot for room ${room.id}`, error);
    }
  }

  private load(roomId: string): Room {
    const latestSeq = this.source.latestSeq(roomId);
    let baseState: RoomState = {};
    let baseSeq = 0;
    try {
      const snapshot = this.source.loadSnapshot(roomId);
      // A snapshot from the future of the log would be wrong state: ignore it.
      if (snapshot && snapshot.seq <= latestSeq) {
        baseState = snapshot.state;
        baseSeq = snapshot.seq;
      }
    } catch (error) {
      this.options.logger?.warn(`[rooms] ignoring an unreadable snapshot for room ${roomId}`, error);
    }
    const tail = this.source.since(roomId, baseSeq).map((stored) => stored.op);
    return new Room(roomId, tail, { baseState, latestSeq, snapshotSeq: baseSeq, now: this.now() });
  }
}

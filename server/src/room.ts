import type { WebSocket } from "ws";
import { applyOp, getShape, isDeleted, type Op, type RoomState } from "@realtime-canvas/shared";

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
export class Room {
  readonly id: string;
  private readonly clients = new Map<WebSocket, Client>();
  private currentState: RoomState = {};

  constructor(id: string, existingOps: Op[] = []) {
    this.id = id;
    for (const op of existingOps) {
      this.currentState = applyOp(this.currentState, op);
    }
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

  addClient(clientId: string, socket: WebSocket): Client {
    const usedColors = new Set([...this.clients.values()].map((client) => client.color));
    const color =
      PRESENCE_COLORS.find((candidate) => !usedColors.has(candidate)) ??
      PRESENCE_COLORS[this.clients.size % PRESENCE_COLORS.length]!;
    const client: Client = { clientId, socket, color };
    this.clients.set(socket, client);
    return client;
  }

  /** Removes exactly this connection. Returns whether it was present. */
  removeClient(socket: WebSocket): boolean {
    return this.clients.delete(socket);
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

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly loadOps: (roomId: string) => Op[]) {}

  get(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this.loadOps(roomId));
      this.rooms.set(roomId, room);
    }
    return room;
  }
}

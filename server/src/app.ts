import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  HybridLogicalClock,
  type ClientMessage,
  type CursorUpdate,
  type Op,
  type ServerMessage,
} from "@realtime-canvas/shared";
import { OpLog } from "./op-log";
import { Room, RoomManager } from "./room";
import { parseClientMessage } from "./validation";

export type Logger = Pick<Console, "info" | "warn" | "error">;

export type ServerOptions = {
  /** Port to listen on. 0 asks the OS for a free port (used by tests). */
  port: number;
  /** SQLite file path, or ":memory:" for a throwaway database. */
  dbPath: string;
  logger?: Logger;
  /** Largest accepted frame. Bigger frames close the connection with code 1009. */
  maxPayloadBytes?: number;
  /** How far ahead of the server's clock a client's claimed timestamp may be. */
  maxClockDriftMs?: number;
};

export type ServerHandle = {
  wss: WebSocketServer;
  opLog: OpLog;
  /** The port actually bound - differs from the requested one when port is 0. */
  port: number;
  close: () => Promise<void>;
};

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_CLOCK_DRIFT_MS = 60_000;

/** What a connection knows once it has joined a room. */
type Session = { room: Room; clientId: string };

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

/**
 * Builds and starts the WebSocket server.
 *
 * This is a factory rather than top-level code so tests can start and stop
 * real servers (real sockets, real SQLite) on throwaway ports; the process
 * entry point (index.ts) is a thin wrapper that reads environment config.
 *
 * The guiding rule: the server is the authority and clients are untrusted.
 * Every inbound frame is validated, the room and sender identity come from
 * the connection (never from the payload), and timestamps are re-stamped
 * by the server's own clock.
 */
export function createServer(opts: ServerOptions): ServerHandle {
  const logger = opts.logger ?? console;
  const maxClockDriftMs = opts.maxClockDriftMs ?? DEFAULT_MAX_CLOCK_DRIFT_MS;

  if (opts.dbPath !== ":memory:") {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
  }

  const opLog = new OpLog(opts.dbPath);
  const rooms = new RoomManager((roomId) => opLog.since(roomId, 0).map((row) => row.op));

  // One HLC for the whole process. Every op passes through it via
  // `.update()`, giving all rooms a single, monotonically increasing
  // timeline.
  const serverClock = new HybridLogicalClock("server");

  function send(socket: WebSocket, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  function broadcastPresence(room: Room): void {
    const message: ServerMessage = { type: "presence", roomId: room.id, clients: room.presenceList() };
    room.broadcast(JSON.stringify(message));
  }

  /**
   * Picks the timestamp for an incoming op. Merging the client's claimed
   * HLC keeps causality (the server clock never falls behind a client it
   * has heard from), but a claim far in the future would drag the server
   * clock forward and make every later op "newer" than real edits, so
   * implausible claims are ignored and the server just ticks.
   */
  function stampFor(claimed: Op["hlc"], clientId: string) {
    if (claimed.physical > Date.now() + maxClockDriftMs) {
      logger.warn(`[server] ignoring client HLC too far in the future (client ${clientId})`);
      return serverClock.tick();
    }
    return serverClock.update(claimed);
  }

  const wss = new WebSocketServer({
    port: opts.port,
    maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  wss.on("connection", (socket: WebSocket) => {
    let session: Session | null = null;

    function handleJoin(message: Extract<ClientMessage, { type: "join_room" }>): void {
      if (session) {
        logger.warn(`[server] ignoring repeated join_room from client ${session.clientId}`);
        return;
      }
      const room = rooms.get(message.roomId);
      room.addClient(message.clientId, socket);
      session = { room, clientId: message.clientId };

      const latestSeq = opLog.latestSeq(room.id);
      // sinceSeq 0 means "I have nothing". A sinceSeq beyond what the log
      // contains means the client is ahead of us (for instance the server
      // lost its database), so replaying "what it missed" would send
      // nothing and leave it silently out of sync - a full snapshot is the
      // only safe answer in both cases.
      if (message.sinceSeq === 0 || message.sinceSeq > latestSeq) {
        send(socket, { type: "sync_snapshot", roomId: room.id, shapes: room.state, latestSeq });
      } else {
        for (const { seq, op } of opLog.since(room.id, message.sinceSeq)) {
          send(socket, { type: "op_ack", roomId: room.id, seq, op });
        }
      }
      broadcastPresence(room);
    }

    function handleCursor(message: CursorUpdate): void {
      if (!session) {
        logger.warn("[server] ignoring cursor from a client that has not joined a room");
        return;
      }
      // Cursor traffic is ephemeral: never persisted, never HLC-stamped.
      // Room and identity are overwritten from the session so a client
      // cannot impersonate another or write into a room it isn't in.
      const outgoing: CursorUpdate = { ...message, roomId: session.room.id, clientId: session.clientId };
      session.room.broadcast(JSON.stringify(outgoing satisfies ServerMessage), socket);
    }

    function handleOp(message: Op): void {
      if (!session) {
        logger.warn("[server] ignoring op from a client that has not joined a room");
        return;
      }
      const { room, clientId } = session;
      const stampedOp: Op = { ...message, roomId: room.id, hlc: stampFor(message.hlc, clientId) };

      const result = opLog.append(room.id, stampedOp);
      if (result.status === "duplicate") {
        // A retry of an op we already have. The original was (or will be)
        // delivered through the normal broadcast/replay path.
        logger.info(`[server] dropped duplicate op ${message.opId} in room ${room.id}`);
        return;
      }

      room.applyAndCache(stampedOp);
      const ack: ServerMessage = { type: "op_ack", roomId: room.id, seq: result.seq, op: stampedOp };
      room.broadcast(JSON.stringify(ack));
    }

    function handleFrame(raw: RawData, isBinary: boolean): void {
      if (isBinary) {
        logger.warn("[server] dropped binary frame (protocol is JSON text only)");
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(rawToString(raw));
      } catch {
        logger.warn("[server] dropped frame that is not valid JSON");
        return;
      }

      const parsed = parseClientMessage(json);
      if (!parsed.ok) {
        logger.warn(`[server] dropped invalid message - ${parsed.error}`);
        return;
      }

      const { message } = parsed;
      switch (message.type) {
        case "join_room":
          return handleJoin(message);
        case "cursor":
          return handleCursor(message);
        case "create_shape":
        case "update_shape":
        case "delete_shape":
          return handleOp(message);
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    }

    socket.on("message", (raw: RawData, isBinary: boolean) => {
      // A bug or bad input while handling one frame must never take the
      // process (and every other room) down with it.
      try {
        handleFrame(raw, isBinary);
      } catch (error) {
        logger.error("[server] unhandled error while handling a frame", error);
      }
    });

    // ws emits "error" for protocol violations (for example an oversized
    // frame). An EventEmitter "error" with no listener throws, so this
    // handler is what keeps one bad connection from crashing the server.
    socket.on("error", (error: Error) => {
      logger.warn(`[server] socket error: ${error.message}`);
    });

    socket.on("close", () => {
      if (!session) return;
      const { room } = session;
      if (room.removeClient(socket)) {
        broadcastPresence(room);
      }
    });
  });

  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    wss,
    opLog,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        // Close the database only after the server has fully stopped, so
        // no in-flight message can hit a closed connection.
        wss.close(() => {
          opLog.close();
          resolve();
        });
      }),
  };
}

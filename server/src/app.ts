import { mkdirSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  CLOSE_POLICY_VIOLATION,
  CLOSE_ROOM_REFUSED,
  CLOSE_TRY_AGAIN_LATER,
  CLOSE_UNSUPPORTED_PROTOCOL,
  HlcDriftError,
  geometryProblem,
  HybridLogicalClock,
  PROTOCOL_VERSION,
  type ClientMessage,
  type CursorUpdate,
  type DragPreview,
  type ErrorCode,
  type Op,
  type OpRejectReason,
  type ServerMessage,
} from "@realtime-canvas/shared";
import { DEFAULT_LIMITS, TokenBucket, VIOLATION_RECOVERY_PER_SECOND, type Limits } from "./limits";
import { OpLog, type StoredOp } from "./op-log";
import { compileOriginMatcher } from "./origin";
import { Room, RoomManager } from "./room";
import { parseClientMessage, rejectableOpId } from "./validation";

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
  /**
   * Origins (see origin.ts) allowed to open a WebSocket. Empty or omitted
   * means any origin is accepted, which suits local development only.
   */
  allowedOrigins?: readonly string[];
  /** Overrides for the ceilings in limits.ts. */
  limits?: Partial<Limits>;
  /** How often to ping every connection; one that has not answered by the next round is dropped. 0 turns it off. */
  heartbeatIntervalMs?: number;
  /** How long a room with nobody in it stays in memory. */
  roomIdleMs?: number;
  /** How often to look for idle rooms. 0 turns the automatic sweep off (tests call `sweepIdleRooms`). */
  sweepIntervalMs?: number;
  /** A connection that has not joined a room within this long is closed, so idle strangers cannot hold connection slots. 0 turns it off. */
  joinTimeoutMs?: number;
  /** Save a room snapshot after this many ops. */
  snapshotEvery?: number;
  /** Refuse room ids shorter than this. Set it high enough that ids cannot be guessed (the web app makes 22-character ones). */
  minRoomIdLength?: number;
  /** The clock, for rate limiting and idle tracking. Tests pass a controllable one. */
  now?: () => number;
};

export type ServerStats = { rooms: number; connections: number; totalOps: number };

export type ServerHandle = {
  wss: WebSocketServer;
  httpServer: Server;
  opLog: OpLog;
  /** The port actually bound - differs from the requested one when port is 0. */
  port: number;
  stats: () => ServerStats;
  /** Evicts rooms that have been empty for longer than `roomIdleMs` now. Returns how many. */
  sweepIdleRooms: () => number;
  close: () => Promise<void>;
};

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_CLOCK_DRIFT_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_ROOM_IDLE_MS = 5 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SNAPSHOT_EVERY = 500;
const DEFAULT_JOIN_TIMEOUT_MS = 10_000;

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

  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const minRoomIdLength = opts.minRoomIdLength ?? 1;
  const roomIdleMs = opts.roomIdleMs ?? DEFAULT_ROOM_IDLE_MS;
  const originAllowed =
    opts.allowedOrigins && opts.allowedOrigins.length > 0 ? compileOriginMatcher(opts.allowedOrigins) : null;
  const startedAt = now();

  const opLog = new OpLog(opts.dbPath);
  const rooms = new RoomManager(opLog, {
    snapshotEvery: opts.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY,
    now,
    logger,
  });

  // One HLC for the whole process. Every op passes through it via
  // `.update()`, giving all rooms a single, monotonically increasing
  // timeline. The clock itself refuses client timestamps that are too far
  // ahead (see stampFor).
  const serverClock = new HybridLogicalClock("server", Date.now, { maxDriftMs: maxClockDriftMs });

  function send(socket: WebSocket, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
    send(socket, { type: "error", code, message });
  }

  function sendReject(socket: WebSocket, opId: string, reason: OpRejectReason): void {
    send(socket, { type: "op_reject", opId, reason });
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
   * implausible claims are ignored and the server just ticks. The limit
   * lives in the clock (`maxDriftMs`); this only decides what to do when
   * it trips.
   */
  function stampFor(claimed: Op["hlc"], clientId: string) {
    try {
      return serverClock.update(claimed);
    } catch (error) {
      if (!(error instanceof HlcDriftError)) throw error;
      logger.warn(`[server] ignoring client HLC too far in the future (client ${clientId})`);
      return serverClock.tick();
    }
  }

  /** Why an op that is not a retry cannot be applied, or null if it can. */
  function semanticRejection(room: Room, op: Op): OpRejectReason | null {
    if (op.type === "create_shape") return room.hasShape(op.shapeId) ? "shape_exists" : null;
    const kind = room.liveKind(op.shapeId);
    if (kind === undefined) return "unknown_shape";
    // Only a line or arrow may have a negative size; the schema cannot know the kind of an existing shape.
    if (op.type === "update_shape" && geometryProblem(kind, op.changes) !== null) return "invalid";
    return null;
  }

  /** Why a valid, new op must still be refused because a ceiling has been reached, or null. */
  function capRejection(room: Room, op: Op): OpRejectReason | null {
    if (op.type === "create_shape" && room.shapeCount() >= limits.maxShapesPerRoom) return "room_full";
    if (room.latestSeq >= limits.maxOpsPerRoom) return "room_full";
    if (opLog.totalOps() >= limits.maxTotalOps) return "server_full";
    return null;
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  // ---- plain HTTP: a health check for the hosting platform, nothing else ----

  function respondJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const readOnly = req.method === "GET" || req.method === "HEAD";
    if (path === "/health" && readOnly) {
      try {
        opLog.ping();
      } catch (error) {
        logger.error("[server] health check failed: the database is not readable", error);
        respondJson(req, res, 503, { status: "error" });
        return;
      }
      // Counts only: a health response must not reveal room ids.
      respondJson(req, res, 200, {
        status: "ok",
        uptimeSeconds: Math.round((now() - startedAt) / 1000),
        rooms: rooms.size,
        connections: wss.clients.size,
      });
      return;
    }
    if (path === "/" && readOnly) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "realtime-canvas server\n");
      return;
    }
    respondJson(req, res, 404, { error: "not found" });
  }

  const httpServer = createHttpServer(handleHttp);

  // ---- the WebSocket handshake: who may connect at all ----

  httpServer.on("upgrade", (req, socket, head) => {
    const refuse = (status: number, text: string): void => {
      socket.on("error", () => {});
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (originAllowed && !originAllowed(req.headers.origin)) {
      logger.warn(`[server] refused a connection from origin ${req.headers.origin ?? "(none)"}`);
      refuse(403, "Forbidden");
      return;
    }
    if (wss.clients.size >= limits.maxConnections) {
      logger.warn("[server] refused a connection: at the connection limit");
      refuse(503, "Service Unavailable");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // ---- heartbeat: find connections that died without saying goodbye ----

  const answered = new WeakSet<WebSocket>();
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const client of wss.clients) {
            if (!answered.has(client)) {
              // No pong since the last ping: the peer is gone (a dropped phone, a dead proxy path).
              client.terminate();
              continue;
            }
            answered.delete(client);
            client.ping();
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  // ---- idle rooms are dropped from memory ----

  function sweepIdleRooms(): number {
    const evicted = rooms.evictIdle(roomIdleMs);
    if (evicted > 0) logger.info(`[server] evicted ${evicted} idle room(s) from memory`);
    return evicted;
  }
  const sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const sweeper = sweepMs > 0 ? setInterval(sweepIdleRooms, sweepMs) : null;
  sweeper?.unref();

  wss.on("connection", (socket: WebSocket) => {
    let session: Session | null = null;
    let closing = false;

    answered.add(socket);
    socket.on("pong", () => answered.add(socket));

    // A connection answers pings without ever joining anything. Without a
    // deadline, a few hundred of those would use up every connection slot.
    const joinTimeoutMs = opts.joinTimeoutMs ?? DEFAULT_JOIN_TIMEOUT_MS;
    const joinTimer =
      joinTimeoutMs > 0
        ? setTimeout(() => {
            if (session || closing) return;
            closing = true;
            logger.warn("[server] closing a connection that never joined a room");
            sendError(socket, "not_joined", "join a room promptly after connecting");
            socket.close(CLOSE_POLICY_VIOLATION, "join timeout");
          }, joinTimeoutMs)
        : null;
    joinTimer?.unref();
    socket.on("close", () => {
      if (joinTimer) clearTimeout(joinTimer);
    });

    // Three allowances per connection. Ops and ephemeral traffic have their
    // own, so a busy cursor cannot starve real edits. Breaking a rule spends
    // a "strike"; running out of strikes ends the connection.
    const opBucket = new TokenBucket(limits.opsBurst, limits.opsPerSecond, now);
    const ephemeralBucket = new TokenBucket(limits.ephemeralBurst, limits.ephemeralPerSecond, now);
    const strikes = new TokenBucket(limits.violationsBeforeClose, VIOLATION_RECOVERY_PER_SECOND, now);

    function violation(): void {
      if (closing || strikes.tryTake()) return;
      closing = true;
      logger.warn("[server] closing a connection that keeps breaking the rules");
      sendError(socket, "rate_limited", "too many invalid or excessive messages; closing this connection");
      socket.close(CLOSE_POLICY_VIOLATION, "rate limit exceeded");
    }

    function refuseJoin(code: ErrorCode, message: string, closeCode: number): void {
      closing = true;
      sendError(socket, code, message);
      socket.close(closeCode, code);
    }

    function handleJoin(message: Extract<ClientMessage, { type: "join_room" }>): void {
      if (session) {
        logger.warn(`[server] ignoring repeated join_room from client ${session.clientId}`);
        sendError(socket, "already_joined", "this connection has already joined a room");
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        logger.warn(
          `[server] refusing join: protocol version ${message.protocolVersion}, expected ${PROTOCOL_VERSION}`,
        );
        sendError(
          socket,
          "unsupported_protocol",
          `server speaks protocol version ${PROTOCOL_VERSION}, client sent ${message.protocolVersion}`,
        );
        socket.close(CLOSE_UNSUPPORTED_PROTOCOL, "unsupported protocol version");
        return;
      }
      if (message.roomId.length < minRoomIdLength) {
        logger.warn(
          `[server] refused room id of length ${message.roomId.length} (minimum ${minRoomIdLength})`,
        );
        refuseJoin(
          "invalid_room",
          `room ids must be at least ${minRoomIdLength} characters`,
          CLOSE_ROOM_REFUSED,
        );
        return;
      }
      if (!rooms.has(message.roomId) && rooms.size >= limits.maxRooms) {
        logger.warn("[server] refused a join: at the room limit");
        refuseJoin("server_busy", "the server is at capacity; try again later", CLOSE_TRY_AGAIN_LATER);
        return;
      }
      const room = rooms.get(message.roomId);
      if (room.clientCount >= limits.maxClientsPerRoom) {
        logger.warn(`[server] refused a join: room ${room.id} is full`);
        refuseJoin("room_full", "this room is full; try again later", CLOSE_TRY_AGAIN_LATER);
        return;
      }
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
        sendError(socket, "not_joined", "join a room before sending cursor updates");
        return;
      }
      // Over the allowance: dropped without a reply. Ephemeral data is stale
      // in a second anyway, and answering each frame would only add traffic.
      if (!ephemeralBucket.tryTake()) return violation();
      // Cursor traffic is ephemeral: never persisted, never HLC-stamped.
      // Room and identity are overwritten from the session so a client
      // cannot impersonate another or write into a room it isn't in.
      const outgoing: CursorUpdate = { ...message, roomId: session.room.id, clientId: session.clientId };
      session.room.broadcast(JSON.stringify(outgoing satisfies ServerMessage), socket);
    }

    function handleDragPreview(message: DragPreview): void {
      if (!session) {
        logger.warn("[server] ignoring drag preview from a client that has not joined a room");
        sendError(socket, "not_joined", "join a room before sending drag previews");
        return;
      }
      if (!ephemeralBucket.tryTake()) return violation();
      // Ephemeral like cursors, with the same identity overwrite. A preview
      // for a shape that does not exist (or is deleted) is dropped quietly:
      // it is high-frequency, short-lived, and an error per frame would
      // only add noise.
      const kind = session.room.liveKind(message.shapeId);
      if (kind === undefined || geometryProblem(kind, message.changes) !== null) return;
      const outgoing: DragPreview = { ...message, roomId: session.room.id, clientId: session.clientId };
      session.room.broadcast(JSON.stringify(outgoing satisfies ServerMessage), socket);
    }

    /** Answers a retry of an op that is already in the log with its stored sequence number, to the sender only. */
    function reAck(room: Room, stored: StoredOp): void {
      logger.info(`[server] re-acknowledged duplicate op ${stored.op.opId} in room ${room.id}`);
      send(socket, { type: "op_ack", roomId: room.id, seq: stored.seq, op: stored.op });
    }

    function handleOp(message: Op): void {
      if (!session) {
        logger.warn("[server] ignoring op from a client that has not joined a room");
        sendReject(socket, message.opId, "not_joined");
        return;
      }
      const { room, clientId } = session;

      // Rate limit first: it is the cheapest check, and a flood should cost as little as possible.
      if (!opBucket.tryTake()) {
        sendReject(socket, message.opId, "rate_limited");
        return violation();
      }

      // A retry must be recognised BEFORE the semantic checks below: a
      // retried create would otherwise be refused as "shape_exists" because
      // its own first attempt created the shape.
      const known = opLog.find(room.id, message.opId);
      if (known) return reAck(room, known);

      const rejection = semanticRejection(room, message);
      if (rejection) {
        logger.info(`[server] rejected op ${message.opId} in room ${room.id}: ${rejection}`);
        sendReject(socket, message.opId, rejection);
        return;
      }

      const capped = capRejection(room, message);
      if (capped) {
        logger.warn(`[server] rejected op ${message.opId} in room ${room.id}: ${capped}`);
        sendReject(socket, message.opId, capped);
        return;
      }

      const stampedOp: Op = { ...message, roomId: room.id, hlc: stampFor(message.hlc, clientId) };
      const result = opLog.append(room.id, stampedOp);
      if (result.status === "duplicate") return reAck(room, result);

      room.applyAndCache(stampedOp);
      // After the op is applied, so a snapshot taken now includes it.
      rooms.noteAppended(room, result.seq);
      const ack: ServerMessage = { type: "op_ack", roomId: room.id, seq: result.seq, op: stampedOp };
      room.broadcast(JSON.stringify(ack));
    }

    function handleFrame(raw: RawData, isBinary: boolean): void {
      if (closing) return;
      if (isBinary) {
        logger.warn("[server] dropped binary frame (protocol is JSON text only)");
        sendError(socket, "invalid_message", "binary frames are not supported; send JSON text");
        return violation();
      }

      let json: unknown;
      try {
        json = JSON.parse(rawToString(raw));
      } catch {
        logger.warn("[server] dropped frame that is not valid JSON");
        sendError(socket, "invalid_message", "frame is not valid JSON");
        return violation();
      }

      const parsed = parseClientMessage(json);
      if (!parsed.ok) {
        logger.warn(`[server] dropped invalid message - ${parsed.error}`);
        // An op the client is waiting on gets a rejection it can match by
        // opId; anything else gets a connection-level error.
        const opId = rejectableOpId(json);
        if (opId !== null) sendReject(socket, opId, "invalid");
        else sendError(socket, "invalid_message", parsed.error);
        return violation();
      }

      const { message } = parsed;
      switch (message.type) {
        case "join_room":
          return handleJoin(message);
        case "cursor":
          return handleCursor(message);
        case "drag_preview":
          return handleDragPreview(message);
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
      if (room.removeClient(socket, now())) {
        broadcastPresence(room);
      }
    });
  });

  httpServer.listen(opts.port);
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  return {
    wss,
    httpServer,
    opLog,
    port,
    stats: () => ({ rooms: rooms.size, connections: wss.clients.size, totalOps: opLog.totalOps() }),
    sweepIdleRooms,
    close: () =>
      new Promise<void>((resolve) => {
        if (heartbeat) clearInterval(heartbeat);
        if (sweeper) clearInterval(sweeper);
        // Persist every room's state while the database is still open, so the next start loads quickly.
        rooms.snapshotAll();
        for (const client of wss.clients) client.terminate();
        // Close the database only after the server has fully stopped, so
        // no in-flight message can hit a closed connection.
        wss.close(() => {
          httpServer.close(() => {
            opLog.close();
            resolve();
          });
          // Health checks use keep-alive connections that would otherwise hold the server open.
          httpServer.closeAllConnections();
        });
      }),
  };
}

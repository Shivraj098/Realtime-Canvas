import {
  CLOSE_ROOM_REFUSED,
  CLOSE_UNSUPPORTED_PROTOCOL,
  type ClientMessage,
  type ServerMessage,
} from "@realtime-canvas/shared";
import { parseServerMessage } from "./parse-server-message";
import {
  realScheduler,
  WS_OPEN,
  type Scheduler,
  type WebSocketConstructor,
  type WebSocketLike,
} from "./types";

/**
 * One WebSocket connection that heals itself: when the connection drops it
 * waits, then reconnects, backing off exponentially so a struggling server
 * is not hammered by every client at once.
 *
 * This class knows nothing about rooms, ops, or state. It opens sockets,
 * parses and validates what arrives, and reports what happened; the layer
 * above decides what to say on each (re)connection.
 */

export type SocketStatus =
  /** Never started. */
  | "idle"
  | "connecting"
  | "open"
  /** Connection lost; a reconnect is scheduled. */
  | "waiting"
  /** Stopped on purpose. */
  | "closed"
  /** The server refused our protocol version. Retrying cannot help until the client is updated. */
  | "unsupported_protocol"
  /** The server refused this room (for example its id is too short). Retrying the same room cannot help. */
  | "refused";

export type BackoffOptions = {
  baseMs: number;
  maxMs: number;
  /** Extra random delay, as a fraction of the delay (0.3 adds up to 30%). */
  jitter: number;
};

/** States that end the connection for good: nothing reconnects until `start` is called again. */
function isTerminal(status: SocketStatus): boolean {
  return (
    status === "idle" || status === "closed" || status === "unsupported_protocol" || status === "refused"
  );
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 15_000, jitter: 0.3 };

/**
 * Delay before reconnect attempt number `attempt` (0 for the first):
 * `min(base * 2^attempt, max)` plus up to `jitter` of that on top. The
 * jitter matters: after a server restart every client would otherwise
 * retry at exactly the same moments, in synchronised waves.
 */
export function backoffDelay(attempt: number, backoff: BackoffOptions, random: () => number): number {
  const exponential = Math.min(backoff.baseMs * 2 ** attempt, backoff.maxMs);
  return Math.round(exponential + random() * backoff.jitter * exponential);
}

export type RoomSocketOptions = {
  url: string;
  WebSocket: WebSocketConstructor;
  scheduler?: Scheduler;
  random?: () => number;
  backoff?: Partial<BackoffOptions>;
};

export type RoomSocketHandlers = {
  onStatus?: (status: SocketStatus) => void;
  /** The connection is open. Send whatever must come first (the join). */
  onOpen?: () => void;
  onMessage?: (message: ServerMessage) => void;
  /** The connection that was open (or connecting) is gone. Called once per connection. */
  onClose?: () => void;
};

const noop = (): void => {};

export class RoomSocket {
  private readonly url: string;
  private readonly WebSocketCtor: WebSocketConstructor;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly backoff: BackoffOptions;

  private status: SocketStatus = "idle";
  private socket: WebSocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private heardFromServer = false;
  private dropped = 0;

  constructor(
    options: RoomSocketOptions,
    private readonly handlers: RoomSocketHandlers = {},
  ) {
    this.url = options.url;
    this.WebSocketCtor = options.WebSocket;
    this.scheduler = options.scheduler ?? realScheduler;
    this.random = options.random ?? Math.random;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  }

  getStatus(): SocketStatus {
    return this.status;
  }

  /** Consecutive failed attempts since the server last spoke to us. */
  getAttempt(): number {
    return this.attempt;
  }

  /** Frames discarded because they were binary or not a valid server message. */
  getDroppedFrames(): number {
    return this.dropped;
  }

  /** Starts connecting. Does nothing if already connecting, open, or waiting to retry. */
  start(): void {
    if (this.status === "connecting" || this.status === "open" || this.status === "waiting") return;
    this.attempt = 0;
    this.connect();
  }

  /** Closes the connection and stops reconnecting until `start` is called again. */
  stop(): void {
    this.clearTimer();
    const hadSocket = this.dropSocket(1000);
    this.setStatus("closed");
    if (hadSocket) this.handlers.onClose?.();
  }

  /** Throws the current connection away and connects again immediately, without backoff. */
  reconnectNow(): void {
    if (isTerminal(this.status)) return;
    this.clearTimer();
    const hadSocket = this.dropSocket(1000);
    this.attempt = 0;
    if (hadSocket) this.handlers.onClose?.();
    this.connect();
  }

  /** Cuts a backoff wait short and connects now. Does nothing unless a reconnect is already scheduled, so it cannot disturb a healthy connection. */
  retryNow(): void {
    if (this.status !== "waiting") return;
    this.clearTimer();
    this.connect();
  }

  /**
   * Throws the current connection away and reconnects after the normal
   * backoff delay. For recovering from a protocol-level anomaly: unlike
   * `reconnectNow`, a server that keeps misbehaving cannot make this loop hot.
   */
  reconnectLater(): void {
    if (isTerminal(this.status)) return;
    this.clearTimer();
    const hadSocket = this.dropSocket(1000);
    if (hadSocket) this.handlers.onClose?.();
    this.scheduleReconnect();
  }

  /** Sends a message if the connection is open. Returns whether it was handed to the socket. */
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (this.status !== "open" || !socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    this.setStatus("connecting");
    let socket: WebSocketLike;
    try {
      socket = new this.WebSocketCtor(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    // Every handler first checks that its socket is still THE socket. A
    // connection we have already abandoned can still deliver a late event;
    // it must not be mistaken for the current one.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.heardFromServer = false;
      this.setStatus("open");
      this.handlers.onOpen?.();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== "string") {
        this.dropped += 1; // the protocol is JSON text only
        return;
      }
      const message = parseServerMessage(event.data);
      if (!message) {
        this.dropped += 1;
        return;
      }
      if (!this.heardFromServer) {
        // A real server message arrived, so the next outage starts a fresh
        // backoff. Garbage does not count: a peer that only sends nonsense is
        // not a healthy server.
        this.heardFromServer = true;
        this.attempt = 0;
      }
      this.handlers.onMessage?.(message);
    };
    // A failed connection reports "error" and then "close"; reacting to the close is enough.
    socket.onerror = noop;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.handlers.onClose?.();
      if (event.code === CLOSE_UNSUPPORTED_PROTOCOL) {
        this.setStatus("unsupported_protocol");
        return;
      }
      if (event.code === CLOSE_ROOM_REFUSED) {
        this.setStatus("refused");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.setStatus("waiting");
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  /** Detaches and closes the current socket. Returns whether there was one. */
  private dropSocket(code: number): boolean {
    const socket = this.socket;
    if (!socket) return false;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = noop; // a stray late "error" must not become an unhandled one
    try {
      socket.close(code);
    } catch {
      // already closed
    }
    return true;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: SocketStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }
}

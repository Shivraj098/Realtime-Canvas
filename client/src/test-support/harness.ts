import WebSocket from "ws";
import {
  applyOps,
  type RoomState,
  type ShapeChanges,
  type ShapeFields,
  type ShapeKind,
} from "@realtime-canvas/shared";
import { createServer, type ServerHandle, type ServerOptions } from "@realtime-canvas/server";
import { RoomClient, type RoomClientEvent } from "../room-client";
import type { LocalResult } from "../sync/sync-engine";
import type { WebSocketConstructor } from "../net/types";
import { faultySocketConstructor, NetworkControl } from "./faulty-network";
import { sleep } from "./rng";

export const ROOM = "room1";

export const DEFAULT_FIELDS: ShapeFields = { x: 0, y: 0, width: 20, height: 20, color: "#336699", text: "" };

/** One client wired to the real server through its own fault-injecting network. */
export class TestClient {
  readonly events: RoomClientEvent[] = [];
  /** Every op this client created and had accepted locally. */
  readonly issued: string[] = [];

  constructor(
    readonly name: string,
    readonly client: RoomClient,
    readonly net: NetworkControl,
  ) {
    client.onEvent((event) => this.events.push(event));
  }

  get engine() {
    return this.client.engine;
  }

  create(fields: Partial<ShapeFields> = {}, shapeId?: string, kind: ShapeKind = "rect"): LocalResult {
    return this.track(this.client.createShape(kind, { ...DEFAULT_FIELDS, ...fields }, shapeId));
  }

  update(shapeId: string, changes: ShapeChanges): LocalResult {
    return this.track(this.client.updateShape(shapeId, changes));
  }

  remove(shapeId: string): LocalResult {
    return this.track(this.client.deleteShape(shapeId));
  }

  /** Ids of ops the server refused, as reported to this client. */
  get rejectedOpIds(): string[] {
    return this.events.flatMap((event) => (event.type === "op_rejected" ? [event.opId] : []));
  }

  private track(result: LocalResult): LocalResult {
    if (result.ok) this.issued.push(result.op.opId);
    return result;
  }
}

export type AddClientOptions = {
  /** Random per-message network delay, in ms. Defaults to none. */
  delayMs?: () => number;
  connect?: boolean;
  protocolVersion?: number;
};

/** A real in-process server plus helpers to attach clients to it. */
export class Harness {
  readonly clients: TestClient[] = [];

  private constructor(readonly server: ServerHandle) {}

  /** Starts a real server on a free port. `options` override its defaults, for tests of limits. */
  static start(options: Partial<ServerOptions> = {}): Harness {
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    return new Harness(createServer({ port: 0, dbPath: ":memory:", logger: quiet, ...options }));
  }

  get opLog() {
    return this.server.opLog;
  }

  addClient(name: string, options: AddClientOptions = {}): TestClient {
    const net = new NetworkControl(options.delayMs);
    const WebSocketCtor: WebSocketConstructor = faultySocketConstructor(
      net,
      WebSocket as unknown as Parameters<typeof faultySocketConstructor>[1],
    );
    const client = new RoomClient({
      url: `ws://localhost:${this.server.port}`,
      roomId: ROOM,
      clientId: name,
      WebSocket: WebSocketCtor,
      // Real timers, scaled down so a reconnect takes milliseconds, not seconds.
      backoff: { baseMs: 2, maxMs: 20, jitter: 0.3 },
      flushBatchSize: 50,
      flushIntervalMs: 5,
      retryDelayMs: 20,
      ...(options.protocolVersion !== undefined && { protocolVersion: options.protocolVersion }),
    });
    const testClient = new TestClient(name, client, net);
    this.clients.push(testClient);
    if (options.connect !== false) client.connect();
    return testClient;
  }

  /** The authoritative state: the server's log folded through the shared reducer. */
  serverState(): RoomState {
    return applyOps(
      {},
      this.opLog.since(ROOM, 0).map((stored) => stored.op),
    );
  }

  /** Polls until `predicate` holds. Condition-based, so it is as fast as the system allows. */
  async waitUntil(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await sleep(2);
    }
  }

  /** Waits until every client is online, has nothing unacknowledged, and has applied the whole log. */
  async settle(timeoutMs = 15_000): Promise<void> {
    await this.waitUntil(
      () =>
        this.clients.every(
          (c) =>
            c.client.getStatus() === "open" &&
            c.engine.getPending().length === 0 &&
            c.engine.getLastSeq() === this.opLog.latestSeq(ROOM),
        ),
      `all clients to settle (${this.describe()})`,
      timeoutMs,
    );
  }

  describe(): string {
    return this.clients
      .map(
        (c) =>
          `${c.name}: ${c.client.getStatus()}, pending ${c.engine.getPending().length}, seq ${c.engine.getLastSeq()}/${this.opLog.latestSeq(ROOM)}, net ${c.net.mode}`,
      )
      .join("; ");
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.client.disconnect();
    await this.server.close();
  }
}

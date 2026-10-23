import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  applyOps,
  CLOSE_UNSUPPORTED_PROTOCOL,
  liveShapes,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Op,
  type ServerMessage,
} from "@realtime-canvas/shared";
import { createServer, type ServerHandle, type ServerOptions } from "./app";

/**
 * Integration tests: a real WebSocketServer (port 0 = an OS-assigned free
 * port) with real `ws` clients and a real SQLite op log. Unit tests prove
 * each piece in isolation; these prove the pieces behave correctly when
 * wired together over an actual socket, which is where ordering, identity,
 * and lifecycle bugs live.
 *
 * To assert that something was *ignored* without sleeping, tests follow
 * the bad input with a valid "probe" op and check the probe got the first
 * sequence number. The server handles one connection's frames in order,
 * so if the bad frame had been persisted, the probe's seq would be higher.
 */

type MessageOfType<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** Buffers every message a socket receives so none can be missed between "send" and "wait". */
class Inbox {
  private readonly received: ServerMessage[] = [];
  private readonly watchers = new Set<() => void>();

  constructor(socket: WebSocket) {
    socket.on("message", (data: Buffer) => {
      this.received.push(JSON.parse(data.toString()) as ServerMessage);
      for (const watcher of [...this.watchers]) watcher();
    });
  }

  /** Consumes and returns the oldest unread message of the given type. */
  next<T extends ServerMessage["type"]>(type: T, timeoutMs = 2000): Promise<MessageOfType<T>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.watchers.delete(attempt);
        reject(new Error(`Timed out waiting for a "${type}" message`));
      }, timeoutMs);

      const attempt = (): void => {
        const index = this.received.findIndex((message) => message.type === type);
        if (index === -1) return;
        const [message] = this.received.splice(index, 1);
        clearTimeout(timer);
        this.watchers.delete(attempt);
        resolve(message as MessageOfType<T>);
      };

      this.watchers.add(attempt);
      attempt();
    });
  }

  /** Number of unread messages of a type currently buffered. */
  pending(type: ServerMessage["type"]): number {
    return this.received.filter((message) => message.type === type).length;
  }
}

type Connection = { socket: WebSocket; inbox: Inbox };

const servers: ServerHandle[] = [];
const sockets: WebSocket[] = [];
const tempDirs: string[] = [];

function quietLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function startServer(overrides: Partial<ServerOptions> = {}): ServerHandle {
  const server = createServer({ port: 0, dbPath: ":memory:", logger: quietLogger(), ...overrides });
  servers.push(server);
  return server;
}

function connect(server: ServerHandle): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${server.port}`);
    sockets.push(socket);
    // Servers may legitimately kill connections in these tests; an
    // unhandled client "error" event must not fail the run.
    socket.on("error", () => {});
    socket.once("open", () => resolve({ socket, inbox: new Inbox(socket) }));
    socket.once("error", reject);
  });
}

function send(connection: Connection, message: ClientMessage): void {
  connection.socket.send(JSON.stringify(message));
}

async function joinRoom(
  server: ServerHandle,
  roomId: string,
  clientId: string,
  sinceSeq = 0,
): Promise<Connection> {
  const connection = await connect(server);
  send(connection, { type: "join_room", protocolVersion: PROTOCOL_VERSION, roomId, clientId, sinceSeq });
  return connection;
}

/** Joins fresh and waits for the snapshot, so later assertions start from a known point. */
async function joinFresh(server: ServerHandle, roomId: string, clientId: string): Promise<Connection> {
  const connection = await joinRoom(server, roomId, clientId);
  await connection.inbox.next("sync_snapshot");
  return connection;
}

/** Sends something that is deliberately not a valid ClientMessage. */
function sendRaw(connection: Connection, value: unknown): void {
  connection.socket.send(JSON.stringify(value));
}

function deleteShape(shapeId: string, opId = `del-${shapeId}`): ClientMessage {
  return { type: "delete_shape", shapeId, roomId: "room1", hlc: claimedHlc(), opId };
}

function claimedHlc(physical = Date.now(), nodeId = "client") {
  return { physical, logical: 0, nodeId };
}

function createShape(shapeId: string, roomId = "room1", opId = `op-${shapeId}`): ClientMessage {
  return {
    type: "create_shape",
    shapeId,
    roomId,
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000000" },
    hlc: claimedHlc(),
    opId,
  };
}

function updateX(shapeId: string, value: number, opId: string, nodeId = "client"): ClientMessage {
  return {
    type: "update_shape",
    shapeId,
    roomId: "room1",
    changes: { x: value },
    hlc: claimedHlc(Date.now(), nodeId),
    opId,
  };
}

/**
 * The create op as a client would hold it. For convergence checks only its
 * presence matters, so an old timestamp is fine: any later update wins over it.
 */
function createShapeAsOp(): Op {
  return {
    type: "create_shape",
    shapeId: "shape1",
    roomId: "room1",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000000" },
    hlc: { physical: 1, logical: 0, nodeId: "server" },
    opId: "op-shape1",
  };
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve(1006);
    socket.once("close", (code) => resolve(code));
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("joining a room", () => {
  it("sends an empty snapshot to the first client in a fresh room", async () => {
    const server = startServer();
    const client = await joinRoom(server, "room1", "clientA");
    const snapshot = await client.inbox.next("sync_snapshot");
    expect(snapshot).toMatchObject({ roomId: "room1", shapes: {}, latestSeq: 0 });
  });

  it("sends the current shapes to a client that joins after edits were made", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");

    const clientB = await joinRoom(server, "room1", "clientB");
    const snapshot = await clientB.inbox.next("sync_snapshot");
    expect(Object.keys(snapshot.shapes)).toEqual(["shape1"]);
    expect(snapshot.latestSeq).toBe(1);
  });

  it("broadcasts presence to everyone when a client joins and when one leaves", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    await clientA.inbox.next("presence"); // A's own join

    const clientB = await joinFresh(server, "room1", "clientB");
    const afterJoin = await clientA.inbox.next("presence");
    expect(afterJoin.clients.map((c) => c.clientId).sort()).toEqual(["clientA", "clientB"]);

    clientB.socket.close();
    const afterLeave = await clientA.inbox.next("presence");
    expect(afterLeave.clients.map((c) => c.clientId)).toEqual(["clientA"]);
  });

  it("ignores a second join_room on the same connection", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, {
      type: "join_room",
      protocolVersion: PROTOCOL_VERSION,
      roomId: "room2",
      clientId: "clientA",
      sinceSeq: 0,
    });
    send(client, createShape("shape1"));

    const ack = await client.inbox.next("op_ack");
    expect(ack.op.roomId).toBe("room1"); // still in the original room
    expect(client.inbox.pending("sync_snapshot")).toBe(0); // no second snapshot
    expect((await client.inbox.next("error")).code).toBe("already_joined");
  });
});

describe("shape ops", () => {
  it("broadcasts the acknowledged op to every client in the room, including the sender", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");

    send(clientA, createShape("shape1"));

    const ackA = await clientA.inbox.next("op_ack");
    const ackB = await clientB.inbox.next("op_ack");
    expect(ackA.seq).toBe(1);
    expect(ackB.seq).toBe(1);
    expect(ackA.op).toEqual(ackB.op);
  });

  it("re-stamps ops with the server's clock instead of trusting the client's timestamp", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    const bogus = { physical: 1, logical: 0, nodeId: "client" };

    send(client, { ...createShape("shape1"), hlc: bogus } as ClientMessage);

    const ack = await client.inbox.next("op_ack");
    expect(ack.op.hlc.nodeId).toBe("server");
    expect(ack.op.hlc.physical).toBeGreaterThan(bogus.physical);
  });

  it("keeps rooms isolated from each other", async () => {
    const server = startServer();
    const inRoom1 = await joinFresh(server, "room1", "clientA");
    const inRoom2 = await joinFresh(server, "room2", "clientB");

    send(inRoom1, createShape("shape1"));
    await inRoom1.inbox.next("op_ack");
    send(inRoom2, createShape("probe", "room2"));
    const probeAck = await inRoom2.inbox.next("op_ack");

    expect(probeAck.seq).toBe(1); // room2's first op; room1's op never reached it
    expect(inRoom2.inbox.pending("op_ack")).toBe(0);
  });

  it("overwrites a spoofed roomId in the payload with the room the connection actually joined", async () => {
    const server = startServer();
    const attacker = await joinFresh(server, "room1", "attacker");
    const victim = await joinFresh(server, "victim-room", "victim");

    send(attacker, createShape("shape1", "victim-room"));
    const ack = await attacker.inbox.next("op_ack");
    expect(ack.op.roomId).toBe("room1");

    send(victim, createShape("probe", "victim-room"));
    const probeAck = await victim.inbox.next("op_ack");
    expect(probeAck.seq).toBe(1); // the spoofed op never landed in victim-room
  });
});

describe("conflict resolution", () => {
  it("converges: two clients racing to edit the same field end in identical state, matching the server's", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");

    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    // Both write the same field "simultaneously".
    send(clientA, updateX("shape1", 111, "update-from-A", "clientA"));
    send(clientB, updateX("shape1", 222, "update-from-B", "clientB"));

    const collect = async (client: Connection): Promise<Op[]> => [
      (await client.inbox.next("op_ack")).op,
      (await client.inbox.next("op_ack")).op,
    ];
    const [opsSeenByA, opsSeenByB] = await Promise.all([collect(clientA), collect(clientB)]);

    // Each client applies what it received with the shared reconcile logic.
    const createOp = createShapeAsOp();
    const stateA = applyOps({}, [createOp, ...opsSeenByA]);
    const stateB = applyOps({}, [createOp, ...opsSeenByB]);
    expect(stateA).toEqual(stateB);

    // And a brand-new client, handed the server's snapshot, agrees too.
    const late = await joinRoom(server, "room1", "clientC");
    const snapshot = await late.inbox.next("sync_snapshot");
    expect(snapshot.shapes.shape1?.x).toBe(stateA.shape1?.x);
    expect([111, 222]).toContain(stateA.shape1?.x);
  });

  it("keeps both edits when two clients change different fields of one shape", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    await clientA.inbox.next("presence");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");

    send(clientA, updateX("shape1", 42, "move"));
    send(clientA, {
      type: "update_shape",
      shapeId: "shape1",
      roomId: "room1",
      changes: { color: "#ff0000" },
      hlc: claimedHlc(),
      opId: "recolor",
    });
    await clientA.inbox.next("op_ack");
    await clientA.inbox.next("op_ack");

    const late = await joinRoom(server, "room1", "clientB");
    const { shapes } = await late.inbox.next("sync_snapshot");
    expect(shapes.shape1).toMatchObject({ x: 42, color: "#ff0000" });
  });
});

describe("reconnect and resync", () => {
  it("replays only the ops a returning client missed, without a fresh snapshot", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    send(clientA, createShape("seen-already"));
    const seen = await clientA.inbox.next("op_ack");
    expect(seen.seq).toBe(1);

    // clientA drops offline while someone else keeps editing.
    clientA.socket.close();
    await waitForClose(clientA.socket);

    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientB, createShape("missed-1"));
    send(clientB, createShape("missed-2"));
    await clientB.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    // clientA returns, saying it has everything up to seq 1.
    const returning = await joinRoom(server, "room1", "clientA", 1);
    const replayed = [await returning.inbox.next("op_ack"), await returning.inbox.next("op_ack")];
    await returning.inbox.next("presence"); // last thing the join handler sends

    expect(replayed.map((ack) => ack.seq)).toEqual([2, 3]);
    expect(returning.inbox.pending("sync_snapshot")).toBe(0);
    expect(returning.inbox.pending("op_ack")).toBe(0); // nothing beyond what it missed
  });

  it("sends a full snapshot when the client claims a sequence the server has never reached", async () => {
    const server = startServer();
    const seeded = await joinFresh(server, "room1", "clientA");
    send(seeded, createShape("shape1"));
    await seeded.inbox.next("op_ack");

    // e.g. the server lost its database and this client is "ahead".
    const ahead = await joinRoom(server, "room1", "clientB", 500);
    const snapshot = await ahead.inbox.next("sync_snapshot");
    expect(Object.keys(snapshot.shapes)).toEqual(["shape1"]);
    expect(snapshot.latestSeq).toBe(1);
  });

  it("does not drop a reconnecting client when its OLD connection closes afterwards", async () => {
    const server = startServer();
    const oldConnection = await joinFresh(server, "room1", "clientA");
    const newConnection = await joinFresh(server, "room1", "clientA"); // same clientId, quick reconnect
    const other = await joinFresh(server, "room1", "clientB");

    // The late "close" of the old socket is the event that used to evict the new one.
    oldConnection.socket.close();
    await waitForClose(oldConnection.socket);

    send(other, createShape("shape1"));
    const ack = await newConnection.inbox.next("op_ack");
    expect(ack.op).toMatchObject({ type: "create_shape", shapeId: "shape1" });
  });

  it("restores room state and sequence numbers after a full server restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realtime-canvas-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "ops.sqlite");

    const first = startServer({ dbPath });
    const writer = await joinFresh(first, "room1", "clientA");
    send(writer, createShape("survivor"));
    await writer.inbox.next("op_ack");
    await first.close();
    servers.splice(servers.indexOf(first), 1);

    const second = startServer({ dbPath });
    const reader = await joinRoom(second, "room1", "clientB");
    const snapshot = await reader.inbox.next("sync_snapshot");
    expect(Object.keys(snapshot.shapes)).toEqual(["survivor"]);
    expect(snapshot.latestSeq).toBe(1);

    send(reader, createShape("after-restart"));
    expect((await reader.inbox.next("op_ack")).seq).toBe(2); // sequence continues, no reuse
  });
});

describe("idempotent ops", () => {
  it("applies a retried op only once", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");

    send(client, createShape("shape1", "room1", "retry-me"));
    send(client, createShape("shape1", "room1", "retry-me")); // the retry
    send(client, createShape("probe"));

    const first = await client.inbox.next("op_ack");
    const retryAck = await client.inbox.next("op_ack");
    const probe = await client.inbox.next("op_ack");
    expect(first.seq).toBe(1);
    expect(retryAck).toEqual(first); // the retry is answered with the stored ack
    expect(probe.seq).toBe(2); // the duplicate consumed no sequence number
    expect(client.inbox.pending("op_ack")).toBe(0);
  });

  it("does not let a retried old update overwrite a newer edit from someone else", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");

    send(clientA, updateX("shape1", 1, "a-move", "clientA"));
    await clientA.inbox.next("op_ack");
    send(clientB, updateX("shape1", 2, "b-move", "clientB")); // newer edit by B
    await clientA.inbox.next("op_ack");

    send(clientA, updateX("shape1", 1, "a-move", "clientA")); // A retries its old op
    send(clientA, createShape("probe"));
    expect((await clientA.inbox.next("op_ack")).seq).toBe(2); // the retry is re-acked with its original seq
    const probe = await clientA.inbox.next("op_ack");
    expect(probe.seq).toBe(4); // create, a-move, b-move, probe - the retry added nothing

    const late = await joinRoom(server, "room1", "clientC");
    const { shapes } = await late.inbox.next("sync_snapshot");
    expect(shapes.shape1?.x).toBe(2);
  });
});

describe("cursors", () => {
  it("relays cursor positions to other clients but not back to the sender, never persisting them", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");

    send(clientA, { type: "cursor", roomId: "room1", clientId: "clientA", x: 5, y: 6, color: "#7fd8b0" });
    const cursor = await clientB.inbox.next("cursor");
    expect(cursor).toMatchObject({ clientId: "clientA", x: 5, y: 6 });

    send(clientA, createShape("probe"));
    const probe = await clientA.inbox.next("op_ack");
    expect(probe.seq).toBe(1); // cursor traffic did not touch the op log
    expect(clientA.inbox.pending("cursor")).toBe(0);
  });

  it("stamps the sender's real identity on a cursor instead of trusting the payload", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");

    send(clientA, { type: "cursor", roomId: "room1", clientId: "clientB", x: 1, y: 1, color: "#7fd8b0" });
    const cursor = await clientB.inbox.next("cursor");
    expect(cursor.clientId).toBe("clientA");
  });
});

describe("hostile and malformed input", () => {
  it("survives garbage frames and keeps serving the same connection", async () => {
    const logger = quietLogger();
    const server = startServer({ logger });
    const client = await joinFresh(server, "room1", "clientA");

    client.socket.send("this is not json");
    client.socket.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true });
    client.socket.send(JSON.stringify({ type: "create_shape", shapeId: "no-hlc-no-fields" }));
    client.socket.send(JSON.stringify({ type: "drop_database" }));
    send(client, createShape("probe"));

    const ack = await client.inbox.next("op_ack");
    expect(ack.seq).toBe(1); // none of the bad frames were persisted
    expect(logger.warn).toHaveBeenCalledTimes(4);
    expect(logger.error).not.toHaveBeenCalled();
    // The sender is told, rather than left guessing: one error per bad frame.
    expect(client.inbox.pending("error")).toBe(4);
  });

  it("deliberately ignores ops and cursors sent before joining a room", async () => {
    const logger = quietLogger();
    const server = startServer({ logger });
    const client = await connect(server);

    send(client, createShape("too-early"));
    send(client, { type: "cursor", roomId: "room1", clientId: "x", x: 1, y: 1, color: "#fff" });
    send(client, {
      type: "join_room",
      protocolVersion: PROTOCOL_VERSION,
      roomId: "room1",
      clientId: "clientA",
      sinceSeq: 0,
    });
    await client.inbox.next("sync_snapshot");
    expect(await client.inbox.next("op_reject")).toEqual({
      type: "op_reject",
      opId: "op-too-early",
      reason: "not_joined",
    });
    expect((await client.inbox.next("error")).code).toBe("not_joined");
    send(client, createShape("probe"));

    expect((await client.inbox.next("op_ack")).seq).toBe(1);
    // Handled on purpose (a warning), not a crash that the catch-all swallowed (an error).
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("survives an unexpected internal failure while handling one frame, and keeps serving", async () => {
    const logger = quietLogger();
    const server = startServer({ logger });
    const client = await joinFresh(server, "room1", "clientA");

    // Simulate the op log failing once (disk full, I/O error...).
    vi.spyOn(server.opLog, "append").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    send(client, createShape("doomed"));
    send(client, createShape("probe"));

    const ack = await client.inbox.next("op_ack");
    expect(ack.op).toMatchObject({ shapeId: "probe" }); // the failed op was never acknowledged
    expect(ack.seq).toBe(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("closes a connection that sends an oversized frame, and keeps serving everyone else", async () => {
    const server = startServer({ maxPayloadBytes: 1024 });
    const offender = await connect(server);
    const closed = waitForClose(offender.socket);

    offender.socket.send("x".repeat(4096));
    expect(await closed).toBe(1009); // "message too big"

    const healthy = await joinFresh(server, "room1", "clientA");
    send(healthy, createShape("probe"));
    expect((await healthy.inbox.next("op_ack")).seq).toBe(1);
  });
});

describe("clock drift protection", () => {
  it("ignores a client timestamp far in the future so it cannot poison the server clock", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    const tenYearsAhead = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;

    send(client, { ...createShape("shape1"), hlc: claimedHlc(tenYearsAhead) } as ClientMessage);
    const ack = await client.inbox.next("op_ack");

    expect(ack.op.hlc.physical).toBeLessThan(Date.now() + 5_000);

    // ...and the server clock stayed sane for the next, honest op.
    send(client, createShape("next"));
    const next = await client.inbox.next("op_ack");
    expect(next.op.hlc.physical).toBeLessThan(Date.now() + 5_000);
  });

  it("still honors a claimed timestamp that is only slightly ahead (ordinary clock skew)", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    const slightlyAhead = Date.now() + 5_000;

    send(client, { ...createShape("shape1"), hlc: claimedHlc(slightlyAhead) } as ClientMessage);
    const ack = await client.inbox.next("op_ack");

    expect(ack.op.hlc.physical).toBeGreaterThanOrEqual(slightlyAhead);
  });
});

describe("retries of ops the server already has", () => {
  it("re-acknowledges a retry to the sender only, with the original sequence number and stamped op", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");

    send(clientA, createShape("shape1", "room1", "op-x"));
    const original = await clientA.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    send(clientA, createShape("shape1", "room1", "op-x")); // retry
    const retryAck = await clientA.inbox.next("op_ack");
    expect(retryAck).toEqual(original);

    // B must not hear about the retry: its next ack is the probe's.
    send(clientA, createShape("probe"));
    expect((await clientB.inbox.next("op_ack")).seq).toBe(2);
    expect(clientB.inbox.pending("op_ack")).toBe(0);
  });

  it("recognises a retried create as a retry instead of refusing it as shape_exists", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("shape1", "room1", "op-x"));
    await client.inbox.next("op_ack");

    send(client, createShape("shape1", "room1", "op-x"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
    expect(client.inbox.pending("op_reject")).toBe(0);
  });

  it("still re-acknowledges a retried create after the shape has since been deleted", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("shape1", "room1", "op-x"));
    await client.inbox.next("op_ack");
    send(client, deleteShape("shape1"));
    await client.inbox.next("op_ack");

    send(client, createShape("shape1", "room1", "op-x"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
    expect(client.inbox.pending("op_reject")).toBe(0);
  });
});

describe("rejected ops", () => {
  it("rejects an update to a shape that does not exist, persisting nothing", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");

    send(client, updateX("ghost", 5, "update-ghost"));
    expect(await client.inbox.next("op_reject")).toEqual({
      type: "op_reject",
      opId: "update-ghost",
      reason: "unknown_shape",
    });

    send(client, createShape("probe"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
  });

  it("rejects a delete of a shape that does not exist", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, deleteShape("ghost", "delete-ghost"));
    expect(await client.inbox.next("op_reject")).toMatchObject({
      opId: "delete-ghost",
      reason: "unknown_shape",
    });
  });

  it("rejects a create for a shapeId that already exists, leaving the shape unchanged", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("shape1", "room1", "first"));
    await client.inbox.next("op_ack");

    send(client, {
      ...createShape("shape1", "room1", "second"),
      fields: { x: 99, y: 99, width: 1, height: 1, color: "#111111" },
    } as ClientMessage);
    expect(await client.inbox.next("op_reject")).toMatchObject({ opId: "second", reason: "shape_exists" });

    const late = await joinRoom(server, "room1", "clientB");
    const { shapes, latestSeq } = await late.inbox.next("sync_snapshot");
    expect(latestSeq).toBe(1);
    expect(shapes.shape1?.x).toBe(0);
  });

  it("rejects an update to a deleted shape, and a second delete of it", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("shape1"));
    await client.inbox.next("op_ack");
    send(client, deleteShape("shape1", "delete-1"));
    await client.inbox.next("op_ack");

    send(client, updateX("shape1", 5, "late-update"));
    send(client, deleteShape("shape1", "delete-2"));
    expect(await client.inbox.next("op_reject")).toMatchObject({
      opId: "late-update",
      reason: "unknown_shape",
    });
    expect(await client.inbox.next("op_reject")).toMatchObject({ opId: "delete-2", reason: "unknown_shape" });
  });

  it("refuses to reuse the id of a deleted shape", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("shape1", "room1", "create-1"));
    await client.inbox.next("op_ack");
    send(client, deleteShape("shape1"));
    await client.inbox.next("op_ack");

    send(client, createShape("shape1", "room1", "create-2"));
    expect(await client.inbox.next("op_reject")).toMatchObject({ opId: "create-2", reason: "shape_exists" });
  });

  it("tells only the sender about a rejection", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");

    send(clientA, updateX("ghost", 5, "update-ghost"));
    await clientA.inbox.next("op_reject");
    send(clientA, createShape("probe"));
    expect((await clientB.inbox.next("op_ack")).seq).toBe(1);
    expect(clientB.inbox.pending("op_reject")).toBe(0);
  });
});

describe("deleting shapes", () => {
  it("broadcasts the delete, and keeps a tombstone that a late joiner receives", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    send(clientA, deleteShape("shape1"));
    expect((await clientB.inbox.next("op_ack")).op.type).toBe("delete_shape");

    const late = await joinRoom(server, "room1", "clientC");
    const { shapes } = await late.inbox.next("sync_snapshot");
    expect(shapes.shape1?.deletedAt).toBeDefined();
    expect(liveShapes(shapes)).toEqual({});
  });

  it("brings a returning client to the same state by replay as a fresh client gets by snapshot", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    send(clientA, createShape("shape1"));
    const created = await clientA.inbox.next("op_ack");
    clientA.socket.close();
    await waitForClose(clientA.socket);

    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientB, deleteShape("shape1"));
    await clientB.inbox.next("op_ack");

    const returning = await joinRoom(server, "room1", "clientA", created.seq);
    const replayed = await returning.inbox.next("op_ack");
    const replayedState = applyOps({}, [created.op, replayed.op]);

    const fresh = await joinRoom(server, "room1", "clientC");
    const { shapes } = await fresh.inbox.next("sync_snapshot");
    expect(liveShapes(replayedState)).toEqual(liveShapes(shapes));
    expect(liveShapes(shapes)).toEqual({});
  });

  it.each(["constructor", "toString", "__proto__"])(
    "handles a shape whose id is %s, which collides with an Object.prototype member",
    async (shapeId) => {
      const server = startServer();
      const client = await joinFresh(server, "room1", "clientA");

      send(client, createShape(shapeId));
      expect((await client.inbox.next("op_ack")).op).toMatchObject({ shapeId });
      send(client, updateX(shapeId, 7, "move"));
      await client.inbox.next("op_ack");

      const late = await joinRoom(server, "room1", "clientB");
      const { shapes } = await late.inbox.next("sync_snapshot");
      expect(Object.keys(shapes)).toEqual([shapeId]);
      expect(Object.getOwnPropertyDescriptor(shapes, shapeId)?.value).toMatchObject({ x: 7 });
    },
  );
});

describe("multi-field updates", () => {
  it("applies several fields as one op: one sequence number, one broadcast, one timestamp", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    send(clientA, {
      type: "update_shape",
      shapeId: "shape1",
      roomId: "room1",
      changes: { x: 40, y: 50 },
      hlc: claimedHlc(),
      opId: "drag-1",
    });
    const ack = await clientB.inbox.next("op_ack");
    expect(ack.seq).toBe(2);
    expect(ack.op).toMatchObject({ opId: "drag-1", changes: { x: 40, y: 50 } });

    const late = await joinRoom(server, "room1", "clientC");
    const { shapes, latestSeq } = await late.inbox.next("sync_snapshot");
    expect(latestSeq).toBe(2); // the whole move cost one log entry
    expect(shapes.shape1).toMatchObject({ x: 40, y: 50 });
    expect(shapes.shape1?.lastHlc.x).toEqual(shapes.shape1?.lastHlc.y);
  });
});

describe("drag previews", () => {
  const preview = (shapeId: string, x: number, clientId = "clientA", roomId = "room1"): ClientMessage => ({
    type: "drag_preview",
    roomId,
    clientId,
    shapeId,
    changes: { x, y: x },
  });

  it("relays a preview to other clients but not back to the sender, never persisting it", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    send(clientA, preview("shape1", 33));
    expect(await clientB.inbox.next("drag_preview")).toMatchObject({
      shapeId: "shape1",
      clientId: "clientA",
      changes: { x: 33, y: 33 },
    });

    send(clientA, updateX("shape1", 1, "commit"));
    expect((await clientA.inbox.next("op_ack")).seq).toBe(2); // the preview consumed no sequence number
    expect(clientA.inbox.pending("drag_preview")).toBe(0);
  });

  it("stamps the sender's real identity and room instead of trusting the payload", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");
    const outsider = await joinFresh(server, "other-room", "clientC");
    send(clientA, createShape("shape1"));
    await clientA.inbox.next("op_ack");
    await clientB.inbox.next("op_ack");

    send(clientA, preview("shape1", 5, "clientB", "other-room"));
    const relayed = await clientB.inbox.next("drag_preview");
    expect(relayed).toMatchObject({ clientId: "clientA", roomId: "room1" });

    send(outsider, createShape("probe", "other-room"));
    await outsider.inbox.next("op_ack");
    expect(outsider.inbox.pending("drag_preview")).toBe(0); // never leaked into the room named in the payload
  });

  it("quietly drops a preview for a shape that does not exist or has been deleted", async () => {
    const server = startServer();
    const clientA = await joinFresh(server, "room1", "clientA");
    const clientB = await joinFresh(server, "room1", "clientB");
    send(clientA, createShape("real"));
    send(clientA, createShape("gone"));
    send(clientA, deleteShape("gone"));
    for (let i = 0; i < 3; i++) await clientA.inbox.next("op_ack");

    send(clientA, preview("ghost", 1));
    send(clientA, preview("gone", 2));
    send(clientA, preview("real", 3));

    expect((await clientB.inbox.next("drag_preview")).shapeId).toBe("real");
    expect(clientB.inbox.pending("drag_preview")).toBe(0);
    expect(clientA.inbox.pending("error")).toBe(0); // dropped without an error per frame
  });

  it("answers a preview sent before joining with a not_joined error", async () => {
    const server = startServer();
    const client = await connect(server);
    send(client, preview("shape1", 1));
    expect((await client.inbox.next("error")).code).toBe("not_joined");
  });
});

describe("telling the client what went wrong", () => {
  it("rejects an invalid op by opId so the client can drop it from its pending queue", async () => {
    const logger = quietLogger();
    const server = startServer({ logger });
    const client = await joinFresh(server, "room1", "clientA");

    sendRaw(client, { type: "create_shape", shapeId: "s1", opId: "bad-op" }); // no hlc, no fields
    expect(await client.inbox.next("op_reject")).toEqual({
      type: "op_reject",
      opId: "bad-op",
      reason: "invalid",
    });
    expect(client.inbox.pending("error")).toBe(0);
  });

  it("answers a message that is not a recognisable op with a connection-level error", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");

    sendRaw(client, { type: "drop_database" });
    const error = await client.inbox.next("error");
    expect(error.code).toBe("invalid_message");
    expect(error.message.length).toBeGreaterThan(0);
    expect(client.inbox.pending("op_reject")).toBe(0);
  });

  it("refuses a join from an unsupported protocol version, tells the client why, and closes with a distinct code", async () => {
    const server = startServer();
    const existing = await joinFresh(server, "room1", "clientA");
    await existing.inbox.next("presence");

    const outdated = await connect(server);
    const closed = waitForClose(outdated.socket);
    sendRaw(outdated, {
      type: "join_room",
      protocolVersion: PROTOCOL_VERSION + 1,
      roomId: "room1",
      clientId: "clientB",
      sinceSeq: 0,
    });

    expect((await outdated.inbox.next("error")).code).toBe("unsupported_protocol");
    expect(await closed).toBe(CLOSE_UNSUPPORTED_PROTOCOL);

    // It never became a member of the room: no presence change, no snapshot.
    send(existing, createShape("probe"));
    await existing.inbox.next("op_ack");
    expect(existing.inbox.pending("presence")).toBe(0);
    expect(outdated.inbox.pending("sync_snapshot")).toBe(0);
  });

  it("refuses a join that carries no protocol version at all", async () => {
    const server = startServer();
    const client = await connect(server);
    sendRaw(client, { type: "join_room", roomId: "room1", clientId: "clientA", sinceSeq: 0 });
    expect((await client.inbox.next("error")).code).toBe("invalid_message");
  });
});

describe("shutdown", () => {
  it("close() resolves promptly even with clients still connected", async () => {
    const server = startServer();
    await joinFresh(server, "room1", "clientA");
    await expect(server.close()).resolves.toBeUndefined();
    servers.splice(servers.indexOf(server), 1);
  });
});

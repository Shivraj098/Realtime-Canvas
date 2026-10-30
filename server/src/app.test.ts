import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  applyOps,
  CLOSE_POLICY_VIOLATION,
  CLOSE_ROOM_REFUSED,
  CLOSE_TRY_AGAIN_LATER,
  CLOSE_UNSUPPORTED_PROTOCOL,
  liveShapes,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Op,
  type ServerMessage,
} from "@realtime-canvas/shared";
import { createServer, type ServerHandle, type ServerOptions } from "./app";
import { OpLog } from "./op-log";

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
    kind: "rect",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000000", text: "" },
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
    kind: "rect",
    fields: { x: 0, y: 0, width: 10, height: 10, color: "#000000", text: "" },
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
      kind: "rect",
      fields: { x: 99, y: 99, width: 1, height: 1, color: "#111111", text: "" },
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

// ---------------------------------------------------------------------------
// Hardening: health, origins, limits, heartbeat, idle rooms and snapshots.
// ---------------------------------------------------------------------------

/** A clock the test controls, for rate limits and idle tracking. */
function controllableClock(start = 1_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

/** Polls until a condition holds. Used for things the server does on its own schedule. */
async function until(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

type Attempt = { opened: true; connection: Connection } | { opened: false; status: number };

/** Opens a WebSocket with an optional Origin and reports whether the server let it in. */
function attemptConnect(server: ServerHandle, origin?: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://localhost:${server.port}`, origin ? { origin } : undefined);
    sockets.push(socket);
    socket.on("error", () => {});
    socket.once("open", () => resolve({ opened: true, connection: { socket, inbox: new Inbox(socket) } }));
    socket.once("unexpected-response", (_request, response) =>
      resolve({ opened: false, status: response.statusCode ?? 0 }),
    );
  });
}

/** Joins and reports how the server closed the connection, for joins that are refused. */
async function joinAndExpectClose(
  server: ServerHandle,
  roomId: string,
  clientId = "someone",
): Promise<{ connection: Connection; closeCode: number }> {
  const connection = await connect(server);
  const closed = waitForClose(connection.socket);
  send(connection, { type: "join_room", protocolVersion: PROTOCOL_VERSION, roomId, clientId, sinceSeq: 0 });
  return { connection, closeCode: await closed };
}

async function healthOf(server: ServerHandle, init?: RequestInit): Promise<Response> {
  return fetch(`http://localhost:${server.port}/health`, init);
}

describe("health check", () => {
  it("answers 200 with counts and no room ids", async () => {
    const server = startServer();
    await joinFresh(server, "a-secret-room-id", "clientA");

    const response = await healthOf(server);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", rooms: 1, connections: 1 });
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(JSON.stringify(body)).not.toContain("a-secret-room-id");
  });

  it("answers HEAD without a body", async () => {
    const server = startServer();
    const response = await healthOf(server, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("answers 404 for other paths and for methods it does not serve", async () => {
    const server = startServer();
    expect((await fetch(`http://localhost:${server.port}/rooms`)).status).toBe(404);
    expect((await healthOf(server, { method: "POST" })).status).toBe(404);
    expect((await fetch(`http://localhost:${server.port}/health/extra`)).status).toBe(404);
  });

  it("identifies the service at the root", async () => {
    const server = startServer();
    const response = await fetch(`http://localhost:${server.port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("realtime-canvas");
  });

  it("reports 503, and says so in the log, when the database cannot be read", async () => {
    const logger = quietLogger();
    const server = startServer({ logger });
    server.opLog.close();
    const response = await healthOf(server);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("works alongside WebSocket traffic on the same port", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    expect((await healthOf(server)).status).toBe(200);
    send(client, createShape("shape1"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
  });
});

describe("origin check", () => {
  it("lets any origin in when no list is configured", async () => {
    const server = startServer();
    expect((await attemptConnect(server, "https://anything.example")).opened).toBe(true);
    expect((await attemptConnect(server)).opened).toBe(true);
  });

  it("lets a listed origin in and turns every other one away with 403", async () => {
    const logger = quietLogger();
    const server = startServer({ allowedOrigins: ["https://app.example.com"], logger });

    expect((await attemptConnect(server, "https://app.example.com")).opened).toBe(true);
    expect(await attemptConnect(server, "https://evil.example.net")).toEqual({ opened: false, status: 403 });
    expect(await attemptConnect(server, "https://app.example.com.evil.net")).toEqual({
      opened: false,
      status: 403,
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it("turns away a connection with no Origin header at all once a list is configured", async () => {
    const server = startServer({ allowedOrigins: ["https://app.example.com"] });
    expect(await attemptConnect(server)).toEqual({ opened: false, status: 403 });
  });

  it("supports wildcard subdomains", async () => {
    const server = startServer({ allowedOrigins: ["https://*.example.com"] });
    expect((await attemptConnect(server, "https://preview-1.example.com")).opened).toBe(true);
    expect(await attemptConnect(server, "https://example.com")).toEqual({ opened: false, status: 403 });
  });

  it("serves plain HTTP regardless of origin: the health check is for the platform, not a browser", async () => {
    const server = startServer({ allowedOrigins: ["https://app.example.com"] });
    expect((await healthOf(server, { headers: { Origin: "https://evil.example.net" } })).status).toBe(200);
  });

  it("a refused connection costs the server nothing: no room, no client", async () => {
    const server = startServer({ allowedOrigins: ["https://app.example.com"] });
    await attemptConnect(server, "https://evil.example.net");
    expect(server.stats()).toMatchObject({ rooms: 0, connections: 0 });
  });
});

describe("connection limit", () => {
  it("turns away connections beyond the limit with 503, and accepts again once one leaves", async () => {
    const server = startServer({ limits: { maxConnections: 2 } });
    const first = await attemptConnect(server);
    const second = await attemptConnect(server);
    expect([first.opened, second.opened]).toEqual([true, true]);
    expect(await attemptConnect(server)).toEqual({ opened: false, status: 503 });

    if (first.opened) first.connection.socket.close();
    await until(() => server.stats().connections === 1, "a connection to leave");
    expect((await attemptConnect(server)).opened).toBe(true);
  });
});

describe("heartbeat", () => {
  it("keeps a connection that answers pings", async () => {
    const server = startServer({ heartbeatIntervalMs: 20 });
    const { socket } = await connect(server);
    let pings = 0;
    socket.on("ping", () => (pings += 1));
    await until(() => pings >= 4, "four pings");
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("drops a connection that stops answering, and removes it from its room", async () => {
    const server = startServer({ heartbeatIntervalMs: 20 });
    const stayer = await joinFresh(server, "room1", "stayer");
    await stayer.inbox.next("presence");

    // A peer that is alive as far as TCP knows but never answers pings (a dead phone, a dropped route).
    const silent = new WebSocket(`ws://localhost:${server.port}`, { autoPong: false });
    sockets.push(silent);
    silent.on("error", () => {});
    await new Promise<void>((resolve) => silent.once("open", () => resolve()));
    silent.send(
      JSON.stringify({
        type: "join_room",
        protocolVersion: PROTOCOL_VERSION,
        roomId: "room1",
        clientId: "ghost",
        sinceSeq: 0,
      }),
    );
    const joined = await stayer.inbox.next("presence");
    expect(joined.clients.map((c) => c.clientId).sort()).toEqual(["ghost", "stayer"]);

    await waitForClose(silent);
    const afterwards = await stayer.inbox.next("presence");
    expect(afterwards.clients.map((c) => c.clientId)).toEqual(["stayer"]);
  });

  it("can be turned off", async () => {
    const server = startServer({ heartbeatIntervalMs: 0 });
    const { socket } = await connect(server);
    let pings = 0;
    socket.on("ping", () => (pings += 1));
    send({ socket, inbox: new Inbox(socket) }, createShape("probe"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(pings).toBe(0);
  });
});

describe("rate limiting", () => {
  it("lets a burst through, then refuses ops with a rate_limited reject and stores nothing more", async () => {
    const clock = controllableClock();
    const server = startServer({ now: clock.now, limits: { opsBurst: 3, opsPerSecond: 1 } });
    const client = await joinFresh(server, "room1", "clientA");

    for (let i = 1; i <= 5; i++) send(client, createShape(`s${i}`));
    for (let i = 0; i < 3; i++) await client.inbox.next("op_ack");
    const rejects = [await client.inbox.next("op_reject"), await client.inbox.next("op_reject")];
    expect(rejects.map((r) => r.reason)).toEqual(["rate_limited", "rate_limited"]);
    expect(rejects.map((r) => r.opId)).toEqual(["op-s4", "op-s5"]);
    expect(server.opLog.latestSeq("room1")).toBe(3);
  });

  it("accepts ops again once the allowance has refilled", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { opsBurst: 1, opsPerSecond: 1, violationsBeforeClose: 1000 },
    });
    const client = await joinFresh(server, "room1", "clientA");

    send(client, createShape("s1"));
    await client.inbox.next("op_ack");
    send(client, createShape("s2"));
    expect((await client.inbox.next("op_reject")).reason).toBe("rate_limited");

    clock.advance(1000);
    send(client, createShape("s2", "room1", "op-s2-again"));
    expect((await client.inbox.next("op_ack")).seq).toBe(2);
  });

  it("limits each connection on its own", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { opsBurst: 1, opsPerSecond: 1, violationsBeforeClose: 1000 },
    });
    const noisy = await joinFresh(server, "room1", "noisy");
    const calm = await joinFresh(server, "room1", "calm");

    send(noisy, createShape("n1"));
    send(noisy, createShape("n2"));
    await noisy.inbox.next("op_reject");
    send(calm, createShape("c1"));

    // Acks go to the whole room, so calm also sees noisy's accepted op; its own must be accepted too.
    const acked = [(await calm.inbox.next("op_ack")).op, (await calm.inbox.next("op_ack")).op].map(
      (op) => op.shapeId,
    );
    expect(acked.sort()).toEqual(["c1", "n1"]);
    expect(calm.inbox.pending("op_reject")).toBe(0);
  });

  it("drops excess cursor traffic without a reply, and keeps the allowed part flowing", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { ephemeralBurst: 2, ephemeralPerSecond: 1, violationsBeforeClose: 1000 },
    });
    const sender = await joinFresh(server, "room1", "sender");
    const watcher = await joinFresh(server, "room1", "watcher");

    for (let i = 0; i < 5; i++) {
      send(sender, { type: "cursor", roomId: "room1", clientId: "x", x: i, y: i, color: "#fff" });
    }
    send(sender, createShape("probe"));
    await watcher.inbox.next("op_ack"); // everything before it has been handled
    expect(watcher.inbox.pending("cursor")).toBe(2);
    expect(sender.inbox.pending("error")).toBe(0);
    expect(sender.inbox.pending("op_reject")).toBe(0);
  });

  it("keeps ephemeral and op allowances separate: a flood of cursors does not block edits", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { ephemeralBurst: 1, ephemeralPerSecond: 1, violationsBeforeClose: 1000 },
    });
    const client = await joinFresh(server, "room1", "clientA");
    for (let i = 0; i < 10; i++) {
      send(client, { type: "cursor", roomId: "room1", clientId: "x", x: i, y: i, color: "#fff" });
    }
    send(client, createShape("s1"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
  });

  it("limits drag previews the same way as cursors", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { ephemeralBurst: 2, ephemeralPerSecond: 1, violationsBeforeClose: 1000 },
    });
    const sender = await joinFresh(server, "room1", "sender");
    const watcher = await joinFresh(server, "room1", "watcher");
    send(sender, createShape("shape1"));
    await watcher.inbox.next("op_ack");

    for (let i = 0; i < 6; i++) {
      send(sender, {
        type: "drag_preview",
        roomId: "room1",
        clientId: "x",
        shapeId: "shape1",
        changes: { x: i },
      });
    }
    send(sender, updateX("shape1", 9, "commit"));
    await watcher.inbox.next("op_ack");
    expect(watcher.inbox.pending("drag_preview")).toBe(2);
  });

  it("closes a connection that keeps breaking the rules, telling it why", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { opsBurst: 1, opsPerSecond: 1, violationsBeforeClose: 3 },
    });
    const client = await joinFresh(server, "room1", "clientA");
    const closed = waitForClose(client.socket);

    for (let i = 0; i < 10; i++) send(client, createShape(`s${i}`));
    expect(await closed).toBe(CLOSE_POLICY_VIOLATION);
    expect((await client.inbox.next("error")).code).toBe("rate_limited");
    expect(server.opLog.latestSeq("room1")).toBe(1);
  });

  it("counts malformed frames as rule-breaking too, so garbage cannot flood the logs forever", async () => {
    const clock = controllableClock();
    const server = startServer({ now: clock.now, limits: { violationsBeforeClose: 3 } });
    const client = await joinFresh(server, "room1", "clientA");
    const closed = waitForClose(client.socket);

    for (let i = 0; i < 8; i++) client.socket.send("{not json");
    expect(await closed).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("forgives occasional mistakes: the allowance recovers with time", async () => {
    const clock = controllableClock();
    const server = startServer({ now: clock.now, limits: { violationsBeforeClose: 3 } });
    const client = await joinFresh(server, "room1", "clientA");

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) client.socket.send("{not json");
      for (let i = 0; i < 3; i++) await client.inbox.next("error");
      clock.advance(10_000);
    }
    send(client, createShape("s1"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("ignores everything a connection sends after it has decided to close it, including cursors", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { opsBurst: 1, opsPerSecond: 1, violationsBeforeClose: 1 },
    });
    const offender = await joinFresh(server, "room1", "offender");
    const watcher = await joinFresh(server, "room1", "watcher");
    const closed = waitForClose(offender.socket);

    // Enough over-limit ops to be cut off, then cursor frames in the same burst, which the
    // (full) ephemeral allowance would happily relay if the connection were still being served.
    for (let i = 0; i < 6; i++) send(offender, createShape(`s${i}`));
    for (let i = 0; i < 5; i++) {
      send(offender, { type: "cursor", roomId: "room1", clientId: "offender", x: i, y: i, color: "#fff" });
    }
    await closed;
    await until(() => server.stats().connections === 1, "the offender to be gone");
    expect(watcher.inbox.pending("cursor")).toBe(0);
  });

  it("stops handling frames from a connection it is closing", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      limits: { opsBurst: 1, opsPerSecond: 1, violationsBeforeClose: 1 },
    });
    const client = await joinFresh(server, "room1", "clientA");
    const closed = waitForClose(client.socket);
    for (let i = 0; i < 20; i++) send(client, createShape(`s${i}`));
    await closed;
    expect(server.opLog.latestSeq("room1")).toBe(1);
  });
});

describe("capacity limits", () => {
  it("refuses new shapes once a room is full, but still allows editing and deleting existing ones", async () => {
    const server = startServer({ limits: { maxShapesPerRoom: 2 } });
    const client = await joinFresh(server, "room1", "clientA");

    send(client, createShape("s1"));
    send(client, createShape("s2"));
    await client.inbox.next("op_ack");
    await client.inbox.next("op_ack");

    send(client, createShape("s3"));
    expect(await client.inbox.next("op_reject")).toMatchObject({ opId: "op-s3", reason: "room_full" });

    send(client, updateX("s1", 5, "move"));
    expect((await client.inbox.next("op_ack")).seq).toBe(3);
    send(client, deleteShape("s2"));
    expect((await client.inbox.next("op_ack")).seq).toBe(4);
  });

  it("counts deleted shapes against the limit, since they stay as tombstones", async () => {
    const server = startServer({ limits: { maxShapesPerRoom: 1 } });
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("s1"));
    await client.inbox.next("op_ack");
    send(client, deleteShape("s1"));
    await client.inbox.next("op_ack");

    send(client, createShape("s2"));
    expect((await client.inbox.next("op_reject")).reason).toBe("room_full");
  });

  it("refuses every op once a room has stored its maximum", async () => {
    const server = startServer({ limits: { maxOpsPerRoom: 2 } });
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("s1"));
    send(client, updateX("s1", 1, "m1"));
    await client.inbox.next("op_ack");
    await client.inbox.next("op_ack");

    send(client, updateX("s1", 2, "m2"));
    send(client, deleteShape("s1"));
    expect((await client.inbox.next("op_reject")).reason).toBe("room_full");
    expect((await client.inbox.next("op_reject")).reason).toBe("room_full");
    expect(server.opLog.latestSeq("room1")).toBe(2);
  });

  it("applies the per-room op limit to each room separately", async () => {
    const server = startServer({ limits: { maxOpsPerRoom: 1 } });
    const a = await joinFresh(server, "roomA", "clientA");
    const b = await joinFresh(server, "roomB", "clientB");
    send(a, createShape("s1", "roomA"));
    send(b, createShape("s1", "roomB"));
    expect((await a.inbox.next("op_ack")).seq).toBe(1);
    expect((await b.inbox.next("op_ack")).seq).toBe(1);
  });

  it("refuses ops with server_full once the whole server has stored its maximum", async () => {
    const server = startServer({ limits: { maxTotalOps: 3 } });
    const a = await joinFresh(server, "roomA", "clientA");
    const b = await joinFresh(server, "roomB", "clientB");
    send(a, createShape("s1", "roomA"));
    send(a, createShape("s2", "roomA"));
    await a.inbox.next("op_ack");
    await a.inbox.next("op_ack");
    send(b, createShape("s1", "roomB"));
    await b.inbox.next("op_ack");

    send(b, createShape("s2", "roomB"));
    expect((await b.inbox.next("op_reject")).reason).toBe("server_full");
    send(a, createShape("s3", "roomA"));
    expect((await a.inbox.next("op_reject")).reason).toBe("server_full");
    expect(server.stats().totalOps).toBe(3);
  });

  it("still answers a retry of an op that is already stored when the room is full", async () => {
    const server = startServer({ limits: { maxOpsPerRoom: 1 } });
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("s1", "room1", "the-op"));
    const original = await client.inbox.next("op_ack");

    send(client, createShape("s1", "room1", "the-op"));
    expect(await client.inbox.next("op_ack")).toEqual(original);
    expect(client.inbox.pending("op_reject")).toBe(0);
  });

  it("turns away a client when the room is full of people, and takes it once someone leaves", async () => {
    const server = startServer({ limits: { maxClientsPerRoom: 2 } });
    const first = await joinFresh(server, "room1", "a");
    await joinFresh(server, "room1", "b");

    const refused = await joinAndExpectClose(server, "room1", "c");
    expect(refused.closeCode).toBe(CLOSE_TRY_AGAIN_LATER);
    expect((await refused.connection.inbox.next("error")).code).toBe("room_full");
    await until(() => server.stats().connections === 2, "the refused connection to be gone");

    first.socket.close();
    await until(() => server.stats().connections === 1, "someone to leave");
    const retry = await joinFresh(server, "room1", "c");
    expect((await retry.inbox.next("presence")).clients).toHaveLength(2);
  });

  it("turns away a join that would open one room too many, while existing rooms keep working", async () => {
    const server = startServer({ limits: { maxRooms: 2 } });
    await joinFresh(server, "r1", "a");
    await joinFresh(server, "r2", "b");

    const refused = await joinAndExpectClose(server, "r3", "c");
    expect(refused.closeCode).toBe(CLOSE_TRY_AGAIN_LATER);
    expect((await refused.connection.inbox.next("error")).code).toBe("server_busy");
    expect((await joinFresh(server, "r1", "d")).socket.readyState).toBe(WebSocket.OPEN);
  });

  it("makes room again once idle rooms have been swept", async () => {
    const clock = controllableClock();
    const server = startServer({
      now: clock.now,
      roomIdleMs: 1000,
      sweepIntervalMs: 0,
      limits: { maxRooms: 1 },
    });
    const first = await joinFresh(server, "r1", "a");
    first.socket.close();
    await until(() => server.stats().connections === 0, "the client to leave");

    expect((await joinAndExpectClose(server, "r2")).closeCode).toBe(CLOSE_TRY_AGAIN_LATER);
    clock.advance(1000);
    expect(server.sweepIdleRooms()).toBe(1);
    expect((await joinFresh(server, "r2", "b")).socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("room id policy", () => {
  it("refuses a room id that is too short, finally", async () => {
    const server = startServer({ minRoomIdLength: 22 });
    const refused = await joinAndExpectClose(server, "demo");
    expect(refused.closeCode).toBe(CLOSE_ROOM_REFUSED);
    expect((await refused.connection.inbox.next("error")).code).toBe("invalid_room");
    expect(server.stats().rooms).toBe(0); // it did not even create the room
  });

  it("accepts an id of exactly the minimum length", async () => {
    const server = startServer({ minRoomIdLength: 22 });
    const id = "a".repeat(22);
    expect((await joinFresh(server, id, "a")).socket.readyState).toBe(WebSocket.OPEN);
    expect((await joinAndExpectClose(server, "a".repeat(21))).closeCode).toBe(CLOSE_ROOM_REFUSED);
  });

  it("accepts any valid id when no minimum is set", async () => {
    const server = startServer();
    expect((await joinFresh(server, "x", "a")).socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("idle rooms and snapshots", () => {
  it("drops an empty room from memory after the idle time, then loads it back identically", async () => {
    const clock = controllableClock();
    const server = startServer({ now: clock.now, roomIdleMs: 1000, sweepIntervalMs: 0 });
    const first = await joinFresh(server, "room1", "a");
    send(first, createShape("s1"));
    send(first, updateX("s1", 7, "move"));
    send(first, createShape("s2"));
    for (let i = 0; i < 3; i++) await first.inbox.next("op_ack");
    first.socket.close();
    await until(() => server.stats().connections === 0, "the client to leave");
    expect(server.stats().rooms).toBe(1);

    clock.advance(999);
    expect(server.sweepIdleRooms()).toBe(0);
    clock.advance(1);
    expect(server.sweepIdleRooms()).toBe(1);
    expect(server.stats().rooms).toBe(0);
    expect(server.opLog.loadSnapshot("room1")?.seq).toBe(3); // saved on the way out

    const returning = await joinRoom(server, "room1", "b");
    const snapshot = await returning.inbox.next("sync_snapshot");
    expect(snapshot.latestSeq).toBe(3);
    expect(Object.keys(snapshot.shapes)).toEqual(["s1", "s2"]);
    expect(snapshot.shapes.s1?.x).toBe(7);
  });

  it("never drops a room while someone is in it", async () => {
    const clock = controllableClock();
    const server = startServer({ now: clock.now, roomIdleMs: 1000, sweepIntervalMs: 0 });
    await joinFresh(server, "room1", "a");
    clock.advance(10_000_000);
    expect(server.sweepIdleRooms()).toBe(0);
    expect(server.stats().rooms).toBe(1);
  });

  it("sweeps on its own schedule when one is configured", async () => {
    const server = startServer({ roomIdleMs: 1, sweepIntervalMs: 10 });
    const client = await joinFresh(server, "room1", "a");
    client.socket.close();
    await until(() => server.stats().rooms === 0, "the room to be swept");
  });

  it("saves a snapshot every N ops", async () => {
    const server = startServer({ snapshotEvery: 3 });
    const client = await joinFresh(server, "room1", "a");
    send(client, createShape("s1"));
    send(client, createShape("s2"));
    await client.inbox.next("op_ack");
    await client.inbox.next("op_ack");
    expect(server.opLog.loadSnapshot("room1")).toBeNull();

    send(client, createShape("s3"));
    await client.inbox.next("op_ack");
    const snapshot = server.opLog.loadSnapshot("room1");
    expect(snapshot?.seq).toBe(3);
    expect(Object.keys(snapshot?.state ?? {})).toEqual(["s1", "s2", "s3"]); // includes the op that triggered it
  });

  it("restarts from the saved snapshot: state survives a server restart exactly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "ops.sqlite");

    const first = startServer({ dbPath, snapshotEvery: 2 });
    const writer = await joinFresh(first, "room1", "a");
    send(writer, createShape("s1"));
    send(writer, updateX("s1", 5, "m1"));
    send(writer, createShape("s2"));
    send(writer, deleteShape("s2"));
    for (let i = 0; i < 4; i++) await writer.inbox.next("op_ack");
    await first.close();

    const check = new OpLog(dbPath);
    expect(check.loadSnapshot("room1")?.seq).toBe(4); // written at shutdown
    check.close();

    const second = startServer({ dbPath });
    const reader = await joinRoom(second, "room1", "b");
    const snapshot = await reader.inbox.next("sync_snapshot");
    expect(snapshot.latestSeq).toBe(4);
    expect(snapshot.shapes.s1?.x).toBe(5);
    expect(snapshot.shapes.s2?.deletedAt).toBeDefined();
    expect(liveShapes(snapshot.shapes)).toEqual({ s1: expect.objectContaining({ x: 5 }) });
  });

  it("saves a snapshot of every room on shutdown, even one that never reached the snapshot interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "ops.sqlite");

    const server = startServer({ dbPath }); // default interval: 500 ops
    const writer = await joinFresh(server, "room1", "a");
    send(writer, createShape("s1"));
    send(writer, createShape("s2"));
    await writer.inbox.next("op_ack");
    await writer.inbox.next("op_ack");
    expect(server.opLog.loadSnapshot("room1")).toBeNull(); // nothing yet: only 2 ops

    await server.close();
    const check = new OpLog(dbPath);
    expect(check.loadSnapshot("room1")?.seq).toBe(2);
    check.close();
  });

  it("recovers by replaying the log when the saved snapshot is damaged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "ops.sqlite");

    const first = startServer({ dbPath });
    const writer = await joinFresh(first, "room1", "a");
    send(writer, createShape("s1"));
    await writer.inbox.next("op_ack");
    await first.close();

    const tamper = new OpLog(dbPath);
    tamper.saveSnapshot("room1", 1, {});
    tamper.close();
    // Break the stored JSON itself, as disk corruption might.
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(dbPath);
    raw.prepare("UPDATE snapshots SET state_json = '{broken' WHERE room_id = 'room1'").run();
    raw.close();

    const logger = quietLogger();
    const second = startServer({ dbPath, logger });
    const reader = await joinRoom(second, "room1", "b");
    const snapshot = await reader.inbox.next("sync_snapshot");
    expect(Object.keys(snapshot.shapes)).toEqual(["s1"]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("join deadline", () => {
  it("closes a connection that never joins a room, and says why", async () => {
    const logger = quietLogger();
    const server = startServer({ joinTimeoutMs: 40, logger });
    const idle = await connect(server);
    const closed = waitForClose(idle.socket);
    expect(await closed).toBe(CLOSE_POLICY_VIOLATION);
    expect((await idle.inbox.next("error")).code).toBe("not_joined");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("leaves a connection alone once it has joined", async () => {
    const server = startServer({ joinTimeoutMs: 40 });
    const client = await joinFresh(server, "room1", "a");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    send(client, createShape("s1"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
  });

  it("frees the slot for someone else", async () => {
    const server = startServer({ joinTimeoutMs: 40, limits: { maxConnections: 1 } });
    const idle = await connect(server);
    expect((await attemptConnect(server)).opened).toBe(false); // the only slot is taken
    await waitForClose(idle.socket);
    await until(() => server.stats().connections === 0, "the slot to be freed");
    expect((await attemptConnect(server)).opened).toBe(true);
  });

  it("can be turned off", async () => {
    const server = startServer({ joinTimeoutMs: 0 });
    const idle = await connect(server);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(idle.socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe("shutting down with people connected", () => {
  it("closes every connection and finishes, even with a health check connection held open", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "a");
    const closed = waitForClose(client.socket);
    const keepAlive = await healthOf(server, { headers: { Connection: "keep-alive" } });
    expect(keepAlive.status).toBe(200);

    await server.close();
    await closed;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("shape kinds, lines and text", () => {
  const shapeOf = (
    kind: Extract<Op, { type: "create_shape" }>["kind"],
    shapeId: string,
    fields = {},
  ): ClientMessage => ({
    type: "create_shape",
    shapeId,
    roomId: "room1",
    kind,
    fields: { x: 100, y: 100, width: -60, height: -40, color: "#6aa9f4", text: "", ...fields },
    hlc: claimedHlc(),
    opId: `op-${shapeId}`,
  });
  const resize = (shapeId: string, changes: object, opId: string): ClientMessage => ({
    type: "update_shape",
    shapeId,
    roomId: "room1",
    changes,
    hlc: claimedHlc(),
    opId,
  });

  it("stores an arrow that points up and to the left, and sends its kind to later joiners", async () => {
    const server = startServer();
    const alice = await joinFresh(server, "room1", "alice");
    send(alice, shapeOf("arrow", "a1", { text: "" }));
    expect(await alice.inbox.next("op_ack")).toMatchObject({ seq: 1, op: { kind: "arrow" } });

    const bob = await joinRoom(server, "room1", "bob");
    const snapshot = await bob.inbox.next("sync_snapshot");
    expect(snapshot.shapes.a1).toMatchObject({ kind: "arrow", width: -60, height: -40 });
  });

  it("refuses a rectangle with a negative size before it reaches the log", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, shapeOf("rect", "bad"));
    expect(await client.inbox.next("op_reject")).toMatchObject({ opId: "op-bad", reason: "invalid" });
    send(client, createShape("probe"));
    expect((await client.inbox.next("op_ack")).seq).toBe(1);
  });

  it("refuses to resize an existing box to a negative size, but lets a line or arrow do it", async () => {
    const server = startServer();
    const client = await joinFresh(server, "room1", "clientA");
    send(client, createShape("box"));
    send(client, shapeOf("line", "ln", { width: 50, height: 0 }));
    await client.inbox.next("op_ack");
    await client.inbox.next("op_ack");

    send(client, resize("box", { width: -5 }, "box-neg"));
    expect(await client.inbox.next("op_reject")).toMatchObject({ opId: "box-neg", reason: "invalid" });

    send(client, resize("ln", { width: -50, height: -10 }, "ln-neg"));
    expect(await client.inbox.next("op_ack")).toMatchObject({ seq: 3, op: { opId: "ln-neg" } });
  });

  it("keeps a concurrent recolor and relabel of one shape", async () => {
    const server = startServer();
    const alice = await joinFresh(server, "room1", "alice");
    const bob = await joinFresh(server, "room1", "bob");
    send(alice, createShape("s1"));
    await alice.inbox.next("op_ack");
    await bob.inbox.next("op_ack");

    send(alice, resize("s1", { text: "hello" }, "label"));
    send(bob, resize("s1", { color: "#ff0000" }, "paint"));
    await alice.inbox.next("op_ack");
    await alice.inbox.next("op_ack");

    const late = await joinRoom(server, "room1", "late");
    const { shapes } = await late.inbox.next("sync_snapshot");
    expect(shapes.s1).toMatchObject({ text: "hello", color: "#ff0000" });
  });

  it("relays a drag preview that flips a line, but drops one that would flip a box", async () => {
    const server = startServer();
    const alice = await joinFresh(server, "room1", "alice");
    const bob = await joinFresh(server, "room1", "bob");
    send(alice, createShape("box"));
    send(alice, shapeOf("arrow", "ar", { width: 10, height: 10 }));
    await alice.inbox.next("op_ack");
    await alice.inbox.next("op_ack");
    await bob.inbox.next("op_ack");
    await bob.inbox.next("op_ack");

    const preview = (shapeId: string): ClientMessage => ({
      type: "drag_preview",
      roomId: "room1",
      clientId: "alice",
      shapeId,
      changes: { width: -20 },
    });
    send(alice, preview("box"));
    send(alice, preview("ar"));
    expect(await bob.inbox.next("drag_preview")).toMatchObject({ shapeId: "ar" });
    expect(bob.inbox.pending("drag_preview")).toBe(0);
  });

  it("loads a database written before shapes had a kind and a text as plain rectangles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-legacy-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "legacy.sqlite");
    const log = new OpLog(dbPath);
    const legacyCreate = {
      type: "create_shape",
      shapeId: "old",
      roomId: "room1",
      fields: { x: 5, y: 6, width: 7, height: 8, color: "#123456" },
      hlc: { physical: 1, logical: 0, nodeId: "server" },
      opId: "old-op",
    };
    log.append("room1", legacyCreate as unknown as Op);
    log.close();

    const server = startServer({ dbPath });
    const client = await joinRoom(server, "room1", "clientA");
    const snapshot = await client.inbox.next("sync_snapshot");
    expect(snapshot.shapes.old).toMatchObject({ kind: "rect", text: "", x: 5, color: "#123456" });
    expect(snapshot.shapes.old!.lastHlc.text).toBeDefined();

    // And the old shape can be labelled like any other.
    send(client, resize("old", { text: "legacy" }, "relabel"));
    expect(await client.inbox.next("op_ack")).toMatchObject({ seq: 2, op: { changes: { text: "legacy" } } });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_UNSUPPORTED_PROTOCOL,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Op,
  type ServerMessage,
  type ShapeFields,
} from "@realtime-canvas/shared";
import { RoomClient, type RoomClientEvent } from "./room-client";
import { FakeScheduler, FakeWebSocket } from "./test-support/fake-websocket";

const FIELDS: ShapeFields = { x: 0, y: 0, width: 10, height: 10, color: "#000000" };
const hlc = (physical: number) => ({ physical, logical: 0, nodeId: "server" });

beforeEach(() => FakeWebSocket.reset());

function setup() {
  let id = 0;
  const scheduler = new FakeScheduler();
  const client = new RoomClient({
    url: "ws://test",
    roomId: "r",
    clientId: "me",
    WebSocket: FakeWebSocket,
    scheduler,
    random: () => 0,
    now: () => 1000,
    newId: () => `id-${++id}`,
  });
  const events: RoomClientEvent[] = [];
  client.onEvent((event) => events.push(event));
  return { client, scheduler, events };
}

const types = (messages: ClientMessage[]) => messages.map((m) => m.type);
const stamp = (op: Op, physical = 100): Op => ({ ...op, hlc: hlc(physical) });
const ack = (seq: number, op: Op): ServerMessage => ({ type: "op_ack", roomId: "r", seq, op });
const emptySnapshot: ServerMessage = { type: "sync_snapshot", roomId: "r", shapes: {}, latestSeq: 0 };

function connected() {
  const ctx = setup();
  ctx.client.connect();
  FakeWebSocket.latest.open();
  return ctx;
}

describe("connecting", () => {
  it("sends join_room first on open, resuming from sequence 0 for a new client", () => {
    connected();
    expect(FakeWebSocket.latest.sent).toEqual([
      { type: "join_room", protocolVersion: PROTOCOL_VERSION, roomId: "r", clientId: "me", sinceSeq: 0 },
    ]);
  });

  it("generates a distinct clientId per client when none is given", () => {
    const make = () =>
      new RoomClient({
        url: "ws://test",
        roomId: "r",
        WebSocket: FakeWebSocket,
        scheduler: new FakeScheduler(),
      });
    expect(make().clientId).not.toBe(make().clientId);
  });

  it("reports connection status changes to subscribers", () => {
    const { client } = setup();
    const listener = vi.fn();
    client.subscribe(listener);
    client.connect();
    FakeWebSocket.latest.open();
    expect(client.getStatus()).toBe("open");
    expect(listener).toHaveBeenCalled();
  });

  it("stops reconnecting when the server refuses the protocol version", () => {
    const { client, scheduler } = setup();
    client.connect();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose(CLOSE_UNSUPPORTED_PROTOCOL);
    expect(client.getStatus()).toBe("unsupported_protocol");
    expect(scheduler.pendingDelays).toEqual([]);
  });
});

describe("edits", () => {
  it("applies an edit locally and sends it at once when online", () => {
    const { client } = connected();
    FakeWebSocket.latest.receive(emptySnapshot);
    const result = client.createShape(FIELDS, "s1");
    expect(result.ok).toBe(true);
    expect(client.engine.getLiveShapes().s1).toBeDefined();
    expect(types(FakeWebSocket.latest.sent)).toEqual(["join_room", "create_shape"]);
  });

  it("queues edits made while offline, and sends them after the join once connected", () => {
    const { client } = setup();
    client.createShape(FIELDS, "a");
    client.createShape(FIELDS, "b");
    expect(client.engine.getPending()).toHaveLength(2);

    client.connect();
    FakeWebSocket.latest.open();
    expect(types(FakeWebSocket.latest.sent)).toEqual(["join_room", "create_shape", "create_shape"]);
    expect(FakeWebSocket.latest.sent.map((m) => (m as { shapeId?: string }).shapeId)).toEqual([
      undefined,
      "a",
      "b",
    ]);
  });

  it("does not send an edit the engine refused", () => {
    const { client } = connected();
    expect(client.updateShape("ghost", { x: 1 })).toEqual({ ok: false, reason: "unknown_shape" });
    expect(types(FakeWebSocket.latest.sent)).toEqual(["join_room"]);
  });

  it("clears an edit from pending when its ack arrives", () => {
    const { client } = connected();
    const result = client.createShape(FIELDS, "s1");
    if (!result.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(1, stamp(result.op)));
    expect(client.engine.getPending()).toEqual([]);
    expect(client.engine.getLastSeq()).toBe(1);
  });
});

describe("reconnecting", () => {
  it("rejoins from the last sequence number and re-sends what was never acknowledged", () => {
    const { client, scheduler } = connected();
    const first = client.createShape(FIELDS, "a");
    if (!first.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(1, stamp(first.op))); // acknowledged
    client.createShape(FIELDS, "b"); // sent, never acknowledged
    const unacked = client.engine.getPending()[0] as Op;

    FakeWebSocket.latest.serverClose();
    client.createShape(FIELDS, "c"); // made while offline
    scheduler.fireNext();
    FakeWebSocket.latest.open();

    const sent = FakeWebSocket.latest.sent;
    expect(sent[0]).toMatchObject({ type: "join_room", sinceSeq: 1 });
    expect(sent.slice(1)).toEqual([unacked, client.engine.getPending()[1]]);
    expect(sent.slice(1).map((m) => (m as { shapeId: string }).shapeId)).toEqual(["b", "c"]);
  });

  it("forgets presence on disconnect but keeps the edits", () => {
    const { client } = connected();
    FakeWebSocket.latest.receive({
      type: "presence",
      roomId: "r",
      clients: [{ clientId: "a", color: "#fff" }],
    });
    client.createShape(FIELDS, "s1");
    FakeWebSocket.latest.serverClose();
    expect(client.engine.getPresence()).toEqual([]);
    expect(client.engine.getPending()).toHaveLength(1);
    expect(client.getStatus()).toBe("waiting");
  });

  it("reconnects after the backoff when a gap in the op stream is detected", () => {
    const { client, scheduler, events } = connected();
    const result = client.createShape(FIELDS, "s1");
    if (!result.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(5, stamp(result.op))); // seq 1..4 never arrived

    expect(events).toContainEqual({ type: "resync_requested" });
    expect(client.getStatus()).toBe("waiting");
    expect(client.engine.getPending()).toHaveLength(1);
    scheduler.fireNext();
    FakeWebSocket.latest.open();
    expect(FakeWebSocket.latest.sent[0]).toMatchObject({ type: "join_room", sinceSeq: 0 });
  });
});

describe("rejections and errors", () => {
  it("emits the rejection and rolls the edit back", () => {
    const { client, events } = connected();
    const create = client.createShape(FIELDS, "s1");
    if (!create.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(1, stamp(create.op, 10)));
    const update = client.updateShape("s1", { x: 5 });
    if (!update.ok) throw new Error("update failed");
    expect(client.engine.getLiveShapes().s1?.x).toBe(5);

    FakeWebSocket.latest.receive({ type: "op_reject", opId: update.op.opId, reason: "unknown_shape" });
    expect(events).toContainEqual({ type: "op_rejected", opId: update.op.opId, reason: "unknown_shape" });
    expect(client.engine.getLiveShapes().s1?.x).toBe(0);
  });

  it("emits server errors", () => {
    const { events } = connected();
    FakeWebSocket.latest.receive({ type: "error", code: "invalid_message", message: "bad frame" });
    expect(events).toContainEqual({ type: "server_error", code: "invalid_message", message: "bad frame" });
  });
});

describe("ephemeral messages", () => {
  it("sends a cursor with the colour the server assigned, and drops it when offline", () => {
    const { client } = setup();
    expect(client.sendCursor(1, 2)).toBe(false);
    client.connect();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive({
      type: "presence",
      roomId: "r",
      clients: [{ clientId: "me", color: "#abcdef" }],
    });

    expect(client.sendCursor(1, 2)).toBe(true);
    expect(FakeWebSocket.latest.sent.at(-1)).toEqual({
      type: "cursor",
      roomId: "r",
      clientId: "me",
      x: 1,
      y: 2,
      color: "#abcdef",
    });
  });

  it("sends drag previews, and does not queue them while offline", () => {
    const { client } = setup();
    expect(client.sendDragPreview("s1", { x: 1 })).toBe(false);
    client.connect();
    FakeWebSocket.latest.open();
    expect(FakeWebSocket.latest.sent.map((m) => m.type)).toEqual(["join_room"]);

    expect(client.sendDragPreview("s1", { x: 1, y: 2 })).toBe(true);
    expect(FakeWebSocket.latest.sent.at(-1)).toEqual({
      type: "drag_preview",
      roomId: "r",
      clientId: "me",
      shapeId: "s1",
      changes: { x: 1, y: 2 },
    });
  });
});

describe("retryNow", () => {
  it("reconnects at once when waiting out a backoff, and sends the join again", () => {
    const { client, scheduler } = connected();
    FakeWebSocket.latest.serverClose();
    expect(client.getStatus()).toBe("waiting");

    client.retryNow();
    FakeWebSocket.latest.open();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(scheduler.pendingDelays).toEqual([]);
    expect(FakeWebSocket.latest.sent[0]).toMatchObject({ type: "join_room" });
  });

  it("leaves a healthy connection alone", () => {
    const { client } = connected();
    client.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getStatus()).toBe("open");
  });
});

describe("disconnecting", () => {
  it("stops for good", () => {
    const { client, scheduler } = connected();
    client.disconnect();
    expect(client.getStatus()).toBe("closed");
    expect(scheduler.pendingDelays).toEqual([]);
  });
});

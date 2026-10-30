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

const FIELDS: ShapeFields = { x: 0, y: 0, width: 10, height: 10, color: "#000000", text: "" };
const hlc = (physical: number) => ({ physical, logical: 0, nodeId: "server" });

beforeEach(() => FakeWebSocket.reset());

function setup(extra: Partial<ConstructorParameters<typeof RoomClient>[0]> = {}) {
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
    ...extra,
  });
  const events: RoomClientEvent[] = [];
  client.onEvent((event) => events.push(event));
  return { client, scheduler, events };
}

const types = (messages: ClientMessage[]) => messages.map((m) => m.type);
const stamp = (op: Op, physical = 100): Op => ({ ...op, hlc: hlc(physical) });
const ack = (seq: number, op: Op): ServerMessage => ({ type: "op_ack", roomId: "r", seq, op });
const emptySnapshot: ServerMessage = { type: "sync_snapshot", roomId: "r", shapes: {}, latestSeq: 0 };

function connected(extra: Partial<ConstructorParameters<typeof RoomClient>[0]> = {}) {
  const ctx = setup(extra);
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
    const result = client.createShape("rect", FIELDS, "s1");
    expect(result.ok).toBe(true);
    expect(client.engine.getLiveShapes().s1).toBeDefined();
    expect(types(FakeWebSocket.latest.sent)).toEqual(["join_room", "create_shape"]);
  });

  it("queues edits made while offline, and sends them after the join once connected", () => {
    const { client } = setup();
    client.createShape("rect", FIELDS, "a");
    client.createShape("rect", FIELDS, "b");
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
    const result = client.createShape("rect", FIELDS, "s1");
    if (!result.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(1, stamp(result.op)));
    expect(client.engine.getPending()).toEqual([]);
    expect(client.engine.getLastSeq()).toBe(1);
  });
});

describe("reconnecting", () => {
  it("rejoins from the last sequence number and re-sends what was never acknowledged", () => {
    const { client, scheduler } = connected();
    const first = client.createShape("rect", FIELDS, "a");
    if (!first.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(1, stamp(first.op))); // acknowledged
    client.createShape("rect", FIELDS, "b"); // sent, never acknowledged
    const unacked = client.engine.getPending()[0] as Op;

    FakeWebSocket.latest.serverClose();
    client.createShape("rect", FIELDS, "c"); // made while offline
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
    client.createShape("rect", FIELDS, "s1");
    FakeWebSocket.latest.serverClose();
    expect(client.engine.getPresence()).toEqual([]);
    expect(client.engine.getPending()).toHaveLength(1);
    expect(client.getStatus()).toBe("waiting");
  });

  it("reconnects after the backoff when a gap in the op stream is detected", () => {
    const { client, scheduler, events } = connected();
    const result = client.createShape("rect", FIELDS, "s1");
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

describe("catching up after a reconnect", () => {
  const shapeIds = (messages: ClientMessage[]) => messages.map((m) => (m as { shapeId?: string }).shapeId);
  const fill = (client: RoomClient, count: number) => {
    for (let i = 0; i < count; i++) client.createShape("rect", FIELDS, `s${i}`);
  };

  it("re-sends a long queue in paced batches, not all at once, so it cannot trip the server's rate limit", () => {
    const { client, scheduler } = setup();
    fill(client, 25);
    client.connect();
    FakeWebSocket.latest.open();

    expect(FakeWebSocket.latest.sent).toHaveLength(1 + 10); // the join, then the first batch
    expect(scheduler.pendingDelays).toEqual([600]);

    scheduler.fireNext();
    expect(FakeWebSocket.latest.sent).toHaveLength(1 + 20);
    scheduler.fireNext();
    expect(FakeWebSocket.latest.sent).toHaveLength(1 + 25);
    expect(scheduler.pendingDelays).toEqual([]); // nothing left to schedule
  });

  it("keeps the original order across batches", () => {
    const { client, scheduler } = setup({ flushBatchSize: 2 });
    fill(client, 5);
    client.connect();
    FakeWebSocket.latest.open();
    scheduler.fireNext();
    scheduler.fireNext();
    expect(shapeIds(FakeWebSocket.latest.sent).slice(1)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("skips an op that was acknowledged while it waited its turn", () => {
    const { client, scheduler } = setup({ flushBatchSize: 1 });
    fill(client, 3);
    const second = client.engine.getPending()[1]!;
    client.connect();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive(ack(1, stamp(second)));

    scheduler.fireNext();
    scheduler.fireNext();
    expect(shapeIds(FakeWebSocket.latest.sent).slice(1)).toEqual(["s0", "s2"]);
  });

  it("makes a new edit wait its turn behind older ones still queued, so it cannot overtake the op it depends on", () => {
    const { client, scheduler } = setup({ flushBatchSize: 1 });
    fill(client, 2);
    client.connect();
    FakeWebSocket.latest.open(); // sends s0; s1 still waiting
    client.updateShape("s1", { x: 9 }); // depends on s1's create

    expect(shapeIds(FakeWebSocket.latest.sent).slice(1)).toEqual(["s0"]);
    scheduler.fireNext();
    scheduler.fireNext();
    const sent = FakeWebSocket.latest.sent.slice(1) as { type: string; shapeId: string }[];
    expect(sent.map((m) => `${m.type}:${m.shapeId}`)).toEqual([
      "create_shape:s0",
      "create_shape:s1",
      "update_shape:s1",
    ]);
  });

  it("sends a new edit straight away when nothing is waiting", () => {
    const { client } = connected();
    client.createShape("rect", FIELDS, "now");
    expect(shapeIds(FakeWebSocket.latest.sent)).toEqual([undefined, "now"]);
  });

  it("forgets what was waiting when the connection drops, and starts over from the queue on the next one", () => {
    const { client, scheduler } = setup({ flushBatchSize: 1 });
    fill(client, 3);
    client.connect();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose();
    expect(scheduler.pendingDelays).toEqual([2000 - 1000]); // only the reconnect timer: no stale flush

    scheduler.fireNext();
    FakeWebSocket.latest.open();
    expect(shapeIds(FakeWebSocket.latest.sent).slice(1)).toEqual(["s0"]); // from the top again
  });
});

describe("when the server says an op came too fast", () => {
  it("keeps the edit, tells the UI it is a notice and not a rollback, and sends it again after a pause", () => {
    const { client, scheduler, events } = connected({ retryDelayMs: 1500 });
    const result = client.createShape("rect", FIELDS, "s1");
    if (!result.ok) throw new Error("create failed");
    const sentBefore = FakeWebSocket.latest.sent.length;

    FakeWebSocket.latest.receive({ type: "op_reject", opId: result.op.opId, reason: "rate_limited" });
    expect(events).toContainEqual({
      type: "op_rejected",
      opId: result.op.opId,
      reason: "rate_limited",
      retryable: true,
    });
    expect(client.engine.getPending()).toHaveLength(1);
    expect(client.engine.getLiveShapes().s1).toBeDefined();
    expect(scheduler.pendingDelays).toEqual([1500]);
    expect(FakeWebSocket.latest.sent).toHaveLength(sentBefore); // not re-sent yet

    scheduler.fireNext();
    expect(FakeWebSocket.latest.sent.at(-1)).toEqual(result.op);
  });

  it("holds later edits behind the one that is waiting to be retried", () => {
    const { client, scheduler } = connected();
    const first = client.createShape("rect", FIELDS, "s1");
    if (!first.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive({ type: "op_reject", opId: first.op.opId, reason: "rate_limited" });

    client.updateShape("s1", { x: 5 });
    const sent = FakeWebSocket.latest.sent.map((m) => m.type);
    expect(sent.filter((type) => type === "update_shape")).toEqual([]); // not sent ahead of its create

    scheduler.fireNext(); // one batch carries both, in order
    const types = FakeWebSocket.latest.sent.map((m) => m.type);
    expect(types.slice(-2)).toEqual(["create_shape", "update_shape"]);
    expect(scheduler.pendingDelays).toEqual([]);
  });

  it("puts several retried ops back in their original order", () => {
    const { client, scheduler } = connected({ flushBatchSize: 10 });
    const ops = ["a", "b", "c"].map((id) => {
      const result = client.createShape("rect", FIELDS, id);
      if (!result.ok) throw new Error("create failed");
      return result.op;
    });
    // The server refuses b and c, and the refusals arrive out of order.
    FakeWebSocket.latest.receive({ type: "op_reject", opId: ops[2]!.opId, reason: "rate_limited" });
    FakeWebSocket.latest.receive({ type: "op_reject", opId: ops[1]!.opId, reason: "rate_limited" });
    const before = FakeWebSocket.latest.sent.length;
    scheduler.fireNext();
    const resent = FakeWebSocket.latest.sent.slice(before) as { shapeId: string }[];
    expect(resent.map((m) => m.shapeId)).toEqual(["b", "c"]);
  });

  it("still rolls back an op the server refuses for a reason that waiting cannot fix", () => {
    const { client, scheduler, events } = connected();
    const result = client.createShape("rect", FIELDS, "s1");
    if (!result.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive({ type: "op_reject", opId: result.op.opId, reason: "room_full" });

    expect(events).toContainEqual({
      type: "op_rejected",
      opId: result.op.opId,
      reason: "room_full",
      retryable: false,
    });
    expect(client.engine.getPending()).toEqual([]);
    expect(client.engine.getLiveShapes()).toEqual({});
    expect(scheduler.pendingDelays).toEqual([]);
  });
});

describe("rejections and errors", () => {
  it("emits the rejection and rolls the edit back", () => {
    const { client, events } = connected();
    const create = client.createShape("rect", FIELDS, "s1");
    if (!create.ok) throw new Error("create failed");
    FakeWebSocket.latest.receive(ack(1, stamp(create.op, 10)));
    const update = client.updateShape("s1", { x: 5 });
    if (!update.ok) throw new Error("update failed");
    expect(client.engine.getLiveShapes().s1?.x).toBe(5);

    FakeWebSocket.latest.receive({ type: "op_reject", opId: update.op.opId, reason: "unknown_shape" });
    expect(events).toContainEqual({
      type: "op_rejected",
      opId: update.op.opId,
      reason: "unknown_shape",
      retryable: false,
    });
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

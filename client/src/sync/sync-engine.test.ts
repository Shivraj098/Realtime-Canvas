import { describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type HlcTimestamp,
  type Op,
  type ServerMessage,
  type ShapeFields,
  type ShapeSnapshot,
} from "@realtime-canvas/shared";
import { SyncEngine, type SyncEngineOptions } from "./sync-engine";

const ROOM = "room1";
const FIELDS: ShapeFields = { x: 0, y: 0, width: 10, height: 10, color: "#000000" };

const serverHlc = (physical: number, logical = 0): HlcTimestamp => ({ physical, logical, nodeId: "server" });

function makeEngine(overrides: Partial<SyncEngineOptions> = {}) {
  let id = 0;
  let now = 1000;
  const engine = new SyncEngine({
    roomId: ROOM,
    clientId: "me",
    now: () => now,
    newId: () => `id-${++id}`,
    ...overrides,
  });
  return { engine, setNow: (value: number) => (now = value) };
}

function stamped(op: Op, physical: number, logical = 0): Op {
  return { ...op, hlc: serverHlc(physical, logical) };
}

const remoteCreate = (shapeId: string, physical: number, fields: ShapeFields = FIELDS): Op => ({
  type: "create_shape",
  shapeId,
  roomId: ROOM,
  fields,
  hlc: serverHlc(physical),
  opId: `remote-create-${shapeId}`,
});

const remoteUpdate = (
  shapeId: string,
  changes: Partial<ShapeFields>,
  physical: number,
  opId: string,
): Op => ({
  type: "update_shape",
  shapeId,
  roomId: ROOM,
  changes,
  hlc: serverHlc(physical),
  opId,
});

const ack = (seq: number, op: Op): ServerMessage => ({ type: "op_ack", roomId: ROOM, seq, op });

function snapshotShape(fields: ShapeFields, physical: number, deletedAt?: HlcTimestamp): ShapeSnapshot {
  const at = serverHlc(physical);
  return {
    ...fields,
    lastHlc: { x: at, y: at, width: at, height: at, color: at },
    ...(deletedAt && { deletedAt }),
  };
}

function created(engine: SyncEngine, shapeId = "s1"): Op {
  const result = engine.createShape(FIELDS, shapeId);
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.op;
}

describe("joining", () => {
  it("builds a join for a fresh client", () => {
    const { engine } = makeEngine();
    expect(engine.buildJoin()).toEqual({
      type: "join_room",
      protocolVersion: PROTOCOL_VERSION,
      roomId: ROOM,
      clientId: "me",
      sinceSeq: 0,
    });
  });

  it("resumes from the last sequence number it applied", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("s1", 100)));
    engine.receive(ack(2, remoteUpdate("s1", { x: 5 }, 110, "u1")));
    expect(engine.buildJoin().sinceSeq).toBe(2);
  });

  it("can speak a different protocol version, for tests of the refusal path", () => {
    const { engine } = makeEngine({ protocolVersion: 99 });
    expect(engine.buildJoin().protocolVersion).toBe(99);
  });
});

describe("optimistic edits", () => {
  it("shows a created shape in the view at once, but not in confirmed state", () => {
    const { engine } = makeEngine();
    const op = created(engine);
    expect(engine.getLiveShapes().s1).toMatchObject(FIELDS);
    expect(engine.getConfirmed()).toEqual({});
    expect(engine.getPending()).toEqual([op]);
  });

  it("gives every local op a fresh opId and the room and client's identity", () => {
    const { engine } = makeEngine();
    const first = created(engine, "a");
    const second = created(engine, "b");
    expect(first.opId).not.toBe(second.opId);
    expect(first.roomId).toBe(ROOM);
  });

  it("keeps the op's own timestamps monotonic", () => {
    const { engine } = makeEngine();
    const a = created(engine, "a");
    const result = engine.updateShape("a", { x: 1 });
    expect(result.ok && result.op.hlc.logical).toBeGreaterThan(a.hlc.logical);
  });

  it("applies several field changes in one op", () => {
    const { engine } = makeEngine();
    created(engine);
    const result = engine.updateShape("s1", { x: 5, y: 6 });
    expect(result.ok && result.op).toMatchObject({ type: "update_shape", changes: { x: 5, y: 6 } });
    expect(engine.getLiveShapes().s1).toMatchObject({ x: 5, y: 6 });
  });

  it("drops undefined values from a change", () => {
    const { engine } = makeEngine();
    created(engine);
    const result = engine.updateShape("s1", { x: 5, y: undefined });
    expect(result.ok && result.op).toMatchObject({ changes: { x: 5 } });
    expect(result.ok && "y" in (result.op as { changes: object }).changes).toBe(false);
  });

  it("hides a shape as soon as its deletion is queued", () => {
    const { engine } = makeEngine();
    created(engine);
    engine.deleteShape("s1");
    expect(engine.getLiveShapes()).toEqual({});
    expect(engine.getView().s1?.deletedAt).toBeDefined();
  });

  it("returns the same view object until something changes", () => {
    const { engine } = makeEngine();
    created(engine);
    expect(engine.getView()).toBe(engine.getView());
    expect(engine.getLiveShapes()).toBe(engine.getLiveShapes());
  });
});

describe("refusing edits that cannot work", () => {
  it.each([
    ["update", (e: SyncEngine) => e.updateShape("ghost", { x: 1 })],
    ["delete", (e: SyncEngine) => e.deleteShape("ghost")],
  ])("refuses to %s a shape it does not have", (_name, act) => {
    const { engine } = makeEngine();
    expect(act(engine)).toEqual({ ok: false, reason: "unknown_shape" });
    expect(engine.getPending()).toEqual([]);
  });

  it("refuses an update with nothing to change", () => {
    const { engine } = makeEngine();
    created(engine);
    expect(engine.updateShape("s1", {})).toEqual({ ok: false, reason: "empty_changes" });
    expect(engine.updateShape("s1", { x: undefined })).toEqual({ ok: false, reason: "empty_changes" });
  });

  it("refuses to create a shape id it already has, and to touch a deleted one", () => {
    const { engine } = makeEngine();
    created(engine);
    expect(engine.createShape(FIELDS, "s1")).toEqual({ ok: false, reason: "shape_exists" });
    engine.deleteShape("s1");
    expect(engine.createShape(FIELDS, "s1")).toEqual({ ok: false, reason: "shape_exists" });
    expect(engine.updateShape("s1", { x: 1 })).toEqual({ ok: false, reason: "unknown_shape" });
  });

  it("stops queueing edits at maxPending, and resumes once acks free the queue", () => {
    const { engine } = makeEngine({ maxPending: 2 });
    const first = created(engine, "a");
    created(engine, "b");
    expect(engine.createShape(FIELDS, "c")).toEqual({ ok: false, reason: "queue_full" });
    expect(engine.updateShape("a", { x: 1 })).toEqual({ ok: false, reason: "queue_full" });
    expect(engine.deleteShape("a")).toEqual({ ok: false, reason: "queue_full" });

    engine.receive(ack(1, stamped(first, 200)));
    expect(engine.createShape(FIELDS, "c").ok).toBe(true);
  });
});

describe("acknowledgements", () => {
  it("moves an acknowledged op from pending into confirmed state, with the server's timestamp", () => {
    const { engine } = makeEngine();
    const op = created(engine);
    engine.receive(ack(1, stamped(op, 500)));

    expect(engine.getPending()).toEqual([]);
    expect(engine.getLastSeq()).toBe(1);
    expect(engine.getConfirmed().s1?.lastHlc.x).toEqual(serverHlc(500));
    expect(engine.getView()).toEqual(engine.getConfirmed());
  });

  it("applies other clients' ops and leaves unrelated pending ops alone", () => {
    const { engine } = makeEngine();
    created(engine, "mine");
    engine.receive(ack(1, remoteCreate("theirs", 100)));
    expect(Object.keys(engine.getLiveShapes()).sort()).toEqual(["mine", "theirs"]);
    expect(engine.getPending()).toHaveLength(1);
  });

  it("treats an ack at or below lastSeq as already applied, but still stops waiting for that op", () => {
    const { engine } = makeEngine();
    const op = created(engine);
    engine.receive(ack(1, stamped(op, 100))); // original ack
    const again = engine.updateShape("s1", { x: 9 });
    expect(again.ok).toBe(true);

    // A late duplicate of the first ack must not re-apply anything or disturb the pending update.
    engine.receive(ack(1, stamped(op, 100)));
    expect(engine.getLastSeq()).toBe(1);
    expect(engine.getPending()).toHaveLength(1);
  });

  it("stops waiting for an op whose ack arrived below lastSeq (re-ack after a replay)", () => {
    const { engine } = makeEngine();
    const op = created(engine);
    // The server had already stored the op; a snapshot brought us past it.
    engine.receive({
      type: "sync_snapshot",
      roomId: ROOM,
      latestSeq: 5,
      shapes: { s1: snapshotShape(FIELDS, 100) },
    });
    expect(engine.getPending()).toHaveLength(1);
    engine.receive(ack(3, stamped(op, 100)));
    expect(engine.getPending()).toEqual([]);
    expect(engine.getLastSeq()).toBe(5);
  });

  it("asks for a resync, applying nothing, when a sequence number is skipped", () => {
    const { engine } = makeEngine();
    const op = created(engine);
    const effect = engine.receive(ack(3, stamped(op, 100)));
    expect(effect).toEqual({ resyncNeeded: true });
    expect(engine.getLastSeq()).toBe(0);
    expect(engine.getConfirmed()).toEqual({});
    expect(engine.getPending()).toHaveLength(1); // the edit is not lost
  });

  it("moves its own clock past every server timestamp it has seen", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("s1", 9_000_000)));
    const result = engine.updateShape("s1", { x: 1 });
    expect(result.ok && result.op.hlc.physical).toBeGreaterThanOrEqual(9_000_000);
  });

  it("ignores acks for another room", () => {
    const { engine } = makeEngine();
    engine.receive({ type: "op_ack", roomId: "other", seq: 1, op: remoteCreate("s1", 100) });
    expect(engine.getLastSeq()).toBe(0);
    expect(engine.getConfirmed()).toEqual({});
  });
});

describe("pending edits win over confirmed state in the view", () => {
  it("keeps the user's pending edit visible when a concurrent remote edit to the same field arrives", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("s1", 100)));
    engine.updateShape("s1", { x: 50 }); // pending, not yet acknowledged
    // Another client's update arrives, stamped later than anything we hold.
    engine.receive(ack(2, remoteUpdate("s1", { x: 7 }, 999_999, "remote-move")));

    // The server will stamp our op after this one, so our edit must stay on top.
    expect(engine.getLiveShapes().s1?.x).toBe(50);
    expect(engine.getConfirmed().s1?.x).toBe(7);
  });

  it("applies several pending edits in the order they were made", () => {
    const { engine } = makeEngine();
    created(engine);
    engine.updateShape("s1", { x: 1 });
    engine.updateShape("s1", { x: 2 });
    expect(engine.getLiveShapes().s1?.x).toBe(2);
  });

  it("settles on the server's value once the ack arrives", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("s1", 100)));
    const result = engine.updateShape("s1", { x: 50 });
    if (!result.ok) throw new Error("update failed");
    engine.receive(ack(2, stamped(result.op, 200)));
    expect(engine.getPending()).toEqual([]);
    expect(engine.getLiveShapes().s1?.x).toBe(50);
  });
});

describe("rejections", () => {
  it("rolls a rejected edit back by dropping it from the queue", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("s1", 100)));
    const result = engine.updateShape("s1", { x: 50 });
    if (!result.ok) throw new Error("update failed");

    const effect = engine.receive({ type: "op_reject", opId: result.op.opId, reason: "unknown_shape" });
    expect(effect.rejected).toEqual({ opId: result.op.opId, reason: "unknown_shape", wasPending: true });
    expect(engine.getLiveShapes().s1?.x).toBe(0);
    expect(engine.getPending()).toEqual([]);
  });

  it("keeps the other pending edits when one is rejected", () => {
    const { engine } = makeEngine();
    const a = created(engine, "a");
    created(engine, "b");
    engine.receive({ type: "op_reject", opId: a.opId, reason: "shape_exists" });
    expect(Object.keys(engine.getLiveShapes())).toEqual(["b"]);
  });

  it("reports a rejection for an op it no longer holds", () => {
    const { engine } = makeEngine();
    const effect = engine.receive({ type: "op_reject", opId: "unknown", reason: "invalid" });
    expect(effect.rejected).toEqual({ opId: "unknown", reason: "invalid", wasPending: false });
  });

  it("passes server errors through", () => {
    const { engine } = makeEngine();
    expect(engine.receive({ type: "error", code: "invalid_message", message: "bad" }).error).toEqual({
      code: "invalid_message",
      message: "bad",
    });
  });
});

describe("snapshots", () => {
  it("replaces confirmed state and the sequence number", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("old", 100)));
    engine.receive({
      type: "sync_snapshot",
      roomId: ROOM,
      latestSeq: 7,
      shapes: { fresh: snapshotShape(FIELDS, 300) },
    });
    expect(Object.keys(engine.getConfirmed())).toEqual(["fresh"]);
    expect(engine.getLastSeq()).toBe(7);
  });

  it("keeps pending edits, applied on top of the snapshot", () => {
    const { engine } = makeEngine();
    created(engine, "mine");
    engine.receive({
      type: "sync_snapshot",
      roomId: ROOM,
      latestSeq: 3,
      shapes: { theirs: snapshotShape(FIELDS, 300) },
    });
    expect(Object.keys(engine.getLiveShapes()).sort()).toEqual(["mine", "theirs"]);
  });

  it("does not duplicate a shape whose create the server already holds", () => {
    const { engine } = makeEngine();
    created(engine, "s1");
    engine.receive({
      type: "sync_snapshot",
      roomId: ROOM,
      latestSeq: 1,
      shapes: { s1: snapshotShape({ ...FIELDS, x: 42 }, 300) },
    });
    expect(Object.keys(engine.getLiveShapes())).toEqual(["s1"]);
    expect(engine.getLiveShapes().s1?.x).toBe(42);
  });

  it("carries tombstones, so a deleted shape is not shown", () => {
    const { engine } = makeEngine();
    engine.receive({
      type: "sync_snapshot",
      roomId: ROOM,
      latestSeq: 2,
      shapes: { gone: snapshotShape(FIELDS, 100, serverHlc(200)) },
    });
    expect(engine.getLiveShapes()).toEqual({});
    expect(engine.getConfirmed().gone).toBeDefined();
  });

  it("moves its clock past the snapshot's timestamps", () => {
    const { engine } = makeEngine();
    engine.receive({
      type: "sync_snapshot",
      roomId: ROOM,
      latestSeq: 1,
      shapes: { s1: snapshotShape(FIELDS, 8_000_000) },
    });
    const result = engine.updateShape("s1", { x: 1 });
    expect(result.ok && result.op.hlc.physical).toBeGreaterThanOrEqual(8_000_000);
  });

  it("does not alias the message's shapes object", () => {
    const { engine } = makeEngine();
    const shapes = { s1: snapshotShape(FIELDS, 100) };
    engine.receive({ type: "sync_snapshot", roomId: ROOM, latestSeq: 1, shapes });
    delete (shapes as Record<string, unknown>).s1;
    expect(engine.getConfirmed().s1).toBeDefined();
  });

  it("handles shape ids that collide with Object.prototype members", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("constructor", 100)));
    expect(engine.updateShape("constructor", { x: 3 }).ok).toBe(true);
    expect(Object.keys(engine.getLiveShapes())).toEqual(["constructor"]);
  });
});

describe("presence, cursors and drag previews", () => {
  const presence = (...ids: string[]): ServerMessage => ({
    type: "presence",
    roomId: ROOM,
    clients: ids.map((clientId, index) => ({ clientId, color: `#00000${index}` })),
  });

  it("lists each client once, however many connections it has", () => {
    const { engine } = makeEngine();
    engine.receive(presence("a", "b", "a"));
    expect(engine.getPresence().map((entry) => entry.clientId)).toEqual(["a", "b"]);
  });

  it("knows its own cursor colour from presence, with a default before then", () => {
    const { engine } = makeEngine();
    const before = engine.getSelfColor();
    engine.receive(presence("other", "me"));
    expect(engine.getSelfColor()).toBe("#000001");
    expect(before).not.toBe("#000001");
  });

  it("stores other clients' cursors, ignoring its own and other rooms'", () => {
    const { engine } = makeEngine();
    engine.receive({ type: "cursor", roomId: ROOM, clientId: "a", x: 1, y: 2, color: "#111111" });
    engine.receive({ type: "cursor", roomId: ROOM, clientId: "me", x: 9, y: 9, color: "#222222" });
    engine.receive({ type: "cursor", roomId: "other", clientId: "b", x: 9, y: 9, color: "#333333" });
    expect(engine.getCursors()).toEqual([{ clientId: "a", x: 1, y: 2, color: "#111111" }]);
  });

  it("forgets the cursor of someone who left the room", () => {
    const { engine } = makeEngine();
    engine.receive({ type: "cursor", roomId: ROOM, clientId: "a", x: 1, y: 2, color: "#111111" });
    engine.receive(presence("me"));
    expect(engine.getCursors()).toEqual([]);
  });

  it("shows a drag preview until an ack for that shape arrives", () => {
    const { engine } = makeEngine();
    engine.receive(ack(1, remoteCreate("s1", 100)));
    engine.receive({ type: "drag_preview", roomId: ROOM, clientId: "a", shapeId: "s1", changes: { x: 5 } });
    expect(engine.getPreviews()).toHaveLength(1);

    engine.receive(ack(2, remoteUpdate("s1", { x: 5 }, 200, "commit")));
    expect(engine.getPreviews()).toEqual([]);
  });

  it("keeps one preview per client and shape, replacing it with the newest", () => {
    const { engine } = makeEngine();
    const preview = (x: number): ServerMessage => ({
      type: "drag_preview",
      roomId: ROOM,
      clientId: "a",
      shapeId: "s1",
      changes: { x },
    });
    engine.receive(preview(1));
    engine.receive(preview(2));
    expect(engine.getPreviews().map((p) => p.changes)).toEqual([{ x: 2 }]);
  });

  it("expires previews that have not been refreshed within the TTL", () => {
    const { engine, setNow } = makeEngine({ previewTtlMs: 500 });
    engine.receive({ type: "drag_preview", roomId: ROOM, clientId: "a", shapeId: "s1", changes: { x: 1 } });
    setNow(1499);
    engine.expirePreviews();
    expect(engine.getPreviews()).toHaveLength(1);
    setNow(1500);
    engine.expirePreviews();
    expect(engine.getPreviews()).toEqual([]);
  });

  it("forgets presence, cursors and previews on disconnect, but keeps pending edits", () => {
    const { engine } = makeEngine();
    created(engine);
    engine.receive(presence("me", "a"));
    engine.receive({ type: "cursor", roomId: ROOM, clientId: "a", x: 1, y: 2, color: "#111111" });
    engine.receive({ type: "drag_preview", roomId: ROOM, clientId: "a", shapeId: "s1", changes: { x: 1 } });

    engine.onDisconnected();
    expect(engine.getPresence()).toEqual([]);
    expect(engine.getCursors()).toEqual([]);
    expect(engine.getPreviews()).toEqual([]);
    expect(engine.getPending()).toHaveLength(1);
  });
});

describe("subscriptions", () => {
  it("notifies on local edits, acks and ephemeral updates, and stops after unsubscribe", () => {
    const { engine } = makeEngine();
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);

    const op = created(engine);
    expect(listener).toHaveBeenCalledTimes(1);
    engine.receive(ack(1, stamped(op, 100)));
    expect(listener).toHaveBeenCalledTimes(2);
    engine.receive({ type: "cursor", roomId: ROOM, clientId: "a", x: 1, y: 1, color: "#111111" });
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    created(engine, "other");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not notify when a disconnect changes nothing", () => {
    const { engine } = makeEngine();
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.onDisconnected();
    expect(listener).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { parseServerMessage } from "./parse-server-message";

const hlc = { physical: 100, logical: 0, nodeId: "server" };
const fields = { x: 1, y: 2, width: 3, height: 4, color: "#fff" };
const base = { shapeId: "s1", roomId: "r", opId: "o1", hlc };
const shape = { ...fields, lastHlc: { x: hlc, y: hlc, width: hlc, height: hlc, color: hlc } };

const valid: Record<string, unknown> = {
  op_ack_create: { type: "op_ack", roomId: "r", seq: 1, op: { type: "create_shape", ...base, fields } },
  op_ack_update: {
    type: "op_ack",
    roomId: "r",
    seq: 2,
    op: { type: "update_shape", ...base, changes: { x: 5 } },
  },
  op_ack_delete: { type: "op_ack", roomId: "r", seq: 3, op: { type: "delete_shape", ...base } },
  op_reject: { type: "op_reject", opId: "o1", reason: "unknown_shape" },
  error: { type: "error", code: "unsupported_protocol", message: "nope" },
  presence: { type: "presence", roomId: "r", clients: [{ clientId: "a", color: "#fff" }] },
  empty_presence: { type: "presence", roomId: "r", clients: [] },
  snapshot: { type: "sync_snapshot", roomId: "r", latestSeq: 4, shapes: { s1: shape } },
  snapshot_with_tombstone: {
    type: "sync_snapshot",
    roomId: "r",
    latestSeq: 4,
    shapes: { s1: { ...shape, deletedAt: hlc } },
  },
  empty_snapshot: { type: "sync_snapshot", roomId: "r", latestSeq: 0, shapes: {} },
  cursor: { type: "cursor", roomId: "r", clientId: "a", x: 1, y: 2, color: "#fff" },
  drag_preview: { type: "drag_preview", roomId: "r", clientId: "a", shapeId: "s1", changes: { x: 1, y: 2 } },
};

describe("parseServerMessage: accepts every well-formed server message", () => {
  it.each(Object.entries(valid))("%s", (_name, message) => {
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts a snapshot containing a shape whose id is __proto__", () => {
    const text = `{"type":"sync_snapshot","roomId":"r","latestSeq":1,"shapes":{"__proto__":${JSON.stringify(shape)}}}`;
    expect(parseServerMessage(text)).not.toBeNull();
  });
});

describe("parseServerMessage: the limit-related reasons and codes", () => {
  it.each(["rate_limited", "room_full", "server_full"])("accepts an op_reject for %s", (reason) => {
    expect(parseServerMessage(JSON.stringify({ type: "op_reject", opId: "o1", reason }))).not.toBeNull();
  });

  it.each(["room_full", "server_busy", "rate_limited", "invalid_room"])(
    "accepts an error with code %s",
    (code) => {
      expect(parseServerMessage(JSON.stringify({ type: "error", code, message: "m" }))).not.toBeNull();
    },
  );
});

describe("parseServerMessage: rejects anything else", () => {
  it.each([
    ["not JSON", "{nope"],
    ["empty string", ""],
    ["a bare number", "5"],
    ["null", "null"],
    ["an array", "[]"],
    ["no type", "{}"],
    ["an unknown type", JSON.stringify({ type: "reboot" })],
    ["a client-only message", JSON.stringify({ type: "join_room", roomId: "r", clientId: "a", sinceSeq: 0 })],
  ])("%s", (_name, text) => {
    expect(parseServerMessage(text)).toBeNull();
  });

  const tweak = (name: string, change: (message: Record<string, unknown>) => void): [string, string] => {
    const copy = JSON.parse(JSON.stringify(valid[name])) as Record<string, unknown>;
    change(copy);
    return [name, JSON.stringify(copy)];
  };

  it.each([
    ["op_ack with seq 0", ...tweak("op_ack_create", (m) => (m.seq = 0))],
    ["op_ack with a fractional seq", ...tweak("op_ack_create", (m) => (m.seq = 1.5))],
    ["op_ack with a string seq", ...tweak("op_ack_create", (m) => (m.seq = "1"))],
    ["op_ack with no op", ...tweak("op_ack_create", (m) => delete m.op)],
    [
      "op_ack whose op has an unknown type",
      ...tweak("op_ack_create", (m) => ((m.op as { type: string }).type = "explode")),
    ],
    [
      "op_ack whose create has no fields",
      ...tweak("op_ack_create", (m) => delete (m.op as { fields?: unknown }).fields),
    ],
    [
      "op_ack whose create has a non-numeric x",
      ...tweak("op_ack_create", (m) => ((m.op as { fields: { x: unknown } }).fields.x = "1")),
    ],
    [
      "op_ack whose hlc is malformed",
      ...tweak("op_ack_create", (m) => ((m.op as { hlc: unknown }).hlc = { physical: -1 })),
    ],
    [
      "op_ack whose update has empty changes",
      ...tweak("op_ack_update", (m) => ((m.op as { changes: unknown }).changes = {})),
    ],
    [
      "op_ack whose update has an unknown field",
      ...tweak("op_ack_update", (m) => ((m.op as { changes: unknown }).changes = { rotation: 1 })),
    ],
    [
      "op_ack whose update has a mistyped field",
      ...tweak("op_ack_update", (m) => ((m.op as { changes: unknown }).changes = { color: 7 })),
    ],
    ["op_reject with an unknown reason", ...tweak("op_reject", (m) => (m.reason = "because"))],
    ["op_reject with no opId", ...tweak("op_reject", (m) => delete m.opId)],
    ["error with an unknown code", ...tweak("error", (m) => (m.code = "teapot"))],
    ["error with no message", ...tweak("error", (m) => delete m.message)],
    ["presence whose clients is not an array", ...tweak("presence", (m) => (m.clients = {}))],
    ["presence with a malformed client", ...tweak("presence", (m) => (m.clients = [{ clientId: "a" }]))],
    ["snapshot with a negative latestSeq", ...tweak("snapshot", (m) => (m.latestSeq = -1))],
    ["snapshot with shapes as an array", ...tweak("snapshot", (m) => (m.shapes = []))],
    [
      "snapshot whose shape lacks lastHlc",
      ...tweak("snapshot", (m) => delete (m.shapes as { s1: { lastHlc?: unknown } }).s1.lastHlc),
    ],
    [
      "snapshot whose shape has a partial lastHlc",
      ...tweak("snapshot", (m) => delete (m.shapes as { s1: { lastHlc: { x?: unknown } } }).s1.lastHlc.x),
    ],
    [
      "snapshot whose tombstone is malformed",
      ...tweak("snapshot", (m) => ((m.shapes as { s1: { deletedAt?: unknown } }).s1.deletedAt = 5)),
    ],
    ["cursor with a non-numeric x", ...tweak("cursor", (m) => (m.x = "1"))],
    ["cursor with an infinite x encoded as null", ...tweak("cursor", (m) => (m.x = null))],
    ["drag_preview with empty changes", ...tweak("drag_preview", (m) => (m.changes = {}))],
    ["drag_preview that changes colour", ...tweak("drag_preview", (m) => (m.changes = { color: "#fff" }))],
    ["drag_preview with no shapeId", ...tweak("drag_preview", (m) => delete m.shapeId)],
  ])("%s", (_name, _type, text) => {
    expect(parseServerMessage(text)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { parseClientMessage, rejectableOpId } from "./validation";

const hlc = { physical: 1000, logical: 0, nodeId: "client-1" };
const fields = { x: 10, y: 20, width: 90, height: 90, color: "#7fd8b0", text: "" };

const validCreate = {
  type: "create_shape",
  shapeId: "s1",
  roomId: "room1",
  kind: "rect",
  fields,
  hlc,
  opId: "op1",
};
const validUpdate = {
  type: "update_shape",
  shapeId: "s1",
  roomId: "room1",
  changes: { x: 5 },
  hlc,
  opId: "op2",
};
const validDelete = { type: "delete_shape", shapeId: "s1", roomId: "room1", hlc, opId: "op3" };
const validCursor = { type: "cursor", roomId: "room1", clientId: "c1", x: 1, y: 2, color: "#fff" };
const validDrag = {
  type: "drag_preview",
  roomId: "room1",
  clientId: "c1",
  shapeId: "s1",
  changes: { x: 1, y: 2 },
};
const validJoin = { type: "join_room", protocolVersion: 1, roomId: "room1", clientId: "c1", sinceSeq: 0 };

function omit(value: object, key: string): object {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

describe("parseClientMessage: valid messages", () => {
  it.each([
    ["create_shape", validCreate],
    ["update_shape", validUpdate],
    ["delete_shape", validDelete],
    ["cursor", validCursor],
    ["drag_preview", validDrag],
    ["join_room", validJoin],
  ])("accepts a well-formed %s", (_name, message) => {
    const result = parseClientMessage(message);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["x", 5],
    ["y", -5],
    ["width", 40],
    ["height", 0],
    ["color", "#abcdef"],
  ])("accepts an update_shape of field %s", (field, value) => {
    expect(parseClientMessage({ ...validUpdate, changes: { [field]: value } }).ok).toBe(true);
  });

  it("accepts an update_shape that changes several fields at once", () => {
    const result = parseClientMessage({
      ...validUpdate,
      changes: { x: 1, y: 2, width: 3, height: 4, color: "#fff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.message as { changes: object }).changes).toEqual({
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        color: "#fff",
      });
    }
  });

  it("strips unknown keys inside changes", () => {
    const result = parseClientMessage({ ...validUpdate, changes: { x: 1, rotation: 90 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.message as { changes: object }).changes).toEqual({ x: 1 });
  });

  it("strips unknown keys so a client cannot smuggle data into the op log", () => {
    const result = parseClientMessage({ ...validCreate, evil: "payload", fields: { ...fields, extra: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).not.toHaveProperty("evil");
      expect((result.message as { fields: object }).fields).not.toHaveProperty("extra");
    }
  });
});

describe("parseClientMessage: rejects malformed input", () => {
  it.each([
    ["null", null],
    ["a string", "hello"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["an unknown type", { type: "drop_database" }],
  ])("rejects %s", (_name, value) => {
    expect(parseClientMessage(value).ok).toBe(false);
  });

  it("rejects an op with no hlc and names the missing field", () => {
    const withoutHlc: Record<string, unknown> = { ...validCreate };
    delete withoutHlc.hlc;
    const result = parseClientMessage(withoutHlc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("hlc");
  });

  it.each([
    ["negative physical time", { ...hlc, physical: -1 }],
    ["fractional logical counter", { ...hlc, logical: 1.5 }],
    ["empty nodeId", { ...hlc, nodeId: "" }],
    ["non-numeric physical time", { ...hlc, physical: "now" }],
  ])("rejects an hlc with %s", (_name, badHlc) => {
    expect(parseClientMessage({ ...validDelete, hlc: badHlc }).ok).toBe(false);
  });

  it.each([
    ["path traversal", "../etc/passwd"],
    ["empty", ""],
    ["too long", "a".repeat(65)],
    ["whitespace", "my room"],
  ])("rejects a roomId that is %s", (_name, roomId) => {
    expect(parseClientMessage({ ...validJoin, roomId }).ok).toBe(false);
  });

  it("rejects coordinates outside the allowed range", () => {
    expect(parseClientMessage({ ...validCursor, x: 1e9 }).ok).toBe(false);
    expect(parseClientMessage({ ...validCursor, y: -1e9 }).ok).toBe(false);
  });

  it("rejects NaN and Infinity coordinates", () => {
    expect(parseClientMessage({ ...validCursor, x: NaN }).ok).toBe(false);
    expect(parseClientMessage({ ...validCursor, x: Infinity }).ok).toBe(false);
  });

  it("rejects negative width/height", () => {
    expect(parseClientMessage({ ...validCreate, fields: { ...fields, width: -1 } }).ok).toBe(false);
  });

  it("rejects colors that are not hex", () => {
    expect(parseClientMessage({ ...validCursor, color: "red" }).ok).toBe(false);
    expect(parseClientMessage({ ...validCursor, color: "url(javascript:alert(1))" }).ok).toBe(false);
  });

  it("rejects an update whose value does not match its field", () => {
    expect(parseClientMessage({ ...validUpdate, changes: { x: "ten" } }).ok).toBe(false);
    expect(parseClientMessage({ ...validUpdate, changes: { color: 7 } }).ok).toBe(false);
    expect(parseClientMessage({ ...validUpdate, changes: { x: 1, color: "red" } }).ok).toBe(false);
  });

  it.each([
    ["empty changes", {}],
    ["only unknown fields", { rotation: 5 }],
    ["not an object", 5],
    ["null", null],
  ])("rejects an update with %s", (_name, changes) => {
    expect(parseClientMessage({ ...validUpdate, changes }).ok).toBe(false);
  });

  it("rejects the old single-field update shape", () => {
    expect(
      parseClientMessage({ ...validUpdate, changes: undefined, change: { field: "x", value: 5 } }).ok,
    ).toBe(false);
  });

  it.each([
    ["empty changes", {}],
    ["a color change (previews are geometry only)", { color: "#fff" }],
    ["an out-of-range coordinate", { x: 1e9 }],
  ])("rejects a drag_preview with %s", (_name, changes) => {
    expect(parseClientMessage({ ...validDrag, changes }).ok).toBe(false);
  });

  it("rejects a drag_preview without a shapeId", () => {
    expect(parseClientMessage(omit(validDrag, "shapeId")).ok).toBe(false);
  });

  it("rejects a join_room without a numeric protocolVersion", () => {
    expect(parseClientMessage(omit(validJoin, "protocolVersion")).ok).toBe(false);
    expect(parseClientMessage({ ...validJoin, protocolVersion: "1" }).ok).toBe(false);
    expect(parseClientMessage({ ...validJoin, protocolVersion: 1.5 }).ok).toBe(false);
  });

  it("accepts a join_room with any integer protocolVersion (the server decides if it is supported)", () => {
    expect(parseClientMessage({ ...validJoin, protocolVersion: 999 }).ok).toBe(true);
  });

  it("rejects a negative or fractional sinceSeq", () => {
    expect(parseClientMessage({ ...validJoin, sinceSeq: -1 }).ok).toBe(false);
    expect(parseClientMessage({ ...validJoin, sinceSeq: 1.5 }).ok).toBe(false);
  });

  it("rejects ids longer than the limit", () => {
    expect(parseClientMessage({ ...validDelete, shapeId: "a".repeat(129) }).ok).toBe(false);
    expect(parseClientMessage({ ...validJoin, clientId: "a".repeat(129) }).ok).toBe(false);
  });
});

describe("rejectableOpId", () => {
  it.each(["create_shape", "update_shape", "delete_shape"])("returns the opId of a malformed %s", (type) => {
    expect(rejectableOpId({ type, opId: "op-1", hlc: "garbage" })).toBe("op-1");
  });

  it.each([
    ["a cursor", { type: "cursor", opId: "op-1" }],
    ["a join_room", { type: "join_room", opId: "op-1" }],
    ["an op without an opId", { type: "create_shape" }],
    ["an op with a non-string opId", { type: "create_shape", opId: 5 }],
    ["an op with an empty opId", { type: "create_shape", opId: "" }],
    ["an op with an oversized opId", { type: "create_shape", opId: "a".repeat(129) }],
    ["null", null],
    ["a string", "create_shape"],
    ["an array", []],
  ])("returns null for %s", (_name, value) => {
    expect(rejectableOpId(value)).toBeNull();
  });
});

describe("parseClientMessage: shape kinds and text", () => {
  const create = (kind: string, overrides: object = {}) => ({
    ...validCreate,
    kind,
    fields: { ...fields, ...overrides },
  });

  it.each(["rect", "ellipse", "diamond", "triangle", "line", "arrow", "text"])("accepts kind %s", (kind) => {
    expect(parseClientMessage(create(kind)).ok).toBe(true);
  });

  it("refuses an unknown kind and a missing kind", () => {
    expect(parseClientMessage(create("star")).ok).toBe(false);
    expect(parseClientMessage(omit(validCreate, "kind")).ok).toBe(false);
  });

  it.each(["line", "arrow"])("lets a %s point up and to the left (negative width and height)", (kind) => {
    expect(parseClientMessage(create(kind, { width: -80, height: -30 })).ok).toBe(true);
  });

  it.each(["rect", "ellipse", "diamond", "triangle", "text"])("refuses a %s with a negative size", (kind) => {
    expect(parseClientMessage(create(kind, { width: -1 })).ok).toBe(false);
    expect(parseClientMessage(create(kind, { height: -1 })).ok).toBe(false);
  });

  it("refuses a size beyond the world limit in either direction", () => {
    expect(parseClientMessage(create("line", { width: 1e9 })).ok).toBe(false);
    expect(parseClientMessage(create("line", { height: -1e9 })).ok).toBe(false);
  });

  it("requires text on create, and accepts up to the limit", () => {
    const { text: _text, ...withoutText } = fields;
    void _text;
    expect(parseClientMessage({ ...validCreate, fields: withoutText }).ok).toBe(false);
    expect(parseClientMessage(create("text", { text: "a".repeat(500) })).ok).toBe(true);
    expect(parseClientMessage(create("text", { text: "a".repeat(501) })).ok).toBe(false);
    expect(parseClientMessage(create("text", { text: 5 })).ok).toBe(false);
  });

  it("accepts a text-only update, and refuses an over-long one", () => {
    expect(parseClientMessage({ ...validUpdate, changes: { text: "hello\nworld" } }).ok).toBe(true);
    expect(parseClientMessage({ ...validUpdate, changes: { text: "a".repeat(501) } }).ok).toBe(false);
  });

  it("cannot change a kind through an update: the key is stripped and the update refused as empty", () => {
    expect(parseClientMessage({ ...validUpdate, changes: { kind: "arrow" } }).ok).toBe(false);
  });
});

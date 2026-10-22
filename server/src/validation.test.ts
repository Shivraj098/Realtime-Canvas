import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./validation";

const hlc = { physical: 1000, logical: 0, nodeId: "client-1" };
const fields = { x: 10, y: 20, width: 90, height: 90, color: "#7fd8b0" };

const validCreate = { type: "create_shape", shapeId: "s1", roomId: "room1", fields, hlc, opId: "op1" };
const validUpdate = {
  type: "update_shape",
  shapeId: "s1",
  roomId: "room1",
  change: { field: "x", value: 5 },
  hlc,
  opId: "op2",
};
const validDelete = { type: "delete_shape", shapeId: "s1", roomId: "room1", hlc, opId: "op3" };
const validCursor = { type: "cursor", roomId: "room1", clientId: "c1", x: 1, y: 2, color: "#fff" };
const validJoin = { type: "join_room", roomId: "room1", clientId: "c1", sinceSeq: 0 };

describe("parseClientMessage: valid messages", () => {
  it.each([
    ["create_shape", validCreate],
    ["update_shape", validUpdate],
    ["delete_shape", validDelete],
    ["cursor", validCursor],
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
    expect(parseClientMessage({ ...validUpdate, change: { field, value } }).ok).toBe(true);
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
    expect(parseClientMessage({ ...validUpdate, change: { field: "x", value: "ten" } }).ok).toBe(false);
    expect(parseClientMessage({ ...validUpdate, change: { field: "color", value: 7 } }).ok).toBe(false);
  });

  it("rejects an update to a field that does not exist", () => {
    expect(parseClientMessage({ ...validUpdate, change: { field: "rotation", value: 5 } }).ok).toBe(false);
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

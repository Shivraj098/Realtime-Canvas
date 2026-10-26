import {
  SHAPE_FIELD_KEYS,
  type ErrorCode,
  type HlcTimestamp,
  type Op,
  type OpRejectReason,
  type ServerMessage,
  type ShapeSnapshot,
} from "@realtime-canvas/shared";

/**
 * Checks a frame from the server before the rest of the client trusts it.
 * The server is far more trusted than a client is, but a proxy, a bug, or a
 * version skew can still deliver something unexpected, and a malformed
 * message must be dropped here rather than throw deep inside the state
 * code. The checks cover the shape of every field the client reads; they do
 * not re-check business rules (ranges, lengths) - the server already
 * enforced those.
 */

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonNegativeInt = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

function isHlc(value: unknown): value is HlcTimestamp {
  return (
    isRecord(value) &&
    isNonNegativeInt(value.physical) &&
    isNonNegativeInt(value.logical) &&
    isString(value.nodeId)
  );
}

function fieldHasRightType(key: (typeof SHAPE_FIELD_KEYS)[number], value: unknown): boolean {
  return key === "color" ? isString(value) : isNumber(value);
}

function isShapeFields(value: unknown): boolean {
  return isRecord(value) && SHAPE_FIELD_KEYS.every((key) => fieldHasRightType(key, value[key]));
}

/** A partial set of fields: only known keys, each of the right type, at least one. */
function isChanges(value: unknown, allowed: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        allowed.includes(key) && fieldHasRightType(key as (typeof SHAPE_FIELD_KEYS)[number], value[key]),
    )
  );
}

function isOp(value: unknown): value is Op {
  if (!isRecord(value)) return false;
  if (!isString(value.shapeId) || !isString(value.roomId) || !isString(value.opId) || !isHlc(value.hlc)) {
    return false;
  }
  switch (value.type) {
    case "create_shape":
      return isShapeFields(value.fields);
    case "update_shape":
      return isChanges(value.changes, SHAPE_FIELD_KEYS);
    case "delete_shape":
      return true;
    default:
      return false;
  }
}

function isShapeSnapshot(value: unknown): value is ShapeSnapshot {
  if (!isShapeFields(value)) return false;
  const shape = value as Rec;
  if (!isRecord(shape.lastHlc) || !SHAPE_FIELD_KEYS.every((key) => isHlc((shape.lastHlc as Rec)[key])))
    return false;
  return shape.deletedAt === undefined || isHlc(shape.deletedAt);
}

const REJECT_REASONS: readonly OpRejectReason[] = [
  "invalid",
  "not_joined",
  "shape_exists",
  "unknown_shape",
  "rate_limited",
  "room_full",
  "server_full",
];
const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_message",
  "not_joined",
  "already_joined",
  "unsupported_protocol",
  "room_full",
  "server_busy",
  "rate_limited",
  "invalid_room",
];

function validate(value: unknown): ServerMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "op_ack":
      return isString(value.roomId) &&
        Number.isInteger(value.seq) &&
        (value.seq as number) >= 1 &&
        isOp(value.op)
        ? (value as unknown as ServerMessage)
        : null;
    case "op_reject":
      return isString(value.opId) && REJECT_REASONS.includes(value.reason as OpRejectReason)
        ? (value as unknown as ServerMessage)
        : null;
    case "error":
      return ERROR_CODES.includes(value.code as ErrorCode) && isString(value.message)
        ? (value as unknown as ServerMessage)
        : null;
    case "presence":
      return isString(value.roomId) &&
        Array.isArray(value.clients) &&
        value.clients.every((c) => isRecord(c) && isString(c.clientId) && isString(c.color))
        ? (value as unknown as ServerMessage)
        : null;
    case "sync_snapshot":
      return isString(value.roomId) &&
        isNonNegativeInt(value.latestSeq) &&
        isRecord(value.shapes) &&
        Object.values(value.shapes).every(isShapeSnapshot)
        ? (value as unknown as ServerMessage)
        : null;
    case "cursor":
      return isString(value.roomId) &&
        isString(value.clientId) &&
        isNumber(value.x) &&
        isNumber(value.y) &&
        isString(value.color)
        ? (value as unknown as ServerMessage)
        : null;
    case "drag_preview":
      return isString(value.roomId) &&
        isString(value.clientId) &&
        isString(value.shapeId) &&
        isChanges(value.changes, ["x", "y", "width", "height"])
        ? (value as unknown as ServerMessage)
        : null;
    default:
      return null;
  }
}

/** Parses one text frame. Returns null for anything that is not a well-formed server message. */
export function parseServerMessage(text: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return validate(value);
}

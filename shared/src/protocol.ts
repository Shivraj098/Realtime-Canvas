import type { HlcTimestamp } from "./hlc";

/**
 * The wire protocol. Defined once, imported by both client and server, so
 * the two sides can never silently drift apart on message shape.
 *
 * Design decision: ops and the ephemeral messages (cursors, drag previews)
 * are deliberately different message families with different guarantees,
 * not one generic "event" type:
 *  - Ops are persisted, ordered by HLC, and reconciled field-by-field.
 *    They represent durable state (a shape existing, its position).
 *  - Cursor updates and drag previews are ephemeral, high-frequency, never
 *    persisted, and don't need causal ordering - only the latest value per
 *    user matters. Giving them HLC/persistence machinery would be pure
 *    overhead for data that's stale within a second anyway.
 *
 * Transport: one WebSocket, JSON text frames only.
 */

/**
 * Version of this wire contract, sent by the client in `join_room`. The
 * server refuses a join with a different version (see `ProtocolError`), so
 * a tab left open across a deploy fails loudly instead of misbehaving.
 * Bump it on any change an older peer could not understand.
 */
export const PROTOCOL_VERSION = 1;

/** WebSocket close code the server uses after refusing an unsupported protocol version. A client must not auto-reconnect on it: retrying cannot succeed until the client is updated. */
export const CLOSE_UNSUPPORTED_PROTOCOL = 4001;

export type ShapeFields = {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
};

/** Every shape field, in a fixed order, for code that iterates fields deterministically. */
export const SHAPE_FIELD_KEYS = [
  "x",
  "y",
  "width",
  "height",
  "color",
] as const satisfies readonly (keyof ShapeFields)[];

/**
 * One or more field changes applied under a single timestamp. Each field
 * is still its own LWW register, so two users editing different fields of
 * the same shape (one drags it, one recolors it) don't clobber each other
 * - only a genuine same-field conflict needs HLC comparison. Grouping the
 * fields of one gesture (a drag changes x and y together) into one op
 * halves the log growth of a move and makes it atomic. Must not be empty.
 */
export type ShapeChanges = Partial<ShapeFields>;

/** The subset of fields a drag or resize gesture can preview. */
export type GeometryChanges = Partial<Pick<ShapeFields, "x" | "y" | "width" | "height">>;

export type Op =
  | {
      type: "create_shape";
      shapeId: string;
      roomId: string;
      fields: ShapeFields;
      hlc: HlcTimestamp;
      opId: string;
    }
  | {
      type: "update_shape";
      shapeId: string;
      roomId: string;
      changes: ShapeChanges;
      hlc: HlcTimestamp;
      opId: string;
    }
  | { type: "delete_shape"; shapeId: string; roomId: string; hlc: HlcTimestamp; opId: string };

export type CursorUpdate = {
  type: "cursor";
  roomId: string;
  clientId: string;
  x: number;
  y: number;
  color: string;
};

/**
 * Ephemeral, never persisted: where a remote user is currently dragging or
 * resizing a shape, so others see smooth movement without every pointer
 * move becoming an op in the log. The dragger commits the final position
 * with ONE `update_shape` op on pointer-up. Receivers should show the
 * preview over the shape's committed state and discard it when an
 * `op_ack` for that shape arrives or after a short timeout (the dragger
 * may cancel or disconnect; there is no explicit "drag ended" message).
 */
export type DragPreview = {
  type: "drag_preview";
  roomId: string;
  clientId: string;
  shapeId: string;
  changes: GeometryChanges;
};

/** Client -> server: join a room, optionally resuming from a known
 * sequence number so the server only replays what was missed instead of
 * dumping full state. */
export type JoinRoom = {
  type: "join_room";
  /** Must equal `PROTOCOL_VERSION`. */
  protocolVersion: number;
  roomId: string;
  clientId: string;
  /** Highest op sequence number this client has already applied, or 0 for
   * a fresh join with no history. */
  sinceSeq: number;
};

/**
 * Server -> client: this op has been durably appended to the room's log
 * at this sequence number.
 *
 * A client may see the same ack more than once (for example a replay on
 * reconnect, then the re-ack for an op it re-sent because it never saw the
 * first one). Acks for a room are delivered in `seq` order, so a client
 * should ignore any ack whose `seq` is not above the last one it applied.
 */
export type OpAck = {
  type: "op_ack";
  roomId: string;
  seq: number;
  op: Op;
};

export type OpRejectReason =
  /** The op did not pass validation. */
  | "invalid"
  /** The connection has not joined a room yet. */
  | "not_joined"
  /** `create_shape` for a shapeId that exists or was deleted (ids are never reused). */
  | "shape_exists"
  /** `update_shape` / `delete_shape` for a shape that does not exist or is deleted. */
  | "unknown_shape";

/**
 * Server -> client: this specific op was refused and nothing was stored.
 * The client should drop it from its pending queue (retrying the same op
 * would be refused again) and, if it had applied it optimistically, roll
 * that back.
 */
export type OpReject = {
  type: "op_reject";
  opId: string;
  reason: OpRejectReason;
};

export type ErrorCode = "invalid_message" | "not_joined" | "already_joined" | "unsupported_protocol";

/** Server -> client: a problem with the connection or a non-op message. Nothing was stored. */
export type ProtocolError = {
  type: "error";
  code: ErrorCode;
  message: string;
};

export type Presence = {
  type: "presence";
  roomId: string;
  clients: { clientId: string; color: string }[];
};

/** A shape as the server keeps it: field values, the HLC of each field's last write, and a tombstone when deleted. */
export type ShapeSnapshot = ShapeFields & {
  lastHlc: Record<keyof ShapeFields, HlcTimestamp>;
  /** Present once the shape has been deleted. Deleted shapes stay in state as tombstones so a replayed `create` cannot bring them back. Render only shapes without it. */
  deletedAt?: HlcTimestamp;
};

/** Sent once after join_room on a fresh join: the full current shape
 * state (including tombstones), so the client doesn't have to replay the
 * whole op history itself. On a reconnect (0 < sinceSeq <= latestSeq) the
 * server skips this and sends only the missed OpAck messages instead. */
export type SyncSnapshot = {
  type: "sync_snapshot";
  roomId: string;
  shapes: Record<string, ShapeSnapshot>;
  latestSeq: number;
};

export type ClientMessage = Op | CursorUpdate | DragPreview | JoinRoom;
export type ServerMessage =
  OpAck | OpReject | ProtocolError | Presence | SyncSnapshot | CursorUpdate | DragPreview;

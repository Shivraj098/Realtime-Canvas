import type { HlcTimestamp } from "./hlc";

/**
 * The wire protocol. Defined once, imported by both client and server, so
 * the two sides can never silently drift apart on message shape.
 *
 * Design decision: ops and cursor updates are deliberately different
 * message families with different guarantees, not one generic "event"
 * type:
 *  - Ops are persisted, ordered by HLC, and reconciled field-by-field.
 *    They represent durable state (a shape existing, its position).
 *  - Cursor updates are ephemeral, high-frequency, never persisted, and
 *    don't need causal ordering — only the latest position per user
 *    matters. Giving them HLC/persistence machinery would be pure
 *    overhead for data that's stale within a second anyway.
 */

export type ShapeFields = {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
};

/** A single field-level change, so two users editing different fields of
 * the same shape (one drags it, one recolors it) don't clobber each
 * other — only a genuine same-field conflict needs HLC comparison. */
export type FieldChange = {
  [K in keyof ShapeFields]: { field: K; value: ShapeFields[K] };
}[keyof ShapeFields];

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
      change: FieldChange;
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

/** Client -> server: join a room, optionally resuming from a known
 * sequence number so the server only replays what was missed instead of
 * dumping full state. */
export type JoinRoom = {
  type: "join_room";
  roomId: string;
  clientId: string;
  /** Highest op sequence number this client has already applied, or 0 for
   * a fresh join with no history. */
  sinceSeq: number;
};

/** Server -> client: this op has been durably appended to the room's log
 * at this sequence number. */
export type OpAck = {
  type: "op_ack";
  roomId: string;
  seq: number;
  op: Op;
};

export type Presence = {
  type: "presence";
  roomId: string;
  clients: { clientId: string; color: string }[];
};

/** Sent once after join_room on a fresh join: the full current shape
 * state, so the client doesn't have to replay the whole op history
 * itself. On a reconnect (sinceSeq > 0) the server skips this and sends
 * only the missed OpAck messages instead. */
export type SyncSnapshot = {
  type: "sync_snapshot";
  roomId: string;
  shapes: Record<string, ShapeFields & { lastHlc: Record<keyof ShapeFields, HlcTimestamp> }>;
  latestSeq: number;
};

export type ClientMessage = Op | CursorUpdate | JoinRoom;
export type ServerMessage = OpAck | Presence | SyncSnapshot | CursorUpdate;
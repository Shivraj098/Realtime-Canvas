import { z } from "zod";
import { isLinearKind, MAX_TEXT_LENGTH, SHAPE_KINDS, type ClientMessage } from "@realtime-canvas/shared";

/**
 * Runtime validation for everything a client can send.
 *
 * TypeScript types disappear at runtime: `JSON.parse(raw) as ClientMessage`
 * only *claims* the shape, it does not check it. A single frame with a
 * missing field (say, an op with no `hlc`) would throw deep inside the
 * handler and, uncaught, take down the whole process - and with it every
 * room. So the network boundary validates first, and everything past this
 * file can rely on the types being true.
 *
 * Limits are deliberate, not cosmetic: bounded ids and coordinates keep a
 * hostile client from bloating the op log or the in-memory room state.
 */

const MAX_ID_LENGTH = 128;
const COORDINATE_LIMIT = 1_000_000;

const id = z.string().min(1).max(MAX_ID_LENGTH);
const roomId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 chars of A-Z a-z 0-9 _ -");
const coordinate = z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT);
// Boxes never have a negative size, but the vector of a line or arrow does. Whether a
// negative is allowed depends on the shape's kind: checked on create below, and for an
// update against the stored shape (see `geometryProblem`).
const dimension = z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT);
const text = z.string().max(MAX_TEXT_LENGTH);
const kind = z.enum(SHAPE_KINDS);
const color = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex color like #7fd8b0");

const hlc = z.object({
  physical: z.number().int().min(0),
  logical: z.number().int().min(0),
  nodeId: id,
});

const shapeFields = z.object({
  x: coordinate,
  y: coordinate,
  width: dimension,
  height: dimension,
  color,
  text,
});

const atLeastOneField = (value: object): boolean => Object.keys(value).length > 0;

// Unknown keys are stripped first, then the emptiness check runs, so an
// object containing only junk keys is refused rather than accepted as a no-op.
const shapeChanges = z
  .object({
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
    color: color.optional(),
    text: text.optional(),
  })
  .refine(atLeastOneField, "must change at least one field");

const geometryChanges = z
  .object({
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: dimension.optional(),
    height: dimension.optional(),
  })
  .refine(atLeastOneField, "must change at least one field");

const opBase = { shapeId: id, roomId, hlc, opId: id };

const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("create_shape"), ...opBase, kind, fields: shapeFields })
    .refine(
      (op) => isLinearKind(op.kind) || (op.fields.width >= 0 && op.fields.height >= 0),
      "a box cannot have a negative width or height",
    ),
  z.object({ type: z.literal("update_shape"), ...opBase, changes: shapeChanges }),
  z.object({ type: z.literal("delete_shape"), ...opBase }),
  z.object({ type: z.literal("cursor"), roomId, clientId: id, x: coordinate, y: coordinate, color }),
  z.object({ type: z.literal("drag_preview"), roomId, clientId: id, shapeId: id, changes: geometryChanges }),
  z.object({
    type: z.literal("join_room"),
    protocolVersion: z.number().int().min(0),
    roomId,
    clientId: id,
    sinceSeq: z.number().int().min(0),
  }),
]);

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; error: string };

/**
 * Validates an already-JSON-parsed value. Unknown keys are stripped, so
 * a client cannot smuggle extra data into the persisted op log. The
 * `ClientMessage` return type doubles as a compile-time check that this
 * schema can never accept something the shared protocol doesn't allow.
 */
export function parseClientMessage(value: unknown): ParseResult {
  const result = clientMessageSchema.safeParse(value);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  const issue = result.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(message)";
  return { ok: false, error: `${path}: ${issue?.message ?? "invalid"}` };
}

const OP_TYPES = new Set(["create_shape", "update_shape", "delete_shape"]);

/**
 * When a frame failed validation, tells whether it was recognisably an op
 * and returns its `opId`, so the server can answer with an `op_reject` the
 * client can match to its pending op. Without it a client would wait
 * forever on an op the server silently dropped. Returns null for anything
 * that is not an op with a usable id.
 */
export function rejectableOpId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, opId } = value as { type?: unknown; opId?: unknown };
  if (typeof type !== "string" || !OP_TYPES.has(type)) return null;
  if (typeof opId !== "string" || opId.length < 1 || opId.length > MAX_ID_LENGTH) return null;
  return opId;
}

import { z } from "zod";
import type { ClientMessage } from "@realtime-canvas/shared";

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
const dimension = z.number().min(0).max(COORDINATE_LIMIT);
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
});

const fieldChange = z.discriminatedUnion("field", [
  z.object({ field: z.literal("x"), value: coordinate }),
  z.object({ field: z.literal("y"), value: coordinate }),
  z.object({ field: z.literal("width"), value: dimension }),
  z.object({ field: z.literal("height"), value: dimension }),
  z.object({ field: z.literal("color"), value: color }),
]);

const opBase = { shapeId: id, roomId, hlc, opId: id };

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_shape"), ...opBase, fields: shapeFields }),
  z.object({ type: z.literal("update_shape"), ...opBase, change: fieldChange }),
  z.object({ type: z.literal("delete_shape"), ...opBase }),
  z.object({ type: z.literal("cursor"), roomId, clientId: id, x: coordinate, y: coordinate, color }),
  z.object({ type: z.literal("join_room"), roomId, clientId: id, sinceSeq: z.number().int().min(0) }),
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

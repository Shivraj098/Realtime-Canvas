import { compareHlc, type HlcTimestamp } from "./hlc";
import type { ShapeFields, Op } from "./protocol";

/**
 * Per-field Last-Write-Wins registers, ordered by Hybrid Logical Clock.
 *
 * Each *field* of a shape (x, y, width, height, color) is its own LWW
 * register with its own HLC timestamp — not the shape as a whole. That
 * distinction matters: if user A drags a shape (changing x, y) while
 * user B recolors it (changing color) at the same time, both edits
 * survive, because they touch different registers. Only a genuine
 * same-field conflict (two users dragging the same shape simultaneously)
 * needs the HLC comparison to decide a winner.
 *
 * This is intentionally simpler than a general-purpose CRDT (no merge of
 * concurrent structural edits, no tombstone GC for deletes at scale) —
 * see the project README for why that scope is the right call here.
 */

export type ShapeState = ShapeFields & {
  lastHlc: Record<keyof ShapeFields, HlcTimestamp>;
};

export type RoomState = Record<string, ShapeState>;

/** Applies one op to room state, returning a new state object (state is
 * treated as immutable so callers can diff by reference).
 *
 * Important scope limitation, deliberate: this function assumes ops
 * arrive in an order where a shape's create precedes its updates/delete.
 * It is NOT tolerant of arbitrary out-of-order delivery for causally
 * dependent ops - an update for a shape that hasn't been created yet is
 * silently dropped rather than buffered (see reconcile.test.ts for a
 * regression test of this exact behavior). This system gets away with
 * that because the server's op log (see server/src/op-log.ts) is the
 * single ordering authority: every client applies ops in the order the
 * server assigned them, so this situation doesn't arise in practice. A
 * general-purpose CRDT designed for true peer-to-peer delivery with no
 * ordering authority would need to buffer out-of-order ops or use
 * tombstones instead - intentionally out of scope here. */
export function applyOp(state: RoomState, op: Op): RoomState {
  switch (op.type) {
    case "create_shape": {
      const existing = state[op.shapeId];
      if (existing) return state; // duplicate/replayed create - no-op
      const lastHlc = {} as Record<keyof ShapeFields, HlcTimestamp>;
      for (const key of Object.keys(op.fields) as (keyof ShapeFields)[]) {
        lastHlc[key] = op.hlc;
      }
      return { ...state, [op.shapeId]: { ...op.fields, lastHlc } };
    }
    case "update_shape": {
      const existing = state[op.shapeId];
      if (!existing) return state; // update for a shape we don't know (e.g. deleted) - drop
      const { field, value } = op.change;
      const currentHlc = existing.lastHlc[field];
      // The actual conflict resolution: only apply if this op's HLC is
      // causally later than the last write to this exact field.
      if (compareHlc(op.hlc, currentHlc) <= 0) return state;
      return {
        ...state,
        [op.shapeId]: {
          ...existing,
          [field]: value,
          lastHlc: { ...existing.lastHlc, [field]: op.hlc },
        },
      };
    }
    case "delete_shape": {
      if (!state[op.shapeId]) return state;
      const next = { ...state };
      delete next[op.shapeId];
      return next;
    }
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

export function applyOps(state: RoomState, ops: Op[]): RoomState {
  return ops.reduce(applyOp, state);
}

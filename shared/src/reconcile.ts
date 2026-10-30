import { compareHlc, type HlcTimestamp } from "./hlc";
import { SHAPE_FIELD_KEYS, type Op, type ShapeFields, type ShapeSnapshot } from "./protocol";

/**
 * Per-field Last-Write-Wins registers, ordered by Hybrid Logical Clock.
 *
 * Each *field* of a shape (x, y, width, height, color, text) is its own LWW
 * register with its own HLC timestamp - not the shape as a whole. That
 * distinction matters: if user A drags a shape (changing x, y) while
 * user B recolors it (changing color) at the same time, both edits
 * survive, because they touch different registers. Only a genuine
 * same-field conflict (two users dragging the same shape simultaneously)
 * needs the HLC comparison to decide a winner.
 *
 * Deletion is the one non-LWW rule: a delete leaves a tombstone and wins
 * over any update, whatever its timestamp. A deleted shape stays deleted,
 * so replaying an old `create` (or a late `update`) cannot resurrect it.
 * Tombstones are never garbage-collected - that needs a "every replica has
 * seen this" signal, which is out of scope for this project.
 *
 * This is intentionally simpler than a general-purpose CRDT (no merge of
 * concurrent structural edits) - see the project README for why that
 * scope is the right call here.
 */

export type ShapeState = ShapeSnapshot;

export type RoomState = Record<string, ShapeState>;

/**
 * Own-property lookup. Shape ids come from clients, and a plain
 * `state[id]` would also find inherited members: `state["constructor"]`
 * is a function, which would make a create for that id look like a
 * duplicate and an update for it throw.
 */
export function getShape(state: RoomState, shapeId: string): ShapeState | undefined {
  return Object.hasOwn(state, shapeId) ? state[shapeId] : undefined;
}

export function isDeleted(shape: ShapeState): boolean {
  return shape.deletedAt !== undefined;
}

/** The shapes to render: everything except tombstones. */
export function liveShapes(state: RoomState): RoomState {
  const live: RoomState = {};
  for (const [shapeId, shape] of Object.entries(state)) {
    if (!isDeleted(shape)) live[shapeId] = shape;
  }
  return live;
}

/** Applies one op to room state, returning a new state object (state is
 * treated as immutable so callers can diff by reference). A no-op returns
 * the very same reference.
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
 * ordering authority would need to buffer out-of-order ops instead -
 * intentionally out of scope here. */
export function applyOp(state: RoomState, op: Op): RoomState {
  switch (op.type) {
    case "create_shape": {
      // Live or tombstoned: ids are never reused, and a replayed create must not resurrect a deleted shape.
      if (getShape(state, op.shapeId)) return state;
      const lastHlc = {} as Record<keyof ShapeFields, HlcTimestamp>;
      for (const key of SHAPE_FIELD_KEYS) lastHlc[key] = op.hlc;
      return { ...state, [op.shapeId]: { ...op.fields, kind: op.kind, lastHlc } };
    }
    case "update_shape": {
      const existing = getShape(state, op.shapeId);
      if (!existing || isDeleted(existing)) return state; // unknown or deleted shape - drop
      const applied: Partial<ShapeFields> = {};
      const lastHlc = { ...existing.lastHlc };
      let changed = false;
      for (const key of SHAPE_FIELD_KEYS) {
        const value = op.changes[key];
        if (value === undefined) continue;
        // The actual conflict resolution, per field: only apply if this op's
        // HLC is causally later than the last write to this exact field.
        if (compareHlc(op.hlc, existing.lastHlc[key]) <= 0) continue;
        (applied as Record<string, unknown>)[key] = value;
        lastHlc[key] = op.hlc;
        changed = true;
      }
      if (!changed) return state;
      return { ...state, [op.shapeId]: { ...existing, ...applied, lastHlc } };
    }
    case "delete_shape": {
      const existing = getShape(state, op.shapeId);
      if (!existing || isDeleted(existing)) return state;
      return { ...state, [op.shapeId]: { ...existing, deletedAt: op.hlc } };
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

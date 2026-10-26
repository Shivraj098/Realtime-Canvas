import Database from "better-sqlite3";
import type { Op, RoomState } from "@realtime-canvas/shared";

export type StoredOp = { seq: number; op: Op };

/** A room's materialized state as of op `seq`, saved so a room can be loaded without replaying its whole log. */
export type StoredSnapshot = { seq: number; state: RoomState };

/** `duplicate` carries the op as originally stored, so a retry can be answered with its real sequence number. */
export type AppendResult = { status: "appended"; seq: number } | ({ status: "duplicate" } & StoredOp);

/**
 * Append-only operation log, persisted to SQLite. This is what lets a
 * client that drops for 30 seconds resync by replaying exactly what it
 * missed, instead of the server sending a full state dump on every
 * reconnect - the same idea behind event sourcing and write-ahead logs
 * in real distributed systems, scoped down to "one file, one table".
 *
 * Each row gets a monotonically increasing `seq` per room. A reconnecting
 * client says "I've seen up to seq N", and the server reads
 * `WHERE room_id = ? AND seq > N` - a single indexed range scan (the
 * primary key doubles as that index).
 *
 * Ops are also idempotent by `opId`: a client that retries an op it never
 * saw acknowledged must not apply it twice. A replayed update would
 * otherwise get a fresh, later server timestamp and could silently
 * overwrite a newer edit from someone else. The UNIQUE (room_id, op_id)
 * constraint makes the retry a no-op, and the stored row lets the server
 * tell the retrying client which sequence number its op already has.
 *
 * Alongside the log, a `snapshots` table keeps one saved state per room.
 * It is a cache, never the truth: the log is never trimmed, and a missing
 * or unreadable snapshot just means the room is rebuilt from the whole log.
 * With one, loading a room replays only the ops after the snapshot.
 */
export class OpLog {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly findByOpIdStmt: Database.Statement;
  private readonly selectSinceStmt: Database.Statement;
  private readonly maxSeqStmt: Database.Statement;
  private readonly saveSnapshotStmt: Database.Statement;
  private readonly loadSnapshotStmt: Database.Statement;
  private total: number;
  private readonly appendTx: (roomId: string, op: Op) => AppendResult;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ops (
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        op_id TEXT NOT NULL,
        op_json TEXT NOT NULL,
        PRIMARY KEY (room_id, seq),
        UNIQUE (room_id, op_id)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        room_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO ops (room_id, seq, op_id, op_json) VALUES (@roomId, @seq, @opId, @opJson)`,
    );
    this.findByOpIdStmt = this.db.prepare(
      `SELECT seq, op_json FROM ops WHERE room_id = @roomId AND op_id = @opId`,
    );
    this.selectSinceStmt = this.db.prepare(
      `SELECT seq, op_json FROM ops WHERE room_id = @roomId AND seq > @sinceSeq ORDER BY seq ASC`,
    );
    this.maxSeqStmt = this.db.prepare(`SELECT MAX(seq) AS maxSeq FROM ops WHERE room_id = @roomId`);
    this.saveSnapshotStmt = this.db.prepare(
      `INSERT OR REPLACE INTO snapshots (room_id, seq, state_json) VALUES (@roomId, @seq, @stateJson)`,
    );
    this.loadSnapshotStmt = this.db.prepare(`SELECT seq, state_json FROM snapshots WHERE room_id = @roomId`);
    // Counted once at startup, then kept in step by append(): the global cap
    // is checked on every op, and COUNT(*) on a large table is not free.
    this.total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ops`).get() as { n: number }).n;

    // Check-for-duplicate, read the next seq, and insert as one atomic
    // unit, so the sequence can never be handed out twice.
    this.appendTx = this.db.transaction((roomId: string, op: Op): AppendResult => {
      const existing = this.find(roomId, op.opId);
      if (existing) {
        return { status: "duplicate", ...existing };
      }
      const seq = this.latestSeq(roomId) + 1;
      this.insertStmt.run({ roomId, seq, opId: op.opId, opJson: JSON.stringify(op) });
      return { status: "appended", seq };
    });
  }

  /** Ops stored across every room. */
  totalOps(): number {
    return this.total;
  }

  /** Throws if the database cannot be read. For health checks. */
  ping(): void {
    this.db.prepare(`SELECT 1`).get();
  }

  /** Highest sequence number in the room, or 0 if it has no ops yet. */
  latestSeq(roomId: string): number {
    const row = this.maxSeqStmt.get({ roomId }) as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  }

  /** The op already stored under this opId in the room, with its sequence number, or null. */
  find(roomId: string, opId: string): StoredOp | null {
    const row = this.findByOpIdStmt.get({ roomId, opId }) as { seq: number; op_json: string } | undefined;
    return row ? { seq: row.seq, op: JSON.parse(row.op_json) as Op } : null;
  }

  /**
   * Appends an op, assigning it the next sequence number for the room.
   * Returns `duplicate` (and stores nothing) if this opId was already
   * appended to the room.
   */
  append(roomId: string, op: Op): AppendResult {
    const result = this.appendTx(roomId, op);
    if (result.status === "appended") this.total += 1;
    return result;
  }

  /** Saves the room's state as of `seq`, replacing any earlier snapshot. */
  saveSnapshot(roomId: string, seq: number, state: RoomState): void {
    this.saveSnapshotStmt.run({ roomId, seq, stateJson: JSON.stringify(state) });
  }

  /** The room's saved snapshot, or null if it has none. Throws if the stored JSON is unreadable. */
  loadSnapshot(roomId: string): StoredSnapshot | null {
    const row = this.loadSnapshotStmt.get({ roomId }) as { seq: number; state_json: string } | undefined;
    return row ? { seq: row.seq, state: JSON.parse(row.state_json) as RoomState } : null;
  }

  /** All ops after `sinceSeq`, in order - what a reconnecting client needs to catch up. */
  since(roomId: string, sinceSeq: number): StoredOp[] {
    const rows = this.selectSinceStmt.all({ roomId, sinceSeq }) as { seq: number; op_json: string }[];
    return rows.map((row) => ({ seq: row.seq, op: JSON.parse(row.op_json) as Op }));
  }

  close(): void {
    this.db.close();
  }
}

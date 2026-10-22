import Database from "better-sqlite3";
import type { Op } from "@realtime-canvas/shared";

export type AppendResult = { status: "appended"; seq: number } | { status: "duplicate" };

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
 * constraint makes the retry a no-op.
 */
export class OpLog {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly findOpIdStmt: Database.Statement;
  private readonly selectSinceStmt: Database.Statement;
  private readonly maxSeqStmt: Database.Statement;
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
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO ops (room_id, seq, op_id, op_json) VALUES (@roomId, @seq, @opId, @opJson)`,
    );
    this.findOpIdStmt = this.db.prepare(`SELECT 1 FROM ops WHERE room_id = @roomId AND op_id = @opId`);
    this.selectSinceStmt = this.db.prepare(
      `SELECT seq, op_json FROM ops WHERE room_id = @roomId AND seq > @sinceSeq ORDER BY seq ASC`,
    );
    this.maxSeqStmt = this.db.prepare(`SELECT MAX(seq) AS maxSeq FROM ops WHERE room_id = @roomId`);

    // Check-for-duplicate, read the next seq, and insert as one atomic
    // unit, so the sequence can never be handed out twice.
    this.appendTx = this.db.transaction((roomId: string, op: Op): AppendResult => {
      if (this.findOpIdStmt.get({ roomId, opId: op.opId })) {
        return { status: "duplicate" };
      }
      const seq = this.latestSeq(roomId) + 1;
      this.insertStmt.run({ roomId, seq, opId: op.opId, opJson: JSON.stringify(op) });
      return { status: "appended", seq };
    });
  }

  /** Highest sequence number in the room, or 0 if it has no ops yet. */
  latestSeq(roomId: string): number {
    const row = this.maxSeqStmt.get({ roomId }) as { maxSeq: number | null };
    return row.maxSeq ?? 0;
  }

  /**
   * Appends an op, assigning it the next sequence number for the room.
   * Returns `duplicate` (and stores nothing) if this opId was already
   * appended to the room.
   */
  append(roomId: string, op: Op): AppendResult {
    return this.appendTx(roomId, op);
  }

  /** All ops after `sinceSeq`, in order - what a reconnecting client needs to catch up. */
  since(roomId: string, sinceSeq: number): { seq: number; op: Op }[] {
    const rows = this.selectSinceStmt.all({ roomId, sinceSeq }) as { seq: number; op_json: string }[];
    return rows.map((row) => ({ seq: row.seq, op: JSON.parse(row.op_json) as Op }));
  }

  close(): void {
    this.db.close();
  }
}

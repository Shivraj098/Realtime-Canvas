import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { applyOps, liveShapes } from "@realtime-canvas/shared";
import { Harness, ROOM, type TestClient } from "./test-support/harness";
import { seededRandom, sleep } from "./test-support/rng";

/**
 * End-to-end: real clients, a real server, real sockets, real SQLite.
 * Faults are injected around the sockets (see faulty-network.ts).
 *
 * Waiting is always for a condition ("every client has applied the whole
 * log"), never for a fixed time, so the tests are as fast as the system
 * and do not depend on how slow the machine is.
 */

let harness: Harness | null = null;

function start(): Harness {
  harness = Harness.start();
  return harness;
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

/** Everything that must be true once the system is quiet. */
function expectConverged(h: Harness): void {
  const log = h.opLog.since(ROOM, 0);
  const truth = applyOps(
    {},
    log.map((stored) => stored.op),
  );

  // The log is gap-free and holds each op once.
  expect(log.map((stored) => stored.seq)).toEqual(log.map((_, index) => index + 1));
  const loggedIds = log.map((stored) => stored.op.opId);
  expect(new Set(loggedIds).size).toBe(loggedIds.length);

  const rejected = new Set<string>();
  for (const c of h.clients) {
    // Same state as the server, tombstones included, and nothing left over.
    expect(c.engine.getConfirmed(), `${c.name} confirmed state`).toEqual(truth);
    expect(c.engine.getLiveShapes(), `${c.name} view`).toEqual(liveShapes(truth));
    expect(c.engine.getPending(), `${c.name} pending`).toEqual([]);
    expect(c.engine.getLastSeq(), `${c.name} seq`).toBe(log.length);
    for (const id of c.rejectedOpIds) rejected.add(id);
  }

  // No op is lost, and none is both applied and refused.
  const logged = new Set(loggedIds);
  for (const c of h.clients) {
    for (const opId of c.issued) {
      const isLogged = logged.has(opId);
      const isRejected = c.rejectedOpIds.includes(opId);
      expect(isLogged || isRejected, `${c.name}'s op ${opId} was neither applied nor rejected`).toBe(true);
      expect(isLogged && isRejected, `${c.name}'s op ${opId} was both applied and rejected`).toBe(false);
    }
  }
}

/**
 * Like `expectConverged`, but for runs where the server asked for retries. An op
 * refused as "too fast" and accepted on a retry is both rejected (once or more)
 * and applied, which `expectConverged` forbids for ops refused for good.
 */
function expectConvergedAllowingRetries(h: Harness): void {
  const log = h.opLog.since(ROOM, 0);
  const truth = applyOps(
    {},
    log.map((stored) => stored.op),
  );
  const loggedIds = new Set(log.map((stored) => stored.op.opId));
  expect(loggedIds.size).toBe(log.length);
  for (const c of h.clients) {
    expect(c.engine.getConfirmed(), `${c.name} confirmed state`).toEqual(truth);
    expect(c.engine.getPending(), `${c.name} pending`).toEqual([]);
    expect(c.engine.getLastSeq()).toBe(log.length);
    for (const opId of c.issued) expect(loggedIds.has(opId), `${c.name}'s op ${opId} was lost`).toBe(true);
  }
}

function created(c: TestClient, fields = {}, shapeId?: string): string {
  const result = c.create(fields, shapeId);
  if (!result.ok) throw new Error(`create failed: ${result.reason}`);
  return result.op.shapeId;
}

describe("clients sharing a room", () => {
  it("see each other's shapes, and know who else is present", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    await h.waitUntil(
      () => alice.engine.getPresence().length === 2 && bob.engine.getPresence().length === 2,
      "presence",
    );

    const id = created(alice);
    await h.settle();
    expect(bob.engine.getLiveShapes()[id]).toMatchObject({ width: 20 });
    expectConverged(h);
  });

  it("settle concurrent edits to the same field on the server's order", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    const id = created(alice);
    await h.settle();

    alice.update(id, { x: 111 });
    bob.update(id, { x: 222 });
    await h.settle();

    const updates = h.opLog.since(ROOM, 0).filter((stored) => stored.op.type === "update_shape");
    expect(updates).toHaveLength(2);
    const last = updates.at(-1)!.op;
    expect(last.type === "update_shape" && alice.engine.getLiveShapes()[id]?.x).toBe(
      last.type === "update_shape" ? last.changes.x : undefined,
    );
    expectConverged(h);
  });

  it("keep concurrent edits to different fields of one shape", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    const id = created(alice);
    await h.settle();

    alice.update(id, { x: 5, y: 6 });
    bob.update(id, { color: "#ff0000" });
    await h.settle();

    expect(alice.engine.getLiveShapes()[id]).toMatchObject({ x: 5, y: 6, color: "#ff0000" });
    expectConverged(h);
  });

  it("share drag previews, and drop one once the drag is committed", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    const id = created(alice);
    await h.settle();

    alice.client.sendDragPreview(id, { x: 40, y: 50 });
    await h.waitUntil(() => bob.engine.getPreviews().length === 1, "bob to see the preview");
    expect(bob.engine.getPreviews()[0]).toMatchObject({
      clientId: "alice",
      shapeId: id,
      changes: { x: 40, y: 50 },
    });

    alice.update(id, { x: 40, y: 50 });
    await h.waitUntil(() => bob.engine.getPreviews().length === 0, "the preview to clear on commit");
    expectConverged(h);
  });
});

describe("connection trouble", () => {
  it("resumes from the log, not a snapshot, after a dropped connection", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    created(alice);
    await h.settle();
    expect(alice.net.received.sync_snapshot).toBe(1);

    alice.net.sever();
    created(bob, {}, "while-alice-was-away-1");
    created(bob, {}, "while-alice-was-away-2");
    await h.settle();

    expect(alice.net.connections).toBeGreaterThanOrEqual(2);
    expect(alice.net.received.sync_snapshot).toBe(1); // no second snapshot: only the missed ops were replayed
    expect(Object.keys(alice.engine.getLiveShapes())).toContain("while-alice-was-away-2");
    expectConverged(h);
  });

  it("applies an op exactly once when its acknowledgement was lost", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const id = created(alice);
    await h.settle();

    alice.net.mode = "drop-inbound"; // the server will hear her, but she will not hear it
    const result = alice.update(id, { x: 77 });
    if (!result.ok) throw new Error("update failed");
    await h.waitUntil(() => h.opLog.find(ROOM, result.op.opId) !== null, "the server to store the op");
    expect(alice.engine.getPending()).toHaveLength(1); // she does not know yet

    alice.net.heal();
    await h.settle();

    const stored = h.opLog.since(ROOM, 0).filter((entry) => entry.op.opId === result.op.opId);
    expect(stored).toHaveLength(1);
    expect(alice.engine.getLiveShapes()[id]?.x).toBe(77);
    expectConverged(h);
  });

  it("delivers an op the server never received once the connection is replaced", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const id = created(alice);
    await h.settle();

    alice.net.mode = "drop-outbound";
    const result = alice.update(id, { x: 88 });
    if (!result.ok) throw new Error("update failed");
    expect(alice.net.dropped.outbound).toBe(1);
    expect(h.opLog.find(ROOM, result.op.opId)).toBeNull(); // it really never arrived

    alice.net.heal();
    await h.settle();
    expect(h.opLog.find(ROOM, result.op.opId)).not.toBeNull();
    expect(alice.engine.getLiveShapes()[id]?.x).toBe(88);
    expectConverged(h);
  });

  it("keeps edits made while offline and sends them when the client connects", async () => {
    const h = start();
    const alice = h.addClient("alice", { connect: false });
    const first = created(alice);
    const second = created(alice);
    alice.update(first, { x: 9 });
    expect(alice.engine.getPending()).toHaveLength(3);

    alice.client.connect();
    await h.settle();
    expect(h.opLog.latestSeq(ROOM)).toBe(3);
    expect(alice.engine.getLiveShapes()[first]?.x).toBe(9);
    expect(Object.keys(alice.engine.getLiveShapes()).sort()).toEqual([first, second].sort());
    expectConverged(h);
  });

  it("rolls back an edit the server refuses because someone else deleted the shape", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    const id = created(alice);
    await h.settle();

    alice.net.mode = "drop-inbound"; // alice cannot see bob's delete
    bob.remove(id);
    await h.waitUntil(() => h.opLog.latestSeq(ROOM) === 2, "the delete to be stored");
    const edit = alice.update(id, { x: 5 });
    if (!edit.ok) throw new Error("update failed");
    expect(alice.engine.getLiveShapes()[id]?.x).toBe(5); // optimistic

    alice.net.heal();
    await h.settle();

    expect(alice.rejectedOpIds).toContain(edit.op.opId);
    expect(alice.engine.getLiveShapes()[id]).toBeUndefined();
    expectConverged(h);
  });

  it("recovers by itself when it notices a hole in the stream of acks", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    created(alice);
    await h.settle();

    alice.net.mode = "drop-inbound";
    created(bob, {}, "lost-1");
    created(bob, {}, "lost-2");
    await h.waitUntil(() => h.opLog.latestSeq(ROOM) === 3, "bob's ops to be stored");
    alice.net.mode = "ok"; // the link returns WITHOUT a reconnect, so the next ack skips seq 2 and 3
    created(bob, {}, "visible");
    await h.settle();

    expect(alice.events).toContainEqual({ type: "resync_requested" });
    expect(Object.keys(alice.engine.getLiveShapes())).toEqual(
      expect.arrayContaining(["lost-1", "lost-2", "visible"]),
    );
    expectConverged(h);
  });

  it("does not reconnect in a loop when the server refuses its protocol version", async () => {
    const h = start();
    const outdated = h.addClient("outdated", { protocolVersion: 999 });
    await h.waitUntil(() => outdated.client.getStatus() === "unsupported_protocol", "the refusal");
    await sleep(30); // the one place a wait is the point: nothing may happen
    expect(outdated.net.connections).toBe(1);
    expect(outdated.client.getStatus()).toBe("unsupported_protocol");
  });

  it("gives a client that joins late the same state as the clients that were there all along", async () => {
    const h = start();
    const alice = h.addClient("alice");
    const id = created(alice);
    alice.update(id, { x: 1 });
    created(alice);
    alice.remove(id);
    await h.settle();

    h.addClient("late");
    await h.settle();
    expectConverged(h);
  });
});

describe("a server that limits what it will accept", () => {
  it("gets a long offline queue through a rate limit without losing or doubling anything", async () => {
    // Ten ops at once, then 200 a second: far below what the client's catch-up sends in its first burst.
    const h = (harness = Harness.start({
      limits: { opsBurst: 10, opsPerSecond: 200, violationsBeforeClose: 100_000 },
    }));
    const alice = h.addClient("alice", { connect: false });
    for (let i = 0; i < 100; i++) created(alice);
    expect(alice.engine.getPending()).toHaveLength(100);

    alice.client.connect();
    await h.settle();

    expect(h.opLog.latestSeq(ROOM)).toBe(100);
    // The server really did push back, and the client treated that as "wait", not as "give up".
    const slowedDown = alice.events.filter((e) => e.type === "op_rejected" && e.reason === "rate_limited");
    expect(slowedDown.length).toBeGreaterThan(0);
    expect(slowedDown.every((e) => e.type === "op_rejected" && e.retryable)).toBe(true);
    expect(alice.rejectedOpIds.length).toBeGreaterThan(0);
    expectConvergedAllowingRetries(h);
  });

  it("refuses shapes beyond a room's limit, rolls them back, and keeps everyone in agreement", async () => {
    const h = (harness = Harness.start({ limits: { maxShapesPerRoom: 3 } }));
    const alice = h.addClient("alice");
    const bob = h.addClient("bob");
    await h.waitUntil(
      () => alice.client.getStatus() === "open" && bob.client.getStatus() === "open",
      "both online",
    );

    for (let i = 0; i < 5; i++) created(i % 2 === 0 ? alice : bob);
    await h.settle();

    expect(Object.keys(alice.engine.getLiveShapes())).toHaveLength(3);
    expect(Object.keys(bob.engine.getLiveShapes())).toHaveLength(3);
    const refused = [...alice.events, ...bob.events].filter(
      (e) => e.type === "op_rejected" && e.reason === "room_full",
    );
    expect(refused).toHaveLength(2);
    expect(refused.every((e) => e.type === "op_rejected" && !e.retryable)).toBe(true);
    expectConverged(h);
  });
});

describe("property: any mix of edits and network failures converges", () => {
  const color = fc.constantFrom("#111111", "#222222", "#333333", "#444444");

  const action = fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("create" as const),
        who: fc.nat(2),
        color,
        shape: fc.constantFrom("rect", "ellipse", "diamond", "triangle", "line", "arrow", "text"),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("relabel" as const),
        who: fc.nat(2),
        target: fc.nat(),
        text: fc.constantFrom("", "a", "two words", "line\nbreak"),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("flip" as const),
        who: fc.nat(2),
        target: fc.nat(),
        width: fc.integer({ min: -300, max: 300 }),
        height: fc.integer({ min: -300, max: 300 }),
      }),
    },
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant("move" as const),
        who: fc.nat(2),
        target: fc.nat(),
        x: fc.integer({ min: 0, max: 900 }),
        y: fc.integer({ min: 0, max: 900 }),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("recolor" as const),
        who: fc.nat(2),
        target: fc.nat(),
        color,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant("delete" as const), who: fc.nat(2), target: fc.nat() }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("partition" as const),
        who: fc.nat(2),
        mode: fc.constantFrom("drop-inbound" as const, "drop-outbound" as const, "drop-both" as const),
      }),
    },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("heal" as const), who: fc.nat(2) }) },
    // The link comes back WITHOUT a new connection: acks that were lost leave a hole in the stream.
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("mend" as const), who: fc.nat(2) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("blip" as const), who: fc.nat(2) }) },
    // Composite faults that random sequences almost never line up by chance.
    // `gap`: someone misses a few acks, then the link returns WITHOUT reconnecting, so the next ack skips ahead.
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("gap" as const),
        who: fc.nat(2),
        lost: fc.integer({ min: 1, max: 3 }),
      }),
    },
    // `stale`: someone edits a shape that another client has just deleted, without knowing it yet.
    {
      weight: 3,
      arbitrary: fc.record({ kind: fc.constant("stale" as const), who: fc.nat(2), target: fc.nat() }),
    },
    {
      weight: 2,
      arbitrary: fc.record({ kind: fc.constant("pause" as const), ms: fc.integer({ min: 0, max: 4 }) }),
    },
  );

  const SEED = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

  it("leaves every client, the server's log and a brand-new joiner in the same state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(action, { minLength: 5, maxLength: 30 }),
        fc.integer(),
        async (actions, netSeed) => {
          const h = Harness.start();
          try {
            const random = seededRandom(netSeed);
            const delayMs = () => Math.floor(random() * 3);
            const clients = [0, 1, 2].map((i) => h.addClient(`client${i}`, { delayMs }));

            const pick = (c: TestClient, target: number): string | null => {
              const ids = Object.keys(c.engine.getLiveShapes());
              return ids.length === 0 ? null : (ids[target % ids.length] ?? null);
            };

            for (const step of actions) {
              if (step.kind === "pause") {
                await sleep(step.ms);
                continue;
              }
              const c = clients[step.who]!;
              switch (step.kind) {
                case "create":
                  c.create({ color: step.color }, undefined, step.shape);
                  break;
                case "relabel": {
                  const id = pick(c, step.target);
                  if (id) c.update(id, { text: step.text });
                  break;
                }
                case "flip": {
                  // Only lines may point backwards; for a box the client refuses it, which is part of the test.
                  const id = pick(c, step.target);
                  if (id) c.update(id, { width: step.width, height: step.height });
                  break;
                }
                case "move": {
                  const id = pick(c, step.target);
                  if (id) c.update(id, { x: step.x, y: step.y });
                  break;
                }
                case "recolor": {
                  const id = pick(c, step.target);
                  if (id) c.update(id, { color: step.color });
                  break;
                }
                case "delete": {
                  const id = pick(c, step.target);
                  if (id) c.remove(id);
                  break;
                }
                case "partition":
                  c.net.mode = step.mode;
                  break;
                case "heal":
                  c.net.heal();
                  break;
                case "mend":
                  c.net.mode = "ok";
                  break;
                case "gap": {
                  const others = clients.filter((other) => other !== c);
                  const before = h.opLog.latestSeq(ROOM);
                  c.net.mode = "drop-inbound";
                  for (let i = 0; i < step.lost; i++) others[i % others.length]!.create();
                  await h
                    .waitUntil(() => h.opLog.latestSeq(ROOM) >= before + step.lost, "acks to be lost", 300)
                    .catch(() => {});
                  c.net.mode = "ok";
                  others[0]!.create();
                  break;
                }
                case "stale": {
                  const id = pick(c, step.target);
                  const other = clients[(step.who + 1) % clients.length]!;
                  if (!id || !other.engine.getLiveShapes()[id]) break;
                  c.net.mode = "drop-inbound";
                  const before = h.opLog.latestSeq(ROOM);
                  other.remove(id);
                  await h
                    .waitUntil(() => h.opLog.latestSeq(ROOM) > before, "the delete to be stored", 300)
                    .catch(() => {});
                  c.update(id, { x: 1 });
                  c.net.heal();
                  break;
                }
                case "blip":
                  c.net.sever();
                  break;
              }
              await new Promise((resolve) => setImmediate(resolve)); // let traffic move between actions
            }

            for (const c of clients) c.net.heal();
            h.addClient("fresh-joiner");
            await h.settle();
            expectConverged(h);
          } finally {
            await h.stop();
          }
        },
      ),
      { numRuns: 25, ...(SEED !== undefined && { seed: SEED }) },
    );
  }, 120_000);
});

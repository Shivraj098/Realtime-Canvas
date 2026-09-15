import { describe, expect, it } from "vitest";
import { HybridLogicalClock, compareHlc } from "./hlc";

describe("HybridLogicalClock.tick", () => {
  it("advances physical time and resets logical when wall clock moves forward", () => {
    let now = 1000;
    const clock = new HybridLogicalClock("a", () => now);
    const t1 = clock.tick();
    expect(t1).toEqual({ physical: 1000, logical: 0, nodeId: "a" });

    now = 2000;
    const t2 = clock.tick();
    expect(t2).toEqual({ physical: 2000, logical: 0, nodeId: "a" });
  });

  it("increments the logical counter when physical time does not advance", () => {
    const now = 1000;
    const clock = new HybridLogicalClock("a", () => now);
    const t1 = clock.tick();
    const t2 = clock.tick();
    const t3 = clock.tick();
    expect([t1.logical, t2.logical, t3.logical]).toEqual([0, 1, 2]);
    expect([t1.physical, t2.physical, t3.physical]).toEqual([1000, 1000, 1000]);
  });

  it("never produces a timestamp that goes backward even if the wall clock does", () => {
    let now = 5000;
    const clock = new HybridLogicalClock("a", () => now);
    const t1 = clock.tick();
    now = 1000; // clock jumps backward (e.g. NTP correction)
    const t2 = clock.tick();
    expect(compareHlc(t2, t1)).toBeGreaterThan(0);
  });
});

describe("HybridLogicalClock.update", () => {
  it("adopts the remote physical time when it is ahead of both local and wall clock", () => {
    const clock = new HybridLogicalClock("local", () => 1000);
    const result = clock.update({ physical: 9000, logical: 3, nodeId: "remote" });
    expect(result.physical).toBe(9000);
    expect(result.logical).toBe(4); // remote.logical + 1
  });

  it("never lets the local clock fall behind a remote event it has observed", () => {
    const clock = new HybridLogicalClock("local", () => 1000);
    clock.update({ physical: 9000, logical: 3, nodeId: "remote" });
    // A subsequent local tick, even with a stale wall clock, must stay
    // causally after the observed remote event.
    const localTick = clock.tick();
    expect(localTick.physical).toBeGreaterThanOrEqual(9000);
  });

  it("breaks ties by taking the max logical counter + 1 when physical times match exactly", () => {
    const clock = new HybridLogicalClock("local", () => 5000);
    // Advance local logical counter first.
    clock.tick(); // physical 5000, logical 0
    clock.tick(); // physical 5000, logical 1
    const result = clock.update({ physical: 5000, logical: 4, nodeId: "remote" });
    expect(result.logical).toBe(5); // max(1, 4) + 1
  });
});

describe("compareHlc", () => {
  it("orders by physical time first", () => {
    const a = { physical: 100, logical: 5, nodeId: "z" };
    const b = { physical: 200, logical: 0, nodeId: "a" };
    expect(compareHlc(a, b)).toBeLessThan(0);
  });

  it("falls back to logical counter when physical times are equal", () => {
    const a = { physical: 100, logical: 1, nodeId: "z" };
    const b = { physical: 100, logical: 2, nodeId: "a" };
    expect(compareHlc(a, b)).toBeLessThan(0);
  });

  it("falls back to nodeId as the final deterministic tie-break", () => {
    const a = { physical: 100, logical: 1, nodeId: "a" };
    const b = { physical: 100, logical: 1, nodeId: "b" };
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, a)).toBeGreaterThan(0);
  });

  it("is a strict total order: exactly one of a<b, a>b, a==b holds for any pair", () => {
    const samples = [
      { physical: 1, logical: 0, nodeId: "a" },
      { physical: 1, logical: 0, nodeId: "b" },
      { physical: 1, logical: 1, nodeId: "a" },
      { physical: 2, logical: 0, nodeId: "a" },
    ];
    for (const a of samples) {
      for (const b of samples) {
        const cmp = compareHlc(a, b);
        const reverse = compareHlc(b, a);
        if (cmp === 0) expect(reverse).toBe(0);
        else expect(Math.sign(cmp)).toBe(-Math.sign(reverse));
      }
    }
  });
});

describe("causality property under simulated message passing", () => {
  it("orders a remote event before a local event that was caused by receiving it", () => {
    // Node A ticks, sends to B. B updates its clock on receive, then
    // ticks locally (representing "the local response to that message").
    // The local tick must compare as happening-after the received event.
    let clockTime = 1000;
    const nodeA = new HybridLogicalClock("A", () => clockTime);
    const nodeB = new HybridLogicalClock("B", () => clockTime);

    const sentByA = nodeA.tick();
    clockTime = 999; // B's wall clock is behind A's — realistic skew
    nodeB.update(sentByA);
    const respondedByB = nodeB.tick();

    expect(compareHlc(sentByA, respondedByB)).toBeLessThan(0);
  });
});
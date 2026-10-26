import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, TokenBucket } from "./limits";

function bucketAt(capacity: number, perSecond: number) {
  let now = 10_000;
  const bucket = new TokenBucket(capacity, perSecond, () => now);
  return { bucket, advance: (ms: number) => (now += ms), setNow: (value: number) => (now = value) };
}

describe("TokenBucket", () => {
  it("starts full: a burst up to the capacity is allowed", () => {
    const { bucket } = bucketAt(5, 1);
    const results = Array.from({ length: 7 }, () => bucket.tryTake());
    expect(results).toEqual([true, true, true, true, true, false, false]);
  });

  it("refills at the sustained rate", () => {
    const { bucket, advance } = bucketAt(2, 10); // one token per 100 ms
    bucket.tryTake();
    bucket.tryTake();
    expect(bucket.tryTake()).toBe(false);
    advance(99);
    expect(bucket.tryTake()).toBe(false);
    advance(1);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("never holds more than its capacity, however long it idles", () => {
    const { bucket, advance } = bucketAt(3, 100);
    advance(3_600_000);
    const allowed = Array.from({ length: 10 }, () => bucket.tryTake()).filter(Boolean).length;
    expect(allowed).toBe(3);
  });

  it("lets a client at exactly the sustained rate go on forever", () => {
    const { bucket, advance } = bucketAt(1, 20); // one every 50 ms
    for (let i = 0; i < 200; i++) {
      expect(bucket.tryTake()).toBe(true);
      advance(50);
    }
  });

  it("refuses a client above the sustained rate once the burst is spent", () => {
    const { bucket, advance } = bucketAt(10, 20);
    let refused = 0;
    for (let i = 0; i < 100; i++) {
      if (!bucket.tryTake()) refused += 1;
      advance(10); // 100 per second against an allowance of 20
    }
    expect(refused).toBeGreaterThan(50);
  });

  it("does not hand out tokens when the clock steps backwards", () => {
    const { bucket, setNow } = bucketAt(1, 1);
    bucket.tryTake();
    setNow(0); // a big step back
    expect(bucket.tryTake()).toBe(false);
  });

  it("recovers normally after a clock step back", () => {
    const { bucket, setNow, advance } = bucketAt(1, 1);
    bucket.tryTake();
    setNow(0);
    bucket.tryTake();
    advance(1000);
    expect(bucket.tryTake()).toBe(false); // time is measured from the highest time seen
    advance(10_000);
    expect(bucket.tryTake()).toBe(true);
  });
});

describe("DEFAULT_LIMITS", () => {
  it("lets a normal drag through: 30 cursor + 30 preview messages a second is well within the ephemeral allowance", () => {
    expect(DEFAULT_LIMITS.ephemeralPerSecond).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_LIMITS.ephemeralBurst).toBeGreaterThanOrEqual(DEFAULT_LIMITS.ephemeralPerSecond);
  });

  it("allows a burst of ops at least as large as the sustained rate", () => {
    expect(DEFAULT_LIMITS.opsBurst).toBeGreaterThanOrEqual(DEFAULT_LIMITS.opsPerSecond);
  });
});

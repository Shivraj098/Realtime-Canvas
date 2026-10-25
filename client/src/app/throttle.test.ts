import { describe, expect, it, vi } from "vitest";
import { FakeScheduler } from "../test-support/fake-websocket";
import { createThrottle } from "./throttle";

function setup(intervalMs = 33) {
  const scheduler = new FakeScheduler();
  let now = 1000;
  const fn = vi.fn();
  const throttled = createThrottle(fn, intervalMs, { now: () => now, scheduler });
  return { throttled, fn, scheduler, advance: (ms: number) => (now += ms) };
}

describe("createThrottle", () => {
  it("runs the first call immediately", () => {
    const { throttled, fn } = setup();
    throttled(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("holds calls inside the interval and runs the LATEST one when it ends", () => {
    const { throttled, fn, scheduler, advance } = setup();
    throttled(1);
    advance(10);
    throttled(2);
    advance(10);
    throttled(3);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingDelays).toEqual([23]); // 33 - 10: scheduled once, at the first held call

    advance(23);
    scheduler.fireNext();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it("runs a call that arrives after the interval at once, with nothing left waiting", () => {
    const { throttled, fn, scheduler, advance } = setup();
    throttled(1);
    advance(40);
    throttled(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(scheduler.pendingDelays).toEqual([]);
  });

  it("does not run a trailing call when only one call was made", () => {
    const { throttled, fn, scheduler } = setup();
    throttled(1);
    expect(scheduler.pendingDelays).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush runs the waiting call now and cancels its timer", () => {
    const { throttled, fn, scheduler, advance } = setup();
    throttled(1);
    advance(5);
    throttled(2);
    throttled.flush();
    expect(fn).toHaveBeenLastCalledWith(2);
    expect(scheduler.pendingDelays).toEqual([]);
  });

  it("flush with nothing waiting does nothing", () => {
    const { throttled, fn } = setup();
    throttled.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel drops the waiting call without running it", () => {
    const { throttled, fn, scheduler, advance } = setup();
    throttled(1);
    advance(5);
    throttled(2);
    throttled.cancel();
    expect(scheduler.pendingDelays).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps working after a trailing call", () => {
    const { throttled, fn, scheduler, advance } = setup();
    throttled(1);
    advance(5);
    throttled(2);
    advance(28);
    scheduler.fireNext();
    advance(40);
    throttled(3);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenLastCalledWith(3);
  });
});

import type { Scheduler } from "../net/types";

export type Throttled<A extends unknown[]> = {
  (...args: A): void;
  /** Run the waiting call now, if there is one. */
  flush(): void;
  /** Forget the waiting call without running it. */
  cancel(): void;
};

/**
 * Limits `fn` to one call per `intervalMs`, but never loses the last word.
 *
 * The first call goes through at once (leading edge). Calls arriving during
 * the quiet period are collapsed into one that runs when it ends, with the
 * LATEST arguments (trailing edge). The trailing call is what makes a drag
 * end where the pointer actually stopped, rather than wherever the previous
 * tick happened to catch it.
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  deps: { now: () => number; scheduler: Scheduler },
): Throttled<A> {
  let lastRun = Number.NEGATIVE_INFINITY;
  let waiting: A | null = null;
  let timer: unknown = null;

  const run = (args: A): void => {
    lastRun = deps.now();
    fn(...args);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      deps.scheduler.clearTimeout(timer);
      timer = null;
    }
  };

  const throttled = ((...args: A): void => {
    const elapsed = deps.now() - lastRun;
    if (elapsed >= intervalMs && timer === null) {
      run(args);
      return;
    }
    waiting = args;
    if (timer === null) {
      timer = deps.scheduler.setTimeout(
        () => {
          timer = null;
          const pending = waiting;
          waiting = null;
          if (pending) run(pending);
        },
        Math.max(0, intervalMs - elapsed),
      );
    }
  }) as Throttled<A>;

  throttled.flush = () => {
    clearTimer();
    const pending = waiting;
    waiting = null;
    if (pending) run(pending);
  };
  throttled.cancel = () => {
    clearTimer();
    waiting = null;
  };
  return throttled;
}

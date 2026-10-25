/**
 * The slice of the browser WebSocket API the client uses. Declared here so
 * the transport can be swapped for a fake (unit tests), a wrapper that
 * injects network faults (convergence tests), or the `ws` package (Node).
 */
export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** `WebSocket.OPEN`. */
export const WS_OPEN = 1;

/** Timers, injectable so reconnect behaviour can be tested without waiting. */
export type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The platform's WebSocket (browsers, and Node 22+). */
export function globalWebSocketConstructor(): WebSocketConstructor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") throw new Error("No global WebSocket; pass one in the options");
  return ctor as WebSocketConstructor;
}

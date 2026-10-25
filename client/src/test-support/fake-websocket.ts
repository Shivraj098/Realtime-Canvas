import type { ClientMessage, ServerMessage } from "@realtime-canvas/shared";
import type { Scheduler, WebSocketLike } from "../net/types";

/** A WebSocket the test drives by hand: no network, nothing asynchronous. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static failNextConstruction = false;

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.failNextConstruction = false;
  }

  static get latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("no socket has been created");
    return socket;
  }

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sentFrames: string[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {
    if (FakeWebSocket.failNextConstruction) {
      FakeWebSocket.failNextConstruction = false;
      throw new Error("construction failed");
    }
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(data);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  /** Everything the client sent, parsed. */
  get sent(): ClientMessage[] {
    return this.sentFrames.map((frame) => JSON.parse(frame) as ClientMessage);
  }

  // ---- the server's side -------------------------------------------------

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: ServerMessage | string | ArrayBuffer): void {
    const data =
      typeof message === "string" || message instanceof ArrayBuffer ? message : JSON.stringify(message);
    this.onmessage?.({ data });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Timers that only fire when the test says so. */
export class FakeScheduler implements Scheduler {
  private nextHandle = 1;
  private readonly timers = new Map<number, { callback: () => void; delayMs: number }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  get pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }

  /** Fires the earliest scheduled timer. */
  fireNext(): void {
    const first = this.timers.entries().next();
    if (first.done) throw new Error("no timer is scheduled");
    const [handle, timer] = first.value;
    this.timers.delete(handle);
    timer.callback();
  }
}

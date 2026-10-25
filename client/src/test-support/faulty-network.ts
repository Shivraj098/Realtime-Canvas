import type { WebSocketConstructor, WebSocketLike } from "../net/types";
import { sleep } from "./rng";

/**
 * Network faults for tests, injected around a REAL WebSocket to a REAL
 * server.
 *
 * What it can do is what real networks do to a TCP connection:
 *  - delay traffic (in order: TCP never reorders within a connection);
 *  - silently lose traffic in one or both directions while the connection
 *    still looks open (a dead Wi-Fi link, a stalled proxy);
 *  - break the connection abruptly, losing whatever was still in flight.
 * It deliberately does NOT reorder or duplicate messages within a
 * connection, because TCP cannot; duplicates in this system come from the
 * client re-sending ops after a reconnect, and the tests produce those the
 * honest way.
 */

export type NetworkMode = "ok" | "drop-inbound" | "drop-outbound" | "drop-both";

type RealSocket = WebSocketLike & { terminate?: () => void };
type RealSocketConstructor = new (url: string) => RealSocket;

export class NetworkControl {
  /** Applies to all of this client's connections, current and future. */
  mode: NetworkMode = "ok";
  readonly dropped = { inbound: 0, outbound: 0 };
  /** Server messages that reached the client, by message type. */
  readonly received: Record<string, number> = {};
  /** Connections attempted so far. */
  connections = 0;

  private readonly links = new Set<FaultyLink>();

  constructor(private readonly delayMs: () => number = () => 0) {}

  get dropsInbound(): boolean {
    return this.mode === "drop-inbound" || this.mode === "drop-both";
  }

  get dropsOutbound(): boolean {
    return this.mode === "drop-outbound" || this.mode === "drop-both";
  }

  nextDelay(): number {
    return this.delayMs();
  }

  /** Breaks every open connection abruptly. Traffic still in flight is lost. */
  sever(): void {
    for (const link of [...this.links]) link.sever();
  }

  /** Ends any outage and forces a fresh connection, as a network coming back would. */
  heal(): void {
    this.mode = "ok";
    this.sever();
  }

  register(link: FaultyLink): void {
    this.links.add(link);
    this.connections += 1;
  }

  unregister(link: FaultyLink): void {
    this.links.delete(link);
  }
}

export class FaultyLink implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  private readonly inner: RealSocket;
  private severed = false;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();

  constructor(
    url: string,
    private readonly control: NetworkControl,
    Real: RealSocketConstructor,
  ) {
    this.inner = new Real(url);
    control.register(this);

    this.inner.onopen = (event) => this.deliverIn(() => this.onopen?.(event));
    this.inner.onmessage = (event) => {
      if (this.control.dropsInbound) {
        this.control.dropped.inbound += 1;
        return;
      }
      this.deliverIn(() => {
        const type =
          typeof event.data === "string" ? (JSON.parse(event.data) as { type: string }).type : "binary";
        this.control.received[type] = (this.control.received[type] ?? 0) + 1;
        this.onmessage?.(event);
      });
    };
    this.inner.onclose = (event) => {
      this.control.unregister(this);
      this.deliverIn(() => this.onclose?.(event));
    };
    this.inner.onerror = () => {};
  }

  get readyState(): number {
    return this.severed ? 3 : this.inner.readyState;
  }

  send(data: string): void {
    if (this.control.dropsOutbound) {
      this.control.dropped.outbound += 1;
      return;
    }
    const delay = this.control.nextDelay();
    this.outbound = this.outbound.then(async () => {
      if (delay > 0) await sleep(delay);
      if (!this.severed && this.inner.readyState === 1) this.inner.send(data);
    });
  }

  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  /** The connection dies now: undelivered traffic is lost and the client sees an abnormal close. */
  sever(): void {
    if (this.severed) return;
    this.severed = true;
    this.control.unregister(this);
    if (this.inner.terminate) this.inner.terminate();
    else this.inner.close();
    this.onclose?.({ code: 1006 });
  }

  private deliverIn(deliver: () => void): void {
    const delay = this.control.nextDelay();
    this.inbound = this.inbound.then(async () => {
      if (delay > 0) await sleep(delay);
      if (!this.severed) deliver();
    });
  }
}

/** A WebSocket constructor whose connections go through `control`. */
export function faultySocketConstructor(
  control: NetworkControl,
  Real: RealSocketConstructor,
): WebSocketConstructor {
  return class extends FaultyLink {
    constructor(url: string) {
      super(url, control, Real);
    }
  };
}

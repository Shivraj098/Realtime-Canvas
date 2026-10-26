import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_ROOM_REFUSED, CLOSE_UNSUPPORTED_PROTOCOL, type ServerMessage } from "@realtime-canvas/shared";
import { FakeScheduler, FakeWebSocket } from "../test-support/fake-websocket";
import { backoffDelay, DEFAULT_BACKOFF, RoomSocket, type SocketStatus } from "./room-socket";

beforeEach(() => FakeWebSocket.reset());

function setup(random: () => number = () => 0) {
  const scheduler = new FakeScheduler();
  const statuses: SocketStatus[] = [];
  const messages: ServerMessage[] = [];
  const handlers = {
    onStatus: vi.fn((status: SocketStatus) => statuses.push(status)),
    onOpen: vi.fn(),
    onMessage: vi.fn((message: ServerMessage) => messages.push(message)),
    onClose: vi.fn(),
  };
  const socket = new RoomSocket({ url: "ws://test", WebSocket: FakeWebSocket, scheduler, random }, handlers);
  return { socket, scheduler, statuses, messages, handlers };
}

const presence: ServerMessage = { type: "presence", roomId: "r", clients: [] };

describe("backoffDelay", () => {
  it("doubles from the base up to the cap", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, DEFAULT_BACKOFF, () => 0));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it("adds up to the jitter fraction on top, never more", () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.5)).toBe(1150);
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThanOrEqual(1300);
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0.999999)).toBeLessThanOrEqual(19500);
  });

  it("stays finite for a huge attempt count", () => {
    expect(backoffDelay(5000, DEFAULT_BACKOFF, () => 0)).toBe(15000);
  });
});

describe("connecting", () => {
  it("starts idle, connects on start, and reports open", () => {
    const { socket, statuses, handlers } = setup();
    expect(socket.getStatus()).toBe("idle");
    socket.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.latest.url).toBe("ws://test");
    expect(socket.getStatus()).toBe("connecting");

    FakeWebSocket.latest.open();
    expect(statuses).toEqual(["connecting", "open"]);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it("ignores start while already connecting, open or waiting", () => {
    const { socket } = setup();
    socket.start();
    socket.start();
    FakeWebSocket.latest.open();
    socket.start();
    FakeWebSocket.latest.serverClose();
    socket.start(); // waiting to retry
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("treats a constructor that throws as a failed attempt and retries", () => {
    const { socket, scheduler } = setup();
    FakeWebSocket.failNextConstruction = true;
    socket.start();
    expect(socket.getStatus()).toBe("waiting");
    scheduler.fireNext();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("reconnecting", () => {
  it("waits, then reconnects, when the connection drops", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose(1006);

    expect(socket.getStatus()).toBe("waiting");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingDelays).toEqual([1000]);

    scheduler.fireNext();
    expect(socket.getStatus()).toBe("connecting");
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off further after each failed attempt", () => {
    const { socket, scheduler } = setup();
    socket.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      FakeWebSocket.latest.serverClose(1006); // never opens: a failed attempt
      delays.push(...scheduler.pendingDelays);
      scheduler.fireNext();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
  });

  it("starts the backoff over once the server has spoken", () => {
    const { socket, scheduler } = setup();
    socket.start();
    FakeWebSocket.latest.serverClose(); // fail 1
    scheduler.fireNext();
    FakeWebSocket.latest.serverClose(); // fail 2
    scheduler.fireNext();
    expect(socket.getAttempt()).toBe(2);

    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive(presence);
    expect(socket.getAttempt()).toBe(0);

    FakeWebSocket.latest.serverClose();
    expect(scheduler.pendingDelays).toEqual([1000]);
  });

  it("does not reset the backoff for a connection that opened but never said anything", () => {
    const { socket, scheduler } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose();
    scheduler.fireNext();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose();
    expect(scheduler.pendingDelays).toEqual([2000]);
  });

  it("does not reconnect, and says why, when the server refuses the protocol version", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose(CLOSE_UNSUPPORTED_PROTOCOL);

    expect(socket.getStatus()).toBe("unsupported_protocol");
    expect(scheduler.pendingDelays).toEqual([]);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    socket.start(); // after an update, a manual start works again
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect, and says why, when the server refuses the room itself", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.serverClose(CLOSE_ROOM_REFUSED);

    expect(socket.getStatus()).toBe("refused");
    expect(scheduler.pendingDelays).toEqual([]);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    socket.reconnectLater(); // no way back from a refusal
    socket.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(1);

    socket.start(); // unless asked again on purpose
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnectNow replaces the connection at once, without waiting", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    const old = FakeWebSocket.latest;
    socket.reconnectNow();
    expect(old.closedWith).toBe(1000);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(scheduler.pendingDelays).toEqual([]);
  });

  it("reconnectLater replaces the connection after the backoff delay", () => {
    const { socket, scheduler } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    socket.reconnectLater();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.getStatus()).toBe("waiting");
    expect(scheduler.pendingDelays).toEqual([1000]);
    scheduler.fireNext();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it.each(["reconnectNow", "reconnectLater"] as const)(
    "%s does nothing on a socket that was never started or was stopped",
    (method) => {
      const { socket } = setup();
      socket[method]();
      expect(FakeWebSocket.instances).toHaveLength(0);
      socket.start();
      socket.stop();
      socket[method]();
      expect(FakeWebSocket.instances).toHaveLength(1);
    },
  );
});

describe("retryNow", () => {
  it("cuts a backoff wait short", () => {
    const { socket, scheduler } = setup();
    socket.start();
    FakeWebSocket.latest.serverClose();
    expect(socket.getStatus()).toBe("waiting");

    socket.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.getStatus()).toBe("connecting");
    expect(scheduler.pendingDelays).toEqual([]); // the timer was cancelled, not left to fire a second attempt
  });

  it("keeps growing the backoff if the attempt it starts also fails", () => {
    const { socket, scheduler } = setup();
    socket.start();
    FakeWebSocket.latest.serverClose(); // fail 1
    socket.retryNow();
    FakeWebSocket.latest.serverClose(); // fail 2
    expect(scheduler.pendingDelays).toEqual([2000]);
  });

  it.each(["idle", "connecting", "open", "closed"] as const)("does nothing when %s", (state) => {
    const { socket } = setup();
    if (state !== "idle") socket.start();
    if (state === "open") FakeWebSocket.latest.open();
    if (state === "closed") socket.stop();
    const before = FakeWebSocket.instances.length;
    socket.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(before);
    expect(socket.getStatus()).toBe(state);
  });
});

describe("stopping", () => {
  it("closes the connection, cancels a pending retry, and stays closed", () => {
    const { socket, handlers } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    socket.stop();
    expect(FakeWebSocket.latest.closedWith).toBe(1000);
    expect(socket.getStatus()).toBe("closed");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    const waiting = setup();
    waiting.socket.start();
    FakeWebSocket.latest.serverClose();
    waiting.socket.stop();
    expect(waiting.scheduler.pendingDelays).toEqual([]);
  });

  it("ignores late events from a connection it has abandoned", () => {
    const { socket, handlers } = setup();
    socket.start();
    const old = FakeWebSocket.latest;
    old.open();
    socket.stop();

    old.receive(presence);
    old.serverClose();
    old.open();
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(socket.getStatus()).toBe("closed");
  });

  it("ignores late events from an earlier connection after reconnecting", () => {
    const { socket, handlers } = setup();
    socket.start();
    const old = FakeWebSocket.latest;
    old.open();
    socket.reconnectNow();
    FakeWebSocket.latest.open();
    handlers.onMessage.mockClear();

    old.receive(presence);
    old.serverClose();
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(socket.getStatus()).toBe("open");
  });

  it("ignores a late message from a connection that had already closed on its own", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    const old = FakeWebSocket.latest;
    old.open();
    old.serverClose(); // closed by the network, not by us: its handlers are still attached
    scheduler.fireNext();
    FakeWebSocket.latest.open();
    handlers.onMessage.mockClear();

    old.receive(presence);
    expect(handlers.onMessage).not.toHaveBeenCalled();
  });

  it("ignores a second close event from a connection that had already closed", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    const old = FakeWebSocket.latest;
    old.open();
    old.serverClose();
    scheduler.fireNext();
    FakeWebSocket.latest.open();
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    old.serverClose(); // a duplicate close must not tear down the new connection
    expect(socket.getStatus()).toBe("open");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingDelays).toEqual([]);
  });

  it("ignores a late open from a connection that has already been replaced", () => {
    const { socket, scheduler, handlers } = setup();
    socket.start();
    const old = FakeWebSocket.latest;
    old.serverClose(); // never opened; closed by the network
    scheduler.fireNext(); // a new attempt is now connecting
    expect(socket.getStatus()).toBe("connecting");

    old.open(); // a stray open from the dead attempt
    expect(socket.getStatus()).toBe("connecting");
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it("can be started again after a stop", () => {
    const { socket } = setup();
    socket.start();
    socket.stop();
    socket.start();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket.getStatus()).toBe("connecting");
  });
});

describe("messages", () => {
  it("delivers well-formed messages", () => {
    const { socket, messages } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive(presence);
    expect(messages).toEqual([presence]);
  });

  it("drops binary frames, invalid JSON and unknown messages, counting them", () => {
    const { socket, handlers } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive(new ArrayBuffer(4));
    FakeWebSocket.latest.receive("{nope");
    FakeWebSocket.latest.receive(JSON.stringify({ type: "reboot" }));
    expect(handlers.onMessage).not.toHaveBeenCalled();
    expect(socket.getDroppedFrames()).toBe(3);
    expect(socket.getStatus()).toBe("open");
  });

  it("does not treat unparseable frames as the server being healthy, so the backoff keeps growing", () => {
    const { socket, scheduler } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive(new ArrayBuffer(4));
    FakeWebSocket.latest.receive("{nope");
    FakeWebSocket.latest.serverClose(); // attempt 0 -> waits 1000
    scheduler.fireNext();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.receive("{nope");
    FakeWebSocket.latest.serverClose();
    expect(scheduler.pendingDelays).toEqual([2000]);
  });

  it("sends JSON while open, and refuses otherwise", () => {
    const { socket } = setup();
    const message = { type: "cursor", roomId: "r", clientId: "a", x: 1, y: 2, color: "#fff" } as const;
    expect(socket.send(message)).toBe(false); // never started
    socket.start();
    expect(socket.send(message)).toBe(false); // connecting
    FakeWebSocket.latest.open();
    expect(socket.send(message)).toBe(true);
    expect(FakeWebSocket.latest.sent).toEqual([message]);

    FakeWebSocket.latest.serverClose();
    expect(socket.send(message)).toBe(false); // waiting
  });

  it("reports a send that throws as not sent", () => {
    const { socket } = setup();
    socket.start();
    FakeWebSocket.latest.open();
    FakeWebSocket.latest.send = () => {
      throw new Error("boom");
    };
    expect(socket.send({ type: "cursor", roomId: "r", clientId: "a", x: 1, y: 2, color: "#fff" })).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";
import { DEFAULT_LIMITS } from "./limits";

describe("loadConfig defaults", () => {
  it("works with no environment at all", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.dbPath).toBe("./data/ops.sqlite");
    expect(config.allowedOrigins).toEqual([]);
    expect(config.limits).toEqual({});
  });

  it("leaves tuning options unset so the server's own defaults apply", () => {
    const config = loadConfig({});
    expect(config.maxPayloadBytes).toBeUndefined();
    expect(config.heartbeatIntervalMs).toBeUndefined();
    expect(config.roomIdleMs).toBeUndefined();
    expect(config.snapshotEvery).toBeUndefined();
    expect(config.minRoomIdLength).toBeUndefined();
    expect(config.joinTimeoutMs).toBeUndefined();
  });
});

describe("loadConfig values", () => {
  it("reads the basics", () => {
    const config = loadConfig({ PORT: "9000", DB_PATH: "/data/ops.sqlite" });
    expect(config.port).toBe(9000);
    expect(config.dbPath).toBe("/data/ops.sqlite");
  });

  it("accepts port 0, which asks the OS for a free port", () => {
    expect(loadConfig({ PORT: "0" }).port).toBe(0);
  });

  it("treats empty variables as unset", () => {
    const config = loadConfig({ PORT: "", DB_PATH: "  ", MAX_ROOMS: "", ALLOWED_ORIGINS: "" });
    expect(config.port).toBe(8080);
    expect(config.dbPath).toBe("./data/ops.sqlite");
    expect(config.limits).toEqual({});
  });

  it("reads every limit by its variable name", () => {
    const config = loadConfig({
      MAX_CONNECTIONS: "11",
      MAX_ROOMS: "12",
      MAX_CLIENTS_PER_ROOM: "13",
      MAX_SHAPES_PER_ROOM: "14",
      MAX_OPS_PER_ROOM: "15",
      MAX_TOTAL_OPS: "16",
      OPS_PER_SECOND: "17",
      OPS_BURST: "18",
      EPHEMERAL_PER_SECOND: "19",
      EPHEMERAL_BURST: "20",
      VIOLATIONS_BEFORE_CLOSE: "21",
    });
    expect(config.limits).toEqual({
      maxConnections: 11,
      maxRooms: 12,
      maxClientsPerRoom: 13,
      maxShapesPerRoom: 14,
      maxOpsPerRoom: 15,
      maxTotalOps: 16,
      opsPerSecond: 17,
      opsBurst: 18,
      ephemeralPerSecond: 19,
      ephemeralBurst: 20,
      violationsBeforeClose: 21,
    });
  });

  it("only sets the limits that were given", () => {
    expect(loadConfig({ MAX_ROOMS: "7" }).limits).toEqual({ maxRooms: 7 });
    expect(Object.keys(DEFAULT_LIMITS).length).toBeGreaterThan(1);
  });

  it("reads tuning options", () => {
    const config = loadConfig({
      MAX_PAYLOAD_BYTES: "2048",
      HEARTBEAT_INTERVAL_MS: "0",
      ROOM_IDLE_MS: "60000",
      JOIN_TIMEOUT_MS: "5000",
      SNAPSHOT_EVERY: "250",
      MIN_ROOM_ID_LENGTH: "22",
    });
    expect(config).toMatchObject({
      maxPayloadBytes: 2048,
      heartbeatIntervalMs: 0,
      roomIdleMs: 60_000,
      joinTimeoutMs: 5000,
      snapshotEvery: 250,
      minRoomIdLength: 22,
    });
  });

  it("splits and trims the origin list", () => {
    const config = loadConfig({ ALLOWED_ORIGINS: " https://a.example.com , https://*.b.example.com/ ,, " });
    expect(config.allowedOrigins).toEqual(["https://a.example.com", "https://*.b.example.com/"]);
  });
});

describe("loadConfig refuses bad values, naming every problem at once", () => {
  function problemsFor(env: Record<string, string>): string[] {
    try {
      loadConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as ConfigError).problems;
    }
    throw new Error("expected loadConfig to throw");
  }

  it.each([
    ["a non-numeric port", { PORT: "http" }, /PORT/],
    ["a fractional port", { PORT: "80.5" }, /PORT/],
    ["a port above 65535", { PORT: "70000" }, /PORT/],
    ["a negative limit", { MAX_ROOMS: "-1" }, /MAX_ROOMS/],
    ["a zero limit that must be positive", { MAX_SHAPES_PER_ROOM: "0" }, /MAX_SHAPES_PER_ROOM/],
    ["a limit that is not a number", { OPS_PER_SECOND: "fast" }, /OPS_PER_SECOND/],
    ["a room id minimum above the longest allowed id", { MIN_ROOM_ID_LENGTH: "65" }, /MIN_ROOM_ID_LENGTH/],
    ["a payload cap too small to hold any message", { MAX_PAYLOAD_BYTES: "10" }, /MAX_PAYLOAD_BYTES/],
    ["a malformed origin", { ALLOWED_ORIGINS: "app.example.com" }, /ALLOWED_ORIGINS/],
  ])("%s", (_name, env, pattern) => {
    expect(problemsFor(env).join("\n")).toMatch(pattern);
  });

  it("lists several problems together", () => {
    const problems = problemsFor({ PORT: "x", MAX_ROOMS: "0", ALLOWED_ORIGINS: "nope" });
    expect(problems).toHaveLength(3);
  });

  it("puts all of them in the error message", () => {
    expect(() => loadConfig({ PORT: "x", MAX_ROOMS: "0" })).toThrow(/PORT[\s\S]*MAX_ROOMS/);
  });
});

describe("loadConfig in production", () => {
  it("insists that the allowed origins are set, so open access is a decision and not an accident", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/ALLOWED_ORIGINS is empty in production/);
  });

  it("accepts a configured allowlist", () => {
    const config = loadConfig({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://app.example.com" });
    expect(config.allowedOrigins).toEqual(["https://app.example.com"]);
  });

  it("accepts an explicit opt-out", () => {
    expect(() => loadConfig({ NODE_ENV: "production", ALLOW_ANY_ORIGIN: "true" })).not.toThrow();
  });

  it("does not accept a vague opt-out value", () => {
    expect(() => loadConfig({ NODE_ENV: "production", ALLOW_ANY_ORIGIN: "yes" })).toThrow();
  });

  it("does not require the allowlist outside production", () => {
    expect(() => loadConfig({ NODE_ENV: "development" })).not.toThrow();
    expect(() => loadConfig({})).not.toThrow();
  });
});

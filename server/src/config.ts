import { DEFAULT_LIMITS, type Limits } from "./limits";
import { originPatternProblem } from "./origin";
import type { ServerOptions } from "./app";

/**
 * Turns environment variables into validated server options. Everything an
 * operator can tune is named and range-checked here, in one place, so a typo
 * fails at startup with a message listing every problem instead of showing up
 * as odd behaviour later.
 */

export type ServerConfig = Omit<ServerOptions, "logger"> & { port: number; dbPath: string };

type Env = Record<string, string | undefined>;

type IntSpec = { name: string; min: number; max: number };

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const LIMIT_VARIABLES: Record<keyof Limits, IntSpec> = {
  maxConnections: { name: "MAX_CONNECTIONS", min: 1, max: 100_000 },
  maxRooms: { name: "MAX_ROOMS", min: 1, max: 100_000 },
  maxClientsPerRoom: { name: "MAX_CLIENTS_PER_ROOM", min: 1, max: 10_000 },
  maxShapesPerRoom: { name: "MAX_SHAPES_PER_ROOM", min: 1, max: 1_000_000 },
  maxOpsPerRoom: { name: "MAX_OPS_PER_ROOM", min: 1, max: 100_000_000 },
  maxTotalOps: { name: "MAX_TOTAL_OPS", min: 1, max: 1_000_000_000 },
  opsPerSecond: { name: "OPS_PER_SECOND", min: 1, max: 10_000 },
  opsBurst: { name: "OPS_BURST", min: 1, max: 100_000 },
  ephemeralPerSecond: { name: "EPHEMERAL_PER_SECOND", min: 1, max: 100_000 },
  ephemeralBurst: { name: "EPHEMERAL_BURST", min: 1, max: 1_000_000 },
  violationsBeforeClose: { name: "VIOLATIONS_BEFORE_CLOSE", min: 1, max: 1_000_000 },
};

export function loadConfig(env: Env): ServerConfig {
  const problems: string[] = [];

  /** Reads an optional integer variable. Returns undefined when unset or empty. */
  function readInt(spec: IntSpec): number | undefined {
    const raw = env[spec.name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
      problems.push(`${spec.name}="${raw}": expected an integer from ${spec.min} to ${spec.max}`);
      return undefined;
    }
    return value;
  }

  const port = readInt({ name: "PORT", min: 0, max: 65_535 }) ?? 8080;
  const dbPath = env.DB_PATH?.trim() || "./data/ops.sqlite";

  const limits: Partial<Limits> = {};
  for (const [key, spec] of Object.entries(LIMIT_VARIABLES) as [keyof Limits, IntSpec][]) {
    const value = readInt(spec);
    if (value !== undefined) limits[key] = value;
  }
  const effective = { ...DEFAULT_LIMITS, ...limits };
  if (effective.opsBurst < 1 || effective.ephemeralBurst < 1) problems.push("burst sizes must be at least 1");

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  for (const origin of allowedOrigins) {
    const problem = originPatternProblem(origin.replace(/\/+$/, ""));
    if (problem) problems.push(`ALLOWED_ORIGINS: ${problem}`);
  }

  // In production, "any website may connect" must be a decision, not an oversight.
  if (env.NODE_ENV === "production" && allowedOrigins.length === 0 && env.ALLOW_ANY_ORIGIN !== "true") {
    problems.push(
      "ALLOWED_ORIGINS is empty in production: set it to the origins of your web app (comma-separated), or set ALLOW_ANY_ORIGIN=true to accept every origin on purpose",
    );
  }

  const config: ServerConfig = { port, dbPath, allowedOrigins, limits };

  const maxPayloadBytes = readInt({ name: "MAX_PAYLOAD_BYTES", min: 1024, max: 16 * 1024 * 1024 });
  if (maxPayloadBytes !== undefined) config.maxPayloadBytes = maxPayloadBytes;
  const heartbeat = readInt({ name: "HEARTBEAT_INTERVAL_MS", min: 0, max: 3_600_000 });
  if (heartbeat !== undefined) config.heartbeatIntervalMs = heartbeat;
  const roomIdle = readInt({ name: "ROOM_IDLE_MS", min: 1000, max: 86_400_000 });
  if (roomIdle !== undefined) config.roomIdleMs = roomIdle;
  const joinTimeout = readInt({ name: "JOIN_TIMEOUT_MS", min: 0, max: 600_000 });
  if (joinTimeout !== undefined) config.joinTimeoutMs = joinTimeout;
  const snapshotEvery = readInt({ name: "SNAPSHOT_EVERY", min: 1, max: 1_000_000 });
  if (snapshotEvery !== undefined) config.snapshotEvery = snapshotEvery;
  const minRoomIdLength = readInt({ name: "MIN_ROOM_ID_LENGTH", min: 1, max: 64 });
  if (minRoomIdLength !== undefined) config.minRoomIdLength = minRoomIdLength;

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/**
 * Room ids and the server address. A room id is the only thing protecting a
 * room (there is no authentication), so a generated one is 128 bits of
 * randomness: unguessable, which is what "anyone with the link" requires.
 */

/** Same rule the server enforces on `roomId`. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

/** 16 random bytes as 22 URL-safe characters. */
export function generateRoomId(
  fillRandom: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
): string {
  const bytes = fillRandom(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The room named by `?room=...`, or null if absent or not a usable id. */
export function roomIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("room");
  return value !== null && isValidRoomId(value) ? value : null;
}

/**
 * Where the server is. `configured` is the build-time `VITE_WS_URL`; without
 * it the client assumes a server on the same host at the server's default port,
 * which is right for local development.
 */
export function serverUrl(
  configured: string | undefined,
  location: { protocol: string; hostname: string },
): string {
  if (configured) return configured;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.hostname}:8080`;
}

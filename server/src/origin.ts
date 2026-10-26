/**
 * Which web pages may open a WebSocket to this server.
 *
 * Browsers attach an `Origin` header (the page's scheme, host and port) to
 * every WebSocket handshake, and page scripts cannot change it. Checking it
 * stops OTHER websites from using a visitor's browser to talk to this
 * server (cross-site WebSocket hijacking). It is not authentication: a
 * script outside a browser can send any Origin it likes. The room id
 * remains the only thing that protects a room.
 *
 * A pattern is `scheme://host[:port]`, optionally with `*.` at the start of
 * the host to accept any subdomain: `https://*.example.com` accepts
 * `https://a.example.com` and `https://a.b.example.com`, but neither
 * `https://example.com` itself nor `https://evil-example.com`.
 */

const PATTERN =
  /^(https?):\/\/(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;
const ORIGIN = /^(https?):\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns a problem description for a malformed pattern, or null if it is fine. */
export function originPatternProblem(pattern: string): string | null {
  return PATTERN.test(pattern.toLowerCase())
    ? null
    : `"${pattern}" is not a valid origin: expected scheme://host[:port], optionally scheme://*.host`;
}

export function compileOriginMatcher(patterns: readonly string[]): (origin: string | undefined) => boolean {
  const exact = new Set<string>();
  const wildcards: RegExp[] = [];

  for (const raw of patterns) {
    const pattern = raw.trim().toLowerCase().replace(/\/+$/, "");
    const problem = originPatternProblem(pattern);
    if (problem) throw new Error(problem);
    const match = PATTERN.exec(pattern)!;
    const [, scheme, wildcard, host, , , , port] = match;
    if (wildcard) {
      // One or more subdomain labels, then the rest of the host exactly.
      wildcards.push(
        new RegExp(
          `^${scheme}://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.${escapeForRegExp(host!)}${escapeForRegExp(port ?? "")}$`,
        ),
      );
    } else {
      exact.add(pattern);
    }
  }

  return (origin) => {
    if (origin === undefined) return false;
    const candidate = origin.trim().toLowerCase();
    if (!ORIGIN.test(candidate)) return false; // "null", paths, junk
    return exact.has(candidate) || wildcards.some((regex) => regex.test(candidate));
  };
}

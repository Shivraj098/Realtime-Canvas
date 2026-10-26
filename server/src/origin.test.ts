import { describe, expect, it } from "vitest";
import { compileOriginMatcher, originPatternProblem } from "./origin";

describe("exact origins", () => {
  const allowed = compileOriginMatcher(["https://app.example.com", "http://localhost:5173"]);

  it("accepts a listed origin", () => {
    expect(allowed("https://app.example.com")).toBe(true);
    expect(allowed("http://localhost:5173")).toBe(true);
  });

  it("ignores case and trailing whitespace in the header", () => {
    expect(allowed("HTTPS://App.Example.COM")).toBe(true);
    expect(allowed("  https://app.example.com ")).toBe(true);
  });

  it.each([
    ["a different scheme", "http://app.example.com"],
    ["a different port", "http://localhost:5174"],
    ["a missing port", "http://localhost"],
    ["a different host", "https://other.example.com"],
    ["a parent domain", "https://example.com"],
    ["a look-alike prefix", "https://app.example.com.evil.com"],
    ["a look-alike suffix", "https://evil-app.example.com"],
    ["a path appended", "https://app.example.com/"],
    ["a sandboxed page", "null"],
    ["an empty header", ""],
    ["junk", "javascript:alert(1)"],
  ])("rejects %s", (_name, origin) => {
    expect(allowed(origin)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(allowed(undefined)).toBe(false);
  });

  it("tolerates a trailing slash in the configured pattern", () => {
    expect(compileOriginMatcher(["https://app.example.com/"])("https://app.example.com")).toBe(true);
  });
});

describe("wildcard subdomains", () => {
  const allowed = compileOriginMatcher(["https://*.example.com"]);

  it("accepts one or several subdomain labels", () => {
    expect(allowed("https://a.example.com")).toBe(true);
    expect(allowed("https://a-b.example.com")).toBe(true);
    expect(allowed("https://a.b.example.com")).toBe(true);
  });

  it.each([
    ["the bare domain", "https://example.com"],
    ["a host that merely ends with the same letters", "https://evil-example.com"],
    ["a host that contains the domain as a prefix", "https://a.example.com.evil.com"],
    ["a different scheme", "http://a.example.com"],
    ["an unexpected port", "https://a.example.com:8443"],
    ["a dot trick", "https://a.example.com."],
    ["an empty label", "https://.example.com"],
  ])("rejects %s", (_name, origin) => {
    expect(allowed(origin)).toBe(false);
  });

  it("requires the port when the pattern names one", () => {
    const withPort = compileOriginMatcher(["https://*.example.com:8443"]);
    expect(withPort("https://a.example.com:8443")).toBe(true);
    expect(withPort("https://a.example.com")).toBe(false);
  });

  it("treats dots in the pattern literally", () => {
    expect(compileOriginMatcher(["https://*.example.com"])("https://a.exampleXcom")).toBe(false);
  });
});

describe("an empty list", () => {
  it("matches nothing (the caller decides that no list means no check)", () => {
    expect(compileOriginMatcher([])("https://app.example.com")).toBe(false);
  });
});

describe("originPatternProblem", () => {
  it.each([
    "https://app.example.com",
    "http://localhost:5173",
    "https://*.example.com",
    "HTTPS://App.Example.com",
  ])("accepts %s", (pattern) => {
    expect(originPatternProblem(pattern)).toBeNull();
  });

  it.each([
    "app.example.com",
    "https://",
    "https://app.example.com/path",
    "ftp://app.example.com",
    "https://*",
    "https://a.*.example.com",
    "https://app example.com",
    "*",
    "",
  ])("rejects %j", (pattern) => {
    expect(originPatternProblem(pattern)).not.toBeNull();
  });

  it("makes the matcher refuse to build from a bad pattern", () => {
    expect(() => compileOriginMatcher(["not an origin"])).toThrow(/not a valid origin/);
  });
});

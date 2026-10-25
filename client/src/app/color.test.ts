import { describe, expect, it } from "vitest";
import { shade } from "./color";

describe("shade", () => {
  it("darkens toward black", () => {
    expect(shade("#ffffff", -0.5)).toBe("#808080");
    expect(shade("#ffffff", -1)).toBe("#000000");
  });

  it("lightens toward white", () => {
    expect(shade("#000000", 0.5)).toBe("#808080");
  });

  it("expands three-digit colours", () => {
    expect(shade("#fff", -1)).toBe("#000000");
  });

  it("keeps the alpha of eight-digit colours", () => {
    expect(shade("#ffffff80", -1)).toBe("#00000080");
  });

  it("leaves anything it cannot parse unchanged", () => {
    for (const value of ["red", "#12", "#12345", "rgb(1,2,3)", "", "#gggggg"]) {
      expect(shade(value, -0.3)).toBe(value);
    }
  });

  it("does nothing for a zero amount", () => {
    expect(shade("#336699", 0)).toBe("#336699");
  });
});

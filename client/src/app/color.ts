/** Darkens (negative amount) or lightens (positive) a `#rgb`, `#rrggbb` or `#rrggbbaa` colour. Anything else is returned unchanged. */
export function shade(color: string, amount: number): string {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color);
  if (!match) return color;
  let hex = match[1]!;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const alpha = hex.length === 8 ? hex.slice(6) : "";
  const channels = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const target = amount < 0 ? 0 : 255;
  const mix = Math.min(1, Math.abs(amount));
  const shaded = channels.map((c) =>
    Math.round(c + (target - c) * mix)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${shaded.join("")}${alpha}`;
}

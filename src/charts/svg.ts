/** Minimal SVG helpers: no dependency, deterministic output (same input, same bytes). */

export type ThemeName = "light" | "dark";

export type Theme = {
  name: ThemeName;
  background: string;
  text: string;
  muted: string;
  grid: string;
  track: string;
  accent: string;
  accent2: string;
  good: string;
  warn: string;
  bad: string;
  /** Ceiling colours: restriction is shown in neutral/amber tones, never in alarm red. */
  ceiling: Record<"rest" | "easy" | "moderate" | "hard", string>;
};

export const THEMES: Record<ThemeName, Theme> = {
  light: {
    name: "light",
    background: "#ffffff",
    text: "#111827",
    muted: "#6b7280",
    grid: "#e5e7eb",
    track: "#f3f4f6",
    accent: "#2563eb",
    accent2: "#ea580c",
    good: "#16a34a",
    warn: "#d97706",
    bad: "#dc2626",
    ceiling: { rest: "#64748b", easy: "#d97706", moderate: "#2563eb", hard: "#16a34a" },
  },
  dark: {
    name: "dark",
    background: "#111827",
    text: "#f3f4f6",
    muted: "#9ca3af",
    grid: "#374151",
    track: "#1f2937",
    accent: "#60a5fa",
    accent2: "#fb923c",
    good: "#4ade80",
    warn: "#fbbf24",
    bad: "#f87171",
    ceiling: { rest: "#94a3b8", easy: "#fbbf24", moderate: "#60a5fa", hard: "#4ade80" },
  },
};

export const FONT = "Inter, sans-serif";

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Number to at most two decimals, never "-0". */
export function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export type TextOptions = { size?: number; weight?: 400 | 600; anchor?: "start" | "middle" | "end"; fill: string; baseline?: "auto" | "middle" | "hanging"; halo?: string };

export function text(x: number, y: number, content: string, options: TextOptions): string {
  const { size = 12, weight = 400, anchor = "start", fill, baseline = "auto", halo } = options;
  const outline = halo ? ` stroke="${halo}" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke"` : "";
  return `<text x="${n(x)}" y="${n(y)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" dominant-baseline="${baseline}" fill="${fill}"${outline}>${esc(content)}</text>`;
}

export function svgDocument(width: number, height: number, theme: Theme, title: string, description: string, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">` +
    `<title>${esc(title)}</title><desc>${esc(description)}</desc>` +
    `<rect width="${width}" height="${height}" rx="12" fill="${theme.background}"/>` +
    body +
    `</svg>`
  );
}

export function scale(domainMin: number, domainMax: number, rangeMin: number, rangeMax: number): (value: number) => number {
  const span = domainMax - domainMin || 1;
  return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

/** Round tick values covering [min, max] (about `count` of them). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rawStep) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Math.round(value * 1e6) / 1e6);
  return ticks;
}

/** Polyline path through points, breaking the line where a value is missing. */
export function linePath(points: ReadonlyArray<{ x: number; y: number | null }>): string {
  let out = "";
  let open = false;
  for (const point of points) {
    if (point.y === null) {
      open = false;
      continue;
    }
    out += `${open ? "L" : "M"}${n(point.x)} ${n(point.y)}`;
    open = true;
  }
  return out;
}

/** Point on a circle; angle 0 = right, pi = left, counter-clockwise on screen. */
export function polar(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + radius * Math.cos(angle), y: cy - radius * Math.sin(angle) };
}

/** Arc along the top half-circle from value `from` to `to` (0-100), left to right. */
export function gaugeArc(cx: number, cy: number, radius: number, from: number, to: number): string {
  const start = polar(cx, cy, radius, Math.PI * (1 - from / 100));
  const end = polar(cx, cy, radius, Math.PI * (1 - to / 100));
  return `M${n(start.x)} ${n(start.y)}A${n(radius)} ${n(radius)} 0 0 1 ${n(end.x)} ${n(end.y)}`;
}

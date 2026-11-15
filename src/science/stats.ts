/**
 * Small statistics toolbox used by every model. Pure functions, no dependency.
 * `null` always means "no measurement": it is skipped, never read as 0.
 */

export type Maybe = number | null | undefined;

export function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function valid(values: readonly Maybe[]): number[] {
  return values.filter(isNum);
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundOrNull(value: Maybe, digits = 1): number | null {
  return isNum(value) ? round(value, digits) : null;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function mean(values: readonly number[]): number | null {
  return values.length ? sum(values) / values.length : null;
}

/** Sample standard deviation (n - 1). Needs at least two values. */
export function sd(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = sum(values) / values.length;
  let squares = 0;
  for (const value of values) squares += (value - m) ** 2;
  return Math.sqrt(squares / (values.length - 1));
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * clamp(q, 0, 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** Median absolute deviation scaled to estimate a standard deviation (x 1.4826). */
export function madSd(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null || values.length < 2) return null;
  const deviation = median(values.map((value) => Math.abs(value - center)));
  return deviation === null ? null : deviation * 1.4826;
}

export type Baseline = { center: number; scale: number; n: number };

/**
 * Robust personal baseline: median and MAD-based SD, so that a few sick or
 * hung-over nights do not widen the "normal" range. `scaleFloor` is the
 * smallest scale accepted: it prevents a very regular person from getting
 * huge z-scores out of measurement noise.
 */
export function robustBaseline(values: readonly Maybe[], scaleFloor: number, minN: number): Baseline | null {
  const clean = valid(values);
  if (clean.length < minN) return null;
  const center = median(clean);
  if (center === null) return null;
  // MAD is 0 when more than half the values are identical (integer heart rates):
  // fall back on the interquartile range, then on the floor. The classic SD is
  // never used: a few outliers would inflate it.
  const mad = madSd(clean) ?? 0;
  const iqr = ((quantile(clean, 0.75) as number) - (quantile(clean, 0.25) as number)) / 1.349;
  const scale = Math.max(mad > 0 ? mad : iqr, scaleFloor);
  return { center, scale, n: clean.length };
}

export function zScore(value: Maybe, baseline: Baseline | null): number | null {
  if (!isNum(value) || !baseline) return null;
  return (value - baseline.center) / baseline.scale;
}

/** Standard normal cumulative distribution (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Exponentially weighted moving average with time constant `tau` (days):
 * x[t] = x[t-1] + (v[t] - x[t-1]) * (1 - exp(-1 / tau)).
 */
export function ewma(values: readonly number[], tau: number, seed: number): number[] {
  const alpha = 1 - Math.exp(-1 / tau);
  const out: number[] = [];
  let current = seed;
  for (const value of values) {
    current += (value - current) * alpha;
    out.push(current);
  }
  return out;
}

/** Ordinary least squares slope of y against its index (units of y per step). */
export function slope(values: readonly Maybe[]): number | null {
  const points: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (isNum(value)) points.push([index, value]);
  });
  if (points.length < 3) return null;
  const mx = sum(points.map((p) => p[0])) / points.length;
  const my = sum(points.map((p) => p[1])) / points.length;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Deterministic pseudo-random generator (mulberry32): resampling results are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hedges' g: standardized mean difference (a - b) with the small-sample correction. */
export function hedgesG(a: readonly number[], b: readonly number[]): number | null {
  const ma = mean(a);
  const mb = mean(b);
  const sa = sd(a);
  const sb = sd(b);
  if (ma === null || mb === null || sa === null || sb === null) return null;
  const df = a.length + b.length - 2;
  const pooled = Math.sqrt(((a.length - 1) * sa ** 2 + (b.length - 1) * sb ** 2) / df);
  if (pooled === 0) return null;
  return ((ma - mb) / pooled) * (1 - 3 / (4 * df - 1));
}

/** Percentile bootstrap confidence interval of mean(a) - mean(b). */
export function bootstrapDiffCi(
  a: readonly number[],
  b: readonly number[],
  iterations = 2000,
  level = 0.95,
  seed = 20261115,
): [number, number] | null {
  if (a.length < 2 || b.length < 2) return null;
  const random = seededRandom(seed);
  const resampleMean = (values: readonly number[]) => {
    let total = 0;
    for (let i = 0; i < values.length; i += 1) total += values[Math.floor(random() * values.length)];
    return total / values.length;
  };
  const diffs: number[] = [];
  for (let i = 0; i < iterations; i += 1) diffs.push(resampleMean(a) - resampleMean(b));
  const tail = (1 - level) / 2;
  return [quantile(diffs, tail) as number, quantile(diffs, 1 - tail) as number];
}

/** Two-sided permutation p-value of the difference of means. */
export function permutationP(a: readonly number[], b: readonly number[], iterations = 5000, seed = 20261115): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const observed = Math.abs((mean(a) as number) - (mean(b) as number));
  const pool = [...a, ...b];
  const random = seededRandom(seed);
  let extreme = 0;
  for (let i = 0; i < iterations; i += 1) {
    // Partial Fisher-Yates shuffle: the first a.length items form the permuted group.
    for (let j = 0; j < a.length; j += 1) {
      const k = j + Math.floor(random() * (pool.length - j));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    const groupSum = sum(pool.slice(0, a.length));
    const diff = Math.abs(groupSum / a.length - (sum(pool) - groupSum) / b.length);
    if (diff >= observed - 1e-12) extreme += 1;
  }
  return (extreme + 1) / (iterations + 1);
}

/** Benjamini-Hochberg adjusted p-values (false discovery rate), same order as the input. */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 1;
  for (let rank = order.length; rank >= 1; rank -= 1) {
    const { p, index } = order[rank - 1];
    running = Math.min(running, (p * order.length) / rank);
    adjusted[index] = running;
  }
  return adjusted;
}

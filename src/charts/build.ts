/**
 * Chart builders: pure functions from already computed model results to SVG.
 * Nothing here computes physiology; every number drawn comes from the models.
 * Logical sizes are in CSS pixels; the PNG is rendered at twice that for sharp screens.
 */

import { LABELS, shortDate, type Lang } from "./labels.ts";
import { FONT, esc, gaugeArc, linePath, n, niceTicks, polar, scale, svgDocument, text, type Theme } from "./svg.ts";

export type Chart = { svg: string; width: number; height: number; alt: string };

export type SignalRow = { value: number | null; baseline: number | null; delta: number | null; z: number | null };
export type SignalRows = Record<"hrv" | "restingHr" | "respiration" | "skinTemp" | "spo2", SignalRow>;

export type HrvPoint = { date: string; ms: number | null; trendMs: number | null };
export type LoadPoint = { date: string; ctl: number; atl: number; tsb: number };
export type SleepPoint = { date: string; hours: number | null; deepH: number | null; lightH: number | null; remH: number | null; needH: number };

type Common = { theme: Theme; lang: Lang };

// --- Recovery gauge ---------------------------------------------------------------------------------

export function recoveryGauge(input: Common & { score: number | null; band: "low" | "moderate" | "high" | null }): Chart {
  const { theme, lang, score, band } = input;
  const t = LABELS[lang];
  const width = 280;
  const height = 210;
  const cx = 140;
  const cy = 146;
  const radius = 92;
  const stroke = 20;
  const bands: Array<[number, number, string]> = [
    [0, 33, theme.bad],
    [34, 66, theme.warn],
    [67, 100, theme.good],
  ];
  let body = text(cx, 22, t.recovery, { size: 15, weight: 600, anchor: "middle", fill: theme.text });
  for (const [from, to, color] of bands) {
    body += `<path d="${gaugeArc(cx, cy, radius, from + 0.6, to - 0.6)}" fill="none" stroke="${score === null ? theme.track : color}" stroke-width="${stroke}" stroke-opacity="${score === null ? 1 : 0.28}"/>`;
  }
  if (score !== null && band !== null) {
    const color = band === "high" ? theme.good : band === "moderate" ? theme.warn : theme.bad;
    body += `<path d="${gaugeArc(cx, cy, radius, 0.6, Math.max(score, 1))}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`;
    const tip = polar(cx, cy, radius, Math.PI * (1 - Math.max(score, 1) / 100));
    body += `<circle cx="${n(tip.x)}" cy="${n(tip.y)}" r="${stroke / 2 + 3}" fill="${theme.background}"/><circle cx="${n(tip.x)}" cy="${n(tip.y)}" r="${stroke / 2 - 3}" fill="${color}"/>`;
    body += `<text x="${cx}" y="${cy - 8}" font-family="${FONT}" text-anchor="middle" fill="${theme.text}"><tspan font-size="46" font-weight="600">${score}</tspan><tspan font-size="13" fill="${theme.muted}" dx="4">${esc(t.of100)}</tspan></text>`;
    body += text(cx, cy + 28, t.bands[band], { size: 15, weight: 600, anchor: "middle", fill: color });
  } else {
    body += text(cx, cy - 4, "n/a", { size: 38, weight: 600, anchor: "middle", fill: theme.muted });
    body += text(cx, cy + 28, t.noScore, { size: 13, anchor: "middle", fill: theme.muted });
  }
  body += text(cx - radius, cy + 20, "0", { size: 11, anchor: "middle", fill: theme.muted });
  body += text(cx + radius, cy + 20, "100", { size: 11, anchor: "middle", fill: theme.muted });
  return { svg: svgDocument(width, height, theme, t.recovery, t.altGauge(score, band ? t.bands[band] : null), body), width, height, alt: t.altGauge(score, band ? t.bands[band] : null) };
}

// --- Ceiling ladder ---------------------------------------------------------------------------------

export function ceilingLadder(input: Common & { ceiling: "rest" | "easy" | "moderate" | "hard"; suggestedLoad: { min: number; max: number } | null }): Chart {
  const { theme, lang, ceiling, suggestedLoad } = input;
  const t = LABELS[lang];
  const width = 280;
  const height = 210;
  const order = ["rest", "easy", "moderate", "hard"] as const;
  const level = order.indexOf(ceiling);
  const color = theme.ceiling[ceiling];
  let body = text(width / 2, 28, t.ceilingTitle, { size: 15, weight: 600, anchor: "middle", fill: theme.text });
  const barWidth = 44;
  const gap = 14;
  const left = (width - (4 * barWidth + 3 * gap)) / 2;
  const base = 156;
  order.forEach((name, index) => {
    const barHeight = 26 + index * 15;
    const x = left + index * (barWidth + gap);
    const active = index <= level;
    body += `<rect x="${n(x)}" y="${n(base - barHeight)}" width="${barWidth}" height="${barHeight}" rx="6" fill="${active ? color : theme.track}" fill-opacity="${active ? (index === level ? 1 : 0.45) : 1}"/>`;
    body += text(x + barWidth / 2, base + 16, t.ceilings[name], { size: 11, weight: index === level ? 600 : 400, anchor: "middle", fill: index === level ? theme.text : theme.muted });
  });
  body += text(width / 2, 74, t.ceilings[ceiling], { size: 30, weight: 600, anchor: "middle", fill: color });
  if (suggestedLoad) {
    body += text(width / 2, 196, `${t.suggestedLoad}: ${Math.round(suggestedLoad.min)}–${Math.round(suggestedLoad.max)}`, { size: 12, anchor: "middle", fill: theme.muted });
  }
  const alt = t.altCeiling(t.ceilings[ceiling]);
  return { svg: svgDocument(width, height, theme, t.ceilingTitle, alt, body), width, height, alt };
}

// --- Overnight signals against the personal baseline -----------------------------------------------

const SIGNAL_ORDER = ["hrv", "restingHr", "respiration", "skinTemp", "spo2"] as const;
/** Direction in which a deviation is unfavourable. */
const BAD_SIDE: Record<(typeof SIGNAL_ORDER)[number], 1 | -1> = { hrv: -1, restingHr: 1, respiration: 1, skinTemp: 1, spo2: -1 };
const UNITS: Record<(typeof SIGNAL_ORDER)[number], string> = { hrv: "ms", restingHr: "bpm", respiration: "/min", skinTemp: "°C", spo2: "%" };

function formatSigned(value: number, digits = 1): string {
  const text = value.toFixed(digits).replace(/^-/, "−");
  return value > 0 ? `+${text}` : text;
}

export function signalsChart(input: Common & { rows: SignalRows }): Chart {
  const { theme, lang, rows } = input;
  const t = LABELS[lang];
  const width = 600;
  const rowHeight = 34;
  const top = 62;
  const height = top + SIGNAL_ORDER.length * rowHeight + 14;
  const trackLeft = 118;
  const trackRight = 440;
  const x = scale(-3, 3, trackLeft, trackRight);
  let body = text(20, 28, t.signalsTitle, { size: 15, weight: 600, fill: theme.text });
  body += text(20, 46, t.signalsSubtitle, { size: 11, fill: theme.muted });
  const described: string[] = [];
  SIGNAL_ORDER.forEach((key, index) => {
    const row = rows[key];
    const cy = top + index * rowHeight + rowHeight / 2;
    body += text(20, cy, t.signals[key], { size: 13, weight: 600, fill: theme.text, baseline: "middle" });
    body += `<rect x="${trackLeft}" y="${cy - 6}" width="${trackRight - trackLeft}" height="12" rx="6" fill="${theme.track}"/>`;
    body += `<rect x="${n(x(-2))}" y="${cy - 6}" width="${n(x(2) - x(-2))}" height="12" fill="${theme.grid}"/>`;
    body += `<rect x="${n(x(-1))}" y="${cy - 6}" width="${n(x(1) - x(-1))}" height="12" fill="${theme.accent}" fill-opacity="0.22"/>`;
    body += `<line x1="${n(x(0))}" y1="${cy - 9}" x2="${n(x(0))}" y2="${cy + 9}" stroke="${theme.muted}" stroke-width="1"/>`;
    if (row.z === null || row.value === null) {
      body += text(trackRight + 16, cy, t.noData, { size: 12, fill: theme.muted, baseline: "middle" });
      return;
    }
    const z = Math.max(-3, Math.min(3, row.z));
    const unfavourable = row.z * BAD_SIDE[key] > 0 ? Math.abs(row.z) : 0;
    const color = unfavourable >= 2 ? theme.bad : unfavourable >= 1 ? theme.warn : theme.good;
    body += `<circle cx="${n(x(z))}" cy="${cy}" r="8" fill="${theme.background}"/><circle cx="${n(x(z))}" cy="${cy}" r="6" fill="${color}"/>`;
    const digits = key === "skinTemp" || key === "respiration" ? 1 : 0;
    const delta = row.delta === null ? "" : key === "hrv" ? `  (${formatSigned(row.delta, 0)} %)` : `  (${formatSigned(row.delta, digits === 0 ? 0 : 1)})`;
    const shown = key === "skinTemp" ? formatSigned(row.value, 1) : row.value.toFixed(digits);
    body += text(trackRight + 16, cy, `${shown} ${UNITS[key]}${delta}`, { size: 12, fill: theme.text, baseline: "middle" });
    described.push(`${t.signals[key]} ${shown} ${UNITS[key]}`);
  });
  const alt = `${t.signalsTitle}: ${described.join(", ") || t.noData}.`;
  return { svg: svgDocument(width, height, theme, t.signalsTitle, alt, body), width, height, alt };
}

// --- HRV trend ------------------------------------------------------------------------------------

export function hrvChart(input: Common & { points: HrvPoint[]; range: { lowMs: number; highMs: number } | null }): Chart {
  const { theme, lang, points, range } = input;
  const t = LABELS[lang];
  const width = 600;
  const height = 260;
  const plot = { left: 48, right: 566, top: 64, bottom: 212 };
  const values = points.flatMap((p) => [p.ms, p.trendMs]).filter((v): v is number => v !== null);
  if (range) values.push(range.lowMs, range.highMs);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.12 || 5;
  const y = scale(lo - pad, hi + pad, plot.bottom, plot.top);
  const x = scale(0, Math.max(points.length - 1, 1), plot.left, plot.right);
  let body = text(20, 28, t.hrvTitle, { size: 15, weight: 600, fill: theme.text });
  body += text(20, 46, t.hrvSubtitle, { size: 11, fill: theme.muted });
  for (const tick of niceTicks(lo - pad, hi + pad, 4)) {
    body += `<line x1="${plot.left}" y1="${n(y(tick))}" x2="${plot.right}" y2="${n(y(tick))}" stroke="${theme.grid}" stroke-width="1"/>`;
    body += text(plot.left - 8, y(tick), String(Math.round(tick)), { size: 11, anchor: "end", fill: theme.muted, baseline: "middle" });
  }
  if (range) {
    body += `<rect x="${plot.left}" y="${n(y(range.highMs))}" width="${plot.right - plot.left}" height="${n(y(range.lowMs) - y(range.highMs))}" fill="${theme.good}" fill-opacity="0.16"/>`;
  }
  points.forEach((p, index) => {
    if (p.ms !== null) body += `<circle cx="${n(x(index))}" cy="${n(y(p.ms))}" r="3" fill="${theme.muted}" fill-opacity="0.7"/>`;
  });
  body += `<path d="${linePath(points.map((p, index) => ({ x: x(index), y: p.trendMs === null ? null : y(p.trendMs) })))}" fill="none" stroke="${theme.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  const last = [...points].reverse().findIndex((p) => p.trendMs !== null);
  if (last !== -1) {
    const index = points.length - 1 - last;
    const p = points[index];
    body += `<circle cx="${n(x(index))}" cy="${n(y(p.trendMs as number))}" r="5" fill="${theme.accent}"/>`;
    body += text(Math.min(x(index), plot.right - 4), y(p.trendMs as number) - 12, `${Math.round(p.trendMs as number)} ms`, { size: 12, weight: 600, anchor: "end", fill: theme.accent, halo: theme.background });
  }
  const labelEvery = Math.max(1, Math.round(points.length / 5));
  points.forEach((p, index) => {
    if ((points.length - 1 - index) % labelEvery === 0) body += text(x(index), plot.bottom + 18, shortDate(p.date, lang), { size: 11, anchor: "middle", fill: theme.muted });
  });
  // Legend.
  const ly = height - 14;
  body += `<circle cx="22" cy="${ly - 4}" r="3" fill="${theme.muted}" fill-opacity="0.7"/>` + text(31, ly, t.nightly, { size: 11, fill: theme.muted });
  body += `<line x1="92" y1="${ly - 4}" x2="112" y2="${ly - 4}" stroke="${theme.accent}" stroke-width="2.5"/>` + text(119, ly, t.trend7, { size: 11, fill: theme.muted });
  if (range) body += `<rect x="212" y="${ly - 10}" width="18" height="10" fill="${theme.good}" fill-opacity="0.3"/>` + text(237, ly, `${t.normalRange} ${Math.round(range.lowMs)}–${Math.round(range.highMs)} ms`, { size: 11, fill: theme.muted });
  const lastTrend = [...points].reverse().find((p) => p.trendMs !== null)?.trendMs;
  const alt = `${t.hrvTitle}: ${lastTrend == null ? t.noData : `${Math.round(lastTrend)} ms (7 d)`}${range ? `, ${t.normalRange.toLowerCase()} ${Math.round(range.lowMs)}–${Math.round(range.highMs)} ms` : ""}.`;
  return { svg: svgDocument(width, height, theme, t.hrvTitle, alt, body), width, height, alt };
}

// --- Fitness, fatigue, form ----------------------------------------------------------------------------

export function loadChart(input: Common & { points: LoadPoint[] }): Chart {
  const { theme, lang, points } = input;
  const t = LABELS[lang];
  const width = 600;
  const height = 350;
  const left = 48;
  const right = 566;
  const top = { top: 64, bottom: 198 };
  const bottom = { top: 232, bottom: 292 };
  const x = scale(0, Math.max(points.length - 1, 1), left, right);
  const loadMax = Math.max(...points.flatMap((p) => [p.ctl, p.atl]), 10);
  const yLoad = scale(0, loadMax * 1.1, top.bottom, top.top);
  const tsbAbs = Math.max(...points.map((p) => Math.abs(p.tsb)), 10);
  const yTsb = scale(-tsbAbs, tsbAbs, bottom.bottom, bottom.top);
  let body = text(20, 28, t.loadTitle, { size: 15, weight: 600, fill: theme.text });
  body += text(20, 46, "TRIMP", { size: 11, fill: theme.muted });
  for (const tick of niceTicks(0, loadMax * 1.1, 4)) {
    body += `<line x1="${left}" y1="${n(yLoad(tick))}" x2="${right}" y2="${n(yLoad(tick))}" stroke="${theme.grid}" stroke-width="1"/>`;
    body += text(left - 8, yLoad(tick), String(Math.round(tick)), { size: 11, anchor: "end", fill: theme.muted, baseline: "middle" });
  }
  const area = `${linePath(points.map((p, i) => ({ x: x(i), y: yLoad(p.ctl) })))}L${n(right)} ${n(top.bottom)}L${n(left)} ${n(top.bottom)}Z`;
  body += `<path d="${area}" fill="${theme.accent}" fill-opacity="0.12"/>`;
  body += `<path d="${linePath(points.map((p, i) => ({ x: x(i), y: yLoad(p.ctl) })))}" fill="none" stroke="${theme.accent}" stroke-width="2.5" stroke-linejoin="round"/>`;
  body += `<path d="${linePath(points.map((p, i) => ({ x: x(i), y: yLoad(p.atl) })))}" fill="none" stroke="${theme.accent2}" stroke-width="2" stroke-linejoin="round"/>`;
  // Form: bars around zero, favourable above.
  body += text(20, bottom.top - 8, t.form, { size: 11, fill: theme.muted });
  body += `<line x1="${left}" y1="${n(yTsb(0))}" x2="${right}" y2="${n(yTsb(0))}" stroke="${theme.muted}" stroke-width="1"/>`;
  const barWidth = Math.max(1.5, ((right - left) / points.length) * 0.7);
  points.forEach((p, i) => {
    const y0 = yTsb(0);
    const y1 = yTsb(p.tsb);
    body += `<rect x="${n(x(i) - barWidth / 2)}" y="${n(Math.min(y0, y1))}" width="${n(barWidth)}" height="${n(Math.abs(y1 - y0))}" fill="${p.tsb >= 0 ? theme.good : theme.warn}" fill-opacity="0.8"/>`;
  });
  body += text(left - 8, yTsb(tsbAbs), `+${Math.round(tsbAbs)}`, { size: 10, anchor: "end", fill: theme.muted, baseline: "middle" });
  body += text(left - 8, yTsb(-tsbAbs), `−${Math.round(tsbAbs)}`, { size: 10, anchor: "end", fill: theme.muted, baseline: "middle" });
  const labelEvery = Math.max(1, Math.round(points.length / 6));
  points.forEach((p, i) => {
    if ((points.length - 1 - i) % labelEvery === 0) body += text(x(i), bottom.bottom + 16, shortDate(p.date, lang), { size: 11, anchor: "middle", fill: theme.muted });
  });
  const lastPoint = points[points.length - 1];
  body += `<circle cx="${n(x(points.length - 1))}" cy="${n(yLoad(lastPoint.ctl))}" r="4" fill="${theme.accent}"/><circle cx="${n(x(points.length - 1))}" cy="${n(yLoad(lastPoint.atl))}" r="4" fill="${theme.accent2}"/>`;
  const ly = height - 12;
  body += `<line x1="22" y1="${ly - 4}" x2="42" y2="${ly - 4}" stroke="${theme.accent}" stroke-width="2.5"/>` + text(49, ly, `${t.fitness} ${lastPoint.ctl.toFixed(0)}`, { size: 11, fill: theme.muted });
  body += `<line x1="190" y1="${ly - 4}" x2="210" y2="${ly - 4}" stroke="${theme.accent2}" stroke-width="2"/>` + text(217, ly, `${t.fatigue} ${lastPoint.atl.toFixed(0)}`, { size: 11, fill: theme.muted });
  body += `<rect x="358" y="${ly - 10}" width="12" height="10" fill="${lastPoint.tsb >= 0 ? theme.good : theme.warn}"/>` + text(377, ly, `${t.form} ${lastPoint.tsb >= 0 ? "+" : "−"}${Math.abs(lastPoint.tsb).toFixed(0)}`, { size: 11, fill: theme.muted });
  const alt = `${t.loadTitle}: ${t.fitness} ${lastPoint.ctl.toFixed(0)}, ${t.fatigue} ${lastPoint.atl.toFixed(0)}, ${t.form} ${lastPoint.tsb.toFixed(0)}.`;
  return { svg: svgDocument(width, height, theme, t.loadTitle, alt, body), width, height, alt };
}

// --- Sleep ----------------------------------------------------------------------------------------

export function sleepChart(input: Common & { nights: SleepPoint[] }): Chart {
  const { theme, lang, nights } = input;
  const t = LABELS[lang];
  const width = 600;
  const height = 260;
  const plot = { left: 48, right: 580, top: 56, bottom: 200 };
  const need = nights.length ? nights[nights.length - 1].needH : 8;
  const maxHours = Math.max(...nights.map((night) => night.hours ?? 0), need, 6) * 1.1;
  const y = scale(0, maxHours, plot.bottom, plot.top);
  const slot = (plot.right - plot.left) / Math.max(nights.length, 1);
  const barWidth = Math.min(slot * 0.62, 30);
  let body = text(20, 28, t.sleepTitle, { size: 15, weight: 600, fill: theme.text });
  const stagesKnown = nights.some((night) => night.deepH !== null);
  for (let tick = 0; tick <= maxHours; tick += 2) {
    body += `<line x1="${plot.left}" y1="${n(y(tick))}" x2="${plot.right}" y2="${n(y(tick))}" stroke="${theme.grid}" stroke-width="1"/>`;
    body += text(plot.left - 8, y(tick), `${Math.round(tick)}`, { size: 11, anchor: "end", fill: theme.muted, baseline: "middle" });
  }
  nights.forEach((night, index) => {
    const cx = plot.left + slot * (index + 0.5);
    if (night.hours === null) return;
    const segments: Array<[number | null, string]> = stagesKnown && night.deepH !== null && night.lightH !== null && night.remH !== null
      ? [[night.deepH, theme.accent], [night.remH, theme.good], [night.lightH, theme.accent2]]
      : [[night.hours, theme.accent]];
    let acc = 0;
    // Stages stack from the bottom: deep, REM, light.
    for (const [hours, color] of segments) {
      if (hours === null) continue;
      const y1 = y(acc + hours);
      const y0 = y(acc);
      body += `<rect x="${n(cx - barWidth / 2)}" y="${n(y1)}" width="${n(barWidth)}" height="${n(Math.max(y0 - y1, 0))}" fill="${color}" fill-opacity="${night.hours < night.needH * 0.75 ? 0.55 : 0.9}"/>`;
      acc += hours;
    }
    body += text(cx, y(night.hours) - 6, night.hours.toFixed(1), { size: 10, weight: 600, anchor: "middle", fill: theme.text, halo: theme.background });
    const weekday = new Date(`${night.date}T12:00:00Z`).getUTCDay();
    body += text(cx, plot.bottom + 16, t.weekdays[weekday], { size: 11, anchor: "middle", fill: theme.muted });
    if (index === 0 || index === nights.length - 1) body += text(cx, plot.bottom + 30, shortDate(night.date, lang), { size: 10, anchor: "middle", fill: theme.muted });
  });
  body += `<line x1="${plot.left}" y1="${n(y(need))}" x2="${plot.right}" y2="${n(y(need))}" stroke="${theme.text}" stroke-width="1.2" stroke-dasharray="5 4"/>`;
  const ly = height - 12;
  body += `<line x1="370" y1="${ly - 4}" x2="392" y2="${ly - 4}" stroke="${theme.text}" stroke-width="1.2" stroke-dasharray="5 4"/>` + text(399, ly, `${t.need} ${need.toFixed(1)} ${t.hours}`, { size: 11, fill: theme.muted });
  if (stagesKnown) {
    body += `<rect x="22" y="${ly - 9}" width="10" height="10" rx="2" fill="${theme.accent}"/>` + text(37, ly, t.deep, { size: 11, fill: theme.muted });
    body += `<rect x="92" y="${ly - 9}" width="10" height="10" rx="2" fill="${theme.good}"/>` + text(107, ly, t.rem, { size: 11, fill: theme.muted });
    body += `<rect x="172" y="${ly - 9}" width="10" height="10" rx="2" fill="${theme.accent2}"/>` + text(187, ly, t.light, { size: 11, fill: theme.muted });
  } else {
    body += `<rect x="22" y="${ly - 9}" width="10" height="10" rx="2" fill="${theme.accent}"/>` + text(37, ly, t.unknownStages, { size: 11, fill: theme.muted });
  }
  const avg = nights.filter((night) => night.hours !== null);
  const mean = avg.length ? avg.reduce((total, night) => total + (night.hours as number), 0) / avg.length : null;
  const alt = `${t.sleepTitle}: ${avg.length} ${lang === "fr" ? "nuits" : "nights"}${mean === null ? "" : `, ${mean.toFixed(1)} ${t.hours}`} ${lang === "fr" ? "en moyenne" : "on average"}, ${t.need.toLowerCase()} ${need.toFixed(1)} ${t.hours}.`;
  return { svg: svgDocument(width, height, theme, t.sleepTitle, alt, body), width, height, alt };
}

export { FONT, esc };

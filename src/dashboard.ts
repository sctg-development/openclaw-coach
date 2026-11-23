/**
 * OpenClaw dashboard tab: one read-only HTML page with the same models and charts as the daily briefing.
 *
 * It is served by a Gateway HTTP route (`auth: "gateway"`, GET and HEAD only) and shown by the Control UI in a
 * sandboxed frame, so it needs no browser JavaScript and no "custom plugin UI" setting. Everything on the page is
 * computed by the plugin's models from the local store; nothing is written, and Garmin is not synced on a page view
 * (the briefing does that). Every dynamic string is escaped.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Chart } from "./charts/build.ts";
import { STATUS_COLORS } from "./charts/build.ts";
import { LABELS, type Lang } from "./charts/labels.ts";
import { THEMES, esc } from "./charts/svg.ts";
import { chartBuilders, dailyBriefing, loadContext, loadStatuses, type Deps } from "./tools.ts";
import type { LoadStatusReport } from "./science/loadstatus.ts";
import { WEEKLY_MINIMUM_MIN } from "./science/intensity.ts";

const TEXT = {
  en: {
    title: "AI Coach",
    today: "Today",
    ceiling: "Ceiling",
    recovery: "Recovery",
    cardiac: "Cardiac load",
    muscular: "Muscular load",
    distribution: "Last 30 days by status",
    status: "Status",
    days: "Days",
    intensity: "Intensity minutes",
    intensityNote: "Moderate + 2 × vigorous minutes, against the 150 min/week minimum (WHO, US guidelines).",
    rolling: "Last 7 days",
    weekSoFar: "This week so far",
    previous: "Previous weeks",
    garmin: "Garmin's own figures",
    loadBalance: "Training load balance (30 days)",
    shown: "Garmin's targets and models, shown for comparison.",
    noData: "Not enough data yet.",
    footer: "Read-only view built from the coach's local store. Last sync:",
    never: "never",
    aerobicLow: "Aerobic low",
    aerobicHigh: "Aerobic high",
    anaerobic: "Anaerobic",
    below: "below target",
    within: "within target",
    above: "above target",
  },
  fr: {
    title: "Coach IA",
    today: "Aujourd'hui",
    ceiling: "Plafond",
    recovery: "Récupération",
    cardiac: "Charge cardiaque",
    muscular: "Charge musculaire",
    distribution: "30 derniers jours par statut",
    status: "Statut",
    days: "Jours",
    intensity: "Minutes d'intensité",
    intensityNote: "Minutes modérées + 2 × minutes vigoureuses, face au minimum de 150 min/semaine (OMS, recommandations américaines).",
    rolling: "7 derniers jours",
    weekSoFar: "Semaine en cours",
    previous: "Semaines précédentes",
    garmin: "Indicateurs propres à Garmin",
    loadBalance: "Équilibre de la charge d'entraînement (30 jours)",
    shown: "Cibles et modèles de Garmin, donnés à titre de comparaison.",
    noData: "Pas encore assez de données.",
    footer: "Vue en lecture seule construite depuis la base locale du coach. Dernière synchronisation :",
    never: "jamais",
    aerobicLow: "Aérobie basse",
    aerobicHigh: "Aérobie haute",
    anaerobic: "Anaérobie",
    below: "sous la cible",
    within: "dans la cible",
    above: "au-dessus de la cible",
  },
} as const;

type Briefing = Awaited<ReturnType<typeof dailyBriefing>>;

/** One chart in both themes: the page shows the one matching the browser's colour scheme. */
function chartPair(build: () => Chart | string, builderFor: (theme: "light" | "dark") => (() => Chart | string) | null): string {
  const light = build();
  if (typeof light === "string") return `<p class="muted">${esc(light)}</p>`;
  const dark = builderFor("dark")?.();
  return `<figure><div class="light">${light.svg}</div>${typeof dark === "string" || !dark ? "" : `<div class="dark">${dark.svg}</div>`}</figure>`;
}

function distributionTable(report: LoadStatusReport, lang: Lang, t: (typeof TEXT)[Lang]): string {
  if (!report.distribution.length) return `<p class="muted">${esc(t.noData)}</p>`;
  const names = LABELS[lang].loadStatus.statuses;
  const rows = report.distribution
    .map(
      (entry) =>
        `<tr><td>${esc(names[entry.status])}</td><td class="num">${entry.days}</td><td><span class="bar" style="width:${entry.pct}%;background:${STATUS_COLORS[entry.status]}"></span></td><td class="num">${entry.pct} %</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>${esc(t.status)}</th><th>${esc(t.days)}</th><th></th><th>%</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function intensityBlock(briefing: Briefing, t: (typeof TEXT)[Lang]): string {
  const im = briefing.intensityMinutes;
  const bar = (label: string, value: number | null, extra = "") => {
    if (value === null) return `<div class="row"><span>${esc(label)}</span><span class="muted">${esc(t.noData)}</span></div>`;
    const width = Math.min(100, Math.round((value / (WEEKLY_MINIMUM_MIN * 2)) * 100));
    const mark = Math.round((WEEKLY_MINIMUM_MIN / (WEEKLY_MINIMUM_MIN * 2)) * 100);
    return `<div class="row"><span>${esc(label)}</span><span class="track"><span class="fill" style="width:${width}%;background:${value >= WEEKLY_MINIMUM_MIN ? "#16a34a" : "#2563eb"}"></span><span class="mark" style="left:${mark}%"></span></span><span class="num">${Math.round(value)} min${esc(extra)}</span></div>`;
  };
  const prev = im.previousWeeks.map((week) => bar(week.weekStart, week.equivalentMin)).join("");
  return `<p class="muted">${esc(t.intensityNote)}</p>${bar(t.rolling, im.rolling7.equivalentMin, im.percentOfMinimum === null ? "" : ` (${im.percentOfMinimum} %)`)}${bar(t.weekSoFar, im.weekToDate.equivalentMin, ` · ${im.weekToDate.daysWithData} d`)}<h4>${esc(t.previous)}</h4>${prev}`;
}

function garminBlock(briefing: Briefing, t: (typeof TEXT)[Lang]): string {
  const g = briefing.garmin as unknown as {
    trainingReadiness?: { score: number | null };
    trainingStatus?: { phrase: string | null; loadRatio: number | null };
    vo2max?: { value: number | null };
    loadBalance?: { categories: Record<string, { load: number; targetMin: number | null; targetMax: number | null; status: string | null }>; phrase: string | null };
  };
  const names: Record<string, string> = { aerobicLow: t.aerobicLow, aerobicHigh: t.aerobicHigh, anaerobic: t.anaerobic };
  const words: Record<string, string> = { below: t.below, within: t.within, above: t.above };
  const facts: string[] = [];
  if (g.trainingReadiness?.score != null) facts.push(`Training readiness: <b>${esc(String(g.trainingReadiness.score))}</b>`);
  if (g.vo2max?.value != null) facts.push(`VO₂max: <b>${esc(String(g.vo2max.value))}</b>`);
  if (g.trainingStatus?.phrase) facts.push(`${esc(g.trainingStatus.phrase)}`);
  let balance = "";
  if (g.loadBalance) {
    const rows = Object.entries(g.loadBalance.categories)
      .map(([key, c]) => `<tr><td>${esc(names[key] ?? key)}</td><td class="num">${c.load}</td><td class="num muted">${c.targetMin ?? "–"}–${c.targetMax ?? "–"}</td><td>${esc(words[c.status ?? ""] ?? "")}</td></tr>`)
      .join("");
    balance = `<h4>${esc(t.loadBalance)}</h4><table><tbody>${rows}</tbody></table>`;
  }
  return `<p class="muted">${esc(t.shown)}</p><p>${facts.join(" · ") || esc(t.noData)}</p>${balance}`;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#111827;--text:#f3f4f6;--muted:#9ca3af;--line:#1f2937}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h3{font-size:15px;margin:0 0 8px}h4{font-size:13px;margin:12px 0 4px;color:var(--muted)}
.grid{display:grid;align-items:start;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:hidden}
.muted{color:var(--muted)}figure{margin:0}svg{max-width:100%;height:auto;display:block}
.dark{display:none}@media (prefers-color-scheme:dark){.light{display:none}.dark{display:block}}
table{width:100%;border-collapse:collapse}th,td{padding:4px 6px;text-align:left;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
.num{text-align:right;font-variant-numeric:tabular-nums}.bar{display:block;height:8px;border-radius:4px}
.row{display:flex;align-items:center;gap:8px;margin:4px 0}.row>span:first-child{flex:0 0 110px}.track{position:relative;flex:1;height:10px;background:var(--line);border-radius:5px}
.fill{display:block;height:100%;border-radius:5px}.mark{position:absolute;top:-3px;width:2px;height:16px;background:var(--muted)}
.kpis{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px}.kpi b{font-size:22px}
footer{margin-top:16px;color:var(--muted);font-size:12px}`;

/** The whole page. Never throws for missing data: a block without data says so. */
export async function renderDashboard(deps: Deps): Promise<string> {
  const lang: Lang = deps.config.language;
  const t = TEXT[lang];
  const briefing = await dailyBriefing(deps, { sync: false, replies: false });
  const context = await loadContext(deps, { sync: false });
  const build = (theme: "light" | "dark") => chartBuilders(context, { theme: THEMES[theme], lang });
  const light = build("light");
  const dark = build("dark");
  const chart = (id: keyof typeof light) => chartPair(light[id], () => dark[id]);
  const statuses = loadStatuses(context);
  const ceiling = briefing.readiness.ceiling;
  const lastSync = context.store.activitiesSyncedAt;

  const card = (title: string, content: string) => `<section class="card"><h3>${esc(title)}</h3>${content}</section>`;
  const body = [
    `<h1>${esc(t.title)}</h1><div class="muted">${esc(briefing.date)}</div>`,
    `<div class="kpis"><div class="kpi">${esc(t.ceiling)}<br><b>${esc(String(ceiling))}</b></div><div class="kpi">${esc(t.recovery)}<br><b>${esc(briefing.recovery.score === null ? "–" : String(briefing.recovery.score))}</b></div></div>`,
    `<div class="grid">`,
    card(t.today, chart("recovery_gauge") + chart("ceiling")),
    card(LABELS[lang].signalsTitle, chart("signals")),
    card(LABELS[lang].hrvTitle, chart("hrv_trend")),
    card(LABELS[lang].sleepTitle, chart("sleep_nights")),
    card(t.cardiac, chart("cardiac_load") + distributionTable(statuses.cardiac, lang, t)),
    card(t.muscular, chart("muscular_load") + distributionTable(statuses.muscular, lang, t)),
    card(LABELS[lang].loadTitle, chart("load_curve")),
    card(t.intensity, intensityBlock(briefing, t)),
    card(t.garmin, garminBlock(briefing, t)),
    `</div>`,
    `<footer>${esc(t.footer)} ${esc(lastSync ?? t.never)}</footer>`,
  ].join("");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

const CACHE_MS = 5 * 60_000;

/** HTTP handler: GET and HEAD only, the page cached for five minutes (each build asks Garmin for a few live figures). */
export function dashboardHandler(deps: Deps) {
  let cached: { at: number; html: string } | null = null;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return true;
    }
    try {
      if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), html: await renderDashboard(deps) };
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      // The page is static HTML and CSS: it loads nothing and runs nothing.
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(req.method === "HEAD" ? undefined : cached.html);
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("The coach dashboard could not be built.");
    }
    return true;
  };
}

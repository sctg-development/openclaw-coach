/**
 * The daily briefing as an e-mail: HTML (tables, inline CSS, one centred column), plain text and
 * subject, built from results the models already computed. Pure functions, no I/O: the same input gives
 * the same bytes, so the layout is tested and does not depend on which model assembles the message.
 * Every text that comes from outside (the model's sentence and bullets) is escaped.
 */
import { LABELS, type Lang } from "./charts/labels.ts";
import { THEMES } from "./charts/svg.ts";
import type { LoadStatus } from "./science/loadstatus.ts";
import type { Ceiling } from "./science/readiness.ts";

export type EmailChart = { id: string; cid: string; displayWidth: number; alt: string };

export type EmailSession = { type: string | null; name: string | null; durationMin: number | null; avgHr: number | null; load: number | null };

export type EmailInput = {
  lang: Lang;
  date: string;
  ceiling: Ceiling;
  /** One sentence: what to do today. */
  headline: string;
  /** At most 3 bullets, main cause first. */
  why: string[];
  /** Cautions only. */
  watch: string[];
  charts: EmailChart[];
  sleep: { durationH: number | null; needH: number | null; efficiencyPct: number | null; bedtime: string | null; wakeTime: string | null } | null;
  /** Sessions of the previous day. */
  sessions: EmailSession[];
  load: { ctl: number | null; atl: number | null; tsb: number | null; weekChangePct: number | null } | null;
  /** Cardiac and muscular load status (see loadstatus.ts). Optional: older callers omit it. */
  loadStatus?: { cardiac: LoadStatusLine | null; muscular: LoadStatusLine | null };
  /** Intensity minutes of the last 7 days (moderate + 2 x vigorous) and their share of the 150-minute guideline. */
  intensity?: { equivalentMin: number | null; percentOfMinimum: number | null } | null;
};

export type LoadStatusLine = { value: number; status: LoadStatus; low: number; high: number };

export type BriefingEmail = { subject: string; html: string; text: string };

type Strings = {
  subject: (weekdayDate: string, ceiling: string) => string;
  banner: string;
  why: string;
  watch: string;
  sleep: string;
  yesterday: string;
  load: string;
  duration: string;
  efficiency: string;
  bedtime: string;
  wake: string;
  noSession: string;
  hr: string;
  week: string;
  noData: string;
  footerFeel: string;
  footerDisclaimer: string;
  meaning: Record<Ceiling, string>;
};

const STRINGS: Record<Lang, Strings> = {
  en: {
    subject: (weekdayDate, ceiling) => `Briefing for ${weekdayDate}: ${ceiling}`,
    banner: "Today's ceiling",
    why: "Why",
    watch: "To watch",
    sleep: "Sleep",
    yesterday: "Yesterday's session",
    load: "Load",
    duration: "Duration",
    efficiency: "Efficiency",
    bedtime: "Bedtime",
    wake: "Wake-up",
    noSession: "No session yesterday",
    hr: "avg HR",
    week: "7 days",
    noData: "n/a",
    footerFeel: "Tell me how you feel (fatigue, pain, motivation).",
    footerDisclaimer: "This message is a training aid, not medical advice.",
    meaning: {
      rest: "Rest or very light movement only today.",
      easy: "Easy aerobic session today (zones 1-2), no intensity.",
      moderate: "Steady aerobic or tempo work is fine today; skip maximal or very long efforts.",
      hard: "Nothing argues against your planned hard or long session today.",
    },
  },
  fr: {
    subject: (weekdayDate, ceiling) => `Briefing du ${weekdayDate} : ${ceiling}`,
    banner: "Plafond du jour",
    why: "Pourquoi",
    watch: "À surveiller",
    sleep: "Sommeil",
    yesterday: "Séance d'hier",
    load: "Charge",
    duration: "Durée",
    efficiency: "Efficacité",
    bedtime: "Coucher",
    wake: "Réveil",
    noSession: "Aucune séance hier",
    hr: "FC moy.",
    week: "7 j",
    noData: "n/d",
    footerFeel: "Dis-moi comment tu te sens (fatigue, douleurs, motivation).",
    footerDisclaimer: "Ce message est une aide à l'entraînement, pas un avis médical.",
    meaning: {
      rest: "Repos ou mouvement très léger uniquement aujourd'hui.",
      easy: "Séance aérobie légère (zones 1-2) aujourd'hui, sans intensité.",
      moderate: "Aérobie soutenu ou allure tempo possible ; évite les efforts maximaux ou très longs.",
      hard: "Rien ne s'oppose à ta séance intense ou longue prévue aujourd'hui.",
    },
  },
};

export function defaultHeadline(lang: Lang, ceiling: Ceiling): string {
  return STRINGS[lang].meaning[ceiling];
}

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** "mardi 17 novembre" / "Tuesday, November 17" for an ISO date, independent of the host time zone. */
export function longDate(date: string, lang: Lang): string {
  const formatter = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-US", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return formatter.format(new Date(`${date}T12:00:00Z`));
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const TEXT = "#111827";
const MUTED = "#6b7280";

/** French puts a space before a colon. */
function colon(lang: Lang, label: string): string {
  return lang === "fr" ? `${label} :` : `${label}:`;
}

function num(value: number | null | undefined, digits: number, unit = ""): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : `${value.toFixed(digits)}${unit}`;
}

function signed(value: number | null | undefined, digits: number, unit = ""): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}${unit}`;
}

function image(chart: EmailChart, width: number): string {
  return `<img src="cid:${escapeHtml(chart.cid)}" width="${width}" alt="${escapeHtml(chart.alt)}" style="display:block;margin:0 auto;max-width:100%;height:auto;border:0">`;
}

function heading(label: string): string {
  return `<tr><td style="padding:20px 20px 4px 20px;font-size:17px;font-weight:600;color:${TEXT}">${escapeHtml(label)}</td></tr>`;
}

function bullets(items: string[]): string {
  const lis = items.map((item) => `<li style="margin:0 0 4px 0">${escapeHtml(item)}</li>`).join("");
  return `<tr><td style="padding:0 20px 0 20px;font-size:15px;line-height:1.45;color:${TEXT}"><ul style="margin:4px 0 0 0;padding-left:20px">${lis}</ul></td></tr>`;
}

function imageRow(chart: EmailChart | undefined): string {
  return chart ? `<tr><td align="center" style="padding:16px 10px 0 10px">${image(chart, chart.displayWidth)}</td></tr>` : "";
}

/** The three figures people want without opening the images. */
function summaryColumns(input: EmailInput, t: Strings): Array<{ title: string; lines: string[] }> {
  const sleepLines: string[] = [];
  if (input.sleep) {
    const duration = num(input.sleep.durationH, 1);
    const need = num(input.sleep.needH, 1);
    if (duration) sleepLines.push(`${t.duration}: ${duration} h${need ? ` / ${need} h` : ""}`);
    const efficiency = num(input.sleep.efficiencyPct, 0, " %");
    if (efficiency) sleepLines.push(`${t.efficiency}: ${efficiency}`);
    if (input.sleep.bedtime || input.sleep.wakeTime) sleepLines.push(`${t.bedtime}: ${input.sleep.bedtime ?? t.noData}, ${t.wake}: ${input.sleep.wakeTime ?? t.noData}`);
  }
  if (!sleepLines.length) sleepLines.push(t.noData);

  const sessionLines: string[] = [];
  for (const session of input.sessions) {
    const label = session.name ?? session.type ?? "";
    const parts = [label, session.durationMin !== null ? `${Math.round(session.durationMin)} min` : null, session.avgHr !== null ? `${t.hr} ${Math.round(session.avgHr)}` : null, session.load !== null ? `${t.load.toLowerCase()} ${Math.round(session.load)}` : null].filter(Boolean);
    sessionLines.push(parts.join(", "));
  }
  if (!sessionLines.length) sessionLines.push(t.noSession);

  const loadLines: string[] = [];
  if (input.load) {
    const ctl = num(input.load.ctl, 1);
    const atl = num(input.load.atl, 1);
    const tsb = signed(input.load.tsb, 1);
    const change = signed(input.load.weekChangePct, 0, " %");
    if (ctl) loadLines.push(`CTL: ${ctl}`);
    if (atl) loadLines.push(`ATL: ${atl}`);
    if (tsb) loadLines.push(`TSB: ${tsb}`);
    if (change) loadLines.push(`${t.week}: ${change}`);
  }
  if (!loadLines.length) loadLines.push(t.noData);

  const names = LABELS[input.lang].loadStatus;
  const statusLines: string[] = [];
  for (const [label, line] of [[names.cardiac, input.loadStatus?.cardiac], [names.muscular, input.loadStatus?.muscular]] as const) {
    if (line) statusLines.push(`${label}: ${line.value} · ${names.statuses[line.status]} (${names.range.toLowerCase()} ${line.low}-${line.high})`);
  }
  if (input.intensity?.equivalentMin != null) {
    const share = input.intensity.percentOfMinimum != null ? ` (${input.intensity.percentOfMinimum} %)` : "";
    statusLines.push(`${input.lang === "fr" ? "Minutes d'intensité" : "Intensity minutes"}: ${Math.round(input.intensity.equivalentMin)} / 150${share}`);
  }

  return [
    { title: t.sleep, lines: sleepLines },
    { title: t.yesterday, lines: sessionLines },
    { title: t.load, lines: loadLines },
    ...(statusLines.length ? [{ title: input.lang === "fr" ? "Charge et intensité" : "Load status", lines: statusLines }] : []),
  ];
}

export function renderBriefingEmail(input: EmailInput): BriefingEmail {
  const t = STRINGS[input.lang];
  const ceilingLabel = LABELS[input.lang].ceilings[input.ceiling];
  const color = THEMES.light.ceiling[input.ceiling];
  const chart = (id: string) => input.charts.find((candidate) => candidate.id === id);
  const subject = t.subject(longDate(input.date, input.lang), ceilingLabel);

  const rows: string[] = [];
  rows.push(`<tr><td style="background:${color};padding:14px 20px;font-size:20px;font-weight:600;color:#ffffff">${escapeHtml(colon(input.lang, t.banner))} ${escapeHtml(ceilingLabel)}</td></tr>`);
  rows.push(`<tr><td style="background:#f9fafb;padding:12px 20px;font-size:15px;line-height:1.45;color:${TEXT}">${escapeHtml(input.headline)}</td></tr>`);

  const gauge = chart("recovery_gauge");
  const ceiling = chart("ceiling");
  if (gauge || ceiling) {
    const cell = (item: EmailChart | undefined) => `<td width="50%" align="center" valign="top" style="padding:0 5px">${item ? image(item, Math.min(item.displayWidth, 280)) : ""}</td>`;
    rows.push(`<tr><td style="padding:16px 10px 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cell(gauge)}${cell(ceiling)}</tr></table></td></tr>`);
  }
  if (input.why.length) rows.push(heading(colon(input.lang, t.why)), bullets(input.why));
  rows.push(imageRow(chart("signals")), imageRow(chart("hrv_trend")), imageRow(chart("sleep_nights")), imageRow(chart("cardiac_load")), imageRow(chart("muscular_load")), imageRow(chart("intensity")), imageRow(chart("load_curve")));
  if (input.watch.length) rows.push(heading(colon(input.lang, t.watch)), bullets(input.watch));

  // The load statuses and intensity minutes are drawn as charts in the HTML; their lines stay in the plain-text version
  // (the fourth column) for clients that show no images.
  const columns = summaryColumns(input, t);
  const tableColumns = columns.slice(0, 3);
  const th = tableColumns.map((column) => `<td width="33%" valign="top" style="padding:6px 8px;font-size:13px;font-weight:600;color:${TEXT};border:1px solid #d1d5db;background:#f3f4f6">${escapeHtml(column.title)}</td>`).join("");
  const td = tableColumns.map((column) => `<td width="33%" valign="top" style="padding:6px 8px;font-size:13px;line-height:1.5;color:${TEXT};border:1px solid #d1d5db">${column.lines.map(escapeHtml).join("<br>")}</td>`).join("");
  rows.push(`<tr><td style="padding:20px 20px 0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${th}</tr><tr>${td}</tr></table></td></tr>`);
  rows.push(`<tr><td align="center" style="padding:24px 20px 28px 20px;font-size:13px;line-height:1.5;color:${MUTED}">${escapeHtml(t.footerFeel)}<br>${escapeHtml(t.footerDisclaimer)}</td></tr>`);

  const html =
    `<!DOCTYPE html><html lang="${input.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff"><tr><td align="center">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;font-family:${FONT}">${rows.join("")}</table>` +
    `</td></tr></table></body></html>`;

  const text = [
    `${colon(input.lang, t.banner)} ${ceilingLabel}`,
    input.headline,
    ...(input.why.length ? ["", colon(input.lang, t.why), ...input.why.map((item) => `- ${item}`)] : []),
    ...(input.watch.length ? ["", colon(input.lang, t.watch), ...input.watch.map((item) => `- ${item}`)] : []),
    "",
    ...columns.flatMap((column) => [`${colon(input.lang, column.title)} ${column.lines.join(" ; ")}`]),
    "",
    t.footerFeel,
    t.footerDisclaimer,
  ].join("\n");

  return { subject, html, text };
}

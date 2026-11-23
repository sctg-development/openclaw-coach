export type Lang = "en" | "fr";

type Strings = {
  recovery: string;
  of100: string;
  bands: Record<"low" | "moderate" | "high", string>;
  noScore: string;
  ceilingTitle: string;
  ceilings: Record<"rest" | "easy" | "moderate" | "hard", string>;
  suggestedLoad: string;
  signalsTitle: string;
  signalsSubtitle: string;
  signals: Record<"hrv" | "restingHr" | "respiration" | "skinTemp" | "spo2", string>;
  noData: string;
  hrvTitle: string;
  hrvSubtitle: string;
  nightly: string;
  trend7: string;
  normalRange: string;
  loadTitle: string;
  intensity: { title: string; subtitle: string; thisWeek: string; minimum: string };
  loadStatus: { cardiac: string; muscular: string; range: string; value: string; statuses: Record<"calibrating" | "undertraining" | "maintaining" | "optimal" | "productive" | "strained" | "overreaching", string> };
  fitness: string;
  fatigue: string;
  form: string;
  sleepTitle: string;
  need: string;
  deep: string;
  light: string;
  rem: string;
  unknownStages: string;
  hours: string;
  months: string[];
  weekdays: string[];
  /** Alt texts. */
  altGauge: (score: number | null, band: string | null) => string;
  altCeiling: (ceiling: string) => string;
};

export const LABELS: Record<Lang, Strings> = {
  en: {
    recovery: "Recovery",
    of100: "/100",
    bands: { low: "Low", moderate: "Moderate", high: "High" },
    noScore: "Not enough data",
    ceilingTitle: "Today's ceiling",
    ceilings: { rest: "Rest", easy: "Easy", moderate: "Moderate", hard: "Hard" },
    suggestedLoad: "Suggested load",
    signalsTitle: "Overnight signals vs your normal",
    signalsSubtitle: "Dot = last night; blue band = usual range (±1 SD), grey = ±2 SD",
    signals: { hrv: "HRV", restingHr: "Resting HR", respiration: "Respiration", skinTemp: "Skin temp.", spo2: "SpO2" },
    noData: "no data",
    hrvTitle: "Heart rate variability",
    hrvSubtitle: "Overnight rMSSD (ms), 7-day trend and personal normal range",
    nightly: "Night",
    trend7: "7-day mean",
    normalRange: "Normal range",
    loadTitle: "Fitness, fatigue and form",
    intensity: { title: "Intensity minutes", subtitle: "Moderate + 2 × vigorous, per week · dashed line = 150 min guideline", thisWeek: "7 days", minimum: "150 min" },
    loadStatus: {
      cardiac: "Cardiac load",
      muscular: "Muscular load",
      range: "Optimal range",
      value: "7-day load",
      statuses: { calibrating: "Calibrating", undertraining: "Undertraining", maintaining: "Maintaining", optimal: "Optimal", productive: "Productive", strained: "Strained", overreaching: "Overreaching" },
    },
    fitness: "Fitness (CTL)",
    fatigue: "Fatigue (ATL)",
    form: "Form (TSB)",
    sleepTitle: "Sleep",
    need: "Need",
    deep: "Deep",
    light: "Light",
    rem: "REM",
    unknownStages: "Total",
    hours: "h",
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    weekdays: ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
    altGauge: (score, band) => (score === null ? "Recovery index: not enough data." : `Recovery index ${score} out of 100 (${band}).`),
    altCeiling: (ceiling) => `Training ceiling for today: ${ceiling}.`,
  },
  fr: {
    recovery: "Récupération",
    of100: "/100",
    bands: { low: "Basse", moderate: "Moyenne", high: "Haute" },
    noScore: "Données insuffisantes",
    ceilingTitle: "Plafond du jour",
    ceilings: { rest: "Repos", easy: "Facile", moderate: "Modéré", hard: "Intense" },
    suggestedLoad: "Charge suggérée",
    signalsTitle: "Signaux de la nuit vs votre normale",
    signalsSubtitle: "Point = nuit dernière ; bande bleue = plage habituelle (±1 É.T.), grise = ±2 É.T.",
    signals: { hrv: "VFC", restingHr: "FC repos", respiration: "Respiration", skinTemp: "Temp. peau", spo2: "SpO2" },
    noData: "pas de données",
    hrvTitle: "Variabilité de la fréquence cardiaque",
    hrvSubtitle: "rMSSD nocturne (ms), tendance sur 7 jours et plage normale personnelle",
    nightly: "Nuit",
    trend7: "Moyenne 7 j",
    normalRange: "Plage normale",
    loadTitle: "Forme physique, fatigue et fraîcheur",
    intensity: { title: "Minutes d'intensité", subtitle: "Modérées + 2 × vigoureuses, par semaine · pointillé = 150 min recommandées", thisWeek: "7 jours", minimum: "150 min" },
    loadStatus: {
      cardiac: "Charge cardiaque",
      muscular: "Charge musculaire",
      range: "Plage optimale",
      value: "Charge sur 7 jours",
      statuses: { calibrating: "Étalonnage", undertraining: "Manque d'entraînement", maintaining: "Maintien", optimal: "Optimal", productive: "Productif", strained: "Fatigue", overreaching: "Surentraînement" },
    },
    fitness: "Forme (CTL)",
    fatigue: "Fatigue (ATL)",
    form: "Fraîcheur (TSB)",
    sleepTitle: "Sommeil",
    need: "Besoin",
    deep: "Profond",
    light: "Léger",
    rem: "Paradoxal",
    unknownStages: "Total",
    hours: "h",
    months: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
    weekdays: ["D", "L", "M", "M", "J", "V", "S"],
    altGauge: (score, band) => (score === null ? "Indice de récupération : données insuffisantes." : `Indice de récupération ${score} sur 100 (${band}).`),
    altCeiling: (ceiling) => `Plafond d'entraînement du jour : ${ceiling}.`,
  },
};

export function shortDate(date: string, lang: Lang): string {
  const month = LABELS[lang].months[Number(date.slice(5, 7)) - 1] ?? "";
  const day = Number(date.slice(8, 10));
  return lang === "fr" ? `${day} ${month}` : `${month} ${day}`;
}

/** Resolves the athlete's physiological anchors: configuration first, then data, then formulas. */

import type { CoachConfig } from "./config.ts";
import { hrMaxFromAge, observedHrMax } from "./science/performance.ts";
import { median, valid } from "./science/stats.ts";
import type { Activity, DayRecord, Profile } from "./types.ts";

const DEFAULT_SLEEP_NEED_H = 8;

export function resolveProfile(config: CoachConfig, days: readonly DayRecord[], activities: readonly Activity[], storedLthr: number | null, today: string): Profile {
  let hrMax = config.hrMax;
  let hrMaxSource: Profile["hrMaxSource"] = hrMax !== null ? "config" : null;
  if (hrMax === null) {
    const observed = observedHrMax(activities);
    if (observed !== null) {
      hrMax = observed;
      hrMaxSource = "observed";
    } else if (config.birthYear !== null) {
      hrMax = hrMaxFromAge(Number(today.slice(0, 4)) - config.birthYear);
      hrMaxSource = "age-formula";
    }
  }

  let hrRest = config.hrRest;
  let hrRestSource: Profile["hrRestSource"] = hrRest !== null ? "config" : null;
  if (hrRest === null) {
    const recent = valid(days.slice(-60).map((day) => day.restingHr));
    const baseline = recent.length >= 7 ? median(recent) : null;
    if (baseline !== null) {
      hrRest = Math.round(baseline);
      hrRestSource = "baseline";
    }
  }

  const lthr = config.lthr ?? storedLthr;
  return {
    sex: config.sex,
    birthYear: config.birthYear,
    hrMax,
    hrMaxSource,
    hrRest,
    hrRestSource,
    lthr,
    lthrSource: lthr === null ? null : config.lthr !== null ? "config" : "garmin",
    sleepNeedS: (config.sleepNeedHours ?? DEFAULT_SLEEP_NEED_H) * 3600,
    sleepNeedSource: config.sleepNeedHours !== null ? "config" : "default",
    hrZoneFloorsPctMax: config.hrZoneFloorsPctMax,
  };
}

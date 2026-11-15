# OpenClaw Coach

An endurance and recovery coach plugin for [OpenClaw](https://github.com/openclaw/openclaw), built on
[garmin-cli](https://github.com/sctg-development/garmin-cli) (the `gc` CLI for Garmin Connect).

Version 2 is a rewrite. Version 1 handed raw Garmin payloads to the model; version 2 **computes documented
physiological models in code** and gives the model compact, sourced results to interpret:

- **HRV** against the athlete's own baseline (ln rMSSD, 7-day trend, normal range, stability);
- a **recovery index** and its components (HRV, resting heart rate, sleep, respiratory rate, skin temperature);
- **early-warning** flags when several signals move together;
- **sleep** sufficiency, running debt and regularity;
- **training load** (Banister TRIMP, fitness, fatigue, form, monotony, intensity distribution) with
  **projection of a plan**;
- a daily **training ceiling** (rest / easy / moderate / hard) with the rules behind it;
- activity analysis (grade-adjusted pace, aerobic decoupling), zones and paces, strength summaries,
  a habit journal with association statistics, long-term health markers.

Every formula, constant, threshold, level of evidence and limit is in
[`docs/SCIENCE.md`](docs/SCIENCE.md) (in French, written for review by sport-science and medical teams,
with a verified bibliography and LLM recommendations). The coaching behaviour and safety rules are in
[`skills/coach/SKILL.md`](skills/coach/SKILL.md).

This is a coaching aid for a healthy training adult. It is not a medical device and makes no diagnosis.

## Requirements

- An OpenClaw Gateway (2026.8.2+).
- [`gc`](https://github.com/sctg-development/garmin-cli) **0.4.0 or later** (for `gc daily`), installed
  and authenticated (`gc login ...`) in the environment the Gateway runs in.

## Install

```bash
openclaw plugins install npm:@sctg/openclaw-coach
```

## Set up

1. Check that `gc status` succeeds in the Gateway's environment.
2. Configure the athlete's anchors (see Configuration). At least `timezone`, `sex` and a measured `hrMax`.
3. Ask the coach to run `coach_data_status` with `sync: true`: it fetches 90 days of recovery signals and
   180 days of activities (about 25 Garmin requests), and says what is missing.
4. Create `ATHLETE.md` in the workspace from the template in the skill, or ask the coach to do it with you.
5. Optionally schedule check-ins with OpenClaw Automations (recipes in the skill).

Baselines need history: HRV and recovery are `calibrating` until 14 nights exist, and the load model
needs about a month to be usable and three months to be stable.

## Tools

| Tool | Purpose | Writes |
|---|---|---|
| `coach_daily_briefing` | Ceiling for the day, recovery, HRV, sleep, early warning, load, yesterday's sessions | local store |
| `coach_trends` | Weekly aggregates, load indicators, long-term health markers | local store |
| `coach_training_load` | Load model and projection of a plan | local store |
| `coach_activity_deep_dive` | One activity: laps, grade-adjusted pace, decoupling, heat | — |
| `coach_zones_and_paces` | Heart-rate zones, VDOT paces, race equivalences | — |
| `coach_strength_analysis` | One strength session: volume, estimated 1RM | — |
| `coach_journal_log` | Subjective check-in, symptoms, habits | local journal |
| `coach_journal_insights` | Associations between habits and the following night | — |
| `coach_workout_push` | Create a workout in Garmin Connect (preview, then explicit confirmation) | **Garmin Connect** |
| `coach_data_status` | Coverage, sync errors, anchors in use | local store |

Version 1's `coach_garmin_digest` is gone: replace it with `coach_daily_briefing` in existing automations.

## Configuration

| Key | Default | Description |
|---|---|---|
| `gcBinary` | `gc` | Path to the garmin-cli binary. |
| `timezone` | Gateway timezone | IANA timezone of the athlete (day boundaries). |
| `dataDir` | `~/.openclaw/coach` | Local store directory. |
| `sex` | — | `male` or `female`: training-load coefficients. |
| `birthYear` | — | Only used to estimate maximum heart rate when none is measured. |
| `hrMax` | observed, else age formula | Measured maximum heart rate (bpm). Strongly recommended. |
| `hrRest` | 60-day median | Resting heart rate (bpm). |
| `lthr` | Garmin's estimate | Lactate-threshold heart rate (bpm). |
| `sleepNeedHours` | `8` | Used when Garmin reports no personal sleep need. |
| `hrZoneFloorsPctMax` | `[50,60,70,80,90]` | Lower bound of zones 1-5, in percent of maximum heart rate. |
| `historyDays` | `90` | Days of recovery history kept in sync. |
| `loadHistoryDays` | `180` | Days of activities used by the load model. |
| `retentionDays` | `730` | Older stored data is deleted. |
| `cacheMinutes` | `15` | Minimum delay between two fetches of recent days. |
| `allowWorkoutPush` | `false` | Allow `coach_workout_push` to write to Garmin Connect. |

```json5
{
  plugins: {
    entries: {
      coach: {
        config: { timezone: "Europe/Paris", sex: "male", birthYear: 1975, hrMax: 182 },
      },
    },
  },
}
```

## Data and privacy

The plugin keeps a single JSON file (`coach-store.json`, owner-only permissions) with nightly aggregates,
the activity list and the journal: no intraday series, no GPS tracks, no credentials. Delete the file to
erase everything. Tool results, the journal and `ATHLETE.md` are sent to whichever LLM provider the
Gateway uses: that is health data, so choose the provider accordingly (see `docs/SCIENCE.md`, section 10).

## Development

```bash
npm ci
npm run typecheck
npm test          # 38 tests, synthetic data, no Garmin access needed
npm run build
```

The models are pure functions in `src/science/`; `src/tools.ts` takes its `gc` runner and clock as
arguments, so tests run against a fake `gc`. When a formula, constant or threshold changes, bump the
model's `version` and update `docs/SCIENCE.md` in the same commit.

To check which fields your watch and account return, without exposing any value:

```bash
gc daily yesterday --keys
```

## Publishing

`.github/workflows/publish.yml` publishes to npm when a GitHub Release is published. It checks that
`package.json`'s version matches the release tag (`vX.Y.Z`).

## License

MIT — see [LICENSE](LICENSE).

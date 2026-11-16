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
[`docs/SCIENCE.md`](docs/SCIENCE.md) (written for review by sport-science and medical teams,
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
4. Create `ATHLETE.md` (and, when you want the coach to follow a plan, `PLAN.md`) in the agent's workspace: see
   [Workspace files](#workspace-files).
5. Optionally schedule check-ins with OpenClaw Automations (recipes in the skill).

Baselines need history: HRV and recovery are `calibrating` until 14 nights exist, and the load model
needs about a month to be usable and three months to be stable.

## Workspace files

The coach computes from your watch data; what the watch cannot know (your goal, injuries, constraints,
availability, the plan) lives in two plain Markdown files in the **agent's workspace**, which the coach reads
at the start of its routines.

| File | Required | Who writes it | Role |
|---|---|---|---|
| `ATHLETE.md` | Strongly recommended | You, once, then when your situation changes | Bio, measured anchors, goal, injury and medical history, **binding constraints**, availability, preferences |
| `PLAN.md` | Optional | The coach (you can edit it too) | Phases, the next 7 days, adjustment rules, log of changes |

Examples with a fictional athlete are in [`examples/ATHLETE.md`](examples/ATHLETE.md) and
[`examples/PLAN.md`](examples/PLAN.md). The constraints in `ATHLETE.md` are never overridden by the coach or
by a model output; symptoms always come before signals.

### Where they go

The workspace is `~/.openclaw/workspace/` of the user running the Gateway (`agents.defaults.workspace`
can move it). In the OpenClaw container image this is
`/home/node/.openclaw/workspace/`, on the persistent volume:

```text
~/.openclaw/workspace/ATHLETE.md
~/.openclaw/workspace/PLAN.md
```

### How to create them

1. **With the coach (simplest).** Say: "Create my ATHLETE.md; ask me the questions you need, one block at a
   time, and show it to me before saving." The coach follows the template in
   [`skills/coach/SKILL.md`](skills/coach/SKILL.md). For `PLAN.md`, give your goal and availability and ask
   for a plan; the coach projects it with `coach_training_load` before saving it.
2. **By hand.** Copy the examples and replace every value:

   ```bash
   cp examples/ATHLETE.md ~/.openclaw/workspace/ATHLETE.md
   cp examples/PLAN.md    ~/.openclaw/workspace/PLAN.md
   ```

   On a Kubernetes deployment, copy into the pod instead
   (`kubectl cp ATHLETE.md <namespace>/<pod>:/home/node/.openclaw/workspace/ATHLETE.md -c gateway`).
3. **Seeded by the Helm chart** (`sctg-claw`): put the content under `openclaw.workspaceFiles.ATHLETE.md` in
   your **private** values. The init container copies it on first boot only (an existing file on the volume
   is kept), so later edits are made in the workspace, not in the values. Do not put health data in a public
   chart.

Tips: keep `ATHLETE.md` under about one page (it is sent to the LLM provider in every session, see
[Data and privacy](#data-and-privacy)); write measured values with how and when they were measured; put every
restriction in *Current constraints* as an instruction ("no ...", "at most ..."), with the date of the next
review; remove a constraint only when the person who set it lifts it. Also set `hrMax` and `lthr` in the plugin
configuration: the files are for the coach, the configuration is for the models.

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
| `coach_briefing_charts` | Render the day's figures as PNG images (gauge, ceiling, signals, HRV, load, sleep) for an email | PNG files in `dataDir/charts` |
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
| `language` | `en` | Language of the chart labels: `en` or `fr`. |
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

## Charts for emails

`coach_briefing_charts` draws the day's figures as PNG images, from the same model results as
`coach_daily_briefing` (it computes nothing of its own):

| Chart id | Size (px) | Shows |
|---|---|---|
| `recovery_gauge` | 280 x 210 | Recovery index 0-100 on a three-band gauge |
| `ceiling` | 280 x 210 | Today's ceiling (rest / easy / moderate / hard) and the suggested load |
| `signals` | 600 x 246 | Last night's HRV, resting heart rate, respiration, skin temperature and SpO2 against your own usual range |
| `hrv_trend` | 600 x 260 | 28 nights of HRV, the 7-day trend and the personal normal range |
| `load_curve` | 600 x 350 | 8 weeks of fitness (CTL), fatigue (ATL) and form (TSB) |
| `sleep_nights` | 600 x 260 | 14 nights, stacked by stage, against the sleep need |

Images are rendered at twice their display size (sharp on high-density screens) with a bundled font
([Inter](assets/fonts/LICENSE.txt), SIL OFL), so the output does not depend on the fonts of the host. A chart
without enough data is skipped with the reason. Parameters: `charts` (subset), `lang` (`en` or `fr`, default
the `language` setting), `theme` (`light` or `dark`, default `light`: an email keeps its own opaque card).
Files are written to `<dataDir>/charts/<date>/<id>.png` (owner-only permissions) and folders older than 14
days are deleted.

To put them **inside** an email, the mail tool must send them as inline images: with the `sctg-mail`
plugin's `send_email`, pass each chart as `inlineImages: [{ cid, path }]` and reference it in the HTML:

```html
<table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr>
  <td width="300"><img src="cid:coach-recovery_gauge" width="280" alt="Recovery 51/100 (moderate)"></td>
  <td width="300"><img src="cid:coach-ceiling" width="280" alt="Today's ceiling: easy"></td>
</tr></table>
<img src="cid:coach-hrv_trend" width="600" alt="HRV trend" style="display:block;max-width:100%;height:auto">
```

The tool result already contains, for each chart, the `cid` (`coach-<id>`), the `path`, the display size and a
ready-made `alt` text. `send_email` only reads image files from `~/.openclaw/coach/charts` (configurable with
its `inlineImageRoots`), refuses anything that is not a real PNG or JPEG, and falls back to a text-only
rendering on channels that cannot carry inline images. Always write the `alt` text: many mail clients block
images until the reader allows them.

## Data and privacy

The plugin keeps a single JSON file (`coach-store.json`, owner-only permissions) with nightly aggregates,
the activity list and the journal: no intraday series, no GPS tracks, no credentials. Delete the file to
erase everything. Tool results, the journal and `ATHLETE.md` are sent to whichever LLM provider the
Gateway uses: that is health data, so choose the provider accordingly (see `docs/SCIENCE.md`, section 10).

## Development

```bash
npm ci
npm run typecheck
npm test          # 40 tests, synthetic data, no Garmin access needed
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

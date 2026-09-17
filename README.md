# OpenClaw Coach

An AI endurance coach plugin for [OpenClaw](https://github.com/openclaw/openclaw),
built on top of [garmin-cli](https://github.com/sctg-development/garmin-cli)
(the `gc` CLI for Garmin Connect).

It ships:

- A `coach` skill with a coaching workflow and safety framing (see
  [`skills/coach/SKILL.md`](skills/coach/SKILL.md)).
- One tool, `coach_garmin_digest`, that aggregates the handful of `gc`
  commands a coaching check-in actually needs (recent activities, training
  readiness/status, body battery, sleep, weight trend, race predictions)
  into a single call.

It deliberately does **not** ship its own scheduler or a bundled athlete
profile. Proactive check-ins use OpenClaw's built-in
[Automations](https://docs.openclaw.ai/automation/cron-jobs) (`openclaw
automations create ...`), and the athlete's actual profile — bio, personal
records, goal race, injury/medical history, current constraints — lives in a
workspace `ATHLETE.md` file you maintain yourself, the same way OpenClaw
already handles `AGENTS.md`/`SOUL.md`/`USER.md`. That file is never part of
this repo: it's personal health data, and this plugin is public.

## Requirements

- An OpenClaw Gateway (2026.8.2+).
- [`gc`](https://github.com/sctg-development/garmin-cli) installed and
  authenticated (`gc login ...`) in the same environment the Gateway runs
  in. The bundled [`garmin`](https://github.com/openclaw/openclaw/tree/main/skills/garmin)
  skill already documents this.

## Install

```bash
openclaw plugins install npm:@sctg-development/openclaw-coach
```

Or as a git submodule alongside a local OpenClaw checkout, matching how this
was originally built — see the parent deployment's plugin loading setup for
the exact wiring.

## Set up

1. Confirm `gc status` succeeds in the Gateway's environment.
2. Create `ATHLETE.md` in your OpenClaw workspace from the template in
   [`skills/coach/SKILL.md`](skills/coach/SKILL.md#athletemd-template), or
   just ask the coach to create it with you.
3. Optionally, set up a proactive check-in — see
   [the skill's "Proactive check-ins" section](skills/coach/SKILL.md#proactive-check-ins)
   for the `openclaw automations create` recipe.
4. Ask the coach for a status update, a plan, or anything else — it reads
   `ATHLETE.md` and pulls Garmin data as needed.

## Configuration

| Key         | Type   | Default | Description                                     |
| ----------- | ------ | ------- | ------------------------------------------------ |
| `gcBinary`  | string | `"gc"`  | Path to the garmin-cli binary, if not on `PATH`. |

```json5
{
  plugins: {
    entries: {
      coach: {
        config: { gcBinary: "/usr/local/bin/gc" },
      },
    },
  },
}
```

## Why so little custom code?

Most of what an "AI coach" needs is already solved by OpenClaw itself: full
Garmin data access (the `garmin` skill), scheduling (Automations), and
durable per-athlete context (workspace files). This plugin's job is the one
thing those don't cover well on their own — collapsing several Garmin calls
into one coaching-shaped digest — plus the coaching methodology and safety
framing as a skill. See [`skills/coach/SKILL.md`](skills/coach/SKILL.md) for
the actual coaching logic; it lives in prose, not code, because a coach's
judgment calls (how to weigh a good VO2max trend against a still-healing
fracture, for instance) belong in reasoning, not a rigid algorithm.

## License

MIT — see [LICENSE](LICENSE).

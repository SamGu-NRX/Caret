# Jev meeting scheduler

A small Next.js app for Vercel that reads a **sample email thread** and a **sample local computer history**, packages them with the **meeting-scheduler skill** into TypeSafe Jev requests, lets Jev decide what needs to be done, and schedules the meeting as tentative holds.

```
inputs/email-thread.json        the thread (Anna Keller / Paul, "Contract renewal")
inputs/computer-history.json    SYNTHETIC screenpipe-style activity: calendar view, Slack, SBB search, notes
inputs/timetable-basel-zurich.json  sourced, dated SBB connections (only the windows actually looked up)
skills/meeting-scheduler/       SKILL.md + skill.json (the typed questions Jev answers)
lib/                            jev client (+mock), planner, scheduler, pipeline
app/                            one page + POST /api/run
```

## How it decides

1. **Extract** (Jev, one call): intent, agreement in principle, who travels, venue, date window, excluded weekdays, duration, whether legal should attend, travel mode, register, language.
2. **Plan** (code): candidate days in the window minus excluded weekdays, weekends and holidays; for each candidate start time, the latest verified train that arrives in time and the earliest verified train back; the door-to-door block is checked against calendar events found in the computer history. Anything the timetable does not cover is dropped with a reason.
3. **Rank** (Jev, one call): `best_option` over the candidates plus one `option_<id>_acceptable` noul each.
4. **Schedule** (code): tentative holds (best first), `.ics` export, optional `SCHEDULE_WEBHOOK_URL` POST, and a draft reply built from fixed sentences and sourced facts. Nothing is sent.

Jev never writes text; it only picks from options you define. Email and screen text are treated as evidence, not instructions.

## Run

```sh
cd jev-scheduler
npm install
cp .env.example .env.local   # add TYPESAFE_API_KEY; without it the app uses a labeled deterministic mock
npm run dev                  # http://localhost:3000
npm test                     # planner, validation and mock pipeline tests
npm run run-local            # whole pipeline in the terminal, writes last-run.json
npm run package-input        # writes jev-input.json = exact POST body for https://api.typesafe.ai/v1/systemone
```

## Deploy to Vercel

```sh
npx vercel --cwd jev-scheduler          # first deploy; pick "Next.js", accept defaults
npx vercel env add TYPESAFE_API_KEY production
npx vercel --cwd jev-scheduler --prod
```

Or import the GitHub repo in the Vercel dashboard with **Root Directory** set to `jev-scheduler` and add `TYPESAFE_API_KEY` (and optionally `SCHEDULE_WEBHOOK_URL`) under Environment Variables.

## Limits

- The computer history is synthetic. The email thread is the sample from the skill; the timetable rows were read from sbb.ch on 2026-09-19 for three dates only, so other dates are dropped as unverified.
- Holds are tentative and local (plus the optional webhook); there is no calendar or mail connector, so nothing is sent.
- The Jev token budget is roughly 32k tokens; the sample state is well under that.

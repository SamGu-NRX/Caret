# Jev meeting scheduler

A small Next.js app for Vercel that reads a **sample email thread** and a **sample local computer history**, packages them with the **meeting-scheduler skill** into TypeSafe **Jev** requests, lets Jev decide what needs to be done (schedule a meeting), and schedules it as tentative calendar holds with an `.ics` export and a draft reply.

Jev never writes text. It answers typed questions (`choice`, `score`, `noul`) over a JSON state. Code does everything factual: timetable lookup, calendar conflicts, holds. Email bodies and captured screen text are evidence, never instructions.

## Quick start

```sh
cd jev-scheduler
npm install
cp .env.example .env.local     # optional: add TYPESAFE_API_KEY (see "Reproduce the demo")
npm run dev                    # open http://localhost:3000 and click "Run through Jev"
```

Other commands:

```sh
npm test                       # 6 tests: planner, source failures, response validation, mock pipeline
npm run run-local              # whole pipeline in the terminal, prints holds + draft, writes last-run.json
npm run package-input          # writes jev-input.json = exact POST body for https://api.typesafe.ai/v1/systemone
npm run build                  # production build (what Vercel runs)
```

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Decision model | TypeSafe Jev (`jev-latest`) via `POST https://api.typesafe.ai/v1/systemone` | Bearer `TYPESAFE_API_KEY`. Two calls per run. Plain `fetch`, no SDK. |
| App | Next.js 16 (App Router, Turbopack), React 19, TypeScript | One page (`app/page.tsx`) and one route (`app/api/run/route.ts`). |
| Runtime | Node.js 20+ (24 used locally) | Scripts and tests run the `.ts` sources through Node's built-in type stripping. |
| Hosting | Vercel | Serverless route; inputs and the skill are bundled via `outputFileTracingIncludes`. |
| Storage | none | Holds are returned in the response and as `.ics`; optional webhook POST. No database. |

## Architecture

```
 inputs/                                   skills/meeting-scheduler/
 ├─ email-thread.json  ──────┐             └─ skill.json (typed questions)
 ├─ computer-history.json ───┤                        │
 └─ timetable-basel-zurich.json            ┌──────────┘
                             │             │
                             ▼             ▼
                 ┌───────────────────────────────┐
     (1) extract │  Jev call #1: state = thread  │  intent, agreement, who travels, venue,
                 │  + history; 16 questions      │  window, excluded weekdays, duration,
                 └───────────────┬───────────────┘  legal?, travel mode, register, language
                                 │ answers (choice / noul + confidence)
                                 ▼
                 ┌───────────────────────────────┐
        (2) plan │  lib/plan.ts (pure code)      │  days in window − excluded weekdays/holidays
                 │  timetable coverage + trains  │  latest train in / earliest train back
                 │  calendar events from history │  door-to-door block vs calendar → drop w/ reason
                 └───────────────┬───────────────┘
                                 │ up to 3 verified candidates A/B/C
                                 ▼
                 ┌───────────────────────────────┐
        (3) rank │  Jev call #2: + candidates    │  best_option, option_<id>_acceptable
                 └───────────────┬───────────────┘
                                 ▼
                 ┌───────────────────────────────┐
    (4) schedule │  lib/schedule.ts (pure code)  │  tentative holds (best first), .ics,
                 │                               │  optional SCHEDULE_WEBHOOK_URL, draft reply
                 └───────────────┬───────────────┘
                                 ▼
                    app/page.tsx  ←  POST /api/run (JSON)
```

Files: `lib/jev.ts` (client, validation, labeled mock), `lib/plan.ts` (planner), `lib/schedule.ts` (holds, ics, draft), `lib/pipeline.ts` (orchestration), `lib/inputs.ts` (loads the JSON inputs).

## Reproduce the demo

1. **Environment.** Create `jev-scheduler/.env.local`:

   ```ini
   # Live mode: key from https://console.typesafe.ai/keys
   TYPESAFE_API_KEY=ts_xxxxxxxxxxxxxxxxx
   TYPESAFE_MODEL=jev-latest

   # Mock mode: leave TYPESAFE_API_KEY empty, or force it with JEV_MOCK=1.
   # The UI then shows "Jev mode: mock" and the answers are deterministic and labeled as such.
   JEV_MOCK=

   # Optional: receive the holds as JSON (e.g. a Zapier/Make hook that writes Google Calendar events).
   SCHEDULE_WEBHOOK_URL=
   ```

   `.env.example` in this folder has the same keys. No other secrets are needed.

2. **Run** `npm install && npm run dev`, open http://localhost:3000, click **Run through Jev**.

3. **What you should see** (identical in mock and, barring model variance, live mode):
   - status `scheduled`; summary "Propose Contract renewal with Helvetia Parts AG office in Zürich, 2026-10-01 to 2026-10-10, 2 option(s), rail; best first: A".
   - Option A: Tue 6 Oct 11:00–12:30, ICE 09:07 Basel SBB → 10:00 Zürich HB out, EC 14:34 → 15:26 back. Option B: Thu 8 Oct 09:30–11:00, IC 3 07:33 → 08:26 out, TGV 11:34 → 12:26 back.
   - Pass 1 answers (intent `schedule_meeting`, `friday_excluded` ≈ 1, `legal_should_attend` ≈ 0), pass 2 ranking, a "Dropped (7)" list with reasons, the draft reply, and a **Download .ics holds** button.

4. **Same thing without the browser:** `npm run run-local`. **Just the Jev request:** `npm run package-input`, then

   ```sh
   curl -s https://api.typesafe.ai/v1/systemone \
     -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" \
     -d @jev-input.json
   ```

5. **Deploy to Vercel:**

   ```sh
   npx vercel --cwd jev-scheduler                  # first deploy, accept the Next.js defaults
   npx vercel env add TYPESAFE_API_KEY production
   npx vercel --cwd jev-scheduler --prod
   ```

   Or import the repo in the Vercel dashboard with **Root Directory** = `jev-scheduler` and set the same variables.

## Datasets, synthetic data and provenance

| File | What it is | Provenance |
| --- | --- | --- |
| `inputs/email-thread.json` | Two-message thread "Contract renewal" between Paul (PSI GmbH, Basel) and Anna Keller (Helvetia Parts AG, Zürich) | Sample thread shipped with the `meeting-logistics-proposer` skill; the PDF export it was parsed from is `inputs/sample-thread.pdf`. Fictional companies and people. |
| `inputs/computer-history.json` | Seven screenpipe/ActivityWatch-style entries: a Calendar week view with events, a Mail window, a Slack message from legal, an SBB search, a Maps lookup, a Notes page, a signature block | **Entirely synthetic**, written for this demo on 2026-09-19. Nothing was captured from a real machine; no real personal data. |
| `inputs/timetable-basel-zurich.json` | 24 SBB connections Basel SBB ⇄ Zürich HB for 6, 7 and 8 Oct 2026 with platform and service | Read manually from the SBB online timetable (sbb.ch/en) on 2026-09-19. Only the queried departure windows are listed under `coverage`; anything outside is treated as a failed source. Wed 7 Oct return was not captured. |
| `inputs/timetable-basel-zurich.json → holidays` | No ZH/BS public holidays 28 Sep–12 Oct 2026 | swisscalendar.com/2026 and iamexpat.ch Swiss public holidays, checked 2026-09-19. |
| `skills/meeting-scheduler/skill.json` | The two Jev question passes and planner defaults | Written for this demo. Defaults marked `assumed` in the evidence: 20 min last mile, 20 min arrival buffer, 15 min station access, candidate starts 11:00/14:00/09:30. |
| `jev-input.json` | Generated request body for pass 1 | `npm run package-input`; regenerate after editing inputs. |

The mock Jev answers in `lib/jev.ts` are hard-coded for this thread and are labeled as mock in the UI and JSON.

## Known limitations

- **Jev live mode is untested here.** The pipeline was exercised in mock mode only; the request/response contract follows the TypeSafe API docs and is validated on receipt (`lib/jev.ts`), but no live run has been recorded yet.
- **Timetable is a dated cache, not a live source.** Three dates, limited windows. Any other date is dropped as unverified by design.
- **Nothing is sent or booked.** There is no mail or calendar connector. Holds are tentative: shown in the UI, exported as `.ics`, optionally POSTed to a webhook.
- **Single corridor, single time zone.** Basel–Zürich, `Europe/Zurich`, fixed `+02:00` offset from the timetable file. The repo's Austin–Dallas target is not wired.
- **Draft reply is templated English.** Jev picks register and language, but only English sentences exist; the legal answer is a fixed sentence chosen by Jev's `legal_should_attend` noul.
- **Synthetic history is structured.** Calendar events are read from a structured `events` field, not OCR'd from text.
- **Jev state budget** is about 32k tokens; the sample is ~4k characters, but a long real thread would need trimming.

## Next steps

1. Record a live Jev run (`TYPESAFE_API_KEY`) and commit the answers next to `jev-input.json` for comparison with the mock.
2. Replace the cached timetable with a live adapter (SBB/opentransportdata.swiss) that returns `coverage` from the actual query, and add the Austin–Dallas corridor (Amtrak Texas Eagle 21/22).
3. Connect real sources: Gmail thread retrieval and Google Calendar free/busy per `docs/integrations.md`; recheck availability immediately before writing events.
4. Turn holds into real tentative events with stable IDs, and implement the staged reply flow (keep one, release the others).
5. Hook the Caret Mac popup to `POST /api/run` so the same proposal appears natively.
6. Add reply templates for `de`/`fr`/`it` and a formal register.

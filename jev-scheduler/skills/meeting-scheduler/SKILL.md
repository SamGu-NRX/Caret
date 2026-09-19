---
name: meeting-scheduler
description: Turn an email thread that has agreed in principle to meet, plus the user's local computer history, into a scheduled meeting. Jev (TypeSafe's System One model) answers typed questions; code plans verified options, writes tentative holds and a draft reply. Use whenever the inputs are an email thread and activity context and the job is to decide what needs to be done and schedule it.
---

# Meeting scheduler (Jev edition)

Jev does not generate text. It evaluates typed questions (`choice`, `score`, `noul`)
against a JSON `state` and returns structured answers with probabilities and
confidence. This skill therefore splits the work:

| Step | Who | What |
|---|---|---|
| 1. Extract | Jev | One `systemone` call: intent, agreement in principle, who travels, venue, date window, excluded weekdays, duration, whether legal attends, travel mode, register, language. Question set: `skill.json -> passes.extract`. |
| 2. Plan | code | Build up to three candidate options from the window, the weekday exclusions, the calendar events found in computer history, and the **sourced** timetable. Door-to-door block = train out - access - buffer to train back + access. Drop anything the timetable does not cover. |
| 3. Rank | Jev | One call: `best_option` over the candidates and one `option_<id>_acceptable` noul per candidate (`passes.rank`). |
| 4. Schedule | code | Tentative holds for every acceptable candidate, the best first; `.ics` export; optional webhook; draft reply assembled from fixed sentences that only use sourced facts. |

## State the questions see

```json
{
  "skill": { "name": "meeting-scheduler", "rules": ["..."] },
  "email_thread": { "user_email": "", "subject": "", "messages": [{"from": "", "to": [], "date": "", "body": ""}] },
  "computer_history": { "entries": [{"ts": "", "app": "", "window_title": "", "text": "", "events": []}] },
  "candidates": [{"id": "A", "date": "", "meeting": {"start": "", "end": ""}, "outbound": {}, "return": {}}]
}
```

`candidates` is only present in the rank pass. The whole state stays well under
Jev's roughly 32k-token budget.

## Gates

- `intent != schedule_meeting` or `agreement_in_principle < 0.5`: stop after step 1 and report why.
- A candidate whose outbound or return is not in the timetable's `coverage` is dropped, with the reason listed under `dropped`.
- An `option_<id>_acceptable` below 0.5 removes the hold for that option.
- Nothing is sent. Holds are tentative and local (plus an optional webhook the operator configures).

## Packaging inputs for Jev

`npm run package-input` writes `jev-input.json`: the exact request body for the
extract pass (`model`, `state`, `questions`). Paste it into the TypeSafe
playground or POST it to `https://api.typesafe.ai/v1/systemone` with
`Authorization: Bearer $TYPESAFE_API_KEY`.

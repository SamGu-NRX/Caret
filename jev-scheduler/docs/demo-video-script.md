# Demo video script (3 minutes)

Flow: title → one-sentence blurb → multi-sentence blurb → demo 1 → demo 2 → implementation details → close.
Sections marked **TBD** have a suggested default; replace freely, keep the timings.

Prep: `npm run dev` running in one terminal, http://localhost:3000 open and not yet run, a second terminal idle in `jev-scheduler`. If there is no `TYPESAFE_API_KEY`, say "mock" on camera when the pill appears.

---

## 0:00–0:05 — Title (title card or app header on screen)

> Caret: from email thread to scheduled meeting, decided by Jev.

## 0:05–0:15 — One-sentence blurb (camera)

> Native macOS AI productivity app that lets you automate actions anywhere you type.

## 0:15–0:45 — Multi-sentence blurb (camera)

> Agents that schedule things usually fail by being confidently wrong: a train that doesn't run, a slot you're already in. We split the job. Jev, TypeSafe's System One model, answers typed questions: what's the intent, who travels, which week, should legal come. It never writes text. Code does everything factual: the timetable, the calendar, the holds. So every option on screen is one the code has already verified, and the model only chooses between them.

## 0:45–1:30 — Demo 1 **(TBD)**  — default: "thread + screen context → Jev decides"

Screen: the app. Expand "Email thread", then "Computer history", then click **Run through Jev**.

> Two inputs. Anna in Zürich: "happy to host, early October, not Fridays, should legal join?". And a synthetic slice of local computer history: a calendar week, a Slack message from legal, an SBB search, a note saying "train, back the same day".
>
> One click, one Jev call, sixteen typed questions. Intent: schedule a meeting, 88 percent. Fridays excluded, 0.96. Legal should attend, 0.08, because Lena said in Slack she doesn't need to be in the room. Jev read that off the screen history, not the email.

## 1:30–2:15 — Demo 2 **(TBD)** — default: "verified options → holds → reply"

Screen: scroll to Pass 2, open "Dropped", then the holds and the draft. Optionally run `npm run run-local` in the second terminal for the raw JSON.

> Now code plans. It walks early October, drops Fridays, and for each day picks the latest train from Basel that still makes it and the earliest train back, from a timetable we captured and dated. Wednesday has no return in our cache, so it's dropped, with the reason shown. Tuesday and Thursday survive with a door-to-door block checked against the calendar.
>
> Second Jev call ranks them: Tuesday 11:00 first. The app writes tentative holds for the whole block, hands me an .ics, and assembles the reply from facts only: "I'd take the 09:07 from Basel, arriving 10:00, so 11:00 is comfortable." Nothing is sent.

## 2:15–2:55 — Implementation details **(TBD)** — default: three decisions

Screen: the architecture diagram in the README, or `lib/plan.ts`.

> Next.js on Vercel, one API route, two Jev calls with plain fetch against the systemone endpoint. Three decisions mattered. One: because Jev doesn't generate text, we decomposed "schedule this" into atomic questions with probabilities we can gate on. Two: no invented travel. We couldn't get a live feed in time, so the timetable is sourced, dated rows with explicit coverage windows, and anything outside coverage is a failed source and gets dropped. Three: mock mode. Without an API key the whole loop still runs, but it says "mock" everywhere. Six tests cover the planner, source failures and response validation.

## 2:55–3:00 — Close (camera)

> Next: live Gmail and calendar, a real timetable adapter, and the Caret Mac popup on top of this same loop. Thanks.

---

Fallbacks: if the run takes longer than a few seconds, keep talking over it; if live Jev ranks differently from the mock, narrate what it chose. Cut the `run-local` terminal if over time.

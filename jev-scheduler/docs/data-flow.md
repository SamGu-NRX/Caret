# Caret data flow: inputs and outputs for the LLM and for Jev

Based on `origin/main` at `cfeb8fe` ("final lol", 2026-09-19) plus `jev-scheduler/` from PR #1.
Two model kinds exist. **Jev** (TypeSafe System One) chooses from options code supplies and returns probabilities. The **LLM** (Gemini 2.5 Flash through Vercel AI Gateway) generates text. Nothing else calls a model.

## 1. What actually runs today

```
                         ┌────────────────────────────── Mac app (Swift) ──────────────────────────────┐
 focused field/selection │ SelectionMonitor → selectedText, sourceApp                                 │
 pinned action / skill   │ Model.run(action, skill)  → NSLog only (no model, no CLI call)              │
 Debug menu              │ HistoryDebug → python3 -m caret history-debug → last-2 windows/minutes/clip │
 Settings                │ notes/skills/*.md, notes/memories/*.md → shown in UI, sent nowhere          │
                         └─────────────────────────────────────────────────────────────────────────────┘
                                                        │ (CaretCLI.autoExpand exists, uncalled)
                                                        ▼
 ┌──────────────────────────────── Python core (python3 -m caret) ────────────────────────────────┐
 │ complete --prompt --system        ┐                                                            │
 │ auto-expand --prefix --instr.     ┴─► caret/completions.py ─► LLM (Gemini 2.5 Flash)            │
 │ history-windows|minutes|clipboard ──► caret/screenpipe.py ─► Screenpipe HTTP API (port 3031)   │
 │ preview --fixture / hold / confirm ─► caret/planner.py + store.py (no model, fixture only)      │
 │ skills list|filter|create ─────────► caret/skills.py (JSON files, no model)                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────── jev-scheduler/ (Next.js, PR #1) ────────────────────────────────┐
 │ inputs/*.json + skills/meeting-scheduler/skill.json ─► Jev call #1 (extract) ─► plan (code)      │
 │                                                     ─► Jev call #2 (rank)    ─► holds/.ics/draft │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Jev is not called anywhere on `main`.** The only Jev calls in the repo are the two in `jev-scheduler/lib/pipeline.ts`. The ambient judge described in `docs/input-pipeline.md` (ABSTAIN / INLINE / ACTION, then workflow selection) is a contract, not code.

## 2. LLM: inputs and outputs (`caret/completions.py`, `caret/auto_expand.py`)

| | Value |
| --- | --- |
| Endpoint | `POST https://ai-gateway.vercel.sh/v1/chat/completions` (OpenAI-compatible) |
| Model | `google/gemini-2.5-flash` default; `--model` override. Docs say "Groq-hosted fast model"; code uses Gemini via Vercel. |
| Auth | `VERCEL_API_GATEWAY_KEY` or `AI_GATEWAY_API_KEY` |
| Request body | `{model, messages:[{role, content}], stream:false, temperature?, max_tokens?}` |
| Response used | `choices[0].message.content` (string), `model`, `usage` |

**Callers and their concrete inputs/outputs**

| Caller | Input to the LLM | Output from the LLM | Post-processing |
| --- | --- | --- | --- |
| `python3 -m caret complete --prompt P [--system S]` | messages: system `S` (optional), user `P` | free text | printed as-is |
| `python3 -m caret auto-expand --prefix X [--instructions I]` (`complete_auto_expand`) | system = skill instructions `I` (default: the auto-expand note text) + fixed autocomplete rules ("return ONLY the continuation, do not repeat the prefix"); user = "Continue this text from the caret. Prefix: `X`"; `temperature 0.35`, `max_tokens 96` | continuation text | `normalize_continuation`: strips quotes, strips a repeated prefix, returns `""` if nothing new; stdout = suffix only |
| Swift `CaretCLI.autoExpand(prefix:instructions:)` | same as above, via subprocess with `CARET_PROJECT_ROOT` | trimmed stdout | **Not invoked by any UI path yet.** `Model.run` only logs. |

Where the inputs would come from once wired: `prefix` = focused text before the caret (SelectionMonitor / KeyType AX reader); `instructions` = body of `caret/notes/skills/<action>.md` (user-editable skill note, e.g. `auto-expand.md`); memories (`caret/notes/memories/*.md`, e.g. "default to Central Time and 30-minute slots") are loaded by the app but **not** yet included in any prompt.

## 3. Jev: inputs and outputs

### 3a. Target contract on `main` (`docs/input-pipeline.md`, not implemented)

| Call | Input | Allowed outputs | Output record |
| --- | --- | --- | --- |
| Jev #1 (every ≤2 s of changed context) | `ContextFrame` = `InputSnapshot` (revision, app/bundle, window+element identity, role/security, caret/selection offsets, bounded nearby text + digest) + permitted clipboard + Screenpipe records (with source IDs, capture times) + latest computer observation; missing sources marked explicitly | `ABSTAIN` \| `INLINE` \| `ACTION` | `RouteDecision` {snapshot revision, choice, model result, timing} |
| Jev #2 (only if ACTION) | same frame + registered workflow IDs / supported computer tasks from the registry (`caret/workflows.json`: `book-flight`, `book-calendar-link`, `revise`) | one workflow ID, one computer task, or `NONE` | `ActionProposal` {revision, proposal/workflow IDs, title, effect, required inputs, evidence, execution method} |
| INLINE branch | → LLM writer (above) | | `InlineProposal` {revision, replacement range, text, original digest} |

Rules that shape the inputs: skip unchanged snapshots; one in-flight request; discard stale responses by revision; never send the whole Screenpipe history each tick; confidence is not permission to act.

### 3b. Implemented in `jev-scheduler/` (PR #1)

Endpoint `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer TYPESAFE_API_KEY`, body `{model:"jev-latest", state, questions}`. Response `{model, answers:{id:{choice, probabilities, confidence} | {noul}}, usage}`. Validated in `lib/jev.ts` (choice in criteria, probabilities sum to 1, noul in [0,1]); labeled mock when no key.

**Jev call #1, extract** (`skill.json → passes.extract`)

| Input (`state`) | Source |
| --- | --- |
| `skill.rules[]` | `skill.json` |
| `email_thread` {user_email, subject, messages[{id, from, to, cc, date, subject, body}]} | `inputs/email-thread.json` (parsed from `inputs/sample-thread.pdf`) |
| `computer_history` {entries[{ts, app, window_title, kind, text?, url?, events?[{title,start,end}]}]} | `inputs/computer-history.json` (synthetic, screenpipe-shaped) |

| Question id | Type | Output used by code as |
| --- | --- | --- |
| `intent` | choice: schedule_meeting / reply_only / book_travel / nothing | gate: continue only if `schedule_meeting` |
| `agreement_in_principle` | noul | gate: ≥ 0.5 |
| `who_travels`, `venue` | choice | evidence (planner assumes user travels to counterparty office) |
| `date_window` | choice: early/mid/late_october / other | window dates from `skill.defaults.windows` |
| `monday_excluded` … `friday_excluded` | 5 nouls | weekday excluded if ≥ 0.5 |
| `duration_minutes` | choice: 30/60/90/120/180 | meeting length |
| `legal_should_attend` | noul | picks one of two fixed reply sentences |
| `travel_mode`, `same_day_return` | choice / noul | summary text, evidence |
| `register`, `language` | choice | greeting/sign-off style (English templates only) |

**Code between the calls** (`lib/plan.ts`, no model): inputs = extraction + `inputs/timetable-basel-zurich.json` (coverage + connections + holidays) + calendar `events` from computer history + skill defaults; output = `candidates[]` {id, date, meeting start/end, hold start/end, outbound, return, venue, evidence[]} and `dropped[]` {date, start?, reason}.

**Jev call #2, rank** (`passes.rank`)

| Input (`state`) | Source |
| --- | --- |
| everything from call #1 | same |
| `candidates` {A: {date, meeting, venue, outbound, return, door_to_door}, B: …} | planner output, also used as the `criteria` of `best_option` |

| Question id | Type | Output used by code as |
| --- | --- | --- |
| `best_option` | choice over candidate ids | ordering; first hold flagged `proposed_first` |
| `option_<id>_acceptable` | noul per candidate | drop candidate if < 0.5 |

**Final outputs** (`lib/schedule.ts`, no model): `holds[]` {option_id, start, end, status:"tentative", proposed_first, summary}; `ics` (VEVENT per hold, STATUS:TENTATIVE); `draft_reply` {to, subject, body} from fixed sentences + sourced facts; optional `POST SCHEDULE_WEBHOOK_URL` with {run_id, holds, ics}; `requests.extract` / `requests.rank` (the exact Jev bodies) for inspection.

## 4. Context sources feeding either model

| Source | Code | Shape | Consumed by |
| --- | --- | --- | --- |
| Screenpipe 0.4.50 (port 3031, lease `.local/screenpipe-lease.json`) | `caret/screenpipe.py` `last_n_windows/minutes/clipboard`, `debug_preview` | records {timestamp, app, title, text_source, structure_source, structure[{role,label,text,depth}], text} | Debug menu only. Not sent to any model yet. |
| Synthetic history samples | `.screenpipe/synthetic/{family-cancun,ny-dba-aruba}/{windows,minutes,clipboard}.json` | same record shape | Nothing reads them yet (fixtures for the future judge). |
| Live focus/selection | Swift `SelectionMonitor` | selectedText, sourceApp | logged in `Model.run`; intended `prefix` for auto-expand |
| Skill notes | `caret/notes/skills/*.md` (frontmatter + body) | instruction text | body → `--instructions` for auto-expand (when wired) |
| Memory notes | `caret/notes/memories/*.md`, `caret/memories/store.json` | preference text, apps | UI only |
| Workflow registry | `caret/workflows.json` | id, inputs, stages, status | intended criteria for Jev #2 |
| Sample thread / history / timetable | `jev-scheduler/inputs/*.json` | see §3b | jev-scheduler Jev calls |

## 5. Gaps between the doc'd flow and the code

1. **No Jev judge on `main`.** Both ambient decisions (#1, #2) are unimplemented; only `jev-scheduler` calls Jev, and it reads files, not a `ContextFrame`.
2. **Writer model mismatch.** Docs name a Groq-hosted writer; code is Gemini 2.5 Flash via Vercel AI Gateway (`VERCEL_API_GATEWAY_KEY`). Pick one and update `docs/input-pipeline.md`.
3. **UI → model bridge missing.** `CaretCLI.autoExpand` is never called; `Model.run` logs and closes. Inline text, Tab acceptance and routing remain unwired (README says so).
4. **Memories are not in any prompt.** `about-me.md` ("Central Time, 30-minute slots, door-to-door over fare") is exactly the kind of `computer_history`/preference input Jev's questions expect; it should be added to the state of both Jev calls and to the writer's system prompt.
5. **Synthetic Screenpipe fixtures are orphaned.** `.screenpipe/synthetic/*` matches the `screenpipe.py` record shape and could be passed straight into a `ContextFrame` for tests.
6. **jev-scheduler needs a context adapter.** To join the contract it must accept `{thread, history}` from a `ContextFrame` instead of `inputs/*.json`, and split `runPipeline()` into prepare (extract + plan + rank, read-only) and execute (authorized live holds), as `docs/input-pipeline.md` asks.

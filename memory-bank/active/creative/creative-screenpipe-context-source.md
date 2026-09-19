# Architecture Decision: Screenpipe Context Source

How Caret obtains last-N-minutes and last-N-windows context for “what the user has been up to,” so the rest of the app can request that data without talking to Screenpipe.

## Requirements and Constraints

Functional:

- The rest of Caret can ask for last N minutes and last N windows and get a structured record: app, title, structure if present, otherwise visible text.
- That gatherer is Screenpipe-backed. This is history, not a replacement for Caret reading the focused thread via its own Accessibility grant.
- Callers must not depend on Screenpipe URLs, tokens, or `AX*` role names.
- Screenpipe down, unreachable, or missing the history a Caret run needs is a **hard failure**. The run stops. Do not continue inference on empty context. Do not invent windows.

Quality attributes, ranked for this event:

1. Fitness — the facade exists and returns the dump shape we already proved locally.
2. Honesty with TCC and license — do not claim Caret’s Accessibility covers their binary; do not ship current Screenpipe under the MIT pin story.
3. Simplicity — ship this weekend; Caret stays two processes and no daemon of our own.
4. Maintainability — a teammate can debug “is Screenpipe up?” without a Rust embed.
5. Local privacy — capture stays on the machine; Caret only reads what the gatherer already stored.
6. Scale — not a factor. One laptop, one demo.

Technical constraints:

- Caret is a Swift popup that shells out to `python3 -m caret`. There is no HTTP server in the starter.
- macOS Accessibility and Screen Recording attach to a code signature. Spawning the Screenpipe CLI does not inherit Caret’s grant. Already observed on this machine.
- `packages/screenpipe` is pinned at `892199f` as a historical MIT reference. Do not advance across the later commercial license. Do not copy `ee/`.
- Current published Screenpipe is source-available commercial. Embedding it is a legal decision, not a launchd trick.
- A Screenpipe recorder is already running locally as a sidecar (`127.0.0.1:3030` + API token). The dump format and AppKit role map are proven in `.scratch/`.

In scope: where the gatherer process lives, and the Caret-facing query boundary.

Out of scope: implementing the facade, UI for the dumps, audio, embedding their desktop app, changing the Screenpipe pin.

## Components

```mermaid
flowchart LR
  classDef ui fill:#e1f5fe,stroke:#01579b;
  classDef core fill:#f3e5f5,stroke:#7b1fa2;
  classDef gather fill:#fff3e0,stroke:#ef6c00;

  Popup["Mac popup"]:::ui --> CLI["python3 -m caret"]:::core
  CLI --> Facade["last N minutes / last N windows"]:::core
  Facade --> Client["Screenpipe client"]:::core
  Client -->|"localhost, optional override"| SP["Screenpipe recorder"]:::gather
  AX["Caret Accessibility: current thread"]:::ui -.->|"not this decision"| CLI
```

- **Caret facade** — owns the request shape and the Apple role labels. Single responsibility: history for the rest of Caret.
- **Screenpipe client** — health check, auth header, `/search` + `/frames/{id}/elements`. Knows the sidecar. Callers do not.
- **Screenpipe recorder** — someone else’s process. Capture, SQLite, TCC for *that* binary.
- **Caret Accessibility** — already shipped. Frontmost thread and selection. Not the gatherer.

Communication is request/response over loopback HTTP. No shared database. No Caret-owned capture daemon.

## Options Evaluated

- **Bundle the engine**: Vendor Screenpipe (current or the MIT pin) into `Caret.app`, sign it as Caret, run capture inside our identity.
- **Sidecar plus configured endpoint**: Users must run Screenpipe themselves. Caret is a client. Endpoint is configurable; default is loopback 3030.
- **Caret-signed helper from the MIT pin only**: A third path. Bundle *only* the frozen MIT engine as a helper we sign. Same TCC story as bundle, without the current license. Old engine, large embed, still a daemon we own.

## Analysis

| Criterion | Bundle engine | Sidecar plus endpoint | MIT-pin helper |
| --- | --- | --- | --- |
| Fitness | Yes, after a large embed and our own TCC for Screen Recording | Yes, if Screenpipe is running. Same dump we already produced | Yes, eventually, against an old API |
| TCC honesty | Works only if the binary is really Caret-signed. Launching *their* CLI still fails | Explicit: user grants Screenpipe. Caret’s grant stays for *now* | Works if we sign the helper as Caret |
| License | Current engine: blocked without a commercial license | Client to a user-installed app. We do not redistribute their engine | Allowed at `892199f` only. Must not fast-forward |
| Simplicity | Conflicts with “two processes, no server.” Adds models, ffmpeg, port fights | Smallest change. Probe health, then query | Weeks, not a weekend |
| Maintainability | We debug their Rust inside our app | “Is port 3030 up?” | Forked snapshot we do not want to maintain |
| Risk | Hard to undo once vendored. Pin policy exists to prevent this | Hard fail if sidecar is down or history is missing. Easy to add a bundle later behind the same facade | Medium: legal-ok, operationally a second product |

Key insights:

- “Bundle Screenpipe” and “inherit Caret’s Accessibility” only meet if the gatherer **is** Caret. The official CLI is not Caret.
- The facade is not optional in any winning design. Option 1 vs 2 is only about who runs the recorder.
- License plus TCC together eliminate “ship `npx screenpipe` inside the app” as a serious option.
- Configured endpoint is the right escape hatch. Forcing every user to type it is not. Default `http://127.0.0.1:3030` and `screenpipe auth token` / env cover this machine.

## Decision

### Choice Pre-Mortem

- Demo machine has no Screenpipe or too little history, so the run dies: checked. That is the intended failure. Show why it failed (sidecar down, no token, no rows in the window). Do not degrade to guesswork.
- A later teammate vendors current Screenpipe because the sidecar feels incomplete: checked. The pin note and this decision say the facade stays; the gatherer can be replaced later, the current engine must not be copied in.
- Callers use last-N history when they needed the focused Gmail thread: checked. Integrations already say current thread is Accessibility. This facade is “what they’ve been up to,” not “what is focused.”

**Selected**: Sidecar gatherer, Caret-owned facade. Default loopback Screenpipe. Optional endpoint override. Do not bundle the engine for this event.

**Rationale**: Fitness is already proven against a running sidecar. Honesty and simplicity both rank above “user never hears Screenpipe.” Bundle fails license or TCC unless we take on a daemon we will not finish this weekend. The MIT-pin helper is the only honest bundle, and it is the wrong size for the starter.

**Tradeoff**: A Caret run that needs “what the user has been up to” cannot succeed without a live Screenpipe and enough captured history. Caret will not start Screenpipe and will not inherit its permissions. Soft-empty last-N is not a valid outcome for that run.

## Implementation Notes

- Put `last_n_minutes(n)` and `last_n_windows(n)` on the Python CLI. Return the scratch dump shape: title, app, timestamp, structure with `role` plus AppKit `label`, or visible text.
- Client defaults: `http://127.0.0.1:3030`, token from `SCREENPIPE_API_KEY` or `screenpipe auth token`. Optional Caret setting overrides the base URL only when the default is wrong.
- If health fails, auth fails, or last-N has no usable records for the requested window, fail the Caret run. Structured error, non-zero CLI, no inference. Never invent windows. Never proceed on empty context.
- Do not spawn Screenpipe from Caret. Do not open their TCC panes as if they were ours.
- Keep Caret Accessibility for “now.” Do not route thread identification through this facade.
- Do not change the Screenpipe submodule pin. Do not copy `ee/`.
- If a later licensed or MIT-pin helper is approved, it sits behind the same two functions. Callers do not change.

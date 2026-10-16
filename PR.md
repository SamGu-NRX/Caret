base: alpha
title: [obvious-fleet] test(helper): pin what the native reads take from web pages
draft: true
---
fleet-packet: burst14-caret-web-area-audit

## What the Mac reader takes from web pages, and where it lands — pinned

**Target:** `SamGu-NRX/Caret`, `obv/burst14-caret-web-area-audit` → `alpha` · **Base:** `558f6f1e` · **Head:** `fa6a2c29` (pushed) · **Not merged** · Human author: Sam Gu (sgu07966@gmail.com)

The extension boundary from #52 holds: a page walk sends `hasValue` and `rev`, never a text
control's value (`TextPageControl` refuses one, loudly). This PR does not touch that, and does
not change runtime code. It does two things:

### 1. `docs/research/web-area-reads.md` — the audit

Every native path by which page text or a text field's value reaches the helper through
Accessibility, with file:line evidence re-verified at `alpha@558f6f1e`:

- **Window walks** — `Walker.read` copies `kAXValueAttribute` for every non-secure
  value-bearing role (`Walker.swift:74`); no rule mentions `AXWebArea` on the way down, so
  Safari pages (always exposed) and Chromium pages (exposed once any assistive app turns the
  tree on — the reader deliberately never enables it itself, `ScreenReader.swift:416-424`)
  give up every field's value and every piece of static text, capped at 20,000 chars.
  Every walk flavour funnels the same emit (`AppWorker.walkWindow:658`, `walkSubtree:694`),
  triggered by focus change, `AXValueChangedNotification`, background passes and the
  pending-state watch.
- **The focused element** — `focusChanged`/`emitFocus` read the whole value at event time and
  keep only its emptiness (`AppWorker.swift:568`, `:599`).
- **Act read-back** — every write/press/raise ends in a full `requestWalk` whose snapshot
  carries values again; the write verb re-reads the target's value before acting
  (`:870-877`). On a failed recheck the reader answers `.changed` quoting the field's
  actual value to 80 characters (`:877`, `:965`, `:1038`) — text that reaches the helper
  through no snapshot at all.
- **The host** — `FieldReader` reads the focused field's whole value and selection for the
  insertion guard and inline (`FieldReader.swift:20-27`); Chrome yields page fields to the
  page engine (`PageInline.nativeYields`, `PageInline.swift:145-149`), Safari has no page
  engine, so Safari web fields get native reads. `BrowserPage.frontOrigin` reads an
  `AXWebArea`'s `AXURL` (`BrowserPage.swift:30-48`).
- **Where it lands** — `protocol.ts Node.value` (no AXWebArea rule in the walk), admission
  (`exclude.ts`): a revealed password whose label does not name a secret and whose value is
  ordinary-shaped sails through. The ledger's inventory holds node values as
  request-quotable parts (`ledger/source.ts:151-178`), typed values become fill candidates,
  and an admitted value can reach a Jev (cloud) request, both as quoted context and as an
  Ask value question's source line. The focused field's caret text is the one screen text
  with a cloud guard (`focus-tripwire.ts`); a non-focused page field's value has none.
  `DENIED_HOSTS` applies where page content enters with an origin attached — the extension's
  page traffic (`extension/src/worker/left-tab.ts:112`, mirrored in
  `helper/src/privacy/denied-origins.ts:6`); a native snapshot has no origin at all, so the
  deny list does not cover the native path.

### 2. `helper/test/web-area-boundary.test.ts` — the pin

A synthetic native snapshot of a browser window (an `AXWebArea` holding page fields, one a
revealed password with no secret-naming label, plus the typed values the reader's detector
would send) runs through the real `ScreenModel`, the privacy admission rules, the ledger's
inventory and the protocol schema:

- **Passing today:** the model keeps the revealed password's value, typed values are
  admitted, and the inventory holds the password's value under `nodePart(key, "value")` as
  request-quotable text.
- **`it.fails` — the rule:** "text-control values under an AXWebArea never reach the helper;
  the focused field's caret text is for inline writing only." Four tests state what the rule
  requires (value absent from the model, no typed value admitted, no quotable part); the
  change that implements the rule removes the `.fails` and keeps the tests.
- **Schema pin:** a page `TextPageControl` still refuses a `value` ("a text control's value
  never leaves the page"), while a native `Node` carries one — the asymmetry the rule closes.

The doc also prices the rule before anyone implements it: fill verification and S1 undo for
Safari page fields, and native inline text in Safari web fields, all depend on helper-visible
values today. The replacement is #52's own pattern turned native — reader-side compare
(equivalent of `pageCompare`) and reader-held undo (`pageRestore`'s contract), outcome-only
answers, and the 80-character verb-detail quotes dropped.

## Verification

- Commit `fa6a2c29` pushed to `origin/obv/burst14-caret-web-area-audit`; docs and one new
  test file only — 301 insertions, 0 deletions, no runtime code touched.
- `tsc -p tsconfig.json` green on `helper`.
- `vitest run test/web-area-boundary.test.ts test/page-values-boundary.test.ts`: 15 passed,
  4 expected-fail (the rule tests, as designed).
- Full `helper` suite: 1,855 passed / 2 failed (1,857). Both failures triaged against the
  base commit, neither touches this work:
  - `memory-documents.test.ts` — "does not report its own writes as changes…" (expected a
    duplicate-id list, got `[]`). Fails identically at base `558f6f1e` with no burst commit
    (control run in a clean worktree), and again on the head pairing — pre-existing.
  - `goal-values.test.ts` — "refuses the goal, saying why…" intermittently returns the
    generic "the plan program broke the rules" reason under load. It passed solo at head,
    passed paired with the new boundary test file (12 passed + 4 expected-fail), passed in
    the base control, and failed twice under full-suite load — a load-sensitive flake, not a
    regression: this commit adds no runtime code the suite imports.
  - `web-area-boundary.test.ts` passed 10/10 in every run, full suite included.
- Opened as draft: the branch's full suite is not fully green (the two triaged failures
  above) and the pin deliberately proposes an unimplemented rule; flip draft off if the
  triage above reads as settled.

## Suggested commit

Squash of one commit:

```
test(helper): pin what the native reads take from web pages
```

🔗 [Obvious Project](https://app.obvious.ai/p/products-Uu1863v1) · 🧵 [Obvious Thread](https://app.obvious.ai/p/products-Uu1863v1?thread=th_qQpghoOi) · 🔀 [Obvious PR Artifact](https://app.obvious.ai/link/pr-artifact/caret-audit-what-the-mac-reader-takes-from-web-pag-task:todo_cl1yPo5O)

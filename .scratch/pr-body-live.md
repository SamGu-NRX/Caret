Caret's inline writing, aimed at replacing Cotypist for everyday use. This PR adds spelling fixes in web fields and for the word just typed, longer ghost suggestions, Cotypist's accept keys as a setting, a per-app off switch, personal writing instructions, Electron accessibility, and a guard that makes rich web editors safe to turn on. Base is `v2/dogfood`, so the diff shows only this lane.

## What changed

### Spelling fixes in web fields and for the word just typed

Writing fixes used to run only when a sentence ended, and only in native fields that Accessibility can read and write. Now:

- **The word just typed.** The word just closed by a space or punctuation is checked at once. A fix gets its Tab line only when the system checker is sure of it and the edit is small: two letters up to eight-letter words, three beyond, as KeyType does ([WordFix.swift](https://github.com/SamGu-NRX/Caret/blob/0c18809d/apps/caret/Sources/CaretHostCore/Writing/WordFix.swift)).
- **Web fields.** A new page machine checks the text the extension reports around the caret ([PageWriting.swift](https://github.com/SamGu-NRX/Caret/blob/0c18809d/apps/caret/Sources/CaretHostCore/Writing/PageWriting.swift)). Tab sends one page insert with a new `replace` count, so the page's own Undo restores the misspelled word in one step. The content script selects the text to replace, inserts through `execCommand`, reads the field back, and puts the caret back if the page refused ([insert.ts](https://github.com/SamGu-NRX/Caret/blob/0c18809d/extension/src/content/insert.ts)).
- **Limits on pages.** No underlines, since the page reports no word positions, and only errors that end at or before the caret.

The engine stays NSSpellChecker plus the static rules. A comparison on 60 sentences found it caught 48 with one false positive, against Harper's 35 with three.

### Longer suggestions: paint 4 tokens, then extend to the sentence end

Raising the token cap does not lengthen KeyType's suggestions. Its beam scores cumulative log probability, so a short branch that ends the sentence wins. Measured on this Mac (876 keystrokes per mode):

| Mode | Mean words | 5-7 words | First word p50 / p95 | Full suggestion p50 / p95 |
|---|---|---|---|---|
| 4 tokens | 2.4 | 90 | 88 / 144 ms | 88 / 144 ms |
| 32 tokens | 2.4 | 83 | 145 / 342 ms | 145 / 342 ms |
| 4 then extend to 28 | 3.0 | 153 | 95 / 155 ms | 117 / 391 ms |

So the ghost paints at 4 tokens, then one follow-up request from the end of the shown text is appended in place, with no motion ([GhostExtend.swift](https://github.com/SamGu-NRX/Caret/blob/0c18809d/apps/caret/Sources/CaretHostCore/GhostExtend.swift), [HostCoordinator.swift](https://github.com/SamGu-NRX/Caret/blob/0c18809d/apps/caret/Sources/CaretHost/Runtime/HostCoordinator.swift)).

- **When an extension is dropped.** Anything typed, a moved field or caret, or an offer that is no longer the one it was asked for.
- **Tab.** Tab takes what is drawn when it is pressed. A claim removes the offer, so a late extension cannot change what was taken.
- **Narrow fields.** A suggestion wider than a single-line field now offers the whole words that fit inline, in native and web fields, instead of a capsule under the caret.

### Accept keys: Caret's or Cotypist's

Caret's keys stay the default: Tab takes the whole suggestion, ⌥→ the next word, Esc closes. Cotypist's keys are a setting:

- Tab takes the next word.
- The key above Tab takes the whole suggestion (` on ANSI keyboards, § on ISO).
- ⌥Tab reaches the app as a plain Tab.

In web fields, repeated Tabs walk the same suggestion word by word without regenerating. Fills, action lines and writing fixes keep their keys in both presets ([KeyOwnership.swift](https://github.com/SamGu-NRX/Caret/blob/0c18809d/apps/caret/Sources/CaretHostCore/KeyOwnership.swift)).

### Turn Caret off in one app

The menu bar says "Turn Off in <app>" for the app the user was in, and the Writing tab lists the apps that are off. Ghost text, writing fixes, page inline text and fills all stay out of an app that is off, and what is showing there goes at once.

### How you write

A plain field for how the user writes, plus instructions for one app or one site. They go into the completion prompt's instructions section, replacing KeyType's unwired `policy.customInstructions`. They are composed site, then app, then the general text, within the section's budget of 1,536 characters. Only the local model reads them. The debug socket's settings reply shows their lengths, never their text.

### The Writing tab

A fourth tab in What Caret Knows holds How you write, per-app or per-site instructions, the accept keys, and the apps Caret is off in.

### Electron apps

The host now asks each Electron app for its accessibility tree itself (`AXManualAccessibility`, once per process, by the reader's rule), then reads again at 0.15, 0.5 and 1.5 s. Before, ghost text in Slack or Notion depended on the reader having asked first. Chromium browsers are not asked, and `AXEnhancedUserInterface` is never set.

### Rich web editors: no offer right after a paste, drop, undo or redo

Rich editors keep their own undo history and group changes made close together. In the VM, one ⌘Z after a paste and Tab in ProseMirror took both. The page now reports how long ago the last non-typing edit was (`quietMs`), and in a contenteditable the host offers nothing until 600 ms after it. ProseMirror's default grouping window is 500 ms; 600 is chosen above it, not measured. Rich editors stay off by default until the paste rows pass with this change.

### The offer slip stays off a web form's other fields and labels

At a full-width web field the slip went below the field, over the next field's label: in the DF1 VM run it sat on "Last Name" at First Name. The placement hit-tests Accessibility, and Chrome shows it no web content, so the spot looked clear. Now the extension records each control's label text rectangle, the helper sends the frames of nearby controls and labels with the page field (`PageField.nearby`, rectangles only), and the host keeps the slip off them. For a page field it tries beside the field first, then below and above, then above or below aligned to the field's trailing edge, clear of its own label ([FieldPanelPlacement.swift](https://github.com/SamGu-NRX/Caret/blob/6d36051c/apps/caret/Sources/CaretHostCore/FieldPanelPlacement.swift)). Native fields keep below first.

### Smaller fixes

- One rule for fields that may hold a secret, now including KeyType's password-manager trait.
- The "Caret can't see this page yet" line and the page-site lookup treat all Chromium browsers alike, not only Chrome.

## UI changes

New, the Writing tab. These are CI-rendered references at the commit shown, not captures of the running app.

| How you write, filled (light) | Cotypist keys and apps off (dark) |
|---|---|
| ![](https://github.com/SamGu-NRX/Caret/blob/4e680909/apps/caret/Tests/CaretHostTests/References/writing-editing-light.png?raw=true) | ![](https://github.com/SamGu-NRX/Caret/blob/4e680909/apps/caret/Tests/CaretHostTests/References/writing-cotypist-keys-dark.png?raw=true) |

The other What Caret Knows references changed only by the fourth tab label (793 px light, 875 px dark).

There are no captures of ghost text, the extension, writing lines in web fields, or the per-app menu item from the running app.

## Verification

- **CI.** All six jobs (helper, extension, screen-reader, python, guards, host) pass on 6d36051c ([run 37899906807](https://github.com/SamGu-NRX/Caret/actions/runs/37899906807)). Host includes every Swift test, the new snapshot references, and the tests for the key presets, word fixes, page writing, extension and quiet-period rules, and the slip placement on the geometry recorded in the DF1 run (`PageSlipPlacementTests`).
- **Latency.** `Caret --probe-length` (this PR) on an M4 Pro with the local Gemma model produced the table above.
- **Rich-editor VM rows** (`INLINE_RICH=1`, real HID keys in the rig VM, recorded suggestions, at d9f6b6e1, before the 600 ms quiet period). 41 of 42 passed. ProseMirror, Lexical and Draft.js each passed 3 of 3 for typing, Tab and one ⌘Z leaving the typed text alone, plus the 5 s pause and arrow-key variants. The paste variant passed in Lexical and Draft.js and failed in ProseMirror, which led to the quiet period. Keystroke to ghost on the host: p50 106 ms, p95 192 ms.
- **Not verified:**
  - The paste rows with the quiet period: the VM rerun is waiting for a heavy lease.
  - The extension drawn on screen, since the VM runs on recorded suggestions without the follow-up request.
  - Writing fixes in a real web field.
  - Electron in a VM: there is no Electron app in the guest, and the 0.15/0.5/1.5 s re-reads are assumed, not measured.
  - The key presets with real keys.
  - The label rectangles and the slip's new spot in a real browser page.
  - The browser cases for the page `replace` verb (`fixtures/web-form/tests/tab-text.test.ts`), which need the fixture's dependencies.

## Risk

- `PageFocusText.quietMs`, `pageInsert.replace` and `PageField.nearby` are optional protocol fields, mirrored in CaretScreenCore. Older peers ignore them.
- The extension adds a second model request for each suggestion that doesn't end a sentence.

## Checklist

- [x] The scope is focused; related changes belong together
- [x] I explained what changed and why
- N/A Before/after images for visible changes: the Writing tab is new, so it has after images only (CI renders); ghost text changes have no captures yet.
- N/A Video: no running-app recording yet; see Not verified.

🤖 Generated with [Claude Code](https://claude.com/claude-code)


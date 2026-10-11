# Web form fixtures

`server.ts` serves the synthetic pages the page engine is tested on, and `accept.ts` runs the engine's acceptance over them. This file covers the browser task pages under `/tasks/` and their oracle, which the browser loop (P2, P3) measures against.

## Browser task pages and the oracle

### The pages

`tasks/site.ts` lists them in `TASK_PAGES`. `FixtureSite` serves them on its main origin, so `node server.ts --port N` serves them too.

| Page | Path | What it tests |
| --- | --- | --- |
| `wizard-1` | `/tasks/wizard/1` | Contact details. Country is a react-select; State is a native select that appears and changes options with Country. |
| `wizard-2` | `/tasks/wizard/2` | Work history; a School picker that queries `/tasks/api/schools` as you type and lists matches in a listbox at the end of `<body>`; Yes/No buttons, where Yes shows Sponsorship radios. |
| `wizard-3` | `/tasks/wizard/3` | Resume by file input and by dropzone, cover letter, consent box, Submit. |
| `reveal` | `/tasks/reveal` | Five choices that each show new fields. One of those sections sits in an open shadow root. |
| `forty` | `/tasks/forty` | Exactly 40 fields, for the size-limit hand-off. |
| `greenhouse` | `/tasks/greenhouse` | A careers page that embeds the form at `/tasks/greenhouse/form` in an iframe. react-select fields, School loaded as you type, and an EEO section where Race appears only after Hispanic/Latino is No. |
| `ashby` | `/tasks/ashby` | Renders 400 ms after load, has no `<form>`, a location combobox named only by its placeholder, dropzones over clipped inputs, and Yes/No buttons. |

Next and Submit are real buttons. Caret must never press them. `?show=all` shows every dependent section without setting the choices that trigger it, so a walk can count every field.

### Driving a journey

The oracle lives in the fixture server's process (`site.tasks.oracle`). A harness that starts `FixtureSite` in-process, as accept.ts does, has everything it needs:

```ts
const site = new FixtureSite();
await site.start();
const sink = new NetworkSink(site.tasks.oracle);
await sink.start();
// Launch the browser with sink.chromeFlags() added (a proxy; loopback bypasses it).
// Open site.mainOrigin + taskPage("wizard-1").path. Before reading, wait until
// oracle.currentLoads("wizard-1") holds a load that was not in oracle.loads("wizard-1") before you opened it.
// ... Caret fills the page ...
await site.tasks.harnessPress("wizard-1", "next"); // the only sanctioned press; the page moves to wizard-2
```

`harnessPress` hands the press to the page's probe over a long poll that only the server answers, and the probe tags the click with an id issued in-process. No HTTP route issues an id, so Caret's extension cannot make a press count as the harness's. `tasks/chrome.ts` launches headless Chrome for Testing on a temporary profile with a DevTools pipe and no extension. `tests/browser.test.ts` shows the waiting, filling and pressing.

Each task page keeps one long poll open per frame, and Chrome allows six connections per host. Close tabs you are done with.

### Reading the oracle

- `values(page)` gives every field's value now, keyed by its `data-oracle` name, across the page's frames. Checkboxes read `"true"`/`"false"`; selects, radios, Yes/No groups and react-selects read the visible text; pickers read the last pick, not typed text; file fields read file names. It throws if the page never loaded.
- `score(page, loadExpectation(page).expected)` sorts fields into right, wrong, missed, left alone and absent. A wrong fill is any value other than the expected one, including any value where `none` was expected.
- `submits` has one record per request to `/tasks/submit`, however the page sent it. The bar is 0.
- `strayPresses()` lists every press on a button or link that the harness did not make. Clicks inside Yes/No groups, radios, react-selects and pickers are field writes, not presses.
- `unaskedChanges(page, asked)` names fields that moved from their first reading without being in `asked`. `unmet(page, asked)` names asked fields that don't hold the asked value.
- `offsite()` lists requests that left 127.0.0.1. Chrome's own calls to Google hosts can't be switched off by flags, so `browserService()` holds them separately (`BROWSER_SERVICE_HOSTS`). A request Caret made to one of those hosts would land there and not in `offsite()`. Requests to other loopback ports bypass the proxy and aren't seen.
- `probeErrors` must stay empty. A field the probe can't read is reported there rather than guessed.

### Expectations

`tasks/expect/<page>.json` holds one invented person's note, email and memory entries, and the expected value or `none` for every field, with the quote each value comes from. An agent that had not read Caret's fill code wrote them. Self-identification, consent and free-prose fields are always `none`. The wizard's three pages share one person. No route serves these files, so a page can't read its own answers.

### Commands

- `pnpm test` runs the typecheck and then `tests/*.test.ts`: the oracle's logic, the expectations against the pages, and the oracle in headless Chrome for Testing.
- `pnpm tasks:bundle` rebuilds `public/tasks/tasks.bundle.js` after `src/tasks.jsx` changes.

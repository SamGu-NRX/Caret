// The page engine of fill-transaction.test.ts (D2-04), shared with the page goal tests (P2): one tab whose content
// script acts as the real one does, and the mixed-control form with the note and canned picks that fill it. Every name
// and value is invented.
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type HelperToEngine, type PageControl, type PageSnapshot, type PageVerb, type VerbResult } from "../src/protocol.ts";

export const X = "kcmlnoabcdefghijklmnopabcdefghij";
export const chrome = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };
export const TITLE = "Apply: Mixed controls";
export const WIN = "page:eng1:7";
export const hello = { type: "pageHello" as const, v: 1 as const, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] };
export const okReader = { run: async (): Promise<VerbResult> => ({ type: "verbResult", v: 1, id: "r", at: 0, outcome: "ok", detail: null }) };
export const TEXTEDIT = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };

/** The note the user just left: one labelled line per field, and an age that says nothing about a box asking "over 18". */
export const NOTE = [
  "Full name: Robin Vale",
  "Email: robin@example.test",
  "Country: Canada",
  "Shift: Night",
  "Valid driving license: yes",
  "Age: 34",
  "Start date: October 20, 2026",
  "Interview time: 3:30 PM",
  "Available from: Oct 19, 2026 at 9:00 AM",
  "Country of residence: United States",
].join("\n");

/** What canned Jev picks for each field, by the label its question quotes: what an over-eager model would pick, "34" included. */
export const PICKS: Record<string, string> = {
  "Full name": "Robin Vale",
  Email: "robin@example.test",
  Country: "Canada",
  Shift: "Night",
  "Do you have a valid driving license?": "yes",
  "Are you over 18?": "34",
  "Start date": "October 20, 2026",
  "Interview time": "3:30 PM",
  "Available from": "Oct 19, 2026 at 9:00 AM",
  "Country of residence": "United States",
};
export const byLabel = (_: string, ins: string): string | null => PICKS[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null;

export const c = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id, key: `form[apply]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#apply", rect: [0, 0, 200, 20], ...extra,
});

/** The mixed-control form, as the content script walks it. */
export function mixedControls(): PageControl[] {
  const shift = { id: "g1", name: "Shift" };
  return [
    c("e1", "text", "Full name", { value: "" }),
    c("e2", "email", "Email", { value: "" }),
    c("e3", "select", "Country", { options: [{ value: "", label: "Choose a country", selected: true }, { value: "ca", label: "Canada", selected: false }, { value: "mx", label: "Mexico", selected: false }, { value: "us", label: "United States", selected: false }] }),
    c("e4", "radio", "Day", { checked: false, group: shift }),
    c("e5", "radio", "Night", { checked: false, group: shift }),
    c("e6", "checkbox", "Do you have a valid driving license?", { checked: false }),
    c("e7", "checkbox", "Are you over 18?", { checked: false }),
    c("e8", "checkbox", "Send me news and offers", { checked: false }),
    c("e9", "date", "Start date", { value: "" }),
    c("e10", "time", "Interview time", { value: "" }),
    c("e11", "datetime", "Available from", { value: "" }),
    c("e12", "combobox", "Country of residence", { value: "" }),
    c("e13", "file", "Resume", { value: "" }),
    c("e14", "button", "Submit Application"),
  ];
}

export const KEY = (id: string): string => `f0/${mixedControls().find((x) => x.id === id)?.key ?? id}`;
export const RADIO = "f0/radiogroup:g1";

/**
 * A page engine for one tab that acts as the content script does: a write sets a value, a select picks by option value,
 * a checked write ticks or unticks a box, checks a radio (and unchecks its group's others), and clears a radio only on an
 * undo (sameAs). A press is a hand-off. `reload()` starts a new document: values empty, a new navigation generation,
 * and every act under the old grant refused, as the worker refuses one.
 */
export class FakePage {
  readonly sent: HelperToEngine[] = [];
  readonly session: EngineSession;
  onAct: ((v: Exclude<PageVerb, { kind: "pageWalk" }>, page: FakePage) => object | null) | null = null;
  controls: PageControl[];
  /** The tab's title, and what a reload puts back (P2: other forms than the mixed one). */
  title: string;
  private make: () => PageControl[];
  /** P3: the files each file control holds, by control id, as pageAttachFile put them there. */
  readonly files = new Map<string, { name: string; size: number }>();
  /** P3: the page's path, which goTo changes (the wizard's next page). */
  path = "/mixed";
  navGen = 1;
  documentId = "D0";
  /** The navigation generation the task's grant pinned; an act in a later one is refused. */
  grantedGen: number | null = null;

  constructor(make: () => PageControl[] = mixedControls, title = TITLE) {
    this.make = make;
    this.controls = make();
    this.title = title;
    this.session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      this.sent.push(m);
      if (m.type === "scopedActGrant" && m.scope.kind === "page") this.grantedGen = m.scope.navGen;
      if (m.type === "pageCommand") queueMicrotask(() => this.answer(m.id, m.verb));
      return true;
    }, 500);
  }

  snapshot(id: string): PageSnapshot {
    return {
      type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: Date.now(), tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: this.title,
      frames: [{ frameId: 0, parentFrameId: -1, documentId: this.documentId, origin: "http://127.0.0.1:4310", path: this.path, navGen: this.navGen, title: this.title, headings: [], iframes: [], excluded: {}, truncated: false, controls: structuredClone(this.controls) }],
      missing: [],
      focused: { frameId: 0, id: "e1", selection: [0, 0] },
    };
  }

  find(id: string): PageControl {
    const x = this.controls.find((y) => y.id === id);
    if (x === undefined) throw new Error(`no control ${id}`);
    return x;
  }

  /** What each control shows: its value, its selected option's label, or its checked state. */
  shown(id: string): string | boolean | undefined {
    const x = this.find(id);
    if (x.kind === "select") return x.options?.find((o) => o.selected && o.value !== "")?.label ?? "";
    if (x.kind === "checkbox" || x.kind === "radio") return x.checked === true;
    return x.value;
  }

  reload(): void {
    this.navGen++;
    this.documentId = `D${this.navGen}`;
    this.controls = this.make();
    this.files.clear();
  }

  /** P3: the user's own Next: a new document with another form (`make`), title and path; what reload() puts back from then on. */
  goTo(make: () => PageControl[], title: string, path: string): void {
    this.make = make;
    this.title = title;
    this.path = path;
    this.reload();
  }

  get verbs(): PageVerb[] {
    return this.sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb] : []));
  }

  private reply(id: string, r: object): void {
    this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), ...r } as never);
  }

  private answer(id: string, verb: PageVerb): void {
    if (verb.kind === "pageWalk") {
      this.session.receive(this.snapshot(id));
      return this.reply(id, { outcome: "ok", detail: null });
    }
    const custom = this.onAct?.(verb, this) ?? null;
    if (custom !== null) return this.reply(id, custom);
    if (this.grantedGen !== this.navGen || verb.documentId !== this.documentId) return this.reply(id, { outcome: "notAllowed", detail: "the frame navigated since the grant" });
    const x = this.find(verb.id);
    switch (verb.kind) {
      case "pageWrite":
      case "pageChooseOption": {
        const before = x.value ?? "";
        // As the content script: a field already holding the value is left; one holding other text than expected is stale.
        if (before === verb.value) return this.reply(id, { outcome: "alreadyTrue", detail: null });
        if (before !== verb.expect) return this.reply(id, { outcome: "stale", detail: "the field holds other text than when it was walked" });
        x.value = verb.value;
        return this.reply(id, { outcome: "ok", detail: null, readings: { before, afterInput: verb.value, afterBlur: verb.value, invalid: false, error: null } });
      }
      case "pageSelect": {
        const before = x.options?.find((o) => o.selected)?.value ?? "";
        if (before === verb.value) return this.reply(id, { outcome: "alreadyTrue", detail: null });
        if (before !== verb.expect) return this.reply(id, { outcome: "stale", detail: "the select shows another option than when it was walked" });
        x.options = x.options?.map((o) => ({ ...o, selected: o.value === verb.value }));
        return this.reply(id, { outcome: "ok", detail: null, readings: { before, afterInput: verb.value, afterBlur: verb.value, invalid: false, error: null } });
      }
      case "pageAttachFile": {
        // As the content script: a file input takes the file and reports its own file list; a dropzone shows the name.
        if (x.kind !== "file" && x.kind !== "button") return this.reply(id, { outcome: "unsupported", detail: "takes no file" });
        this.files.set(x.id, { name: verb.file.name, size: verb.file.size });
        const attached = x.kind === "file" ? { via: "input", file: { name: verb.file.name, size: verb.file.size }, shown: true } : { via: "drop", file: null, shown: true };
        return this.reply(id, { outcome: "ok", detail: null, attached });
      }
      case "pageSetChecked": {
        if (x.checked === verb.checked) return this.reply(id, { outcome: "alreadyTrue", detail: null });
        if (!verb.checked && x.kind === "radio" && verb.sameAs === undefined) return this.reply(id, { outcome: "unsupported", detail: "a radio is cleared by choosing another one" });
        if (x.kind === "radio" && verb.checked) for (const o of this.controls) if (o.kind === "radio" && o.group?.id === x.group?.id) o.checked = false;
        x.checked = verb.checked;
        return this.reply(id, { outcome: "ok", detail: null });
      }
      default:
        return this.reply(id, { outcome: "handoff", detail: "a press is the user's", risk: "pageScript" });
    }
  }
}

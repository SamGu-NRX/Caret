// An in-process stand-in for the reader and one app window, for executor tests. It answers reader
// verbs the way caret-screen does: recheck the target, act, and send a fresh snapshot before the
// answer. Buttons run small handlers. Everything here is synthetic.
import { isCalendarVerb, PROTOCOL_VERSION, type ActGrant, type ActRevoke, type Node, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
import type { Helper } from "../src/helper.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { FIXTURE_APP, snap } from "./builders.ts";
import { FakeGrants } from "./fake-grants.ts";
import { FakeMarks } from "./fake-marks.ts";

export const WIN = "5150-7";
/** The fake window's window-server number (B21: a planRequest names its window by number). Invented. */
export const WIN_NUMBER = 4821;
export const TITLE = "Fixture — Executor";
export const K = (s: string): string => `dev.caret.fixture/standard/${s}`;

export class FakeApp implements ReaderLink {
  helper: Helper | null = null;
  title = TITLE;
  /** The window's kind from its subrole; "systemdialog" makes it a system prompt (B22). */
  windowKind = "standard";
  nodes: Node[];
  focusedKey: string | null = null;
  readonly verbs: ReaderVerb[] = [];
  readonly buttons = new Map<string, (app: FakeApp) => void>();
  /** Makes value writes report success while changing nothing, as a web view whose window is not key does (B15). */
  dropWrites = false;
  /** The same for focus-then-value (B20). */
  dropFocusValues = false;
  /** The same for focus-and-insert. */
  dropInserts = false;
  /** Leaves the field out of the walk right after a write of this kind and back in the next one, as B15's WebKit window did. */
  vanishAfter: "value" | "focusValue" | "insert" | null = null;
  private vanished: Node | null = null;
  /**
   * Answers a write of these kinds focusMoved and writes nothing, as caret-screen does when a page's focus handler
   * moves focus off the field it just focused (B23, S1 audit #14).
   */
  focusMovesOn = new Set<string>();
  /** Sets the value but answers axError, as a reader that timed out while settling does. */
  timeoutAfterWrite = false;
  /** Answers this many walks with axError first, as a walk cut short by a busy app is. */
  failWalks = 0;
  /** Rewrites each written value, as an app that formats input does. */
  normalize: ((v: string) => string) | null = null;
  /** Called after each verb, so a test can change the app between steps. */
  afterVerb: ((app: FakeApp, v: ReaderVerb) => void) | null = null;
  /** Called when a verb arrives, before the fake judges it: a control the user sends while the verb is on its way. */
  beforeVerb: ((app: FakeApp, v: ReaderVerb) => void) | null = null;
  /** Every grant and revoke the executor sent. */
  readonly grants = new FakeGrants();
  /** The elements writes were recorded under, as the reader keeps them (B23). */
  readonly marks = new FakeMarks();
  /** Refuses write, press and raise without a live grant, as caret-screen without --act-pids does. Off by default. */
  enforceGrants = false;
  /** Other windows a test sent itself, which walks re-read as unchanged; the fake acts in none of them. */
  readonly readable = new Set<string>();
  private at = 1000;

  constructor(nodes: Node[]) {
    this.nodes = nodes;
  }

  node(key: string): Node | undefined {
    return this.nodes.find((n) => n.key === key);
  }

  setValue(key: string, value: string): void {
    const n = this.node(key);
    if (n === undefined) throw new Error(`no node ${key}`);
    if (value === "") delete n.value;
    else n.value = value;
  }

  /** Sends the window's current state to the helper, as a full walk. */
  show(): void {
    this.at += 10;
    const nodes = this.vanished === null ? this.nodes : this.nodes.filter((n) => n.key !== this.vanished?.key);
    void this.helper?.handleReader(
      snap(structuredClone(nodes), { at: this.at, windowId: WIN, title: this.title, focusedKey: this.focusedKey, reason: "request", number: WIN_NUMBER, kind: this.windowKind }),
    );
  }

  grant(m: ActGrant | ActRevoke): void {
    this.grants.receive(m);
  }

  async run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    this.beforeVerb?.(this, verb);
    const refused = this.enforceGrants ? this.grants.refusal(verb) : null;
    const r = refused !== null ? { outcome: "notAllowed" as const, detail: refused } : this.perform(verb);
    this.afterVerb?.(this, verb);
    return { type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: this.at, outcome: r.outcome, detail: r.detail };
  }

  private perform(verb: ReaderVerb): { outcome: VerbResult["outcome"]; detail: string | null } {
    if (verb.kind === "watchInput" || verb.kind === "watchWindows" || verb.kind === "watchPresses") return { outcome: "ok", detail: null };
    if (isCalendarVerb(verb)) return { outcome: "notAllowed", detail: "the fake app has no calendar" };
    if (verb.kind === "walk" && this.readable.has(verb.windowId)) return { outcome: "ok", detail: null };
    if (verb.pid !== FIXTURE_APP.pid) return { outcome: "notAllowed", detail: null };
    if (verb.windowId !== WIN) return { outcome: "noWindow", detail: null };
    if (verb.kind === "walk" && this.failWalks > 0) {
      this.failWalks--;
      return { outcome: "axError", detail: "the walk was cut short" };
    }
    if (verb.kind === "raise") return { outcome: "notAllowed", detail: "the fake app does not raise its window" };
    if (verb.kind === "walk") this.vanished = null;
    this.show();
    if (verb.kind === "walk") return { outcome: "ok", detail: null };
    const n = this.node(verb.key);
    if (n === undefined) return { outcome: "noElement", detail: verb.key };
    if (n.role !== verb.role) return { outcome: "changed", detail: `role is ${n.role}` };
    if (verb.kind === "write") {
      const notSame = this.marks.check(verb);
      if (notSame !== null) return { outcome: "notSameElement", detail: notSame };
      if (n.states?.includes("secure")) return { outcome: "secure", detail: null };
      if (this.focusMovesOn.has(verb.attribute)) return { outcome: "focusMoved", detail: "focus is on another field of the window" };
      if (verb.attribute === "value" || verb.attribute === "focusValue" || verb.attribute === "insert") {
        if ((n.value ?? "") !== verb.expect) return { outcome: "changed", detail: `value is '${n.value ?? ""}'` };
        if (verb.attribute !== "value") this.focusedKey = verb.key;
        const dropped = verb.attribute === "value" ? this.dropWrites : verb.attribute === "focusValue" ? this.dropFocusValues : this.dropInserts;
        if (!dropped) this.setValue(verb.key, this.normalize === null ? verb.value : this.normalize(verb.value));
        if (verb.attribute === this.vanishAfter) this.vanished = n;
        if (this.timeoutAfterWrite) return { outcome: "axError", detail: "no answer from the reader within 5000 ms" };
      } else this.focusedKey = verb.key;
    } else {
      if ((n.label ?? "") !== verb.label) return { outcome: "changed", detail: `label is '${n.label ?? ""}'` };
      this.buttons.get(verb.key)?.(this);
    }
    this.show();
    return { outcome: "ok", detail: null };
  }
}

/** A form with two named fields, two same-named fields in two sections, a status line and four buttons. */
export function executorWindow(): Node[] {
  return [
    { key: K("textfield:name~0"), parent: null, role: "AXTextField", label: "Name", editable: true, frame: [100, 40, 200, 24] },
    { key: K("textfield:email~0"), parent: null, role: "AXTextField", label: "Email", editable: true, value: "old@example.com", frame: [100, 80, 200, 24] },
    { key: K("group:billing~0"), parent: null, role: "AXGroup", label: "Billing" },
    { key: K("group:billing/textfield:city~0"), parent: K("group:billing~0"), role: "AXTextField", label: "City", editable: true },
    { key: K("group:shipping~0"), parent: null, role: "AXGroup", label: "Shipping" },
    { key: K("group:shipping/textfield:city~0"), parent: K("group:shipping~0"), role: "AXTextField", label: "City", editable: true },
    { key: K("statictext:status: active~0"), parent: null, role: "AXStaticText", label: "Status: Active" },
    { key: K("statictext:page~0"), parent: null, role: "AXStaticText", label: "Page 1" },
    { key: K("button:archive~0"), parent: null, role: "AXButton", label: "Archive" },
    { key: K("button:next page~0"), parent: null, role: "AXButton", label: "Next page" },
    { key: K("button:send~0"), parent: null, role: "AXButton", label: "Send" },
    { key: K("button:~0"), parent: null, role: "AXButton" },
  ];
}

export function wireButtons(app: FakeApp): void {
  app.buttons.set(K("button:archive~0"), (a) => {
    a.nodes = a.nodes.filter((n) => n.key !== K("statictext:status: active~0"));
    a.nodes.push({ key: K("statictext:status: archived~0"), parent: null, role: "AXStaticText", label: "Status: Archived" });
  });
  app.buttons.set(K("button:next page~0"), (a) => {
    a.title = `${TITLE} (page 2)`;
    const page = a.node(K("statictext:page~0"));
    if (page !== undefined) page.label = "Page 2";
  });
  app.buttons.set(K("button:send~0"), (a) => {
    a.nodes.push({ key: K("statictext:sent!~0"), parent: null, role: "AXStaticText", label: "Sent!" });
  });
}

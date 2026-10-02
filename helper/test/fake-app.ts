// An in-process stand-in for the reader and one app window, for executor tests. It answers reader
// verbs the way caret-screen does: recheck the target, act, and send a fresh snapshot before the
// answer. Buttons run small handlers. Everything here is synthetic.
import { PROTOCOL_VERSION, type Node, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
import type { Helper } from "../src/helper.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { FIXTURE_APP, snap } from "./builders.ts";

export const WIN = "5150-7";
export const TITLE = "Fixture — Executor";
export const K = (s: string): string => `dev.caret.fixture/standard/${s}`;

export class FakeApp implements ReaderLink {
  helper: Helper | null = null;
  title = TITLE;
  nodes: Node[];
  focusedKey: string | null = null;
  readonly verbs: ReaderVerb[] = [];
  readonly buttons = new Map<string, (app: FakeApp) => void>();
  /** Makes value writes report success while changing nothing, as Chromium does in the background. */
  dropWrites = false;
  /** Sets the value but answers axError, as a reader that timed out while settling does. */
  timeoutAfterWrite = false;
  /** Answers this many walks with axError first, as a walk cut short by a busy app is. */
  failWalks = 0;
  /** Rewrites each written value, as an app that formats input does. */
  normalize: ((v: string) => string) | null = null;
  /** Called after each verb, so a test can change the app between steps. */
  afterVerb: ((app: FakeApp, v: ReaderVerb) => void) | null = null;
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
    void this.helper?.handleReader(
      snap(structuredClone(this.nodes), { at: this.at, windowId: WIN, title: this.title, focusedKey: this.focusedKey, reason: "request" }),
    );
  }

  async run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    const r = this.perform(verb);
    this.afterVerb?.(this, verb);
    return { type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: this.at, outcome: r.outcome, detail: r.detail };
  }

  private perform(verb: ReaderVerb): { outcome: VerbResult["outcome"]; detail: string | null } {
    if (verb.kind === "watchInput" || verb.kind === "watchWindows") return { outcome: "ok", detail: null };
    if (verb.pid !== FIXTURE_APP.pid) return { outcome: "notAllowed", detail: null };
    if (verb.windowId !== WIN) return { outcome: "noWindow", detail: null };
    if (verb.kind === "walk" && this.failWalks > 0) {
      this.failWalks--;
      return { outcome: "axError", detail: "the walk was cut short" };
    }
    this.show();
    if (verb.kind === "walk") return { outcome: "ok", detail: null };
    const n = this.node(verb.key);
    if (n === undefined) return { outcome: "noElement", detail: verb.key };
    if (n.role !== verb.role) return { outcome: "changed", detail: `role is ${n.role}` };
    if (verb.kind === "write") {
      if (n.states?.includes("secure")) return { outcome: "secure", detail: null };
      if (verb.attribute === "value") {
        if ((n.value ?? "") !== verb.expect) return { outcome: "changed", detail: `value is '${n.value ?? ""}'` };
        if (!this.dropWrites) this.setValue(verb.key, this.normalize === null ? verb.value : this.normalize(verb.value));
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

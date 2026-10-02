// A large synthetic screen for the candidate generator's budget: windows shaped like the ones B5's
// audit met on a real day (mail, a table, a chat transcript, a web page, contacts, an agent thread,
// a file list), with 1,500 or more distinct spans and a couple of hundred typed values. Every name,
// number and address is invented, and the scene is the same for the same seed.
import { ScreenModel } from "../src/model.ts";
import type { AppRef, Frame, Node, Snapshot, TypedValue } from "../src/protocol.ts";
import { snap } from "./builders.ts";

const FIRST = ["Ines", "Tomas", "Priya", "Dana", "Kofi", "Mirela", "Aiko", "Bram", "Lucia", "Oren", "Sefa", "Wren", "Yuki", "Zora", "Emeka", "Hanne"];
const LAST = ["Okafor", "Lindqvist", "Raman", "Whitfield", "Mensah", "Vasquez", "Tanaka", "Dekker", "Moreau", "Halevi", "Tupou", "Ashby", "Sato", "Kral", "Obi", "Berg"];
const WORDS = [
  "venue", "deposit", "invoice", "schedule", "draft", "review", "budget", "shipment", "catering", "renewal", "agenda", "quote", "receipt",
  "transfer", "booking", "estimate", "summary", "contract", "roster", "seating", "permit", "badge", "travel", "storage", "audit",
];

/** mulberry32: a small seeded generator, so the scene is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Builder {
  readonly nodes: Node[] = [];
  readonly values: TypedValue[] = [];
  private n = 0;
  private y = 40;
  private readonly prefix: string;
  private readonly r: () => number;
  constructor(prefix: string, r: () => number) {
    this.prefix = prefix;
    this.r = r;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)] as T;
  }
  name(): string {
    return `${this.pick(FIRST)} ${this.pick(LAST)}`;
  }
  phrase(k: number): string {
    return Array.from({ length: k }, () => this.pick(WORDS)).join(" ");
  }
  key(role: string): string {
    return `${this.prefix}/${role.slice(2).toLowerCase()}~${this.n++}`;
  }
  add(role: string, label: string, parent: string | null = null, x = 320, w = 420, extra: Partial<Node> = {}): string {
    const key = this.key(role);
    const frame: Frame = [x, this.y, w, 18];
    this.y += 22;
    this.nodes.push({ key, parent, role, label, frame, ...extra });
    return key;
  }
  typed(kind: TypedValue["kind"], text: string, nodeKey: string): void {
    this.values.push({ kind, text, nodeKey });
  }
}

export interface LargeScene {
  model: ScreenModel;
  formWindowId: string;
  snapshots: Snapshot[];
  /** Nodes over every window but the form. */
  nodes: number;
}

const app = (pid: number, bundleId: string, name: string): AppRef => ({ pid, bundleId, name });

/**
 * `scale` multiplies every window's length; 1 gives about 1,700 spans. The windows are focused one
 * after another, oldest first, so recency differs between them, and the form window comes last.
 */
export function largeScene(seed = 7, scale = 1): LargeScene {
  const r = rng(seed);
  const snapshots: Snapshot[] = [];
  let at = 1_000_000;
  const window = (pid: number, bundle: string, appName: string, title: string, fill: (b: Builder) => void): void => {
    const b = new Builder(`${bundle}/standard`, r);
    fill(b);
    at += 5000;
    snapshots.push(snap(b.nodes, { at, windowId: `${pid}-1`, app: app(pid, bundle, appName), title, focused: true, values: b.values }));
  };
  const n = (k: number): number => Math.round(k * scale);

  window(4101, "dev.caret.mail", "Mail", "Inbox", (b) => {
    for (let i = 0; i < n(40); i++) {
      const who = b.name();
      const msg = b.add("AXGroup", `Message from ${who}`);
      b.add("AXStaticText", `${b.phrase(6)}, ${b.phrase(4)}.`, msg);
      b.add("AXStaticText", `${b.phrase(8)}`, msg);
      const sig = b.add("AXStaticText", `${who}\n${b.pick(WORDS)} lead\n+1 512 555 ${String(1000 + i).padStart(4, "0")}`, msg);
      b.typed("phone", `+1 512 555 ${String(1000 + i).padStart(4, "0")}`, sig);
      const mail = b.add("AXStaticText", `${who.toLowerCase().replace(" ", ".")}${i}@example.org`, msg);
      b.typed("email", `${who.toLowerCase().replace(" ", ".")}${i}@example.org`, mail);
    }
  });
  window(4202, "dev.caret.sheet", "Sheets", "Q3 budget", (b) => {
    const table = b.add("AXTable", "Budget");
    for (let row = 0; row < n(80); row++) {
      b.add("AXCell", `ORD-2026-${String(40000 + row)}`, table, 100, 120);
      const amt = b.add("AXCell", `$${(row * 37.5 + 12).toFixed(2)}`, table, 240, 100);
      b.typed("amount", `$${(row * 37.5 + 12).toFixed(2)}`, amt);
      b.add("AXCell", b.phrase(2), table, 360, 160);
      b.add("AXCell", b.name(), table, 540, 160);
    }
  });
  window(4303, "dev.caret.chat", "Chat", "Planning", (b) => {
    for (let i = 0; i < n(150); i++) {
      b.add("AXStaticText", `${b.name()}`, null, 100, 120);
      b.add("AXStaticText", `${b.phrase(5)} ${i}`, null, 240, 500);
    }
  });
  window(4404, "dev.caret.browser", "Browser", "Vendor portal", (b) => {
    const area = b.add("AXWebArea", "Vendor portal");
    for (let i = 0; i < n(120); i++) {
      b.add("AXLink", `${b.phrase(3)} ${i}`, area);
      const t = b.add("AXStaticText", `Ref: QX-${70000 + i}`, area);
      b.typed("id", `QX-${70000 + i}`, t);
    }
    for (let i = 0; i < n(60); i++) b.add("AXHeading", `${b.phrase(2)} section ${i}`, area);
  });
  window(4505, "dev.caret.contacts", "Contacts", "All contacts", (b) => {
    for (let i = 0; i < n(80); i++) {
      const card = b.add("AXGroup", b.name());
      b.add("AXStaticText", "Phone:", card, 100, 60);
      b.add("AXStaticText", `(415) 555-${String(2000 + i)}`, card, 180, 140);
      b.add("AXStaticText", `Company: ${b.pick(LAST)} ${b.pick(WORDS)} Ltd`, card);
    }
  });
  window(4606, "dev.caret.agent", "Agent", "Thread", (b) => {
    for (let i = 0; i < n(200); i++) b.add("AXStaticText", `${b.phrase(7)} step ${i}`, null, 300, 600);
    b.add("AXButton", "Send", null, 900, 40);
  });
  window(4707, "dev.caret.files", "Files", "Projects", (b) => {
    for (let i = 0; i < n(150); i++) b.add("AXStaticText", `${b.pick(WORDS)}-${b.pick(WORDS)}-${i}.pdf`, null, 120, 300);
  });
  const formNodes: Node[] = [
    { key: "dev.caret.form/standard/textfield:email~0", parent: null, role: "AXTextField", editable: true, label: "Email", frame: [200, 100, 300, 20] },
    { key: "dev.caret.form/standard/textfield:phone~0", parent: null, role: "AXTextField", editable: true, label: "Phone", frame: [200, 140, 300, 20] },
  ];
  at += 5000;
  snapshots.push(snap(formNodes, { at, windowId: "4808-1", app: app(4808, "dev.caret.form", "Form"), title: "Vendor form", focused: true }));

  const model = new ScreenModel();
  for (const s of snapshots) model.apply(s);
  const nodes = [...model.windows.values()].filter((w) => w.window.windowId !== "4808-1").reduce((k, w) => k + w.nodes.size, 0);
  return { model, formWindowId: "4808-1", snapshots, nodes };
}

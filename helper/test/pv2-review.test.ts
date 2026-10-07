// PV2 review of fc6c853: one test per finding, each the reviewer's counterexample. Under the standing rule these broke
// provenance (1), a shape (2), a budget (3), a structural exclusion (4, 7) or Sites (5, 6); the last is the should-fix
// for a short secret quoted out of a line redaction removed.
import { describe, expect, it } from "vitest";
import { Disclosure, UnmintedText, verifySent, type ModelText } from "../src/privacy/disclosure.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { EngineSession } from "../src/engines/session.ts";
import { EngineRegistry } from "../src/engines/registry.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { llamaEngine } from "../src/engines/decide/llama.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot, type Snapshot } from "../src/protocol.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import { field, node, snap, text } from "./builders.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = (): EngineSession => new EngineSession({ engine: "eng1", browser: CHROME, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, () => true);
const control = (id: string, name: string, value: string): PageControl => ({ id, key: `form[a]/text:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "text", name, form: "form#a", rect: [0, 0, 100, 20], value });
const page = (frames: { origin: string; controls: PageControl[] }[], title = "Vault: Lumen staging"): PageSnapshot => ({
  type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title,
  frames: frames.map((f, i) => ({ frameId: i, parentFrameId: i === 0 ? -1 : 0, documentId: `D${i}`, origin: f.origin, path: "/", navGen: 1, title, headings: [], iframes: [], excluded: {}, truncated: false, controls: f.controls })),
  missing: [],
  focused: null,
});

function note(lines: string[]): { m: ScreenModel; view: WindowState } {
  const m = new ScreenModel();
  m.apply(snap(lines.map((l, i) => text(`t${i}`, l)), { at: 900, windowId: "note", title: "Notes" }));
  return { m, view: redactWindow(m.windows.get("note") as WindowState) };
}

describe("PV2 review: provenance, shapes and budgets in the Disclosure", () => {
  it("1: join's separator is Caret's literal or a minted text, never raw screen text", () => {
    const { m, view } = note(["Name: Elena Vance"]);
    const d = new Disclosure(m.windows.values());
    const [a, b] = [d.own("A"), d.own("B")];
    const raw: string = "Elena Vance";
    expect(() => d.join([a, b], raw as "; ")).toThrow(UnmintedText);
    // A minted separator carries its reasons into the join.
    const sep = d.candidate(view, "Elena Vance") as ModelText;
    expect([...(d.reasonsOf(d.join([a, b], sep)) ?? [])].sort()).toEqual(["candidate", "ownWording"]);
    expect(d.join([a, b], "; ")).toBe("A; B");
  });

  it("2: a JSON state is checked as it was written, not as its source object is later", () => {
    const { m, view } = note(["Name: Elena Vance"]);
    const d = new Disclosure(m.windows.values());
    const source: { task: ModelText } = { task: d.candidate(view, "Elena Vance") as ModelText };
    const json = d.jsonText(source);
    source.task = d.own("Route.");
    expect(() => verifySent({ purpose: "route.judge", disclosure: d }, { state: json, questions: {} })).toThrow(/state\.task carries text minted as candidate/u);
  });

  it("3: a derivation read from a basis is priced against its window, so a prose line never goes out whole", () => {
    const prose = "Dana said the staging rotation moves to the Austin office after the March review, then back again in June.";
    const { m, view } = note([prose]);
    const d = new Disclosure(m.windows.values());
    const b = d.basis(view, prose);
    expect(b).not.toBeNull();
    expect(d.derived(b!, prose)).toBeNull();
    expect(d.declared().charged).toEqual({});
    // A short derivation fits, and is charged.
    expect(d.derived(b!, "March review")).toBe("March review");
    expect(d.declared().charged.note ?? 0).toBeGreaterThan(0);
  });
});

describe("PV2 review: structural exclusions", () => {
  it("4: a cut walk that marks a group secure excludes the child it kept from before", () => {
    const m = new ScreenModel();
    const secret = "violet-orchard-seven";
    m.apply(snap([node("g", "AXGroup", { label: "Sign-in" }), field("g/pw", secret, { parent: "g", label: "Code" })], { at: 1000, windowId: "w" }));
    const cut: Snapshot = { ...snap([node("g", "AXGroup", { label: "Sign-in", states: ["secure"] })], { at: 1100, windowId: "w" }), stats: { walkMs: 5, visited: 1, truncated: true } };
    m.apply(cut);
    const child = m.windows.get("w")?.nodes.get("g/pw");
    expect(child).toBeDefined();
    expect(child?.value).toBeUndefined();
    expect(child?.excluded).toBe("secure");
    expect(JSON.stringify([...(m.windows.get("w")?.values ?? [])])).not.toContain(secret);
  });

  it("7: the local engine renders the request it checked, whatever the caller does to it afterwards", async () => {
    const d = new Disclosure([]);
    const req: JevRequest = d.seal({ purpose: "route.judge", state: { task: d.own("Route.") }, questions: { q: { type: "choice", instructions: d.own("Which?"), criteria: { a: d.own("A"), b: d.own("B") } } }, snippets: [], charged: {} });
    const prompts: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      prompts.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ prompt: "x", completion_probabilities: [{ top_logprobs: [{ token: "A", logprob: 0 }] }], tokens_evaluated: 1, content: "A" }), { status: 200 });
    }) as typeof fetch;
    const engine = llamaEngine({ url: "http://127.0.0.1:1", model: "m", prompt: "document", fetchImpl });
    const run = engine.ask(req).catch(() => null);
    (req as { state: unknown }).state = { task: "raw secret swapped in after the check" };
    await run;
    expect(prompts.join("\n")).not.toContain("raw secret swapped in");
  });
});

describe("PV2 review: Sites", () => {
  it("5: a tab whose top frame is at a site switched off brings neither its frames nor its title", () => {
    const s = session();
    s.sitesOff(["https://vault.example"]);
    const w = toWindowSnapshot(page([{ origin: "https://vault.example", controls: [control("e1", "Note", "hello")] }, { origin: "https://embed.example", controls: [control("e2", "Other", "x")] }]), s, 1);
    expect(w.window.title).not.toContain("Lumen");
    expect(w.nodes).toEqual([]);
  });

  it("6: switching a site off removes what the model already holds from it", async () => {
    const m = new ScreenModel();
    const reg = new EngineRegistry({ apply: (x) => void (x.type === "windowClosed" ? m.close(x.windowId, x.at) : m.apply(x)) });
    const s = session();
    reg.add(s);
    s.receive({ type: "pageHello", v: 1, extensionId: X, version: "0.1.0", profile: "p", instance: "w", startedAt: 1, capabilities: [] });
    await new Promise((r) => setTimeout(r, 0));
    const p = page([{ origin: "https://vault.example", controls: [control("e1", "Note", "Lumen staging token")] }], "Apply");
    s.tabs.set(7, p);
    s.onSnapshot?.(p, s);
    expect(JSON.stringify([...(m.windows.get("page:eng1:7")?.nodes.values() ?? [])])).toContain("Lumen staging token");
    reg.setSitesOff(["https://vault.example"]);
    expect(JSON.stringify([...(m.windows.get("page:eng1:7")?.nodes.values() ?? [])])).not.toContain("Lumen staging token");
  });
});

describe("PV2 review should-fix: a short secret quoted out of a removed line", () => {
  it("plan text never quotes a value-shaped word that only a removed line shows", () => {
    const { m } = note(["Password: hunter2", "City: Austin"]);
    const d = new Disclosure(m.windows.values());
    expect(d.planText("The note says hunter2")).toBeNull();
    // Words the views keep, and plain words, still go.
    expect(d.planText("The note says Austin")).toBe("The note says Austin");
  });
});

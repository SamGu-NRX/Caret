// A web page's text field never sends its text (counsel 2026-10-09, "Field values never leave the content script"):
// the schema has no place for it, the focused field's caret text is the one exception and is branded local-only, and
// one module each sends the two verbs that ask a page about its fields' text. Every value here is invented.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { EngineMessage, PageControl, PageVerb, PROTOCOL_VERSION, TextPageControl, type HelperToEngine, type PageSnapshot } from "../src/protocol.ts";
import { PAGE_SOURCE_REFUSAL, readPickedSource } from "../src/engines/page-source.ts";
import { EngineSession } from "../src/engines/session.ts";
import { FocusTextSerialized, focusText, forHost } from "../src/engines/focus-text.ts";
import { FocusTextLeak, MIN_TRIPWIRE_CHARS, noteFocusedText, refuseFocusedText } from "../src/privacy/focus-tripwire.ts";
import { X, chrome } from "./fake-page.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const text = { id: "e1", key: "form[a]/textbox:email~0", strongKey: null, kind: "email" as const, role: "textbox", name: "Email", form: "form#a", rect: [0, 0, 100, 20] as [number, number, number, number] };

describe("a text control at the type level", () => {
  it("has hasValue and rev, and no value", () => {
    expectTypeOf<TextPageControl["value"]>().toEqualTypeOf<undefined>();
    expectTypeOf<TextPageControl["hasValue"]>().toEqualTypeOf<boolean | null>();
    expectTypeOf<TextPageControl["rev"]>().toEqualTypeOf<number | null>();
    // @ts-expect-error a text control carries no value
    const bad: TextPageControl = { ...text, hasValue: true, rev: 2, value: "robin@example.test" };
    void bad;
  });
});

describe("a text control on the wire", () => {
  it("is refused, loudly, when it carries a value, checked or options, and taken with hasValue and rev", () => {
    expect(PageControl.safeParse({ ...text, hasValue: true, rev: 2 }).success).toBe(true);
    const valued = PageControl.safeParse({ ...text, hasValue: true, rev: 2, value: "robin@example.test" });
    expect(valued.success).toBe(false);
    expect(JSON.stringify(valued.error?.issues)).toMatch(/never leaves the page/);
    expect(PageControl.safeParse({ ...text, hasValue: null, rev: null, options: [] }).success).toBe(false);
    // Without hasValue and rev, it is not a text control the helper reads.
    expect(PageControl.safeParse({ ...text }).success).toBe(false);
    // A select is a choice control: its chosen option is page state, sent as before.
    expect(PageControl.safeParse({ ...text, kind: "select", role: "combobox", value: "ca", options: [{ value: "ca", label: "Canada", selected: true }] }).success).toBe(true);
  });

  it("refuses a whole snapshot that carries one", () => {
    const snap = (controls: object[]): object => ({ type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w", at: 1, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "https://jobs.example.test", path: "/", navGen: 1, title: "Apply", headings: [], controls, iframes: [], excluded: {}, truncated: false }], missing: [], focused: null });
    expect(EngineMessage.safeParse(snap([{ ...text, hasValue: true, rev: 1 }])).success).toBe(true);
    expect(EngineMessage.safeParse(snap([{ ...text, hasValue: true, rev: 1, value: "Tr0mbone-Lattice-91" }])).success).toBe(false);
  });
});

describe("the focused field's caret text", () => {
  const t = { before: "Dear hiring team, I am writing about the ", after: "", selection: "" };
  it("is branded when a walk arrives: its JSON throws, and the host's copy is plain", () => {
    const branded = focusText(t);
    expect(() => JSON.stringify({ focused: { text: branded } })).toThrow(FocusTextSerialized);
    expect(JSON.parse(JSON.stringify(forHost(branded)))).toEqual(t);
  });

  it("is branded in the walk's answer, and kept nowhere", async () => {
    const session: EngineSession = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m: HelperToEngine) => {
      if (m.type !== "pageCommand") return true;
      const s: PageSnapshot = { type: "pageSnapshot", v: PROTOCOL_VERSION, id: m.id, at: 1, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "https://jobs.example.test", path: "/", navGen: 1, title: "Apply", headings: [], controls: [{ ...text, kind: "textarea" as const, hasValue: true, rev: 3 }], iframes: [], excluded: {}, truncated: false }], missing: [], focused: { frameId: 0, id: "e1", selection: [41, 41], text: t } };
      queueMicrotask(() => {
        session.receive(s);
        session.receive({ type: "pageResult", v: PROTOCOL_VERSION, id: m.id, at: 1, outcome: "ok", detail: null });
      });
      return true;
    }, 500);
    const a = await session.command({ kind: "pageWalk", tabId: 7 });
    expect(() => JSON.stringify(a.snapshot)).toThrow(FocusTextSerialized);
    expect(JSON.stringify(session.tabs.get(7))).not.toContain("hiring team");
  });

  it("stops a cloud request body that holds it", () => {
    noteFocusedText([t.before]);
    expect(() => refuseFocusedText(JSON.stringify({ messages: [{ role: "user", content: `Continue: ${t.before}` }] }), "groq")).toThrow(FocusTextLeak);
    expect(() => refuseFocusedText(JSON.stringify({ messages: [{ role: "user", content: "Fill the form from the note" }] }), "groq")).not.toThrow();
    // A run shorter than the tripwire's floor occurs by chance: it is not looked for.
    noteFocusedText(["Hi there"]);
    expect("Hi there".length).toBeLessThan(MIN_TRIPWIRE_CHARS);
    expect(() => refuseFocusedText("Hi there", "groq")).not.toThrow();
    noteFocusedText([]);
  });
});

/** The relative imports of a source file, resolved to absolute paths. */
function importsOf(file: string): string[] {
  const s = readFileSync(file, "utf8");
  return [...s.matchAll(/(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gu)].map((m) => resolve(dirname(file), m[1] as string));
}

/** Every module `file` reaches through relative imports, itself included. */
function reach(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const f of importsOf(file)) reach(f, seen);
  return seen;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("the modules that may touch a page field's text", () => {
  it("keeps the focused text's brand and unwrap out of the cloud routes", () => {
    const focus = join(SRC, "engines/focus-text.ts");
    for (const route of ["writer/chat.ts", "fill/jev.ts"]) expect([...reach(join(SRC, route))], route).not.toContain(focus);
  });

  it("builds pageCompare in engines/page-compare.ts only, and pageSourceGrant nowhere", () => {
    for (const [verb, owners] of [["pageCompare", ["engines/page-compare.ts"]], ["pageSourceGrant", []]] as const) {
      const builders = sources(SRC).filter((f) => new RegExp(`kind: "${verb}"`, "u").test(readFileSync(f, "utf8")));
      expect(builders.map((f) => f.slice(SRC.length)).sort(), verb).toEqual(owners);
    }
  });

  it("refuses a copy from a web page's fields by name, whatever pick it is handed, and the protocol has no verb for one", () => {
    const frame = { tabId: 7, frameId: 0, documentId: "D" };
    expect(readPickedSource(frame, "t1", ["e1"], null)).toEqual({ refused: PAGE_SOURCE_REFUSAL });
    expect(readPickedSource(frame, "t1", ["e1"], { by: "user", windowId: "w1" })).toEqual({ refused: PAGE_SOURCE_REFUSAL });
    expect(PageVerb.safeParse({ kind: "pageSourceGrant", ...frame, taskId: "t1", ids: ["e1"] }).success).toBe(false);
  });
});

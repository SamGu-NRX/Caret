// SC1 section 4, the structural exclusions (privacy/exclude.ts, applied when a window is read in) and the gates beside
// them. Each has one correct answer, so each is a blocker:
// T-E1 a secure field's value never enters the model, a fill or a candidate;
// T-E2 a page control the walker marks arrives without a value, and no node in any fixture snapshot is marked and valued;
// T-E3 values in a secret format, generated per family and put in every position, reach no wire string of any builder,
//      while a near-miss corpus survives;
// T-E4 an editable control whose own label, placeholder or group names a sensitive kind keeps no value;
// T-E5 a window of an app, or a frame of a site, that the user switched off never enters the model or a request;
// T-E6 a route whose provider keeps what it is sent is refused outside an evaluation, in the Jev client and the writer.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { PROTOCOL_VERSION, ReaderMessage, type Node, type PageControl, type PageSnapshot, type Snapshot } from "../src/protocol.ts";
import { excludedValue, HIGH_ENTROPY_BITS, HIGH_ENTROPY_CHARS, WITHHELD, withholdValues } from "../src/privacy/exclude.ts";
import { DEFAULT_APPS_OFF } from "../src/privacy/read-policy.ts";
import { jevPolicy, writerPolicy } from "../src/privacy/providers.ts";
import { EngineSession } from "../src/engines/session.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { LABEL_PHRASES, labelKind } from "../src/memory/sensitive.ts";
import { collectCandidates, setGeneratorClock } from "../src/fill/candidates.ts";
import { formFields, proposeFill } from "../src/fill/fill.ts";
import { aboutValues } from "../src/fill/about.ts";
import { makeJevClient, jevSettings, JevGatewayPolicyError, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { makeWriterPort, WriterProviderRefused } from "../src/writer/port.ts";
import { gatewayRoute } from "../src/writer/routes.ts";
import { GROQ_QWEN_3_8_27B } from "../src/writer/config.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { planAsk } from "../src/planner/ask.ts";
import { planTask } from "../src/planner/planner.ts";
import { buildLookRequest } from "../src/tasks/pending.ts";
import { router1Request } from "../src/routing/judge.ts";
import { contextNow } from "../src/routing/context.ts";
import { freeze } from "../src/routing/routes.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { field, node, snap, text, value } from "./builders.ts";
import { minted } from "./minted.ts";
import { rng } from "./large-scene.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "caret-sc1-te-"));
beforeAll(() => {
  setGeneratorClock(() => 0);
  setTestVerifier(null);
});
afterAll(() => {
  setGeneratorClock(null);
  rmSync(dir, { recursive: true, force: true });
});

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const FORM_APP = { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" };
const P = "com.google.Chrome/standard";

describe("T-E1: a secure field", () => {
  it("is kept without its value, is never a fill field and never a candidate", () => {
    const m = new ScreenModel();
    const secret = "violet-orchard-seven";
    m.apply(snap([
      node("pw", "AXTextField", { label: "Sign-in", value: secret, editable: true, states: ["secure"] }),
      field("email", "", { label: "Email" }),
      field("name", "", { label: "Name" }),
    ], { at: 1000, windowId: "form", title: "Sign in", focused: true, focusedKey: "email" }));
    m.apply(snap([node("pw2", "AXSecureTextField", { label: "Vault", value: secret, editable: true }), text("t", "dana@lumen.example")], { at: 900, windowId: "src", title: "Source", app: NOTE_APP }));
    const w = m.windows.get("form") as WindowState;
    expect(w.nodes.get("pw")).toMatchObject({ excluded: "secure", label: "Sign-in" });
    expect(w.nodes.get("pw")?.value).toBeUndefined();
    expect(m.windows.get("src")?.nodes.get("pw2")).toMatchObject({ excluded: "secure" });
    expect(m.windows.get("src")?.nodes.get("pw2")?.value).toBeUndefined();
    expect(formFields(w, "email").map((n) => n.key)).not.toContain("pw");
    const cands = collectCandidates(m, "form", { now: 3000, ledger: new Disclosure(m.windows.values()) }).candidates;
    expect(cands.some((c) => c.text.includes(secret))).toBe(false);
    expect(JSON.stringify([...m.windows.values()].map((x) => [...x.nodes.values()]))).not.toContain(secret);
  });
});

const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = (): EngineSession => new EngineSession({ engine: "eng1", browser: CHROME, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({ id, key: `form[a]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#a", rect: [0, 0, 100, 20], ...extra });
const page = (frames: { origin: string; controls: PageControl[]; frameId?: number; parentFrameId?: number }[], focused: PageSnapshot["focused"] = null): PageSnapshot => ({
  type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
  frames: frames.map((f, i) => ({ frameId: f.frameId ?? i, parentFrameId: f.parentFrameId ?? (i === 0 ? -1 : 0), documentId: `D${i}`, origin: f.origin, path: "/apply", navGen: 1, title: "Apply", headings: [], iframes: [], excluded: {}, truncated: false, controls: f.controls })),
  missing: [],
  focused,
});

describe("T-E2: page controls the walker marks", () => {
  it.each(["password", "payment", "oneTimeCode"] as const)("a %s control arrives marked, without a value, and nothing targets it", (why) => {
    const m = new ScreenModel();
    // A value on a marked control would be the walker's bug; the helper still never keeps it.
    const s = toWindowSnapshot(page([{ origin: "https://shop.example", controls: [control("e1", "text", "Name", { value: "" }), control("e2", "text", "Secret field", { value: "4111 1111 1111 1111", excluded: why })] }], { frameId: 0, id: "e2", selection: null }), session(), 1);
    m.apply(s);
    const w = m.windows.get("page:eng1:7") as WindowState;
    const n = [...w.nodes.values()].find((x) => x.label === "Secret field");
    expect(n).toMatchObject({ excluded: why, states: ["focused", "secure"] });
    expect(n?.value).toBeUndefined();
    expect(w.focusedKey).toBe(n?.key);
    expect(formFields(w, [...w.nodes.values()].find((x) => x.label === "Name")?.key ?? "").map((x) => x.key)).not.toContain(n?.key);
  });

  it("no node of any fixture snapshot is both marked and valued, nor holds a value in a secret format", () => {
    const files = [join(here, "../fixtures/recorded"), join(here, "../fixtures/golden")].flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ndjson")).map((f) => join(d, f)));
    let snapshots = 0;
    for (const f of files) {
      const m = new ScreenModel();
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        let msg: unknown;
        try {
          msg = ReaderMessage.parse(JSON.parse(line));
        } catch {
          continue;
        }
        if ((msg as { type?: string }).type !== "snapshot") continue;
        m.apply(msg as Snapshot);
        snapshots++;
      }
      for (const w of m.windows.values()) {
        expect(excludedValue(w.window.title), f).toBeNull();
        for (const n of w.nodes.values()) {
          if (n.excluded !== undefined) expect(n.value, `${f} ${n.key}`).toBeUndefined();
          for (const t of [n.label, n.value, n.placeholder]) expect(excludedValue(t), `${f} ${n.key}`).toBeNull();
        }
      }
    }
    expect(snapshots).toBeGreaterThan(20);
  });
});

// MARK: - T-E3

const r = rng(301);
const pick = (alphabet: string, n: number): string => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function luhnComplete(prefix: string): string {
  for (let d = 0; d <= 9; d++) {
    const s = `${prefix}${d}`;
    let sum = 0;
    for (let i = s.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
      let x = s.charCodeAt(i) - 48;
      if (dbl) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
      sum += x;
    }
    if (sum % 10 === 0) return s;
  }
  throw new Error("unreachable");
}
function iban(country: string, bban: string): string {
  const moved = `${bban}${country}00`.replace(/[A-Z]/gu, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of moved) rem = (rem * 10 + Number(d)) % 97;
  const check = String(98 - rem).padStart(2, "0");
  return `${country}${check}${bban}`;
}
const spaced = (s: string, every: number, sep = " "): string => s.replace(new RegExp(`(.{${every}})(?!$)`, "gu"), `$1${sep}`);

/** Valid instances of each family; each must be withheld wherever it stands. */
const FAMILIES: Record<string, string[]> = {
  apiKey: [`sk_live_${pick(ALNUM, 24)}`, `sk-${pick(ALNUM, 40)}`, `ghp_${pick(ALNUM, 36)}`, `github_pat_${pick(ALNUM, 30)}`, `xoxb-${pick(ALNUM, 24)}`, `AKIA${pick(UPPER_DIGITS, 16)}`, `AIza${pick(ALNUM, 35)}`, `gsk_${pick(ALNUM, 30)}`],
  jwt: [`eyJ${pick(ALNUM, 20)}.${pick(ALNUM, 24)}.${pick(ALNUM, 16)}`],
  card: [13, 15, 16, 19].flatMap((len) => {
    const n = luhnComplete(`4${pick("0123456789", len - 2)}`);
    return len === 16 ? [n, spaced(n, 4), spaced(n, 4, "-")] : [n];
  }),
  ssn: ["219-09-9999", "078-05-1120"],
  iban: [iban("DE", `${pick("0123456789", 18)}`), spaced(iban("GB", `NWBK${pick("0123456789", 14)}`), 4)],
  pem: [`-----BEGIN RSA PRIVATE KEY-----\n${pick(ALNUM, 64)}\n${pick(ALNUM, 64)}\n-----END RSA PRIVATE KEY-----`],
  highEntropy: [pick(ALNUM, 32), `${pick(ALNUM, 20)}_${pick(ALNUM, 12)}`],
};
/** Pieces of an instance that must not reach the wire either: its digits run together, and each line of a block. */
const pieces = (x: string): string[] => [x, ...x.split("\n").filter((l) => l.length >= 12 && !l.startsWith("-----")), ...(/^[\d -]+$/u.test(x) ? [x.replace(/\D/gu, "")] : []), ...(/^[A-Z]{2}\d{2}/u.test(x) ? [x.replace(/ /gu, "")] : [])];

/** Near misses that must survive: phone numbers, order numbers that fail Luhn, dates, UUIDs, SHAs, tracking numbers, URLs. */
const NEAR_MISSES = [
  "(512) 555-0193", "+1 415 555 0162", "ORD-2026-48213", "4111 1111 1111 1112", "1234 5678 9012 3456", "2026-10-07", "Oct 7, 2026",
  "123e4567-e89b-12d3-a456-426614174000", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "1Z999AA10123456784", "94001118992233445566",
  "https://www.linkedin.com/in/dana-whitfield-42", "https://meet.example.com/day-4", "dana.whitfield@lumenlabs.example", "PO12 3456 7890",
];

describe("T-E3: values in a secret format, generated", () => {
  it("each family's instances are excluded values, and every near miss survives", () => {
    for (const [family, xs] of Object.entries(FAMILIES)) for (const x of xs) {
      expect(excludedValue(x), `${family}: ${x}`).not.toBeNull();
      expect(withholdValues(`before ${x} after`), family).toBe(`before ${WITHHELD} after`);
    }
    for (const x of NEAR_MISSES) expect(withholdValues(x), x).toBe(x);
    // The thresholds are assumed (exclude.ts); the test pins what they are so a change shows here.
    expect([HIGH_ENTROPY_CHARS, HIGH_ENTROPY_BITS]).toEqual([24, 4.0]);
  });

  const fetched: string[] = [];
  const stub: typeof fetch = async (_u, init) => {
    fetched.push(String(init?.body));
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, q.type === "noul" ? { type: "noul", noul: 0.97 } : { choice: Object.keys(q.criteria ?? {})[0] ?? "none", confidence: 0.95 }]));
    return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1 } }), { status: 200 });
  };
  const client = makeJevClient(() => "test-key", 10_000, new DailySpend({ dir, capUsd: 100 }), jevSettings({}), stub);
  const ask: AskJev = (req) => client(req);
  const settle = async (p: Promise<unknown>): Promise<void> => {
    try {
      await p;
    } catch {
      // A flow may refuse or ask back; only what reached the wire counts here.
    }
  };

  /** A note holding `x` in each position a window gives, beside a form; `x` also in the instruction and in memory. */
  async function flows(x: string): Promise<void> {
    const m = new ScreenModel();
    const lineKey = "te/line";
    m.apply(snap([
      field("te/note", `Rental notes\nName: Elena Vance\nKey ${x}\nEmail: elena.vance@example.com`, { role: "AXTextArea" }),
      text(lineKey, `Account: ${x}`),
      field("te/hint", "", { label: `Paste ${x} here`, placeholder: `e.g. ${x}` }),
    ], { at: 900, windowId: "note", title: `${x} — Notes`, app: NOTE_APP, focused: true, values: [value("id", x, lineKey), value("email", "elena.vance@example.com", "te/note")] }));
    const fields = ["Full name", "Email", "Reference"].map((l, i) => field(`${P}/textfield:${l.toLowerCase()}~0`, "", { parent: `${P}/webarea:~0`, label: l, frame: [100, 100 + 30 * i, 200, 20] }));
    m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }), ...fields], { at: 1000, windowId: "form", title: "Apply", app: FORM_APP, focused: true, focusedKey: `${P}/textfield:full name~0` }));
    const about = aboutValues([{ id: "about-1", fields: { label: "Reference", value: x, source: "typed" as const } }]);
    await settle(proposeFill(m, ask, "form", `${P}/textfield:full name~0`, 5000, { about }));
    await settle(planAsk(`put ${x} in Reference and my email in Email`, m, { values: () => [{ id: "about-1", label: "Reference", text: x, whose: "user" as const }] }, [{ id: "about-1", label: "Reference", value: x, kind: "id" as never }], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "te3", windowId: "form", now: 2000 }));
    await settle(planTask(`Set Reference to ${x}`, m, { values: () => [] }, { askJev: ask, offerKey: "te3-plan", now: 2000, rand: () => 0, windowId: "form" }));
    const w = m.windows.get("note") as WindowState;
    await settle(ask(buildLookRequest(w, m.windows.values(), [{ rule: "running", line: `Key ${x}` }] as never).req));
    const ctx = contextNow({ model: m, focus: null, host: null, readerSession: 1, memoryRevision: 0, settingsRevision: 0, hostBreaks: 0, candidates: [] });
    if (ctx !== null) {
      const built = router1Request(m, ctx, ["abstain", "write"], freeze(1, [], new Set()));
      if (built.outcome !== null) await settle(ask(built.outcome.request));
    }
    // Nothing of it stayed in the model either.
    for (const p of pieces(x)) expect(JSON.stringify([...m.windows.values()].map((v) => [v.window.title, [...v.nodes.values()], v.values]))).not.toContain(p);
  }

  for (const [family, xs] of Object.entries(FAMILIES)) {
    it(`${family}: no wire string of any builder holds an instance in any position`, async () => {
      for (const x of xs) {
        const before = fetched.length;
        await flows(x);
        const bodies = fetched.slice(before);
        expect(bodies.length, family).toBeGreaterThan(0);
        for (const b of bodies) for (const p of pieces(x)) expect(b.includes(p), `${family}: ${p}`).toBe(false);
      }
    });
  }
});

describe("T-E4: a control labelled with a sensitive kind", () => {
  const TRAILING = ["", "number", "no", "code", "id"];
  const cases: { label: string; where: "label" | "placeholder" | "group" }[] = [];
  for (const [, phrases] of LABEL_PHRASES) for (const p of phrases) for (const t of TRAILING) {
    if (t !== "" && p[p.length - 1] === t) continue;
    const label = [...p, ...(t === "" ? [] : [t])].join(" ");
    if (labelKind(label) === null) continue;
    for (const where of ["label", "placeholder", "group"] as const) cases.push({ label, where });
  }

  it("covers every phrase", () => expect(cases.length).toBeGreaterThan(150));

  it.each(cases)("$where '$label': the value is absent", ({ label, where }) => {
    const m = new ScreenModel();
    const v = "Robin Vale 2027";
    const control = where === "group"
      ? [node("g", "AXGroup", { label }), field("f", v, { parent: "g", label: "Value" })]
      : [field("f", v, where === "label" ? { label } : { label: "Value", placeholder: label })];
    m.apply(snap(control, { at: 1000, windowId: "w" }));
    const n = m.windows.get("w")?.nodes.get("f");
    expect(n?.value).toBeUndefined();
    expect(n?.excluded).toBe(labelKind(label));
  });

  it.each(["Password hint", "PIN code reminder", "Card type", "Number of attendees", "Account holder"])("'%s' keeps its value", (label) => {
    const m = new ScreenModel();
    m.apply(snap([field("f", "Robin Vale", { label })], { at: 1000, windowId: "w" }));
    expect(m.windows.get("w")?.nodes.get("f")).toMatchObject({ value: "Robin Vale" });
    expect(m.windows.get("w")?.nodes.get("f")?.excluded).toBeUndefined();
  });
});

describe("T-E5: apps and sites switched off", () => {
  it("the helper's default deny list is the reader's, word for word", () => {
    const swift = readFileSync(join(here, "../../apps/screen-reader/Sources/CaretScreenAX/ScreenReader.swift"), "utf8");
    const block = /static let defaults = \[([\s\S]*?)\]/u.exec(swift)?.[1] ?? "";
    expect([...block.matchAll(/"([^"]+)"/gu)].map((x) => x[1])).toEqual([...DEFAULT_APPS_OFF]);
  });

  const line = "Vault item: Lumen staging, user dana";
  it("a window of an app switched off never enters the model, and one already there closes", () => {
    const m = new ScreenModel();
    const vault = { pid: 8100, bundleId: "com.1password.1password", name: "1Password" };
    expect(m.apply(snap([text("t", line)], { at: 1000, windowId: "vault", app: vault }))).toEqual([]);
    expect(m.windows.has("vault")).toBe(false);
    const other = { pid: 8200, bundleId: "dev.caret.vault", name: "Vault" };
    m.apply(snap([text("t", line)], { at: 1000, windowId: "v2", app: other }));
    expect(m.windows.has("v2")).toBe(true);
    m.setAppsOff([...DEFAULT_APPS_OFF, "dev.caret.vault"], 1100);
    expect(m.windows.has("v2")).toBe(false);
    m.apply(snap([text("t", line)], { at: 1200, windowId: "v2", app: other }));
    expect(m.windows.has("v2")).toBe(false);
  });

  it("a frame at a site switched off never enters the model, and no request names it or carries its text", async () => {
    const s = session();
    s.sitesOff(["https://vault.example"]);
    const m = new ScreenModel();
    m.apply(snap([field("te/note", "Name: Elena Vance", { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Notes.txt", app: NOTE_APP }));
    m.apply(toWindowSnapshot(page([
      { origin: "https://apply.example", controls: [control("e1", "text", "Name", { value: "" })] },
      { origin: "https://vault.example", controls: [control("e2", "text", line, { value: line })] },
    ], { frameId: 0, id: "e1", selection: null }), s, 1));
    const w = m.windows.get("page:eng1:7") as WindowState;
    expect(JSON.stringify([...w.nodes.values()])).not.toContain(line);
    const sent: JevRequest[] = [];
    const recording: AskJev = async (req) => {
      sent.push(req);
      return { model: "jev-test", answers: {}, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await proposeFill(m, recording, "page:eng1:7", [...w.nodes.values()].find((n) => n.label === "Name")?.key ?? "", 5000).catch(() => undefined);
    expect(sent.length).toBeGreaterThan(0);
    for (const req of sent) {
      expect(JSON.stringify([req.state, req.questions])).not.toContain("Vault item");
      expect(Object.keys(req.charged).every((id) => id !== "vault")).toBe(true);
    }
  });
});

describe("T-E6: providers that keep what they are sent", () => {
  const req = minted({ purpose: "probe.latency" as const, state: "fixture", questions: { q: { type: "choice" as const, instructions: "Pick", criteria: { a: "A", b: "B" } } }, snippets: [], charged: {} });

  it("the Jev client refuses Laya outside an evaluation, before any fetch", async () => {
    let fetches = 0;
    const laya = jevSettings({ CARET_JEV_PROVIDER: "gateway", CARET_JEV_MODEL: "convaiinnovations/laya-free" });
    expect(jevPolicy(laya).retains).toBe(true);
    const c = makeJevClient(() => "key", 1000, new DailySpend({ dir, capUsd: 1 }), laya, async () => (fetches++, new Response("{}")));
    await expect(c(req)).rejects.toBeInstanceOf(JevGatewayPolicyError);
    expect(fetches).toBe(0);
  });

  it("the writer port refuses a route whose provider retains, before reading its key, unless it is an evaluation", async () => {
    let keys = 0;
    const retains = () => ({ retains: true, verified: false as const, source: "test" });
    const route = gatewayRoute("openai/gpt-oss-120b");
    const write = { kind: "plan" as const, disclosureId: "te6", input: { goal: "Sign me up", snapshots: [] }, maxOutputTokens: 8, signal: new AbortController().signal };
    await expect(makeWriterPort(route, { policy: retains, key: () => (keys++, "k") }).write(minted(write))).rejects.toBeInstanceOf(WriterProviderRefused);
    expect(keys).toBe(0);
    // In an evaluation the policy lets it through to the input's schema (which this fixture input does not meet).
    const e = await makeWriterPort(route, { policy: retains, evaluation: true, key: () => (keys++, "k") }).write(minted(write)).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(WriterProviderRefused);
    expect(keys).toBe(0);
  });

  it("every provider flag is as the code had it, and labelled unverified", () => {
    for (const p of [jevPolicy(jevSettings({})), jevPolicy(jevSettings({ CARET_JEV_PROVIDER: "gateway" })), writerPolicy(GROQ_QWEN_3_8_27B), writerPolicy(gatewayRoute("poolside/laguna-s-2.1-free"))]) {
      expect(p).toMatchObject({ retains: false, verified: false });
      expect(p.source).toMatch(/^unverified/u);
    }
  });
});

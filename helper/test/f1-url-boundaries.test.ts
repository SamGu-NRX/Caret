import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { mintOf, proposeFill } from "../src/fill/fill.ts";
import { fieldContract, setTestVerifier } from "../src/fill/contract.ts";
import { formatForField } from "../src/fill/field-format.ts";
import { lowerGoal } from "../src/goals/lower.ts";
import type { GoalInventory, TargetBinding, ValueBinding } from "../src/goals/plan.ts";
import type { DraftPlan } from "../src/codemode/types.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { inventoryLedger } from "./minted.ts";

const WIN = "5150-7";
const KEY = "com.google.Chrome/standard/github";
const SAFE = "com.google.Chrome/standard/reference";
const WRONG = "https://github.com/harperq-data";
afterEach(() => setTestVerifier(STAND_IN));
const requestText = (value: unknown): string => typeof value === "string" ? value : value !== null && typeof value === "object" ? Object.values(value).map(requestText).join("\n") : "";

async function throughGoal(token: string, wanted = WRONG, typed: boolean | string = false, options: { source?: string; label?: string; role?: string; refuse?: boolean } = {}) {
  const model = new ScreenModel();
  const label = options.label ?? "GitHub URL";
  const source = options.source ?? `GitHub: ${token}`;
  model.apply(snap([field("source", source, { role: options.role ?? "AXTextArea" }), field("safe", "Reference: REF-42", { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title: "Notes", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, ...(typed ? { values: [{ kind: "url", text: typeof typed === "string" ? typed : "github.com/harperq-data", nodeKey: "source" }] } : {}) }));
  model.apply(snap([
    { key: "web", parent: null, role: "AXWebArea", label: "Form" },
    field(KEY, "", { parent: "web", label, ...(label === "GitHub URL" ? { inputKind: "url" as const } : {}), frame: [10, 10, 200, 20] }),
    field(SAFE, "", { parent: "web", label: "Reference", frame: [10, 40, 200, 20] }),
  ], { at: 2000, windowId: WIN, title: "Form", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
  const offered: string[] = [];
  const verify: string[] = [];
  setTestVerifier(async (req) => {
    const text = requestText(req);
    if (text.includes(wanted)) verify.push(text);
    if (options.refuse) return { model: "part", answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: requestText(q).includes(wanted) ? "part" : "exact", confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    return STAND_IN(req);
  });
  const picker = jevPickingText((_id, ins) => ins.includes("'Reference'") ? "REF-42" : wanted);
  const p = await proposeFill(model, async (req) => {
    for (const q of Object.values(req.questions)) if (String(q.instructions).includes(`'${label}'`)) for (const text of Object.values(q.criteria)) if (text !== null) offered.push(text);
    return picker(req);
  }, WIN, KEY, 3000, { authority: { kind: "goal", goalId: "g" } });
  const domain = { kind: "window" as const, windowId: WIN, pid: 5150, bundleId: "com.google.Chrome", appName: "Google Chrome", title: "Form", number: null, windowKind: "standard", page: false };
  const targets: TargetBinding[] = p.fields.map((f, i) => ({ ref: `t${i}`, domain, key: f.key, role: "AXTextField", label: f.key === KEY ? label : "Reference", own: f.key === KEY ? label : "Reference", placeholder: null, control: "text", value: "", options: null, field: fieldContract(model.windows.get(WIN)!, model.windows.get(WIN)!.nodes.get(f.key)!) }));
  const values: ValueBinding[] = [];
  const steps: DraftPlan["steps"] = [];
  for (const [i, f] of p.fields.entries()) {
    const checked = mintOf(f);
    if (f.value === null || checked === undefined) continue;
    const ref = `v${i}`;
    values.push({ ref, text: f.value, display: f.value, origin: { kind: "derived", inputs: [], resolver: "fill", version: "1", parametersDigest: "p" }, source: { windowId: "7001-1", key: "source", revision: "r" }, memory: null, event: null, draft: null, owner: null, provenance: checked.provenance, checked });
    steps.push({ ref: `s${i}`, kind: "fill", target: `t${i}`, value: ref });
  }
  const inventory: GoalInventory = { readerSession: 1, targets: new Map(targets.map((t) => [t.ref, t])), values: new Map(values.map((v) => [v.ref, v])), revisions: new Map(), documents: new Map(), windowRefs: new Map(), texts: new Map(), owed: new Map() };
  const goal = await lowerGoal("g", "fill GitHub URL and Reference", { basedOn: "s1", window: "w1", steps, choices: [], drafts: [], programDigest: "b".repeat(64) }, inventory, { askJev: STAND_IN, ledger: inventoryLedger(inventory) });
  return { p, offered, verify, writes: goal.segments.flatMap((s) => s.steps).filter((s) => s.kind === "write") };
}

// These are extraction results from 1872a37, not promises that the shorter span is an exact answer.
const reviewed = [
  ["gist.github.com/harperq-data", "github.com/harperq-data"],
  ["profiles.github.com/harperq-data", "github.com/harperq-data"],
  ["evil.example/github.com/harperq-data", "github.com/harperq-data"],
  ["GITHUB.COM/harperq-data", "GITHUB.COM/harperq-data"],
  ["égithub.com/harperq-data", "github.com/harperq-data"],
  ["evil.example?next=github.com/harperq-data", "github.com/harperq-data"],
  ["evil.example#github.com/harperq-data", "github.com/harperq-data"],
  ["evil.example/https://github.com/harperq-data", WRONG],
  ["evil.example/www.github.com/harperq-data", "www.github.com/harperq-data"],
  ["profiles.www.example.com/person", "www.example.com/person"],
  ["evil.example/linkedin.com/in/harperq-data", "linkedin.com/in/harperq-data"],
  ["github.com/harperq-data?filter[role]=engineer", "github.com/harperq-data?filter[role]=engineer"],
  ["github.com/harperq-data?next=x", "github.com/harperq-data?next=x"],
  ["github.com/harperq-data#bio", "github.com/harperq-data#bio"],
  ["github.com/harperq-data/repository", "github.com/harperq-data/repository"],
  ["https://user@github.com/harperq-data", "https://user@github.com/harperq-data"],
  ["https://[::1]/profile", "https://[::1]/profile"],
] as const;

describe("reviewed URL spans carry raw evidence instead of new extraction rules", () => {
  it.each(reviewed)("F1 refuses %s and the verifier reads the raw token beside %s", async (raw, extracted) => {
    const f1 = await throughGoal(raw);
    expect(f1.offered.some((s) => s.includes("value in the field's format"))).toBe(false);
    expect(f1.writes.some((s) => s.checked?.provenance.kind === "derived" && s.checked.provenance.how === "fieldFormat")).toBe(false);
    expect(formatForField(extracted, ["GitHub URL"], "url", `GitHub: ${raw}`)).toBeNull();

    const r = await throughGoal(raw, extracted, false, { label: "Notes", refuse: true });
    expect(r.offered.some((s) => s.startsWith(`"${extracted}"`))).toBe(true);
    expect(r.verify).toHaveLength(2);
    for (const request of r.verify) {
      expect(request).toContain(raw);
      expect(request).toContain(extracted);
    }
    expect(r.p.fields.find((f) => f.key === KEY)?.value).toBeNull();
    expect(r.writes.some((s) => s.writes === extracted)).toBe(false);
    expect(r.writes.some((s) => s.writes === "REF-42")).toBe(true);
  });

  it.each([
    ["evil.example?next=https://github.com/harperq-data", WRONG],
    ["profiles.www.example.com/person", "www.example.com/person"],
    ["evil.example#www.github.com/harperq-data", "www.github.com/harperq-data"],
  ])("reader spans also carry all of %s", async (raw, extracted) => {
    const r = await throughGoal(raw, extracted, extracted, { label: "Notes", refuse: true });
    expect(r.verify).toHaveLength(2);
    for (const request of r.verify) expect(request).toContain(raw);
    expect(r.writes.some((s) => s.writes === extracted)).toBe(false);
  });

  it("keeps the raw token in base provenance when the verifier approves an extracted span", async () => {
    const raw = "evil.example?next=https://github.com/harperq-data";
    const r = await throughGoal(raw, WRONG, false, { label: "Notes" });
    const checked = r.writes.find((s) => s.writes === WRONG)?.checked;
    expect(checked?.provenance).toMatchObject({ kind: "window", span: WRONG, line: raw });
    expect(r.verify).toHaveLength(2);
    for (const request of r.verify) expect(request).toContain(raw);
  });
});

describe("1872a37 URL coverage", () => {
  it.each([
    ["Website:https://example.com/profile", "https://example.com/profile", false, "AXTextArea"],
    ["a@example.net,https://example.com/profile", "https://example.com/profile", false, "AXTextArea"],
    ["example.org/profile", "example.org/profile", "example.org/profile", "AXButton"],
    ["https://example.com/profile,", "https://example.com/profile", false, "AXTextArea"],
    ["https://example.com/profile.", "https://example.com/profile", false, "AXTextArea"],
    ["https://[::1]/profile", "https://[::1]/profile", false, "AXTextArea"],
  ] as const)("offers %s with raw evidence, including reader-only roles", async (raw, extracted, typed, role) => {
    const r = await throughGoal(raw, extracted, typed, { source: raw, label: "Notes", role });
    expect(r.p.fields.find((f) => f.key === KEY)?.value).toBe(extracted);
    expect(r.writes.some((s) => s.writes === extracted)).toBe(true);
    expect(r.verify).toHaveLength(2);
    for (const request of r.verify) expect(request).toContain(raw);
    expect(r.writes.find((s) => s.writes === extracted)?.checked?.provenance).toMatchObject({ kind: "window", line: raw });
  });
});

describe("scan end and evidence budget", () => {
  it.each([false, "https://example.com/profile"] as const)("does not re-extract a token touching the 4000-character slice, reader=%s", async (typed) => {
    const value = "https://example.com/profile";
    const source = `${"x".repeat(4000 - value.length - 1)} ${value}THIS-IS-STILL-THE-SAME-TOKEN`;
    const r = await throughGoal(value, value, typed, { source, label: "Notes" });
    expect(r.offered.some((s) => s.startsWith(`"${value}"`))).toBe(false);
    expect(r.verify).toHaveLength(0);
    expect(r.writes.some((s) => s.writes === value)).toBe(false);
  });

  it("withholds an extracted URL when its full raw token cannot fit the evidence budget", async () => {
    const value = "https://example.com/profile";
    const raw = `${"x".repeat(1500)}/${value}`;
    const r = await throughGoal(raw, value, false, { label: "Notes" });
    expect(r.offered.some((s) => s.startsWith(`"${value}"`))).toBe(false);
    expect(r.verify).toHaveLength(0);
    expect(r.writes.some((s) => s.writes === value)).toBe(false);
  });
});

describe("strict GitHub profiles", () => {
  it.each([
    "github.com/harperq-data", "github.com/harperq-data/", "github.com/harperq-data.",
    "github.com/harperq-data,", "github.com/harperq-data)", "(github.com/harperq-data)",
    "<github.com/harperq-data>", "[github.com/harperq-data]", '"github.com/harperq-data"',
    "'github.com/harperq-data'", "[profile](github.com/harperq-data)",
  ])("formats only the profile shape in %s, keeping the raw token in both wordings", async (raw) => {
    const value = raw.includes("data/") ? `${WRONG}/` : WRONG;
    const r = await throughGoal(raw, value);
    expect(r.p.fields.find((f) => f.key === KEY)?.value).toBe(value);
    expect(r.verify).toHaveLength(2);
    for (const request of r.verify) expect(request).toContain(raw);
    expect(r.writes.find((s) => s.writes === value)?.checked?.provenance).toMatchObject({ kind: "derived", how: "fieldFormat", base: { kind: "window", span: raw, line: raw } });
  });

  it.each([
    "github.com/a_b", "github.com/a--b", "github.com/-abc", "github.com/abc-", "github.com/a.b",
    `github.com/${"a".repeat(40)}`, "github.com/a/b", "github.com/a?query=b", "github.com/a#bio",
    "github.com/a[role]", "github.com@evil.example/a", "((github.com/abc))", "http://github.com/abc",
  ])("refuses unsupported profile syntax %s", async (raw) => {
    const r = await throughGoal(raw);
    expect(r.offered.some((s) => s.includes("value in the field's format"))).toBe(false);
    expect(formatForField(raw, ["GitHub URL"], "url", raw)).toBeNull();
  });

  it("accepts the 39-character username limit and does not replace a supplied HTTPS scheme", () => {
    const token = `github.com/${"A".repeat(39)}`;
    expect(formatForField(token, ["GitHub URL"], "url", token)?.value).toBe(`https://${token}`);
    expect(formatForField("https://github.com/abc", ["GitHub URL"], "url", "https://github.com/abc")).toBeNull();
  });
});

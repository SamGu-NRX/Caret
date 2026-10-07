import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { mintOf, proposeFill } from "../src/fill/fill.ts";
import { fieldContract, setTestVerifier } from "../src/fill/contract.ts";
import { lineValues } from "../src/fill/line-values.ts";
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

async function throughGoal(token: string, wanted = WRONG, typed = false) {
  const model = new ScreenModel();
  const source = `GitHub: ${token}\nReference: REF-42`;
  model.apply(snap([field("source", source, { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title: "Notes", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, ...(typed ? { values: [{ kind: "url", text: "github.com/harperq-data", nodeKey: "source" }] } : {}) }));
  model.apply(snap([
    { key: "web", parent: null, role: "AXWebArea", label: "Form" },
    field(KEY, "", { parent: "web", label: "GitHub URL", inputKind: "url", frame: [10, 10, 200, 20] }),
    field(SAFE, "", { parent: "web", label: "Reference", frame: [10, 40, 200, 20] }),
  ], { at: 2000, windowId: WIN, title: "Form", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
  const offered: string[] = [];
  const verify: string[] = [];
  setTestVerifier(async (req) => {
    verify.push(JSON.stringify(req));
    return STAND_IN(req);
  });
  const picker = jevPickingText((_id, ins) => ins.includes("'Reference'") ? "REF-42" : wanted);
  const p = await proposeFill(model, async (req) => {
    for (const q of Object.values(req.questions)) if (String(q.instructions).includes("'GitHub URL'")) for (const text of Object.values(q.criteria)) if (text !== null) offered.push(text);
    return picker(req);
  }, WIN, KEY, 3000, { authority: { kind: "goal", goalId: "g" } });
  const domain = { kind: "window" as const, windowId: WIN, pid: 5150, bundleId: "com.google.Chrome", appName: "Google Chrome", title: "Form", number: null, windowKind: "standard", page: false };
  const targets: TargetBinding[] = p.fields.map((f, i) => ({ ref: `t${i}`, domain, key: f.key, role: "AXTextField", label: f.key === KEY ? "GitHub URL" : "Reference", own: f.key === KEY ? "GitHub URL" : "Reference", placeholder: null, control: "text", value: "", options: null, field: fieldContract(model.windows.get(WIN)!, model.windows.get(WIN)!.nodes.get(f.key)!) }));
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

describe("F1 complete URL tokens through fill and goal lowering", () => {
  it.each([
    "gist.github.com/harperq-data",
    "profiles.github.com/harperq-data",
    "evil.example/github.com/harperq-data",
    "GITHUB.COM/harperq-data",
    "github.com/harperq-data.",
  ])("never offers or mints the truncated conversion of %s", async (token) => {
    const r = await throughGoal(token);
    const f = r.p.fields.find((f) => f.key === KEY)!;
    expect({ offered: r.offered.some((text) => text.startsWith(`"${WRONG}"`)), value: f.value, minted: mintOf(f) !== undefined, loweredWrong: r.writes.some((s) => s.writes === WRONG) }).toEqual({ offered: false, value: null, minted: false, loweredWrong: false });
    expect(r.writes.some((s) => s.writes === "REF-42")).toBe(true);
  });

  it.each(["gist.github.com/harperq-data", "evil.example/github.com/harperq-data", "github.com/harperq-data."])("does not trust a reader's partial URL typed value inside %s", async (token) => {
    const r = await throughGoal(token, WRONG, true);
    expect(r.offered.some((text) => text.startsWith(`"${WRONG}"`))).toBe(false);
    expect(r.writes.some((s) => s.writes === WRONG)).toBe(false);
  });

  it("withholds when a reader span could refer to either a complete token or a hostname suffix in the same node", async () => {
    const r = await throughGoal("github.com/harperq-data\nOther: gist.github.com/harperq-data", WRONG, true);
    expect(r.offered.some((text) => text.startsWith(`"${WRONG}"`))).toBe(false);
    expect(r.writes.some((s) => s.writes === WRONG)).toBe(false);
  });

  it.each([
    ["profiles.www.example.com/person", "www.example.com/person"],
    ["evil.example/www.github.com/harperq-data", "www.github.com/harperq-data"],
    ["evil.example/https://github.com/harperq-data", WRONG],
  ])("non-F1 URL picks also refuse a truncated source %s", async (token, wanted) => {
    const r = await throughGoal(token, wanted);
    const f = r.p.fields.find((f) => f.key === KEY)!;
    expect({ value: f.value, minted: mintOf(f) !== undefined, loweredWrong: r.writes.some((s) => s.writes === wanted) }).toEqual({ value: null, minted: false, loweredWrong: false });
  });

  it.each(["github.com/harperq-data", "GITHUB.COM/harperq-data"])("preserves the full source token %s in both verifier wordings and the lowered goal", async (token) => {
    const value = `https://${token}`;
    const r = await throughGoal(token, value);
    expect(r.p.fields.find((f) => f.key === KEY)?.value).toBe(value);
    expect(r.verify).toHaveLength(2);
    for (const request of r.verify) expect(request).toContain(token);
    const checked = r.writes.find((s) => s.writes === value)?.checked;
    expect(checked?.verdict.by).toBe("verifier");
    expect(checked?.provenance).toMatchObject({ kind: "derived", how: "fieldFormat", base: { kind: "window", span: token } });
  });
});

describe("URL extraction before F1", () => {
  it.each([
    "gist.github.com/harperq-data",
    "profiles.github.com/harperq-data",
    "evil.example/github.com/harperq-data",
    "evil.example/www.github.com/harperq-data",
    "evil.example/https://github.com/harperq-data",
    "profiles.www.example.com/person",
    "evil.example/linkedin.com/in/harperq-data",
  ])("does not extract a URL substring from %s", (token) => {
    expect(lineValues(`Profile: ${token}`).filter((v) => v.kind === "url")).toEqual([]);
  });

  it("retains a trailing dot in the complete source token", () => {
    expect(lineValues("GitHub: github.com/harperq-data.").filter((v) => v.kind === "url").map((v) => v.text)).toEqual(["github.com/harperq-data."]);
  });
});

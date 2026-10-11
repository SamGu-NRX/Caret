// I2: where A3's scope ask (planner/intent-heads.ts) meets G2's disclosure rule and W1's canned dispatch. A3 added a
// request that quotes each field's label, heading, group and neighbours; G2's rule is that screen text holding a secret
// marker word is sent as what it is, never as its words (planner/intent.ts snapMint). SC1 retired G2's wire check for
// those words: the client's last check is for formats (privacy.ts assertNoExcludedValue), and the request is sealed by
// its Disclosure (privacy/disclosure.ts), which mints only text the redacted view keeps. W1's canned engines answer by each request's purpose, so the new request must name one.
import { describe, expect, it } from "vitest";
import { assertNoExcludedValue } from "../src/privacy.ts";
import { secretText } from "../src/memory/sensitive.ts";
import { questionKind } from "../src/engines/decide/canned.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, scopeId, scopeRequest } from "../src/planner/intent-heads.ts";
import { AskAsks, AskRefused, planAsk } from "../src/planner/ask.ts";
import { SAYS } from "../src/planner/says.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { ScreenModel } from "../src/model.ts";
import { field, node, scopeLabel, snap } from "./builders.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Snapshot } from "../src/protocol.ts";
import { buildDesk, loadCorpus } from "../scripts/realfill-corpus.ts";
import { rng } from "./large-scene.ts";

const SECRET_LABEL = "Password hint";
const SECRET_HEADING = "Account PIN";

function form() {
  const m = new ScreenModel();
  m.apply(
    snap(
      [
        node("pg/h", "AXHeading", { label: SECRET_HEADING }),
        field("pg/email", "", { label: "Email" }),
        field("pg/hint", "", { label: SECRET_LABEL }),
        field("pg/name", "", { label: "Full name" }),
      ],
      { at: 1000, windowId: "page:i2:1", kind: "page", focused: true, title: "Sign up" },
    ),
  );
  const w = m.windows.get("page:i2:1");
  if (w === undefined) throw new Error("no page");
  return intentSnapshot("put my name and email in", m, w, []);
}

describe("A3's scope ask under G2's disclosure rule", () => {
  it("the fixture's label and heading are ones G2 calls secret", () => {
    expect(secretText(SECRET_LABEL)).toBe(true);
    expect(secretText(SECRET_HEADING)).toBe(true);
  });

  it("sends neither a secret label nor a secret heading, as a field's own text or as a neighbour's, in either wording", () => {
    const s = form();
    expect(s.fields.map((f) => f.name)).toContain(SECRET_LABEL);
    for (const w of [0, 1] as const) {
      const req = scopeRequest(s, w);
      const sent = JSON.stringify([req.state, req.questions]);
      expect(sent, `wording ${w}`).not.toContain(SECRET_LABEL);
      expect(sent, `wording ${w}`).not.toContain(SECRET_HEADING);
      expect(() => assertNoExcludedValue(req)).not.toThrow();
      // The field is still asked about, named as what it is.
      const hint = s.fields.find((f) => f.name === SECRET_LABEL);
      expect(String(req.questions[scopeId(hint?.ref ?? "")]?.instructions)).toContain("a field Caret leaves to the user");
      // The form's outline names it the same way.
      const outline = (req.state as unknown as { form: { sections: { fields: string[] }[] } }).form;
      expect(outline.sections.flatMap((x) => x.fields)).toContain("a field Caret leaves to the user");
    }
  });

  it("the heads request passes the client's checks with its refuse wording, which names kinds of secret", () => {
    const req = headsRequest(form());
    expect(Object.values(req.questions.route?.criteria ?? {}).some((t) => secretText(t))).toBe(true);
    expect(() => assertNoExcludedValue(req)).not.toThrow();
    expect(JSON.stringify(req.state)).not.toContain(SECRET_LABEL);
  });

  it("names a purpose on both requests, and every id they ask has a canned kind", () => {
    const s = form();
    const heads = headsRequest(s);
    const scopes = [scopeRequest(s, 0), scopeRequest(s, 1)];
    expect(heads.purpose).toBe("ask.heads");
    for (const r of scopes) expect(r.purpose).toBe("ask.scope");
    expect(Object.keys(heads.questions).map((id) => questionKind(heads, id)).sort()).toEqual(["ask.heads:route", "ask.heads:source", "ask.heads:whose", "ask.heads:why"]);
    for (const r of scopes) for (const id of Object.keys(r.questions)) expect(questionKind(r, id)).toBe(id === "section" ? "ask.scope:section" : "ask.scope:field");
  });
});

describe("a native plan from Jev's scope ask writes only the fields Jev chose (I2 review of the A3 merge)", () => {
  const MEMORY = [
    { id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const },
    { id: "about-2", label: "Email", text: "elena.vance@example.com", whose: "user" as const },
  ];
  const VALUES: Record<string, string> = { Name: "Elena Vance", Email: "elena.vance@example.com" };
  const desk = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(
      snap([field("sf/name", "", { label: "Name", frame: [10, 10, 200, 20] }), field("sf/email", "", { label: "Email", frame: [10, 40, 200, 20] }), node("sf/submit", "AXButton", { label: "Submit", frame: [10, 70, 80, 20] })], {
        at: 1000,
        windowId: "signup",
        title: "Sign up",
        app: { pid: 7100, bundleId: "com.example.signup", name: "Signup" },
        focused: true,
        focusedKey: "sf/name",
      }),
    );
    return m;
  };
  /** Heads say plan; the scope ask says asks for `asks`, unclear for `unclear`, not for the rest; the planner takes every value it is offered. */
  const jev = (asks: readonly string[], unclear: readonly string[] = []): AskJev => async (req: JevRequest) => ({
    model: "jev-test",
    inputTokens: 1,
    latencyMs: 1,
    costUsd: 0,
    answers: Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        const pick = (choice: string) => [id, { choice, confidence: 0.95 }] as const;
        if (req.purpose === "ask.heads") return pick({ route: "plan", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
        if (id === "section") return pick("fields");
        if (req.purpose === "ask.scope") {
          const label = scopeLabel(ins);
          return pick(unclear.includes(label) ? "unclear" : asks.includes(label) ? "asks" : "not");
        }
        if (id === "press") return pick(Object.entries(q.criteria).find(([, d]) => /Submit/u.test(String(d)))?.[0] ?? "none");
        const want = Object.entries(VALUES).find(([label]) => ins.includes(`'${label}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => String(d).startsWith(`"${want}"`));
        if (hit !== undefined) return pick(hit[0]);
        if ("yes" in q.criteria) return pick("yes");
        if ("user" in q.criteria) return pick("user");
        return pick(Object.keys(q.criteria).at(-1) ?? "none");
      }),
    ),
  });
  const go = (ask: AskJev, resume?: Parameters<typeof planAsk>[4]["resume"], instruction = "fill the form and submit") => planAsk(instruction, desk(), { values: () => MEMORY }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "i2n", windowId: "signup", now: 2000, ...(resume === undefined ? {} : { resume }) });

  it("writes Name and not Email when Jev chose only Name", async () => {
    const d = await go(jev(["Name"]));
    expect(d.route).toBe("plan");
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([["sf/name", "Elena Vance"]]);
  });

  it("refuses, writing nothing, when Jev left Email unclear on an instruction that presses (no question is asked about a press)", async () => {
    const e = await go(jev(["Name"], ["Email"])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).message).toBe(SAYS.whichFields);
  });

  // I3 lead ruling: Name, which Jev chose, is written whatever the pick; the question asks about Email alone.
  it("asks first when Jev left Email unclear, offering Email beside the chosen Name, and a pick adds to Name", async () => {
    const plain = "put my details in and tidy the form up";
    const e = await go(jev(["Name"], ["Email"]), undefined, plain).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    expect(q.part).toBe("fields");
    expect(q.options.map((c) => (c.option.kind === "field" ? c.option.label : c.option.kind))).toEqual(["Email"]);
    expect(q.text).toBe("Caret will fill Name. Which of these should it fill too?");
    const email = q.options.find((c) => c.option.kind === "field" && c.option.label === "Email");
    if (email === undefined) throw new Error("no Email option");
    const after = await go(jev(["Name"], ["Email"]), { ...q.resume, fixed: { ...q.resume.fixed, ...email.fixes } }, plain);
    expect(after.checked.writes.map((w) => [w.node.key, w.value])).toEqual([["sf/name", "Elena Vance"], ["sf/email", "elena.vance@example.com"]]);
  });

  it("plans no write when Jev chose no field, so a press alone is said as the user's (B26 decision 3), not asked about", async () => {
    const e = await go(jev([])).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(AskAsks);
    expect(String((e as Error).message)).toMatch(/yours/iu);
  });
});

describe("property: no native plan writes a field outside Jev's selection (I2)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
  const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

  it("on every corpus form, with random selections and a planner Jev that takes any value it is offered", async () => {
    const draw = rng(20261007);
    let plans = 0;
    let writes = 0;
    for (const form of corpus.forms) {
      for (let round = 0; round < 4; round++) {
        const d = buildDesk(corpus, snaps, form);
        const instruction = "fill out this form";
        const s = intentSnapshot(instruction, d.model, d.form, d.memory);
        const chosen = new Set(s.fields.filter(() => draw() < 0.35).map((f) => f.ref));
        const ask: AskJev = async (req) => ({
          model: "adversary",
          inputTokens: 1,
          latencyMs: 1,
          costUsd: 0,
          answers: Object.fromEntries(
            Object.entries(req.questions).map(([id, q]) => {
              const keys = Object.keys(q.criteria);
              const pick = (choice: string) => [id, { choice, confidence: 0.99 }] as const;
              if (req.purpose === "ask.heads") return pick({ route: "plan", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
              if (id === "section") return pick("fields");
              if (req.purpose === "ask.scope") return pick(chosen.has(id.slice(2)) ? "asks" : "not");
              if (id === "press") return pick("none" in q.criteria ? "none" : (keys.at(-1) ?? "none"));
              if ("yes" in q.criteria) return pick("yes");
              if ("user" in q.criteria) return pick("user");
              // Any offered value, never keep: the widest plan the planner could be talked into.
              return pick(keys.find((k) => k !== "keep" && k !== "none") ?? keys[0] ?? "none");
            }),
          ),
        });
        const allowed = new Set(s.fields.filter((f) => chosen.has(f.ref)).map((f) => f.key));
        const r = await planAsk(instruction, d.model, { values: () => d.memory }, d.about, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: `prop-${form.id}-${round}`, windowId: d.form.window.windowId, now: 2000, rand: () => 0 }).catch((e: unknown) => {
          if (e instanceof Error && /does not hold/u.test(e.message)) throw e;
          return null;
        });
        if (r === null || !("checked" in r)) continue;
        plans++;
        for (const w of r.checked.writes) {
          writes++;
          expect(allowed.has(w.node.key), `${form.id} round ${round}: ${w.node.key}`).toBe(true);
        }
      }
    }
    // The property was exercised, not vacuously true.
    expect(plans).toBeGreaterThan(5);
    expect(writes).toBeGreaterThan(5);
  }, 120_000);
});

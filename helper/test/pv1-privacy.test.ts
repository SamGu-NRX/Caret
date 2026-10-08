import { beforeEach as vercelBeforeEach, afterEach as vercelAfterEach, vi as vercelVi } from "vitest";
import { Disclosure, UnmintedText } from "../src/privacy/disclosure.ts";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { describeField, nearestText } from "../src/fill/descriptor.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { intentInput, jevIntentMaker } from "../src/planner/intent-makers.ts";
import { valueList } from "../src/planner/codeplan.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { macClock } from "../src/offers/event-time.ts";
import { headsRequest, scopeRequest } from "../src/planner/intent-heads.ts";
import { instructionForModel } from "../src/fill/redact.ts";
import { localTargets } from "../src/planner/targets.ts";
import { planAsk } from "../src/planner/ask.ts";
import { askAttend } from "../src/offers/event-card.ts";
import { router1Request } from "../src/routing/judge.ts";
import { freeze } from "../src/routing/routes.ts";
import { contextNow } from "../src/routing/context.ts";
import { assertNoExcludedValue } from "../src/privacy.ts";
import { gatewayRoute } from "../src/writer/routes.ts";
import { makeWriterPort } from "../src/writer/port.ts";
import { field, node, snap } from "./builders.ts";

const modelOf = (nodes: ReturnType<typeof node>[]) => {
  const model = new ScreenModel();
  model.apply(snap(nodes, { at: 1000, windowId: "form", title: "Contact details" }));
  return model;
};

describe("PV1 outbound redaction", () => {
  it.each([
    'My password is:\nviolet-orchard-seven\nand put "R-42" in Reference',
    'My password is:\nviolet and orchard\nand put "R-42" in Reference',
    'My password is violet and orchard and put "R-42" in Reference',
    'My password is:\n\n\nviolet-orchard-seven\nand put "R-42" in Reference',
    'API\nkey:\n\nviolet-orchard-seven\nand put "R-42" in Reference',
    'put "violet and orchard" in Password and put "R-42" in Reference',
  ])("does not disclose a removed instruction value: %s", (instruction) => {
    const model = modelOf([field("ref", "", { label: "Reference" })]);
    const snapshot = intentSnapshot(instruction, model, model.windows.get("form")!, []);
    const input = intentInput(snapshot);
    const head = headsRequest(snapshot);
    const literal = instruction.includes("violet and orchard") ? "violet and orchard" : "violet-orchard-seven";
    expect(JSON.stringify(input)).not.toContain(literal);
    expect(JSON.stringify(input)).not.toContain("orchard");
    expect(JSON.stringify(input)).not.toContain("violet");
    expect(JSON.stringify(head)).not.toContain("orchard");
    expect(JSON.stringify(head)).not.toContain(literal);
    expect(snapshot.literals).toContain("R-42");
    expect(() => assertNoExcludedValue({ input })).not.toThrow();
    expect(() => assertNoExcludedValue(head)).not.toThrow();
  });

  it.each([
    node("container", "AXHeading", { label: "Password" }),
    node("container", "AXGroup", { value: "Password:" }),
  ])("excludes descendants of a wholly removed text node: $role", (container) => {
    // Child-first order also must not let a removed ancestor's content through.
    const model = modelOf([node("child", "AXStaticText", { parent: "container", value: "violet-orchard-seven" }), container]);
    const kept = redactWindow(model.windows.get("form")!);
    expect(kept.nodes.has("container")).toBe(false);
    expect(kept.nodes.has("child")).toBe(false);
  });

  it("joins marker text on adjacent reading-order nodes", () => {
    const model = modelOf([
      node("head", "AXStaticText", { value: "API", frame: [0, 0, 100, 20] }),
      node("tail", "AXStaticText", { value: "key: violet-orchard-seven", frame: [0, 25, 200, 20] }),
      field("ref", "", { label: "Reference", frame: [0, 100, 200, 20] }),
    ]);
    const kept = redactWindow(model.windows.get("form")!);
    expect(kept.nodes.has("head")).toBe(false);
    expect(kept.nodes.has("tail")).toBe(false);
    expect(kept.nodes.has("ref")).toBe(true);
  });

  it("does not join Card to a different labelled record", () => {
    const model = modelOf([
      node("head", "AXStaticText", { value: "Card", frame: [0, 0, 100, 20] }),
      node("tail", "AXStaticText", { value: "Number of attendees: 4", frame: [0, 25, 200, 20] }),
    ]);
    const kept = redactWindow(model.windows.get("form")!);
    expect(kept.nodes.size).toBe(2);
  });

  it("does not treat leftover punctuation as an actionable safe instruction", async () => {
    let calls = 0;
    const forbidden = async (): Promise<never> => { calls++; throw new Error("must not call a model"); };
    await expect(planAsk("put my social security number in;", modelOf([field("ref", "", { label: "Reference" })]), { values: () => [] }, [], {
      askJev: forbidden, maker: { name: "heads", make: forbidden }, writer: null, offerKey: "fixture",
    })).rejects.toThrow("Caret doesn't type Social Security numbers. Type it yourself.");
    expect(calls).toBe(0);
  });

  it("does not read a marked sender into the intent writer's input", () => {
    const model = modelOf([field("email", "", { label: "Email" })]);
    model.apply(snap([node("from", "AXStaticText", { value: "From: Robin Vale; password: violet-orchard-seven" })], { at: 900, windowId: "mail", title: "A meeting", app: { pid: 6160, bundleId: "dev.caret.mail", name: "Mail" } }));
    const input = intentInput(intentSnapshot("Fill my email", model, model.windows.get("form")!, []));
    expect(JSON.stringify(input)).not.toContain("violet-orchard-seven");
    expect(input.windows.find((w) => w.ref === "w1")?.from).toBeNull();
  });

  it("represents a marked section safely in descriptors and scope requests", () => {
    const model = modelOf([node("group", "AXGroup", { label: "Password" }), field("email", "", { label: "Email", parent: "group" })]);
    const w = model.windows.get("form")!;
    expect(describeField(w, w.nodes.get("email")!).section).not.toBe("Password");
    expect(() => assertNoExcludedValue(scopeRequest(intentSnapshot("Fill my email", model, w, []), 0))).not.toThrow();
  });

  it("joins a marker split across a cell's own attributes", () => {
    const model = modelOf([node("cell", "AXCell", { label: "API", value: "key: violet-orchard-seven" })]);
    expect(redactWindow(model.windows.get("form")!).nodes.has("cell")).toBe(false);
  });

  it("a multiline document cannot hide the nearest marked label", () => {
    const model = modelOf([
      node("label", "AXStaticText", { value: "Password", frame: [0, 40, 80, 20] }),
      node("doc", "AXStaticText", { value: "A short\ndocument", frame: [85, 40, 35, 20] }),
      field("input", "violet-orchard-seven", { frame: [125, 40, 100, 20] }),
    ]);
    const w = model.windows.get("form")!;
    expect(nearestText(w, w.nodes.get("input")!)).toBe("Password");
    expect(redactWindow(w).nodes.has("input")).toBe(false);
  });

  it("retains forbidden-field classes locally but projects only redacted names", () => {
    const model = modelOf([field("ssn", "", { label: "Social Security number" }), field("email", "", { label: "Email" })]);
    const w = model.windows.get("form")!;
    expect(localTargets(w).find((x) => x.node.key === "ssn")?.neverTyped).toBe("governmentId");
    const s = intentSnapshot("Fill my email", model, w, []);
    expect(s.fields.find((f) => f.key === "ssn")?.neverTyped).toBe("governmentId");
    for (const req of [headsRequest(s), scopeRequest(s, 0), scopeRequest(s, 1)]) {
      // Fixed refusal criteria may name a kind; screen-derived state and field instructions may not quote its label.
      expect(JSON.stringify([req.state, Object.values(req.questions).map((q) => q.instructions)])).not.toContain("Social Security number");
      expect(() => assertNoExcludedValue(req)).not.toThrow();
    }
    expect(JSON.stringify(intentInput(s))).not.toContain("Social Security number");
  });

  it("keeps required forbidden fields in local completion checks, not writer snapshots", () => {
    const model = modelOf([field("ssn", "", { label: "Social Security number (required)" }), field("email", "", { label: "Email" })]);
    const inv = buildInventory(model, { instruction: "Fill my email", windows: ["form"], memory: [], calendar: null, clock: macClock(new Date("2026-10-07T10:00:00Z")), now: 1000, readerSession: 1 });
    expect(inv.inventory.owed.get("form")).toContainEqual({ key: "ssn", label: "Social Security number", why: "required", empty: true });
    expect(JSON.stringify(inv.snapshots)).not.toContain("Social Security number");
  });

  it("replaces forbidden instruction clauses while retaining the safe clause", () => {
    const raw = 'put "4111 1111 1111 1111" in Notes and the order number in Reference';
    const safe = instructionForModel(raw);
    expect(safe).toBe("[a field Caret leaves to you] and the order number in Reference");
    expect(() => assertNoExcludedValue({ input: { instruction: safe } })).not.toThrow();
    expect(instructionForModel("API\nkey: violet-orchard-seven")).toBe("[a field Caret leaves to you]");
  });

  it("does not reintroduce a forbidden clause through extracted names or literals", async () => {
    const model = modelOf([field("notes", "", { label: "Notes" }), field("ref", "", { label: "Reference" })]);
    const instruction = 'put "Robin Vale" in Password and put "R-42" in Reference';
    const w = model.windows.get("form")!;
    const snapshot = intentSnapshot(instruction, model, w, []);
    expect(JSON.stringify(intentInput(snapshot))).not.toContain("Robin Vale");
    expect(JSON.stringify(headsRequest(snapshot))).not.toContain("Robin Vale");
    let calls = 0;
    await jevIntentMaker(async (req) => {
      calls++;
      expect(JSON.stringify(req)).not.toContain("Robin Vale");
      return { model: "fixture", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "refuse", confidence: 1 }])), inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    }).make(snapshot);
    expect(calls).toBe(2);
    const values = valueList(instruction, model, w, [], new Disclosure(model.windows.values()), 1000, 1000);
    expect(values.find((v) => v.text === "Robin Vale")?.display).toBe("[a field Caret leaves to you]");
    expect(values.find((v) => v.text === "R-42")?.display).toContain("R-42");
  });

  it("refuses an entirely forbidden instruction before any window-selection or maker request", async () => {
    let calls = 0;
    const forbidden = async (): Promise<never> => { calls++; throw new Error("must not call a model"); };
    await expect(planAsk("put my social security number in", modelOf([field("email", "", { label: "Email" })]), { values: () => [] }, [], {
      askJev: forbidden,
      maker: { name: "heads", make: forbidden },
      writer: null,
      offerKey: "fixture",
    })).rejects.toThrow("Caret doesn't type Social Security numbers. Type it yourself.");
    expect(calls).toBe(0);
  });

  it("does not judge an unmarked event sentence taken from a removed field", async () => {
    const sentence = "Meet Robin Vale Friday at 3pm.";
    const model = modelOf([field("secret", sentence, { label: "Password" })]);
    let calls = 0;
    const result = await askAttend(async () => {
      calls++;
      return { model: "fixture", answers: { attend: { choice: "yes", confidence: 1 } }, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
    }, model, model.windows.get("form")!, sentence);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("does not route raw event evidence from a removed field", () => {
    const sentence = "Meet Robin Vale Friday at 3pm.";
    const model = new ScreenModel();
    model.apply(snap([field("secret", sentence, { label: "Password" })], { at: 1000, windowId: "form", focused: true, focusedKey: "secret" }));
    const w = model.windows.get("form")!;
    const ctx = contextNow({ model, focus: null, host: null, readerSession: 1, memoryRevision: 0, settingsRevision: 0, hostBreaks: 0, candidates: ["event"] });
    expect(ctx).not.toBeNull();
    const reg = freeze(1, [{ id: "event", kind: "workflow", says: sentence, plain: "Add an event", quotes: [{ window: w, kind: "candidate", texts: [sentence] }], relevance: 1, evidence: { task: "Add an event", sentence, found: "A person and a time", offerWhen: "An upcoming meeting" }, say: (d) => {
      // As the event producer mints it: the sentence from the window's redacted view, which removed it.
      const m = d.candidate(redactWindow(w), sentence);
      return { says: m, plain: d.own("Add an event"), offer: m === null ? null : { task: d.own("Add an event"), sentence: m, found: d.own("A person and a time"), offerWhen: d.own("An upcoming meeting") } };
    }, run: () => {} }], new Set());
    const built = router1Request(model, ctx!, ["abstain", "act"], reg);
    expect(built.task).toBeNull();
    expect(built.taskPrivacy).toBe(true);
    expect(JSON.stringify(built)).not.toContain(sentence);
  });

  it("the writer refuses marked input before reading its key or sending", async () => {
    let keyReads = 0;
    const writer = makeWriterPort(gatewayRoute("openai/gpt-oss-120b"), { key: () => { keyReads++; throw new Error("must not read a key"); } });
    await expect(writer.write({ kind: "intent", disclosureId: "fixture", input: { instruction: "password: violet-orchard-seven" as never }, disclosure: new Disclosure([]), maxOutputTokens: 50, signal: new AbortController().signal })).rejects.toBeInstanceOf(UnmintedText);
    expect(keyReads).toBe(0);
  });
});

// These provider-shaping tests use fake transports; gateway execution requires an explicit dev opt-in.
vercelBeforeEach(() => { vercelVi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1"); vercelVi.stubEnv("CARET_RELEASE_HOST", "0"); });
vercelAfterEach(() => vercelVi.unstubAllEnvs());

import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []);
type Ast = { type: string; start: number; end: number; [key: string]: unknown };
const node = (x: unknown): x is Ast => typeof x === "object" && x !== null && "type" in x;
const prop = (x: unknown, key: string): unknown => node(x) ? x[key] : undefined;
const name = (x: unknown): unknown => prop(x, "name") ?? prop(x, "value");

// Every new request site needs a window-read audit, even when added to an already audited file.
const builders: Record<string, number> = {
  "codemode/jev-chooser.ts": 1, "executor/target.ts": 1, "fill/contract.ts": 1, "fill/fill.ts": 2,
  "goals/drafts.ts": 1, "goals/propose.ts": 1, "goals/saved-files.ts": 1, "offers/event-card.ts": 1,
  "patterns/naming.ts": 1, "planner/ask.ts": 1, "planner/codeplan.ts": 3, "planner/intent-heads.ts": 2,
  "planner/planner.ts": 2, "routing/judge.ts": 3, "tasks/pending.ts": 2,
};
// These transform an already checked request, or normalize it for a cache; they never extract window text.
const transforms: Record<string, number> = { "engines/decide/cache.ts": 2, "engines/decide/harness.ts": 1, "fill/jev.ts": 4, "privacy/disclosure.ts": 1, "privacy/send.ts": 1 };
const contributors = ["fill/answers.ts", "goals/inventory.ts", "patterns/skills.ts", "planner/intent.ts", "planner/people.ts", "planner/sources.ts", "planner/targets.ts"];

// Exact raw model lookups are allowed only for local safety/execution, privacy-budget accounting, or an audited redaction boundary.
// Counts prevent a new lookup in the same function from inheriting an exception.
const reads: Record<string, number> = {
  "fill/contract.ts|provenanceStale|model.windows.get(pr.windowId)": 1,
  "fill/contract.ts|provenanceStale|model.windows.get(pr.base.windowId)": 1,
  "fill/contract.ts|provenanceStale|model.windows.get(pr.srcWindowId)": 1,
  "fill/fill.ts|selectedFormInputs|model.windows.get(windowId)": 1,
  "fill/fill.ts|sourceWords|model.windows.values()": 1,
  // V6 B3: the second is the alternate-field veto's read of the form after the asks, compared locally and never sent.
  "fill/fill.ts|proposeFill|model.windows.get(windowId)": 2,
  "fill/fill.ts|proposeFill|model.windows.values()": 1,
  // Value settlement: the alternate-field veto's read of the form when a picked value is settled, as the one above.
  "fill/fill.ts|settle|at.model.windows.get(windowId)": 1,
  "goals/inventory.ts|buildInventory|model.windows.get(id)": 1,
  "goals/inventory.ts|buildInventory|model.windows.values()": 1,
  "goals/saved-files.ts|match|this.deps.model.windows.values()": 1,
  "offers/event-card.ts|askAttend|model.windows.values()": 1,
  "offers/event-card.ts|onChanges|model.windows.get(c.windowId)": 1,
  "offers/event-card.ts|onChanges|model.windows.get(e.windowId)": 1,
  "offers/event-card.ts|typingField|model.windows.get(id)": 1,
  "offers/event-card.ts|consider|deps.model.windows.get(w.window.windowId)": 1,
  "offers/event-card.ts|accept|this.deps.model.windows.get(e.windowId)": 2,
  "offers/event-card.ts|look|deps.model.windows.values()": 1,
  "offers/event-card.ts|acceptFound|this.deps.model.windows.get(windowId)": 1,
  "patterns/skills.ts|onBundleClosed|this.deps.model.windows.values()": 1,
  "planner/ask.ts|planAsk|model.windows.get(windowId)": 1,
  "planner/ask.ts|planAsk|model.windows.get(w.window.windowId)": 1,
  "planner/codeplan.ts|planWithCode|model.windows.values()": 1,
  "planner/intent.ts|intentSnapshot|model.windows.values()": 1,
  "planner/people.ts|peopleOnScreen|model.windows.values()": 1,
  "planner/planner.ts|planIn|model.windows.values()": 1,
  "planner/planner.ts|requestedWindow|model.windows.values()": 1,
  "planner/planner.ts|chooseWindow|model.windows.values()": 1,
  "planner/sources.ts|senderNames|model.windows.values()": 1,
  "planner/sources.ts|namedSources|model.windows.values()": 1,
  "routing/judge.ts|describe|model.windows.values()": 1,
  "tasks/pending.ts|left|this.deps.model.windows.get(windowId)": 1,
  "tasks/pending.ts|onSnapshot|this.deps.model.windows.get(windowId)": 1,
  "tasks/pending.ts|ask|this.deps.model.windows.get(watch.windowId)": 1,
  "tasks/pending.ts|askOnce|this.deps.model.windows.values()": 1,
  "tasks/pending.ts|update|this.deps.model.windows.get(watch.windowId)": 1,
};

// Pin the model-facing read boundaries independently of the allowed local raw lookups above.
const boundaries: Record<string, RegExp[]> = {
  "fill/fill.ts": [/function buildFillRequest[\s\S]*?w = redactWindow\(w\)/u, /const w = redactWindow\(localWindow\)/u, /const safeControls = new Map\(formControls\(w\)/u, /windowProvenance\(viewOf\(model, c.source.windowId\)/u],
  "fill/contract.ts": [/w = w === undefined \? undefined : redactWindow\(w\)/u],
  "fill/answers.ts": [/function pageText[\s\S]*?w = redactWindow\(w\)/u],
  "planner/intent.ts": [/const local = w;\s*w = redactWindow\(w\)/u, /windows.values\(\)\].map\(redactWindow\)/u, /modelName: x.modelName/u],
  "planner/targets.ts": [/const view = redactWindow\(w\)/u, /nameOf\(view, \{ ...x, node: kept \}\)/u],
  "planner/sources.ts": [/function senderOf[\s\S]*?w = redactWindow\(w\)/u, /windows.values\(\)\].map\(redactWindow\)/u],
  "planner/people.ts": [/const w = redactWindow\(raw\)/u],
  "planner/planner.ts": [/function planIn[\s\S]*?w = redactWindow\(w\)/u, /function fieldRequest[\s\S]*?w = redactWindow\(w\)/u, /windows.values\(\)\].map\(redactWindow\)/u],
  "planner/codeplan.ts": [/const w = viewOf\(model, o.windowId\)/u, /const win = viewOf\(model, id\)/u],
  "goals/inventory.ts": [/return redactWindow\(w\)/u, /function basisText[\s\S]*?w = redactWindow\(w\)/u, /function eventsIn[\s\S]*?w = redactWindow\(w\)/u],
  "goals/saved-files.ts": [/async offer[\s\S]*?w = redactWindow\(w\)/u, /kept.label \?\? ""\).includes\(label\)/u],
  "executor/target.ts": [/function elementTexts[\s\S]*?w = redactWindow\(w\)/u, /function buildTargetRequest[\s\S]*?w = redactWindow\(w\)/u],
  "tasks/pending.ts": [/function buildPendingRequest[\s\S]*?w = redactWindow\(w\)/u, /function buildLookRequest[\s\S]*?w = redactWindow\(w\)/u],
  "routing/judge.ts": [/viewOf\(model,/u, /windows.values\(\)\].map\(redactWindow\)/u, /const view = redactWindow\(q.window\)/u, /shown.some\(\(s\) => flat\(s\).includes\(flat\(t\)\)\)/u],
  "offers/event-card.ts": [/windows.values\(\)\].map\(redactWindow\)/u, /function askAttend[\s\S]*?w = redactWindow\(w\)/u, /nodeText\(n\).includes\(sentence\)/u],
  "patterns/skills.ts": [/viewOf\(model, cells\[0\]\?\.dstWindowId/u, /viewOf\(model, c.srcWindowId\)/u, /viewOf\(model, c.dstWindowId\)\?\.nodes.get\(c.dstKey\)\?\.label/u],
  "writer/port.ts": [/async write\(req\) \{[\s\S]*?assertNoExcludedValue\(req\);[\s\S]*?verifyWriterInput\(req\);[\s\S]*?const sealed = seal\(\{ writer: req \}, chatSink\(/u],
  "writer/local-port.ts": [/assertNoExcludedValue\(\{ input: ask.prompt \}\)/u],
  "writer/local-draft.ts": [/assertNoExcludedValue\(\{ input: ask.prompt \}\)/u],
  "writer/local-model.ts": [/assertNoExcludedValue\(\{ input: \{ prefix: req.prefix, prompt: req.prompt \} \}\)/u],
  "engines/decide/llama.ts": [/assertNoExcludedValue\(asked\);\s*const out = seal\(/u],
};

function inspect(sources: Map<string, string>): string[] {
  const errors: string[] = [];
  const foundBuilders: Record<string, number> = {};
  const foundReads: Record<string, number> = {};
  for (const [file, source] of sources) {
    const ast = parse(stripTypeScriptTypes(source), { ecmaVersion: "latest", sourceType: "module" });
    const walk = (n: Ast, ancestors: Ast[]): void => {
      if (n.type === "ObjectExpression") {
        const keys = (n.properties as Ast[]).map((p) => name(p.key));
        if ((keys.includes("state") && keys.includes("questions")) || (keys.includes("disclosureId") && keys.includes("input"))) {
          foundBuilders[file] = (foundBuilders[file] ?? 0) + 1;
          const parent = ancestors.at(-1);
          // SC1: a Disclosure's seal() verifies the request it builds (minted, in shape) and checks its formats.
          const guard = parent?.type === "CallExpression" && (name(parent.callee) === "assertNoExcludedValue" || name(prop(parent.callee, "property")) === "seal");
          if (!(file in transforms) && !guard) errors.push(`${file}: unguarded request`);
        }
      }
      if ((file in builders || contributors.includes(file)) && n.type === "CallExpression" && prop(prop(n.callee, "object"), "type") === "MemberExpression" && name(prop(prop(n.callee, "object"), "property")) === "windows" && ["get", "values"].includes(String(name(prop(n.callee, "property"))))) {
        const fn = [...ancestors].reverse().find((p) => p.type === "FunctionDeclaration" || p.type === "MethodDefinition" || (p.type === "VariableDeclarator" && ["ArrowFunctionExpression", "FunctionExpression"].includes(String(prop(p.init, "type")))));
        const key = `${file}|${String(name(fn?.id) ?? name(fn?.key) ?? "<anonymous>")}|${source.slice(n.start, n.end)}`;
        foundReads[key] = (foundReads[key] ?? 0) + 1;
      }
      for (const [key, value] of Object.entries(n)) if (key !== "start" && key !== "end") {
        if (Array.isArray(value)) for (const child of value) { if (node(child)) walk(child, [...ancestors, n]); }
        else if (node(value)) walk(value, [...ancestors, n]);
      }
    };
    walk(ast as unknown as Ast, []);
  }
  for (const [file, count] of Object.entries(foundBuilders)) if (count !== (builders[file] ?? transforms[file])) errors.push(`${file}: request inventory changed`);
  for (const [file, count] of Object.entries({ ...builders, ...transforms })) if (foundBuilders[file] !== count) errors.push(`${file}: request site missing`);
  for (const [key, count] of Object.entries(foundReads)) if (reads[key] !== count) errors.push(`${key}: unaudited raw window read`);
  for (const [file, patterns] of Object.entries(boundaries)) for (const pattern of patterns) if (!pattern.test(sources.get(file) ?? "")) errors.push(`${file}: redacted boundary missing: ${pattern.source}`);
  return errors;
}

const sources = (): Map<string, string> => new Map(files(root).map((f) => [relative(root, f), readFileSync(f, "utf8")]));

describe("PV1 request/read structure", () => {
  it("audits every request site and pins its redacted window-read boundaries", () => {
    expect(inspect(sources())).toEqual([]);
  });
  it("rejects removal of a redacted boundary and a new raw lookup in an audited builder", () => {
    const changed = sources();
    const file = "planner/codeplan.ts";
    changed.set(file, changed.get(file)!.replace("const w = viewOf(model, o.windowId);", "const w = model.windows.get(o.windowId);"));
    const errors = inspect(changed);
    expect(errors.some((e) => e.includes("unaudited raw window read"))).toBe(true);
    expect(errors.some((e) => e.includes("redacted boundary missing"))).toBe(true);
  });
  it("rejects a newly added request file even if it uses the guard", () => {
    const changed = sources();
    changed.set("new-request.ts", "const r = assertNoExcludedValue({ purpose: 'new', state: model.windows.get('raw'), questions: {} });");
    expect(inspect(changed)).toContain("new-request.ts: request inventory changed");
  });
});

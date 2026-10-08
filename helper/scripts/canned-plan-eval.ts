// Fixture-only planning check. Corpus pages use recorded page walks; task pages project their static
// HTML declarations, including templates, into text fields. This checks question coverage, not browser
// control kinds, dynamic visibility, field accuracy or writes.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel } from "../src/model.ts";
import { questionKind } from "../src/engines/decide/canned.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { PROTOCOL_VERSION, Snapshot, type Node } from "../src/protocol.ts";
import { buildDesk, loadCorpus, normLabel, pageForm, T0, type Desk } from "./realfill-corpus.ts";
import { pageLoopCanned } from "../../fixtures/web-form/canned-jev.ts";
import { fieldWhoseAnswer, loadOwners, ownersOf, valueOwnerAnswer } from "../../fixtures/web-form/owners.ts";
import { TASK_PAGES, loadExpectation } from "../../fixtures/web-form/tasks/site.ts";
import { field, snap, text } from "../test/builders.ts";

const ROOT = join(import.meta.dirname, "../..");
const corpus = loadCorpus(join(ROOT, "fixtures/realfill"));
const recorded = readFileSync(join(ROOT, "helper/fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((line) => Snapshot.parse(JSON.parse(line)));
const truth = loadOwners(join(ROOT, "fixtures/web-form/owners.json"), true);
const quoted = (s: string | null): string | null => s === null ? null : /^"([^"]*)"/u.exec(s)?.[1] ?? null;
const plain = (s: string): string => s.replace(/<[^>]*>/gu, "").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();

function taskDesk(page: (typeof TASK_PAGES)[number]): { desk: Desk; labels: Map<string, string> } {
  const e = loadExpectation(page.name);
  const model = new ScreenModel();
  model.apply(snap([field("note/text", e.sources.note, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Application details.txt", focused: true, app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
  model.apply(snap([text("mail/from", `From: ${e.sources.email.from}`), text("mail/to", `To: ${e.sources.email.to}`), text("mail/body", e.sources.email.body)], { at: T0 - 60_000, windowId: "mail", title: e.sources.email.subject, app: { pid: 7002, bundleId: "com.apple.mail", name: "Mail" } }));
  const nodes: Node[] = [];
  const labels = new Map<string, string>();
  for (const file of page.files) {
    const html = readFileSync(join(ROOT, "fixtures/web-form/public/tasks", file), "utf8");
    const labelFor = new Map([...html.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gu)].map((m) => [m[1]!, plain(m[2]!)]));
    for (const m of html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>|<[^>]*\sdata-oracle="([^"]+)"[^>]*>/gu)) {
      if (m[1] !== undefined) {
        nodes.push({ key: `form/h${nodes.length}`, parent: null, role: "AXHeading", label: plain(m[1]) });
        continue;
      }
      const name = m[2]!;
      const id = /\bid="([^"]+)"/u.exec(m[0])?.[1] ?? /data-input-id="([^"]+)"/u.exec(m[0])?.[1];
      const label = (id === undefined ? undefined : labelFor.get(id)) ?? name;
      labels.set(label, name);
      nodes.push(field(`form/${name}`, "", { label, parent: "form/root", frame: [0, nodes.length * 30, 300, 24] }));
    }
  }
  const trigger = nodes.find((n) => n.editable === true);
  if (trigger === undefined) throw new Error(`${page.name}: no declared field`);
  model.apply(snap(nodes, { at: T0, windowId: "page:tasks:1", kind: "page", title: page.name, focused: true, focusedKey: trigger.key }));
  const memory = e.sources.memory.map((m, i) => ({ id: `about-${i}`, label: m.key, text: m.value, whose: "user" as const }));
  return { desk: { model, form: model.windows.get("page:tasks:1")!, source: model.windows.get("note")!, trigger, about: [], memory }, labels };
}

const cases = [
  ...corpus.forms.map((form) => ({ suite: "corpus", id: form.id, desk: buildDesk(corpus, recorded, form, pageForm(form)), labels: new Map(form.fields.map((f) => [f.label, f.label])), values: form.fields.flatMap((f) => [f.expected, ...(f.accept ?? [])]) })),
  ...TASK_PAGES.map((page) => ({ suite: "tasks", id: page.name, ...taskDesk(page), values: Object.values(loadExpectation(page.name).expected).flat() })),
];
let failed = 0;
let previews = 0;
const missing = new Set<string>();
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), "caret-canned-plan-"));
  const store = new Store(dir);
  const owners = ownersOf(truth, c.id, c.desk.memory.map((m) => m.text));
  const wanted = new Set(c.values.filter((v) => v !== "none" && v !== "handoff"));
  const kinds = new Set<string>();
  const gaps: string[] = [];
  const engine = pageLoopCanned(async (q) => ({ choice: Object.entries(q.criteria).find(([, d]) => wanted.has(quoted(d) ?? "\u0000"))?.[0] ?? "none", confidence: 0.95 }), {
    whose: (q) => {
      const label = [...c.labels.keys()].find((l) => String(q.instructions).includes(`Label: '${l.slice(0, 40)}`));
      return fieldWhoseAnswer(label === undefined ? null : c.labels.get(label)!, owners, (a, b) => c.suite === "tasks" ? a === b : normLabel(a) === normLabel(b));
    },
    owner: (q, id, req) => {
      const subject = req.subjects?.[id];
      if (subject === undefined) throw new Error(`whose-value question ${id} came with no subject`);
      return valueOwnerAnswer(subject, q.criteria, owners);
    },
  }, (gap) => { gaps.push(gap.message); missing.add(gap.message); });
  const decide = harnessEngine({ name: "canned", canned: engine, fixture: { windows: (id) => c.desk.model.windows.has(id), memory: true, plan: true }, env: {} });
  const helper = new Helper({ store, shadow: false, allowBackgroundFocus: false, ask: { maker: "heads" }, writer: null, pageDocument: (id) => id === c.desk.form.window.windowId ? `fixture-${c.id}` : null, now: () => T0, publish: () => {}, askJev: async (req) => {
    for (const id of Object.keys(req.questions)) kinds.add(questionKind(req, id));
    return decide.ask(req);
  } });
  try {
    await helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "fixture" });
    for (const w of c.desk.model.windows.values()) helper.model.apply(snap([...w.nodes.values()], { at: w.updatedAt, app: w.app, windowId: w.window.windowId, kind: w.window.kind, title: w.window.title, focused: w.focused, focusedKey: w.focusedKey, values: w.values }));
    for (const m of c.desk.memory) helper.memory.addTyped({ label: m.label, value: m.text, source: "typed" }, (label) => label, T0);
    const reply = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: c.id, at: T0, instruction: "fill out this form", windowId: c.desk.form.window.windowId }, undefined, true, true);
    const outcome = reply.type === "planProposal" ? `${reply.outcome}${reply.error === null ? "" : ` ${reply.error.code}: ${reply.error.detail}`}` : reply.type === "goalProgress" ? `${reply.event}${"says" in reply ? `: ${reply.says}` : ""}` : "asked";
    const ok = gaps.length === 0 && reply.type === "goalProgress";
    if (reply.type === "goalProgress" && reply.event === "segment") previews++;
    if (!ok) failed++;
    console.log(`${c.suite}/${c.id}: ${ok ? "PASS" : "FAIL"} ${reply.type} ${outcome}; kinds=${[...kinds].join(",")}${gaps.length === 0 ? "" : `; ${gaps.join("; ")}`}`);
  } finally {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`summary: ${cases.length - failed}/${cases.length} pages past Ask into goal planning; ${previews} previews; ${missing.size} distinct gap messages`);
process.exitCode = failed === 0 ? 0 : 1;

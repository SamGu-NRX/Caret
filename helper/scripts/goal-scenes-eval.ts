// D2-06 acceptance: goal plans on the native scenes, with the real Helper and Executor, the reader's grant and press
// rules played by the synthetic desk (test/goal-desk.ts), and the calendar adapter's in-memory stand-in. No app, no
// GUI, no input. The "user" accepts every preview it is shown, and the oracle is the desk's own state, read apart
// from the helper: each field's value, the calendar's events, the buttons pressed.
//   node scripts/goal-scenes-eval.ts --out DIR                          canned writer (the gating run)
//   CARET_ENV_FILE=… node scripts/goal-scenes-eval.ts --out DIR --writer provider:model [--budget 0.15] [--runs N] [--jev live]
// L1: a live writer is only the route --writer names ("groq:<model>" or "gateway:<model>", writer/routes.ts devWriterRoute).
// --drafts local: the local model writes drafts' words (G1's caret-local-model, the GGUF read by path; take a heavy
// lease), and scene 2's reply Message is a draft from the mail instead of the instruction's words, judged by whether it
// says "I'm in". The other scenes ask for no words and run as they are.
// Reports, per scene and writer: plan offered (valid), refused for an unsupported route, segments and acceptances,
// steps verified, fresh previews, the end, the oracle, false done, replayed mutations and sends; and the cost.
import { writeStore } from "../src/privacy/send.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import type { GoalProgress } from "../src/protocol.ts";
import { YOURS_EFFECT } from "../src/goals/capabilities.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import { startLocalModel } from "../src/writer/local-model.ts";
import { toolLocalModel, type LocalModelPort } from "../src/writer/local-port.ts";
import { makeWriterPort, type WriterPort } from "../src/writer/port.ts";
import { loadJevKey, makeJevClient } from "../src/fill/jev.ts";
import { areaKey, button, caseWindow, detailsWindow, fieldKey, goalScene, MAIL, mailWindow, replyWindow, standInJev, SUPPORT, wizardWindow, type CannedStep, type DeskWindow, type GoalScene } from "../test/goal-desk.ts";

const { values: a } = parseArgs({ options: { out: { type: "string" }, writer: { type: "string", default: "canned" }, drafts: { type: "string", default: "program" }, "local-model": { type: "string", default: fileURLToPath(new URL("../../apps/local-model/.build/release/caret-local-model", import.meta.url)) }, "model-path": { type: "string", default: `${process.env.HOME}/Library/Application Support/app.cotypist.Cotypist/Models/gemma-4-E2B-i1-Q4_K_M.gguf` }, budget: { type: "string", default: "0.15" }, runs: { type: "string", default: "1" }, "space-ms": { type: "string", default: "0" }, jev: { type: "string", default: "none" } } });
// B30: a live writer may draft text, whose claims Jev checks. G2: every copied value is Jev's to confirm too, so a run
// without live Jev uses test/goal-desk.ts's stand-in, which confirms every value and claim; its rows say "jev stand-in".
const jevLive = a.jev === "live" ? makeJevClient(loadJevKey) : null;
if (a.jev !== "live" && a.jev !== "none") throw new Error("--jev is live or none (the stand-in)");
if (a.out === undefined) throw new Error("usage: node scripts/goal-scenes-eval.ts --out DIR [--writer canned|provider:model] [--budget USD] [--runs N]");
const OUT = a.out;
mkdirSync(OUT, { recursive: true });
const live = a.writer !== "canned";
const route = live ? devWriterRoute(a.writer ?? "") : null;
const budget = Number(a.budget);
/** Least time between two writer calls: Groq allows qwen3.8 about 1,000 output tokens a minute (writer/config.ts). */
const spaceMs = Number(a["space-ms"]);
let lastCall = 0;

const ORDER = "ORD-2026-48213";
const PROBLEM = "The desk lamp arrived with a cracked base and does not switch on.";
const EMAIL = "priya.raman@northwind.example";

if (a.drafts !== "program" && a.drafts !== "local") throw new Error("--drafts is program or local");
const tool = a.drafts === "local" ? await startLocalModel({ binary: a["local-model"] ?? "", modelPath: a["model-path"] ?? "" }) : null;
const draftCalls: { scene: string; ms: number; text: string | null; stop: string | null; error: string | null }[] = [];
let currentScene = "";
const drafter: LocalModelPort | null = tool === null ? null : (() => {
  const port = toolLocalModel(tool);
  return {
    via: port.via,
    async complete(ask, signal) {
      const t0 = performance.now();
      try {
        const r = await port.complete(ask, signal);
        draftCalls.push({ scene: currentScene, ms: performance.now() - t0, text: r.text, stop: r.stop, error: null });
        return r;
      } catch (e) {
        draftCalls.push({ scene: currentScene, ms: performance.now() - t0, text: null, stop: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        throw e;
      }
    },
  };
})();
if (tool !== null) console.log(`local model ${tool.model} loaded in ${Math.round(tool.loadMs)} ms`);

interface Scene {
  name: string;
  instruction: string;
  windows: () => DeskWindow[];
  user: string;
  /** The canned writer's programs, in order (the first plan, then each fresh plan). */
  canned: CannedStep[][];
  /** What the desk must hold at the end, by window and key; and the calendar's events by title. */
  expect: { fields: [string, string, string][]; events: string[] };
  /** --drafts local: the canned programs with a draft in place of the instruction's words, and what the draft must say. */
  local?: { canned: CannedStep[][]; field: [string, string, RegExp] };
  /** Changes the scene makes while it runs (a dialog), after the given act. */
  during?: (sc: GoalScene) => void;
}

const SCENES: Scene[] = [
  {
    name: "mail to support form (two windows)",
    instruction: "copy the order number from the email into the support case, then put the problem from the email in the case description",
    windows: () => [mailWindow(), caseWindow(), detailsWindow()],
    user: "7171-1",
    canned: [[
      { fill: { window: "New case", target: "Order number", value: ORDER } },
      { fill: { window: "Case details", target: "Description", value: "cracked base" } },
    ]],
    expect: { fields: [["7171-1", fieldKey(SUPPORT, "Order number"), ORDER], ["7171-2", areaKey(SUPPORT, "Description"), PROBLEM]], events: [] },
  },
  {
    name: "mail to calendar plus draft (Send is yours)",
    instruction: 'add this meeting to my calendar and draft a reply to Priya saying "I\'m in"',
    windows: () => [mailWindow(), replyWindow()],
    user: "6161-2",
    canned: [[
      { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } },
      { fill: { window: "Re: Order", target: "To", value: EMAIL } },
      { fill: { window: "Re: Order", target: "Message", value: "I'm in" } },
      { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
    ]],
    expect: { fields: [["6161-2", fieldKey(MAIL, "To"), EMAIL], ["6161-2", areaKey(MAIL, "Message"), "I'm in"]], events: ["Meet Priya"] },
    local: {
      canned: [[
        { fill: { window: "Calendar", target: "Caret", value: "Meet Priya" } },
        { fill: { window: "Re: Order", target: "To", value: EMAIL } },
        { draft: { window: "Re: Order", target: "Message", text: "(canned: the local model writes this)", from: ["Order ORD-2026-48213 arrived damaged"] } },
        { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
      ]],
      field: ["6161-2", areaKey(MAIL, "Message"), /\bI(?:'m| am) in\b/i],
    },
  },
  {
    name: "form behind a Next step",
    instruction: "report the damaged lamp from the email: the order number, then the description on the next page",
    windows: () => [mailWindow(), wizardWindow()],
    user: "7171-3",
    canned: [
      [{ fill: { window: "Report a problem", target: "Order number", value: ORDER } }, { press: { window: "Report a problem", target: "Next", effect: "e:reveal" } }],
      [{ fill: { window: "Report a problem", target: "Description", value: "cracked base" } }],
    ],
    expect: { fields: [["7171-3", fieldKey(SUPPORT, "Order number"), ORDER], ["7171-3", areaKey(SUPPORT, "Description"), PROBLEM]], events: [] },
  },
  {
    name: "a dialog mid-plan",
    instruction: "reply to Priya with the problem from her email",
    windows: () => [mailWindow(), replyWindow()],
    user: "6161-2",
    canned: [
      [{ fill: { window: "Re: Order", target: "To", value: EMAIL } }, { fill: { window: "Re: Order", target: "Message", value: "cracked base" } }],
      [{ fill: { window: "Re: Order", target: "Message", value: "cracked base" } }],
    ],
    expect: { fields: [["6161-2", fieldKey(MAIL, "To"), EMAIL], ["6161-2", areaKey(MAIL, "Message"), PROBLEM]], events: [] },
    during: (sc) => {
      sc.desk.afterAct = (v) => {
        if (v.kind !== "write") return;
        sc.desk.afterAct = null;
        sc.desk.show({ windowId: "6161-9", app: MAIL, title: "Spelling and Grammar", kind: "dialog", nodes: [button(MAIL, "Change")] });
      };
    },
  },
];

interface Row {
  scene: string;
  run: number;
  writer: string;
  model: string;
  valid: boolean;
  refused: string | null;
  unsupportedRoute: boolean;
  segments: number;
  acceptances: number;
  verified: number;
  skipped: number;
  freshPreviews: number;
  end: string;
  oracle: boolean;
  oracleDetail: string;
  falseDone: boolean;
  replayed: number;
  sends: number;
  costUsd: number;
  latencyMs: number[];
  /** Writer errors and the helper's warnings (a refused goal's detail, a fresh plan not built). */
  notes: string[];
}

/**
 * Wraps a writer to space its calls and add up what each cost and how long it took. A call that waited gets a fresh
 * abort signal: the caller's was made before the wait (B25: a 15 s gap aborted every request otherwise).
 */
function metered(w: WriterPort, into: { cost: number; latency: number[]; model: string; errors: string[]; programs: string[] }): WriterPort {
  return {
    route: w.route,
    async write(req) {
      const wait = lastCall + spaceMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      let r: Awaited<ReturnType<WriterPort["write"]>>;
      try {
        r = await w.write(wait > 0 ? { ...req, signal: AbortSignal.timeout(15_000) } : req);
      } catch (e) {
        into.errors.push(e instanceof Error ? e.message.slice(0, 200) : String(e));
        throw e;
      }
      into.cost += r.costUsd;
      into.latency.push(r.latencyMs);
      into.programs.push(r.output.program ?? "(no program)");
      into.model = r.model;
      return r;
    },
  };
}

let spent = 0;
const rows: Row[] = [];
const runs = live ? Number(a.runs) : 1;
for (let run = 1; run <= runs; run++) {
  for (const s of SCENES) {
    if (live && spent >= budget) {
      console.log(`budget: $${spent.toFixed(4)} spent of $${budget}; stopping before '${s.name}'`);
      break;
    }
    const meter = { cost: 0, latency: [] as number[], model: route === null ? "canned" : route.model, errors: [] as string[], programs: [] as string[] };
    currentScene = s.name;
    const local = drafter === null ? undefined : s.local;
    const sc = goalScene({ scripts: structuredClone(local?.canned ?? s.canned), ...(drafter === null ? {} : { drafter }), windows: s.windows(), userWindow: s.user, ...(route === null ? {} : { writer: metered(makeWriterPort(route), meter) }), askJev: jevLive === null ? standInJev() : async (req) => { const r = await jevLive(req); meter.cost += r.costUsd; return r; } });
    s.during?.(sc);
    const first = await sc.request(s.instruction);
    let acceptances = 0;
    // The user accepts each preview as shown, at most six times.
    for (let i = 0; i < 6; i++) {
      await sc.helper.goals.idle();
      const pending = [...sc.goals].reverse().find((g): g is Extract<GoalProgress, { event: "segment" }> => g.event === "segment" && sc.helper.goals.get(g.goalId)?.state === "awaiting" && sc.helper.goals.get(g.goalId)?.cursor.segment === g.segment);
      if (pending === undefined) break;
      acceptances++;
      await sc.accept(pending.goalId);
    }
    await sc.helper.goals.idle();
    const ends = sc.goals.filter((g) => g.event === "finished" || g.event === "stopped");
    const lastEnd = ends.at(-1);
    const end = lastEnd === undefined ? "none" : lastEnd.event === "finished" ? `finished ${lastEnd.outcome}` : `stopped ${lastEnd.reason}`;
    const bad: string[] = [];
    for (const [w, k, v] of s.expect.fields) {
      const got = sc.desk.node(w, k)?.value ?? "";
      const drafted = local !== undefined && local.field[0] === w && local.field[1] === k ? local.field[2] : null;
      if (drafted !== null ? !drafted.test(got) : got !== v) bad.push(`${k.split("/").at(-1)} '${got}' (want ${drafted === null ? `'${v}'` : String(drafted)})`);
    }
    const events = [...sc.calendar.events.values()].map((e) => e.title);
    if (JSON.stringify(events) !== JSON.stringify(s.expect.events)) bad.push(`calendar ${JSON.stringify(events)} (want ${JSON.stringify(s.expect.events)})`);
    const seen = new Map<string, number>();
    for (const w of sc.desk.writes) seen.set(`${w.windowId}|${w.key}|${w.value}`, (seen.get(`${w.windowId}|${w.key}|${w.value}`) ?? 0) + 1);
    const replayed = [...seen.values()].reduce((n, c) => n + (c - 1), 0);
    const sends = sc.desk.pressed.filter((p) => /^(send|submit|pay|delete)/i.test(p.label)).length;
    const finished = sc.goals.some((g) => g.event === "finished");
    const steps = sc.goals.filter((g) => g.event === "step");
    const refused = first.event === "stopped" && first.reason === "refused" ? first.says : null;
    rows.push({
      scene: s.name,
      run,
      writer: live ? "live" : "canned",
      model: meter.model,
      valid: first.event === "segment",
      refused,
      unsupportedRoute: refused !== null && /goal plan cannot|nothing for Caret|not a control|after a step that is yours/.test(refused),
      segments: first.event === "segment" ? first.segments : 0,
      acceptances,
      verified: steps.filter((g) => g.event === "step" && g.phase === "verified").length,
      skipped: steps.filter((g) => g.event === "step" && g.phase === "skipped").length,
      freshPreviews: sc.goals.filter((g) => g.event === "segment" && g.replaces !== null).length,
      end,
      oracle: bad.length === 0,
      oracleDetail: bad.join("; "),
      falseDone: finished && lastEnd?.event === "finished" && lastEnd.outcome === "done" && bad.length > 0,
      replayed,
      sends,
      costUsd: meter.cost,
      latencyMs: meter.latency,
      notes: [...meter.errors, ...sc.warnings.filter((l) => l.startsWith("goal "))],
    });
    spent += meter.cost;
    for (const note of rows.at(-1)?.notes ?? []) console.log(`  note: ${note}`);
    console.log(`${s.name} [${meter.model}]: ${end}; valid ${first.event === "segment"}${refused === null ? "" : ` (${refused})`}; oracle ${bad.length === 0 ? "ok" : bad.join("; ")}; verified ${rows.at(-1)?.verified}; replayed ${replayed}; sends ${sends}; $${meter.cost.toFixed(4)}`);
    writeStore(join(OUT, `${s.name.replace(/[^a-z0-9]+/gi, "-")}-${run}.goals.ndjson`), sc.goals.map((g) => JSON.stringify(g)).join("\n") + "\n");
    // The writer's programs, to count the ones the sandbox refused and why (G2, the writer's contract).
    if (live) writeStore(join(OUT, `${s.name.replace(/[^a-z0-9]+/gi, "-")}-${run}.programs.ts`), meter.programs.map((p, i) => `// program ${i + 1} (${meter.model})\n${p}\n`).join("\n"));
    await sc.close();
  }
}

const sum = (f: (r: Row) => number): number => rows.reduce((n, r) => n + f(r), 0);
const verifiedTasks = rows.filter((r) => r.oracle && !r.falseDone).length;
const summary = {
  writer: route === null ? "canned" : `live ${route.provider} ${route.model}`,
  jev: jevLive === null ? "jev stand-in (confirms every value and claim)" : "live Jev",
  scenes: rows.length,
  validPlans: rows.filter((r) => r.valid).length,
  unsupportedRoutes: rows.filter((r) => r.unsupportedRoute).length,
  oraclePassed: rows.filter((r) => r.oracle).length,
  stepsVerified: sum((r) => r.verified),
  freshPreviews: sum((r) => r.freshPreviews),
  falseDone: rows.filter((r) => r.falseDone).length,
  replayedMutations: sum((r) => r.replayed),
  sends: sum((r) => r.sends),
  costUsd: spent,
  costPerVerifiedTask: verifiedTasks === 0 ? null : spent / verifiedTasks,
  localDrafts: tool === null ? null : { model: tool.model, calls: draftCalls },
};
await tool?.close();
writeStore(join(OUT, "goal-scenes.json"), JSON.stringify({ summary, rows }, null, 2) + "\n");
const md = [
  `# Goal scenes (${summary.writer})`,
  "",
  "| scene | run | model | valid | segments | accepts | verified | fresh | end | oracle | false done | replayed | sends | $ |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.scene} | ${r.run} | ${r.model} | ${r.valid ? "yes" : `no: ${r.refused}`} | ${r.segments} | ${r.acceptances} | ${r.verified} | ${r.freshPreviews} | ${r.end} | ${r.oracle ? "ok" : r.oracleDetail} | ${r.falseDone ? 1 : 0} | ${r.replayed} | ${r.sends} | ${r.costUsd.toFixed(4)} |`),
  "",
  `Summary: ${JSON.stringify(summary)}`,
  "",
].join("\n");
writeStore(join(OUT, "goal-scenes.md"), md);
console.log(`summary ${JSON.stringify(summary)}`);
process.exitCode = summary.falseDone === 0 && summary.replayedMutations === 0 && summary.sends === 0 && (live || summary.oraclePassed === summary.scenes) ? 0 : 1;

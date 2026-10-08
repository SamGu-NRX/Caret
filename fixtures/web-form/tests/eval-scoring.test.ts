import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as scoring from "../oracle.ts";
import { storeJson } from "../../../helper/src/privacy/send.ts";

const loop = readFileSync(new URL("../page-loop-eval.ts", import.meta.url), "utf8");
const journey = readFileSync(new URL("../tab-source-journey.ts", import.meta.url), "utf8");
const guard = readFileSync(new URL("../../../helper/scripts/guard-adversary.ts", import.meta.url), "utf8");

// These executables start Chrome or consume saved walks on import. Run their actual scoring closures without either.
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end: ${end}`);
  return source.slice(from, to);
}
function run(code: string, context: Record<string, unknown> = {}): unknown {
  return runInNewContext(stripTypeScriptTypes(code), { ...scoring, ...context });
}

const fitsCode = between(loop, "function fits(", "// ---- task pages:");
function fits(text: string, expected: scoring.ExpectedValue, control: string | null = null, source = "task"): unknown {
  return run(`${fitsCode}\nfits(text, key)`, { text, key: { source, label: "Name", expected, accept: [], control } });
}

for (const [actual, expected, right] of [
  ["İ", "İ", true], ["İ", "İ", true], ["İ", ["Elif", "İ"], true],
  ["１２３", "123", false], ["elif", "Elif", false], [" Elif ", "Elif", false],
] as const) {
  test(`canned fits uses NFC only for ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`, () => {
    assert.equal(fits(actual, expected), right);
  });
  test(`write scoring uses NFC only for ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`, () => {
    const code = between(loop, "scoreWrite: (label, value) => {", "\n        };\n        await goalPath");
    const result = run(`const judge = { ${code} }; judge.scoreWrite("Name", value)`, {
      value: actual, expected: { name: expected }, taskFields: [],
      fieldsNamed: () => [{ name: "name", kind: "text", type: "text" }],
    });
    assert.equal(result, right ? "right" : "wrong");
  });
}

for (const sentinel of ["handoff", "unchecked"]) {
  for (const alternatives of [[sentinel, "Elif"], ["Elif", sentinel]]) {
    test(`task alternatives ${JSON.stringify(alternatives)} do not acquire corpus sentinel semantics`, async () => {
      const code = between(loop, "async function taskKeyFor(", "/** Canned Jev: canned-jev.ts's rules");
      const result = await run(`${code}\ntaskKeyFor("Label: 'Name'.")`, {
        page: { id: "test", expected: { name: alternatives } }, readTaskFields: async () => [],
        SAID: [/Label: '(.+?)'/u], taskFields: [{ name: "name" }], asksOn: () => ({ ambiguous: new Set(), unmapped: new Set() }),
        fieldsNamed: () => [{ name: "name" }], controlOf: () => null,
      });
      assert.equal(run(`${fitsCode}\nfits("Elif", key)`, { key: result }), true);
    });
  }
  test(`corpus ${sentinel} still means no text to write`, () => {
    assert.equal(fits(sentinel, sentinel, null, "corpus"), false);
  });
}

for (const [control, actual, expected] of [
  ["date", "March 3, 1991", "1991-03-03"], ["time", "7:30 pm", "19:30"],
  ["select", "Large, mushroom and onion", "Large"], ["month", "August 2022", "2022-08"],
  ["picker", "San Diego, California", "San Diego, California, United States"],
] as const) {
  test(`fits retains ${control} candidate interpretation`, () => assert.equal(fits(actual, expected, control), true));
}

for (const [expected, actual] of [
  ["Ines", "Ines"], [["Ines"], "Ines"], [["Other", "Ines"], "Ines"], [["İ"], "İ"],
] as const) {
  test(`tab-source selects and reads back ${JSON.stringify(expected)}`, () => {
    const code = between(journey, "const quoted =", "const theUsers =");
    const choice = run(`${code}\nfillValue(q).choice`, {
      expected: { first_name: expected }, LABEL_FIELD: { "First name": "first_name" },
      q: { instructions: "Label: 'First name'.", criteria: { picked: `"${actual}"`, none: "No value" } },
    });
    assert.equal(choice, "picked");
    const check = between(journey, 'check("the oracle reads back values from the message",', '\n  check("0 wrong"');
    let accepted: unknown;
    run(check, {
      expected: Object.fromEntries(["first_name", "last_name", "email", "phone"].map((k) => [k, expected])),
      after: Object.fromEntries(["first_name", "last_name", "email", "phone"].map((k) => [k, actual])), filled: [],
      check: (_name: string, result: unknown) => { accepted = result; },
    });
    assert.equal(accepted, true);
  });
}

test("tab-source does not select a literal no-write sentinel", () => {
  const code = between(journey, "const quoted =", "const theUsers =");
  assert.equal(run(`${code}\nfillValue(q).choice`, {
    expected: { first_name: "none" }, LABEL_FIELD: { "First name": "first_name" },
    q: { instructions: "Label: 'First name'.", criteria: { picked: '"none"', none: "No value" } },
  }), "none");
});

for (const phase of ["task", "refill", "wizard"] as const) {
  for (const value of ["WRONG", "Ines"]) {
    test(`${phase} preserves its score and fails loudly on EACCES with value ${value}`, async () => {
      const oracle = new scoring.Oracle();
      oracle.recordState({ page: "wizard-1", frame: "/", loadId: "1", seq: 1, reason: "change", fields: {
        first_name: { value, kind: "text", visible: true },
      } });
      const row = { right: 0, wrong: [] as string[], missed: [], fields: null, note: "", error: null };
      const task = { wrong: [] as scoring.Scored["wrong"], refill: "", fields: null, refillFields: null };
      const writer = between(loop, "const oracleFieldReports:", "/** How the goal path judges");
      let score: string;
      if (phase === "task") {
        const caught = between(loop.slice(loop.indexOf('stage = "refill";')), "      } catch (e) {", "      const a = asksOn(name);");
        score = `const judge = { ${between(loop, "score: async () => {", "          unrestored:")} }; try { await judge.score(); ${caught}`;
      } else if (phase === "wizard") {
        score = `try { ${between(loop, "        await settleOracle(name);\n        const sc =", "      lastName = name;")} `;
      } else {
        score = between(loop.slice(loop.indexOf('stage = "refill";')), "            const s = oracle.score(name, expected);", "      const a = asksOn(name);");
        score = score.replace("\n          }\n        }\n      } catch", "\n      } catch");
        score = `try {\n${score}`;
      }
      const attempts: string[] = [];
      const execution = run(`${writer}\n(async () => { ${score} })()`, {
        oracle, name: "wizard-1", expected: { first_name: "Ines" }, t: task, row,
        settle: async () => {}, settleOracle: async () => {}, attachGap: () => [], eligibleOf: () => 1,
        asksOn: () => ({ picked: new Map() }), r: { outcome: "ok", tabs: 0 },
        join, OUT: "/synthetic/report", writeStoreJson: (path: string) => {
          attempts.push(path);
          const error = new Error("EACCES: permission denied");
          Object.assign(error, { code: "EACCES" });
          throw error;
        },
      });
      await assert.rejects(Promise.resolve(execution), /EACCES/);
      assert.equal(attempts.length, 1);
      assert.equal(row.wrong.length, value === "WRONG" ? 1 : 0);
      const fields = phase === "wizard" ? row.fields : phase === "task" ? task.fields : task.refillFields;
      assert.notEqual(fields, null, "the in-memory evidence is independent of writing its file");
      if (phase === "task") assert.equal(task.wrong.length, value === "WRONG" ? 1 : 0);
      const exitCodes: number[] = [];
      const logs: string[] = [];
      let cleaned = false;
      await run(`(async () => { ${loop.slice(loop.indexOf("\nlet code = 1;"))} })()`, {
        main: () => execution, cleanup: async () => { cleaned = true; },
        say: (message: string) => logs.push(message), process: { exit: (code: number) => exitCodes.push(code) },
        existsSync: () => false, homedir: () => "/synthetic", join, HOST_NAME: "test",
      });
      assert.deepEqual(exitCodes, [1]);
      assert.equal(cleaned, true);
      assert.ok(logs.some((message) => message.includes("run failed:") && message.includes("EACCES")));
    });
  }
}

test("guard-adversary canned task matching accepts alternatives in NFC", () => {
  const code = between(guard, "    const keyPicks = new Map<string, string>();", "    observing =");
  const helpers = between(guard, "const norm =", "const session =");
  const result = run(`${helpers}\n${code}\nkeyPicks.get("name")`, {
    offered: new Map([["name", new Map([["İ", {}]])]]),
    byKey: new Map([["name", { source: "task", key: "name", label: "Name", expected: ["Elif", "İ"], checkbox: false }]]),
  });
  assert.equal(result, "İ");
});

for (const [actual, expected, right] of [
  ["İ", ["İ"], true], ["Ines", ["Ines"], true], [undefined, ["Ines"], false],
  ["Ines", undefined, false], ["none", "none", false], ["INÉS", ["Inés"], false],
] as const) {
  test(`tab-source readback compares ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`, () => {
    let accepted: unknown;
    run(between(journey, 'check("the oracle reads back values from the message",', '\n  check("0 wrong"'), {
      expected: Object.fromEntries(["first_name", "last_name", "email", "phone"].map((k) => [k, expected])),
      after: Object.fromEntries(["first_name", "last_name", "email", "phone"].map((k) => [k, actual])), filled: [],
      check: (_name: string, result: unknown) => { accepted = result; },
    });
    assert.equal(accepted, right);
  });
}

for (const [actual, expected, right] of [
  ["İ", "İ", true], ["１２３", "123", false], [" Elif ", "Elif", false],
  ["elif", "Elif", false], ["Elif", ["handoff", "Elif"], true], ["Elif", ["unchecked", "Elif"], true],
  ["false", "false", true], ["handoff", "handoff", true], ["unchecked", "unchecked", true],
] as const) {
  test(`guard-adversary task comparison is strict NFC for ${JSON.stringify(actual)} against ${JSON.stringify(expected)}`, () => {
    const helpers = between(guard, "const norm =", "const session =");
    const field = { source: "task", expected, checkbox: false };
    assert.equal(run(`${helpers}\nkeyMatches(text, field)`, { text: actual, field }), right);
    assert.equal(run(`${helpers}\nnoText(field)`, { field }), false);
  });
}

test("guard-adversary keeps corpus normalization and corpus sentinels separate from tasks", () => {
  const helpers = between(guard, "const norm =", "const session =");
  assert.equal(run(`${helpers}\nkeyMatches(" ＥＬＩＦ ", field)`, {
    field: { source: "corpus", expected: "Elif", accept: [] },
  }), true);
  for (const expected of ["none", "handoff", "unchecked"]) {
    assert.equal(run(`${helpers}\nnoText(field)`, { field: { source: "corpus", expected, accept: [] } }), true);
  }
  assert.equal(run(`${helpers}\nnoText(field)`, { field: { source: "task", expected: ["true"], checkbox: true } }), true);
});

test("successful field reports retain task and refill evidence before an early stop", () => {
  const writer = between(loop, "const oracleFieldReports:", "/** How the goal path judges");
  const snapshots: string[] = [];
  const fields = {
    text: { value: "false", kind: "text", outcome: "wrong" },
    checkbox: { value: "false", kind: "checkbox", outcome: "leftAlone" },
  };
  const refill = { name: { value: "İ", kind: "text", outcome: "right" } };
  assert.throws(() => run(`${writer}
    recordScoredFields("wizard-1", fields);
    recordScoredFields("wizard-1", refill, "refillFields");
    recordScoredFields("wizard-2", refill);
    throw new Error("stopped early");`, {
    fields, refill, join, OUT: "/synthetic/report",
    writeStoreJson: (_path: string, value: unknown) => snapshots.push(storeJson(value)),
  }), /stopped early/);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(JSON.parse(snapshots[2]!), {
    pages: { "wizard-1": { fields, refillFields: refill }, "wizard-2": { fields: refill, refillFields: null } },
  });
});

for (const [expected, kind, note] of [
  [["İ", "Elif"], "text", "First name: İ"], [["false", "Elif"], "text", "First name: false"],
  [["true"], "checkbox", "First name: yes"],
] as const) {
  test(`guard-adversary retains ${JSON.stringify(expected)} and labels one ${kind} written form`, () => {
    const dir = "/synthetic/walks";
    const file = join(dir, "f1-wizard-1.snapshot.json");
    const notes: string[] = [];
    const code = between(guard, "function* taskDesks(", "function* w4Desks(");
    const result = run(`${code}\nJSON.stringify([...taskDesks(true)].map((desk) => desk.fields))`, {
      a: { values: { "tasks-pages": dir } }, skipped: [], join, T0: 0, session: {},
      existsSync: (path: string) => path === dir || path === file,
      loadExpectation: () => ({ expected: { first_name: expected } }),
      readFileSync: (path: string) => {
        assert.equal(path, file);
        return JSON.stringify({ frames: [{ frameId: 0, controls: [{
          key: "name", strongKey: '"name=first_name"', name: "First name", kind,
        }] }] });
      },
      PageSnapshot: { parse: (value: unknown) => value },
      toWindowSnapshot: () => ({ nodes: [{ key: "f0/name", role: "AXTextField" }] }),
      oracleNames: () => new Map([["name=first_name", "first_name"]]), forgetWindows: () => {},
      ScreenModel: class { apply(text: string): void { notes.push(text); } }, noteWindow: (text: string) => text,
      putForm: () => ({ window: { windowId: "form" } }), pageParts: () => [], pageDocument: () => "document",
    });
    assert.ok(typeof result === "string");
    assert.deepEqual(JSON.parse(result), [[{
      source: "task", key: "f0/name", label: "First name", expected, checkbox: kind === "checkbox",
    }]]);
    assert.deepEqual(notes, [note]);
  });
}

for (const text of ["none", "", "Ines"]) {
  test(`guard-adversary counts writing ${JSON.stringify(text)} against bare none as unexempt`, () => {
    const helpers = between(guard, "const norm =", "const session =");
    const outcome = between(guard, "function outcomeOf(", "function record(");
    const unexempt = between(guard, "const exempt =", "const byRule =");
    const result = run(`${helpers}\n${outcome}\n${unexempt}
      const matched = keyMatches(text, field);
      const verdict = outcomeOf(result, field);
      attempts.push({ cls: "c", outcome: verdict, via: null });
      JSON.stringify({ matched, verdict, unexempt: unexempt().length });`, {
      text, field: { source: "task", key: "name", expected: "none", checkbox: false }, attempts: [],
      result: { written: new Map([["name", text]]), shown: new Map() },
    });
    assert.ok(typeof result === "string");
    assert.deepEqual(JSON.parse(result), { matched: false, verdict: "written", unexempt: 1 });
  });
}

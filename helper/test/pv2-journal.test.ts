// The lead's ruling on the executor's recovery journal (executor/journal.ts): it is the product's own state for writes
// the user accepted, kept so Undo works after a restart, not a store of requests. It holds the accepted plan, the write
// about to be made and the undo ledger, and nothing else: no prompt, model request or rejected draft, whatever a caller
// hands it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JournalRecord, RecoveryJournal } from "../src/executor/journal.ts";
import { open } from "../src/sealed.ts";
import type { Plan } from "../src/executor/schema.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv2-journal-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the recovery journal keeps accepted plan values and undo data only", () => {
  it("has exactly the fields of an accepted run: its plan, the act it is about to make, its undo ledger and run facts", () => {
    expect(Object.keys(JournalRecord.shape).sort()).toEqual(["afterIntended", "granted", "ledger", "next", "pending", "plan", "readerId", "savedAt", "skillId", "startedAt", "taskId", "unprompted", "window"]);
  });

  it("drops anything else a caller hands it before sealing: a prompt, a model request, a rejected draft", () => {
    const journal = new RecoveryJournal(join(dir, "data"));
    try {
      const accepted = "Robin Vale";
      const plan: Plan = { id: "p", title: "p", slots: {}, steps: [{ says: `Name holds ${accepted}`, end: { kind: "valueEquals", window: { titleStartsWith: "Form" }, target: { key: "k", describe: "Name" }, value: accepted } }] };
      const extra = { prompt: "Write a reply from Dana's staging note", request: { state: { task: "Which value fits?" } }, rejectedDraft: "Hi, the rotation moves to Austin" };
      journal.save({ taskId: "t1", startedAt: 1, savedAt: Date.now(), plan, unprompted: false, granted: true, readerId: null, next: 0, ledger: [], pending: null, skillId: null, window: null, ...extra } as JournalRecord);
      const { records } = journal.load(Date.now());
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records[0])).toContain(accepted);
      const key = (journal as unknown as { key: Buffer }).key;
      const sealed = journal.rawRows().map((r) => open(key, Buffer.from(r.sealed))).join("\n");
      for (const t of [extra.prompt, "Which value fits?", extra.rejectedDraft]) expect(sealed).not.toContain(t);
    } finally {
      journal.close();
    }
  });
});

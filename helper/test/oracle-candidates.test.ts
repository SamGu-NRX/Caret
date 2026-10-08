import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { collectCandidates } from "../src/fill/candidates.ts";
import { Snapshot } from "../src/protocol.ts";
import { buildDesk, loadCorpus, pageForm, T0 } from "../scripts/realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));

it("reads b31-04's whole candidate list within the visit cap", () => {
  const form = corpus.forms.find((f) => f.id === "greenhouse-apply") ?? (() => { throw new Error("no form"); })();
  const desk = buildDesk(corpus, snaps, form, pageForm(form));
  const result = collectCandidates(desk.model, desk.form.window.windowId, { now: T0 });
  expect(result.stats.overBudget).toBe(false);
  expect(result.candidates.map((c) => c.text)).toContain("The University of Texas at Austin");
});

// I3 lead ruling on B26 heldout2-11 ("add his cell number too"): a request that points at someone else (he, him, his,
// she, her, they, them, their, "my sister", a name) never offers the user as the person it means: "you" cannot be what
// "his" means. With no other person to offer, there is no question, and the Ask refuses with the "which person"
// sentence. A request about the user ("use my cell") still offers the user. Synthetic corpus and fixtures only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { Snapshot } from "../src/protocol.ts";
import { intentSnapshot, type IntentSnapshot } from "../src/planner/intent.ts";
import { choicesFor } from "../src/planner/choices.ts";
import { pointsAtOther } from "../src/planner/people.ts";
import { buildDesk, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { ScreenModel } from "../src/model.ts";
import { field, snap } from "./builders.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const desk = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());
const snapOn = (form: string, instruction: string): { s: IntentSnapshot; d: Desk } => {
  const d = desk(form);
  return { s: intentSnapshot(instruction, d.model, d.form, d.memory), d };
};
const options = (form: string, instruction: string): string[] | string => {
  const { s, d } = snapOn(form, instruction);
  const r = choicesFor("person", s, d.model, [], T0);
  return r.choices === null ? r.why : r.choices.options.map((o) => (o.option.kind === "person" ? o.option.name : o.option.kind));
};

describe("whom a person question offers", () => {
  it("B26 heldout2-11: 'add his cell number too' offers the people on screen and never the user", () => {
    const got = options("rental-application", "add his cell number too");
    expect(got).not.toContain("you");
    expect(got).toEqual(expect.arrayContaining(["Gary Pruitt"]));
  });

  it("leaves the user out for every third-person reference, and keeps them for the user's own words", () => {
    for (const ins of ["put her email in", "use their address", "add him as the contact", "she wants the large", "they moved in May", "ship it to my sister", "use Gary's phone"]) {
      expect(pointsAtOther(snapOn("rental-application", ins).s), ins).toBe(true);
      expect(options("rental-application", ins), ins).not.toContain("you");
    }
    for (const ins of ["use my cell", "fill in my details", "RSVP for me and Bea"]) expect(pointsAtOther(snapOn("rental-application", ins).s), ins).toBe(false);
    expect(options("rental-application", "use my cell")).toContain("you");
  });

  it("asks nothing when no one else could be meant: the Ask refuses with the which-person sentence", () => {
    const m = new ScreenModel();
    m.apply(snap([field("f/cell", "", { label: "Cell phone" })], { at: 1000, windowId: "form", title: "Contact", focused: true }));
    const w = m.windows.get("form");
    if (w === undefined) throw new Error("no form");
    const s = intentSnapshot("add his cell number too", m, w, []);
    const r = choicesFor("person", s, m, [], 2000);
    expect(r.choices).toBeNull();
  });
});

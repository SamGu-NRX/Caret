// P3: attach, with a file the user chose. A page goal for a host that shows attach rows (GOAL_FILES_CAPABILITY) offers
// each file control in scope as an attach step, last in its segment, whose row lets the user choose a file. The file
// arrives with the acceptance (goalAccept.confirmedFile), is read once and bound to that step's field for that run
// (engines/attach.ts), and lands through the page engine, verified by the page's own file list. An attach row given no
// file runs nothing and is left to the user. Caret never looks for a file. Every name and value is invented.
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRANT_MAX_MS, type HelperMessage, type PageControl } from "../src/protocol.ts";
import { c, mixedControls } from "./fake-page.ts";
import { closeRigs, goalMessages, presses, rig, type Finished, type Rig, type Segment } from "./page-rig.ts";

afterEach(closeRigs);

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "caret-p3-files-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function resume(name = "Robin Vale Resume.pdf", bytes = "%PDF-1.4 synthetic resume\n"): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** A wizard's documents page: a name, a file input, a dropzone's hidden input named by the dropzone's text, and Submit. */
function documents(): PageControl[] {
  return [c("r0", "text", "Full name", { value: "" }), c("r1", "file", "Resume"), c("r2", "file", "Or drop your resume here"), c("r3", "button", "Submit application")];
}

const finished = (r: Rig): Finished[] => goalMessages(r).filter((m): m is Finished => m.event === "finished");
const errors = (r: Rig): string[] => r.published.flatMap((m: HelperMessage) => (m.type === "error" ? [m.message] : []));
const attachVerbs = (r: Rig): number => r.page.verbs.filter((v) => v.kind === "pageAttachFile").length;
const settle = async (r: Rig): Promise<void> => {
  await r.helper.goals.idle();
  await new Promise((x) => setTimeout(x, 0));
  await r.helper.goals.idle();
};

describe("an attach row in a page goal's preview (P3)", () => {
  it("offers each file control in scope as an attach step after the writes, with a file chooser", async () => {
    const r = await rig({ goalFiles: true });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const attach = s.steps.filter((x) => x.kind === "attach");
    expect(attach).toEqual([{ index: s.steps.length - 1, kind: "attach", says: "Resume: a file you choose", file: { source: "choose" } }]);
    expect(s.steps.slice(0, -1).every((x) => x.kind === "write")).toBe(true);
  });

  it("offers none to a host that cannot show one, and the file control stays the user's", async () => {
    const r = await rig();
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.steps.some((x) => x.kind === "attach")).toBe(false);
  });
});

describe("attaching the file the user confirmed (P3)", () => {
  it("lands by the file input, verified by its file list, with the rest of the segment", async () => {
    const r = await rig({ goalFiles: true });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const step = s.steps.find((x) => x.kind === "attach")?.index as number;
    const path = resume();
    await r.accept(s, { confirmedFile: { step, path } });
    await settle(r);
    expect(r.page.files.get("e13")).toEqual({ name: "Robin Vale Resume.pdf", size: 26 });
    expect(r.page.shown("e1")).toBe("Robin Vale");
    expect(goalMessages(r).some((m) => m.event === "step" && m.step === step && m.phase === "verified")).toBe(true);
    expect(presses(r)).toBe(0);
  });

  it("lands by the dropzone when that is the row the user gave the file, and nothing goes to the other", async () => {
    const r = await rig({ goalFiles: true, controls: documents, title: "Apply: step 3" });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(s.steps.map((x) => x.says)).toEqual(["Full name: Robin Vale", "Resume: a file you choose", "Or drop your resume here: a file you choose"]);
    await r.accept(s, { confirmedFile: { step: 2, path: resume() } });
    await settle(r);
    expect(r.page.files.get("r2")?.name).toBe("Robin Vale Resume.pdf");
    expect(r.page.files.has("r1")).toBe(false);
    expect(attachVerbs(r)).toBe(1);
    // The input left without a file is the user's, and said so.
    expect(finished(r).at(-1)?.left).toContain("Attaching a file to 'Resume' is yours");
  });
});

describe("what never attaches (P3)", () => {
  it("an attach row the acceptance gave no file: nothing is sent, the writes run, and the row is left to the user", async () => {
    const r = await rig({ goalFiles: true });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    await r.accept(s);
    await settle(r);
    expect(attachVerbs(r)).toBe(0);
    expect(r.page.shown("e1")).toBe("Robin Vale");
    const end = finished(r).at(-1) as Finished;
    expect(end.outcome).toBe("partial");
    expect(end.left).toContain("Attaching a file to 'Resume' is yours");
  });

  it("a path that is a link to another file: the acceptance is refused, nothing runs, and the preview still waits", async () => {
    const r = await rig({ goalFiles: true });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const step = s.steps.find((x) => x.kind === "attach")?.index as number;
    const link = join(dir, "Resume.pdf");
    symlinkSync(resume("secret.txt", "not a resume"), link);
    expect(await r.accept(s, { confirmedFile: { step, path: link } })).toBeNull();
    expect(errors(r).at(-1)).toMatch(/link to another file/);
    expect(r.page.verbs.filter((v) => v.kind !== "pageWalk")).toEqual([]);
    // The user chooses the file itself and presses Tab again: now it runs.
    await r.accept(s, { confirmedFile: { step, path: resume() } });
    await settle(r);
    expect(r.page.files.get("e13")?.name).toBe("Robin Vale Resume.pdf");
  });

  it("a path that is not a regular file", async () => {
    const r = await rig({ goalFiles: true });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const step = s.steps.find((x) => x.kind === "attach")?.index as number;
    const folder = join(dir, "Resume.pdf");
    mkdirSync(folder);
    expect(await r.accept(s, { confirmedFile: { step, path: folder } })).toBeNull();
    expect(errors(r).at(-1)).toMatch(/not a file/);
    expect(attachVerbs(r)).toBe(0);
  });

  it("a confirmation older than GRANT_MAX_MS when the run reaches the attach: the step is handed back, and nothing lands", async () => {
    let offset = 0;
    const r = await rig({ goalFiles: true, now: () => Date.now() + offset });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    const step = s.steps.find((x) => x.kind === "attach")?.index as number;
    // The writes before the attach take longer than a grant lives (a slow page): the confirmation lapses on the way.
    r.page.onAct = (v) => {
      if (v.kind !== "pageAttachFile") offset = GRANT_MAX_MS + 1000;
      return null;
    };
    await r.accept(s, { confirmedFile: { step, path: resume() } });
    await settle(r);
    expect(attachVerbs(r)).toBe(0);
    expect(r.page.files.size).toBe(0);
    expect(finished(r).at(-1)?.left).toContain("Attaching a file to 'Resume' is yours");
  });

  it("a confirmed file for a step that is not an attach", async () => {
    const r = await rig({ goalFiles: true });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    expect(await r.accept(s, { confirmedFile: { step: 0, path: resume() } })).toBeNull();
    expect(errors(r).at(-1)).toMatch(/not an attach step/);
    expect(r.page.verbs.filter((v) => v.kind !== "pageWalk")).toEqual([]);
  });

  it("a page goal the helper offers to a host without attach rows can name no file", async () => {
    const r = await rig({ controls: mixedControls });
    const s = (await r.ask("fill out this form from my note")) as Segment;
    // Its preview has no attach step, so any step it names is not one.
    expect(await r.accept(s, { confirmedFile: { step: s.steps.length - 1, path: resume() } })).toBeNull();
    expect(attachVerbs(r)).toBe(0);
  });
});

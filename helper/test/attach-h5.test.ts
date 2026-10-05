// H5 (lead decision 7): a plan that attaches a file, the file the user confirms for the run, and the executor's attach
// step through the page engine. Every name, address and file here is invented.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelperMessage, PROTOCOL_VERSION, type HelperToEngine, type PageSnapshot, type Snapshot, type TaskProgress } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { FILE_INPUT_SUBROLE, PageEngineLink } from "../src/engines/page-link.ts";
import { ScreenModel } from "../src/model.ts";
import { attachWanted, planAttach } from "../src/planner/attach.ts";
import { proposed } from "../src/planner/proposal.ts";
import { SAYS, SaidError } from "../src/planner/says.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { RoutedReaderLink, type ReaderLink } from "../src/executor/means.ts";

const X = "kcmlnoabcdefghijklmnopabcdefghij";
const chrome = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };
const W = "page:eng1:7";

type Control = PageSnapshot["frames"][number]["controls"][number];
const file = (id: string, name: string, y: number): Control => ({ id, key: `form[apply]/button:${name.toLowerCase()}~0`, strongKey: null, kind: "file", role: "button", name, form: "form#apply", rect: [0, y, 200, 20] });
const email: Control = { id: "e1", key: "form[apply]/textbox:email~0", strongKey: null, kind: "email", role: "textbox", name: "Email", value: "", form: "form#apply", rect: [0, 0, 200, 20] };

function snapshot(id: string, controls: Control[]): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply: Synthetic Role",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/form", navGen: 1, title: "Apply: Synthetic Role", headings: [], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [],
    focused: { frameId: 0, id: "e1", selection: [0, 0] },
  };
}

/** A page engine that answers walks with `controls` and every other command with `result`. */
function rig(controls: Control[], result: (m: HelperToEngine) => object = () => ({ outcome: "ok", detail: null })) {
  const sent: HelperToEngine[] = [];
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
    sent.push(m);
    queueMicrotask(() => {
      if (m.type !== "pageCommand") return;
      if (m.verb.kind === "pageWalk") session.receive(snapshot(m.id, controls));
      session.receive({ type: "pageResult", v: 1, id: m.id, at: 1, ...(m.verb.kind === "pageWalk" ? { outcome: "ok", detail: null } : result(m)) } as never);
    });
    return true;
  }, 500);
  return { session, sent };
}
const verbs = (sent: HelperToEngine[]) => sent.flatMap((m) => (m.type === "pageCommand" ? [m.verb] : []));

async function walked(controls: Control[]): Promise<ScreenModel> {
  const model = new ScreenModel();
  const { session } = rig(controls);
  const link = new PageEngineLink(session, (s) => model.apply(s));
  await link.run({ kind: "walk", pid: chrome.pid, windowId: W });
  return model;
}

describe("a page's file input in the screen model", () => {
  it("carries the file-input subrole, which a button does not", async () => {
    const model = await walked([email, file("e4", "Resume", 30)]);
    const nodes = [...(model.windows.get(W)?.nodes.values() ?? [])];
    expect(nodes.find((n) => n.label === "Resume")).toMatchObject({ role: "AXButton", subrole: FILE_INPUT_SUBROLE });
    expect(nodes.find((n) => n.label === "Email")?.subrole).toBeUndefined();
  });
});

describe("planAttach", () => {
  it("plans one attach step into the file input the instruction names", async () => {
    const model = await walked([email, file("e4", "Resume/CV", 30), file("e5", "Cover Letter", 60)]);
    const d = planAttach("attach my resume", model, W, "plan-1");
    expect(d?.plan.steps).toEqual([{ says: "Resume/CV holds your resume", end: { kind: "fileAttached", window: { bundleId: chrome.bundleId, title: "Apply: Synthetic Role", page: true }, target: { key: "f0/form[apply]/button:resume/cv~0", describe: "the Resume/CV input" }, wants: "your resume" } }]);
    expect(d?.checked.attach).toMatchObject({ step: 0, label: "Resume/CV", wants: "your resume" });
    expect(planAttach("upload my cover letter", model, W, "plan-2")?.checked.attach?.label).toBe("Cover Letter");
    // The proposal says what it attaches, names no press, and Tab says what it does.
    const p = proposed("r1", d as NonNullable<typeof d>, 1);
    expect(p).toMatchObject({ handoff: null, attach: { step: 0, field: "Resume/CV", wants: "your resume" } });
    expect(p.spec?.blocks.at(-1)).toMatchObject({ type: "actions", items: [{ label: "Attach it" }] });
    expect(HelperMessage.safeParse(p).success).toBe(true);
  });

  it("takes the one file input when the label names nothing, and asks which when there are several", async () => {
    const one = await walked([email, file("e4", "Upload", 30)]);
    expect(planAttach("attach my resume", one, W, "p")?.checked.attach?.label).toBe("Upload");
    const two = await walked([email, file("e4", "Upload", 30), file("e5", "Other file", 60)]);
    const e = (() => {
      try {
        return planAttach("attach my resume", two, W, "p");
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(SaidError);
    expect((e as SaidError).message).toBe(SAYS.whichField);
  });

  it("is not this rule's without an attach word, a file it knows, or a file input", async () => {
    const model = await walked([email, file("e4", "Resume", 30)]);
    expect(planAttach("fill my email", model, W, "p")).toBeNull();
    expect(planAttach("attach the thing", model, W, "p")).toBeNull();
    expect(planAttach("attach my resume", await walked([email]), W, "p")).toBeNull();
    expect(attachWanted("Add my CV please")?.wants).toBe("your resume");
  });
});

describe("the confirmed file's run (helper, executor, page engine)", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "caret-h5-attach-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function setUp(attached: object = { via: "input", file: { name: "Resume.pdf", size: 3 }, shown: true }) {
    const published: HelperMessage[] = [];
    const { session, sent } = rig([email, file("e4", "Resume/CV", 30)], (m) => (m.type === "pageCommand" && m.verb.kind === "pageAttachFile" ? { outcome: "ok", detail: null, attached } : { outcome: "ok", detail: null }));
    let helper: Helper | null = null;
    const link = new PageEngineLink(session, (s: Snapshot) => void helper?.handleReader(s));
    // As main.ts joins them: the page window's verbs go to its engine, everything else (the input watch) to the reader.
    const reader: ReaderLink = { run: async () => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "r", at: 0, outcome: "ok", detail: null }) };
    const routed = new RoutedReaderLink(reader, { engineFor: (id) => (id.startsWith("page:") ? link : null), engines: () => [link] });
    helper = new Helper({
      store: new Store(join(dir, "data")),
      askJev: () => Promise.reject(new Error("no Jev in this test")),
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => published.push(m),
      readerLink: routed,
    });
    await link.run({ kind: "walk", pid: chrome.pid, windowId: W });
    const p = await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "ask-1", at: 1, instruction: "attach my resume", windowId: W });
    expect(p.outcome).toBe("proposed");
    expect(p.attach).toEqual({ step: 0, field: "Resume/CV", wants: "your resume" });
    return { helper, published, sent, offerKey: p.offerKey as string };
  }

  const progress = (published: HelperMessage[], taskId: string): TaskProgress[] => published.flatMap((m) => (m.type === "taskProgress" && m.taskId === taskId ? [m] : []));

  it("attaches the file the user confirmed, verified by the page's file list", async () => {
    const { helper, published, sent, offerKey } = await setUp();
    const path = join(dir, "Resume.pdf");
    writeFileSync(path, "pdf");
    const reply = helper.handleFileConfirm({ type: "fileConfirm", v: PROTOCOL_VERSION, requestId: "f1", at: 2, taskId: offerKey, path });
    expect(reply).toEqual({ type: "fileConfirmReply", v: 1, requestId: "f1", taskId: offerKey, outcome: "confirmed", file: { name: "Resume.pdf", size: 3 }, says: null });
    const accepted = await helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: offerKey, actionId: "run", overrides: {}, at: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(accepted).toMatchObject({ outcome: "done", acted: 1 });
    expect(verbs(sent).find((v) => v.kind === "pageAttachFile")).toMatchObject({ id: "e4", control: "file", taskId: offerKey, file: { name: "Resume.pdf", size: 3, data: "cGRm" } });
    expect(progress(published, offerKey).map((m) => m.phase)).toEqual(expect.arrayContaining(["verified", "done"]));
    // The confirmation was the run's alone.
    expect(helper.files.confirmed(offerKey)).toBeNull();
  });

  it("hands the step over when no file was confirmed, and stops when the page does not show it", async () => {
    const plain = await setUp();
    await plain.helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: plain.offerKey, actionId: "run", overrides: {}, at: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(verbs(plain.sent).filter((v) => v.kind === "pageAttachFile")).toEqual([]);
    const handed = progress(plain.published, plain.offerKey).find((m) => m.phase === "handoff");
    expect(handed?.detail).toContain("no file was confirmed for this run");

    const unseen = await setUp({ via: "input", file: { name: "other.pdf", size: 3 }, shown: false });
    const path = join(dir, "Resume.pdf");
    writeFileSync(path, "pdf");
    unseen.helper.handleFileConfirm({ type: "fileConfirm", v: PROTOCOL_VERSION, requestId: "f1", at: 2, taskId: unseen.offerKey, path });
    await unseen.helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: unseen.offerKey, actionId: "run", overrides: {}, at: 3 });
    await new Promise((r) => setTimeout(r, 50));
    expect(progress(unseen.published, unseen.offerKey).find((m) => m.phase === "stopped")?.detail).toContain("does not show the attached file");
  });

  it("never lets another run under the offer's key take the confirmed file (review #1)", async () => {
    const { helper, sent, offerKey } = await setUp();
    const path = join(dir, "Resume.pdf");
    writeFileSync(path, "pdf");
    helper.handleFileConfirm({ type: "fileConfirm", v: PROTOCOL_VERSION, requestId: "f1", at: 2, taskId: offerKey, path });
    const other = { id: "x", title: "x", slots: {}, steps: [{ says: "x", end: { kind: "fileAttached" as const, window: { bundleId: chrome.bundleId, title: "Apply: Synthetic Role" }, target: { key: "f0/form[apply]/textbox:email~0", describe: "email" }, wants: "your resume" } }] };
    expect(await helper.handleTask({ type: "runPlan", v: PROTOCOL_VERSION, taskId: offerKey, plan: other, slots: {} })).toBeNull();
    expect(verbs(sent).filter((v) => v.kind === "pageAttachFile")).toEqual([]);
    expect(helper.files.confirmed(offerKey)).toEqual({ name: "Resume.pdf", size: 3 });
  });

  it("refuses a confirmation for no plan that attaches, and a file it cannot read, in the user's words", async () => {
    const { helper, offerKey } = await setUp();
    const none = helper.handleFileConfirm({ type: "fileConfirm", v: PROTOCOL_VERSION, requestId: "f1", at: 2, taskId: "plan-x", path: join(dir, "a.pdf") });
    expect(none).toMatchObject({ outcome: "refused", file: null, says: SAYS.fileNoPlan });
    const gone = helper.handleFileConfirm({ type: "fileConfirm", v: PROTOCOL_VERSION, requestId: "f2", at: 2, taskId: offerKey, path: join(dir, "missing.pdf") });
    expect(gone).toMatchObject({ outcome: "refused", says: SAYS.fileUnreadable });
    expect(HelperMessage.safeParse(gone).success).toBe(true);
  });
});

// What the user told Caret as a fill source (B17): a typed Name or Email fills a field that asks for
// exactly that, with no other window open, and the offer says it came from "what you told Caret".
// Jev is a fake that answers by rule; every name and address here is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { aboutKind, aboutValues, fieldAsksFor, ABOUT_SAYS, type AboutValue } from "../src/fill/about.ts";
import { FillError, proposeFill } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { buildFillPopup, fillPlan, fillPopupEligible, recheckFill } from "../src/offers/fill-popup.ts";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FillProposal, PROTOCOL_VERSION, type MemoryEntry, type OfferPopup } from "../src/protocol.ts";
import { MAIL_APP, field, focus, jevPickingText, snap, text, value } from "./builders.ts";
import { LineClient, SocketReader, until } from "./socket-reader.ts";

const NAME: AboutValue = { id: "about-name", label: "Name", value: "Sam Rivera", kind: "name" };
const EMAIL: AboutValue = { id: "about-email", label: "Email", value: "sam.rivera@example.com", kind: "email" };
const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const FORM = "5150-7";

describe("which values and fields About entries fit", () => {
  it("reads an email by its shape and a name by its label and shape", () => {
    expect(aboutKind("Email", "sam.rivera@example.com")).toBe("email");
    expect(aboutKind("Work email", " sam@work.example ")).toBe("email");
    expect(aboutKind("Name", "Sam Rivera")).toBe("name");
    expect(aboutKind("Full name", "Ana de la Cruz")).toBe("name");
    expect(aboutKind("Name", "J. O'Neil-Park")).toBe("name");
    expect(aboutKind("Nickname", "Sam")).toBeNull();
    expect(aboutKind("Name", "Sam Rivera 2")).toBeNull();
    expect(aboutKind("Company", "Lumen Labs")).toBeNull();
    expect(aboutKind("Home city", "Porto")).toBeNull();
  });

  it("keeps typed entries only, trimmed, with their kinds", () => {
    const e = (id: string, label: string, v: string, source: "typed" | "edit" | "contacts") => ({ id, fields: { label, value: v, source } });
    expect(aboutValues([e("a", "Name", "Sam Rivera ", "typed"), e("b", "Guest", "Marcus Lowe", "edit"), e("c", "Email", "x@y.example", "contacts"), e("d", "Home city", "Porto", "typed")])).toEqual([
      { id: "a", label: "Name", value: "Sam Rivera", kind: "name" },
    ]);
  });

  const table: [AboutValue, string | null, boolean][] = [
    [NAME, "Name", true],
    [NAME, "Full name", true],
    [NAME, "Your name", true],
    [NAME, "Name (required)", true],
    [NAME, "Legal name", true],
    [NAME, "First name", false],
    [NAME, "Last name", false],
    [NAME, "Guest name", false],
    [NAME, "Company name", false],
    [NAME, "Username", false],
    [NAME, "Email", false],
    [NAME, null, false],
    [EMAIL, "Email", true],
    [EMAIL, "E-mail", true],
    [EMAIL, "Email address", true],
    [EMAIL, "Your email", true],
    [EMAIL, "Recipient email", false],
    [EMAIL, "Work email", false],
    [EMAIL, "Name", false],
    [EMAIL, "Mail", false],
    [{ ...EMAIL, label: "Work email" }, "Work email", true],
    [{ ...EMAIL, label: "Work email" }, "Email", true],
    [{ ...EMAIL, label: "Work email" }, "Personal email", false],
  ];
  it.each(table)("%o fits a field named %s: %s", (a, name, fits) => {
    expect(fieldAsksFor(a, name)).toBe(fits);
  });
});

/** A form of the named fields in a window of its own, the first focused. */
function form(m: ScreenModel, labels: readonly string[], at = 2000): void {
  m.apply(
    snap(
      labels.map((l, i) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })),
      { at, windowId: FORM, title: "Sign up", focused: true, focusedKey: F(`textfield:${labels[0]?.toLowerCase()}~0`) },
    ),
  );
}
const key = (label: string): string => F(`textfield:${label.toLowerCase()}~0`);

/** Picks by field label from a table, recording each request. */
function recording(byLabel: Record<string, string>): { ask: AskJev; requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  const inner = jevPickingText((_, ins) => byLabel[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.92);
  return { requests, ask: (req) => (requests.push(req), inner(req)) };
}

describe("proposeFill with values the user told Caret", () => {
  it("fills Name and Email with no other window open, sourced to memory, and asks nothing about Phone", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Email", "Phone"]);
    const { ask, requests } = recording({ Name: "Sam Rivera", Email: "sam.rivera@example.com" });
    const p = FillProposal.parse(await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] }));
    const by = Object.fromEntries(p.fields.map((f) => [f.key, f]));
    expect(by[key("Name")]).toMatchObject({ value: "Sam Rivera", source: null, memory: { id: NAME.id, label: "Name", says: ABOUT_SAYS }, withheld: null });
    expect(by[key("Email")]).toMatchObject({ value: "sam.rivera@example.com", source: null, memory: { id: EMAIL.id, label: "Email", says: ABOUT_SAYS } });
    expect(by[key("Phone")]).toMatchObject({ value: null, memory: null, withheld: null, asks: [] });
    // Each value is offered only in the question of the field that asks for it, and is declared as memory.
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(Object.keys(r.questions)).toHaveLength(2);
      const crit = Object.values(r.questions).map((q) => Object.values(q.criteria).filter((c) => c?.includes("which the user told Caret")));
      expect(crit.map((c) => c.length)).toEqual([1, 1]);
      // Values and their labels both go into the question, so both are declared (review B17 #1).
      expect(r.snippets.filter((s) => s.windowId === "memory").map((s) => s.text).sort()).toEqual(["Email", "Name", "Sam Rivera", "sam.rivera@example.com"]);
    }
  });

  it("offers nothing from memory to First name, Guest email or Company name, and so asks nothing", async () => {
    const m = new ScreenModel();
    form(m, ["First name", "Guest email", "Company name"]);
    const { ask, requests } = recording({});
    await expect(proposeFill(m, ask, FORM, key("First name"), 3000, { about: [NAME, EMAIL] })).rejects.toThrow(FillError);
    expect(requests).toHaveLength(0);
  });

  it("offers a window's copy of the same address as that window's candidate, not as memory", async () => {
    const m = new ScreenModel();
    const SRC = "6160-3";
    const mk = "dev.caret.mail/standard/statictext:sam~0";
    m.apply(snap([text(mk, "sam.rivera@example.com")], { at: 1000, windowId: SRC, title: "Thread", app: MAIL_APP, values: [value("email", "sam.rivera@example.com", mk)] }));
    form(m, ["Name", "Email"]);
    const { ask, requests } = recording({ Email: "sam.rivera@example.com", Name: "Sam Rivera" });
    const p = await proposeFill(m, ask, FORM, key("Email"), 3000, { about: [NAME, EMAIL] });
    const email = p.fields.find((f) => f.key === key("Email"));
    expect(email).toMatchObject({ value: "sam.rivera@example.com", memory: null, source: { windowId: SRC } });
    expect(p.fields.find((f) => f.key === key("Name"))).toMatchObject({ value: "Sam Rivera", memory: { id: NAME.id } });
    expect(requests[0]?.snippets.filter((s) => s.windowId === "memory").map((s) => s.text)).toEqual(["Sam Rivera", "Name"]);
  });

  it("charges a window that shows a memory value inside a line, as sending the value reveals it", async () => {
    const m = new ScreenModel();
    m.apply(snap([text("dev.caret.mail/standard/statictext:sig~0", "Thanks, Sam Rivera")], { at: 1000, windowId: "6160-4", title: "Note", app: MAIL_APP }));
    form(m, ["Name", "Email"]);
    const { ask, requests } = recording({});
    await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME] });
    expect(requests[0]?.charged["6160-4"]).toBeGreaterThanOrEqual("Sam Rivera".length);
  });

  it("refuses an answer that picks a memory value for a field it was not offered to", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Email"]);
    // Answers every question with the first memory id it has seen anywhere in the request.
    const ask: AskJev = async (req) => {
      const ids = Object.values(req.questions).flatMap((q) => Object.keys(q.criteria).filter((k) => /^[mn]\d+$/.test(k)));
      return { model: "jev-test", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: ids[0] ?? "none", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await expect(proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] })).rejects.toThrow(/not a candidate id for f/);
  });

  it("makes a pop-up from memory alone, sourced 'what you told Caret', which a forgotten entry makes stale", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Email"]);
    const { ask } = recording({ Name: "Sam Rivera", Email: "sam.rivera@example.com" });
    const p = await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] });
    expect(fillPopupEligible(p)).toBe(true);
    if (!fillPopupEligible(p)) return;
    const popup = buildFillPopup(m, p);
    const source = popup.spec.blocks.find((b) => b.type === "source");
    expect(source).toEqual({ type: "source", value: { text: ABOUT_SAYS, ref: { rule: "sources", derived: [{ memory: NAME.id }, { memory: EMAIL.id }] } } });
    const fields = popup.spec.blocks.find((b) => b.type === "fields");
    expect(fields?.type === "fields" ? fields.rows.map((r) => r.value) : null).toEqual([
      { text: "Sam Rivera", ref: { memory: NAME.id } },
      { text: "sam.rivera@example.com", ref: { memory: EMAIL.id } },
    ]);
    expect(popup.sourceApps).toBeUndefined();
    const held = new Map<string, AboutValue>([[NAME.id, NAME], [EMAIL.id, EMAIL]]);
    expect(recheckFill(m, p, (id) => held.get(id) ?? null)).toBeNull();
    // Renamed with the same value: the label decided where it was offered, so the offer ends.
    held.set(NAME.id, { ...NAME, label: "Organization" });
    expect(recheckFill(m, p, (id) => held.get(id) ?? null)).toBe("what you told Caret as Name changed");
    held.set(NAME.id, NAME);
    held.delete(EMAIL.id);
    expect(recheckFill(m, p, (id) => held.get(id) ?? null)).toBe("what you told Caret as Email changed");
    // Each write from memory names its entry, for the executor's check right before it writes.
    expect(fillPlan(m, p).plan.steps.map((s) => s.memory)).toEqual([NAME.id, EMAIL.id]);
  });
});

// Acceptance (B17 brief, 2): over the real socket, the host adds a name and an email, a fresh form's Name
// and Email fields get offers sourced "what you told Caret", and Forget removes them.
describe("typed name and email over the socket, as the host sends them", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;
  const hooks = { applied: (w: string, at: number) => helper.model.windows.get(w)?.updatedAt === at, tick: (at: number) => helper.tick(at) };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-about-"));
    store = new Store(join(dir, "data"));
    let n = 0;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      // Answers like a careful Jev would for these labels: the user's own value, if offered.
      askJev: jevPickingText((_, ins) => ({ Name: "Sam Rivera", Email: "sam.rivera@example.com" })[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null),
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      publish: (m) => own.publish(m),
      sendToReader: (cmd) => own.sendToReader(cmd),
    });
    helper = mine;
    server = own;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    reader.enforceGrants = true;
  });

  afterEach(async () => {
    host.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const memory = async (requestId: string, body: Record<string, unknown>): Promise<{ error: string | null; entries: MemoryEntry[] }> => {
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId, ...body });
    return (await host.waitFor((m) => m.type === "memoryReply" && m.requestId === requestId)) as unknown as { error: string | null; entries: MemoryEntry[] };
  };
  /** A fresh form in its own window, focused on its first field. */
  const openForm = async (windowId: string, labels: readonly string[], at: number): Promise<void> => {
    const nodes = labels.map((l, i) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] }));
    await reader.replay([snap(nodes, { at, windowId, title: "Sign up", focused: true, focusedKey: key(labels[0] as string) }), focus(windowId, key(labels[0] as string), at + 10)], hooks);
  };

  it("adds a name and an email, offers them on a fresh form as 'what you told Caret', fills them on accept, and Forget removes them", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    const email = await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    expect([name.error, email.error]).toEqual([null, null]);
    const nameId = name.entries[0]?.id as string;
    const emailId = email.entries[0]?.id as string;

    // A Name and Email form: every field grounded, so one pop-up.
    await openForm("5150-11", ["Name", "Email"], 3000);
    const popup = (await host.waitFor((m) => m.type === "popup")) as unknown as OfferPopup;
    expect(popup.spec.blocks.find((b) => b.type === "source")).toMatchObject({ value: { text: "what you told Caret" } });
    const rows = popup.spec.blocks.find((b) => b.type === "fields");
    expect(rows?.type === "fields" ? rows.rows.map((r) => [r.destination.text, r.value?.text, r.value?.ref]) : null).toEqual([
      ["Name", "Sam Rivera", { memory: nameId }],
      ["Email", "sam.rivera@example.com", { memory: emailId }],
    ]);
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: 1 });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === popup.offerKey && m.phase === "done");
    expect([reader.value("5150-11", key("Name")), reader.value("5150-11", key("Email"))]).toEqual(["Sam Rivera", "sam.rivera@example.com"]);

    // The filled form now shows both values, and a window's copy is offered as that window's; close it.
    reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: 8000, windowId: "5150-11" });
    await until(() => !helper.model.windows.has("5150-11"));
    // A form with a field memory cannot fill: per-field offers, Name and Email from memory.
    await openForm("5150-12", ["Name", "Email", "Phone"], 9000);
    const proposal = FillProposal.parse(await host.waitFor((m) => m.type === "fillProposal" && m.windowId === "5150-12"));
    expect(proposal.fields.map((f) => [f.key, f.value, f.memory?.says ?? null])).toEqual([
      [key("Name"), "Sam Rivera", "what you told Caret"],
      [key("Email"), "sam.rivera@example.com", "what you told Caret"],
      [key("Phone"), null, null],
    ]);

    // Forget both: a fresh form gets nothing from memory, so nothing is offered at all.
    expect((await memory("forget-name", { op: "forget", id: nameId })).error).toBeNull();
    expect((await memory("forget-email", { op: "forget", id: emailId })).error).toBeNull();
    const before = host.received.length;
    await openForm("5150-13", ["Name", "Email"], 20_000);
    // The fill ran and found nothing to offer: no window shows a value, and memory holds none.
    await host.waitFor((m) => m.type === "error" && /no candidate values in any window other than 5150-13/.test(String(m.message)));
    const after = host.received.slice(before).map((m) => (m as { type: string }).type);
    expect(after.filter((t) => t === "popup" || t === "fillProposal")).toEqual([]);
  });

  it("withdraws a first look's fill offer when an entry it shows is paused, and refuses a write from memory once it is gone", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    // The form arrives without focus, so only the first look offers it.
    const nodes = ["Name", "Email"].map((l, i) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] }));
    await reader.replay([snap(nodes, { at: 3000, windowId: "5150-31", title: "Sign up" })], hooks);
    const look = await helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "look", at: 3100, families: ["fill"], level: "eager", deadlineMs: 4000 });
    expect(look.found?.family).toBe("fill");
    const key = look.found?.offerKey as string;
    await memory("pause-name", { op: "pause", id: name.entries[0]?.id });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === key)).toMatchObject({ reason: "stale" });
  });

  it("withdraws an open pop-up when the entry it offers is forgotten", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    await openForm("5150-21", ["Name", "Email"], 3000);
    const popup = (await host.waitFor((m) => m.type === "popup")) as unknown as OfferPopup;
    await memory("forget-name", { op: "forget", id: name.entries[0]?.id });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === popup.offerKey)).toMatchObject({ reason: "stale" });
  });
});

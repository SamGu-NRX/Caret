// M1 through the helper: memory as markdown the user can read and edit. "Remember this" writes an active record at
// once; a fact Caret noticed is used at once and every offer built from it says where it came from; "Not right"
// fixes or forgets it on the spot; taking the offer confirms it. An edit made outside Caret withdraws offers and
// revokes tasks that used it, and no edit to a file can grant authority. Jev is a fake; every value is invented, and
// every folder is a fresh temporary one.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { MemoryError, MemoryStore } from "../src/patterns/memory.ts";
import { captureEdit } from "../src/patterns/preferences.ts";
import { parseDocument } from "../src/memory/parse.ts";
import { AnyMessage, ConsumerMessage, HelperMessage, MEMORY_DOCUMENTS_CAPABILITY, PROTOCOL_VERSION, type MemoryDocumentReply, type MemoryEntry, type MemoryProvenance, type OfferPopup } from "../src/protocol.ts";
import { noticedSays } from "../src/helper.ts";
import { field, focus, jevPickingText, snap } from "./builders.ts";
import { LineClient, SocketReader, until } from "./socket-reader.ts";

const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const key = (label: string): string => F(`textfield:${label.toLowerCase()}~0`);
const NOTICED_AT = Date.UTC(2026, 8, 29, 16, 5);

describe("memory as markdown, through the helper", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let oldHost: LineClient;
  let reader: SocketReader;
  let beforeAct: (() => void) | null = null;
  const hooks = { applied: (w: string, at: number) => helper.model.windows.get(w)?.updatedAt === at, tick: (at: number) => helper.tick(at) };
  const memDir = (): string => join(dir, "data", "Memory");

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-m1-"));
    store = new Store(join(dir, "data"));
    let n = 0;
    beforeAct = null;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      askJev: jevPickingText((_, ins) => {
        const label = /Label: '([^']+)'/.exec(ins)?.[1] ?? "";
        const name = helper.memory.list("about").find((e) => e.kind === "about" && e.fields.label === label);
        return name?.kind === "about" ? name.fields.value : null;
      }),
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      publish: (m) => own.publish(m),
      sendToReader: (cmd) => own.sendToReader(cmd),
      executorHooks: { beforeAct: async () => beforeAct?.() },
    });
    helper = mine;
    server = own;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test", host: true, capabilities: [MEMORY_DOCUMENTS_CAPABILITY] });
    oldHost = await LineClient.connect(join(dir, "screen.sock"));
    oldHost.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 2, version: "host-before-m1" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    reader.enforceGrants = true;
  });

  afterEach(async () => {
    host.close();
    oldHost.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const memory = async (requestId: string, body: Record<string, unknown>, via = host): Promise<{ error: string | null; entries: MemoryEntry[] }> => {
    via.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId, ...body });
    return (await via.waitFor((m) => m.type === "memoryReply" && m.requestId === requestId)) as unknown as { error: string | null; entries: MemoryEntry[] };
  };
  const documents = async (requestId: string, body: Record<string, unknown>): Promise<MemoryDocumentReply> => {
    host.send({ type: "memoryDocumentRequest", v: PROTOCOL_VERSION, requestId, ...body });
    return (await host.waitFor((m) => m.type === "memoryDocumentReply" && m.requestId === requestId)) as unknown as MemoryDocumentReply;
  };
  const openForm = async (windowId: string, labels: readonly string[], at: number): Promise<OfferPopup> => {
    const nodes = labels.map((l, i) => field(key(l), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] }));
    await reader.replay([snap(nodes, { at, windowId, title: "Sign up", focused: true, focusedKey: key(labels[0] as string) }), focus(windowId, key(labels[0] as string), at + 10)], hooks);
    return (await host.waitFor((m) => m.type === "popup" && (m as unknown as OfferPopup).field.windowId === windowId)) as unknown as OfferPopup;
  };
  /** Writes about-me.md through the memory window's editor, as the host would. */
  const saveAbout = async (text: string): Promise<MemoryDocumentReply> => {
    const read = await documents(`read-${Math.random()}`, { op: "read", doc: "about-me" });
    return documents(`save-${Math.random()}`, { op: "save", doc: "about-me", baseRevision: read.documents[0]?.revision ?? null, text });
  };
  const noticedName = (value: string): string =>
    ["# About me", "", "## Name <!-- caret:id=about-noticed1 kind=about -->", "- Label: Name", `- Value: ${value}`, "- Source: typed", "- Status: noticed", "- Noticed in: Mail", "- Window: Re: Friday", `- Noticed on: ${new Date(NOTICED_AT).toISOString()}`, ""].join("\n");

  it("'remember this' writes an active record to the right file at once", async () => {
    const a = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    const p = await memory("add-person", { op: "add", kind: "people", fields: { alias: "Dana", name: "Dana Whitfield" } });
    expect([a.error, p.error]).toEqual([null, null]);
    const about = parseDocument("about-me", readFileSync(join(memDir(), "about-me.md"), "utf8")).records.map((r) => r.record);
    const people = parseDocument("people", readFileSync(join(memDir(), "people.md"), "utf8")).records.map((r) => r.record);
    expect(about).toEqual([{ id: a.entries[0]?.id, kind: "about", status: "active", noticed: null, fields: { label: "Name", value: "Sam Rivera", source: "typed" } }]);
    expect(people).toEqual([{ id: p.entries[0]?.id, kind: "people", status: "active", noticed: null, fields: { alias: "Dana", name: "Dana Whitfield" } }]);
  });

  it("an offer built from a noticed fact says where it came from, to a host that asked; taking it confirms the fact", async () => {
    expect((await saveAbout(noticedName("Sam Rivera"))).error).toBeNull();
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    const listed = (await memory("list", { op: "list", kind: "about" })).entries.find((e) => e.id === "about-noticed1") as MemoryEntry & { kind: "about" };
    expect(listed).toMatchObject({ id: "about-noticed1", status: "noticed", noticed: { app: "Mail", windowTitle: "Re: Friday", at: NOTICED_AT } });
    // A host from before M1 reads it as active, with no key it does not know.
    const old = (await memory("list-old", { op: "list", kind: "about" }, oldHost)).entries.find((e) => e.id === "about-noticed1") as unknown as Record<string, unknown>;
    expect(old.status).toBe("active");
    expect("noticed" in old).toBe(false);

    const popup = await openForm("5150-71", ["Name", "Email"], 3000);
    const prov = (await host.waitFor((m) => m.type === "memoryProvenance" && m.offerKey === popup.offerKey)) as unknown as MemoryProvenance;
    expect(prov.facts).toEqual([{ memoryId: "about-noticed1", kind: "about", label: "Name", says: noticedSays("Mail", NOTICED_AT, prov.at), noticed: { app: "Mail", windowTitle: "Re: Friday", at: NOTICED_AT } }]);
    expect(oldHost.received.some((m) => (m as { type: string }).type === "memoryProvenance")).toBe(false);

    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: 1 });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === popup.offerKey && m.phase === "done");
    expect(reader.value("5150-71", key("Name"))).toBe("Sam Rivera");
    // The accept resolves with its run, just after the done line.
    await until(() => readFileSync(join(memDir(), "about-me.md"), "utf8").includes("- Status: active\n- Noticed in: Mail"));
    const after = parseDocument("about-me", readFileSync(join(memDir(), "about-me.md"), "utf8")).records.find((r) => r.record.id === "about-noticed1")?.record;
    // Confirmed: active, with where it was first noticed kept as history.
    expect(after).toMatchObject({ status: "active", noticed: { app: "Mail", window: "Re: Friday", at: NOTICED_AT } });
  });

  it("'Not right' with a correction replaces the value and withdraws the offer; without one it forgets the fact", async () => {
    await saveAbout(noticedName("Sam Rivera"));
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    const popup = await openForm("5150-72", ["Name", "Email"], 3000);
    host.send({ type: "memoryNotRight", v: PROTOCOL_VERSION, requestId: "nr-1", memoryId: "about-noticed1", offerKey: popup.offerKey, correction: "Samuel Rivera" });
    const fixed = (await host.waitFor((m) => m.type === "memoryReply" && m.requestId === "nr-1")) as unknown as { error: string | null; entries: MemoryEntry[] };
    expect(fixed.error).toBeNull();
    expect(fixed.entries[0]).toMatchObject({ status: "active", fields: { value: "Samuel Rivera" } });
    expect("noticed" in (fixed.entries[0] as object)).toBe(false);
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === popup.offerKey)).toMatchObject({ reason: "stale" });
    expect(readFileSync(join(memDir(), "about-me.md"), "utf8")).toContain("- Value: Samuel Rivera");
    expect(readFileSync(join(memDir(), "about-me.md"), "utf8")).not.toContain("Noticed in");

    host.send({ type: "memoryNotRight", v: PROTOCOL_VERSION, requestId: "nr-2", memoryId: "about-noticed1", offerKey: null, correction: null });
    const gone = (await host.waitFor((m) => m.type === "memoryReply" && m.requestId === "nr-2")) as unknown as { error: string | null; entries: MemoryEntry[] };
    expect(gone).toMatchObject({ error: null, entries: [] });
    expect(readFileSync(join(memDir(), "about-me.md"), "utf8")).not.toContain("about-noticed1");
    // A host from before M1 is refused by name.
    oldHost.send({ type: "memoryNotRight", v: PROTOCOL_VERSION, requestId: "nr-3", memoryId: "x-123", offerKey: null, correction: null });
    expect(await oldHost.waitFor((m) => m.type === "error")).toMatchObject({ message: 'memoryNotRight needs "memoryDocuments" in the consumer\'s hello capabilities' });
  });

  it("an edit in an editor withdraws the offer that used it, and the accept that follows is refused", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    const popup = await openForm("5150-73", ["Name", "Email"], 3000);
    const path = join(memDir(), "about-me.md");
    // No watcher in tests: the accept's own check by content finds the edit.
    writeFileSync(path, readFileSync(path, "utf8").replace("- Value: Sam Rivera", "- Value: Sam R."));
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: 1 });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === popup.offerKey)).toMatchObject({ reason: "stale" });
    expect(await host.waitFor((m) => m.type === "error" && String(m.message).startsWith(`offer ${popup.offerKey}`))).toMatchObject({ message: `offer ${popup.offerKey}: what it uses from memory (${name.entries[0]?.id}) changed since it was offered` });
    expect(reader.value("5150-73", key("Name"))).toBe("");
  });

  it("an edit in an editor during a run revokes it before the next write", async () => {
    await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    const popup = await openForm("5150-74", ["Name", "Email"], 3000);
    const path = join(memDir(), "about-me.md");
    let edited = false;
    beforeAct = () => {
      // Once the Name is in, the user changes the email in their editor.
      if (edited || reader.value("5150-74", key("Name")) !== "Sam Rivera") return;
      edited = true;
      writeFileSync(path, readFileSync(path, "utf8").replace("sam.rivera@example.com", "sam@elsewhere.example"));
    };
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: 1 });
    const stop = await host.waitFor((m) => m.type === "taskProgress" && m.taskId === popup.offerKey && m.phase === "stopped");
    expect(String(stop.detail)).toMatch(/what you told Caret for .* changed or is gone/);
    expect([reader.value("5150-74", key("Name")), reader.value("5150-74", key("Email"))]).toEqual(["Sam Rivera", ""]);
  });

  it("lists, reads and saves documents for the memory window, refusing a stale save and a secret by line", async () => {
    await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    const list = await documents("l", { op: "list" });
    expect(list.folder).toBe(memDir());
    expect(list.documents.map((d) => [d.doc, d.path, d.revision === null])).toEqual([
      ["about-me", join(memDir(), "about-me.md"), false],
      ["people", join(memDir(), "people.md"), true],
      ["preferences", join(memDir(), "preferences.md"), true],
    ]);
    const read = await documents("r", { op: "read", doc: "about-me" });
    expect(read.text).toBe(readFileSync(join(memDir(), "about-me.md"), "utf8"));
    const stale = read.documents[0]?.revision as string;
    expect((await saveAbout(`${read.text ?? ""}\nA note of mine.\n`)).error).toBeNull();
    const conflict = await documents("s", { op: "save", doc: "about-me", baseRevision: stale, text: "# About me\n" });
    expect(conflict.error).toBe("about-me.md changed outside Caret while it saved; keeping that version");
    expect(conflict.conflict?.revision).toBe(conflict.documents[0]?.revision);
    expect(readFileSync(join(memDir(), "about-me.md"), "utf8")).toContain("A note of mine.");
    const secret = await saveAbout(`${readFileSync(join(memDir(), "about-me.md"), "utf8")}\nSSN 123-45-6789\n`);
    expect(secret.error).toMatch(/^about-me\.md:\d+: Caret doesn't keep government ID numbers in memory$/);
    expect(readFileSync(join(memDir(), "about-me.md"), "utf8")).not.toContain("123-45-6789");
  });
});

describe("authority stays in the protected state", () => {
  let dir: string;
  let m: MemoryStore;
  const outside: string[][] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-m1-auth-"));
    m = new MemoryStore(dir);
    outside.length = 0;
    m.onOutsideChange = (c) => outside.push(c.map((x) => x.id));
  });
  afterEach(() => {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const step = { shapeHash: "s", srcBundle: "a", srcApp: "A", srcWindowKind: "standard", srcTemplateHash: "t", srcPos: 0, part: "whole", dstBundle: "b", dstApp: "Tracker", dstWindowKind: "standard", dstTemplateHash: "u", dstPos: 0 };
  const skillFile = (id: string): string => join(dir, "Memory", "skills", `${id}.md`);
  const newSkill = () => {
    const r = m.recordRoutine("sig", [step], 1);
    return m.addSkill(r?.id as string, { name: "Copy tracking", trigger: "a Tracker window opens with Order empty", needed: 3, handsOff: null }, 2);
  };
  const flush = (): Promise<void> => new Promise((r) => queueMicrotask(r));

  it("typing 'On its own: true', clean runs or a permission into the files grants nothing, and says so", async () => {
    const s = newSkill();
    writeFileSync(skillFile(s.id), `${readFileSync(skillFile(s.id), "utf8")}- On its own: true\n- onItsOwn: true\n- Clean runs: 99\n- Hands off: none\n`);
    writeFileSync(join(dir, "Memory", "permissions.md"), "# Permissions\n\n## Sensitive <!-- caret:id=permission-sensitive kind=permission -->\n- Rule: act\n");
    expect(m.skill(s.id)).toMatchObject({ onItsOwn: false, cleanRuns: 0, handsOff: null, paused: false });
    expect(m.permission("sensitive")).toBe("handoff");
    expect(m.list("permission").find((e) => e.id === "permission-sensitive")?.says).toBe("Money, passwords, system dialogs: hand off to you");
    const warnings = m.documents().find((d) => d.doc === `skills/${s.id}`)?.diagnostics.map((d) => `${d.severity} ${d.field}`);
    expect(warnings).toEqual(["warning On its own", "warning onItsOwn", "warning Clean runs", "warning Hands off"]);
    // Unknown lines change no record, so nothing was reported as edited.
    await flush();
    expect(outside).toEqual([]);
  });

  it("an edit to a skill running on its own puts it back on Tab, and its name follows the file", async () => {
    const s = newSkill();
    m.updateSkill(s.id, { onItsOwn: true, cleanRuns: 3, wrote: ["writeElsewhere"] }, 3);
    writeFileSync(skillFile(s.id), readFileSync(skillFile(s.id), "utf8").replace("- Name: Copy tracking", "- Name: Copy tracking numbers"));
    expect(m.skill(s.id)).toMatchObject({ name: "Copy tracking numbers", onItsOwn: false, cleanRuns: 0, wrote: [] });
    expect(m.list("skill")[0]).toMatchObject({ status: "learning" });
    await flush();
    expect(outside).toEqual([[s.id]]);
  });

  it("a skill whose file is deleted or broken is off, never on", () => {
    const s = newSkill();
    m.updateSkill(s.id, { onItsOwn: true, cleanRuns: 3 }, 3);
    writeFileSync(skillFile(s.id), readFileSync(skillFile(s.id), "utf8").replace("- Status: active", "- Status: maybe"));
    expect(m.skill(s.id)).toMatchObject({ paused: true, onItsOwn: false });
    rmSync(skillFile(s.id));
    expect(m.skill(s.id)?.paused).toBe(true);
    expect(() => m.setPaused(s.id, false)).toThrow(/skills\/skill-[0-9a-f]+\.md is missing/);
  });

  it("#4 looking at the documents first does not let an edited skill keep its approval", async () => {
    const s = newSkill();
    m.updateSkill(s.id, { onItsOwn: true, cleanRuns: 3 }, 3);
    writeFileSync(skillFile(s.id), readFileSync(skillFile(s.id), "utf8").replace("- When: a Tracker", "- When: any Tracker"));
    m.documents();
    m.readDocument(`skills/${s.id}`);
    expect(m.skill(s.id)).toMatchObject({ onItsOwn: false, cleanRuns: 0, trigger: "any Tracker window opens with Order empty" });
    await flush();
    expect(outside).toEqual([[s.id]]);
  });

  it("#5 a skill file edited while Caret was stopped puts the skill back on Tab at start", () => {
    const s = newSkill();
    m.updateSkill(s.id, { onItsOwn: true, cleanRuns: 3 }, 3);
    m.close();
    writeFileSync(skillFile(s.id), readFileSync(skillFile(s.id), "utf8").replace("- Name: Copy tracking", "- Name: Copy everything"));
    m = new MemoryStore(dir);
    expect(m.skill(s.id)).toMatchObject({ name: "Copy everything", onItsOwn: false, cleanRuns: 0 });
    expect(m.takeOutsideChanges().map((c) => c.id)).toEqual([s.id]);
    // Caret's own renames and pauses are not edits: a restart after them changes nothing.
    m.updateSkill(s.id, { onItsOwn: true, cleanRuns: 3 }, 4);
    m.edit(s.id, { name: "Copy all" }, 5);
    m.setPaused(s.id, true);
    m.setPaused(s.id, false);
    m.close();
    m = new MemoryStore(dir);
    expect(m.skill(s.id)).toMatchObject({ name: "Copy all", onItsOwn: true, cleanRuns: 3 });
  });

  it("#7 a secret in a preference field or in where a fact was noticed never reaches a file", () => {
    const pref = m.upsert("preference", "format:phone", { rule: "format", valueKind: "phone", template: "###-###-####" }, 1, null);
    expect(() => m.edit(pref, { template: "###-###-# sk-proj-abcdefghijklmnopqrstuvwxyzabcdef" }, 2)).toThrow("Caret doesn't keep API keys or tokens in memory");
    const id = m.upsert("people", "dana", { alias: "Dana", name: "Dana Reyes" }, 3, "Mail", { app: "Mail", window: "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789", at: 3 });
    expect(m.get(id)).toMatchObject({ status: "noticed", noticed: { app: "Mail", windowTitle: null, at: 3 } });
    for (const f of ["preferences.md", "people.md"]) expect(readFileSync(join(dir, "Memory", f), "utf8")).not.toMatch(/sk-proj|ghp_/);
  });

  it("refuses to keep a secret from any path: a learned edit, 'remember this', an edit, a correction", () => {
    const hash = (t: string): string => `h:${t}`;
    expect(() => captureEdit(m, hash, { source: "x", written: "x", edited: "4111 1111 1111 1111", kind: null, dstShapeHash: "d", fieldLabel: "Card", app: "Shop" }, 1)).toThrow("Caret doesn't keep card numbers in memory");
    expect(() => m.addTyped({ label: "Bank password", value: "hunter2", source: "typed" }, (l) => `t:${l}`, 1)).toThrow("Caret doesn't keep passwords in memory");
    const id = m.addTyped({ label: "Tax note", value: "file in April", source: "typed" }, (l) => `t:${l}`, 1).id;
    expect(() => m.edit(id, { value: "123-45-6789" }, 2)).toThrow("Caret doesn't keep government ID numbers in memory");
    const guest = m.upsert("about", "g", { label: "Guest", value: "Marcus", source: "edit" }, 1, "Mail", { app: "Mail", window: null, at: 1 });
    expect(() => m.notRight(guest, "sk-proj-abcdefghijklmnopqrstuvwxyz012345", 3)).toThrow("Caret doesn't keep API keys or tokens in memory");
    const text = readFileSync(join(dir, "Memory", "about-me.md"), "utf8");
    for (const secret of ["4111", "hunter2", "123-45-6789", "sk-proj"]) expect(text).not.toContain(secret);
    expect(m.list("about").map((e) => (e.kind === "about" ? e.fields.value : ""))).toEqual(expect.arrayContaining(["file in April", "Marcus"]));
  });
});

describe("zero silent lost edits", () => {
  let dir: string;
  let m: MemoryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-m1-race-"));
    m = new MemoryStore(dir);
  });
  afterEach(() => {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const hash = (t: string): string => `h:${t}`;
  const path = (): string => join(dir, "Memory", "about-me.md");

  it("the user editing the file while Caret saves a noticed fact: a different record merges, the same record wins with a conflict", () => {
    m.addTyped({ label: "Name", value: "Sam Rivera", source: "typed" }, (l) => `typed:${l}`, 1);
    const files = m.files;
    if (files === null) throw new Error("documents mode expected");
    // The user edits their Name at the moment Caret installs a fact it noticed in Mail.
    let once = true;
    files.hooks.beforeInstall = () => {
      if (!once) return;
      once = false;
      writeFileSync(path(), readFileSync(path(), "utf8").replace("- Value: Sam Rivera", "- Value: Sam R. Rivera"));
    };
    captureEdit(m, hash, { source: "Marcus Lowe", written: "Marcus Lowe", edited: "Marcus Lowe (ops)", kind: null, dstShapeHash: "d1", fieldLabel: "Guest", app: "Mail", windowTitle: "Re: Friday" }, 5);
    const merged = m.list("about").map((e) => (e.kind === "about" ? [e.fields.label, e.fields.value, e.status] : []));
    expect(merged.sort()).toEqual([["Guest", "Marcus Lowe (ops)", "noticed"], ["Name", "Sam R. Rivera", "active"]]);

    // Now the user edits a person's record while Caret writes a newer sighting of that same person (a person is keyed by
    // alias, so both writes are to one record): the user's text wins and Caret's write is refused, loudly.
    files.hooks.beforeInstall = () => undefined;
    captureEdit(m, hash, { source: "Dana", written: "Dana", edited: "Dana Reyes", kind: null, dstShapeHash: "d2", fieldLabel: "Guest", app: "Mail", windowTitle: null }, 6);
    const people = join(dir, "Memory", "people.md");
    once = true;
    files.hooks.beforeInstall = () => {
      if (!once) return;
      once = false;
      writeFileSync(people, readFileSync(people, "utf8").replace("- Name: Dana Reyes", "- Name: Dana Reyes-Lowe"));
    };
    expect(() => captureEdit(m, hash, { source: "Dana", written: "Dana", edited: "Dana Smith", kind: null, dstShapeHash: "d2", fieldLabel: "Guest", app: "Mail", windowTitle: null }, 7)).toThrow(/people\.md: the record people-[0-9a-f]+ changed outside Caret \(it was edited\); keeping that version/);
    expect(readFileSync(people, "utf8")).toContain("- Name: Dana Reyes-Lowe");
    expect(readFileSync(people, "utf8")).not.toContain("Dana Smith");
  });

  it("over 200 interleaved saves, every user edit and every save Caret reported as done is in the file", () => {
    const files = m.files;
    if (files === null) throw new Error("documents mode expected");
    const userLines: string[] = [];
    const caretValues: string[] = [];
    let refused = 0;
    let i = 0;
    let lastEdit = -1;
    files.hooks.beforeInstall = () => {
      // Every third save, the user appends a note of their own at the worst moment (once; Caret's retry then lands).
      if (i % 3 !== 0 || lastEdit === i || !existsSync(path())) return;
      lastEdit = i;
      const line = `User note ${i}.`;
      userLines.push(line);
      writeFileSync(path(), `${readFileSync(path(), "utf8")}\n${line}\n`);
    };
    for (i = 0; i < 200; i++) {
      const value = `Value ${i}`;
      try {
        m.upsert("about", `k${i % 7}`, { label: `Field ${i % 7}`, value, source: "edit" }, i, "Mail", { app: "Mail", window: null, at: i });
        caretValues.push(`${i % 7}:${value}`);
      } catch (e) {
        if (!(e instanceof MemoryError)) throw e;
        refused++;
      }
    }
    const text = readFileSync(path(), "utf8");
    const lostUser = userLines.filter((l) => !text.includes(l));
    // The last value Caret reported saving for each field is the one in the file.
    const last = new Map(caretValues.map((x) => [x.split(":")[0], x.split(":")[1]]));
    const fields = new Map(parseDocument("about-me", text).records.map((r) => [(r.record.fields as { label: string }).label.slice(6), (r.record.fields as { value: string }).value]));
    const lostCaret = [...last].filter(([k, v]) => fields.get(k as string) !== v);
    expect({ userEdits: userLines.length, lostUser: lostUser.length, lostCaret: lostCaret.length, refused }).toEqual({ userEdits: 66, lostUser: 0, lostCaret: 0, refused: 0 });
  });
});

describe("the M1 protocol lines", () => {
  const lines = readFileSync(new URL("../fixtures/golden/memory-documents.ndjson", import.meta.url), "utf8").trim().split("\n");

  it("parses every golden line and writes it back byte for byte", () => {
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual([
      "hello", "memoryRequest", "memoryReply", "memoryProvenance", "memoryNotRight", "memoryReply", "memoryNotRight", "memoryReply",
      "memoryDocumentRequest", "memoryDocumentReply", "memoryDocumentRequest", "memoryDocumentReply", "memoryDocumentRequest", "memoryDocumentReply",
    ]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      const schema = ["hello", "memoryRequest", "memoryNotRight", "memoryDocumentRequest"].includes(m.type) ? ConsumerMessage : HelperMessage;
      expect(JSON.stringify(schema.parse(m)), m.type).toBe(l);
    }
  });

  it("refuses the shapes the contract rules out", () => {
    const at = (t: string, n = 0): Record<string, unknown> => JSON.parse(lines.filter((l) => (JSON.parse(l) as { type: string }).type === t)[n] as string) as Record<string, unknown>;
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    const reply = at("memoryReply") as { entries: Record<string, unknown>[] };
    const noticed = reply.entries.find((e) => e.status === "noticed") as Record<string, unknown>;
    const { noticed: _n, ...noSource } = noticed;
    expect(bad({ ...reply, entries: [noSource] })).toBe(true);
    expect(bad({ ...reply, entries: [{ ...noticed, kind: "routine", fields: { srcApps: [], dstApp: "x", steps: 1, name: null, silent: { hits: 0, misses: 0 } } }] })).toBe(true);
    expect(bad({ ...at("memoryDocumentRequest"), doc: "about-me" })).toBe(true);
    expect(bad({ ...at("memoryDocumentRequest", 1), doc: "../about-me" })).toBe(true);
    expect(bad({ ...at("memoryDocumentRequest", 1), doc: "skills/../people" })).toBe(true);
    expect(bad({ ...at("memoryDocumentRequest", 2), baseRevision: undefined })).toBe(true);
    expect(bad({ ...at("memoryDocumentReply", 2), error: null })).toBe(true);
    expect(bad({ ...at("memoryProvenance"), facts: [] })).toBe(true);
    expect(bad({ ...at("hello"), role: "reader", host: undefined })).toBe(true);
  });
});

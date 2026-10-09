import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { FirstLookPreviews, PREVIEW_TTL_MS } from "../src/offers/first-look-preview.ts";
import { FirstLookAllowList, PreviewStale, withFirstLookAllowList } from "../src/privacy/first-look-allow-list.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { ConsumerMessage, FirstLookPreview, FirstLookPreviewRequest, FirstLookReply, HelperMessage, PROTOCOL_VERSION } from "../src/protocol.ts";
import { windowBudget } from "../src/privacy.ts";
import { sealRequest } from "../src/fill/jev.ts";
import { sendable } from "../src/privacy/send.ts";
import { registryOf } from "../src/privacy/ledger/account.ts";
import { buildLookRequest } from "../src/tasks/pending.ts";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { field, jevPickingText, snap, text } from "./builders.ts";
import { LineClient, SocketReader, loadRecording, until } from "./socket-reader.ts";

const request: FirstLookPreviewRequest = { type: "firstLookPreviewRequest", v: PROTOCOL_VERSION, requestId: "preview-1", at: 1000, families: ["fill", "pending", "event"], level: "balanced" };
const fixture = fileURLToPath(new URL("../../apps/caret/Tests/CaretHostCoreTests/Fixtures/first-look-preview.ndjson", import.meta.url));

function desk(): ScreenModel {
  const model = new ScreenModel();
  model.apply(snap([text("name", "Name: Dana"), text("secret", "Password: violet-orchard-seven")], { at: 1, windowId: "note", title: "About me" }));
  return model;
}

describe("first-look preview allow-list", () => {
  it("reads and round-trips the host fixture in the consumer/helper envelopes", () => {
    const lines = readFileSync(fixture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ConsumerMessage.parse(lines[0])).toEqual(lines[0]);
    for (const line of lines.slice(1)) expect(HelperMessage.parse(line)).toEqual(line);
    const p = FirstLookPreview.parse(lines[1]);
    expect(FirstLookPreview.safeParse({ ...p, totalChars: 19 }).success).toBe(false);
    expect(FirstLookPreview.safeParse({ ...p, windows: p.windows.map((w) => ({ ...w, lines: [...w.lines, { sent: false, text: "private" }] })) }).success).toBe(false);
  });

  it("allows redacted window text and gives withheld lines empty placeholders", () => {
    const p = new FirstLookPreviews().build(request, desk(), 1000);
    expect(p.windows).toEqual([{ bundleId: "dev.caret.fixture", appName: "Caret Fixture", title: "About me", charsSent: 18, lines: [{ text: "About me", sent: true }, { text: "Name: Dana", sent: true }, { text: "", sent: false }] }]);
    expect(p.totalChars).toBe(18);
    expect(JSON.stringify(p)).not.toContain("violet-orchard-seven");
    expect(FirstLookPreview.parse(p)).toEqual(p);
  });

  it("omits windows with nothing allowed, empty desks and families the level silences", () => {
    const previews = new FirstLookPreviews();
    expect(previews.build(request, new ScreenModel(), 1000).windows).toEqual([]);
    const model = new ScreenModel();
    model.apply(snap([text("body", "Name: Dana")], { at: 1, windowId: "secret", title: "Password: secret note" }));
    expect(previews.build(request, model, 1000)).toMatchObject({ windows: [], totalChars: 0 });
    for (const families of [[], ["loop", "routine"], ["event"]]) {
      expect(previews.build({ ...request, families, level: "quiet" }, desk(), 1000).windows).toEqual([]);
    }
  });

  it("uses the model's app deny list and app exclusions", () => {
    const model = desk();
    model.apply(snap([text("secret", "Name: Should not appear")], { at: 1, windowId: "vault", title: "Vault", app: { pid: 7, bundleId: "com.1password", name: "Vault" } }));
    expect(new FirstLookPreviews().build(request, model, 1000).windows).toHaveLength(1);
    model.setAppsOff(["dev.caret.fixture"], 2);
    expect(new FirstLookPreviews().build(request, model, 1000).windows).toEqual([]);
  });

  it("withholds secure controls without exposing their values", () => {
    const model = new ScreenModel();
    model.apply(snap([text("name", "Name: Dana"), field("secure", "violet-orchard-seven", { label: "Password", states: ["secure"] })], { at: 1, windowId: "note", title: "About me" }));
    const p = new FirstLookPreviews().build(request, model, 1000);
    expect(JSON.stringify(p)).not.toContain("violet-orchard-seven");
    expect(p.windows.flatMap((w) => w.lines).filter((l) => !l.sent).every((l) => l.text === "")).toBe(true);
  });

  it("keeps the window budget and conversation-half rule, including partial-line placeholders", () => {
    const model = new ScreenModel();
    // Distinct lines (merge of v2/access into v2/next): the output ledger charges every place a text appears and a
    // partial quote of a conversation line as the whole line, so one long line repeating a sentence could send nothing.
    const body = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} is about ordinary travel plans.`).join("\n");
    model.apply(snap([text("body", body)], { at: 1, windowId: "mail", title: "Thursday", app: { pid: 2, bundleId: "com.apple.mail", name: "Mail" } }));
    const w = model.windows.get("mail")!;
    const p = new FirstLookPreviews().build(request, model, 1000);
    expect(p.windows[0]?.charsSent).toBeLessThanOrEqual(windowBudget(w));
    expect(p.totalChars).toBeGreaterThan("Thursday".length);
    expect(p.totalChars).toBeLessThan((w.window.title.length + (w.nodes.get("body")?.label?.length ?? 0)) / 2);
    expect(p.windows[0]?.lines.some((l) => !l.sent && l.text === "")).toBe(true);
    expect(p.totalChars).toBe(p.windows.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.text.length, 0), 0));
  });

  it("rejects unknown and expired ids, but accepts the exact ten-minute boundary", () => {
    const previews = new FirstLookPreviews();
    const p = previews.build(request, desk(), 1000);
    expect(previews.lookup("missing", 1000)).toEqual({ error: "previewUnknown" });
    expect(previews.lookup(p.previewId, 1000 + PREVIEW_TTL_MS)).toHaveProperty("list");
    expect(previews.lookup(p.previewId, 1001 + PREVIEW_TTL_MS)).toEqual({ error: "previewExpired" });
  });

  it("permits an unchanged real request, but refuses changed text before a provider can run", async () => {
    const previews = new FirstLookPreviews();
    const model = desk();
    const p = previews.build(request, model, 1000);
    const approved = previews.lookup(p.previewId, 1000);
    if ("error" in approved) throw new Error(approved.error);
    const provider = vi.fn();
    await withFirstLookAllowList(approved.list, async () => {
      const w = model.windows.get("note")!;
      provider(buildLookRequest(w, model, []).req);
      model.apply(snap([text("name", "Name: Changed after preview")], { at: 2, windowId: "note", title: "About me" }));
      expect(() => provider(buildLookRequest(model.windows.get("note")!, model, []).req)).toThrow(PreviewStale);
      expect(approved.list.stale).toBe(true);
      // Even a previously allowed request is refused after the first violation.
      expect(() => provider(buildLookRequest(w, registryOf([w]), []).req)).toThrow(PreviewStale);
    });
    expect(provider).toHaveBeenCalledTimes(1);
    // Unrelated async work is not held to this look's preview.
    expect(() => buildLookRequest(model.windows.get("note")!, model, [])).not.toThrow();
  });

  it("tracks plan/memory spans and refuses unpreviewed saved values", () => {
    const model = desk();
    const w = redactWindow(model.windows.get("note")!);
    const d = new Disclosure(model);
    const plan = d.planText("Name: Dana");
    const memory = d.memoryText(null, "Name: Dana");
    expect(plan).not.toBeNull();
    expect(memory).not.toBeNull();
    expect(d.spansOfText(plan!)).not.toHaveLength(0);
    expect(d.spansOfText(memory!)).not.toHaveLength(0);
    const list = new FirstLookAllowList(d.spansOfText(d.candidate(w, "Name: Dana")!));
    expect(() => list.check(d.spansOfText(memory!), d.reasonsOf(memory!), memory!)).not.toThrow();
    const unpreviewed = d.memoryText(null, "An unpreviewed saved answer");
    expect(unpreviewed).not.toBeNull();
    expect(() => list.check(d.spansOfText(unpreviewed!), d.reasonsOf(unpreviewed!), unpreviewed!)).toThrow(PreviewStale);
  });

  it("checks original saved text even when a template surrounds it with Caret wording", () => {
    const previews = new FirstLookPreviews();
    const model = desk();
    const p = previews.build(request, model, 1000);
    const approved = previews.lookup(p.previewId, 1000);
    if ("error" in approved) throw new Error(approved.error);
    withFirstLookAllowList(approved.list, () => {
      const d = new Disclosure(model);
      const value = d.memoryText(null, "Name: Dana")!;
      expect(() => d.verify("fill.values", { questions: { q: { instructions: d.t`Saved value: ${value}` } } })).not.toThrow();
      const extra = d.memoryText(null, "Name: Dana with an unpreviewed private detail")!;
      expect(extra).not.toBeNull();
      expect(() => d.verify("fill.values", { questions: { q: { instructions: d.t`Saved value: ${extra}` } } })).toThrow(PreviewStale);
    });
  });

  it("vets sealed bytes again at the transport boundary, including after an await", async () => {
    const previews = new FirstLookPreviews();
    const model = desk();
    const p = previews.build(request, model, 1000);
    const approved = previews.lookup(p.previewId, 1000);
    if ("error" in approved) throw new Error(approved.error);
    await withFirstLookAllowList(approved.list, async () => {
      const sealed = sealRequest(buildLookRequest(model.windows.get("note")!, model, []).req).sealed;
      await Promise.resolve();
      expect(() => sendable(sealed)).not.toThrow();
      approved.list.closed = true;
      expect(() => sendable(sealed)).toThrow(PreviewStale);
    });
  });

  it("allows the approved excerpt when only an untransmitted part of its line changes", () => {
    const list = new FirstLookAllowList([{ windowId: "w", line: "Dana, old details", at: 0, len: 4 }]);
    expect(() => list.check([{ windowId: "w", line: "Dana, new details", at: 0, len: 4 }], new Set(["candidate"]), "Dana")).not.toThrow();
    expect(() => list.check([{ windowId: "w", line: "Dana, new details", at: 0, len: 17 }], new Set(["candidate"]), "Dana, new details")).toThrow(PreviewStale);
  });

  it("holds a late generator after the first look's reply closes its scope", async () => {
    const list = new FirstLookAllowList([]);
    let continueWork!: () => void;
    const wait = new Promise<void>((resolve) => { continueWork = resolve; });
    const late = withFirstLookAllowList(list, async () => {
      await wait;
      return buildLookRequest(desk().windows.get("note")!, desk(), []);
    });
    list.closed = true;
    continueWork();
    await expect(late).rejects.toThrow(PreviewStale);
  });
});

describe("preview and approval over the socket", () => {
  let dir: string;
  let helper: Helper;
  let store: Store;
  let server: HelperServer;
  let host: LineClient;
  let reader: SocketReader;
  let now: number;
  let calls: number;
  let lookNumber: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-preview-"));
    store = new Store(join(dir, "data"));
    now = 1000;
    calls = 0;
    lookNumber = 0;
    const values: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
    const fake = jevPickingText((_, instructions) => values[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null);
    server = new HelperServer(join(dir, "screen.sock"), () => helper, () => {});
    helper = new Helper({ store, askJev: (req) => { calls++; return fake(req); }, shadow: false, allowBackgroundFocus: false, now: () => now, publish: (m) => server.publish(m), sendToReader: (cmd) => server.sendToReader(cmd) });
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "preview-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    await until(() => helper.hasReader);
  });

  afterEach(async () => {
    host.close(); reader.close(); helper.shutdown();
    await server.close(); helper.memory.close(); store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function preview(): Promise<FirstLookPreview> {
    host.send(request);
    return FirstLookPreview.parse(await host.waitFor((m) => m.type === "firstLookPreview" && m.requestId === request.requestId));
  }
  async function look(previewId: string | null): Promise<FirstLookReply> {
    const requestId = `look-${++lookNumber}`;
    host.send({ type: "firstLook", v: PROTOCOL_VERSION, requestId, at: now, families: ["fill"], level: "balanced", deadlineMs: 8000, previewId });
    return FirstLookReply.parse(await host.waitFor((m) => m.type === "firstLookReply" && m.requestId === requestId, 10000));
  }

  it("builds a preview without provider calls or reader walks", async () => {
    await reader.replay(loadRecording("offers-fill.ndjson").filter((m) => m.type === "snapshot"), { applied: (id, at) => helper.model.windows.get(id)?.updatedAt === at, tick: () => {} });
    const before = calls;
    const walks = reader.verbs.length;
    const p = await preview();
    expect(p.totalChars).toBeGreaterThan(0);
    expect(calls).toBe(before);
    expect(reader.verbs).toHaveLength(walks);
  });

  it("returns firstLookReply errors for unknown and expired ids without sending", async () => {
    expect(await look("unknown")).toMatchObject({ outcome: "error", error: "previewUnknown", found: null });
    const p = await preview();
    now += PREVIEW_TTL_MS + 1;
    expect(await look(p.previewId)).toMatchObject({ outcome: "error", error: "previewExpired", found: null });
    expect(calls).toBe(0);
  });

  it("returns nothing for an approved empty screen", async () => {
    const p = await preview();
    expect(await look(p.previewId)).toMatchObject({ outcome: "nothing", error: null });
    expect(calls).toBe(0);
  });

  it("finds a grounded fill when the unchanged requests fit the preview", async () => {
    await reader.replay(loadRecording("offers-fill.ndjson").filter((m) => m.type === "snapshot"), { applied: (id, at) => helper.model.windows.get(id)?.updatedAt === at, tick: () => {} });
    const p = await preview();
    expect(await look(p.previewId)).toMatchObject({ outcome: "found", error: null, found: { kind: "fill" } });
    expect(calls).toBeGreaterThan(0);
  });

  it("returns previewStale when newly opened windows would leave the allow-list", async () => {
    const p = await preview();
    await reader.replay(loadRecording("offers-fill.ndjson").filter((m) => m.type === "snapshot"), { applied: (id, at) => helper.model.windows.get(id)?.updatedAt === at, tick: () => {} });
    calls = 0;
    expect(await look(p.previewId)).toMatchObject({ outcome: "error", error: "previewStale", found: null });
    expect(calls).toBe(0);
  });
});

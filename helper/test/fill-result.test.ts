// The host's fillResult: an insert marks the field's transfer as Caret's, whichever arrives first,
// and an undo removes that transfer from the log and the store again.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type FillProposal, type FillResult, type HelperMessage } from "../src/protocol.ts";
import { SETTLE_MS } from "../src/transfers.ts";
import { field, jevPickingText, MAIL_APP, snap, text } from "./builders.ts";

const SRC = "6160-1";
const FORM = "5150-1";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
const VALUE = "dana.whitfield@example.com";

describe("fillResult", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let sent: HelperMessage[];
  let t0: number;
  let proposal: FillProposal;

  const showForm = (at: number, value: string): void => {
    void helper.handleReader(snap([field(EMAIL, value, { label: "Email", frame: [100, 40, 200, 24] })], { at, windowId: FORM, title: "Claim form", focused: true }));
  };
  const result = (outcome: FillResult["outcome"], at: number, extra: Partial<FillResult> = {}): void =>
    helper.handleFillResult({ type: "fillResult", v: PROTOCOL_VERSION, at, proposalId: proposal.id, windowId: FORM, fieldKey: EMAIL, outcome, reason: null, method: "pastePid", valueLength: VALUE.length, ...extra });
  const errors = (): string[] => sent.flatMap((m) => (m.type === "error" ? [m.message] : []));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-fill-result-"));
    store = new Store(dir);
    sent = [];
    helper = new Helper({ store, askJev: jevPickingText(() => VALUE), shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m) });
    t0 = Date.now();
    void helper.handleReader(snap([text("m/statictext:sig~0", `Dana Whitfield\n${VALUE}`)], { at: t0 - 5000, windowId: SRC, app: MAIL_APP, title: "Signature" }));
    showForm(t0 - 4000, "");
    proposal = (await helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL }))!;
    expect(proposal.fields[0]?.value).toBe(VALUE);
    expect(proposal.pid).toBe(5150);
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks the transfer as Caret's when the result arrives before the transfer is judged, and undo removes it", () => {
    showForm(t0, VALUE);
    result("inserted", t0 + 20);
    helper.tick(t0 + SETTLE_MS + 10);
    expect(helper.recentTransfers.map((t) => [t.value, t.attribution])).toEqual([[VALUE, "caret"]]);
    expect(store.transfers().map((r) => r.attribution)).toEqual(["caret"]);
    result("undone", t0 + 3000);
    expect(helper.recentTransfers).toEqual([]);
    expect(store.transfers()).toEqual([]);
    expect(errors()).toEqual([]);
  });

  it("re-attributes a transfer already judged when the result comes late", () => {
    showForm(t0, VALUE);
    helper.tick(t0 + SETTLE_MS + 10);
    expect(store.transfers().map((r) => r.attribution)).toEqual(["user"]);
    result("inserted", t0 + SETTLE_MS + 50);
    expect(helper.recentTransfers[0]?.attribution).toBe("caret");
    expect(store.transfers().map((r) => r.attribution)).toEqual(["caret"]);
  });

  it("logs nothing for a fill undone before its transfer was judged", () => {
    showForm(t0, VALUE);
    result("inserted", t0 + 20);
    result("undone", t0 + 500);
    helper.tick(t0 + SETTLE_MS + 10);
    expect(helper.recentTransfers).toEqual([]);
    expect(store.transfers()).toEqual([]);
  });

  it("leaves a user's own entry alone and only counts rejected and failed results", () => {
    result("rejected", t0, { reason: "the field changed" });
    result("failed", t0, { method: null });
    showForm(t0, VALUE);
    helper.tick(t0 + SETTLE_MS + 10);
    expect(store.transfers().map((r) => r.attribution)).toEqual(["user"]);
    store.flush();
    expect(store.counts()).toMatchObject({ "fill.result_rejected": 1, "fill.result_failed": 1 });
  });

  it("rejects a result for a proposal, window or field it never proposed", () => {
    result("inserted", t0, { proposalId: "nope" });
    result("inserted", t0, { windowId: "5150-9" });
    result("inserted", t0, { fieldKey: "dev.caret.fixture/standard/textfield:phone~0" });
    result("undone", t0);
    expect(errors()).toEqual([
      "fillResult: unknown or expired proposal nope",
      `fillResult: proposal ${proposal.id} is for window ${FORM}, not 5150-9`,
      `fillResult: proposal ${proposal.id} proposed no value for dev.caret.fixture/standard/textfield:phone~0`,
      `fillResult: undone for ${EMAIL}, but no insert of proposal ${proposal.id} was reported`,
    ]);
  });
});

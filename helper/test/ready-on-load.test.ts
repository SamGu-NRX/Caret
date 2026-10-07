// P3, ready on load: a page that loads with a form gets the Fill all offer with no focus, once per document, but only
// when code finds two empty fields with a candidate from memory or the window the user left (lead decision). A
// search box, a login form's credentials and a payment form never count, and none of them sends a Jev request. Every
// name and value is invented.
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import type { HelperMessage, Node, PageControl } from "../src/protocol.ts";
import type { AboutValue } from "../src/fill/about.ts";
import { readyOnLoad } from "../src/offers/ready-on-load.ts";
import { field, node, snap, text } from "./builders.ts";
import { c, chrome, mixedControls, NOTE, WIN } from "./fake-page.ts";
import { closeRigs, rig, type Rig } from "./page-rig.ts";
import type { Store } from "../src/store.ts";

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const PAGE_APP = { pid: 4100, bundleId: "com.google.chrome.for.testing", name: "Google Chrome for Testing" };

/** A page window with these fields, after the user was in a note with `note` (null: no window before it). */
function scene(fields: Node[], note: string | null, other?: string): ScreenModel {
  const m = new ScreenModel();
  if (other !== undefined) m.apply(snap([text("o/t", other)], { at: 500, windowId: "other", title: "Other note", app: NOTE_APP, focused: true }));
  if (note !== null) m.apply(snap([text("n/t", note)], { at: 1000, windowId: "note", title: "Details", app: NOTE_APP, focused: true }));
  m.apply(snap([node("web", "AXWebArea"), ...fields.map((f) => ({ ...f, parent: "web" }))], { at: 2000, windowId: "page", title: "Apply", app: PAGE_APP, focused: true, kind: "page" }));
  return m;
}

const tf = (key: string, label: string, extra: Partial<Node> = {}): Node => field(key, "", { label, ...extra });
const verdict = (m: ScreenModel, about: AboutValue[] = [], excluded = {}) => readyOnLoad(m, m.windows.get("page") as never, about, { excluded });

describe("the check before a page load's Fill all asks Jev", () => {
  it("fires for two empty fields the window the user left has values for, from the first", () => {
    const m = scene([tf("f/name", "Full name"), tf("f/email", "Email"), tf("f/fav", "Favorite color")], "Full name: Robin Vale\nEmail: robin@example.test");
    expect(verdict(m)).toEqual({ fires: true, trigger: "f/name", fields: ["f/name", "f/email"] });
  });

  it("does not fire for one field with a candidate", () => {
    const m = scene([tf("f/name", "Full name"), tf("f/fav", "Favorite color")], "Full name: Robin Vale");
    expect(verdict(m)).toMatchObject({ fires: false, why: "fewCandidates", fields: ["f/name"] });
  });

  it("counts what the user told Caret as a candidate", () => {
    const m = scene([tf("f/name", "Full name"), tf("f/email", "Email")], null);
    const about: AboutValue[] = [
      { id: "a1", label: "Name", value: "Robin Vale", kind: "name" },
      { id: "a2", label: "Email", value: "robin@example.test", kind: "email" },
    ];
    expect(verdict(m, about)).toMatchObject({ fires: true, trigger: "f/name" });
    expect(verdict(m)).toMatchObject({ fires: false, why: "fewCandidates" });
  });

  it("reads only the window the user left, not every open window", () => {
    // The values are in a window the user was in before the one they left.
    const m = scene([tf("f/name", "Full name"), tf("f/email", "Email")], "Shopping: eggs, milk", "Full name: Robin Vale\nEmail: robin@example.test");
    expect(verdict(m)).toMatchObject({ fires: false, why: "fewCandidates", fields: [] });
  });

  it("never counts a search box, however its name matches a line", () => {
    const m = scene([tf("f/q", "Search jobs"), tf("f/site", "", { placeholder: "Find a location", role: "AXSearchField" })], "Search jobs: robotics\nLocation: Denver");
    expect(verdict(m)).toMatchObject({ fires: false, why: "noFields" });
  });

  it("counts no credential on a page with a login form: a password the page engine left out", () => {
    const m = scene([tf("f/user", "Email or username"), tf("f/phone", "Phone")], "Email or username: robin@example.test\nPhone: 555-0147");
    expect(verdict(m, [], { password: 1 })).toMatchObject({ fires: false, why: "noFields" });
    // Without the password, the same page is a contact form.
    expect(verdict(m)).toMatchObject({ fires: true });
  });

  it("counts no credential beside a native password field", () => {
    const m = scene([tf("f/user", "Username"), tf("f/email", "Email"), field("f/pw", "", { label: "Password", role: "AXSecureTextField", states: ["secure"] })], "Username: rvale\nEmail: robin@example.test");
    expect(verdict(m)).toMatchObject({ fires: false });
  });

  it("never fires on a page with a payment form, whatever else it asks", () => {
    const m = scene([tf("f/name", "Full name"), tf("f/email", "Email"), tf("f/card", "Name on card")], "Full name: Robin Vale\nEmail: robin@example.test");
    expect(verdict(m, [], { payment: 1 })).toEqual({ fires: false, why: "payment", fields: [] });
    const typed = scene([tf("f/name", "Full name"), tf("f/email", "Email"), tf("f/cc", "Card number")], "Full name: Robin Vale\nEmail: robin@example.test");
    expect(verdict(typed)).toEqual({ fires: false, why: "payment", fields: [] });
  });

  it("does not count a payment form's own fields when only its card number was left out", () => {
    const m = scene([tf("f/holder", "Cardholder name"), tf("f/billing", "Billing ZIP")], "Cardholder name: Robin Vale\nBilling ZIP: 80202");
    expect(verdict(m)).toMatchObject({ fires: false, why: "noFields" });
  });
});

describe("a page load in the helper (P3)", () => {
  afterEach(closeRigs);

  /** The tab loads a new document with no field in focus, and the worker reports it as it reports focus. */
  async function load(r: Rig, make: () => PageControl[], title: string, path: string): Promise<void> {
    r.page.focusedId = null;
    r.page.goTo(make, title, path);
    r.page.session.receive({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 });
    for (let i = 0; i < 20; i++) await new Promise((x) => setTimeout(x, 5));
    await r.helper.routedSettled;
  }
  const popups = (r: Rig): HelperMessage[] => r.published.filter((m) => m.type === "popup");

  async function ready(o: Parameters<typeof rig>[0] = {}): Promise<Rig> {
    const r = await rig(o);
    r.helper.model.frontmostPid = chrome.pid;
    r.asked.length = 0;
    return r;
  }

  it("offers Fill all for a form with no focus, once per document, and again for the next document", async () => {
    const r = await ready();
    await load(r, mixedControls, "Apply: Mixed controls", "/mixed");
    expect(popups(r)).toHaveLength(1);
    const asked = r.asked.length;
    expect(asked).toBeGreaterThan(0);
    // The same document walked again (the user's focus moving, another report): no second ask.
    r.page.session.receive({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 });
    for (let i = 0; i < 10; i++) await new Promise((x) => setTimeout(x, 5));
    expect(r.asked.length).toBe(asked);
    expect(popups(r)).toHaveLength(1);
    // A new document is asked for once more.
    await load(r, () => [c("n1", "text", "Full name", { value: "" }), c("n2", "email", "Email", { value: "" })], "Apply: step 2", "/two");
    expect(r.asked.length).toBeGreaterThan(asked);
  });

  it("sends no Jev request for a page whose only field is a search box", async () => {
    const r = await ready();
    // Two search boxes, as a jobs site has (what, where), and the note the user left has lines for both.
    await r.setNote(`${NOTE}\nSearch jobs: robotics\nSearch location: Denver`);
    await load(r, () => [c("s1", "search", "Search jobs", { value: "" }), c("s2", "search", "Search location", { value: "" }), c("s3", "button", "Search")], "Jobs", "/search");
    expect(r.asked).toEqual([]);
    expect(popups(r)).toEqual([]);
  });

  it("sends no Jev request for a login page", async () => {
    const r = await ready();
    r.page.focusedId = null;
    const login = (): PageControl[] => [c("l1", "email", "Email", { value: "" }), c("l0", "text", "Username", { value: "" }), c("l2", "button", "Sign in")];
    await r.setNote(`${NOTE}\nUsername: rvale`);
    r.page.goTo(login, "Sign in", "/login");
    // The walker never reports a password field; it says how many it left out.
    const snapshot = r.page.snapshot.bind(r.page);
    r.page.snapshot = (id) => {
      const s = snapshot(id);
      return { ...s, frames: s.frames.map((f) => ({ ...f, excluded: { password: 1 } })) };
    };
    r.page.session.receive({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 });
    for (let i = 0; i < 20; i++) await new Promise((x) => setTimeout(x, 5));
    expect(r.asked).toEqual([]);
  });

  // I6 item 4: P3's eval read W4's five saved pages 0 of 5. The code check fires on all five (evidence/screen/i6
  // probe/load-w4.txt); the eval loaded them after four corpus pages had spent the hour's four offers, and the hourly
  // budget holds a load before the check. The budget is the user's setting and stays; the hold is now counted.
  // Each page's form is its own (another form id), as each saved page's is: one form's repeat would be covered anyway.
  const inForm = (i: number, x: PageControl): PageControl => ({ ...x, key: x.key.replace("form[apply]", `form[p${i}]`), form: `form#p${i}` });
  const five = (i: number) => (): PageControl[] => [inForm(i, c(`p${i}a`, "text", "Full name", { value: "" })), inForm(i, c(`p${i}b`, "email", "Email", { value: "" }))];
  const counts = (r: Rig): Record<string, number> => {
    const store = (r.helper as unknown as { opts: { store: Store } }).opts.store;
    store.flush();
    return store.counts();
  };

  it("holds a fifth page's load in the hour before the check, and counts the hold", async () => {
    const r = await ready();
    for (let i = 1; i <= 5; i++) await load(r, five(i), `Apply: step ${i}`, `/s${i}`);
    expect(popups(r)).toHaveLength(4);
    expect(counts(r)["fill.load_held_hourlyBudget"]).toBe(1);
    expect(counts(r)["fill.load"]).toBe(4);
  });

  it("measures every page on its own when the budget is lifted, as the load eval runs", async () => {
    const r = await ready({ offersPerHour: 1000 });
    for (let i = 1; i <= 6; i++) await load(r, five(i), `Apply: step ${i}`, `/s${i}`);
    expect(popups(r)).toHaveLength(6);
    expect(counts(r)["fill.load_held_hourlyBudget"]).toBeUndefined();
  });

  it("leaves a page a carried goal is planning to that goal", async () => {
    const r = await ready();
    const s = await r.ask("fill out this form from my note");
    if (s.event !== "segment") throw new Error("no preview");
    await r.accept(s);
    await r.helper.goals.idle();
    await new Promise((x) => setTimeout(x, 0));
    await r.helper.goals.idle();
    // The user's Next, which the reader saw (I2 ruling: a carry needs an observed Next), then the next page loads.
    await r.helper.handleReader({ type: "userPress", v: PROTOCOL_VERSION, at: Date.now(), pid: chrome.pid, windowId: WIN, key: null, role: "AXButton", label: "Next", via: "click" });
    await load(r, () => [c("n1", "text", "Full name", { value: "" }), c("n2", "email", "Email", { value: "" })], "Apply: step 2", "/two");
    await r.helper.goals.idle();
    expect(popups(r)).toEqual([]);
    expect(r.published.some((m) => m.type === "goalProgress" && m.event === "segment" && m.reason === "nextPage")).toBe(true);
  });
});


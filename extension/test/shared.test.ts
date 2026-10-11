// The extension's pure pieces: the press table against the cases the helper and the reader share, identifier rules,
// the grant table, the frame registry, the bridge message checks and the combobox's option matching. DOM behavior is checked in a real browser by
// fixtures/web-form/accept.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyPress, RISK_TABLE, SAFE_PRESSES } from "../src/shared/risk.ts";
import { authorIdentifier, isGeneratedId, strongKey } from "../src/shared/ids.ts";
import { GRANT_MAX_MS, GrantTable } from "../src/shared/grants.ts";
import { NavGens, frameOrigin } from "../src/worker/frames.ts";
import { Chunks, parseFromHelper } from "../src/worker/wire.ts";
import { matchOptions, normalizeName, whyNoPick } from "../src/shared/choose.ts";

const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../helper/fixtures/golden/press-risk.json", import.meta.url)), "utf8")) as {
  cases: { label: string; windowSubrole: string | null; bundleId: string; risk: string }[];
};
const helperRisk = readFileSync(fileURLToPath(new URL("../../helper/src/executor/risk.ts", import.meta.url)), "utf8");

describe("press risk", () => {
  it("agrees with every shared case outside a system prompt (pages have no window subrole or prompt process)", () => {
    const pageCases = golden.cases.filter((c) => !/System(Dialog|FloatingWindow)/.test(c.windowSubrole ?? "") && !c.bundleId.startsWith("com.apple."));
    expect(pageCases.length).toBeGreaterThan(5);
    for (const c of pageCases) expect(classifyPress(c.label), c.label).toBe(c.risk);
  });

  it("holds the helper's table word for word", () => {
    for (const words of Object.values(RISK_TABLE)) for (const w of words) expect(helperRisk).toContain(`"${w}"`);
    for (const w of SAFE_PRESSES) expect(helperRisk).toContain(`"${w}"`);
  });

  it("hands off Submit, Pay now and an unknown label, and presses only a whole safe name", () => {
    expect(classifyPress("Submit")).toBe("outbound");
    expect(classifyPress("Submit application")).toBe("outbound");
    expect(classifyPress("Pay now")).toBe("money");
    expect(classifyPress("Continue")).toBe("unclassified");
    expect(classifyPress("  Next   page ")).toBe("safe");
    expect(classifyPress("Next and submit")).toBe("outbound");
  });
});

describe("author identifiers", () => {
  it("rejects identifiers frameworks generate", () => {
    for (const id of [":r1:", ":R2b:", "«r3»", "mui-123", "react-select-4-input", "radix-:r5:", "headlessui-listbox-7", "ember42", "field-8f3a9c2b1d4e", "input_1700000123"]) expect(isGeneratedId(id), id).toBe(true);
  });
  it("keeps identifiers people write, including Greenhouse and Workday shapes", () => {
    for (const id of ["job_application[first_name]", "first_name", "email", "legalNameSection_firstName", "address-city", "q1"]) expect(isGeneratedId(id), id).toBe(false);
  });
  it("takes name, then id, then data-automation-id, skipping generated ones", () => {
    expect(authorIdentifier({ name: ":r1:", id: "email", automationId: "x" })).toBe("id=email");
    expect(authorIdentifier({ name: null, id: "mui-3", automationId: "legalNameSection_firstName" })).toBe("data-automation-id=legalNameSection_firstName");
    expect(authorIdentifier({ name: ":r1:", id: "mui-3", automationId: null })).toBeNull();
  });
  it("makes a strong key only with an author identifier", () => {
    expect(strongKey("http://a", "form#apply", "name=first", "text")).toBe('["http://a","form#apply","name=first","text"]');
    expect(strongKey("http://a", null, "name=first", "text")).toBe('["http://a",null,"name=first","text"]');
    expect(strongKey("http://a", "form#apply", null, "text")).toBeNull();
  });
  it("cannot be forged by moving a separator between page-controlled parts (review #7)", () => {
    expect(strongKey("http://a", "form#a|name=b", "name=c", "text")).not.toBe(strongKey("http://a", "form#a", "name=b|name=c", "text"));
  });
});

describe("grant table", () => {
  const page = (o: Partial<Record<string, unknown>> = {}) => ({ kind: "page", engine: "e1", tabId: 7, frameId: 0, origin: "http://127.0.0.1:4310", navGen: 1, ...o });
  function table(start = 1_000_000) {
    const clock = { wall: start, mono: 50 };
    return { t: new GrantTable({ wall: () => clock.wall, mono: () => clock.mono }), clock };
  }

  it("covers its task in its own tab and frame only", () => {
    const { t, clock } = table();
    expect(t.grant("t1", page(), clock.wall + 10_000, "e1")).toBeNull();
    expect(t.check("t1", 7, 0)).toMatchObject({ ok: true, scope: { navGen: 1 } });
    expect(t.check("t1", 7, 3).ok).toBe(false);
    expect(t.check("t1", 8, 0).ok).toBe(false);
    expect(t.check("t2", 7, 0).ok).toBe(false);
  });

  it("refuses a grant for another engine, a native scope, or before the engine is known", () => {
    const { t, clock } = table();
    expect(t.grant("t1", page({ engine: "e2" }), clock.wall + 1000, "e1")).toMatch(/engine e2/);
    expect(t.grant("t1", { kind: "native", pid: 1, windowId: "1-1" }, clock.wall + 1000, "e1")).toMatch(/native/);
    expect(t.grant("t1", page(), clock.wall + 1000, null)).not.toBeNull();
    expect(t.check("t1", 7, 0).ok).toBe(false);
  });

  it("ends at its expiry, and 120 s after arrival on the monotonic clock even if the wall clock is set back", () => {
    const { t, clock } = table();
    t.grant("t1", page(), clock.wall + 5000, "e1");
    clock.wall += 5000;
    expect(t.check("t1", 7, 0).ok).toBe(false);
    t.grant("t2", page(), clock.wall + GRANT_MAX_MS * 10, "e1");
    clock.mono += GRANT_MAX_MS - 1;
    expect(t.check("t2", 7, 0).ok).toBe(true);
    clock.wall -= 3_600_000;
    clock.mono += 1;
    expect(t.check("t2", 7, 0)).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
  });

  it("is gone after a revoke and after clear (the port closed)", () => {
    const { t, clock } = table();
    t.grant("t1", page(), clock.wall + 10_000, "e1");
    t.grant("t1", page({ frameId: 3 }), clock.wall + 10_000, "e1");
    t.revoke("t1");
    expect(t.check("t1", 7, 0).ok).toBe(false);
    expect(t.check("t1", 7, 3).ok).toBe(false);
    t.grant("t2", page(), clock.wall + 10_000, "e1");
    t.clear();
    expect(t.check("t2", 7, 0).ok).toBe(false);
  });

  it("hands the content script the earlier of the two ends as its deadline", () => {
    const { t, clock } = table();
    t.grant("t1", page(), clock.wall + 5000, "e1");
    expect(t.check("t1", 7, 0)).toMatchObject({ ok: true, expires: clock.wall + 5000 });
  });
});

describe("frames", () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: "http://127.0.0.1:4310/form?x=1#y" },
    { frameId: 2, parentFrameId: 0, url: "about:srcdoc" },
    { frameId: 3, parentFrameId: 0, url: "http://127.0.0.1:4311/embed" },
    { frameId: 4, parentFrameId: -1, url: "chrome://newtab/" },
  ];
  it("gives about: frames their parent's origin, and none to non-web frames", () => {
    expect(frameOrigin(frames, 0)).toBe("http://127.0.0.1:4310");
    expect(frameOrigin(frames, 2)).toBe("http://127.0.0.1:4310");
    expect(frameOrigin(frames, 3)).toBe("http://127.0.0.1:4311");
    expect(frameOrigin(frames, 4)).toBeNull();
    expect(frameOrigin(frames, 9)).toBeNull();
  });
  it("counts navigations per frame, from 1", () => {
    const g = new NavGens();
    expect(g.get(7, 0)).toBe(1);
    expect(g.bump(7, 0)).toBe(2);
    expect(g.get(7, 3)).toBe(1);
    g.forgetTab(7);
    expect(g.get(7, 0)).toBe(1);
  });
});

describe("bridge messages", () => {
  const write = { kind: "pageWrite", tabId: 7, frameId: 0, documentId: "D", id: "e1", control: "text", name: "First name", taskId: "t1", expect: "", value: "Ada" };
  it("accepts the shapes it routes", () => {
    expect(parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb: write })).toMatchObject({ type: "pageCommand", verb: { kind: "pageWrite" } });
    expect(parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb: { kind: "pageWalk", tabId: null } })).not.toBeNull();
    expect(parseFromHelper({ type: "engineReady", v: 1, engine: "e" })).toEqual({ type: "engineReady", engine: "e" });
  });
  it("drops a mutating verb with no task, a bad control kind, a walk with a fractional tab, and unknown types", () => {
    const { taskId: _t, ...noTask } = write;
    expect(parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb: noTask })).toBeNull();
    expect(parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb: { ...write, control: "password" } })).toBeNull();
    expect(parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb: { kind: "pageWalk", tabId: 1.5 } })).toBeNull();
    expect(parseFromHelper({ type: "engineHello", v: 1 })).toBeNull();
    expect(parseFromHelper({ type: "scopedActGrant", v: 1, taskId: "t", scope: { kind: "page", engine: "e" }, at: 1, expires: 2 })).toBeNull();
  });
  it("joins chunks in order, and starts over on a gap", () => {
    const c = new Chunks();
    expect(c.add({ id: "k1", index: 0, count: 3, data: "ab" })).toBeNull();
    expect(c.add({ id: "k1", index: 1, count: 3, data: "cd" })).toBeNull();
    expect(c.add({ id: "k1", index: 2, count: 3, data: "e" })).toBe("abcde");
    expect(c.add({ id: "k2", index: 0, count: 2, data: "x" })).toBeNull();
    expect(c.add({ id: "k2", index: 0, count: 2, data: "y" })).toBeNull();
    expect(c.add({ id: "k3", index: 1, count: 2, data: "z" })).toBeNull();
  });
});

describe("W2 bridge messages", () => {
  const target = { tabId: 7, frameId: 0, documentId: "D", id: "e6", control: "file", name: "Resume", taskId: "t1" };
  const file = { name: "resume.pdf", type: "application/pdf", size: 9, sha256: "e5c62df5dab5c87b6a015ef3d43597074d1eec433b15f51aec63b8582d0e4ab4", data: "JVBERi0xLjQK" };
  it("routes an attach only with its bytes and a bare file name", () => {
    const cmd = (f: object) => parseFromHelper({ type: "pageCommand", v: 1, id: "c", expires: 5, verb: { kind: "pageAttachFile", ...target, file: f } });
    expect(cmd(file)).not.toBeNull();
    const { data: _d, ...noData } = file;
    expect(cmd(noData)).toBeNull();
    expect(cmd({ ...file, data: "%%%" })).toBeNull();
    expect(cmd({ ...file, name: "../../etc/passwd" })).toBeNull();
    expect(cmd({ ...file, name: "a\\b" })).toBeNull();
  });
  it("takes Not on this site as a list of http(s) origins and nothing else", () => {
    expect(parseFromHelper({ type: "pageSitesOff", v: 1, origins: ["http://127.0.0.1:4310", "https://jobs.example.test"] })).toEqual({ type: "pageSitesOff", origins: ["http://127.0.0.1:4310", "https://jobs.example.test"] });
    expect(parseFromHelper({ type: "pageSitesOff", v: 1, origins: [] })).toEqual({ type: "pageSitesOff", origins: [] });
    expect(parseFromHelper({ type: "pageSitesOff", v: 1, origins: ["https://jobs.example.test/apply"] })).toBeNull();
    expect(parseFromHelper({ type: "pageSitesOff", v: 1, origins: "https://jobs.example.test" })).toBeNull();
    expect(parseFromHelper({ type: "pageSitesOff", v: 1, origins: [7] })).toBeNull();
  });
});

describe("combobox option matching", () => {
  const opts = ["United States", "United States Minor Outlying Islands", "Canada", "Mexico"].map((name) => ({ name }));
  it("picks the one option named exactly the value, case and spacing aside", () => {
    const m = matchOptions(opts, "  united   STATES ");
    expect(m.exact.map((o) => o.name)).toEqual(["United States"]);
    expect(whyNoPick(m, "united states")).toBeNull();
    expect(normalizeName("Ｕｎｉｔｅｄ States")).toBe("united states");
  });
  it("stops on a filter two options contain, and names both", () => {
    const why = whyNoPick(matchOptions(opts, "United"), "United");
    expect(why).toContain("'United States'");
    expect(why).toContain("'United States Minor Outlying Islands'");
    expect(why).toContain("2 options");
  });
  it("stops on two options with the same name, on one that only contains it, and on none", () => {
    expect(whyNoPick(matchOptions([{ name: "Springfield" }, { name: "springfield" }], "Springfield"), "Springfield")).toContain("2 options are named");
    expect(whyNoPick(matchOptions(opts, "Can"), "Can")).toContain("no option is named exactly 'Can'");
    expect(whyNoPick(matchOptions(opts, "USA"), "USA")).toBe("no option in the list matches 'USA'");
    expect(whyNoPick(matchOptions(opts, ""), "")).toBe("no option in the list matches ''");
  });
});

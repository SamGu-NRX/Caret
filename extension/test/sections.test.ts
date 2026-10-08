// SCP1: the sections each control sits in (content/sections.ts), as occurrences, on small page trees. The extension's
// tests run without a DOM, so the trees are plain objects with the members sectionOutline reads; the walk in a real page
// is walker.ts's. A synthetic service form; every heading is invented.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { frameHeadings, MAX_OCCURRENCES, MAX_SECTIONS, Outline, sectionOutline, type OutlineElement, type OutlineReader } from "../src/content/sections.ts";
import { SELF_IDENTIFICATION } from "../src/content/walker.ts";

interface El extends OutlineElement<El> {
  readonly attrs: Record<string, string>;
  readonly kids: El[];
  shadow: El[] | null;
  readonly name: string;
}

/** An element: its tag, attributes (`name` marks a control by name in the result), own text and children. */
function el(localName: string, attrs: Record<string, string> = {}, ...kids: (El | string)[]): El {
  const children = kids.filter((k): k is El => typeof k !== "string");
  const own = kids.filter((k): k is string => typeof k === "string").join(" ");
  return {
    localName,
    attrs,
    kids: children,
    shadow: null,
    name: attrs.name ?? "",
    children,
    get textContent() {
      return [own, ...children.map((c) => c.textContent ?? "")].filter((t) => t !== "").join(" ");
    },
    getAttribute: (n: string) => attrs[n] ?? null,
  };
}
const input = (name: string, attrs: Record<string, string> = {}): El => el("input", { name, ...attrs });
const host = (tag: string, light: El[], shadow: El[]): El => {
  const h = el(tag, {}, ...light);
  h.shadow = shadow;
  return h;
};

function all(root: El): El[] {
  return [root, ...root.kids.flatMap(all), ...(root.shadow ?? []).flatMap(all)];
}

/** Each control's sections, by the text of each occurrence ("(excluded)" for one with none), and the occurrences. */
function walk(...body: El[]) {
  const doc = el("body", {}, ...body);
  const everything = all(doc);
  const reader: OutlineReader<El> = {
    wanted: (e) => e.localName === "input",
    shown: (e) => e.attrs.hidden === undefined,
    labelledBy: (_e, ids) => ids.split(/\s+/).flatMap((id) => everything.find((x) => x.attrs.id === id) ?? []),
    shadowRoot: (e) => (e.shadow === null ? null : { children: e.shadow }),
    // A slot's assigned elements: the host's light children whose slot attribute names it (default: none).
    assigned: (e) => {
      if (e.localName !== "slot") return null;
      const owner = everything.find((h) => h.shadow !== null && all({ ...h, kids: [], shadow: h.shadow } as El).includes(e));
      const named = e.attrs.name ?? "";
      const got = (owner?.kids ?? []).filter((k) => (k.attrs.slot ?? "") === named);
      return got.length > 0 ? got : e.kids;
    },
    excluded: (text) => SELF_IDENTIFICATION.test(text),
  };
  const r = sectionOutline(doc, reader);
  const text = new Map(r.occurrences.map((o) => [o.id, o.text ?? "(excluded)"]));
  const chains: Record<string, string[]> = {};
  for (const [e, ids] of r.chains) {
    if (e.name in chains) throw new Error(`control ${e.name} was walked twice`);
    chains[e.name] = ids.map((id) => text.get(id) ?? id);
  }
  return { chains, occurrences: r.occurrences, ids: Object.fromEntries([...r.chains].map(([e, ids]) => [e.name, ids])) };
}

describe("the sections a control sits in", () => {
  it("is its fieldset's legend", () => {
    expect(walk(el("form", {}, el("fieldset", {}, el("legend", {}, "Equipment details"), input("serial")), el("fieldset", {}, el("legend", {}, "Service contact"), input("phone")))).chains).toEqual({ serial: ["Equipment details"], phone: ["Service contact"] });
  });

  it("is the heading before it, and the next heading of its rank ends that section", () => {
    expect(walk(el("form", {}, el("h2", {}, "Equipment details"), el("div", {}, input("serial")), el("h2", {}, "Service contact"), el("div", {}, input("phone")))).chains).toEqual({ serial: ["Equipment details"], phone: ["Service contact"] });
  });

  it("nests a subheading under its section, and keeps the page title over everything", () => {
    const r = walk(el("h1", {}, "Service request"), el("form", {}, el("h2", {}, "Equipment details"), input("serial"), el("h3", {}, "Warranty"), input("warranty"), el("h2", {}, "Service contact"), input("phone")));
    expect(r.chains).toEqual({ serial: ["Service request", "Equipment details"], warranty: ["Service request", "Equipment details", "Warranty"], phone: ["Service request", "Service contact"] });
  });

  it("is the heading section and the radio group's legend inside it, outermost first", () => {
    expect(walk(el("form", {}, el("h2", {}, "Service contact"), input("phone"), el("fieldset", {}, el("legend", {}, "How should we reach you?"), input("text"), input("call")))).chains).toEqual({
      phone: ["Service contact"],
      text: ["Service contact", "How should we reach you?"],
      call: ["Service contact", "How should we reach you?"],
    });
  });

  // Review P1 1: a container's own heading suppresses the inherited heading of its rank.
  it("lets a container's own heading replace the inherited one of its rank or deeper, not a higher one", () => {
    const r = walk(
      el("h1", {}, "Service request"),
      el("h2", {}, "Equipment details"),
      input("serial"),
      el("section", {}, el("h2", {}, "Service contact"), input("phone")),
      el("section", {}, el("h3", {}, "Warranty"), input("warranty")),
    );
    expect(r.chains).toEqual({ serial: ["Service request", "Equipment details"], phone: ["Service request", "Service contact"], warranty: ["Service request", "Equipment details", "Warranty"] });
  });

  it("ends a heading with its container, and takes a region's own label", () => {
    const r = walk(
      el("aside", {}, el("h2", {}, "Need help?"), input("search")),
      el("form", {}, input("first")),
      el("section", { "aria-labelledby": "billing-title" }, el("h2", { id: "billing-title" }, "Billing"), input("card-name")),
      el("div", { role: "group", "aria-label": "Preferred time" }, input("time")),
      el("span", { id: "pay-label" }, "Payment"),
      el("div", { role: "region", "aria-labelledby": "pay-label" }, input("card")),
    );
    // A section labelled by its own heading is that heading's one occurrence; one labelled by other text has its own.
    expect(r.chains).toEqual({ search: ["Need help?"], first: [], "card-name": ["Billing"], time: ["Preferred time"], card: ["Payment"] });
    expect(r.occurrences.filter((o) => o.text === "Billing")).toHaveLength(1);
  });

  it("is none for a control before any heading, in no labelled group", () => {
    expect(walk(el("form", {}, input("early"), el("h2", {}, "Equipment details"), input("serial"))).chains).toEqual({ early: [], serial: ["Equipment details"] });
  });

  // Review P1 3: two headings that read alike are two sections.
  it("gives two headings with the same text two occurrences, and each control only its own", () => {
    const r = walk(el("form", {}, el("h2", {}, "Delivery"), el("h3", {}, "Address"), input("a1"), el("h3", {}, "Notes"), input("n"), el("h3", {}, "Address"), input("a2")));
    expect(r.chains.a1).toEqual(["Delivery", "Address"]);
    expect(r.chains.a2).toEqual(["Delivery", "Address"]);
    expect(r.ids.a1?.[1]).not.toBe(r.ids.a2?.[1]);
  });

  it("reads role=heading by its aria-level, and skips a hidden heading or legend", () => {
    expect(walk(el("div", { role: "heading", "aria-level": "3" }, "Equipment details"), input("serial"), el("h2", { hidden: "" }, "Old section"), input("model"), el("fieldset", {}, el("legend", { hidden: "" }, "Ghost"), input("ghost"))).chains).toEqual({
      serial: ["Equipment details"],
      model: ["Equipment details"],
      // Still under the heading before it; the fieldset's hidden legend defines no section.
      ghost: ["Equipment details"],
    });
  });

  // Review P1 2: an excluded heading still ends the section before it.
  it("keeps an excluded heading's occurrence and boundary, with no text", () => {
    const r = walk(el("form", {}, el("h2", {}, "Equipment details"), input("serial"), el("h2", {}, "Voluntary self-identification"), input("note"), el("fieldset", {}, el("legend", {}, "Self-identification survey"), input("other"))));
    expect(r.chains).toEqual({ serial: ["Equipment details"], note: ["(excluded)"], other: ["(excluded)", "(excluded)"] });
    expect(r.occurrences.filter((o) => o.text === undefined)).toHaveLength(2);
    expect(JSON.stringify(r.occurrences)).not.toMatch(/identification/iu);
  });

  it("walks a shadow root in place of its host's children, as a container of its own", () => {
    const r = walk(el("h1", {}, "Service request"), host("service-form", [], [el("h2", {}, "Equipment details"), input("serial")]), input("after"));
    expect(r.chains).toEqual({ serial: ["Service request", "Equipment details"], after: ["Service request"] });
  });

  // Review P1 4: a slotted control is where its slot is, once.
  it("visits a slotted control at its slot's place in the shadow tree, once", () => {
    const r = walk(host("service-form", [input("early", { slot: "top" }), input("late")], [el("slot", { name: "top" }), el("h2", {}, "Service contact"), el("slot", {}), input("own")]));
    expect(r.chains).toEqual({ early: [], late: ["Service contact"], own: ["Service contact"] });
  });
});

describe("the outline", () => {
  it("keeps the innermost sections when a control is nested past the cap", () => {
    const o = new Outline();
    for (let i = 1; i <= MAX_SECTIONS + 2; i++) o.open(`g${i}`);
    expect(o.here()).toEqual(Array.from({ length: MAX_SECTIONS }, (_, i) => `g${i + 3}`));
  });

  // Re-review item 4: past the occurrence cap a heading still ends the sections before it, and places nothing.
  it("ends earlier sections at a heading past the occurrence cap, and gives the controls under it no chain", () => {
    const r = walk(el("form", {}, el("h2", {}, "Equipment details"), input("serial"), ...Array.from({ length: MAX_OCCURRENCES - 1 }, (_, i) => el("h3", {}, `Part ${i + 1}`)), el("h2", {}, "Service contact"), input("phone")));
    expect(r.occurrences).toHaveLength(MAX_OCCURRENCES);
    expect(r.chains.serial).toEqual(["Equipment details"]);
    expect(r.chains.phone).toEqual([]);
  });

  it("refuses to close the document", () => {
    expect(() => new Outline().close()).toThrow(/no container is open/u);
  });
});

describe("the frame's heading list", () => {
  // Review P1 8: an excluded heading never leaves the frame in the heading list either.
  it("leaves out a heading the walk's exclusions match", () => {
    expect(frameHeadings(["Apply", "  Voluntary Self-Identification ", "Education"], (t) => SELF_IDENTIFICATION.test(t))).toEqual(["Apply", "Education"]);
  });

  it("holds the same self-identification cases as the helper's copy", () => {
    const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../helper/fixtures/golden/self-identification.json", import.meta.url)), "utf8")) as { excluded: string[]; kept: string[] };
    for (const t of golden.excluded) expect(SELF_IDENTIFICATION.test(t), t).toBe(true);
    for (const t of golden.kept) expect(SELF_IDENTIFICATION.test(t), t).toBe(false);
  });
});

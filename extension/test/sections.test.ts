// SCP1: the sections each control sits in (content/sections.ts), on small page trees. The extension's tests run without
// a DOM, so the trees are plain objects with the members sectionChains reads; the walk in a real page is walker.ts's.
// A synthetic service form; every heading is invented.
import { describe, expect, it } from "vitest";
import { MAX_SECTIONS, Outline, sectionChains, type OutlineElement, type OutlineReader } from "../src/content/sections.ts";

interface El extends OutlineElement<El> {
  readonly attrs: Record<string, string>;
  readonly own: string;
  readonly kids: El[];
  readonly shadow: El[] | null;
  readonly name: string;
}

/** An element: its tag, attributes (`name` marks a control by name in the result), own text and children. */
function el(localName: string, attrs: Record<string, string> = {}, ...kids: (El | string)[]): El {
  const children = kids.filter((k): k is El => typeof k !== "string");
  const own = kids.filter((k): k is string => typeof k === "string").join(" ");
  const node: El = {
    localName,
    attrs,
    own,
    kids: children,
    shadow: null,
    name: attrs.name ?? "",
    children,
    get textContent() {
      return [own, ...children.map((c) => c.textContent ?? "")].filter((t) => t !== "").join(" ");
    },
    getAttribute: (n: string) => attrs[n] ?? null,
  };
  return node;
}
const input = (name: string): El => el("input", { name });
const withShadow = (host: El, ...inside: El[]): El => ({ ...host, shadow: inside });

/** Every element of the tree, shadow content included, for resolving aria-labelledby ids. */
function all(root: El): El[] {
  return [root, ...root.kids.flatMap(all), ...(root.shadow ?? []).flatMap(all)];
}

function chains(...body: El[]): Record<string, string[]> {
  const doc = el("body", {}, ...body);
  const everything = all(doc);
  const reader: OutlineReader<El> = {
    wanted: (e) => e.localName === "input",
    shown: (e) => e.attrs.hidden === undefined,
    labelledBy: (_e, ids) => ids.split(/\s+/).map((id) => everything.find((x) => x.attrs.id === id)?.textContent ?? "").join(" "),
    shadowRoot: (e) => (e.shadow === null ? null : { children: e.shadow }),
    excluded: (name) => /self[- ]identif/i.test(name),
  };
  return Object.fromEntries([...sectionChains(doc, reader)].map(([e, s]) => [e.name, s]));
}

describe("the sections a control sits in", () => {
  it("is its fieldset's legend", () => {
    expect(chains(el("form", {}, el("fieldset", {}, el("legend", {}, "Equipment details"), input("serial")), el("fieldset", {}, el("legend", {}, "Service contact"), input("phone"))))).toEqual({ serial: ["Equipment details"], phone: ["Service contact"] });
  });

  it("is the heading before it, and the next heading of its level ends that section", () => {
    expect(chains(el("form", {}, el("h2", {}, "Equipment details"), el("div", {}, el("label", {}, "Serial number"), input("serial")), el("h2", {}, "Service contact"), el("div", {}, input("phone"))))).toEqual({ serial: ["Equipment details"], phone: ["Service contact"] });
  });

  it("is the whole heading outline at its place: a page title over the form, a subheading under its section", () => {
    const r = chains(el("h1", {}, "Service request"), el("form", {}, el("h2", {}, "Equipment details"), input("serial"), el("h3", {}, "Warranty"), input("warranty"), el("h2", {}, "Service contact"), input("phone")));
    expect(r).toEqual({ serial: ["Service request", "Equipment details"], warranty: ["Service request", "Equipment details", "Warranty"], phone: ["Service request", "Service contact"] });
  });

  it("is the heading section and the radio group's legend inside it, outermost first", () => {
    expect(chains(el("form", {}, el("h2", {}, "Service contact"), input("phone"), el("fieldset", {}, el("legend", {}, "How should we reach you?"), input("text"), input("call"))))).toEqual({
      phone: ["Service contact"],
      text: ["Service contact", "How should we reach you?"],
      call: ["Service contact", "How should we reach you?"],
    });
  });

  it("takes no heading from a region that has closed, and a region's own label", () => {
    const r = chains(
      el("aside", {}, el("h2", {}, "Need help?"), input("search")),
      el("form", {}, input("first")),
      el("section", { "aria-labelledby": "billing-title" }, el("h2", { id: "billing-title" }, "Billing"), input("card-name")),
      el("div", { role: "group", "aria-label": "Preferred time" }, input("time")),
    );
    expect(r).toEqual({ search: ["Need help?"], first: [], "card-name": ["Billing"], time: ["Preferred time"] });
  });

  it("is none for a control before any heading, in no labelled group", () => {
    expect(chains(el("form", {}, input("early"), el("h2", {}, "Equipment details"), input("serial")))).toEqual({ early: [], serial: ["Equipment details"] });
  });

  it("reads role=heading by its aria-level, and skips a hidden heading or legend", () => {
    expect(chains(el("div", { role: "heading", "aria-level": "3" }, "Equipment details"), input("serial"), el("h2", { hidden: "" }, "Old section"), input("model"), el("fieldset", {}, el("legend", { hidden: "" }, "Ghost"), input("ghost")))).toEqual({
      serial: ["Equipment details"],
      model: ["Equipment details"],
      // Still under the heading before it; the fieldset's hidden legend names nothing.
      ghost: ["Equipment details"],
    });
  });

  it("drops a section name the walk's exclusions would match: it never leaves the frame", () => {
    expect(chains(el("h2", {}, "Voluntary self-identification"), input("pronouns-note"), el("fieldset", {}, el("legend", {}, "Self-identification survey"), input("other")))).toEqual({ "pronouns-note": [], other: [] });
  });

  it("walks a shadow root where its host is", () => {
    const host = withShadow(el("service-form"), el("h2", {}, "Equipment details"), input("serial"));
    expect(chains(el("h1", {}, "Service request"), host, input("after"))).toEqual({ serial: ["Service request", "Equipment details"], after: ["Service request", "Equipment details"] });
  });
});

describe("the outline", () => {
  it("keeps the innermost sections when a control is nested past the cap", () => {
    const o = new Outline();
    for (let i = 1; i <= MAX_SECTIONS + 2; i++) o.open(`Group ${i}`);
    expect(o.here()).toEqual(Array.from({ length: MAX_SECTIONS }, (_, i) => `Group ${i + 3}`));
  });

  it("refuses to close the document", () => {
    expect(() => new Outline().close()).toThrow(/no container is open/u);
  });
});

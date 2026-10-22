// Issue #54, the unit half of commit 09a2ac61 and of the review of PR #58: an editable label, an editable legend and
// an editable aria-labelledby target each contribute no text to a name or a group's question, while the plain ones
// still name theirs. The extension's tests run without a DOM, so the elements are plain objects carrying the members
// names.ts and secret-dom.ts read, and the browser globals those readers `instanceof` are stubbed with the least
// constructors that make the checks run. The aria-labelledby case spells the role "Textbox", as a real page may: the
// old read was case-sensitive there, so the person's draft named the control through names.ts's one safeText root.
import { describe, expect, it } from "vitest";
import { groupNames, named } from "../src/content/names.ts";

// The least browser globals the readers' instanceof checks and node-type constants need: without them the checks
// throw, and with them a fake is a field only when its attributes say so.
const G = globalThis as unknown as Record<string, unknown>;
if (G.Node === undefined) G.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, CDATA_SECTION_NODE: 4 };
for (const k of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLFieldSetElement", "ShadowRoot"]) {
  if (G[k] === undefined) G[k] = class {};
}

interface TextFake {
  readonly nodeType: 3;
  readonly data: string;
  readonly childNodes: readonly [];
  readonly parentNode: null;
}

interface ElFake {
  readonly localName: string;
  readonly nodeType: 1;
  readonly shadowRoot: null;
  parentNode: ElFake | null;
  readonly attrs: Record<string, string>;
  readonly childNodes: (ElFake | TextFake)[];
  readonly textContent: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): ElFake | null;
  contains(other: unknown): boolean;
  getRootNode(): { getElementById(id: string): ElFake | null };
  labels?: ElFake[];
}

/** A text node: safeText reads its data. */
function text(data: string): TextFake {
  return { nodeType: 3, data, childNodes: [], parentNode: null };
}

/** An element: its tag, attributes and children — plain strings become text nodes, which is what safeText reads. */
function el(localName: string, attrs: Record<string, string> = {}, ...kids: (ElFake | TextFake | string)[]): ElFake {
  const children = kids.map((k): ElFake | TextFake => (typeof k === "string" ? text(k) : k));
  const self: ElFake = {
    localName,
    nodeType: 1,
    shadowRoot: null,
    parentNode: null,
    attrs,
    childNodes: children,
    get textContent() {
      return children.map((c) => (c.nodeType === 3 ? (c as TextFake).data : c.textContent)).filter((t) => t !== "").join(" ");
    },
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => name in attrs,
    querySelector: () => null,
    contains: () => false,
    getRootNode: () => ({ getElementById: () => null }),
  };
  return self;
}

/** The control the labels path names: a real HTMLInputElement to named()'s instanceof, with the labels given. */
function inputWith(attrs: Record<string, string>, labels: ElFake[]): Element {
  const input = Object.assign(el("input", attrs), { labels }) as unknown as HTMLInputElement;
  Object.setPrototypeOf(input, HTMLInputElement.prototype);
  return input as unknown as Element;
}

/** A fieldset the legend path reads: a real HTMLFieldSetElement to groupNames()'s instanceof, holding its legend. */
function fieldsetOf(legend: ElFake): ElFake {
  const fs = el("fieldset", {}, legend);
  Object.setPrototypeOf(fs, HTMLFieldSetElement.prototype);
  fs.querySelector = () => legend;
  return fs;
}

describe("an editable label, legend or aria-labelledby target names no control (issue #54)", () => {
  it("text typed into an editable label contributes no name, and a plain label still names its own", () => {
    const member = inputWith({ name: "member" }, [el("label", { contenteditable: "true" }, "Aunt Betty")]);
    expect(named(member)).toEqual({ name: "", from: "none" });

    const home = inputWith({ name: "home" }, [el("label", {}, "Home address")]);
    expect(named(home)).toEqual({ name: "Home address", from: "labels" });
  });

  it("text typed into an editable legend contributes no group name, and a plain legend still names its group", () => {
    const member = el("input", { name: "pref" });
    member.parentNode = fieldsetOf(el("legend", { contenteditable: "true" }, "Edgewater Flats"));
    // The reader keeps its slot in the group list (groupNames pushes even an empty read); the empty name is what
    // reaches no question.
    expect(groupNames(member as unknown as Element)).toEqual([""]);

    const other = el("input", { name: "size" });
    other.parentNode = fieldsetOf(el("legend", {}, "Household"));
    expect(groupNames(other as unknown as Element)).toEqual(["Household"]);
  });

  it("an editable aria-labelledby target contributes no name, whatever case its role spells textbox in", () => {
    // The hole the browser had: the aria filter read the role case-sensitively, so a "Textbox" the page made editable
    // by role alone was kept, and safeText left an editable element's own text in as the control's name.
    const draft = el("div", { role: "Textbox" }, "Renamed by hand");
    const ctl = el("div", { "aria-labelledby": "draft" });
    ctl.getRootNode = () => ({ getElementById: (id) => (id === "draft" ? draft : null) });
    expect(named(ctl as unknown as Element).name).toBe("");
    expect(named(ctl as unknown as Element).from).not.toBe("labelledby");

    // The lowercase spelling is the filter's own, as before.
    const lower = el("div", { role: "textbox" }, "Renamed by hand");
    const plain = el("div", { "aria-labelledby": "lower" });
    plain.getRootNode = () => ({ getElementById: (id) => (id === "lower" ? lower : null) });
    expect(named(plain as unknown as Element)).toEqual({ name: "", from: "none" });
  });
});

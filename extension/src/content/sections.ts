// SCP1: which sections of the page each control sits in, so an Ask that names one section ("fill the equipment details
// section") writes only controls the page puts in it. The frame's heading list says what sections a page has, not which
// control is under which; b31-07 proposed two landlord fields for "the current residence section" because nothing on
// the page path said where they were.
//
// A control's sections, outermost first, are read as a person reads a page's outline:
//   - the headings (h1-h6, role=heading) before it in document order, as an outline: a heading closes the earlier ones
//     of its level or deeper. A heading counts only inside the form or region it is in: one in a form or region that
//     has closed (a sidebar's, another form's) names nothing after it.
//   - each enclosing fieldset's legend, and each enclosing group or region's label (aria-labelledby, else aria-label).
// A control before any heading, in no labelled group, has none. Hidden headings are not part of the outline.
//
// The walk is split so its rules run without a browser: Outline holds the rules over events in document order, and
// sectionChains feeds it a tree, through only the few element members it reads.
import { clean } from "./names.ts";

/** Sections one control carries at most; past it the outermost are dropped. Not measured: deep outlines are rare. */
export const MAX_SECTIONS = 8;
/** A section name's length at most, as the walk clips a group's question. */
export const MAX_SECTION_NAME = 120;

interface Frame {
  readonly label: string | null;
  headings: { level: number; text: string }[];
}

/** The outline at each point of a document-order walk: containers opened and closed, headings met. */
export class Outline {
  private readonly frames: Frame[] = [{ label: null, headings: [] }];

  /** A form, region, group or fieldset begins; `label` is its legend or label, null for none. */
  open(label: string | null): void {
    this.frames.push({ label: label === null || label === "" ? null : label, headings: [] });
  }

  /** The innermost open container ends, and the headings met inside it with it. */
  close(): void {
    if (this.frames.length === 1) throw new Error("Outline.close: no container is open");
    this.frames.pop();
  }

  /** A heading of `level` (1-6): it ends the open headings of its level or deeper in the innermost container. */
  heading(level: number, text: string): void {
    if (text === "") return;
    const top = this.frames.at(-1) as Frame;
    top.headings = [...top.headings.filter((h) => h.level < level), { level, text }];
  }

  /** The sections a control here sits in, outermost first, each once, at most MAX_SECTIONS (the innermost kept). */
  here(): string[] {
    const out: string[] = [];
    for (const f of this.frames) for (const t of [...(f.label === null ? [] : [f.label]), ...f.headings.map((h) => h.text)]) if (!out.includes(t)) out.push(t);
    return out.slice(-MAX_SECTIONS);
  }
}

/** What sectionChains reads of an element, whose children are `E`s. A DOM Element has all of it. */
export interface OutlineElement<E> {
  readonly localName: string;
  readonly children: ArrayLike<E>;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}

export interface OutlineReader<E extends OutlineElement<E>> {
  /** Whether the element is a control to record sections for. */
  wanted(el: E): boolean;
  /** Whether a heading or legend is shown to a person; a hidden one is no section. */
  shown(el: E): boolean;
  /** The text of the elements an aria-labelledby value names, in the element's own tree. */
  labelledBy(el: E, ids: string): string;
  /** The element's shadow root, open or closed, walked where it is; null for none. */
  shadowRoot(el: E): { readonly children: ArrayLike<E> } | null;
  /** A section name that must not leave the frame (one the walk's exclusions would match): dropped, never sent. */
  excluded(name: string): boolean;
}

const SCOPE_TAGS = new Set(["form", "fieldset", "section", "article", "aside", "nav", "main", "dialog"]);
const SCOPE_ROLES = new Set(["form", "region", "group", "radiogroup", "dialog", "main", "complementary", "navigation"]);

/** The heading level of a heading element (h1-h6, or role=heading with aria-level, 2 without one), else null. */
function headingLevel(el: OutlineElement<unknown>): number | null {
  const m = /^h([1-6])$/.exec(el.localName);
  if (m !== null) return Number(m[1]);
  if (el.getAttribute("role")?.trim().toLowerCase() !== "heading") return null;
  const level = Number(el.getAttribute("aria-level"));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
}

/** A container's label: a fieldset's own legend, else its aria-labelledby text, else its aria-label. */
function containerLabel<E extends OutlineElement<E>>(el: E, r: OutlineReader<E>): string | null {
  if (el.localName === "fieldset") {
    for (const c of Array.from(el.children)) if (c.localName === "legend") return r.shown(c) ? clean(c.textContent, MAX_SECTION_NAME) : null;
  }
  const ids = el.getAttribute("aria-labelledby");
  const named = ids === null ? "" : clean(r.labelledBy(el, ids), MAX_SECTION_NAME);
  return named !== "" ? named : clean(el.getAttribute("aria-label"), MAX_SECTION_NAME) || null;
}

const isScope = (el: OutlineElement<unknown>): boolean => SCOPE_TAGS.has(el.localName) || SCOPE_ROLES.has(el.getAttribute("role")?.trim().toLowerCase() ?? "");

/** Each wanted control under `root` (shadow roots included), with the sections it sits in, outermost first. */
export function sectionChains<E extends OutlineElement<E>>(root: { readonly children: ArrayLike<E> }, r: OutlineReader<E>): Map<E, string[]> {
  const out = new Map<E, string[]>();
  const outline = new Outline();
  const kept = (name: string | null): string | null => (name === null || name === "" || r.excluded(name) ? null : name);
  const visit = (parent: { readonly children: ArrayLike<E> }): void => {
    for (const el of Array.from(parent.children)) {
      const scope = isScope(el);
      if (scope) outline.open(kept(containerLabel(el, r)));
      const level = headingLevel(el);
      if (level !== null && r.shown(el)) {
        const text = kept(clean(el.textContent, MAX_SECTION_NAME));
        if (text !== null) outline.heading(level, text);
      }
      if (r.wanted(el)) out.set(el, outline.here());
      const sr = r.shadowRoot(el);
      if (sr !== null) visit(sr);
      // A heading's own content is its text, not more of the outline.
      if (level === null) visit(el);
      if (scope) outline.close();
    }
  };
  visit(root);
  return out;
}

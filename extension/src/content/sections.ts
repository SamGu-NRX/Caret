// SCP1: which sections of the page each control sits in, so an Ask that names one section ("fill the equipment details
// section") writes only controls the page puts in it. The frame's heading list says what sections a page has, not which
// control is under which; b31-07 proposed two landlord fields for "the current residence section" because nothing on
// the page path said where they were.
//
// Sections are occurrences, not text: two headings that read "Address" are two sections. Every element that defines a
// section gets an id unique within the walk, and its text travels apart from it (Occurrence):
//   - a heading (h1-h6, or role=heading with its aria-level, 2 without one) that is shown;
//   - a fieldset with a shown legend, and a group or region with a label (aria-labelledby, else aria-label).
// Each control records the ids of the occurrences that contain it, outermost first:
//   - a heading's scope is its nearest sectioning container (form, section, article, aside, nav, main, dialog,
//     fieldset, a labelled group or region, a shadow root), from the heading to the next heading of equal or higher
//     rank in that container, or to the container's end;
//   - a container's own headings suppress the headings it inherits of equal or deeper rank: under an outer h2
//     "Applicant", a section whose own h2 reads "Address" holds its controls in "Address" only;
//   - a container with a label contains everything in it.
// A heading or label the walk's exclusions would match keeps its occurrence and its boundary (it still ends the
// section before it) but has no text: it never leaves the frame. The tree walked is the flat tree the page renders: a
// shadow host's shadow root in place of its children, and a slot's assigned elements where the slot is, once.
//
// The rules run without a browser: sectionOutline reads an element only through OutlineReader and the few members of
// OutlineElement, so tests walk plain objects and walker.ts walks the DOM.
import { clean } from "./names.ts";

/** Sections one control carries at most; past it the outermost are dropped. Not measured: deep outlines are rare. */
export const MAX_SECTIONS = 8;
/** Occurrences one walk reports at most; past it a section is not recorded and its controls carry fewer. Not measured. */
export const MAX_OCCURRENCES = 200;
/** A section's text at most, as the walk clips a group's question. */
export const MAX_SECTION_NAME = 120;

/** One section-defining element of the walk: its id, its text unless an exclusion matched it, and whether it is a heading. */
export interface Occurrence {
  id: string;
  heading: boolean;
  text?: string;
}

interface Frame {
  /** The container's own label occurrence, if it has one. */
  readonly label: string | null;
  headings: { level: number; id: string }[];
}

/** The outline at each point of a walk in document order: containers opened and closed, headings met, by occurrence id. */
export class Outline {
  private readonly frames: Frame[] = [{ label: null, headings: [] }];

  /** A sectioning container begins; `label` is the id of its label occurrence, null for none. */
  open(label: string | null): void {
    this.frames.push({ label, headings: [] });
  }

  /** The innermost open container ends, and the headings met inside it end with it. */
  close(): void {
    if (this.frames.length === 1) throw new Error("Outline.close: no container is open");
    this.frames.pop();
  }

  /** A heading of `level` (1-6) in the innermost container: it ends that container's open headings of its level or deeper. */
  heading(level: number, id: string): void {
    const top = this.frames.at(-1) as Frame;
    top.headings = [...top.headings.filter((h) => h.level < level), { level, id }];
  }

  /**
   * The occurrences a control here sits in, outermost first, at most MAX_SECTIONS (the innermost kept): each open
   * container's label, and each open heading not suppressed by a heading of its rank or higher in a container inside it.
   */
  here(): string[] {
    const kept: string[][] = [];
    let below = 7;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i] as Frame;
      const headings = f.headings.filter((h) => h.level < below);
      kept.unshift([...(f.label === null ? [] : [f.label]), ...headings.map((h) => h.id)]);
      for (const h of f.headings) below = Math.min(below, h.level);
    }
    return kept.flat().slice(-MAX_SECTIONS);
  }
}

/** What sectionOutline reads of an element, whose children are `E`s. A DOM Element has all of it. */
export interface OutlineElement<E> {
  readonly localName: string;
  readonly children: ArrayLike<E>;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
}

export interface OutlineReader<E extends OutlineElement<E>> {
  /** Whether the element is a control to record sections for. */
  wanted(el: E): boolean;
  /** Whether a heading or legend is shown to a person; a hidden one defines no section. */
  shown(el: E): boolean;
  /** The elements an aria-labelledby value names, in the element's own tree. */
  labelledBy(el: E, ids: string): readonly E[];
  /** The element's shadow root, open or closed, walked in place of its children; null for none. */
  shadowRoot(el: E): { readonly children: ArrayLike<E> } | null;
  /** A slot's assigned elements, flattened, walked where the slot is; null for an element that is no slot. */
  assigned(el: E): readonly E[] | null;
  /** A section text that must not leave the frame (one the walk's exclusions would match): its occurrence has no text. */
  excluded(text: string): boolean;
}

const CONTAINER_TAGS = new Set(["form", "section", "article", "aside", "nav", "main", "dialog", "fieldset"]);
const LABELLED_CONTAINER_ROLES = new Set(["form", "region", "group", "radiogroup", "dialog", "main", "complementary", "navigation"]);

/** The heading level of a heading element (h1-h6, or role=heading with aria-level, 2 without one), else null. */
function headingLevel(el: OutlineElement<unknown>): number | null {
  const m = /^h([1-6])$/.exec(el.localName);
  if (m !== null) return Number(m[1]);
  if (el.getAttribute("role")?.trim().toLowerCase() !== "heading") return null;
  const level = Number(el.getAttribute("aria-level"));
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
}

/**
 * A container's label: a fieldset's own shown legend, else its aria-labelledby text, else its aria-label; null for none.
 * `own` is false for a label that is a heading (a section labelled by its own h2): that heading is the occurrence, and a
 * second one with its text would make the section's name read as two sections.
 */
function labelOf<E extends OutlineElement<E>>(el: E, r: OutlineReader<E>): { text: string; own: boolean } | null {
  if (el.localName === "fieldset") {
    for (const c of Array.from(el.children)) if (c.localName === "legend") return r.shown(c) && clean(c.textContent, MAX_SECTION_NAME) !== "" ? { text: clean(c.textContent, MAX_SECTION_NAME), own: true } : null;
    return null;
  }
  const ids = el.getAttribute("aria-labelledby");
  const targets = ids === null ? [] : r.labelledBy(el, ids);
  const named = clean(targets.map((t) => t.textContent ?? "").join(" "), MAX_SECTION_NAME);
  if (named !== "") return { text: named, own: !targets.every((t) => headingLevel(t) !== null) };
  const aria = clean(el.getAttribute("aria-label"), MAX_SECTION_NAME);
  return aria === "" ? null : { text: aria, own: true };
}

/** Whether the element is a sectioning container, given its label text. */
function isContainer(el: OutlineElement<unknown>, label: { text: string } | null): boolean {
  if (CONTAINER_TAGS.has(el.localName)) return true;
  return label !== null && LABELLED_CONTAINER_ROLES.has(el.getAttribute("role")?.trim().toLowerCase() ?? "");
}

/**
 * The walk's section occurrences in document order, and each wanted control under `root` with the ids of the
 * occurrences it sits in, outermost first. `prefix` makes the ids unique when one frame walks more than once.
 */
export function sectionOutline<E extends OutlineElement<E>>(root: { readonly children: ArrayLike<E> }, r: OutlineReader<E>): { occurrences: Occurrence[]; chains: Map<E, string[]> } {
  const occurrences: Occurrence[] = [];
  const chains = new Map<E, string[]>();
  const outline = new Outline();
  /** A new occurrence's id, or null past MAX_OCCURRENCES. */
  const occur = (heading: boolean, text: string): string | null => {
    if (occurrences.length >= MAX_OCCURRENCES) return null;
    const id = `o${occurrences.length + 1}`;
    occurrences.push({ id, heading, ...(text === "" || r.excluded(text) ? {} : { text }) });
    return id;
  };
  const children = (el: E): ArrayLike<E> => r.assigned(el) ?? r.shadowRoot(el)?.children ?? el.children;
  const visit = (parent: ArrayLike<E>): void => {
    for (const el of Array.from(parent)) {
      const label = labelOf(el, r);
      const container = isContainer(el, label);
      if (container) outline.open(label === null || !label.own ? null : occur(false, label.text));
      const level = headingLevel(el);
      if (level !== null && r.shown(el)) {
        const id = occur(true, clean(el.textContent, MAX_SECTION_NAME));
        if (id !== null) outline.heading(level, id);
      }
      if (r.wanted(el)) chains.set(el, outline.here());
      // A heading's content is its text, not more of the outline. A shadow root is a container of its own.
      if (level === null) {
        const shadow = r.assigned(el) === null ? r.shadowRoot(el) : null;
        if (shadow !== null) outline.open(null);
        visit(children(el));
        if (shadow !== null) outline.close();
      }
      if (container) outline.close();
    }
  };
  visit(root.children);
  return { occurrences, chains };
}

/** The frame's heading list as it leaves the frame: shown h1 and h2 text, none an exclusion matches. */
export function frameHeadings(texts: readonly string[], excluded: (text: string) => boolean, max = 10): string[] {
  return texts.map((t) => clean(t, MAX_SECTION_NAME)).filter((t) => t !== "" && !excluded(t)).slice(0, max);
}

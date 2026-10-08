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
import { sha256Hex } from "../shared/sha256.ts";

/** Sections one control carries at most; past it the outermost are dropped. Not measured: deep outlines are rare. */
export const MAX_SECTIONS = 8;
/** Occurrences one walk reports at most; past it a section is not recorded and its controls carry fewer. Not measured. */
export const MAX_OCCURRENCES = 200;
/** A section's text at most, as the walk clips a group's question. */
export const MAX_SECTION_NAME = 120;

/**
 * One section-defining element of the walk: its id, its text unless an exclusion matched it, and whether it is a
 * heading. `digest`: the SHA-256 of its name (sectionName), excluded or not, which the worker keys with a salt it never
 * sends (worker/section-names.ts) so the helper can tell two sections share a name anywhere in the tab, without the
 * name of one an exclusion took ever leaving the frame. Never sent past the worker.
 */
export interface Occurrence {
  id: string;
  heading: boolean;
  text?: string;
  digest?: string;
}

/**
 * Section names one walk digests at most, past MAX_OCCURRENCES too; past it the walk says its sections are cut, and the
 * helper treats its list as incomplete. Not measured: far over any form's sections.
 */
export const MAX_SECTION_DIGESTS = 2000;

/** What a walk reads of a frame's sections. */
export interface SectionOutline<E> {
  occurrences: Occurrence[];
  chains: Map<E, string[]>;
  /** The digests of section names past MAX_OCCURRENCES, which have no id or text. */
  overflow: string[];
  /** More section names than MAX_SECTION_DIGESTS. */
  cut: boolean;
  /** The frame's heading list: shown h1 and h2 text that no exclusion took, by name or by where it is, at most 10. */
  headings: string[];
}

/**
 * SCP1: a section name as every comparison reads it, here and in the helper (helper/src/engines/page-exclusions.ts
 * sectionName, the same function, checked against fixtures/golden/section-names.json): NFKC, case folded, whitespace
 * collapsed. A fullwidth "Ｖｏｌｕｎｔａｒｙ ｓｅｌｆ－ｉｄｅｎｔｉｆｉｃａｔｉｏｎ" is the ASCII one, for the exclusion as for equality.
 */
export function sectionName(s: string): string {
  return s.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/**
 * An occurrence as the outline holds it: its id, or null for one past MAX_OCCURRENCES, which still bounds the sections
 * around it but can't be named, so a control inside it has no chain.
 */
type Slot = string | null;

interface Frame {
  /** The container's own label occurrence, if it has one. */
  readonly label: { id: Slot } | null;
  headings: { level: number; id: Slot }[];
}

/** The outline at each point of a walk in document order: containers opened and closed, headings met, by occurrence id. */
export class Outline {
  private readonly frames: Frame[];

  /** A new outline, or a copy of `from` to try a step on. */
  constructor(from?: Outline) {
    this.frames = from === undefined ? [{ label: null, headings: [] }] : from.frames.map((f) => ({ label: f.label, headings: [...f.headings] }));
  }

  /** A sectioning container begins; `label` is its label occurrence (an id, or null past the cap), undefined for none. */
  open(label?: Slot): void {
    this.frames.push({ label: label === undefined ? null : { id: label }, headings: [] });
  }

  /** The innermost open container ends, and the headings met inside it end with it. */
  close(): void {
    if (this.frames.length === 1) throw new Error("Outline.close: no container is open");
    this.frames.pop();
  }

  /**
   * A heading of `level` (1-6) in the innermost container: it ends that container's open headings of its level or
   * deeper. `id` is null past the cap: the heading still ends them.
   */
  heading(level: number, id: Slot): void {
    const top = this.frames.at(-1) as Frame;
    top.headings = [...top.headings.filter((h) => h.level < level), { level, id }];
  }

  /**
   * The occurrences a control here sits in, outermost first, at most MAX_SECTIONS (the innermost kept): each open
   * container's label, and each open heading not suppressed by a heading of its rank or higher in a container inside it.
   * Empty when one of them is past the cap: its section can't be named, so the control is placed in none, never in the
   * section before it (the helper reads an empty chain as unknown and withholds).
   */
  here(): string[] {
    const kept: Slot[][] = [];
    let below = 7;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i] as Frame;
      const headings = f.headings.filter((h) => h.level < below);
      kept.unshift([...(f.label === null ? [] : [f.label.id]), ...headings.map((h) => h.id)]);
      for (const h of f.headings) below = Math.min(below, h.level);
    }
    const chain = kept.flat();
    return chain.includes(null) ? [] : (chain as string[]).slice(-MAX_SECTIONS);
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
  /**
   * A section text that must not leave the frame (one the walk's exclusions would match), given as sectionName reads
   * it: its occurrence has no text. An occurrence inside an excluded one has none either (context exclusion).
   */
  excluded(name: string): boolean;
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

/** The walk's section occurrences in document order, and each wanted control under `root` with the ids of the occurrences it sits in, outermost first. */
export function sectionOutline<E extends OutlineElement<E>>(root: { readonly children: ArrayLike<E> }, r: OutlineReader<E>): SectionOutline<E> {
  const occurrences: Occurrence[] = [];
  const chains = new Map<E, string[]>();
  const outline = new Outline();
  const overflow: string[] = [];
  const headings: string[] = [];
  let cut = false;
  /** Excluded occurrences by id: a section inside one is excluded too. */
  const excludedIds = new Set<string>();
  /**
   * A new occurrence's id, or null past MAX_OCCURRENCES, where only its name's digest is kept. `within` is the chain it
   * sits in: inside an excluded section (a self-identification fieldset's "Address" heading) its text is excluded
   * too, by context. `level` is a heading's, for the frame's heading list.
   */
  const occur = (heading: boolean, text: string, within: readonly string[], level: number | null = null): string | null => {
    const name = sectionName(text);
    const digest = name === "" ? undefined : sha256Hex(name);
    if (occurrences.length >= MAX_OCCURRENCES) {
      if (digest !== undefined) {
        if (occurrences.length + overflow.length < MAX_SECTION_DIGESTS) overflow.push(digest);
        else cut = true;
      }
      return null;
    }
    const id = `o${occurrences.length + 1}`;
    const withDigest = digest === undefined ? {} : { digest };
    if (name !== "" && (r.excluded(name) || within.some((x) => excludedIds.has(x)))) {
      excludedIds.add(id);
      occurrences.push({ id, heading, ...withDigest });
    } else {
      occurrences.push({ id, heading, ...(text === "" ? {} : { text }), ...withDigest });
      if (text !== "" && level !== null && level <= 2 && headings.length < 10) headings.push(text);
    }
    return id;
  };
  const children = (el: E): ArrayLike<E> => r.assigned(el) ?? r.shadowRoot(el)?.children ?? el.children;
  const visit = (parent: ArrayLike<E>): void => {
    for (const el of Array.from(parent)) {
      const label = labelOf(el, r);
      const container = isContainer(el, label);
      if (container) outline.open(label === null || !label.own ? undefined : occur(false, label.text, outline.here()));
      const level = headingLevel(el);
      if (level !== null && r.shown(el)) {
        // The heading's context is the chain it opens a section in: the headings it ends are not around it.
        const probe = new Outline(outline);
        probe.heading(level, "");
        outline.heading(level, occur(true, clean(el.textContent, MAX_SECTION_NAME), probe.here().filter((x) => x !== ""), level));
      }
      if (r.wanted(el)) chains.set(el, outline.here());
      // A heading's content is its text, not more of the outline. A shadow root is a container of its own.
      if (level === null) {
        const shadow = r.assigned(el) === null ? r.shadowRoot(el) : null;
        if (shadow !== null) outline.open();
        visit(children(el));
        if (shadow !== null) outline.close();
      }
      if (container) outline.close();
    }
  };
  visit(root.children);
  return { occurrences, chains, overflow, cut, headings };
}

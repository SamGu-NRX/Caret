// What real application forms need beyond a control's own accessible name (W4, from the saved markup of Greenhouse,
// Lever, Ashby and HubSpot in W3's and W4's read-only passes):
//
// - The question a field answers when the field has no name of its own, or only its placeholder ("Start typing...",
//   "Type your response"), and the question a radio group answers when it has no fieldset legend: Lever and Ashby put
//   the question in a sibling <div> or an unassociated <label>, beside the control's container.
// - The visible control that owns a hidden file input: Greenhouse's "Attach" button and Ashby's dropzone sit beside
//   a visually hidden <input type=file>, so a walk that keeps only visible controls finds no file target.
// - A Yes/No question built from toggle buttons (Ashby): buttons carrying aria-pressed, side by side in one container,
//   which the page itself marks pressed or not.
//
// The same functions run at the walk and again right before an act (actions.ts), so a name or an owner the walk
// reported is checked against the page as it is then.
import { accessibleName, clean, groupNames, named, textOfLabel } from "./names.ts";
import { visible } from "./walker.ts";
import { plainTextAt, safeText } from "./secret-dom.ts";

/** How far up from a control the question may be looked for. Assumed from the markup: Lever's is 3 levels up, Ashby's 2. */
const QUESTION_LEVELS = 4;
const MAX_QUESTION = 200;

/** Fields whose presence beside a control makes text near it some other field's label. Buttons do not: their text is skipped. */
const FIELD = "input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea, [role=combobox], [role=textbox], [role=radio], [role=checkbox], [role=switch], [role=listbox], [contenteditable='' i], [contenteditable='true' i]";
/** Subtrees whose text is never part of a question: controls and option lists. */
const NOT_QUESTION = "button, [role=button], select, textarea, option, [role=listbox], [role=option], script, style, template, [aria-hidden=true]";

/** The smallest element holding every member (in the light tree, where these forms put them), or null. */
function commonAncestor(members: readonly Element[]): Element | null {
  const first = members[0];
  if (first === undefined) return null;
  for (let a: Element | null = first.parentElement; a !== null; a = a.parentElement) if (members.every((m) => a.contains(m))) return a;
  return null;
}

/** Smallest font size, in px, whose text counts as something a person reads. Assumed; form labels are 11 px and up. */
const MIN_FONT_PX = 6;

/**
 * Whether a text node is drawn where a person could read it: its element is visible (walker.visible), its font is at
 * least MIN_FONT_PX, its colour is not fully transparent, and its own glyph box is over a pixel each way. A page could
 * otherwise put unreadable text beside a control to stand in for the question a person sees (W4 review #3).
 */
function rendered(t: Text, el: Element): boolean {
  const cs = getComputedStyle(el);
  if (Number.parseFloat(cs.fontSize) < MIN_FONT_PX) return false;
  if (/rgba\([^)]*,\s*0(\.0+)?\)$/.test(cs.color) || cs.color === "transparent") return false;
  const range = document.createRange();
  range.selectNodeContents(t);
  const r = range.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

/** Readable text in `scope` outside the members, their labels, and any control or option list. */
function textAround(scope: Element, members: readonly Element[], skip: readonly Element[]): string {
  let out = "";
  const seen = new Map<Element, boolean>();
  const ok = (el: Element): boolean => {
    let v = seen.get(el);
    if (v === undefined) {
      // A field's own text (a one-time-code editor's digits, a draft) is never a question's.
      v = !el.closest(NOT_QUESTION) && !skip.some((s) => s.contains(el)) && plainTextAt(el) && visible(el, { opacity: true });
      seen.set(el, v);
    }
    return v;
  };
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
    const p = t.parentElement;
    if (p === null || members.some((m) => m.contains(p)) || !ok(p) || (t.textContent ?? "").trim() === "" || !rendered(t as Text, p)) continue;
    out += ` ${t.textContent ?? ""}`;
  }
  return clean(out, MAX_QUESTION);
}

/**
 * The texts around `members`, one per element going up from `start`, at most QUESTION_LEVELS of them, stopping before
 * an element that also holds another field (whose label the text could be). Each is the readable text of that element
 * leaving out the members, their labels and every control's own text. Empty levels are left out.
 */
function textsAround(members: readonly Element[], start: Element | null): string[] {
  const skip: Element[] = [];
  for (const m of members) for (const l of (m as HTMLInputElement).labels ?? []) skip.push(l);
  const out: string[] = [];
  for (let scope = start, level = 0; scope !== null && level < QUESTION_LEVELS; level++, scope = scope.parentElement) {
    if ([...scope.querySelectorAll(FIELD)].some((f) => !members.includes(f) && !skip.some((s) => s.contains(f)) && visible(f, { opacity: false }))) break;
    const t = textAround(scope, members, skip);
    if (t !== "" && t !== out.at(-1)) out.push(t);
  }
  return out;
}

const startOf = (members: readonly Element[]): Element | null => (members.length === 1 ? (members[0]?.parentElement ?? null) : commonAncestor(members));

/**
 * The question `members` answer: the readable text of the smallest element around them that has any (textsAround), or
 * "" when there is none before another field.
 */
export function questionText(members: readonly Element[]): string {
  return textsAround(members, startOf(members))[0] ?? "";
}

/**
 * Every text a question around `members` could be read from, nearest first: what an exclusion is tested against, so
 * readable text a page puts close to a control cannot hide a sensitive question further out (W4 review #3).
 */
export function questionTexts(members: readonly Element[]): string[] {
  return textsAround(members, startOf(members));
}

/**
 * The radios that share `el`'s name and form owner, `el` included, in document order. The whole tree is searched: a
 * button outside its form element belongs to it through its form attribute (D2-04 second review), so searching the form
 * element alone split one choice into groups of one.
 */
export function radioPeers(el: HTMLInputElement): HTMLInputElement[] {
  if (el.name === "") return [el];
  const root = el.getRootNode() as Document | ShadowRoot;
  return [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")].filter((r) => r.name === el.name && r.form === el.form);
}

/** The question a radio group answers: its fieldset legend or radiogroup's name, else the text around its buttons. */
export function radioQuestion(el: Element): string {
  const g = groupNames(el)[0];
  if (g !== undefined && g !== "") return g;
  return questionText(el instanceof HTMLInputElement ? radioPeers(el) : [el]);
}

/** Every text a radio group's question could be read from: its group names, then the texts around its buttons. */
export function radioQuestions(el: Element): string[] {
  return [...groupNames(el), ...questionTexts(el instanceof HTMLInputElement ? radioPeers(el) : [el])];
}

/** An attach control's text: what Greenhouse ("Attach"), Ashby ("Upload File") and Lever ("ATTACH RESUME/CV") write on theirs. */
const ATTACH_WORDS = /\b(attach|upload|browse|choose|select|add)\b|\bdrop\b|\bdrag\b/i;

/** Text compared as a person reads it: case, spacing and a trailing required marker do not matter. */
const same = (a: string, b: string): boolean => {
  const n = (x: string): string => x.toLowerCase().replace(/[*✱]/g, "").replace(/\s+/g, " ").trim();
  return n(a) !== "" && n(a) === n(b);
};

/** How far up from a hidden file input its owning button may sit. From the markup: Greenhouse's is a sibling. */
const OWNER_LEVELS = 3;

/**
 * The visible control that owns a hidden file input, or null. Two ways, each an association the page itself states:
 *   - a visible <label> of the input (label[for], or one around it): the browser itself opens the input from it
 *     (Ashby's "Resume" heading, Lever's label around its transparent input);
 *   - the input has a label of its own, hidden, whose text is the visible text of exactly one visible button close by
 *     that says attach or upload, in an element that holds no other file input (Greenhouse: a visually hidden
 *     <label for=resume>Attach</label> beside the visible Attach button). Nearness and wording alone are not enough
 *     (W4 review #2): the page must have labelled the input with the button's own words.
 * A visible file input owns itself and is not asked about here.
 */
export function fileOwner(input: HTMLInputElement): Element | null {
  if (input.type !== "file") return null;
  const labels = [...(input.labels ?? [])];
  for (const l of labels) if (visible(l)) return l;
  if (labels.length === 0) return dropzoneOwner(input);
  const said = labels.map((l) => textOfLabel(l, input)).filter((t) => t !== "");
  if (said.length === 0) return null;
  let a: Element | null = input.parentElement;
  for (let level = 0; a !== null && level < OWNER_LEVELS; level++, a = a.parentElement) {
    if (a.querySelectorAll('input[type="file"]').length !== 1) return null;
    const buttons = [...a.querySelectorAll("button, [role=button], input[type=button]")].filter((b) => visible(b));
    if (buttons.length === 0) continue;
    // The button's visible text, not an aria-label that could say something else.
    const text = (b: Element): string => clean(b instanceof HTMLInputElement ? b.value : safeText(b));
    const owners = buttons.filter((b) => ATTACH_WORDS.test(text(b)) && said.some((t) => same(t, text(b))));
    return owners.length === 1 ? (owners[0] as Element) : null;
  }
  return null;
}

/**
 * P3: the visible button that owns a dropzone's hidden file input that has no label of its own (F1's wizard page 3, and
 * react-dropzone's markup): the nearest element around the input, within OWNER_LEVELS, that names itself as a group (a
 * role=group with an accessible name, or a fieldset with a legend), holds no other file input, and holds exactly one
 * visible button that says attach or upload. The group's name is the page's own statement of what the input is for,
 * which W4's second rule required of a label; the input is then named by it (fileName: its group's name).
 */
function dropzoneOwner(input: HTMLInputElement): Element | null {
  let a: Element | null = input.parentElement;
  for (let level = 0; a !== null && level < OWNER_LEVELS; level++, a = a.parentElement) {
    if (a.querySelectorAll('input[type="file"]').length !== 1) return null;
    const role = a.getAttribute("role");
    const isGroup = role === "group" ? accessibleName(a) !== "" : a instanceof HTMLFieldSetElement && clean(a.querySelector(":scope > legend")?.textContent) !== "";
    if (!isGroup) continue;
    const text = (b: Element): string => clean(b instanceof HTMLInputElement ? b.value : safeText(b));
    const owners = [...a.querySelectorAll("button, [role=button], input[type=button]")].filter((b) => visible(b) && ATTACH_WORDS.test(text(b)));
    return owners.length === 1 ? (owners[0] as Element) : null;
  }
  return null;
}

/** How far above the input the element holding it and its owner may be, for fileScope. From the markup: Ashby's is 2. */
const SCOPE_LEVELS = 4;

/**
 * Where the page shows the name of a file attached through an owned input: the nearest group around the input and its
 * owner (role=group or a fieldset), at most 5 elements above the smallest element holding both (Greenhouse's group is 4
 * above it), else that smallest element. When no element within SCOPE_LEVELS of the input holds both, only the input's
 * own parent: a name the page shows anywhere else on the page is no sign the widget took the file (W4 review #7).
 */
export function fileScope(input: HTMLInputElement, owner: Element): Element {
  let both: Element | null = input.parentElement;
  for (let level = 0; both !== null && !both.contains(owner); level++) both = level + 1 < SCOPE_LEVELS ? both.parentElement : null;
  if (both === null) return input.parentElement ?? input;
  for (let a: Element | null = both, level = 0; a !== null && level < 6; level++, a = a.parentElement) {
    if (a instanceof HTMLFieldSetElement || a.getAttribute("role") === "group") return a;
  }
  return both;
}

/**
 * The name of an owned (hidden) file input: its visible label's text, else its group's name, else its own name. A label
 * that wraps the whole upload widget (Lever's: the question in one child, and in another the link holding the input,
 * the button text, a span where the page writes the chosen file's name and status lines it shows and hides) is read
 * without the child that holds the input, so the name stays the same when the page shows the file.
 */
function fileName(input: HTMLInputElement, owner: Element): string {
  if (owner instanceof HTMLLabelElement) {
    let holder: Element = input;
    while (holder.parentElement !== null && holder.parentElement !== owner) holder = holder.parentElement;
    const t = textOfLabel(owner, holder.parentElement === owner && owner.children.length > 1 ? holder : input);
    if (t !== "") return t;
  }
  const g = groupNames(input)[0];
  if (g !== undefined && g !== "") return g;
  const q = questionText([input, owner]);
  return q !== "" ? q : named(input).name;
}

/** Kinds whose question may stand in for a missing name or a placeholder-only one. */
const FIELD_KINDS = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea", "select", "combobox"]);

/**
 * The name Caret uses for a control, at the walk and before every act: its accessible name, except
 *   - a field with no name, or only its placeholder, takes the question around it when there is one (I2's queue: Ashby's
 *     location combobox is named only "Start typing...", Lever's custom questions are unlabelled selects and text areas);
 *   - a hidden file input that a visible control owns takes that control's label or group (Greenhouse "Resume/CV").
 */
export function controlName(el: Element, kind: string): string {
  const n = named(el);
  if (kind === "file" && el instanceof HTMLInputElement && !visible(el)) {
    const owner = fileOwner(el);
    if (owner !== null) return fileName(el, owner);
  }
  if (FIELD_KINDS.has(kind) && (n.from === "placeholder" || n.from === "none")) {
    const q = questionText([el]);
    if (q !== "") return q;
  }
  return n.name;
}

/** A Yes/No (or other short) question built from toggle buttons, as Ashby's are. */
export interface PressGroup {
  container: Element;
  options: HTMLButtonElement[];
  question: string;
  /** Every text the question could be read from, nearest first: what an exclusion is tested against. */
  texts: string[];
}

/** Options a press group may have. Assumed: a choice of up to 6 toggles reads as one question; more is a toolbar. */
const MAX_PRESS_OPTIONS = 6;

/**
 * A button that cannot send a form when pressed: type=button, or a submit button (no type attribute) with no form
 * owner, which the browser submits nowhere. Ashby's toggles have no type attribute and no <form> around them.
 */
export function sendsNoForm(b: HTMLButtonElement): boolean {
  return b.type === "button" || (!b.hasAttribute("type") && b.form === null && !b.hasAttribute("form"));
}

/**
 * The press group `el` is an option of, or null. All must hold: every option is a visible, enabled <button> that sends
 * no form and carries aria-pressed "true" or "false"; the options are the element children of one container, 2 to
 * MAX_PRESS_OPTIONS of them; the container holds no other visible field; and a question is found around it.
 */
export function pressGroup(el: Element): PressGroup | null {
  if (!(el instanceof HTMLButtonElement)) return null;
  const container = el.parentElement;
  if (container === null) return null;
  const isOption = (b: Element): b is HTMLButtonElement => b instanceof HTMLButtonElement && (b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-pressed") === "false");
  if (!isOption(el)) return null;
  const options = [...container.children].filter(isOption);
  if (options.length < 2 || options.length > MAX_PRESS_OPTIONS) return null;
  // :disabled also covers a button in a disabled <fieldset> (W4 review #4).
  if (!options.every((b) => sendsNoForm(b) && !b.matches(":disabled") && b.getAttribute("aria-disabled") !== "true" && visible(b))) return null;
  // Any other visible control in the container (a third, non-toggle button included) makes it something other than one question.
  const others = [...container.querySelectorAll(`${FIELD}, button, [role=button], a[href]`)].filter((x) => !options.includes(x as HTMLButtonElement) && visible(x, { opacity: false }));
  if (others.length > 0) return null;
  // The question is read from outside the container: the container holds only the options (and hidden inputs), so text
  // inside it is no part of a question a person reads there (W4 review #3).
  const texts = textsAround(options, container.parentElement);
  const question = texts[0] ?? "";
  return question === "" ? null : { container, options, question, texts };
}

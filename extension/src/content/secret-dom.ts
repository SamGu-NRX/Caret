// The DOM half of content/secret.ts: the facts it judges a field on, read off a real element, and text read without
// secret fields. Every reader of page text that could hold a field (a heading, a label, an aria description or error,
// an editor's range, a question around a control) goes through safeText or inSecret, so a value Caret never sends as a
// field's value can't leave the frame as part of some other text.
import { secretKind, textWithoutSecrets, type SecretKind, type TextTree } from "./secret.ts";

/** Input types that hold no typed text: their name and label can't mark a secret. */
const NO_VALUE_TYPES = new Set(["submit", "button", "reset", "image", "checkbox", "radio", "file", "range", "color", "hidden"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** Whether `el` holds what the user types or picks: a text input, a textarea, a select, an editable region or a textbox role. */
export function holdsValue(el: Element): boolean {
  if (el instanceof HTMLInputElement) return !NO_VALUE_TYPES.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  const role = el.getAttribute("role")?.trim().toLowerCase();
  if (role !== undefined && VALUE_ROLES.has(role)) return true;
  const ce = el.getAttribute("contenteditable")?.trim().toLowerCase();
  return ce === "" || ce === "true" || ce === "plaintext-only" || (el instanceof HTMLElement && el.isContentEditable);
}

/** The elements an id list names in `el`'s own tree; none when that tree can't look ids up (a detached clone). */
function byIds(el: Element, ids: string): Element[] {
  const root = el.getRootNode() as Partial<Document>;
  if (typeof root.getElementById !== "function") return [];
  return ids.split(/\s+/).filter(Boolean).flatMap((id) => root.getElementById?.(id) ?? []);
}

/** Every text the page offers as `el`'s label, raw: only tested for secret words, never sent. */
function labelTexts(el: Element, name: string): string[] {
  const out = [name, el.getAttribute("aria-label") ?? "", el.getAttribute("placeholder") ?? "", el.getAttribute("title") ?? ""];
  const ids = el.getAttribute("aria-labelledby");
  if (ids !== null) for (const l of byIds(el, ids)) out.push(l.textContent ?? "");
  const labels = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.labels : null;
  for (const l of labels ?? []) out.push(l.textContent ?? "");
  return out.filter((t) => t.trim() !== "");
}

/** Why `el` holds a password, a one-time code or card details, or null. `name` is the walker's name for it, when known. */
export function secretOfElement(el: Element, name = ""): SecretKind | null {
  const field = holdsValue(el);
  return secretKind(el, {
    role: field ? "field" : "other",
    type: el instanceof HTMLInputElement ? el.type : "",
    autocomplete: el.getAttribute("autocomplete") ?? "",
    nameAndId: `${el.getAttribute("name") ?? ""} ${el.id}`,
    labels: field ? labelTexts(el, name) : [],
  });
}

/**
 * A field below the element being read, by its own markup: an input, textarea or select, a textbox-like role, or an
 * element that sets contenteditable itself. Its text is what someone typed, never part of a heading, label or message
 * around it, and its secret signal may be a question nearby that only the walk reads, so it is left out whatever it is.
 */
function ownField(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  const role = el.getAttribute("role")?.trim().toLowerCase();
  return (role !== undefined && VALUE_ROLES.has(role)) || el.hasAttribute("contenteditable");
}

/**
 * `n.textContent` without the text of any field below it, and "" when `n` itself is a secret field or is missing. The
 * root may be a field (a combobox's shown value): only a secret one gives nothing.
 */
export function safeText(n: Node | null | undefined): string {
  if (n === null || n === undefined) return "";
  const tree: TextTree<Node> = {
    text: (x) => (x.nodeType === Node.TEXT_NODE || x.nodeType === Node.CDATA_SECTION_NODE ? ((x as CharacterData).data ?? "") : null),
    childNodes: (x) => x.childNodes,
    secret: (x) => x.nodeType === Node.ELEMENT_NODE && ((x !== n && ownField(x as Element)) || secretOfElement(x as Element) !== null),
  };
  return textWithoutSecrets(n, tree);
}

/** Whether `n` is inside a secret field, or is one: its parents up through shadow roots to their hosts. */
export function inSecret(n: Node | null): boolean {
  for (let p: Node | null = n; p !== null; p = p instanceof ShadowRoot ? p.host : p.parentNode) {
    if (p.nodeType === Node.ELEMENT_NODE && secretOfElement(p as Element) !== null) return true;
  }
  return false;
}

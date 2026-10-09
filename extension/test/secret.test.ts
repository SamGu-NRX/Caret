// Which fields hold a secret (content/secret.ts): a password, a one-time code or card details. The walker sends such a
// field marked and without its value, and EntryTracker keeps nothing for it. Plain objects stand in for elements; the
// facts are what walker.ts secretOf reads off a real one. Every label and name is invented.
import { describe, expect, it } from "vitest";
import { notePassword, noteTypeChange, readableFrom, secretKind, secretWithin, textWithoutSecrets, withheldForHistory, type FieldFacts, type TextTree, type UpTree } from "../src/content/secret.ts";
import { skippedInEditor } from "../src/content/field-text.ts";
import { EntryTracker } from "../src/content/entry.ts";
import { sectionOutline, type OutlineElement, type OutlineReader } from "../src/content/sections.ts";
import { typeRecords } from "../src/content/password-watch.ts";

type Over = Partial<Omit<FieldFacts, "labels">> & { label?: string; labels?: string[] };
const field = ({ label, labels, ...over }: Over): FieldFacts => ({ role: "field", type: "text", autocomplete: "", nameAndId: " ", identity: [], labels: labels ?? (label === undefined ? [] : [label]), ...over });

describe("secretKind", () => {
  it("keeps a revealed password secret: a field once type=password stays one after a show-password toggle", () => {
    const el = {};
    expect(secretKind(el, field({ type: "password", label: "Password" }))).toBe("password");
    // The toggle: same element, now type=text, with no name, autocomplete or label that says password.
    expect(secretKind(el, field({ type: "text", nameAndId: "f1 ", label: "Enter it here" }))).toBe("password");
  });

  it("keeps a field the content script saw as a password secret though the walk first meets it as text", () => {
    const el = {};
    notePassword(el);
    expect(secretKind(el, field({ nameAndId: "f2 ", label: "Your secret" }))).toBe("password");
  });

  it("marks an unmarked 'Verification code' field as a one-time code", () => {
    expect(secretKind({}, field({ nameAndId: "field_7 q3", label: "Verification code" }))).toBe("oneTimeCode");
  });

  it.each([
    ["autocomplete current-password", field({ autocomplete: "current-password" }), "password"],
    ["autocomplete new-password", field({ autocomplete: "section-signup new-password" }), "password"],
    ["a text field labelled Password", field({ label: "Password" }), "password"],
    ["name userPassword", field({ nameAndId: "userPassword " }), "password"],
    ["autocomplete one-time-code", field({ autocomplete: "one-time-code" }), "oneTimeCode"],
    ["name otp", field({ nameAndId: "otp " }), "oneTimeCode"],
    ["id otpCode", field({ nameAndId: " otpCode" }), "oneTimeCode"],
    ["name one_time_code", field({ nameAndId: "one_time_code " }), "oneTimeCode"],
    ["label Passcode", field({ label: "Passcode" }), "oneTimeCode"],
    ["label One-time code", field({ label: "One-time code" }), "oneTimeCode"],
    ["label 2FA code", field({ label: "Enter your 2FA code" }), "oneTimeCode"],
    ["autocomplete cc-number", field({ autocomplete: "cc-number" }), "payment"],
    ["a select autocomplete cc-exp-month", field({ autocomplete: "cc-exp-month" }), "payment"],
    ["name cardNumber", field({ nameAndId: "cardNumber " }), "payment"],
    ["label Card number", field({ nameAndId: "field_17 ", label: "Card number" }), "payment"],
    ["label CVC", field({ label: "CVC" }), "payment"],
    ["label CVV", field({ label: "CVV" }), "payment"],
    ["label Expiry", field({ label: "Expiry (MM/YY)" }), "payment"],
    ["label Expiration date", field({ label: "Expiration date" }), "payment"],
    ["label Security code", field({ label: "Security code" }), "payment"],
  ] as const)("%s is secret", (_what, facts, want) => {
    expect(secretKind({}, facts)).toBe(want);
  });

  it.each([
    ["First name", field({ nameAndId: "first_name ", label: "First name" })],
    ["Email", field({ type: "email", autocomplete: "email", nameAndId: "email ", label: "Email" })],
    ["Zip code", field({ nameAndId: "zip ", label: "Zip code" })],
    ["Promo code", field({ nameAndId: "promo ", label: "Promo code" })],
    ["a 'Forgot password?' link", field({ role: "other", type: "", label: "Forgot password?" })],
    ["a 'Resend verification code' button", field({ role: "other", type: "", label: "Resend verification code" })],
  ] as const)("%s is not secret", (_what, facts) => {
    expect(secretKind({}, facts)).toBeNull();
  });
});

describe("EntryTracker and secret fields", () => {
  it("never keeps a secret field's value: nothing enters the tracker for it", () => {
    const seen = new WeakMap<object, unknown>();
    const pw = {};
    const t = new EntryTracker((el) => el === pw, seen);
    t.onBefore(pw, "");
    t.onInput(pw, true, "insertText", "h", "h");
    t.onInput(pw, true, "insertText", "hu", "u");
    expect(seen.has(pw)).toBe(false);
    expect(t.entryOf(pw, "hu")).toBeUndefined();
    expect(seen.has(pw)).toBe(false);
  });

  it("drops what it kept for a field that turned secret, as a revealed password field's type changes back", () => {
    const seen = new WeakMap<object, unknown>();
    const el = {};
    let facts = field({ label: "Nickname" });
    const t = new EntryTracker((x) => secretKind(x, facts) !== null, seen);
    t.onInput(el, true, "insertText", "s", "s");
    expect(seen.has(el)).toBe(true);
    facts = field({ type: "password", label: "Nickname" });
    t.onInput(el, true, "insertText", "se", "e");
    expect(seen.has(el)).toBe(false);
    // Shown as text again: still a password field, still nothing kept.
    facts = field({ type: "text", label: "Nickname" });
    t.onInput(el, true, "insertText", "sec", "c");
    expect(seen.has(el)).toBe(false);
  });
});

describe("secretKind reads every label, whatever the accessible name says (review round 2, #4)", () => {
  it("keeps a field secret when one of its labels says Password though its aria-label says something else", () => {
    // <label>Password <input type=text aria-label="Enter it here"></label>: the accessible name is the aria-label.
    expect(secretKind({}, field({ nameAndId: "f9 ", labels: ["Enter it here", "Password"] }))).toBe("password");
    expect(secretKind({}, field({ nameAndId: "f9 ", labels: ["Enter it here", "Verification code"] }))).toBe("oneTimeCode");
  });
});

describe("a password field's type changing (review round 2, #5)", () => {
  it("keeps an input secret once a type change shows it was a password, though it was never focused or walked", () => {
    const el = {};
    // The page's show-password button: type goes from password to text before Caret saw the field.
    noteTypeChange(el, "password", "text");
    expect(secretKind(el, field({ nameAndId: "f3 ", label: "Your secret" }))).toBe("password");
    // The same through the observer's records: the input now says type=text, the record remembers password.
    const seenByObserver = { getAttribute: (n: string) => (n === "type" ? "text" : null) };
    typeRecords([{ target: seenByObserver, attributeName: "type", oldValue: "password" }]);
    expect(secretKind(seenByObserver, field({ nameAndId: "f5 ", label: "Your secret" }))).toBe("password");
    // A type change that never involved a password marks nothing.
    const other = {};
    noteTypeChange(other, "text", "email");
    expect(secretKind(other, field({ type: "email", nameAndId: "f4 ", label: "Email" }))).toBeNull();
  });
});

/** A plain node: text, or an element with attributes and children. Secret when its facts say so. */
type Node = { text: string } | { tag: string; attrs: Record<string, string>; kids: Node[] };
const t = (text: string): Node => ({ text });
const e = (tag: string, attrs: Record<string, string>, ...kids: Node[]): Node => ({ tag, attrs, kids });
const factsOf = (n: Extract<Node, { tag: string }>): FieldFacts =>
  field({ role: n.tag === "textarea" || n.tag === "input" || n.attrs.contenteditable === "true" ? "field" : "other", type: n.attrs.type ?? "", autocomplete: n.attrs.autocomplete ?? "", nameAndId: `${n.attrs.name ?? ""} ${n.attrs.id ?? ""}`, labels: n.attrs["aria-label"] === undefined ? [] : [n.attrs["aria-label"]] });
const tree: TextTree<Node> = {
  text: (n) => ("text" in n ? n.text : null),
  childNodes: (n) => ("kids" in n ? n.kids : []),
  secret: (n) => "tag" in n && secretKind(n, factsOf(n)) !== null,
};

describe("text read around controls leaves secret fields out (review round 2, #2)", () => {
  it("drops a one-time code typed into a heading's textarea", () => {
    const h2 = e("h2", {}, t("Recovery "), e("textarea", { autocomplete: "one-time-code" }, t("123456")));
    expect(textWithoutSecrets(h2, tree)).toBe("Recovery ");
  });

  it("gives nothing when the root itself is secret, and drops a secret nested anywhere below", () => {
    expect(textWithoutSecrets(e("div", { contenteditable: "true", "aria-label": "Password" }, t("hunter2")), tree)).toBe("");
    const wrapper = e("div", { id: "hint" }, t("Code: "), e("span", {}, e("div", { contenteditable: "true", "aria-label": "Passcode" }, t("4242"))), t(" expires soon"));
    expect(textWithoutSecrets(wrapper, tree)).toBe("Code:  expires soon");
  });

  it("keeps ordinary text and ordinary fields' text", () => {
    expect(textWithoutSecrets(e("h2", {}, t("Your "), e("b", {}, t("address"))), tree)).toBe("Your address");
    expect(textWithoutSecrets(e("label", {}, t("Notes "), e("textarea", { name: "notes" }, t("Bring ID"))), tree)).toBe("Notes Bring ID");
  });

  it("keeps the code out of a section heading the walk reports", () => {
    // sectionOutline over the same tree, reading text through the reader as walker.ts does.
    type El = OutlineElement<El> & { node: Node };
    const wrap = (n: Node): El | null => {
      if (!("tag" in n)) return null;
      const children = n.kids.map(wrap).filter((x): x is El => x !== null);
      return { node: n, localName: n.tag, children, getAttribute: (a) => n.attrs[a] ?? null };
    };
    const body = wrap(e("body", {}, e("form", {}, e("h2", {}, t("Recovery "), e("textarea", { autocomplete: "one-time-code" }, t("123456"))), e("input", { name: "email" })))) as El;
    const reader: OutlineReader<El> = {
      wanted: (x) => x.localName === "input",
      shown: () => true,
      labelledBy: () => [],
      shadowRoot: () => null,
      assigned: () => null,
      excluded: () => false,
      text: (x) => textWithoutSecrets(x.node, tree),
    };
    const out = sectionOutline(body, reader);
    expect(JSON.stringify(out.occurrences)).not.toContain("123456");
    expect(out.headings).toEqual(["Recovery"]);
  });
});

describe("EntryTracker keeps no plaintext (review round 2, #7)", () => {
  it("holds a digest and a length for an ordinary field, never the text itself", () => {
    const seen = new WeakMap<object, unknown>();
    const el = {};
    const tr = new EntryTracker(() => false, seen);
    tr.onInput(el, true, "insertText", "s3cret-ish", "s3cret-ish");
    expect(tr.entryOf(el, "s3cret-ish")).toBe("typed");
    tr.onInput(el, true, "deleteContentBackward", "");
    tr.onInput(el, true, "insertText", "k", "k");
    tr.onInput(el, true, "insertText", "ki", "i");
    expect(tr.entryOf(el, "ki")).toBe("typed");
    expect(JSON.stringify(seen.get(el))).not.toMatch(/"ki"|s3cret/);
    expect(tr.entryOf(el, "kx")).toBe("other");
  });

  it("forgets a field the walk found secret, with no further input", () => {
    const seen = new WeakMap<object, unknown>();
    const el = {};
    const tr = new EntryTracker(() => false, seen);
    tr.onInput(el, true, "insertText", "1", "1");
    tr.forget(el);
    expect(seen.has(el)).toBe(false);
  });
});

// Review round 3. A plain tree walked upward: each node's parent, whether it is a secret field, whether it is a field.
type Up = { name: string; parent: Up | null; secret?: boolean; field?: boolean };
const up = (name: string, parent: Up | null, o: { secret?: boolean; field?: boolean } = {}): Up => ({ name, parent, ...o });
const upTree: UpTree<Up> = { parent: (n) => n.parent, secret: (n) => n.secret === true, field: (n) => n.field === true || n.secret === true };

describe("text read from inside a field (review round 3, #1)", () => {
  it("refuses a reference into a secret editor: a span inside <div contenteditable aria-label=Password>", () => {
    const editor = up("editor", up("body", null), { secret: true, field: true });
    const hint = up("hint", editor);
    expect(readableFrom(hint, upTree)).toBe(false);
    expect(readableFrom(up("deeper", hint), upTree)).toBe(false);
  });

  it("refuses text inside any field, and a secret root itself, but reads an ordinary label or a non-secret field root", () => {
    const body = up("body", null);
    expect(readableFrom(up("span", up("draft", body, { field: true })), upTree)).toBe(false);
    expect(readableFrom(up("pw", body, { secret: true }), upTree)).toBe(false);
    expect(readableFrom(up("label", up("form", body)), upTree)).toBe(true);
    expect(readableFrom(up("combobox", body, { field: true }), upTree)).toBe(true);
  });
});

describe("controls inside a secret widget (review round 3, #2)", () => {
  it("makes each digit input of a role=textbox 'Verification code' widget secret, through its ancestors", () => {
    const body = up("body", null);
    const widget = up("widget", body, { secret: true });
    const digit = up("Digit 1", up("cell", widget));
    expect(secretWithin(digit, upTree)).toBe(true);
    expect(secretWithin(up("Email", body), upTree)).toBe(false);
  });
});

describe("password history across a replaced input (review round 3, #4)", () => {
  it("keeps a clone of a known password input secret by its id or name, though it arrives as text", () => {
    expect(secretKind({}, field({ type: "password", identity: ["id:pw-9", "name:pass_word"] }))).toBe("password");
    // The page clones the input, sets type=text while detached, and swaps the clone in: a new object, no type history.
    expect(secretKind({}, field({ type: "text", identity: ["id:pw-9"], label: "Shown" }))).toBe("password");
    expect(secretKind({}, field({ type: "text", identity: ["name:pass_word"], label: "Shown" }))).toBe("password");
    expect(secretKind({}, field({ type: "text", identity: ["id:email"], label: "Email" }))).toBeNull();
  });

  it("withholds a text input's value and caret where Caret could not watch its type from the start", () => {
    expect(withheldForHistory({ tag: "input", type: "text" }, false)).toBe(true);
    expect(withheldForHistory({ tag: "input", type: "email" }, false)).toBe(true);
    expect(withheldForHistory({ tag: "input", type: "text" }, true)).toBe(false);
    expect(withheldForHistory({ tag: "textarea", type: "" }, false)).toBe(false);
    expect(withheldForHistory({ tag: "input", type: "checkbox" }, false)).toBe(false);
  });
});

describe("an editor's text leaves out embedded controls (review round 3, #3)", () => {
  const el = (tagName: string, attrs: Record<string, string> = {}) => ({ tagName, getAttribute: (n: string) => attrs[n] ?? null });
  it("skips an input, textarea or select, and a nested textbox, inside a contenteditable", () => {
    for (const e of [el("TEXTAREA"), el("INPUT"), el("SELECT"), el("OPTION"), el("BUTTON"), el("DIV", { role: "textbox" }), el("SPAN", { role: "combobox" })]) expect(skippedInEditor(e), e.tagName).toBe(true);
    for (const e of [el("SPAN"), el("P"), el("DIV", { contenteditable: "false" }), el("B")]) expect(skippedInEditor(e), e.tagName).toBe(false);
  });
});

// The page `replace` verb (insert.ts, alpha 2ea029d6 and 8cde8ec9): the helper sends `replace` units to take out before
// the caret, and insertAtCaret selects them and types the text over them. The browser test of the same path,
// fixtures/web-form/tests/tab-text.test.ts, needs Chrome for Testing; this one runs insert.ts against a text control
// whose execCommand("insertText") replaces the selection, as Chrome's does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeElement {
  readonly shadowRoot = null;
  readonly localName: string = "input";
}
class FakeHTMLElement extends FakeElement {
  readonly isContentEditable = false;
}
class FakeInput extends FakeHTMLElement {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  constructor(value: string) {
    super();
    this.value = value;
    this.selectionStart = this.selectionEnd = value.length;
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}
class FakeTextArea extends FakeHTMLElement {}
class FakeSelect extends FakeHTMLElement {}

let field: FakeInput;

beforeEach(() => {
  field = new FakeInput("I saw teh");
  vi.stubGlobal("Node", { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLTextAreaElement", FakeTextArea);
  vi.stubGlobal("HTMLSelectElement", FakeSelect);
  vi.stubGlobal("requestAnimationFrame", (go: () => void) => setTimeout(go, 0));
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => true,
    body: null,
    get activeElement() {
      return field;
    },
    execCommand(command: string, _ui: boolean, text: string): boolean {
      if (command !== "insertText") return false;
      const at = field.selectionStart;
      field.value = field.value.slice(0, at) + text + field.value.slice(field.selectionEnd);
      field.selectionStart = field.selectionEnd = at + text.length;
      return true;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = async () => null;

describe("page replace", () => {
  it("types the text over the units before the caret", async () => {
    const { insertAtCaret } = await import("../src/content/insert.ts");
    // A fake text control stands in for the DOM's; insert.ts reads only the members it declares.
    const answer = await insertAtCaret(field as unknown as Element, { expect: "I saw teh", text: "the", replace: 3 }, open);
    expect(answer).toEqual({ outcome: "ok", detail: null });
    expect(field.value).toBe("I saw the");
    expect([field.selectionStart, field.selectionEnd]).toEqual([9, 9]);
  });

  it("refuses a replace longer than the text before the caret and leaves the field", async () => {
    const { insertAtCaret } = await import("../src/content/insert.ts");
    const answer = await insertAtCaret(field as unknown as Element, { expect: "I saw teh", text: "the", replace: 10 }, open);
    expect(answer.outcome).toBe("stale");
    expect(field.value).toBe("I saw teh");
  });
});

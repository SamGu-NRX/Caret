import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";

const intent = { expect: "Dear Sam,", text: " thanks" };

type DomField = HTMLTextAreaElement | HTMLElement;

function setCollapsedCaret(element: DomField, offset: number): void {
  if (element instanceof HTMLTextAreaElement) {
    element.setSelectionRange(offset, offset);
    return;
  }
  const text = element.firstChild;
  if (text === null) throw new Error("test editor has no text node");
  const selection = document.getSelection();
  if (selection === null) throw new Error("test document has no selection");
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function editorCaretOffset(field: HTMLElement): number {
  const selection = document.getSelection();
  const text = field.firstChild;
  if (selection === null || text === null || selection.rangeCount !== 1) return -1;
  const range = document.createRange();
  range.selectNodeContents(field);
  range.setEnd(selection.anchorNode ?? text, selection.anchorOffset);
  return range.toString().length;
}

function installExecCommand(partial: string, field: DomField): void {
  document.execCommand = (command: string, _showUi?: boolean, value?: string): boolean => {
    if (command === "insertText") {
      if (field instanceof HTMLTextAreaElement) {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? start;
        field.value = field.value.slice(0, start) + partial + field.value.slice(end);
        setCollapsedCaret(field, start + partial.length);
        return true;
      }
      const selection = document.getSelection();
      if (selection === null || selection.rangeCount !== 1) return false;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const text = document.createTextNode(partial);
      range.insertNode(text);
      range.setStart(text, text.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    if (command === "delete") {
      if (field instanceof HTMLTextAreaElement) {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? start;
        field.value = field.value.slice(0, start) + field.value.slice(end);
        setCollapsedCaret(field, start);
        return true;
      }
      const selection = document.getSelection();
      if (selection === null || selection.rangeCount !== 1) return false;
      const range = selection.getRangeAt(0);
      const start = range.startOffset;
      range.deleteContents();
      range.setStart(range.startContainer, start);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  };
}

function setUp(field: DomField): void {
  const document = field.ownerDocument;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.hasFocus = () => true;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => field });
  if (!(field instanceof HTMLTextAreaElement)) {
    Object.defineProperty(field, "isContentEditable", { configurable: true, value: true });
    const selection = document.getSelection();
    if (selection === null) throw new Error("test document has no selection");
    Object.defineProperty(selection, "modify", {
      configurable: true,
      value: (_alter: string, direction: string, _granularity: string) => {
        if (direction !== "backward" || selection.rangeCount !== 1) return;
        const range = selection.getRangeAt(0);
        if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return;
        if (range.startOffset === 0) return;
        range.setStart(range.startContainer, range.startOffset - 1);
      },
    });
  }
  installExecCommand(" th", field);
}

beforeEach(() => {
  const window = new Window();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", window.document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("NodeFilter", window.NodeFilter);
  vi.stubGlobal("ShadowRoot", window.ShadowRoot);
  vi.stubGlobal("Element", window.Element);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
  vi.stubGlobal("HTMLSelectElement", window.HTMLSelectElement);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(callback, 0));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("partial insert recovery through insertAtCaret", () => {
  it.each(["textarea", "contenteditable"] as const)("restores the selection after a partial insert on a %s", async (kind) => {
    const field = kind === "textarea" ? document.createElement("textarea") : document.createElement("div");
    if (kind === "textarea") field.value = "Dear Sam, see you";
    else field.textContent = "Dear Sam, see you";
    document.body.append(field);
    setUp(field);
    setCollapsedCaret(field, 9);

    const { insertAtCaret } = await import("../src/content/insert.ts");
    const answer = await insertAtCaret(field, intent, async () => null);

    expect(answer.outcome).toBe("failed");
    expect(field instanceof HTMLTextAreaElement ? field.value : field.textContent).toBe("Dear Sam, see you");
    if (field instanceof HTMLTextAreaElement) {
      expect([field.selectionStart, field.selectionEnd]).toEqual([9, 9]);
    } else {
      const selection = document.getSelection();
      expect(selection?.isCollapsed).toBe(true);
      expect(editorCaretOffset(field)).toBe(9);
    }
  });

  it.each(["textarea", "contenteditable"] as const)("refuses to overwrite a selection moved by the user on a %s", async (kind) => {
    const field = kind === "textarea" ? document.createElement("textarea") : document.createElement("div");
    if (kind === "textarea") field.value = "Dear Sam, see you";
    else field.textContent = "Dear Sam, see you";
    document.body.append(field);
    setUp(field);
    setCollapsedCaret(field, 9);

    const { insertAtCaret } = await import("../src/content/insert.ts");
    const answer = await insertAtCaret(field, intent, async () => {
      setCollapsedCaret(field, 0);
      return null;
    });

    expect(answer.outcome).toBe("stale");
    expect(field instanceof HTMLTextAreaElement ? field.value : field.textContent).toBe("Dear Sam, see you");
    if (field instanceof HTMLTextAreaElement) {
      expect([field.selectionStart, field.selectionEnd]).toEqual([0, 0]);
    } else {
      const selection = document.getSelection();
      expect(selection?.isCollapsed).toBe(true);
      expect(editorCaretOffset(field)).toBe(0);
    }
  });
});

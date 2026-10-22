// The review of PR #58, F3 and F4: a combobox undo stands on the pick's page-side record (page-state.ts, revs.ts
// ChoiceRecords), and both ways that record could be misread are pinned here.
//
// F3: the undo checked the record once, before its grant checks, and each of those awaits the worker. A person who
// re-picks the same option during that wait (a click-only activation, such as an assistive tool's, sends no pointerdown
// or keydown, so the grant survives) changes nothing the later gates read, and the clear then erased their pick. The
// record, the edit and touch counts and the shown text must be read again after every await, before the clear.
//
// F4: a pick's touch watch took the nearest element holding the control and its aria-controls list. A list portaled
// under <body> made that <body>, so a click on any unrelated control counted against the pick and refused a later undo.
//
// The extension's tests run without a DOM. Elements here are small fakes carrying what page-state.ts, flavor.ts and
// combobox.ts read, and the fakes' classes stand in for the browser globals those modules test with instanceof. Two
// seams are replaced: dom.ts, so the test sees every event the undo would dispatch and nothing waits on animation
// frames; and page-state.ts readNow, whose secret check runs the walker over a real document. The stand-in reads the
// fake's value through the real Revs, as readNow does for a text control that is not secret.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseOption } from "../src/content/combobox.ts";
import { beginChoice, revs, touchCount, trackTrustedTouches } from "../src/content/page-state.ts";

const G = globalThis as unknown as Record<string, unknown>;
G.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, CDATA_SECTION_NODE: 4 };
G.ShadowRoot = class {};

interface FakeDoc {
  body: FakeEl;
  documentElement: FakeEl;
  getElementById(id: string): FakeEl | null;
}

/** An element: its tag, attributes, light-DOM parent and children, and an input's value and labels. */
class FakeEl {
  readonly nodeType = 1;
  readonly shadowRoot = null;
  readonly className = "";
  parentNode: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  value = "";
  labels: FakeEl[] = [];
  ownerDocument!: FakeDoc;
  readonly localName: string;
  readonly attrs: Record<string, string>;
  constructor(localName: string, attrs: Record<string, string> = {}) {
    this.localName = localName;
    this.attrs = attrs;
  }
  get id(): string {
    return this.attrs.id ?? "";
  }
  get parentElement(): FakeEl | null {
    return this.parentNode;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  getRootNode(): FakeDoc {
    return this.ownerDocument;
  }
  closest(): null {
    return null;
  }
  append(...kids: FakeEl[]): this {
    for (const k of kids) {
      k.parentNode = this;
      this.children.push(k);
    }
    return this;
  }
  focus(): void {}
  blur(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}
class FakeInput extends FakeEl {}
G.Element = FakeEl;
G.HTMLElement = FakeEl;
G.HTMLInputElement = FakeInput;
G.HTMLTextAreaElement = class extends FakeEl {};

/** Every event the undo dispatched on the page, in order: what it would have done to the person's pick. */
const dispatched = vi.hoisted((): string[] => []);

vi.mock("../src/content/dom.ts", () => ({
  settle: async () => {},
  until: async <T>(read: () => T | null) => read(),
  typeInto: (el: { value: string }, value: string) => {
    dispatched.push(`typeInto ${JSON.stringify(value)}`);
    el.value = value;
  },
  keyEvents: (_el: unknown, key: string) => void dispatched.push(`key ${key}`),
  pressEvents: () => void dispatched.push("press"),
}));

vi.mock("../src/content/page-state.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/content/page-state.ts")>();
  return {
    ...real,
    readNow: (el: { value: string }) => {
      const r = real.revs.read(el as unknown as Element, el.value, true);
      return { text: el.value, rev: r.rev, origin: r.origin, withheld: null };
    },
  };
});

const PICK = "Bluebell State";
const OTHER = "Redwood College";
const TOUCHED = "the undo is refused: something of the person's has touched the control since Caret picked it";

/** The capture listeners trackTrustedTouches registers on the window, by event type. */
const listeners = new Map<string, ((e: unknown) => void)[]>();
G.addEventListener = (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);

/** A trusted event of `type` at `target`, as the person's own click or key reaches the window's capture listeners. */
function trusted(type: string, target: FakeEl): void {
  for (const fn of listeners.get(type) ?? []) fn({ isTrusted: true, type, composedPath: () => [target] });
}

/** A document: <html><body>…</body></html>, whose getElementById searches the tree. */
function documentWith(...bodyKids: FakeEl[]): FakeDoc {
  const html = new FakeEl("html");
  const body = new FakeEl("body");
  html.append(body.append(...bodyKids));
  const doc: FakeDoc = {
    body,
    documentElement: html,
    getElementById: (id) => {
      const find = (n: FakeEl): FakeEl | null => (n.id === id ? n : n.children.map(find).find((x) => x !== null) ?? null);
      return find(html);
    },
  };
  const own = (n: FakeEl): void => {
    n.ownerDocument = doc;
    n.children.forEach(own);
  };
  own(html);
  return doc;
}

beforeAll(() => {
  trackTrustedTouches();
});
beforeEach(() => {
  dispatched.length = 0;
});

describe("a combobox undo reads the pick's record again after every await (F3)", () => {
  /** A generic ARIA text combobox whose list sits beside it, Caret's pick of PICK in it and recorded. */
  function picked(taskId: string): { input: FakeInput; option: FakeEl; rev: number } {
    const input = new FakeInput("input", { id: "school", role: "combobox", "aria-expanded": "false", "aria-controls": "school-list" });
    const option = new FakeEl("li", { role: "option" });
    const list = new FakeEl("ul", { id: "school-list", role: "listbox" }).append(option);
    documentWith(new FakeEl("div").append(input, list));
    beginChoice(taskId, input as unknown as Element, PICK, null);
    input.value = PICK;
    return { input, option, rev: revs.caretWrote(input as unknown as Element, PICK, false, true) };
  }

  const undoVerb = (taskId: string, rev: number) =>
    ({ kind: "pageChooseOption", taskId, tabId: 1, frameId: 0, documentId: "d", id: "c1", control: "combobox", name: "School", value: "", expectRev: rev, wrote: PICK, sameAs: "m1" }) as const;

  /** A grant check that answers yes, after running `meanwhile` while the n-th call is out at the worker. */
  function aliveWith(n: number, meanwhile: () => void): () => Promise<boolean> {
    let calls = 0;
    return async () => {
      if (++calls === n) meanwhile();
      return true;
    };
  }

  /** `call`: which grant check `meanwhile` runs during (1: before focus, 2: after it). `shows`: the control's text after. */
  const cases: { what: string; call: number; meanwhile: (p: { input: FakeInput; option: FakeEl }) => void; detail: string; shows: string }[] = [
    {
      what: "a click-only re-pick of the same option during the first grant check",
      call: 1,
      meanwhile: ({ input, option }) => {
        trusted("click", option);
        input.value = PICK; // the page's script copies the option the person chose
      },
      detail: TOUCHED,
      shows: PICK,
    },
    {
      what: "a click on the control during the grant check after focus",
      call: 2,
      meanwhile: ({ input }) => trusted("click", input),
      detail: TOUCHED,
      shows: PICK,
    },
    {
      what: "the person's own edit during a grant check",
      call: 1,
      meanwhile: ({ input }) => revs.trusted(input as unknown as Element, {}, true),
      detail: TOUCHED,
      shows: PICK,
    },
    {
      what: "the page showing another choice during a grant check",
      call: 2,
      meanwhile: ({ input }) => {
        input.value = OTHER;
      },
      detail: "the undo is refused: the control shows another choice than the one Caret picked",
      shows: OTHER,
    },
  ];

  for (const c of cases) {
    it(`refuses after ${c.what}, and dispatches nothing that would clear the control`, async () => {
      const p = picked(`t-${c.what}`);
      const answer = await chooseOption(p.input as unknown as Element, undoVerb(`t-${c.what}`, p.rev), () => null, aliveWith(c.call, () => c.meanwhile(p)));
      expect(answer.outcome).toBe("stale");
      expect(answer.detail).toBe(c.detail);
      expect(dispatched).toEqual([]);
      expect(p.input.value).toBe(c.shows);
    });
  }

  it("clears Caret's own pick when nothing touched the control during the grant checks", async () => {
    const p = picked("t-clean");
    const answer = await chooseOption(p.input as unknown as Element, undoVerb("t-clean", p.rev), () => null, async () => true);
    expect(answer.outcome).toBe("ok");
    expect(dispatched).toEqual(['typeInto ""']);
    expect(p.input.value).toBe("");
  });
});

describe("a pick's touch watch never takes in the whole page (F4)", () => {
  it("does not count a click on an unrelated control when the pick's list is portaled under <body>", () => {
    const input = new FakeInput("input", { role: "combobox", "aria-controls": "rs-listbox" });
    const option = new FakeEl("div", { role: "option" });
    const portaled = new FakeEl("div", { id: "rs-listbox", role: "listbox" }).append(option);
    const unrelated = new FakeEl("button");
    documentWith(new FakeEl("div").append(new FakeEl("div").append(input)), new FakeEl("section").append(unrelated), portaled);
    beginChoice("t-portal", input as unknown as Element, PICK, null);
    const at = touchCount(input as unknown as Element);
    trusted("click", unrelated);
    trusted("pointerdown", unrelated);
    expect(touchCount(input as unknown as Element)).toBe(at);
    // The portaled list is still the widget's own: a click on its option counts.
    trusted("click", option);
    expect(touchCount(input as unknown as Element)).toBe(at + 1);
  });

  it("counts a click anywhere in the control's own container, which the combobox names at the pick", () => {
    const input = new FakeInput("input", { role: "combobox", "aria-controls": "rs-listbox" });
    const chevron = new FakeEl("div", { "aria-hidden": "true" });
    const container = new FakeEl("div").append(new FakeEl("div").append(new FakeEl("div").append(input), chevron));
    const portaled = new FakeEl("div", { id: "rs-listbox", role: "listbox" });
    documentWith(container, portaled);
    beginChoice("t-container", input as unknown as Element, PICK, container as unknown as Element);
    const at = touchCount(input as unknown as Element);
    trusted("mousedown", chevron);
    expect(touchCount(input as unknown as Element)).toBe(at + 1);
  });

  it("still counts a chevron beside the control when the list sits in the same wrapper", () => {
    const input = new FakeInput("input", { role: "combobox", "aria-controls": "list" });
    const chevron = new FakeEl("button");
    const list = new FakeEl("ul", { id: "list", role: "listbox" });
    documentWith(new FakeEl("form").append(new FakeEl("div").append(input, chevron, list)), new FakeEl("button"));
    beginChoice("t-wrapper", input as unknown as Element, PICK, null);
    const at = touchCount(input as unknown as Element);
    trusted("click", chevron);
    expect(touchCount(input as unknown as Element)).toBe(at + 1);
  });
});

// The reader's element marks (B23, S1 audit #6; CaretScreenCore ElementMarks.swift) for the in-process and socket
// fakes: each field is an element with an identity of its own, a write's `mark` records the element it writes, and
// a write's `sameAs` must find that same element at the key, with the same wording as the reader.
import type { ReaderVerb } from "../src/protocol.ts";

type Write = Extract<ReaderVerb, { kind: "write" }>;

export class FakeMarks {
  private next = 1;
  private readonly ids = new Map<string, number>();
  private readonly marks = new Map<string, { windowId: string; key: string; id: number }>();

  /** The identity of the element at this key now. */
  element(windowId: string, key: string): number {
    const k = `${windowId}\u0000${key}`;
    let id = this.ids.get(k);
    if (id === undefined) this.ids.set(k, (id = this.next++));
    return id;
  }

  /** Another element takes the key: what an app does when it replaces a field with an identical sibling. */
  replace(windowId: string, key: string): void {
    this.ids.set(`${windowId}\u0000${key}`, this.next++);
  }

  /** The reader restarted: it keeps no marks. */
  forget(): void {
    this.marks.clear();
  }

  /** Checks `sameAs` and records `mark` for a write about to be made; the notSameElement detail, or null. */
  check(v: Write): string | null {
    const here = this.element(v.windowId, v.key);
    if (v.sameAs !== undefined) {
      const m = this.marks.get(v.sameAs);
      if (m === undefined) return "the reader holds no element under this mark";
      if (m.windowId !== v.windowId || m.key !== v.key || m.id !== here) return "another element now has this key";
    }
    if (v.mark !== undefined) this.marks.set(v.mark, { windowId: v.windowId, key: v.key, id: here });
    return null;
  }
}

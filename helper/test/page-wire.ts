// Test pages hold their fields' text; the wire never carries a text control's (counsel 2026-10-09). A test builds its
// page from TestField, which keeps a `value` on any kind as the page itself does, and sends what the content script
// would: `walked` turns a text control's value into hasValue and rev. Every name and value in tests is invented.
import { isTextKind, type ChoicePageControl, type PageControl, type PageControlKind, type PageWithheld, type PageWriteReadings, type TextPageControl } from "../src/protocol.ts";

/** A control as a test page holds it: the wire's fields, and its text whatever its kind. */
export type TestField = Omit<ChoicePageControl, "kind"> & { kind: PageControlKind; withheld?: PageWithheld; rev?: number };

/**
 * A rev for a text this stateless stand-in has no history for: a stable digest of the text, so equal text reads as the
 * same rev and any change as another. Real pages count instead (extension content/revs.ts); FakePage counts too.
 */
export function textRev(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  return h % 1_000_000;
}

/** What the content script sends for `f`: a text control without its text, with hasValue and rev; a choice control as it is. */
export function onWire(f: TestField, rev?: number): PageControl {
  const { value, checked, options, withheld, rev: own, ...rest } = f;
  if (!isTextKind(f.kind)) return { ...rest, kind: f.kind as ChoicePageControl["kind"], ...(value === undefined ? {} : { value }), ...(checked === undefined ? {} : { checked }), ...(options === undefined ? {} : { options }) };
  const text = value ?? "";
  const r = own ?? rev ?? textRev(text);
  const secret = f.excluded !== undefined || withheld === "secret";
  const out: TextPageControl = { ...rest, kind: f.kind as TextPageControl["kind"], hasValue: secret ? null : text === "" ? false : withheld === undefined ? true : null, rev: secret || (text !== "" && withheld !== undefined) ? null : r };
  if (withheld !== undefined) out.withheld = withheld;
  else if (f.excluded !== undefined) out.withheld = "secret";
  return out;
}

/** A page's write readings, as the content script computes them from the text before and after and what Caret wrote. */
export function readings(before: string, after: string, wrote: string, rev: number | null): PageWriteReadings {
  return { sameAsBefore: after === before, landed: after === wrote, equivalent: after === wrote, empty: after === "", typedBetween: false, rev };
}

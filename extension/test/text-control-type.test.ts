// A text control carries no value at the type level (counsel 2026-10-09, "the schema has no field for them"): the
// walker cannot forget to strip one, because there is nowhere to put it. tsc runs this file before vitest does
// (`pnpm test`), so each @ts-expect-error below fails the suite if the line ever compiles.
import { describe, expectTypeOf, it } from "vitest";
import type { ChoiceControl, PageControl, TextControl, TextControlKind } from "../src/shared/messages.ts";

const base = { id: "e1", key: "textbox:email~0", strongKey: null, role: "textbox", name: "Email", form: null, rect: [0, 0, 10, 10] as [number, number, number, number] };

describe("PageControl", () => {
  it("gives a text control hasValue and rev, and no value, checked or options", () => {
    expectTypeOf<TextControl["value"]>().toEqualTypeOf<undefined>();
    expectTypeOf<TextControl["hasValue"]>().toEqualTypeOf<boolean | null>();
    expectTypeOf<TextControl["rev"]>().toEqualTypeOf<number | null>();
    const ok: TextControl = { ...base, kind: "email", hasValue: true, rev: 3 };
    // @ts-expect-error a text control has no value to send
    const withValue: TextControl = { ...base, kind: "email", hasValue: true, rev: 3, value: "robin@example.test" };
    // @ts-expect-error nor may a text kind pass as a choice control to carry one
    const disguised: ChoiceControl = { ...base, kind: "text", value: "Tr0mbone-Lattice-91" };
    void [ok, withValue, disguised];
  });

  it("narrows every text kind of the union to the shape with no value", () => {
    type ValueOf<K extends PageControl["kind"]> = (PageControl & { kind: K })["value"];
    expectTypeOf<ValueOf<TextControlKind>>().toEqualTypeOf<undefined>();
    expectTypeOf<ValueOf<"textarea">>().toEqualTypeOf<undefined>();
    expectTypeOf<ValueOf<"combobox">>().toEqualTypeOf<undefined>();
    expectTypeOf<ValueOf<"contenteditable">>().toEqualTypeOf<undefined>();
    // A select's value is the option the page shows chosen: page state, sent as before.
    expectTypeOf<ValueOf<"select">>().toEqualTypeOf<string | undefined>();
  });
});

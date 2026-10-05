// What the writer sees when it turns an Ask into an intent (B25, planner/intent.ts), and the strict JSON schema
// its answer must match. The schema enumerates the snapshot's own refs, so the provider's constrained decoding
// (Groq structured outputs, strict mode) can only produce refs code listed; code still checks every part
// (checkIntent). The writer sees field names, window titles and memory labels, never a value.
import * as z from "zod";
import { REASONS, ROUTES } from "../planner/intent.ts";

const Ref = z.string().regex(/^[a-z]\d+$/u);
export const IntentInputSchema = z
  .object({
    instruction: z.string().min(1).max(500),
    form: z.string().min(1).max(200),
    fields: z.array(z.object({ ref: Ref, name: z.string().min(1).max(200), section: z.string().nullable(), control: z.string(), filled: z.boolean() }).strict()).max(40),
    sections: z.array(z.object({ ref: Ref, name: z.string() }).strict()).max(40),
    windows: z.array(z.object({ ref: Ref, app: z.string(), title: z.string().max(300), from: z.string().nullable() }).strict()).max(8),
    memory: z.array(z.string()).max(20),
    persons: z.array(z.object({ ref: Ref, span: z.string() }).strict()).max(20),
  })
  .strict();
export type IntentInput = z.infer<typeof IntentInputSchema>;

export const INTENT_SYSTEM = `You turn a user's instruction to Caret, a Mac assistant, into a small JSON intent about the form the user is looking at. Choose only refs listed in the input. Never write a value except an exact span copied from the instruction. Caret finds the values itself; you only say where to look.

route:
- fill: fill in or change fields of this form. Most instructions are this.
- plan: more than filling fields: press a button, submit, send, or several steps.
- refuse: something Caret must not or cannot do here: pay or enter a card number; a password, a one-time code, or a Social Security or other government ID number; a field this form does not have; copying from a window, file or app that is not listed.
- ask: only when the instruction names or describes no field and does not ask to fill the form.
why: for refuse or ask, the reason; otherwise none.
scope: all when the instruction asks to fill the form or whatever Caret can ("fill this out", "fill in what you can", "RSVP for me"); list when it names or describes particular fields; section only for a listed section; none for refuse, ask or plan. A route of fill always has a scope of all, section or list, and when you can list the fields, the route is fill.
section: the section ref for scope section; otherwise none.
fields: for list, every field the instruction asks for, including the parts of what it names ("my name" is First name and Last name; "the landlord part" is every landlord field; "my birthday" is the date of birth, or its Day, Month and Year; a slot or an appointment is its date and time). Words that only say where to copy from ("from my note", "what I jotted down", "Morgan's email") never name a field: "do the checkout details from my note" lists the checkout fields, not a field with "note" in its name. Empty otherwise.
sources: the listed windows the instruction says to copy from ("my note" is the note window; "Morgan's email" or "the slot Chris offered" is the window from that sender); memory when it asks for what the user told Caret about themselves and memory is listed; any when it names no source. A source that is not named is any, never a reason to ask.
whose: a person's ref when the instruction asks for that person's details in the fields ("use Gary's info", "use Ines for the emergency contact", "put Bea down as my guest"); user otherwise, including when a person only names where to copy from ("from Morgan's email", "the slot Chris offered"); unnamed when it means someone else's details but names no one ("put his number in").
literals: values the instruction spells out to be written as they are, each copied exactly with its field's ref: a time, a date, a number, an option, or quoted text ("8:15" for a delivery time field). A person's name that says whose details to use is whose, not a literal. Empty when it spells out none.`;

/** The user message for an intent request. */
export function intentUserMessage(input: IntentInput): string {
  return JSON.stringify({ instruction: input.instruction, form: input.form, fields: input.fields, sections: input.sections, windows: input.windows, memory: input.memory, persons: input.persons }, null, 1);
}

/** A non-empty enum: an empty list of refs becomes the one placeholder "none", which checkIntent refuses as a ref. */
const oneOf = (xs: readonly string[]): { type: "string"; enum: string[] } => ({ type: "string", enum: xs.length === 0 ? ["none"] : [...xs] });

/** Groq's strict json_schema response format for this input: every property required, no others, refs enumerated. */
export function intentResponseFormat(input: IntentInput): Record<string, unknown> {
  const fieldRefs = input.fields.map((f) => f.ref);
  return {
    type: "json_schema",
    json_schema: {
      name: "ask_intent",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["route", "why", "scope", "section", "fields", "sources", "whose", "literals"],
        properties: {
          route: oneOf(ROUTES),
          why: oneOf(REASONS),
          scope: oneOf(["all", "section", "list", "none"]),
          section: oneOf(["none", ...input.sections.map((s) => s.ref)]),
          fields: { type: "array", items: oneOf(fieldRefs) },
          // Memory is a source only when the user told Caret something.
          sources: { type: "array", items: oneOf(["any", ...(input.memory.length > 0 ? ["memory"] : []), "instruction", ...input.windows.map((w) => w.ref)]) },
          whose: oneOf(["user", "unnamed", ...input.persons.map((p) => p.ref)]),
          literals: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["field", "text"], properties: { field: oneOf(fieldRefs), text: { type: "string" } } },
          },
        },
      },
    },
  };
}

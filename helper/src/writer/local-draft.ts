// A draft from the local model (L1 lead decision 6): words for one message or description field, under a grammar that
// allows only plain sentences. Code still decides whether a draft may be offered: goals/drafts.ts checks its facts and
// Jev its claims, unchanged. Measured on B30's cases and D2-06's scenes (scripts/goal-drafts-eval.ts,
// goal-scenes-eval.ts); lead decision 2026-10-05: on no default path until the host's engine can apply a grammar.
//
// The development model, Cotypist's Gemma 4 E2B, is a base model (G1), so the prompt is a few-shot document, not a
// chat. Its examples are invented and appear in no evaluation case. The host renders localTextRequest's prompt parts
// into its own model's prompt; this file is the rendering L1 measured, for the host batch to match or replace.
import type { LocalTextAsk } from "./local-port.ts";

/**
 * One to three sentences on one line. A sentence starts with a capital letter, a digit or "$", is words separated by
 * single spaces, and ends with ".", "!" or "?". A word is ASCII letters and digits with the punctuation an address, a
 * time or an amount needs inside it ('@.:/&%$+,-). No quotes, brackets, list marks, line breaks or formatting can be
 * produced, and letters outside ASCII cannot either, so a name like "José" cannot be written (a known gap).
 */
export const DRAFT_GRAMMAR = `root ::= sentence (" " sentence)? (" " sentence)?
sentence ::= first (" " word)* end
first ::= [A-Z0-9$] tail
word ::= [A-Za-z0-9$] tail
tail ::= [A-Za-z0-9'@.:/&%$+,-]*
end ::= "." | "!" | "?"
`;

/** Output cap: three sentences of a short reply. The longest B30 draft the program writer wrote was about 40 tokens. Assumed. */
export const LOCAL_DRAFT_MAX_TOKENS = 96;
/** How long a draft may take, from the request. Assumed, not measured; the eval reports the real times. */
export const LOCAL_DRAFT_DEADLINE_MS = 20_000;
/** Longest text of one basis window the prompt carries, in characters (localTextRequest allows 4,000). */
const BASIS_CHARS = 1500;

const HEADER = `Each reply below was written by an assistant for the user, in the field named. It does only what the instruction asks, in one to three plain sentences, in the user's voice. Every name, number, date, time, amount, email and link in it appears in the instruction or the source. It adds no promise, apology, date, time or detail of its own.

`;

interface Example {
  instruction: string;
  field: string;
  source: string;
  reply: string;
}

const EXAMPLES: readonly Example[] = [
  {
    instruction: "draft a reply thanking Noor for the photos",
    field: "Message",
    source: "Photos from the hike\nFrom: Noor Haddad <noor.h@example.org>\nHere are the photos from Saturday's hike at Bear Creek.",
    reply: "Thanks for the photos from Saturday's hike, Noor.",
  },
  {
    instruction: "write the description: the charger stopped working",
    field: "Description",
    source: "Order 5531 shipped\nYour order 5531 (USB-C charger) shipped on May 2.",
    reply: "The USB-C charger from order 5531 stopped working.",
  },
  {
    instruction: "tell Ravi I can make the 10:30 call on Friday",
    field: "Message",
    source: "Call on Friday?\nFrom: Ravi Menon <ravi@example.net>\nCould we do a call on Friday at 10:30 AM?",
    reply: "Hi Ravi, I can make the 10:30 call on Friday.",
  },
];

const block = (instruction: string, field: string, source: string): string => `Instruction: ${instruction}\nField: ${field}\nSource:\n${source}\nReply:`;

/**
 * The prompt as `prefix` (the header and examples, the same for every draft, which G1's tool decodes once and keeps)
 * and `prompt` (this draft). The reply's text follows "Reply: " on the same line.
 */
export function renderDraftPrompt(p: LocalTextAsk["prompt"]): { prefix: string; prompt: string } {
  const field = p.field.placeholder === null || p.field.placeholder === "" ? p.field.name : `${p.field.name} (${p.field.placeholder})`;
  const source = p.basis.length === 0 ? "(none)" : p.basis.map((b) => b.slice(0, BASIS_CHARS)).join("\n\n");
  return {
    prefix: HEADER + EXAMPLES.map((x) => `${block(x.instruction, x.field, x.source)} ${x.reply}\n\n`).join(""),
    prompt: `${block(p.instruction, field, source)} `,
  };
}

/** The request for one draft in `field`, from `basis` (each window's title and its message's words). */
export function draftAsk(instruction: string, field: { name: string; placeholder: string | null }, basis: readonly string[], now: number): LocalTextAsk {
  return {
    kind: "draft",
    grammar: DRAFT_GRAMMAR,
    prompt: { instruction: instruction.slice(0, 500), field: { name: field.name.slice(0, 200), placeholder: field.placeholder?.slice(0, 200) ?? null }, basis: basis.slice(0, 8).map((b) => b.slice(0, 4000)) },
    maxTokens: LOCAL_DRAFT_MAX_TOKENS,
    deadlineMs: now + LOCAL_DRAFT_DEADLINE_MS,
  };
}

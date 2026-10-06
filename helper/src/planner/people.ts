// Whose details an Ask means, resolved by code against the people in its sources and memory (A1 lead decision 2):
//   - a person the instruction names outside where it copies from ("use Gary's info", "make Bea my guest") is that
//     person; a relation beside the name ("Bea ... my guest") says who the name is, not a second person;
//   - a relation word ("my wife") is the memory entry with that relation, when exactly one has it;
//   - a pronoun ("his number") is the one other person in the instruction's sources: the windows it names, or every
//     window when it names none, and the people the user told Caret about;
//   - the user named beside someone ("for me and Bea") means each field's own: the user's fields the user's details;
//   - otherwise, with no one named, the user's own.
// Two or more candidates are never chosen between: the Ask asks "Whose details go in?" with them as options.
// Names read from windows here go only to the user's options and, once picked or resolved, to the fill's owner
// question, as a picked sender's name already did (B29); the intent maker never sees them.
import type { ScreenModel, WindowState } from "../model.ts";
import { isConversation } from "../conversation.ts";
import { namesIn } from "../fill/kinds.ts";
import { fieldWords, onlyInSources, restrictsSources, senderOf } from "./sources.ts";
import type { IntentSnapshot } from "./intent.ts";
import type { MemoryValue } from "./trace.ts";

/** "his phone", "her email", "their address": someone's details by a pronoun. */
export const PRONOUN_DETAILS = /\b(?:his|her|their|hers|theirs)\s+(?:\w+\s+){0,2}?(?:name|email|e-mail|phone|number|cell|mobile|address|details|info|information|contact|birthday|date of birth|dob)\b/iu;
/** A pronoun that stands for someone's details on its own: "put his in", "use hers". */
const PRONOUN = /\b(?:his|her|their|hers|theirs|him|them)\b/iu;

/** Words on a line that say the name on it is someone the user deals with: a role or a relation. Written for common notes, not measured. */
const PERSON_LINE = /\b(?:landlord|landlady|reference|referred|referee|recruiter|manager|boss|roommate|room-mate|spouse|wife|husband|partner|sister|brother|mom|mother|dad|father|son|daughter|friend|guest|plus-one|emergency|contact|advisor|doctor|neighbor|neighbour|colleague|coworker|cousin|aunt|uncle|grandma|grandpa|fianc[eé]e?|girlfriend|boyfriend|assistant|agent)\b/iu;

/** One person who could be meant: their name as the screen or memory shows it, and where it came from. */
export interface PersonCandidate {
  name: string;
  from: "sender" | "note" | "memory";
  windowId: string | null;
}

/** People in the open windows other than the form (each mail's sender; names on a note's role or relation lines) and in memory. Local only. */
export function peopleOnScreen(model: ScreenModel, form: WindowState, memory: readonly MemoryValue[]): PersonCandidate[] {
  const out: PersonCandidate[] = [];
  const add = (name: string, from: PersonCandidate["from"], windowId: string | null): void => {
    const n = name.replace(/\s+/gu, " ").trim();
    if (n.length < 2 || n.length > 60) return;
    const lower = n.toLowerCase();
    // "Ines" and "Ines Lindqvist" are one person: the longer form stands.
    const same = out.findIndex((p) => p.name.toLowerCase() === lower || p.name.toLowerCase().startsWith(`${lower} `) || lower.startsWith(`${p.name.toLowerCase()} `));
    if (same >= 0) {
      if ((out[same] as PersonCandidate).name.length < n.length) out[same] = { name: n, from, windowId };
      return;
    }
    out.push({ name: n, from, windowId });
  };
  for (const w of model.windows.values()) {
    if (w === form) continue;
    if (isConversation(w)) {
      const s = senderOf(w);
      if (s !== null) add(s, "sender", w.window.windowId);
      continue;
    }
    for (const n of w.nodes.values()) {
      const text = n.value ?? n.label ?? "";
      if (text.length === 0 || text.length > 8000) continue;
      for (const line of text.split(/\r?\n/u)) if (PERSON_LINE.test(line)) for (const name of namesIn(line).filter(personShaped)) add(name, "note", w.window.windowId);
    }
  }
  for (const m of memory) if (m.whose === "other" && m.text.trim() !== "") add(m.text, "memory", null);
  return out;
}

/**
 * A name a note line holds that reads as a person's, not a company's or a place's: two to four capitalized words,
 * an honorific allowed, and none of the words that end a company's or a place's name. Written for common notes, not
 * measured; a miss leaves a person out of the options, which the user can still name.
 */
function personShaped(name: string): boolean {
  const ws = name.replace(/^(?:Dr|Mr|Mrs|Ms|Mx|Prof)\.?\s+/u, "").split(/\s+/u);
  if (ws.length < 2 || ws.length > 4) return false;
  return !ws.some((w) => /^(?:Inc|LLC|Ltd|Co|Corp|Company|Labs?|Group|Partners|Bank|Bakery|Clinic|Health|Analytics|Outdoor|Dental|Apartments?|Court|Street|St|Ave|Avenue|Rd|Road|Lane|Blvd|Drive|Way|Park|Center|Centre|School|College|University|Hospital|Studio|Design|Systems|Services|Summit|Subaru|Notes?|Application|Form|Team)\.?$/u.test(w));
}

/** Whose details code reads the instruction as asking for, or none when it cannot tell without the maker. */
export type WhoseReading =
  | { kind: "user"; why: string }
  /** A person: `ref` when the instruction names them (a span), else `name`, which code resolved from sources or memory. */
  | { kind: "person"; ref: string | null; name: string | null; why: string }
  | { kind: "ask"; candidates: string[]; why: string }
  | { kind: "unread"; why: string };

const RELATION_SPAN = /^(?:my|our)\s+(\S+)$/iu;
/** The user named beside someone else: "for me and Bea", "Bea and I", "both of us". */
const USER_TOO = /\b(?:me|myself|i)\s+(?:and|&|\+)\s+\S|\S\s+(?:and|&|\+)\s+(?:me|myself|i)\b|\bboth of us\b|\bthe two of us\b|\bus both\b/iu;

/**
 * Whose details the instruction asks for, by code. `others` are the people on screen and in memory (peopleOnScreen).
 * `someoneElses` is whether code's scope reading read a kind as someone else's ("his number", "her email").
 */
export function readWhose(snap: IntentSnapshot, others: readonly PersonCandidate[], memory: readonly MemoryValue[], someoneElses: boolean): WhoseReading {
  const instruction = snap.instruction;
  const named = snap.persons.filter((p) => !onlyInSources(instruction, p.span));
  const relations = named.filter((p) => RELATION_SPAN.test(p.span));
  const names = named.filter((p) => !RELATION_SPAN.test(p.span));
  if (named.length > 0 && USER_TOO.test(fieldWords(instruction))) return { kind: "user", why: "the user is named beside them: each field's own details" };
  if (names.length === 1) return { kind: "person", ref: (names[0] as { ref: string }).ref, name: null, why: `the instruction names ${names[0]?.span}` };
  if (names.length > 1) return { kind: "ask", candidates: names.map((p) => p.span), why: `the instruction names ${names.map((p) => p.span).join(" and ")}` };
  if (relations.length === 1) {
    const rel = (RELATION_SPAN.exec((relations[0] as { span: string }).span)?.[1] ?? "").toLowerCase();
    const hits = memory.filter((m) => m.whose === "other" && new RegExp(`\\b${rel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(m.label));
    if (hits.length === 1) return { kind: "person", ref: null, name: (hits[0] as MemoryValue).text, why: `memory says ${rel} is ${hits[0]?.text}` };
    if (hits.length > 1) return { kind: "ask", candidates: hits.map((m) => m.text), why: `memory has ${hits.length} people as ${rel}` };
    return { kind: "unread", why: `memory has no one as ${rel}` };
  }
  if (relations.length > 1) return { kind: "ask", candidates: relations.map((p) => p.span), why: "the instruction names more than one relation" };
  // No one named: a pronoun for someone's details is the one other person in the instruction's sources.
  const fw = fieldWords(instruction);
  if (!someoneElses && !PRONOUN_DETAILS.test(fw) && !PRONOUN.test(fw)) return { kind: "user", why: "no one else is named" };
  if (!someoneElses && !PRONOUN_DETAILS.test(fw)) return { kind: "unread", why: "a pronoun that may not be about details" };
  if (restrictsSources(instruction)) return { kind: "ask", candidates: [], why: "the instruction keeps Caret to its own words" };
  const sourceIds = new Set(snap.named.map((n) => n.windowId));
  const inSources = sourceIds.size === 0 ? others : others.filter((p) => p.windowId !== null && sourceIds.has(p.windowId));
  if (inSources.length === 1) return { kind: "person", ref: null, name: (inSources[0] as PersonCandidate).name, why: `the one other person in the instruction's sources is ${inSources[0]?.name}` };
  return { kind: "ask", candidates: (inSources.length > 0 ? inSources : others).map((p) => p.name), why: `${inSources.length} other people are in the instruction's sources` };
}

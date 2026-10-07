// G2: what code knows about whose a candidate is, before Jev is asked (evidence/screen/g1/REPORT.txt, brief G2). Two
// kinds of evidence, kept as explicit fields on the candidate (candidates.ts Candidate.identity, Candidate.placements):
//   - identity, decided by code: a candidate that is exactly the user's own email, phone or full name from memory is the
//     user's, and fill asks no whose-value question about it;
//   - placement, shown to Jev: where the span sits in its window (a mail's To: line, a sentence of the user's note, a
//     sentence that names someone else), which a whose-value question states for Jev to weigh, never as a rule.
// Live Jev called the user's own To: address someone else's at 0.51 to 0.76 on four of six task pages, and the user's
// own note address the user's at only 0.36/0.52 (LV1 pass 1), so fill excluded or vetoed ten values a canned run wrote.
//
// What each one is for (G1's fields, evidence/screen/g1/live-vs-canned-pass1.tsv), and the wrong value it could cause:
//   - identity: wizard-1, forty, reveal, greenhouse and ashby Email and reveal's Full name, each the To: address or name
//     that memory holds exactly. Wrong value: none from code; a shared or old address the user still keeps in memory
//     is taken as theirs, as memory itself would offer it.
//   - soleRecipient, toUsersAddress: greenhouse's First and Last name, from the To: name beside the user's own address.
//     Wrong value: in a mail the user sent, when memory has no email of theirs to tell it apart, the recipient reads as
//     the user, and someone else's name or address can go in a field that wants the user's.
//   - ownNoteAlone: forty's Mobile phone, City, Apartment and ZIP (the note's own "Mobile …" and "Address: …"). Wrong
//     value: a note the user keeps for someone else ("Dad's appointment: …") with no relation word in the sentence.
//   - namesOther: none recovered; it keeps the husband's and the reference's values ("my husband Marcus Cole, …") off the
//     user's fields. Wrong value: none, a veto only withholds; it can blank the user's own value in a sentence about
//     someone else ("my landlord has my cell, 555-0164").
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import type { AboutValue } from "./about.ts";
import type { Candidate, CandidateIdentity, Placement } from "./candidates.ts";
import { namesIn, textKind } from "./kinds.ts";
import { bareLine, LABELLED, lineValues, sentenceAround } from "./line-values.ts";
import { splitAddress } from "./derive.ts";

/** Memory kinds that are the user's identity: email, phone and (with two words or more) full name. */
const IDENTITY_KINDS: ReadonlySet<string> = new Set(["email", "phone", "name"]);

/**
 * The text as identity compares it, or null when it is not that kind: an email lower-cased whole; a phone number's
 * digit groups ("(512) 555-0147" and "512-555-0147" are both 512 555 0147); a full name's words, case and all, two or
 * more, compared as written (memory's own check, about.ts aboutKind, already said the entry is a name; G2 review: a
 * capitalization test gave "sam rivera" and "张 伟" no identity). Exact token equality (brief G2): no near miss, no part,
 * no other spelling counts.
 */
export function identityKey(kind: "email" | "phone" | "name", text: string): string | null {
  const t = text.trim().replace(/\s+/gu, " ");
  if (kind === "email") return textKind(t) === "email" ? t.toLowerCase() : null;
  if (kind === "phone") return textKind(t) === "phone" ? (t.match(/\+?\d+/gu) ?? []).join(" ") : null;
  return t.split(" ").length >= 2 && !/[@<>,;:()\d]/u.test(t) ? t : null;
}

/** The user's own identities from memory, with each one's key (identityKey). */
export function identitiesOf(about: readonly AboutValue[]): { a: AboutValue; kind: CandidateIdentity["kind"]; key: string }[] {
  return about.flatMap((a) => {
    if (!IDENTITY_KINDS.has(a.kind)) return [];
    const kind = a.kind as CandidateIdentity["kind"];
    const key = identityKey(kind, a.value);
    return key === null ? [] : [{ a, kind, key }];
  });
}

/** The identity a candidate's text is exactly, or null. */
export function identityOf(text: string, ids: ReturnType<typeof identitiesOf>): CandidateIdentity | null {
  for (const x of ids) if (identityKey(x.kind, text) === x.key) return { memoryId: x.a.id, kind: x.kind, label: x.a.label, key: x.key };
  return null;
}

/** Whether two texts are the same identity of some kind (identityKey), as a recheck compares a memory entry with a value. */
export function sameIdentity(a: string, b: string): boolean {
  return (["email", "phone", "name"] as const).some((k) => {
    const x = identityKey(k, a);
    return x !== null && x === identityKey(k, b);
  });
}

/**
 * Words that say a sentence names someone other than the user: a relation of the writer's ("my husband", "Mom and
 * Dad") or a role that is always someone else's in a note or a mail ("landlord", "reference", "referred by"). Written
 * for common note and mail wording, not measured on a corpus.
 */
const RELATION =
  /\b(?:my|our|his|her|their|your)\s+(?:husband|wife|spouse|partner|fianc[eé]e?|boyfriend|girlfriend|mom|mum|mother|dad|father|parents?|sister|brother|sibling|son|daughter|kids?|children|friend|roommate|flatmate|landlord|landlady|manager|boss|supervisor|colleague|coworker|co-worker|neighbou?r|cousin|aunt|uncle|grand(?:ma|pa|mother|father|parents?)|reference|recruiter|advisor|adviser|doctor|lawyer)\b|\b(?:mom and dad|mum and dad|landlord|landlady|roommate|recruiter|reference|referee|referred by|referrer|emergency contact)\b/iu;

/**
 * The window's mail header lines ("From: …", "To: …", "Cc: …", "Bcc: …"), by name, lower-cased, each with every value
 * shown under it in the window, in order.
 */
function headers(w: WindowState): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of w.nodes.values()) {
    for (const raw of nodeText(n).split(/\r?\n/u)) {
      const m = /^(from|to|cc|bcc):\s+(\S.*)$/iu.exec(bareLine(raw));
      if (m?.[1] === undefined || m[2] === undefined) continue;
      const k = m[1].toLowerCase();
      out.set(k, [...(out.get(k) ?? []), m[2].trim()]);
    }
  }
  return out;
}
const emailsIn = (s: string): string[] => lineValues(s).filter((v) => v.kind === "email").map((v) => v.text.toLowerCase());

/**
 * Where a candidate sits (candidates.ts Placement), read from its window as it is now. `userEmails` are the user's own
 * emails from memory, lower-cased; `userNames` the user's own names from memory.
 *   - On a mail's To: line (a window that shows one From: line and one To: line): `soleRecipient` when the line names
 *     one recipient (one address at most, no comma, semicolon or "and"), the mail has no Cc: or Bcc:, and the From:
 *     address is not the user's own (then the user sent it, and its recipient is someone else); `toUsersAddress` too
 *     when that one address is the user's own.
 *   - In a sentence of any other line: `namesOther` when the sentence names someone else (RELATION); else, in the
 *     note the user just left (an editable text, no mail headers), `ownNoteAlone` when the sentence holds no other name
 *     than one inside the span, inside an address it labels, or the user's own from memory.
 */
export function placementsOf(model: ScreenModel, c: Candidate, userEmails: ReadonlySet<string>, userNames: readonly string[]): Placement[] {
  const w = model.windows.get(c.source.windowId);
  const node = w?.nodes.get(c.source.nodeKey);
  if (w === undefined || node === undefined) return [];
  const text = nodeText(node);
  const at = text.indexOf(c.text);
  if (at < 0) return [];
  const nl = text.indexOf("\n", at);
  const line = bareLine(text.slice(text.lastIndexOf("\n", at) + 1, nl < 0 ? text.length : nl));
  const h = headers(w);
  const mail = h.has("from");
  const label = LABELLED.exec(line);
  const name = label?.[1]?.trim().toLowerCase() ?? null;
  if (mail && (name === "to" || name === "from" || name === "cc" || name === "bcc")) {
    if (name !== "to" || c.context?.trim().toLowerCase() !== "to") return [];
    // G2 review: one message's headers only. A window that shows two From: or To: lines (a thread, a quoted reply)
    // does not say which headers this To: line goes with, so it gives no evidence.
    const froms = h.get("from") ?? [];
    const tos = h.get("to") ?? [];
    if (froms.length !== 1 || tos.length !== 1) return [];
    const to = label?.[2]?.trim() ?? "";
    const addresses = emailsIn(to);
    // Both facts hold only for one recipient, no Cc: or Bcc:, and a mail the user did not send (its From: address is
    // not the user's own from memory; then its recipient is someone else). The second also needs that one address
    // to be the user's own.
    const fromUser = emailsIn(froms[0] ?? "").some((e) => userEmails.has(e));
    const one = addresses.length <= 1 && !/[,;]|\sand\s/iu.test(to.replace(/<[^<>]*>/gu, ""));
    if (!one || h.has("cc") || h.has("bcc") || fromUser) return [];
    return addresses.length === 1 && userEmails.has(addresses[0] as string) ? ["soleRecipient", "toUsersAddress"] : ["soleRecipient"];
  }
  const pos = line.indexOf(c.text);
  if (pos < 0) return [];
  const sentence = sentenceAround(line, pos, c.text);
  if (RELATION.test(sentence)) return ["namesOther"];
  const ownNote = !mail && c.recency === "justLeft" && node.editable === true;
  if (!ownNote) return [];
  const value = label?.[2]?.trim() ?? null;
  const address = value !== null && splitAddress(value) !== null ? value : null;
  const others = namesIn(sentence).filter((n) => !c.text.includes(n) && !(address?.includes(n) ?? false) && !userNames.some((u) => u.includes(n)));
  return others.length === 0 ? ["ownNoteAlone"] : [];
}

// Offering a saved answer (S1) as a fill value. A saved answer is the user's own words (memory/answers.ts), so offering
// one fits the never-wrong rule only when three things hold, and each is decided separately:
//   1. It answers this field's question. Jev decides, as for any fill value: one Choice per field between the saved
//      answers and "none", asked twice with the answers shuffled and the question reworded, and offered only when both
//      asks pick the same answer at FILL_CUTOFF or above (fill.ts proposeFill runs these questions beside its own).
//   2. It was not written for someone else. Code decides (guardAnswer): an answer whose text, or the question it was
//      saved for, names an organization, product or role this page does not show is withheld, with the name.
//   3. It fits. A field whose maxlength is shorter than the answer gets nothing: Caret never cuts the user's words.
// An answer that passes is still never written unseen: the host shows it whole first (SAVED_ANSWERS_CAPABILITY), and
// the helper's own Fill all writes one only from a pop-up row that shows it (offers/fill-popup.ts).
import type { WindowState } from "../model.ts";
import type { AnswerWithheld, FillAnswer, Node } from "../protocol.ts";
import type { SavedAnswer } from "../memory/answers.ts";
import { fieldLabelText } from "./descriptor.ts";
import { fieldKinds } from "./kinds.ts";

/** The source line of a value from a saved answer; the host writes it after "from". */
export const ANSWER_SAYS = "your saved answer";
/**
 * How much of an answer a match question carries (lead decision 4): its first 300 characters. The question it was saved
 * for says most of what it answers, and the opening says the rest; the remainder of the user's prose stays on the Mac.
 * Assumed, not measured.
 */
export const ANSWER_CRITERION_CHARS = 300;
/**
 * Saved answers one field's question offers at most, by how many words their question shares with the field's label.
 * Assumed: well above how many prose answers a person keeps for one kind of form.
 */
export const MAX_ANSWERS_ASKED = 12;

/** The id of a field's saved-answer question. */
export const answerQuestionId = (fieldId: string): string => `${fieldId}_answer`;

/** A label that asks a question: ends with "?", or opens like one. */
const QUESTION = /\?\s*$|^(?:why|what|how|describe|tell us|please (?:describe|tell|share|elaborate|explain)|share|explain|is there|anything)\b/iu;

/**
 * Whether an empty field takes a written answer: a text area whose label names no value kind (an email, a date), or a
 * one-line input whose label asks a question and names no kind. A field Caret never types is not one (fill.ts filters it).
 */
export function isAnswerField(n: Node): boolean {
  if (n.editable !== true || n.states?.includes("secure") === true || (n.value ?? "") !== "") return false;
  const label = fieldLabelText(n.label) ?? fieldLabelText(n.placeholder);
  if (label === null) return false;
  const kinds = fieldKinds([label]);
  // A question's words can name a kind ("Describe a time you…" names a time); a text area that asks one is still prose.
  if (n.role === "AXTextArea") return kinds.size === 0 || QUESTION.test(label);
  return n.role === "AXTextField" && kinds.size === 0 && QUESTION.test(label) && !/\bname\b/iu.test(label);
}

/** An answer's text as a match question carries it: its first ANSWER_CRITERION_CHARS characters, marked when cut. */
export function answerExcerpt(answer: string): string {
  const t = answer.replace(/\s+/gu, " ").trim();
  return t.length <= ANSWER_CRITERION_CHARS ? t : `${t.slice(0, ANSWER_CRITERION_CHARS)}…`;
}

/**
 * A saved question as a match question carries it: cut to QUESTION_CHARS like a field's label (descriptor.ts). A saved
 * question is often the very label of the field on screen, and the ledger charges the page for every character of its
 * line a request reveals: whole, a 173-character question went over the page's share and the answer was not offered
 * (the corpus's Ashby "exceptional performance" field). Cut to what the field's descriptor already sends, it costs nothing.
 */
export function questionExcerpt(q: string): string {
  return q.length <= QUESTION_CHARS ? q : `${q.slice(0, QUESTION_CHARS - 1)}…`;
}
/** descriptor.ts MAX_LABEL_CHARS: how much of a label a fill question carries. */
const QUESTION_CHARS = 60;

/** The criterion for one saved answer: the question it was saved for, and how it starts. */
export function describeSaved(a: SavedAnswer): string {
  return `The user's saved answer to the question "${questionExcerpt(a.fields.question)}", which begins: "${answerExcerpt(a.fields.answer)}"`;
}

export const ANSWER_NONE = "No saved answer answers the question this field asks.";

/** The two wordings of a field's saved-answer question (fill.ts asks each once). */
export const ANSWER_WORDINGS = [
  (where: string, d: string): string =>
    `A form in the ${where} has this field: ${d} The user saved answers to questions on earlier forms. Which saved answer answers the question this field asks? Choose none unless the saved answer's question asks the same thing.`,
  (where: string, d: string): string =>
    `Field: ${d} It is in a form in the ${where}. Below are answers the user wrote to questions on other forms. Which one is an answer to this field's question? Answer none if no saved answer's question asks what this field asks.`,
] as const;

// MARK: - the organization guard

/** Where the page is: its address and its h1 and h2 headings, from the page engine; null fields when unknown. */
export interface PageContext {
  site: string | null;
  headings: readonly string[];
}

/** The page's words, in order, as the guard compares names against them. */
export interface PageText {
  tokens: string[];
  /** The organization the page is for, as a sentence names it, or null when code cannot tell. */
  org: string | null;
  /** The company the page's ATS address names (tenantOf), or null for any other address or none. */
  tenant: string | null;
}

/**
 * The company an ATS address names: its host and first path segment, the tenant's slug ("job-boards.greenhouse.io/
 * stripe"). Null for any other host, and for an ATS route with no slug or the embed route, where the path names no one:
 * two organizations' pages could share it (fix-check finding 3).
 */
export function tenantOf(site: string | null): string | null {
  if (site === null) return null;
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return null;
  }
  const slug = u.pathname.split("/").filter((s) => s !== "")[0];
  return ATS_HOSTS.test(u.host) && slug !== undefined && slug !== "embed" ? `${u.host}/${slug.toLowerCase()}` : null;
}

/** A page's address as "the same site" for updating a saved answer: host and first path segment. */
export function siteKey(site: string | null): string | null {
  if (site === null) return null;
  try {
    const u = new URL(site);
    return `${u.host}/${u.pathname.split("/").filter((s) => s !== "")[0] ?? ""}`;
  } catch {
    return site;
  }
}

/** Lower-case letter and digit runs, in order: "Harbor & Pine's" → harbor, pine, s. */
const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");

/** Hosts of the applicant tracking systems whose first path segment names the company. */
const ATS_HOSTS = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com)$/u;

/** The organization a page is for, from its title as Greenhouse, Ashby and Lever write it, else its ATS address. */
export function pageOrg(title: string, site: string | null): string | null {
  // A site's own suffix ("… at Stripe | Greenhouse") is not part of the organization's name.
  const t = title.trim().replace(/\s+\|\s+[^|]*$/u, "");
  const gh = /^Job Application for .+? at (.+)$/u.exec(t)?.[1];
  if (gh !== undefined) return gh.trim();
  const ashby = /^.+ @ (.+)$/u.exec(t)?.[1];
  if (ashby !== undefined) return ashby.trim();
  if (site === null) return null;
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return null;
  }
  if (!ATS_HOSTS.test(u.host)) return null;
  if (u.host.endsWith("lever.co")) {
    const lever = /^(.+?) - .+$/u.exec(t)?.[1];
    if (lever !== undefined) return lever.trim();
  }
  const slug = u.pathname.split("/").filter((s) => s !== "")[0];
  if (slug === undefined || slug === "embed") return null;
  return slug.split(/[-_]/u).map((w) => (w === "" ? w : w[0]?.toUpperCase() + w.slice(1))).join(" ");
}

/**
 * The page's text for the guard: title, address, headings, and every label and placeholder, and the value of what no
 * one types into. Never a field's value: an applicant's "Previous employer: Northwind", or an answer pasted in another
 * field, would otherwise vouch for an answer that names it (review finding 3).
 */
export function pageText(w: WindowState, ctx: PageContext): PageText {
  const parts = [w.window.title, ctx.site ?? "", ...ctx.headings];
  for (const n of w.nodes.values()) parts.push(n.label ?? "", n.placeholder ?? "", n.editable === true ? "" : (n.value ?? ""));
  return { tokens: tokens(parts.join(" \n ")), org: pageOrg(w.window.title, ctx.site), tenant: tenantOf(ctx.site) };
}

/**
 * Capitalized words that name nothing an answer could be written for: pronouns and sentence openers handled below,
 * calendar words, and job-application acronyms every company uses. Written for application answers, not measured.
 */
const NOT_NAMES = new Set(
  (
    "I I'm I've I'd I'll OK " +
    "January February March April May June July August September October November December " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    "API APIs UI UX CEO CTO CFO COO VP PM PMs HR QA CI CD PR PRs MVP KPI KPIs OKR OKRs ML AI IT"
  ).split(" "),
);
/** Words that join a name's parts: "Harbor & Pine", "Bank of the West". Not "and", which joins two names ("AWS and Terraform"). */
const JOINERS = new Set(["&", "of", "the", "de"]);

/** A word written as a name: an initial capital, a capital inside ("GitHub", "iOS"), or two or more capitals ("AWS"). */
const capitalized = (t: string): boolean => /^\p{Lu}/u.test(t) || /^\p{Ll}+\p{Lu}/u.test(t);

const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?:;])\s+|\n+|[()"“”]/u);
const tokensOf = (sentence: string): string[] => (sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*[\p{L}\p{N}]|[\p{L}\p{N}]|&/gu) ?? []).map((t) => t.replace(/['’]s$/u, ""));

/**
 * The names a text uses: runs of capitalized words (with "&" or "of" between them), possessives dropped. A sentence
 * capitalizes its first word whatever it is ("Month-end", "Tools", "Describe"), so that word counts only when it is no
 * common opener, is never written in lower case, and something says it is a name: the next word is capitalized too, it
 * has a capital inside ("GitHub"), or `context` or the text capitalizes it mid-sentence. `context` is where the answer
 * was saved (its question and the page's title), which names the organization it was written for.
 */
export function namesIn(text: string, context: readonly string[] = []): string[] {
  const all = [text, ...context].join("\n");
  const lower = new Set(all.split(/[^\p{L}\p{N}'’]+/u).filter((t) => /^\p{Ll}/u.test(t)).map((t) => t.toLowerCase()));
  const midCaps = new Set(sentencesOf(all).flatMap((s) => tokensOf(s).slice(1).filter(capitalized)));
  const isName = (t: string | undefined): boolean => t !== undefined && capitalized(t) && !NOT_NAMES.has(t);
  const out: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const toks = tokensOf(sentence);
    let run: string[] = [];
    const close = (): void => {
      while (run.length > 0 && JOINERS.has(run[run.length - 1] as string)) run.pop();
      if (run.length > 0) out.push(run.join(" "));
      run = [];
    };
    toks.forEach((t, i) => {
      const l = t.toLowerCase();
      const opener = i === 0 && (OPENERS.has(l) || lower.has(l) || !(midCaps.has(t) || /\p{Lu}/u.test(t.slice(1)) || isName(toks[1]) || toks[1] === "&"));
      const name = isName(t) && !opener;
      if (name) run.push(t);
      else if (run.length > 0 && JOINERS.has(t.toLowerCase())) run.push(t.toLowerCase() === "&" ? "&" : t);
      else close();
    });
    close();
  }
  return [...new Set(out)];
}

/** Common sentence openers, which a sentence capitalizes whatever they are. Written, not measured. */
const OPENERS = new Set(
  "a an the this that these those it its my our we you your he she they their there here when while after before since because if as at in on for from to with by of and but or so then also one two three first last next once during over under about although though however still even just yes no not most many some each every all both what why how which who where".split(" "),
);

/** Whether `name` is on the page: its words appear there in order, next to each other. */
export function onPage(name: string, page: PageText): boolean {
  const want = tokens(name.replace(/['’]s\b/gu, ""));
  if (want.length === 0) return true;
  const have = page.tokens;
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, j) => have[i + j] === w)) return true;
  return false;
}

/**
 * A question about why this organization or role: "Why us?", "Why do you want to work here?", "What draws you to …?".
 * Its answer is written for one organization whatever its words name. Written for application questions, not measured;
 * one it misses still meets the name check, and one it catches wrongly is only withheld.
 */
const FOR_THEM = /\bwhy\b.*\b(?:us|here|this|join|joining|work|working|interested|apply|applying|company|team|role|position|opportunity|mission|product)\b|\bwhat\b.*\b(?:draws|attracts|excites|interests|appeals)\b/iu;

/** Whether a text mentions an organization, in any case: its whole name, or its first word of three letters or more. */
function mentions(text: string, org: string): boolean {
  const have = tokens(text);
  const want = tokens(org);
  const head = want.find((t) => t.length >= 3 && t !== "the");
  for (let i = 0; i + want.length <= have.length; i++) if (want.every((w, j) => have[i + j] === w)) return true;
  return head !== undefined && have.includes(head);
}

/**
 * Why a matched answer is withheld on this page, or null when it may be offered. Three checks, in order:
 *
 * 1. Where it was saved. An answer that mentions the organization it was saved for, in any case and anywhere, or that
 *    answers a why-this-organization question (FOR_THEM), is offered only on that organization's page: same ATS site,
 *    same organization by title, or a page that names it. A capitalized-word search alone missed "Stripe builds…" at a
 *    sentence's start and "I admire stripe" (review finding 2); where the answer was saved says whom it was for.
 * 2. Names. The question it was saved for, then its text, must name nothing the page does not show (namesIn). A name
 *    from the question says the answer was written for that organization; one from the text, that it mentions it.
 * 3. The field's maxlength.
 */
export function guardAnswer(a: SavedAnswer, page: PageText, maxLength: number | undefined): { why: AnswerWithheld; says: string } | null {
  const forPage = page.org === null ? null : `this page is for ${page.org}`;
  const savedOrg = pageOrg(a.fields.form ?? "", a.fields.site);
  const savedTenant = tenantOf(a.fields.site);
  // The same organization only on affirmative evidence: both titles name it alike, or, where a title names none, both
  // addresses are one ATS tenant's. Two names that differ are two organizations whatever the addresses say. A page
  // that merely mentions the organization ("Have you used Stripe?") is not theirs (fix-check finding 3).
  const same =
    savedOrg !== null && page.org !== null
      ? tokens(savedOrg).join(" ") === tokens(page.org).join(" ")
      : savedTenant !== null && savedTenant === page.tenant;
  if (!same) {
    const ownName = savedOrg !== null && (mentions(a.fields.answer, savedOrg) || mentions(a.fields.question, savedOrg));
    if (ownName || FOR_THEM.test(a.fields.question)) {
      const whom = savedOrg ?? "another organization's form";
      return { why: "otherOrganization", says: forPage === null ? `This answer was written for ${whom}, and Caret can't tell whether this page is for the same organization.` : `This answer was written for ${whom}; ${forPage}.` };
    }
  }
  const context = [a.fields.question, a.fields.form ?? ""];
  const fromQuestion = namesIn(a.fields.question, context).find((n) => !onPage(n, page));
  if (fromQuestion !== undefined) return { why: "otherOrganization", says: forPage === null ? `This answer was written for ${fromQuestion}, which this page doesn't mention.` : `This answer was written for ${fromQuestion}; ${forPage}.` };
  const fromText = namesIn(a.fields.answer, context).find((n) => !onPage(n, page));
  if (fromText !== undefined) return { why: "otherOrganization", says: forPage === null ? `This answer mentions ${fromText}, which this page doesn't.` : `This answer mentions ${fromText}; ${forPage}.` };
  if (maxLength !== undefined && a.fields.answer.length > maxLength) {
    return { why: "tooLong", says: `This answer is ${a.fields.answer.length.toLocaleString("en-US")} characters, and this field takes at most ${maxLength.toLocaleString("en-US")}.` };
  }
  return null;
}

/** A field's answer provenance (protocol FillAnswer). */
export function fillAnswer(a: SavedAnswer, withheld: FillAnswer["withheld"]): FillAnswer {
  return { id: a.id, question: a.fields.question, site: a.fields.site, form: a.fields.form, savedOn: a.fields.savedOn, withheld };
}

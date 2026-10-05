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
  if (n.role === "AXTextArea") return kinds.size === 0;
  return n.role === "AXTextField" && kinds.size === 0 && QUESTION.test(label) && !/\bname\b/iu.test(label);
}

/** An answer's text as a match question carries it: its first ANSWER_CRITERION_CHARS characters, marked when cut. */
export function answerExcerpt(answer: string): string {
  const t = answer.replace(/\s+/gu, " ").trim();
  return t.length <= ANSWER_CRITERION_CHARS ? t : `${t.slice(0, ANSWER_CRITERION_CHARS)}…`;
}

/** The criterion for one saved answer: the question it was saved for, and how it starts. */
export function describeSaved(a: SavedAnswer): string {
  return `The user's saved answer to the question "${a.fields.question}", which begins: "${answerExcerpt(a.fields.answer)}"`;
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
}

/** Lower-case letter and digit runs, in order: "Harbor & Pine's" → harbor, pine, s. */
const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");

/** Hosts of the applicant tracking systems whose first path segment names the company. */
const ATS_HOSTS = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com)$/u;

/** The organization a page is for, from its title as Greenhouse, Ashby and Lever write it, else its ATS address. */
export function pageOrg(title: string, site: string | null): string | null {
  const t = title.trim();
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

/** The page's text for the guard: title, address, headings, and every label, placeholder and value on the page. */
export function pageText(w: WindowState, ctx: PageContext): PageText {
  const parts = [w.window.title, ctx.site ?? "", ...ctx.headings];
  for (const n of w.nodes.values()) parts.push(n.label ?? "", n.placeholder ?? "", n.value ?? "");
  return { tokens: tokens(parts.join(" \n ")), org: pageOrg(w.window.title, ctx.site) };
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

/**
 * The names a text uses: runs of capitalized words (with "&" or "of" between them), possessives dropped. A sentence's
 * first word counts only when the text never writes it in lower case and it is not a common opener, so "The", "When"
 * and "My" are not names but "Quillmate" at the start of a sentence is.
 */
export function namesIn(text: string): string[] {
  const lower = new Set(text.split(/[^\p{L}\p{N}'’]+/u).filter((t) => /^\p{Ll}/u.test(t)).map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n+|[()"“”]/u)) {
    const toks = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*[\p{L}\p{N}]|[\p{L}\p{N}]|&/gu) ?? [];
    let run: string[] = [];
    const close = (): void => {
      while (run.length > 0 && JOINERS.has(run[run.length - 1] as string)) run.pop();
      if (run.length > 0) out.push(run.join(" "));
      run = [];
    };
    toks.forEach((raw, i) => {
      const t = raw.replace(/['’]s$/u, "");
      const first = i === 0;
      const name = capitalized(t) && !NOT_NAMES.has(t) && !(first && (lower.has(t.toLowerCase()) || OPENERS.has(t.toLowerCase())));
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
 * Why a matched answer is withheld on this page, or null when it may be offered. First the organization guard: the
 * question it was saved for, then its text, must name nothing the page does not show. A name from the question says the
 * answer was written for that organization; one from the text says only that it mentions it. Then the field's maxlength.
 */
export function guardAnswer(a: SavedAnswer, page: PageText, maxLength: number | undefined): { why: AnswerWithheld; says: string } | null {
  const forPage = page.org === null ? null : `this page is for ${page.org}`;
  const fromQuestion = namesIn(a.fields.question).find((n) => !onPage(n, page));
  if (fromQuestion !== undefined) return { why: "otherOrganization", says: forPage === null ? `This answer was written for ${fromQuestion}, which this page doesn't mention.` : `This answer was written for ${fromQuestion}; ${forPage}.` };
  const fromText = namesIn(a.fields.answer).find((n) => !onPage(n, page));
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

import { normLabel, type CorpusAsk, type CorpusForm } from "./realfill-corpus.ts";
import { oracleOptionText, sameValue } from "./realfill-oracle.ts";

export type LabelKind = "value" | "scope" | "owner" | "other";
export interface QuestionLabel {
  kind: LabelKind;
  right: string[] | null;
}

const SOMEONE_ELSES = /\b(?:landlord|reference|emergency|guest|referr|relationship|recipient)/iu;
const FIELD_LABEL = /(?:Label|field): '(.+?)'(?=[.,;:?)]|\s|$)|[Tt]he field '(.+?)'(?=[.,;:?)]|\s|$)|fill or change '(.+?)'(?=[.,;:?)]|\s|$)/u;

export function labelQuestion(
  ask: CorpusAsk,
  form: CorpusForm,
  qid: string,
  q: { instructions: string; criteria: Record<string, string | null> },
): QuestionLabel {
  const want = ask.expected === "refuse" ? {} : ask.expected;
  const has = (id: string): boolean => Object.hasOwn(q.criteria, id);
  const result = (kind: LabelKind, right: string[] | null): QuestionLabel => {
    const offered = right?.filter(has) ?? [];
    return { kind, right: offered.length === 0 ? null : offered };
  };
  const labelIn = (): string | null => FIELD_LABEL.exec(q.instructions)?.slice(1).find((x) => x !== undefined) ?? null;
  const wantedValue = (label: string): string | undefined => Object.entries(want).find(([l]) => normLabel(l) === normLabel(label))?.[1];
  const field = (label: string) => form.fields.find((f) => normLabel(f.label) === normLabel(label));

  if (qid.startsWith("s_") && has("asks") && has("not")) {
    const label = /Field: "(.*?)"\. Control: "/u.exec(q.instructions)?.[1] ?? labelIn();
    if (label === null) return result("scope", null);
    const v = wantedValue(label);
    return result("scope", [v !== undefined && v !== "none" ? "asks" : "not"]);
  }
  if (/^f\d+$/u.test(qid) && has("none")) {
    const label = labelIn();
    if (label === null) return result("value", null);
    const v = wantedValue(label);
    if (v === undefined || v === "none") return result("value", ["none"]);
    if (["handoff", "unchecked", "checked"].includes(v)) return result("value", null);
    const accept = field(label)?.accept ?? [];
    const hits = Object.entries(q.criteria).filter(([id, description]) => {
      if (id === "none" || description === null) return false;
      const text = oracleOptionText(undefined, qid, id, description);
      return sameValue(text, v) || text === v || accept.includes(text);
    }).map(([id]) => id);
    return result("value", hits.length === 0 ? ["none"] : hits);
  }
  if (qid.endsWith("_owner")) {
    const text = /"([^"]*)"/u.exec(q.instructions)?.[1];
    if (text === undefined) return result("owner", null);
    const matches = Object.entries(want).filter(([, v]) => sameValue(text, v));
    if (matches.some(([l]) => SOMEONE_ELSES.test(l))) return result("owner", ["other", "person"]);
    if (matches.length > 0) return result("owner", ["user"]);
    if (form.fields.some((f) => !SOMEONE_ELSES.test(f.label) && sameValue(text, f.expected))) return result("owner", ["user"]);
    return result("owner", null);
  }
  if (qid.endsWith("_whose")) {
    const label = labelIn();
    if (label === null) return result("owner", null);
    if (SOMEONE_ELSES.test(label)) return result("owner", ["other", "person"]);
    const f = field(label);
    return result("owner", f !== undefined && f.expected !== "none" ? ["user"] : null);
  }
  return result("other", null);
}

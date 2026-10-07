// Two ways to make an Ask's intent (B25, planner/intent.ts), measured against each other on B24's twenty asks
// (scripts/realfill-asks.ts --maker; the pick and its numbers are in writer/config.ts ASK_MAKER):
//   - the writer, emitting strict JSON whose refs the response schema enumerates (writer/intent-prompt.ts);
//   - Jev, in two stages: Choice questions for the route, the scope, the source, whose details and each spelled-out
//     value's field, asked twice with the options reordered; then Noul questions that confirm each field of a list
//     and each value's field. A part both asks do not agree on, at the floors below, is not taken.
// Neither makes values. checkIntent checks whatever a maker returns.
import type { Settled } from "../fill/ask-scope.ts";
import type { Disclosure, Minted, ModelText } from "../privacy/disclosure.ts";
import * as z from "zod";
import { randomInt } from "node:crypto";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import { shuffled } from "../fill/fill.ts";
import type { WriterPort } from "../writer/port.ts";
import type { IntentInput } from "../writer/intent-prompt.ts";
import { REASONS, ROUTES, snapMint, type AskIntent, type IntentSnapshot } from "./intent.ts";
import { PlannerError } from "./validate.ts";
import { jevFailedError } from "./says.ts";

/** What making one intent cost, for the proposal's log and the scoreboard. */
export interface MakerUse {
  maker: "writer" | "jev" | "heads";
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface IntentMaker {
  /** "heads" is the one-request Jev maker (intent-heads.ts). */
  readonly name: "writer" | "jev" | "heads";
  /**
   * `settled`: what the request's scope question already settled (fill/ask-scope.ts Settled), which the heads maker uses
   * instead of asking it again (I2 ruling: one request, one settlement); other makers ignore it.
   */
  make(snap: IntentSnapshot, signal?: AbortSignal, settled?: Pick<Settled, "asks" | "unclear">): Promise<{ intent: AskIntent; use: MakerUse }>;
}

const IntentJson = z
  .object({
    route: z.enum(ROUTES),
    why: z.enum(REASONS),
    scope: z.enum(["all", "section", "list", "none"]),
    section: z.string(),
    fields: z.array(z.string()),
    sources: z.array(z.string()),
    whose: z.string(),
    literals: z.array(z.object({ field: z.string(), text: z.string() }).strict()),
  })
  .strict();

/** The writer's input for a snapshot: names, titles and labels the snapshot's ledger took, never a value, each minted. */
export function intentInput(snap: IntentSnapshot): Minted<IntentInput> {
  const m = snapMint(snap);
  const d = m.d;
  const form = snap.views.get(snap.window.window.windowId) ?? snap.window;
  const title = snap.title === null ? null : d.descriptor(form, snap.title);
  return {
    instruction: d.slice(m.instruction, 500),
    form: title === null ? d.app(form) : d.t`${d.app(form)} window '${d.slice(title, 150)}'`,
    fields: snap.fields.map((f) => ({ ref: d.id(f.ref), name: m.field(f), section: f.section === null ? null : m.section(f.section), control: f.neverTyped === null ? d.id(f.control) : d.own("never typed by Caret"), filled: f.filled })),
    sections: snap.sections.map((s) => ({ ref: d.id(s.ref), name: m.section(s.name) })),
    windows: snap.windows.map((w) => {
      const said = m.source(w);
      return { ref: d.id(w.ref), app: said.app, title: d.slice(said.title, 300), from: said.from };
    }),
    memory: snap.memory.flatMap((l) => m.memoryLabel(l) ?? []),
    persons: snap.persons.flatMap((p) => {
      const span = m.span(p.span);
      return span === null ? [] : [{ ref: d.id(p.ref), span }];
    }),
  };
}

/** Output cap for an intent: the schema's longest answer lists 40 refs and a few spans. Assumed, not measured. */
export const INTENT_MAX_OUTPUT_TOKENS = 400;

/** The writer as an intent maker. A provider error or an answer that does not parse is a PlannerError("unavailable"), never another model. */
export function writerIntentMaker(writer: WriterPort, disclosureId: () => string): IntentMaker {
  return {
    name: "writer",
    async make(snap, signal) {
      let r: Awaited<ReturnType<WriterPort["write"]>>;
      try {
        r = await writer.write(snap.ledger.seal({ kind: "intent", disclosureId: disclosureId(), disclosed: snap.ledger.declared().snippets, input: intentInput(snap), maxOutputTokens: INTENT_MAX_OUTPUT_TOKENS, signal: signal ?? AbortSignal.timeout(15_000) }));
      } catch (e) {
        throw new PlannerError("unavailable", `the intent writer failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      }
      const use: MakerUse = { maker: "writer", model: r.model, calls: 1, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, latencyMs: r.latencyMs };
      const parsed = IntentJson.safeParse(r.output.json);
      if (!parsed.success) throw new PlannerError("schema", `the intent writer's answer is not an intent: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return { intent: parsed.data, use };
    },
  };
}

/** Lowest agreed confidence for a Choice part of an intent: plan section 3's provisional router floor, not calibrated. */
export const ROUTE_CUTOFF = 0.75;
/** Lowest probability of yes, the lower of two asks, for a Noul part: plan section 4's provisional floor, not calibrated. */
export const NOUL_FLOOR = 0.95;

const ROUTE_CRITERIA = {
  fill: "Fill in or change fields of this form, with values from the screen, from what the user told Caret, or from the instruction itself.",
  plan: "More than filling fields with values that already exist: press a button, submit, send, add an event to the calendar, write a message, reply or description in new words, or a task of several steps.",
  refuse: "Something Caret must not or cannot do here: pay or give a card number, a password, a one-time code or a Social Security number, or fill a field this form does not have.",
  ask: "The instruction is too unclear to act on.",
} as const;
const REFUSE_REASONS = {
  neverTyped: "It asks for a card number, a password, a one-time code, or a Social Security or other government ID number.",
  payment: "It asks to pay.",
  pressOrSend: "It asks to submit, send or press something, and nothing else.",
  noSuchField: "It asks for a field this form does not have.",
  nothingToFill: "Something else Caret should not do.",
} as const;

/** Stage one's two wordings of each question; the second reorders every option list. */
const WORDS = {
  route: ["What does the user's instruction ask Caret to do with this form?", "Which describes the instruction best?"],
  why: ["Why should Caret not do what the instruction asks?", "What makes the instruction one Caret should refuse?"],
  scope: ["Which fields of the form does the instruction ask Caret to fill?", "Does the instruction ask for the whole form, a part of it, or particular fields?"],
  source: ["Where does the instruction say the values come from?", "Which source does the instruction name for the values?"],
  whose: ["Whose details does the instruction ask Caret to put in the form?", "The instruction asks for the details of which person?"],
  literal: [(d: Disclosure, span: ModelText) => d.t`The instruction spells out "${span}". Which field is that value for?`, (d: Disclosure, span: ModelText) => d.t`Which field should hold "${span}", which the user wrote in the instruction?`],
  field: [(d: Disclosure, name: ModelText) => d.t`Does the instruction ask Caret to fill in or change the field '${name}'?`, (d: Disclosure, name: ModelText) => d.t`Is the field '${name}' one of the fields the instruction asks for?`],
  tie: [(d: Disclosure, span: ModelText, name: ModelText) => d.t`Does the instruction say to put "${span}" in the field '${name}'?`, (d: Disclosure, span: ModelText, name: ModelText) => d.t`Should the field '${name}' hold "${span}", as the instruction says?`],
} as const;

/** A Choice question's criteria in a given order. */
const ordered = (c: Readonly<Record<string, ModelText>>, order: readonly string[]): Record<string, ModelText> => Object.fromEntries(order.flatMap((k) => {
  const v = c[k];
  return v === undefined ? [] : [[k, v] as const];
}));

/** Jev as an intent maker: two stages, each asked twice in parallel. */
export function jevIntentMaker(askJev: AskJev, o: { rand?: (n: number) => number } = {}): IntentMaker {
  const rand = o.rand ?? randomInt;
  return {
    name: "jev",
    async make(snap) {
      const use: MakerUse = { maker: "jev", model: "", calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
      const ask = async (a: JevRequest, b: JevRequest): Promise<[JevResult, JevResult]> => {
        let r: [JevResult, JevResult];
        try {
          r = await Promise.all([askJev(a), askJev(b)]);
        } catch (e) {
          throw jevFailedError(e);
        }
        use.calls += 2;
        use.model = r[0].model;
        use.inputTokens += r[0].inputTokens + r[1].inputTokens;
        use.costUsd += r[0].costUsd + r[1].costUsd;
        use.latencyMs += Math.max(r[0].latencyMs, r[1].latencyMs);
        return r;
      };
      const declared = snap.ledger.declared();
      const m = snapMint(snap);
      const d = m.d;
      const sources = snap.windows.map((w) => ({ w, said: m.source(w) }));
      const people = snap.persons.flatMap((p) => {
        const span = m.span(p.span);
        return span === null ? [] : [{ ref: p.ref, span }];
      });
      const state = {
        instruction: m.instruction,
        form: m.formTitle,
        form_fields: d.join(snap.fields.map((f) => m.field(f)), "; "),
        open_windows: d.join(sources.map(({ said }) => (said.from === null ? d.t`${said.app}: ${said.title}` : d.t`${said.app}: ${said.title} (from ${said.from})`)), "; "),
        task: d.own("Caret reads the user's instruction about the form on screen: what to do, which fields, from where, and for whom. Answer from the instruction; Caret finds the values itself."),
      };
      // Stage one: Choice questions.
      const scopeCriteria: Record<string, ModelText> = { all: d.own("Every empty field of the form."), list: d.own("Only particular fields that the instruction names or describes.") };
      for (const s of snap.sections) scopeCriteria[s.ref] = d.t`The fields under '${m.section(s.name)}'.`;
      const sourceCriteria: Record<string, ModelText> = { any: d.own("The instruction does not say where the values come from."), ...(snap.memory.length > 0 ? { memory: d.own("What the user told Caret about themselves (their own name and email).") } : {}), instruction: d.own("Only values the instruction itself spells out.") };
      for (const { w, said } of sources) sourceCriteria[w.ref] = said.from === null ? d.t`The ${said.app} window '${said.title}'.` : d.t`The ${said.app} window '${said.title}', from ${said.from}.`;
      sourceCriteria.missing = d.own("A window, file or app that is not among the open windows listed.");
      const whoseCriteria: Record<string, ModelText> = { user: d.own("The user's own details, or each field's own: the instruction names no one else whose details go in.") };
      for (const p of people) whoseCriteria[p.ref] = d.t`The details of ${p.span}, whom the instruction names.`;
      whoseCriteria.unnamed = d.own("Someone else's details, but the instruction does not say whose.");
      const fieldCriteria: Record<string, ModelText> = Object.fromEntries(snap.fields.map((f) => [f.ref, d.t`The field '${m.field(f)}'.`]));
      fieldCriteria.none = d.own("None of the form's fields.");
      const literalSpans = snap.literals.map((span) => m.span(span));
      const stage1 = (wording: 0 | 1): JevRequest => {
        const order = (c: Readonly<Record<string, ModelText>>): Record<string, ModelText> => (wording === 0 ? { ...c } : ordered(c, shuffled(Object.keys(c), rand)));
        const questions: JevRequest["questions"] = {
          route: { type: "choice", instructions: d.own(WORDS.route[wording]), criteria: order(d.ownRecord(ROUTE_CRITERIA)) },
          why: { type: "choice", instructions: d.own(WORDS.why[wording]), criteria: order(d.ownRecord(REFUSE_REASONS)) },
          scope: { type: "choice", instructions: d.own(WORDS.scope[wording]), criteria: order(scopeCriteria) },
          source: { type: "choice", instructions: d.own(WORDS.source[wording]), criteria: order(sourceCriteria) },
          whose: { type: "choice", instructions: d.own(WORDS.whose[wording]), criteria: order(whoseCriteria) },
        };
        literalSpans.forEach((span, i) => {
          if (span !== null) questions[`lit${i + 1}`] = { type: "choice", instructions: WORDS.literal[wording](d, span), criteria: order(fieldCriteria) };
        });
        return d.seal({ purpose: "intent.route", state, questions, snippets: declared.snippets, charged: declared.charged });
      };
      const [a, b] = await ask(stage1(0), stage1(1));
      const agreed = (q: string): string | null => {
        const x = a.answers[q];
        const y = b.answers[q];
        if (x === undefined || y === undefined) throw new PlannerError("jevFailed", `Jev gave no answer about the instruction's ${q}`);
        return x.choice === y.choice && Math.min(x.confidence, y.confidence) >= ROUTE_CUTOFF ? x.choice : null;
      };
      const route = agreed("route");
      const base: AskIntent = { route: "ask", why: "whichFields", scope: "all", section: "none", fields: [], sources: [], whose: "user", literals: [] };
      if (route === "refuse") {
        const why = agreed("why");
        return { intent: { ...base, route: "refuse", why: why !== null && why in REFUSE_REASONS ? (why as AskIntent["why"]) : "nothingToFill" }, use };
      }
      if (route === "plan") return { intent: { ...base, route: "plan", why: "none" }, use };
      // An unsettled route is read as a fill whose fields are open (B29): the user's pick of fields says it is one. The
      // other parts both asks settled stand; any part left unsettled is open, and asked about, never read wider.
      const routeOpen = route === null || route !== "fill";
      const scope = agreed("scope");
      const source = agreed("source");
      if (source === "missing") return { intent: { ...base, route: "refuse", why: "notOnScreen" }, use };
      const whose = agreed("whose");
      const ties = snap.literals.flatMap((span, i) => {
        if (literalSpans[i] === null) return [];
        const f = agreed(`lit${i + 1}`);
        const field = f === null || f === "none" ? undefined : snap.fields.find((x) => x.ref === f);
        return field === undefined ? [] : [{ span, field }];
      });
      // Stage two: Noul questions that confirm a list's fields and each value's field.
      const listed = scope === "list" && !routeOpen ? snap.fields : [];
      const stage2 = (wording: 0 | 1): JevRequest => {
        const nouls: NonNullable<JevRequest["nouls"]> = {};
        for (const f of listed) nouls[`n_${f.ref}`] = { type: "noul", instructions: WORDS.field[wording](d, m.field(f)) };
        ties.forEach((t, i) => {
          const span = m.span(t.span);
          if (span !== null) nouls[`t${i + 1}`] = { type: "noul", instructions: WORDS.tie[wording](d, span, m.field(t.field)) };
        });
        return d.seal({ purpose: "intent.fields", state, questions: {}, nouls, snippets: declared.snippets, charged: declared.charged });
      };
      let yes = (_: string): boolean => false;
      if (listed.length > 0 || ties.length > 0) {
        const [c, d] = await ask(stage2(0), stage2(1));
        yes = (id) => Math.min(c.nouls?.[id] ?? 0, d.nouls?.[id] ?? 0) >= NOUL_FLOOR;
      }
      const literals = ties.filter((_, i) => yes(`t${i + 1}`)).map((t) => ({ field: t.field.ref, text: t.span }));
      // A list is the fields both asks confirm, and the fields a confirmed value is for.
      const fields = [...new Set([...listed.filter((f) => yes(`n_${f.ref}`)).map((f) => f.ref), ...literals.map((l) => l.field)])];
      // An unsettled source or person is a question, never a wider reading: "any" would read windows the instruction
      // may have ruled out, and "user" would give a named person's fields the user's own details (B25 review).
      const open: ("fields" | "source" | "person")[] = [];
      if (routeOpen || scope === null || (scope === "list" && fields.length === 0)) open.push("fields");
      if (source === null) open.push("source");
      if (whose === "unnamed" || (whose === null && snap.persons.length > 0)) open.push("person");
      const settled = {
        scope: scope === null || scope === "all" ? ("all" as const) : scope === "list" ? ("list" as const) : ("section" as const),
        section: scope !== null && scope !== "all" && scope !== "list" ? scope : "none",
        fields: scope === "list" ? fields : [],
        sources: source === null ? [] : [source],
        whose: whose === null || whose === "unnamed" ? "user" : whose,
        literals,
      };
      if (open.length > 0) {
        const why = open[0] === "fields" ? "whichFields" : open[0] === "source" ? "whichSource" : whose === "unnamed" ? "otherPersonUnnamed" : "whichPerson";
        return { intent: { route: "ask", why, ...settled, open }, use };
      }
      return { intent: { route: "fill", why: "none", ...settled }, use };
    },
  };
}

// The rows of Caret's headless acceptance journey (journey.ts) and the report built from them. Kept apart from the run
// so tests/journey-rows.test.ts can check, without a browser, that every row is defined with its oracle and owner and
// that the report lists every row with pass or fail and a cause.
//
// A row passes only when what the run observed equals its oracle exactly (isDeepStrictEqual). A row the run never
// reached, or could not drive, fails with the reason as its cause; nothing is marked passing by default.
import { isDeepStrictEqual } from "node:util";

export const ROW_IDS = [
  "mail-to-event",
  "mail-to-event-undo",
  "mail-to-event-undo-edited",
  "ask-fill",
  "stop-mid-fill",
  "slice2-milestone-a",
  "privacy-jev-requests",
  "privacy-non-host",
  "deny-site-off",
] as const;
export type RowId = (typeof ROW_IDS)[number];

export interface RowSpec {
  id: RowId;
  /** The row's number in the journey brief (1, 1b, ...). */
  number: string;
  /** What must hold, in words: the oracle the observed values are compared against. */
  oracle: string;
  /** The pull request that owns the behavior, named when the row fails because of the product. */
  owner: string;
}

export const ROWS: readonly RowSpec[] = [
  {
    id: "mail-to-event",
    number: "1",
    oracle: "A conversation line in the web mail thread yields one event offer whose title, date, and start and end time equal the message's; accepting it writes exactly that event into the fake calendar. Location is not in the event contract (offers/event-card.ts, CalendarEvent in executor/means.ts): it is recorded as a note, not compared.",
    owner: "#22 (v2/act)",
  },
  {
    id: "mail-to-event-undo",
    number: "1b",
    oracle: "Undo of the accepted event removes it: the fake calendar holds no event afterwards.",
    owner: "#22 (v2/act)",
  },
  {
    id: "mail-to-event-undo-edited",
    number: "1c",
    oracle: "After the added event is edited in the fake calendar, Undo refuses with exactly \"You've changed this event, so Caret left it\" and the edited event stays.",
    owner: "#22 (v2/act)",
  },
  {
    id: "ask-fill",
    number: "2",
    oracle: "A host planRequest \"fill this form from the mail\" on wizard-1 previews exactly the expected values (tasks/expect/wizard-1.json); accepting writes exactly them, as the page oracle reads back; no value goes to someone else's field or is someone else's value (owners.json); Undo restores every field's prior value.",
    owner: "#14 (v2/webstore), #22 (v2/act)",
  },
  {
    id: "stop-mid-fill",
    number: "3",
    oracle: "Stop sent by the host right after the first verified write: no page write is dispatched after the Stop, and the result says \"may have been written\" for exactly the fields whose write was dispatched and not verified.",
    owner: "#21 (fix/stop-reconcile), #33 (fix/stop-input-evidence)",
  },
  {
    id: "slice2-milestone-a",
    number: "4",
    oracle: "The goal previews the open as the user's, waits, observes the thread the user opened and replays: the reply holds exactly the run's confirmation code, and the mail oracle shows no send, no search submit, one history update (the user's) and no press dispatched by Caret.",
    owner: "#29 (v2/nav)",
  },
  {
    id: "privacy-jev-requests",
    number: "5a",
    oracle: "No Jev request recorded during the run contains a password, one-time code or card number value present on the fixture pages.",
    owner: "#14 (v2/webstore)",
  },
  {
    id: "privacy-non-host",
    number: "5b",
    oracle: "A consumer that connects without host: true gets 0 proposals and no first-look preview or first look while the screen has a fillable field.",
    owner: "#46 (fix/nonhost-nothing; host proof #36, first-look preview #17)",
  },
  {
    id: "deny-site-off",
    number: "6",
    oracle: "With the fixture origin switched off through the host's settings sitesOff, nothing from that origin reaches the helper: no page snapshot, no field text, no tab text.",
    owner: "#14 (v2/webstore)",
  },
];

export interface Observation {
  /** False when the run could not drive the row at all; `cause` then says why. */
  driven: boolean;
  observed: unknown;
  expected: unknown;
  /** Why the row failed (the product gap or bug, or what kept it from being driven). Ignored when it passes. */
  cause?: string;
  /** Something observed outside the oracle, reported beside the result (row 1's location). */
  note?: string;
  /** A failure the lead has ruled known, with its label; the row still fails, marked expected. */
  expectedFailure?: string;
}

export interface RowResult extends RowSpec {
  pass: boolean;
  driven: boolean;
  observed: unknown;
  expected: unknown;
  /** Null when the row passed; otherwise never empty. */
  cause: string | null;
  note: string | null;
  /** The known-gap label when the row fails as ruled expected; null otherwise. */
  expectedFailure: string | null;
}

export interface JourneyReport {
  commit: string;
  at: string;
  passed: number;
  failed: number;
  rows: RowResult[];
}

/** Every row, in order, with its result: a row without an observation fails with `notReached` as its cause. */
export function buildReport(commit: string, at: string, observations: Partial<Record<RowId, Observation>>, notReached: string): JourneyReport {
  const unknown = Object.keys(observations).filter((k) => !(ROW_IDS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`observations for rows the journey does not define: ${unknown.join(", ")}`);
  const rows = ROWS.map((spec): RowResult => {
    const o = observations[spec.id];
    if (o === undefined) return { ...spec, pass: false, driven: false, observed: null, expected: null, cause: `not reached: ${notReached}`, note: null, expectedFailure: null };
    const pass = o.driven && isDeepStrictEqual(o.observed, o.expected);
    const cause = pass ? null : o.cause !== undefined && o.cause.trim() !== "" ? o.cause : o.driven ? "observed differs from expected; the run gave no further cause" : "not driven; the run gave no further cause";
    return { ...spec, pass, driven: o.driven, observed: o.observed, expected: o.expected, cause, note: o.note ?? null, expectedFailure: pass ? null : (o.expectedFailure ?? null) };
  });
  const passed = rows.filter((r) => r.pass).length;
  return { commit, at, passed, failed: rows.length - passed, rows };
}

const cell = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "null").replaceAll("|", "\\|").replaceAll("\n", " ");
};

/** results.md: one table row per journey row, with observed and expected written out in full below it. */
export function reportMarkdown(r: JourneyReport): string {
  const lines = [
    `# Caret journey, alpha ${r.commit}`,
    "",
    `Run at ${r.at}. ${r.passed} of ${r.rows.length} rows pass. A row passes only when observed equals expected exactly.`,
    "",
    "| Row | Id | Result | Cause | Owning PR |",
    "| --- | --- | --- | --- | --- |",
    ...r.rows.map((x) => `| ${x.number} | ${x.id} | ${x.pass ? "pass" : x.expectedFailure !== null ? "FAIL (expected)" : "FAIL"} | ${x.expectedFailure !== null ? `${cell(x.expectedFailure)}. ` : ""}${x.cause === null ? "" : cell(x.cause)}${x.note === null ? "" : ` Note: ${cell(x.note)}`} | ${x.pass ? "" : x.owner} |`),
    "",
  ];
  for (const x of r.rows) {
    lines.push(`## ${x.number} ${x.id}: ${x.pass ? "pass" : "FAIL"}`, "", `Oracle: ${x.oracle}`, "");
    if (x.expectedFailure !== null) lines.push(`Expected failure: ${x.expectedFailure}`, "");
    if (x.cause !== null) lines.push(`Cause: ${x.cause}`, "");
    if (x.note !== null) lines.push(`Note: ${x.note}`, "");
    lines.push("Observed:", "", "```json", JSON.stringify(x.observed, null, 2), "```", "", "Expected:", "", "```json", JSON.stringify(x.expected, null, 2), "```", "");
  }
  return `${lines.join("\n")}\n`;
}

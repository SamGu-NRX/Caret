// SC1 section 2c: the declared shape of every request. Each purpose (fill/jev.ts JevPurpose) and writer kind
// (writer/port.ts WriterRequest.kind) lists the paths its body may hold text at, as globs, with the reasons a text there
// may have been minted under (privacy/disclosure.ts MintReason) and its longest length. Disclosure.verify checks every
// wire string against its purpose's row where each request is sent and when a builder seals it: a path with no row, a
// text minted for a reason its slot does not allow, or one over its slot's length throws OutOfShape, naming the path,
// never the text. Adding a slot to a request means adding its row here, where a reviewer reads every request at once.
//
// Globs: `[*]` is any index of a list; `questions.*` any question (choice or yes/no); `criteria.*` any option. The
// client may move an option's description shared by several questions into `state.option_descriptions` (fill/jev.ts
// wireBody); it is checked as the `questions.*.criteria.*` it came from.
//
// Where the rows came from: every path, the union of the reasons and the longest text the builders produced across all
// 178 helper test files and the scripted oracle and adversary (PV2 step 5 observation, 7 Oct 2026:
// ~/.caret-run/evidence/screen/pv2/shapes, derive.py). The reasons are what the builders do today.
//
// The lengths are UNMEASURED: 2x the longest fixture/oracle text, >=1200 for screen-text slots. Each `max` is the
// longest seen, doubled, rounded up to a hundred, and at least 100; a slot that may hold the user's instruction adds
// the 500 characters an instruction may have (protocol.ts); a slot that may hold screen text allows at least
// WINDOW_CHARS (privacy.ts, 1,200), what one window may give one request. No live run measured them. A request over
// one is refused, which fails closed, and the refusal is logged with its purpose, slot and length, never its text
// (privacy/disclosure.ts setShapeLengthLog), so a live run can measure them. The `seen` comment is that longest. An app
// slot also allows Caret's own "an app", which names an app whose name a window shows as a line when that will not fit.
import type { JevPurpose } from "../fill/jev.ts";
import type { WriterRequest } from "../writer/port.ts";
import type { MintReason } from "./disclosure.ts";
import { OWNER_NOTE_CHARS } from "../privacy.ts";

/** What one path of a request may hold: texts minted under these reasons only, at most `max` characters long. */
export interface Slot {
  readonly reasons: readonly MintReason[];
  readonly max: number;
}

/**
 * The purpose a request with none is checked as. Only tests and evaluation scripts build one, from fixture wording (fill/
 * jev.ts JevRequest.purpose); it may carry Caret's own wording, at any path, and no screen text at all.
 */
export const UNNAMED = "unnamed";

/**
 * The requests that ask owner questions, whose state.source_notes holds whole owner notes at the owner-note allotment
 * (OUTPUT-LEDGER-SPEC section 8): fill's owner questions and HA2's on a plan's values. A value question that names the
 * same notes (value settlement's fill.values and fill.verify) holds them to the window's limit.
 */
export const OWNER_QUESTION_PURPOSES: ReadonlySet<string> = new Set<ShapeKey>(["fill.whose", "plan.verify"]);
/** The glob a row may use for every path: only UNNAMED's row does. */
export const ANY_PATH = "**";

/** A kind of request with a shape: a Jev purpose or a writer kind, or UNNAMED. */
export type ShapeKey = JevPurpose | WriterRequest["kind"] | typeof UNNAMED;

export const SHAPES: { readonly [K in ShapeKey]: Readonly<Record<string, Slot>> } = {
  // Assumed: 4,000 characters is well past any fixture's longest wording (475 seen); own wording reveals no screen text.
  [UNNAMED]: { [ANY_PATH]: { reasons: ["ownWording"], max: 4000 } },
  "ask.confirm": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 100 }, // seen 42
    "questions.*.instructions": { reasons: ["descriptor", "instruction", "ownWording"], max: 1200 }, // seen 155
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 54
    "state.task": { reasons: ["ownWording"], max: 200 }, // seen 77
  },
  "ask.heads": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "instruction", "ownWording"], max: 1200 }, // seen 196
    "questions.*.instructions": { reasons: ["ownWording"], max: 200 }, // seen 66
    "state.form.fields[*].control": { reasons: ["ownWording"], max: 100 }, // seen 20
    "state.form.fields[*].id": { reasons: ["ownWording"], max: 100 }, // seen 3
    "state.form.fields[*].name": { reasons: ["descriptor", "instruction", "ownWording"], max: 1200 }, // seen 60
    "state.form.fields[*].section": { reasons: ["ownWording"], max: 100 }, // seen 3
    "state.form.sections[*].id": { reasons: ["ownWording"], max: 100 }, // seen 3
    "state.form.sections[*].name": { reasons: ["descriptor"], max: 1200 }, // seen 31
    "state.form.title": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 92
    "state.people[*].id": { reasons: ["ownWording"], max: 100 }, // seen 2
    "state.people[*].span": { reasons: ["descriptor", "instruction"], max: 1200 }, // seen 13
    "state.sources[*].id": { reasons: ["ownWording"], max: 100 }, // seen 2
    "state.sources[*].title": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.task": { reasons: ["ownWording"], max: 400 }, // seen 158
  },
  "ask.scope": {
    // INT1 (SCP1's section question): an option names one section of the form, a descriptor of its view; UNMEASURED,
    // WINDOW_CHARS as for any slot that may hold screen text.
    "questions.*.criteria.*": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 145 before SCP1
    "questions.*.instructions": { reasons: ["descriptor", "instruction", "memory", "ownWording"], max: 1400 }, // seen 406
    // The form's outline (intent-heads.ts formOutline): its title, each section's path and field labels, and a note when
    // the snapshot left fields out. UNMEASURED: screen-text slots at WINDOW_CHARS, as above.
    "state.form.more": { reasons: ["ownWording"], max: 100 }, // seen 37
    "state.form.sections[*].fields[*]": { reasons: ["descriptor", "ownWording"], max: 1200 },
    "state.form.sections[*].path": { reasons: ["descriptor", "ownWording"], max: 1200 },
    "state.form.title": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.instruction": { reasons: ["instruction"], max: 800 }, // seen 104
    "state.task": { reasons: ["ownWording"], max: 800 }, // seen 381
  },
  "codemode.choice": {
    // Slice 2: a list's choice group offers its rows by their labels (goals/inventory.ts), screen text minted as
    // descriptors and cut to a target label's 200 characters; every other choice offers Caret's own wording.
    "questions.*.criteria.*": { reasons: ["descriptor", "ownWording"], max: 200 }, // seen 47
    "questions.*.instructions": { reasons: ["ownWording"], max: 100 }, // seen 42
    "state.goal": { reasons: ["instruction"], max: 600 }, // seen 10
  },
  "codeplan.asksAbout": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 100 }, // seen 50
    "questions.*.instructions": { reasons: ["descriptor", "instruction", "ownWording"], max: 1200 }, // seen 125
    "state.instruction": { reasons: ["instruction"], max: 600 }, // seen 38
    "state.task": { reasons: ["ownWording"], max: 300 }, // seen 115
  },
  "draft.check": {
    "questions.*.instructions": { reasons: ["drafted", "instruction", "ownWording"], max: 1200 }, // seen 307
    "state.instruction": { reasons: ["instruction"], max: 600 }, // seen 47
    "state.task": { reasons: ["ownWording"], max: 200 }, // seen 96
  },
  "event.card": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 100 }, // seen 41
    "questions.*.instructions": { reasons: ["ownWording"], max: 600 }, // seen 290
    "state.sentence": { reasons: ["candidate"], max: 1200 }, // seen 63
    "state.task": { reasons: ["ownWording"], max: 300 }, // seen 123
  },
  "executor.target": {
    "questions.*.criteria.*": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 44
    "questions.*.instructions": { reasons: ["ownWording", "plan"], max: 1200 }, // seen 234
    "state.task": { reasons: ["ownWording"], max: 200 }, // seen 51
    "state.window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 41
  },
  "fill.values": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "held", "instruction", "memory", "ownWording"], max: 1400 }, // seen 426
    // Value settlement: an Ask's value question carries the request, the user's picks (a field's name, a window's title,
    // a person, a value), the section path and the field's contract (held: code's reading of its label) around the
    // descriptor. UNMEASURED: the old 2500 plus the 500-character request and as much again for the rest. "plan": the
    // fresh pair after a pick is composed again from texts the verifier minted as plan text (its field, its contract), and
    // past Disclosure's MAX_WAYS the composition carries every reason of its parts (live B26, one pick).
    "questions.*.instructions": { reasons: ["candidate", "descriptor", "held", "instruction", "memory", "ownWording", "plan"], max: 3500 }, // seen 989 before value settlement
    "state.destination_window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.form_fields": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 2900 }, // seen 1176
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 92
    // Value settlement: the whole units an Ask's options name, as fill.whose's source_notes.
    "state.source_notes.*": { reasons: ["candidate"], max: 1200 },
    "state.task": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 1800 }, // seen 624
  },
  "fill.verify": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 300 }, // seen 118
    // Value settlement adds the request and the user's picks: UNMEASURED, the old 2800 plus the 500-character request and as much again.
    "questions.*.instructions": { reasons: ["candidate", "descriptor", "held", "instruction", "memory", "ownWording", "plan"], max: 3800 }, // seen 1118 before value settlement
    "state.instruction": { reasons: ["instruction"], max: 800 }, // seen 135
    // Value settlement: the whole unit each Ask value sits in, as the value questions sent it.
    "state.source_notes.*": { reasons: ["candidate"], max: 1200 },
    // VERIFY_TASK is 335 characters (contract.ts); doubled and rounded up.
    "state.task": { reasons: ["ownWording"], max: 700 },
  },
  "fill.whose": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "instruction", "ownWording"], max: 1200 }, // seen 135
    "questions.*.instructions": { reasons: ["candidate", "descriptor", "memory", "ownWording"], max: 1800 }, // seen 855
    "state.destination_window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.form_fields": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 2900 }, // seen 1176
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 92
    // A whole owner note, at most the owner-note allotment (privacy.ts OWNER_NOTE_CHARS).
    "state.source_notes.*": { reasons: ["candidate"], max: OWNER_NOTE_CHARS },
    "state.task": { reasons: ["candidate", "descriptor", "instruction", "ownWording"], max: 1800 }, // seen 624
  },
  "goal": {
    "input.goal": { reasons: ["instruction"], max: 800 }, // seen 119
    "input.snapshots[*].revision": { reasons: ["ownWording"], max: 100 }, // seen 16
    "input.snapshots[*].snapshot": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.snapshots[*].targets[*].allowedPressEffects[*]": { reasons: ["ownWording"], max: 100 }, // seen 8
    // Slice 2: a list row's navigate effects (goals/capabilities.ts), and its list's choice group (goals/inventory.ts).
    "input.snapshots[*].targets[*].allowedNavigateEffects[*]": { reasons: ["ownWording"], max: 100 },
    "input.snapshots[*].questions[*].ref": { reasons: ["ownWording"], max: 100 },
    "input.snapshots[*].questions[*].text": { reasons: ["ownWording"], max: 400 },
    "input.snapshots[*].questions[*].options[*].ref": { reasons: ["ownWording"], max: 100 },
    "input.snapshots[*].questions[*].options[*].label": { reasons: ["descriptor", "ownWording"], max: 1200 },
    "input.snapshots[*].targets[*].kind": { reasons: ["ownWording"], max: 100 }, // seen 8
    "input.snapshots[*].targets[*].label": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 1200 }, // seen 32
    "input.snapshots[*].targets[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.snapshots[*].title": { reasons: ["candidate", "descriptor", "memory", "ownWording"], max: 1200 }, // seen 40
    "input.snapshots[*].values[*].display": { reasons: ["candidate", "descriptor", "held", "instruction", "ownWording"], max: 1200 }, // seen 219
    "input.snapshots[*].values[*].origin.digest": { reasons: ["ownWording"], max: 100 }, // seen 16
    "input.snapshots[*].values[*].origin.kind": { reasons: ["ownWording"], max: 100 }, // seen 7
    "input.snapshots[*].values[*].origin.parametersDigest": { reasons: ["ownWording"], max: 100 }, // seen 16
    "input.snapshots[*].values[*].origin.resolver": { reasons: ["ownWording"], max: 100 }, // seen 10
    "input.snapshots[*].values[*].origin.snapshot": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.snapshots[*].values[*].origin.source": { reasons: ["ownWording"], max: 100 }, // seen 11
    "input.snapshots[*].values[*].origin.version": { reasons: ["ownWording"], max: 100 }, // seen 8
    "input.snapshots[*].values[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 3
    "input.snapshots[*].window": { reasons: ["ownWording"], max: 100 }, // seen 2
  },
  "intent.fields": {
    "questions.*.instructions": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 97
    "state.form": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 28
    "state.form_fields": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 109
    "state.instruction": { reasons: ["instruction"], max: 600 }, // seen 43
    "state.open_windows": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 47
    "state.task": { reasons: ["ownWording"], max: 400 }, // seen 172
  },
  "intent.route": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "instruction", "ownWording"], max: 1200 }, // seen 196
    "questions.*.instructions": { reasons: ["instruction", "ownWording"], max: 700 }, // seen 80
    "state.form": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 90
    "state.form_fields": { reasons: ["descriptor", "instruction", "ownWording"], max: 1500 }, // seen 461
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 57
    "state.open_windows": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 208
    "state.task": { reasons: ["ownWording"], max: 400 }, // seen 172
  },
  "pattern.naming": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "held", "memory", "ownWording"], max: 1200 }, // seen 39
    "questions.*.instructions": { reasons: ["descriptor", "memory", "ownWording"], max: 1200 }, // seen 146
    "state.fromSections[*]": { reasons: ["candidate"], max: 1200 }, // seen 14
    "state.from[*]": { reasons: ["descriptor", "memory"], max: 1200 }, // seen 13
    "state.into": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 15
    "state.intoFields[*]": { reasons: ["descriptor"], max: 1200 }, // seen 15
  },
  "pending.change": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 400 }, // seen 172
    "questions.*.instructions": { reasons: ["ownWording"], max: 400 }, // seen 156
    "state.lines_that_changed": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 89
    "state.signs_of_running_work_now": { reasons: ["candidate", "ownWording"], max: 1200 }, // seen 91
    "state.signs_of_running_work_when_the_user_left": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 91
    "state.situation": { reasons: ["ownWording"], max: 500 }, // seen 238
    "state.window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 37
  },
  "pending.look": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 400 }, // seen 172
    "questions.*.instructions": { reasons: ["ownWording"], max: 400 }, // seen 152
    "state.last_lines": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 316
    "state.signs_of_running_work": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 38
    "state.situation": { reasons: ["ownWording"], max: 300 }, // seen 119
    "state.window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 37
  },
  "plan": {
    "input.goal": { reasons: ["instruction", "ownWording"], max: 600 }, // seen 38
    "input.snapshots[*].questions[*].options[*].label": { reasons: ["ownWording"], max: 100 }, // seen 20
    "input.snapshots[*].questions[*].options[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 5
    "input.snapshots[*].questions[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 9
    "input.snapshots[*].questions[*].text": { reasons: ["ownWording"], max: 200 }, // seen 59
    "input.snapshots[*].revision": { reasons: ["ownWording"], max: 100 }, // seen 16
    "input.snapshots[*].snapshot": { reasons: ["ownWording"], max: 100 }, // seen 11
    "input.snapshots[*].targets[*].allowedPressEffects[*]": { reasons: ["ownWording"], max: 100 }, // seen 11
    "input.snapshots[*].targets[*].kind": { reasons: ["ownWording"], max: 100 }, // seen 9
    "input.snapshots[*].targets[*].label": { reasons: ["candidate", "descriptor", "ownWording", "plan"], max: 1200 }, // seen 19
    "input.snapshots[*].targets[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 9
    "input.snapshots[*].title": { reasons: ["candidate", "descriptor", "ownWording", "plan"], max: 1200 }, // seen 200
    "input.snapshots[*].values[*].display": { reasons: ["candidate", "descriptor", "held", "memory", "ownWording"], max: 1200 }, // seen 176
    "input.snapshots[*].values[*].origin.digest": { reasons: ["ownWording"], max: 100 }, // seen 16
    "input.snapshots[*].values[*].origin.kind": { reasons: ["ownWording"], max: 100 }, // seen 4
    "input.snapshots[*].values[*].origin.snapshot": { reasons: ["ownWording"], max: 100 }, // seen 11
    "input.snapshots[*].values[*].origin.source": { reasons: ["ownWording"], max: 100 }, // seen 11
    "input.snapshots[*].values[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 7
    "input.snapshots[*].window": { reasons: ["ownWording"], max: 100 }, // seen 8
  },
  "plan.verify": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 300 }, // seen 135
    "questions.*.instructions": { reasons: ["candidate", "descriptor", "held", "instruction", "memory", "ownWording", "plan"], max: 1200 }, // seen 278
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 51
    // HA2's notes (verifyWrites): as fill.whose's source_notes.
    "state.source_notes.*": { reasons: ["candidate"], max: OWNER_NOTE_CHARS },
    "state.task": { reasons: ["ownWording"], max: 200 }, // seen 76
  },
  "planner.fields": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "held", "instruction", "memory", "ownWording"], max: 1300 }, // seen 368
    "questions.*.instructions": { reasons: ["descriptor", "instruction", "ownWording"], max: 1200 }, // seen 336
    "state.instruction": { reasons: ["instruction", "ownWording"], max: 800 }, // seen 135
    "state.task": { reasons: ["ownWording"], max: 400 }, // seen 198
    "state.window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
  },
  "planner.window": {
    "questions.*.criteria.*": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 90
    "questions.*.instructions": { reasons: ["instruction", "ownWording"], max: 800 }, // seen 123
    "state.instruction": { reasons: ["instruction"], max: 600 }, // seen 26
    "state.task": { reasons: ["ownWording"], max: 200 }, // seen 80
  },
  // Not implemented: the writer port refuses these kinds before it reads their input (writer/port.ts).
  polish: {},
  memoryProposal: {},
  "probe.latency": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 200 }, // seen 51
    "questions.*.instructions": { reasons: ["ownWording"], max: 300 }, // seen 129
    "state": { reasons: ["ownWording"], max: 100 }, // seen 38
    "state.form[*].control": { reasons: ["ownWording"], max: 100 }, // seen 8
    "state.form[*].label": { reasons: ["ownWording"], max: 100 }, // seen 23
    "state.form[*].options[*]": { reasons: ["ownWording"], max: 100 }, // seen 6
    "state.task": { reasons: ["ownWording"], max: 100 }, // seen 10
    "state.windows[*].text": { reasons: ["ownWording"], max: 1000 }, // seen 456
    "state.windows[*].title": { reasons: ["ownWording"], max: 100 }, // seen 33
  },
  "route.judge": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "ownWording"], max: 1200 }, // seen 237
    "questions.*.instructions": { reasons: ["ownWording"], max: 300 }, // seen 106
    "state.app": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 13
    "state.field": { reasons: ["ownWording"], max: 100 }, // seen 39
    "state.field.describe": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 33
    "state.form.labels[*]": { reasons: ["descriptor"], max: 1200 }, // seen 12
    "state.otherWindows[*]": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 31
    "state.task": { reasons: ["ownWording"], max: 300 }, // seen 104
    "state.window": { reasons: ["descriptor"], max: 1200 }, // seen 11
  },
  "route.pick": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 200 }, // seen 79
    "questions.*.instructions": { reasons: ["ownWording"], max: 100 }, // seen 47
    "state.app": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 13
    "state.decided": { reasons: ["ownWording"], max: 100 }, // seen 36
    "state.field.describe": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 27
    "state.form.labels[*]": { reasons: ["descriptor"], max: 1200 }, // seen 6
    "state.task": { reasons: ["ownWording"], max: 300 }, // seen 104
    "state.window": { reasons: ["descriptor"], max: 1200 }, // seen 11
  },
  "route.task": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 100 }, // seen 24
    "questions.*.instructions": { reasons: ["ownWording"], max: 800 }, // seen 365
    "state.app": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 13
    "state.field.describe": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 27
    "state.offer.found": { reasons: ["candidate", "held", "ownWording"], max: 1200 }, // seen 156
    "state.offer.sentence": { reasons: ["candidate", "ownWording"], max: 1200 }, // seen 34
    "state.offer.task": { reasons: ["ownWording"], max: 100 }, // seen 35
    "state.task": { reasons: ["ownWording"], max: 300 }, // seen 104
    "state.window": { reasons: ["descriptor"], max: 1200 }, // seen 11
  },
  "savedFile.match": {
    "questions.*.criteria.*": { reasons: ["descriptor", "memory", "ownWording"], max: 1200 }, // seen 80
    "questions.*.instructions": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 330
    "state.destination_window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 43
    "state.form_fields": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 11
    "state.task": { reasons: ["ownWording"], max: 400 }, // seen 191
  },
};

/**
 * The most items each list of a request may hold, by the glob of its items: an array's `[*]`, or the ids of
 * `questions.*`, `criteria.*` and `source_notes.*`. Every list a shape's rows reach has one; a nonempty list without one,
 * or over it, is refused and logged (privacy/disclosure.ts setShapeLengthLog), so a request is bounded in its number of
 * pieces as well as their length (OUTPUT-LEDGER-SPEC section 4: what is under 12 scalars goes uncharged).
 *
 * CHOSEN, NOT CALIBRATED. Where a builder caps the list, the cap is that constant, named beside it; elsewhere it is about
 * twice the most seen across every helper test, the scripted oracle and the adversary (~/.caret-run/evidence/screen/
 * pv2/items, 2026-10-08), rounded up, the seen value in the comment. A select's options have no builder cap: 300 covers
 * a country menu.
 */
export const ITEMS: { readonly [K in ShapeKey]: Readonly<Record<string, number>> } = {
  [UNNAMED]: { [ANY_PATH]: 200 }, // tests and evaluation scripts only
  "ask.confirm": { "questions.*": 10, "questions.*.criteria.*": 4 }, // seen 5, 2
  "ask.heads": {
    "questions.*": 8, // seen 4
    "questions.*.criteria.*": 12, // seen 6
    "state.form.fields[*]": 40, // planner/intent.ts MAX_INTENT_FIELDS
    "state.form.sections[*]": 40, // MAX_INTENT_HEADINGS
    "state.people[*]": 8, // seen 2
    "state.sources[*]": 8, // MAX_INTENT_WINDOWS
  },
  "ask.scope": {
    "questions.*": 44, // MAX_INTENT_FIELDS or MAX_INTENT_HEADINGS, and 4 fixed
    "questions.*.criteria.*": 44,
    // intent-heads.ts formOutline: a section per field at most, and a section's fields among the scope's; the scope's
    // fields are the questions' bound.
    "state.form.sections[*]": 44,
    "state.form.sections[*].fields[*]": 44,
  },
  "codemode.choice": { "questions.*": 2, "questions.*.criteria.*": 9 }, // seen 1, 3; a list's MAX_ROWS (8) and none
  "codeplan.asksAbout": { "questions.*": 2, "questions.*.criteria.*": 4 }, // seen 1, 2
  "draft.check": { "questions.*": 4 }, // seen 2
  "event.card": { "questions.*": 2, "questions.*.criteria.*": 4 }, // seen 1, 2
  "executor.target": { "questions.*": 2, "questions.*.criteria.*": 41 }, // seen 1; executor/target.ts MAX_TARGET_CANDIDATES and none
  // Value settlement's source_notes: at most one unit per option a question offers (its criteria's count).
  "fill.values": { "questions.*": 20, "questions.*.criteria.*": 100, "state.source_notes.*": 100 }, // fill.ts MAX_FIELDS; MAX_CANDIDATES (80), remembered values and none (seen 81)
  // source_notes: the one unit each value sits in, at most one per value of a batch (contract.ts VERIFY_BATCH).
  "fill.verify": { "questions.*": 40, "questions.*.criteria.*": 8, "state.source_notes.*": 20 }, // two per MAX_FIELDS (seen 20); seen 5
  "fill.whose": { "questions.*": 60, "questions.*.criteria.*": 8, "state.source_notes.*": 40 }, // MAX_FIELDS and MAX_OWNERS; seen 4; one per MAX_OWNERS
  "goal": {
    "input.snapshots[*]": 4, // goals/inventory.ts MAX_GOAL_WINDOWS and the calendar
    "input.snapshots[*].targets[*]": 40, // planner.ts MAX_PLAN_FIELDS and MAX_PLAN_BUTTONS (seen 5)
    "input.snapshots[*].targets[*].allowedPressEffects[*]": 4, // seen 2
    "input.snapshots[*].targets[*].allowedNavigateEffects[*]": 3, // capabilities.ts: e:select, e:open, e:yours
    "input.snapshots[*].targets[*].options[*]": 300, // a select's options
    "input.snapshots[*].values[*]": 40, // planner/codeplan.ts MAX_VALUES
    "input.snapshots[*].values[*].origin.inputs[*]": 4, // seen 0
    "input.snapshots[*].questions[*]": 8, // goals/inventory.ts: one per list
    "input.snapshots[*].questions[*].options[*]": 300, // a select's options
  },
  "intent.fields": { "questions.*": 40 }, // MAX_INTENT_FIELDS (seen 8)
  "intent.route": { "questions.*": 12, "questions.*.criteria.*": 12 }, // seen 6, 6
  "pattern.naming": { "questions.*": 2, "questions.*.criteria.*": 7, "state.fromSections[*]": 8, "state.from[*]": 8, "state.intoFields[*]": 8 }, // patterns/naming.ts MAX_NAME_CANDIDATES and none; seen 1, 1, 3
  "pending.change": { "questions.*": 4, "questions.*.criteria.*": 6 }, // seen 2, 3
  "pending.look": { "questions.*": 4, "questions.*.criteria.*": 6 }, // seen 2, 3
  "plan": {
    "input.snapshots[*]": 4, // codeplan.ts MAX_SOURCE_WINDOWS and the form
    "input.snapshots[*].targets[*]": 40, // MAX_PLAN_FIELDS and MAX_PLAN_BUTTONS (seen 7)
    "input.snapshots[*].targets[*].allowedPressEffects[*]": 4, // seen 1
    "input.snapshots[*].targets[*].options[*]": 300, // a select's options
    "input.snapshots[*].values[*]": 40, // MAX_VALUES
    "input.snapshots[*].values[*].origin.inputs[*]": 4, // seen 0
    "input.snapshots[*].questions[*]": 8, // seen 1
    "input.snapshots[*].questions[*].options[*]": 300, // a select's options
  },
  "plan.verify": { "questions.*": 80, "questions.*.criteria.*": 6, "state.source_notes.*": 40 }, // two per MAX_VALUES (seen 10); seen 3; one per value
  "planner.fields": { "questions.*": 20, "questions.*.criteria.*": 51 }, // MAX_PLAN_FIELDS; MAX_PLAN_VALUES, MAX_ADDRESS_PARTS and none (seen 43)
  "planner.window": { "questions.*": 2, "questions.*.criteria.*": 9 }, // MAX_INTENT_WINDOWS and none
  "probe.latency": { "questions.*": 2, "questions.*.criteria.*": 4, "state.form[*]": 20, "state.form[*].options[*]": 8, "state.windows[*]": 8, "providerOptions.gateway.only[*]": 4 }, // fixture wording
  "route.judge": { "questions.*": 4, "questions.*.criteria.*": 12, "state.form.labels[*]": 20, "state.otherWindows[*]": 8 }, // seen 3; routing/routes.ts MAX_ROUTES and none; seen 5, 2
  "route.pick": { "questions.*": 2, "questions.*.criteria.*": 12, "state.form.labels[*]": 20, "state.otherWindows[*]": 8 }, // seen 1; MAX_ROUTES and none; seen 3, 0
  "route.task": { "questions.*": 2, "questions.*.criteria.*": 4, "state.otherWindows[*]": 8 }, // seen 1, 2, 0
  "savedFile.match": { "questions.*": 2, "questions.*.criteria.*": 9 }, // goals/saved-files.ts MAX_FILES_ASKED and none
  polish: {}, // not implemented (writer/port.ts)
  memoryProposal: {}, // not implemented (writer/port.ts)
};

/** A JSON scalar a request may hold where its shape names it. */
export type ScalarType = "number" | "boolean" | "null";

/**
 * Where a request may hold a number, a boolean or null instead of text, and of which type: every other path holds a
 * minted string, a list or an object a row reaches. Read from every helper test, the scripted oracle and the adversary
 * (2026-10-08). An option with no description is null in every shape.
 */
export const SCALARS: { readonly [K in ShapeKey]?: Readonly<Record<string, readonly ScalarType[]>> } = {
  [UNNAMED]: { [ANY_PATH]: ["number", "boolean", "null"] },
  "ask.heads": { "state.form.fields[*].filled": ["boolean"], "state.form.fields[*].section": ["null"] },
  goal: { "input.snapshots[*].targets[*].canFill": ["boolean"], "input.snapshots[*].values[*].origin.startUTF16": ["number"], "input.snapshots[*].values[*].origin.endUTF16": ["number"] },
  "pattern.naming": { "state.timesSeen": ["number"] },
  plan: { "input.snapshots[*].targets[*].canFill": ["boolean"], "input.snapshots[*].values[*].origin.startUTF16": ["number"], "input.snapshots[*].values[*].origin.endUTF16": ["number"] },
  "route.judge": { "state.conversation": ["boolean"], "state.field.empty": ["boolean"], "state.field.finishedSentences": ["number"], "state.form.emptyFields": ["number"] },
  "route.pick": { "state.conversation": ["boolean"], "state.field.empty": ["boolean"], "state.field.finishedSentences": ["number"], "state.form.emptyFields": ["number"] },
  "route.task": { "state.conversation": ["boolean"], "state.field.empty": ["boolean"], "state.field.finishedSentences": ["number"] },
};

/** Paths the client writes itself (privacy/disclosure.ts EXEMPT_EXACT), as globs. */
const CLIENT_GLOBS = ["model", "providerOptions.gateway.only[*]", "questions.*.type", "state.option_descriptions"];

/** The scalar types `glob` may hold in a request of `purpose`, or none. */
export function scalarsAt(purpose: string, glob: string): readonly ScalarType[] {
  const own = Object.hasOwn(SCALARS, purpose) ? SCALARS[purpose as ShapeKey] : undefined;
  if (glob === "questions.*.criteria.*") return ["null", ...(own?.[glob] ?? own?.[ANY_PATH] ?? [])];
  return own?.[glob] ?? own?.[ANY_PATH] ?? [];
}

/**
 * Whether a key at `glob` is one a request of `purpose` may have: a row's path, a scalar's, a list's (ITEMS), a path the
 * client writes, or an object or list on the way to one. Any other key, whatever it holds, is outside the shape.
 */
export function knownPath(purpose: string, glob: string): boolean {
  const shape = shapeOf(purpose);
  if (shape === null) return false;
  if (Object.hasOwn(shape, ANY_PATH)) return true;
  const own = Object.hasOwn(SCALARS, purpose) ? Object.keys(SCALARS[purpose as ShapeKey] ?? {}) : [];
  for (const g of [...Object.keys(shape), ...own, ...Object.keys(shapeItems(purpose)), ...CLIENT_GLOBS]) if (g === glob || g.startsWith(`${glob}.`) || g.startsWith(`${glob}[`)) return true;
  return false;
}

/**
 * Whether `glob` may hold an object (`kind` "object") or a list ("list") in a request of `purpose`: some row, scalar,
 * list or client path lies under it, as `glob.` or `glob[`. Checked for every container, empty ones too, so `{}` or `[]`
 * where the shape has a string refuses. The root, and any path of a shape that allows any path, may hold either.
 */
export function containerAt(purpose: string, glob: string, kind: "object" | "list"): boolean {
  const shape = shapeOf(purpose);
  if (shape === null) return false;
  if (glob === "" || Object.hasOwn(shape, ANY_PATH)) return true;
  // The shared option descriptions an engine hoists hold the options' texts by id (childGlob maps them back).
  if (kind === "object" && glob === "state.option_descriptions") return true;
  const own = Object.hasOwn(SCALARS, purpose) ? Object.keys(SCALARS[purpose as ShapeKey] ?? {}) : [];
  const under = kind === "object" ? `${glob}.` : `${glob}[`;
  return [...Object.keys(shape), ...own, ...Object.keys(shapeItems(purpose)), ...CLIENT_GLOBS].some((g) => g.startsWith(under));
}

/** The item counts of a purpose's lists (ITEMS); none for a purpose with no shape. */
export function shapeItems(purpose: string): Readonly<Record<string, number>> {
  return Object.hasOwn(ITEMS, purpose) ? ITEMS[purpose as ShapeKey] : {};
}

/** The shape of a purpose or writer kind, or null when it has none (a request with no purpose, or a name no request uses). */
export function shapeOf(purpose: string): Readonly<Record<string, Slot>> | null {
  return Object.hasOwn(SHAPES, purpose) ? SHAPES[purpose as ShapeKey] : null;
}

/**
 * The glob of a body's child path: an index of a list is `[*]`, a question's id `questions.*`, an option's id
 * `criteria.*`, and a description the client hoisted into `state.option_descriptions` the option it came from.
 */
export function childGlob(glob: string, key: string | number): string {
  if (typeof key === "number") return `${glob}[*]`;
  if (glob === "questions") return "questions.*";
  if (glob.endsWith(".criteria")) return `${glob}.*`;
  if (glob === "state.option_descriptions") return "questions.*.criteria.*";
  // HA2: the whole notes an owner question names, by note id (fill.ts, codeplan.ts verifyWrites): one slot for any id.
  if (glob === "state.source_notes") return "state.source_notes.*";
  return glob === "" ? key : `${glob}.${key}`;
}

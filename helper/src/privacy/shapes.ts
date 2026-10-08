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
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 300 }, // seen 145
    "questions.*.instructions": { reasons: ["descriptor", "instruction", "memory", "ownWording"], max: 1400 }, // seen 406
    "state.form": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.instruction": { reasons: ["instruction"], max: 800 }, // seen 104
    "state.task": { reasons: ["ownWording"], max: 300 }, // seen 103
  },
  "codemode.choice": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 100 }, // seen 47
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
    "questions.*.instructions": { reasons: ["descriptor", "instruction", "ownWording"], max: 2500 }, // seen 989
    "state.destination_window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.form_fields": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 2900 }, // seen 1176
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 92
    "state.task": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 1800 }, // seen 624
  },
  "fill.verify": {
    "questions.*.criteria.*": { reasons: ["ownWording"], max: 300 }, // seen 118
    "questions.*.instructions": { reasons: ["candidate", "descriptor", "held", "instruction", "memory", "ownWording", "plan"], max: 2800 }, // seen 1118
    "state.instruction": { reasons: ["instruction"], max: 800 }, // seen 135
    "state.task": { reasons: ["ownWording"], max: 200 }, // seen 84
  },
  "fill.whose": {
    "questions.*.criteria.*": { reasons: ["candidate", "descriptor", "instruction", "ownWording"], max: 1200 }, // seen 135
    "questions.*.instructions": { reasons: ["candidate", "descriptor", "memory", "ownWording"], max: 1800 }, // seen 855
    "state.destination_window": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 99
    "state.form_fields": { reasons: ["candidate", "descriptor", "instruction", "memory", "ownWording"], max: 2900 }, // seen 1176
    "state.instruction": { reasons: ["instruction"], max: 700 }, // seen 92
    // INT1 (HA2's notes): a note is a candidate cut whole from one window, within its budget while OWNER_NOTE_CHARS is 0
    // (privacy.ts, TODO(INT1)), so WINDOW_CHARS; not observed in PV2's step 5 run, which predates the notes.
    "state.source_notes.*": { reasons: ["candidate"], max: 1200 },
    "state.task": { reasons: ["candidate", "descriptor", "instruction", "ownWording"], max: 1800 }, // seen 624
  },
  "goal": {
    "input.goal": { reasons: ["instruction"], max: 800 }, // seen 119
    "input.snapshots[*].revision": { reasons: ["ownWording"], max: 100 }, // seen 16
    "input.snapshots[*].snapshot": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.snapshots[*].targets[*].allowedPressEffects[*]": { reasons: ["ownWording"], max: 100 }, // seen 8
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
  "intent": {
    "input.fields[*].control": { reasons: ["ownWording"], max: 100 }, // seen 20
    "input.fields[*].name": { reasons: ["descriptor", "instruction", "memory", "ownWording"], max: 1200 }, // seen 56
    "input.fields[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 3
    "input.fields[*].section": { reasons: ["descriptor"], max: 1200 }, // seen 8
    "input.form": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 67
    "input.instruction": { reasons: ["instruction"], max: 800 }, // seen 104
    "input.memory[*]": { reasons: ["descriptor", "memory"], max: 1200 }, // seen 18
    "input.persons[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.persons[*].span": { reasons: ["descriptor", "instruction"], max: 1200 }, // seen 7
    "input.sections[*].name": { reasons: ["descriptor"], max: 1200 }, // seen 8
    "input.sections[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.windows[*].app": { reasons: ["descriptor", "ownWording"], max: 1200 }, // seen 25
    // The one value from a source window the intent writer gets, by the lead's ruling (PV2, 7 Oct): a window's sender as
    // its redacted view shows it (planner/intent.ts snapMint source), so an Ask like "fill from Priya's mail" can name
    // the window. SC1 2c gives the intent writer descriptors and the instruction only; this row is the exception,
    // tested in test/sc1-shapes.test.ts. G3's sender-versus-subject redesign will revisit it.
    "input.windows[*].from": { reasons: ["candidate"], max: 1200 }, // seen 11
    "input.windows[*].ref": { reasons: ["ownWording"], max: 100 }, // seen 2
    "input.windows[*].title": { reasons: ["descriptor"], max: 1200 }, // seen 40
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
    // INT1 (HA2's notes, verifyWrites): as fill.whose's source_notes.
    "state.source_notes.*": { reasons: ["candidate"], max: 1200 },
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

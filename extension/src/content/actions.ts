// The content script's acts (memo section 1, write path), each run only after the worker's grant check and only
// before the deadline the worker passed (the command's expiry or the grant's, whichever is first).
//
// One eligibility check guards every act: the element is still the walked one (or strongly rebound) and connected,
// not excluded, the same kind and name, the page has not moved in history since the walk, and the deadline has not
// passed. It runs before anything is touched, again after focus (focus runs page handlers synchronously, which can
// change the field: W1 review #3), and again before each later stage. The page can still change the field between
// the last check and the setter's own line; nothing in a single-threaded page runs there.
//
// Every stage boundary of a text, select or checkbox write also asks the worker whether the task's grant still
// covers this frame (W3), as the combobox handler does: after focus and before the value goes in, before change,
// and before blur. A page handler that runs long on focus or input is where a revoke can land mid-write. A grant
// that ended before the value went in stops the write untouched (notAllowed); after it went in, the write stops
// there and reports `failed` with no readings, which the helper treats as "may have landed" and records for undo.
//
// Text goes in through the prototype's value setter, which bypasses React's per-instance value tracker so its
// delegated input listener sees a real change, then input, change and blur. It is read on the next frame after blur,
// because React puts a controlled input back on its next render when its state did not take the value, and blur is the
// render most form libraries force. A value back at `before` is "the page kept the old value". The page judges the
// write itself and sends booleans (WriteReadings): a text control's text never leaves the frame (content/revs.ts).
//
// Presses are hand-offs in v1, whatever the control is called: a page button runs the page's own script, so a safe
// name ("Next", or an aria-label over destructive text) is no evidence it sends nothing (W1 review #2; memo lead
// decision on buttons that send data). The exceptions are the combobox handler (combobox.ts), which presses only
// the control it was given and that control's own listbox options, and verifies the pick; and (W4) one option of a
// Yes/No question built from toggle buttons (press.ts), which the page must show pressed afterwards.
import { isTextKind, type ActAnswer, type ActVerb, type WriteReadings } from "../shared/messages.ts";
import { classifyPress } from "../shared/risk.ts";
import { navigationEntry, type Entry, type Registry } from "./registry.ts";
import { clean } from "./names.ts";
import { controlName } from "./question.ts";
import { checkedOf, choiceValueOf, exclusionOf, kindOf, navCellsOf, textOf } from "./walker.ts";
import { openClick, setterFor, settle } from "./dom.ts";
import { chooseOption } from "./combobox.ts";
import { pressOption } from "./press.ts";
import { attachFile } from "./attach.ts";
import { insertAtCaret } from "./insert.ts";
import { compareAnswers, equivalentFor, restoreCheck, type RestoreRefusal } from "./revs.ts";
import { compareBudget, numericOf, readNow, records, revs } from "./page-state.ts";

const answer = (outcome: ActAnswer["outcome"], detail: string | null, extra: Partial<ActAnswer> = {}): ActAnswer => ({ outcome, detail, ...extra });

/**
 * Every verb this page takes. Any other kind is refused by name before anything is read: in particular the counsel's
 * pageSourceGrant, a field's text for a copy, has no handler until a flow where the user picks the source window exists.
 */
const ACT_KINDS: Readonly<Record<ActVerb["kind"], true>> = { pageWrite: true, pagePress: true, pageSelect: true, pageChooseOption: true, pageSetChecked: true, pageAttachFile: true, pageInsertText: true, pageRestore: true, pageCompare: true, pageActivateItem: true };

type Mutating = Extract<ActVerb, { kind: "pageWrite" | "pageSelect" | "pageSetChecked" | "pageRestore" }>;

/** Why the act must not go on now, or null. */
function ineligible(el: Element, verb: ActVerb, entry: Entry | undefined, deadline: number, opts: { name: boolean } = { name: true }): ActAnswer | null {
  if (!el.isConnected || el.ownerDocument !== document) return answer("stale", "the element left the document");
  if (entry !== undefined && entry.href !== location.href) return answer("stale", "the page's address changed since the walk");
  if (entry !== undefined && entry.nav !== navigationEntry()) return answer("stale", "the page moved in history since the walk");
  const name = controlName(el, kindOf(el) ?? "");
  const excluded = exclusionOf(el, name);
  if (excluded !== null) return answer("excluded", `the control is one Caret never touches (${excluded})`);
  if (kindOf(el) !== verb.control) return answer("stale", `the element is now a ${String(kindOf(el))}, not a ${verb.control}`);
  if (opts.name && name !== verb.name) return answer("stale", `the element is now named '${clean(name, 60)}', not '${clean(verb.name, 60)}'`);
  if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired");
  return null;
}

/**
 * What a strong-key rebind may accept as the walked element's replacement (registry.ts resolve): for a text control,
 * the same text the walk read at the rev the verb expects, which only this frame knows (Entry.seen); for a select, the
 * option value the verb expects. Null: no value to hold (a check, a file, an insert never rebinds).
 */
function rebindMatch(verb: ActVerb): ((el: Element, e: Entry) => boolean) | null {
  if (verb.kind === "pageWrite" || (verb.kind === "pageChooseOption" && verb.expectRev !== undefined)) {
    const rev = verb.kind === "pageWrite" ? verb.expectRev : verb.expectRev;
    return (el, e) => e.seen !== undefined && e.seen.rev === rev && revs.digestOf(textOf(el, e.kind)) === e.seen.digest;
  }
  if (verb.kind === "pageSelect") return (el) => choiceValueOf(el) === verb.expect;
  if (verb.kind === "pageChooseOption") return (el) => String(checkedOf(el)) === verb.expect;
  return null;
}

/**
 * Why the activation must not go on now, or null: the walked row's own checks (actions.ts header), without name
 * matching — the row's identity is its cells, read the same way the walk read them (walker.ts navCellsOf).
 */
function navIneligible(el: Element, verb: Extract<ActVerb, { kind: "pageActivateItem" }>, entry: Entry | undefined, deadline: number): ActAnswer | null {
  if (!el.isConnected || el.ownerDocument !== document) return answer("stale", "the row left the document");
  if (entry !== undefined && entry.href !== location.href) return answer("stale", "the page's address changed since the walk");
  if (entry !== undefined && entry.nav !== navigationEntry()) return answer("stale", "the page moved in history since the walk");
  const kind = (el.getAttribute("role") ?? "").trim().toLowerCase();
  if (kind !== verb.control) return answer("stale", `the element is now a ${clean(kind || "control", 40)}, not a ${verb.control}`);
  if (el.getAttribute("aria-disabled") === "true") return answer("failed", "the row is disabled");
  const cells = navCellsOf(el, verb.control);
  if (cells === null) return answer("stale", "the row's cells are gone");
  if (cells.join(" · ") !== verb.name) return answer("stale", `the row is now '${clean(cells.join(" · "), 60)}', not '${clean(verb.name, 60)}'`);
  if (Date.now() >= deadline) return answer("notAllowed", "the grant or command expired");
  return null;
}

/**
 * Runs one verb the worker has checked. `alive` asks the worker whether the task's grant for this frame still holds;
 * the multi-stage acts (combobox, attach) ask it before each stage (memo section 2).
 */
export async function act(reg: Registry, verb: ActVerb, deadline: number, alive: () => Promise<boolean>): Promise<ActAnswer> {
  const kind: unknown = (verb as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !Object.hasOwn(ACT_KINDS, kind)) return answer("unsupported", `this page takes no '${clean(String(kind), 40)}' verb; nothing was read`);
  if (verb.kind === "pagePress") {
    const risk = classifyPress(verb.name);
    return answer("handoff", `'${clean(verb.name, 60)}' runs the page's own script, so you press it`, { risk: risk === "safe" || risk === "unclassified" ? "pageScript" : risk });
  }
  // Slice 2: the one activation the page takes — the walked row opens through its own click handler. It resolves with
  // no rebind (the exact walked element, or nothing: registry.ts resolve with no rebindMatch), checks eligibility as
  // the walk did (the exact row kind in the verb, a list-target role) — the control kinds are all list-target roles.
  if (verb.kind === "pageActivateItem") {
    const r = reg.resolve(verb.id, null, false);
    if ("missing" in r) return answer("noElement", r.missing);
    const entry = reg.entry(verb.id);
    const navCheck = (stage?: string): ActAnswer | null => {
      const stop = navIneligible(r.el, verb, entry, deadline);
      return stop === null || stage === undefined ? stop : { ...stop, detail: `${stop.detail ?? stop.outcome} (${stage})` };
    };
    const first = navCheck();
    if (first !== null) return first;
    if (!(await alive())) return answer("notAllowed", "the task's grant ended");
    (r.el as HTMLElement).focus?.();
    const afterFocus = navCheck("focus");
    if (afterFocus !== null) return afterFocus;
    openClick(r.el);
    await settle();
    // No post-click eligibility: the open itself may have emptied the row, replaced its cells or moved the page in
    // history — the transitions the open is allowed. The helper's own judge decides what the page now shows.
    return answer("ok", null);
  }
  // P4: an insert goes only to the element the walk kept when the offer was made, never to one rebound by its strong
  // key; a restore, a compare and an undo only to the element Caret wrote.
  const rebind = verb.rebind !== false && verb.kind !== "pageInsertText" && verb.kind !== "pageRestore" && verb.kind !== "pageCompare";
  const r = reg.resolve(verb.id, rebindMatch(verb), rebind);
  if ("missing" in r) {
    if (verb.kind === "pageRestore") return answer("notSameElement", r.missing, { restore: { outcome: "refused", why: r.replaced ? "gone" : "noRecord" } });
    return answer(r.replaced && verb.rebind === false ? "notSameElement" : "noElement", r.missing);
  }
  // An undo reaches only the object its write reached: the one kept under its mark, alive in this document (W3 review #2).
  if (verb.sameAs !== undefined && reg.marked(verb.sameAs) !== r.el) {
    const detail = reg.marked(verb.sameAs) === null ? "this page keeps no element under the undo's mark (it was replaced, or the page reloaded)" : "the element at this place is not the one Caret wrote";
    return answer("notSameElement", detail, verb.kind === "pageRestore" ? { restore: { outcome: "refused", why: "gone" } } : {});
  }
  const entry = reg.entry(verb.id);
  const check = (): ActAnswer | null => ineligible(r.el, verb, entry, deadline);
  const first = check();
  if (first !== null) return first;
  // The field is read only while the task's grant still holds: a Stop that reached the worker after it sent the compare ends it here.
  if (verb.kind === "pageCompare") return (await alive()) ? compare(r.el, verb) : answer("notAllowed", "the task's grant ended");
  // Kept before anything is touched, so an act that stops midway ("may have landed") can still be undone on it.
  if (verb.mark !== undefined) reg.mark(verb.mark, r.el);
  let a: ActAnswer;
  if (verb.kind === "pageChooseOption") {
    a = verb.control === "combobox" ? await chooseOption(r.el, verb, check, alive, r.rebound) : verb.control === "button" ? await pressOption(r.el, verb, check, alive) : answer("unsupported", `a ${verb.control} is not a custom listbox; a native select takes pageSelect`);
  } else if (verb.kind === "pageInsertText") {
    // A withheld field's text is not read, and an insert checks the text before its caret against `expect`: answering
    // that would confirm a guess of it. Refused before the check (audit of PR #52, MED 5).
    const held = isTextKind(verb.control) ? readNow(r.el, verb.control, false).withheld : null;
    a = held !== null ? answer("excluded", `the field holds text Caret does not read (${held})`) : await insertAtCaret(r.el, verb, gateWith(alive, check));
  } else if (verb.kind === "pageAttachFile") {
    // Once the file is in, an upload widget often writes its name or a status line into the field's label (Lever,
    // Ashby): after that point the name may change and the element is still the one Caret wrote (W4 review #6).
    a = await attachFile(r.el, verb, check, alive, () => ineligible(r.el, verb, entry, deadline, { name: false }));
  } else {
    a = await actOn(r.el, verb, check, alive, r.rebound);
  }
  // A rebind is the one way an act reaches an element other than the walked object; the receipt says so, and names the
  // replacement's own registry id, so the helper keeps what it knows of the field under the element it wrote.
  const said = r.rebound ? { ...a, reboundTo: reg.idOf(r.el), ...(a.outcome === "ok" || a.outcome === "alreadyTrue" ? { detail: a.detail === null ? "rebound by its strong key" : `${a.detail}; rebound by its strong key` } : {}) } : a;
  return receiptFor(said, isTextKind(verb.control) && readNow(r.el, verb.control, false).withheld !== null);
}

/**
 * The answer an act sends: without its readings when the control's text is withheld now (content/revs.ts), as a walk
 * sends no hasValue or rev for it. The helper then reads a failed write as unverified.
 */
export function receiptFor(a: ActAnswer, withheld: boolean): ActAnswer {
  if (!withheld || a.readings === undefined) return a;
  const { readings: _readings, ...rest } = a;
  return rest;
}

/** pageCompare: whole-value answers for each candidate, from this frame's own reading of the field (content/revs.ts). */
function compare(el: Element, verb: Extract<ActVerb, { kind: "pageCompare" }>): ActAnswer {
  if (!isTextKind(verb.control)) return answer("unsupported", `a ${verb.control} is not a text control`);
  const now = readNow(el, verb.control, false);
  const answers = compareAnswers(now.withheld === null ? textOf(el, verb.control) : null, numericOf(el), verb.candidates, () => compareBudget.take(verb.taskId, verb.id));
  return answer("ok", null, { compare: answers });
}

/** A stage boundary: the task's grant still covers the frame (asked of the worker), then the element is still eligible. */
type Gate = (stage: string) => Promise<ActAnswer | null>;

/** The stop, if any, with the stage it came at in its detail. */
function gateWith(alive: () => Promise<boolean>, check: () => ActAnswer | null): Gate {
  return async (stage) => {
    const stop = (await alive()) ? check() : answer("notAllowed", "the task's grant ended");
    return stop === null ? null : { ...stop, detail: `${stop.detail ?? stop.outcome} (${stage})` };
  };
}

async function actOn(el: Element, verb: Mutating, check: () => ActAnswer | null, alive: () => Promise<boolean>, rebound: boolean): Promise<ActAnswer> {
  // :disabled also covers a control in a disabled <fieldset> and an option in a disabled <optgroup> (W3 second review #4).
  const locked = (): boolean => el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" || (el as HTMLInputElement).readOnly === true;
  const disabled = locked();
  // Every gate also asks again whether the field still takes the value: a focus handler, or page code running while a
  // gate awaits the worker, can disable it, make a select take several choices, or remove or disable the option (W3 review #9).
  const optionOk = (): boolean => verb.kind !== "pageSelect" || !(el instanceof HTMLSelectElement) || [...el.options].some((o) => o.value === verb.value && !o.matches(":disabled"));
  const multiple = (): boolean => el instanceof HTMLSelectElement && el.multiple;
  const checkWrite = (): ActAnswer | null =>
    check() ?? (locked() ? answer("failed", "the field became disabled or read-only") : multiple() ? answer("unsupported", "the select now takes several choices") : !optionOk() ? answer("failed", "the option is gone or disabled") : null);
  const gate = gateWith(alive, checkWrite);
  switch (verb.kind) {
    case "pageWrite": {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return answer("unsupported", "only text inputs and text areas take a pageWrite in v1");
      return writeText(el, verb, disabled, rebound, check, gate);
    }
    case "pageRestore": {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return answer("unsupported", "only text inputs and text areas take a pageRestore", { restore: { outcome: "refused", why: "noRecord" } });
      return restoreText(el, verb, disabled, check, gate);
    }
    case "pageSelect": {
      if (!(el instanceof HTMLSelectElement)) return answer("unsupported", "only a native select takes a pageSelect; a custom listbox is pageChooseOption");
      // One value cannot say which of several selections to keep, and undo could not put them all back (W3 review #7).
      if (multiple()) return answer("unsupported", "a list that holds several choices is yours to set; Caret writes one value");
      const before = el.value;
      if (before === verb.value) return answer("alreadyTrue", null);
      if (before !== verb.expect) return answer("stale", "the select shows another option than when it was walked");
      if (!optionOk()) return answer("failed", "the option is gone or disabled");
      if (disabled) return answer("failed", "the select is disabled");
      const pushed = await pushValue(el, verb.value, check, gate, () => (currentOption(el) !== verb.expect ? answer("stale", "the page changed the field when it took focus") : null), () => {});
      if (!pushed.done) return pushed.answer;
      const final = currentOption(el);
      const readings: WriteReadings = { sameAsBefore: final === before, landed: final === verb.value, equivalent: final === verb.value, empty: final === "", typedBetween: false, rev: null };
      if (readings.landed) return answer("ok", null, { readings });
      return answer("failed", readings.sameAsBefore ? "the page kept the old value" : "the page holds another value than Caret wrote", { readings });
    }
    case "pageSetChecked": {
      const now = checkedOf(el);
      if (now === undefined) return answer("unsupported", "the element is not a checkbox or radio");
      if (now === verb.checked) return answer("alreadyTrue", null);
      if (!verb.checked && verb.control === "radio") {
        // D2-04: a click never clears a radio, so the one way back to no choice is the undo of Caret's own pick, on the
        // very button it checked (sameAs, already required above), and only for a native radio: an ARIA radio's checked
        // state is the page's own script's to change.
        if (verb.sameAs === undefined) return answer("unsupported", "a radio is cleared by choosing another one");
        if (!(el instanceof HTMLInputElement) || el.type !== "radio") return answer("unsupported", "Caret clears only a native radio button it checked itself");
        if (disabled) return answer("failed", "the control is disabled");
        return clearRadio(el, gate);
      }
      if (disabled) return answer("failed", "the control is disabled");
      // D2-04 review: Caret checks a radio only in a choice that is still unanswered, read at each stage; the user's own
      // answer made since the walk is never overwritten.
      const answered = (): boolean => verb.control === "radio" && verb.checked && otherChecked(el);
      if (answered()) return answer("stale", "another answer of this choice is checked now");
      // Focus first, as a real click does, so a page that reacts to focus does so before the grant is asked again.
      (el as HTMLElement).focus();
      const ready = await gate("after focus, before the click");
      if (ready !== null) return ready;
      if (checkedOf(el) === verb.checked) return answer("alreadyTrue", null);
      if (answered()) return answer("stale", "another answer of this choice was checked when it took focus");
      (el as HTMLElement).click();
      await settle();
      const after = checkedOf(el);
      return after === verb.checked ? answer("ok", null) : answer("failed", "the page kept the old state");
    }
  }
}

/**
 * A text write (pageWrite). The field must hold what the walk read: its rev is still the one the verb expects (a
 * rebound replacement was matched on the walk's own text instead, registry.ts), and its text is not withheld while it
 * holds some. Text equivalent to the value already is alreadyTrue. The page keeps the field's text before the write
 * (content/revs.ts WriteRecords) for its undo, before anything is touched, so a write whose answer is lost can still be
 * undone; nothing of it is sent. The readings are booleans the page computed, and the rev the write left.
 */
async function writeText(el: HTMLInputElement | HTMLTextAreaElement, verb: Extract<ActVerb, { kind: "pageWrite" }>, disabled: boolean, rebound: boolean, check: () => ActAnswer | null, gate: Gate): Promise<ActAnswer> {
  const numeric = numericOf(el);
  const now = readNow(el, verb.control, false);
  const before = now.text;
  if (now.withheld !== null && before !== "") return answer("excluded", `the field holds text Caret does not read (${now.withheld})`);
  // The page writes over no text but Caret's own (counsel 2026-10-09): the helper never asks, and the text kept for
  // Undo is then never the user's. Before any comparison with the value: an alreadyTrue on someone else's text would
  // confirm a guess of it (audit of PR #52, LOW 6).
  if (before !== "" && now.origin !== "caret") return answer("stale", "the field holds text Caret did not write, so Caret does not write over it");
  const trusted0 = revs.trustedCount(el);
  const readings = (final: string, rev: number): WriteReadings => ({ sameAsBefore: final === before, landed: final === verb.value, equivalent: equivalentFor({ numeric }, final, verb.value), empty: final === "", typedBetween: revs.trustedCount(el) !== trusted0, rev });
  if (equivalentFor({ numeric }, before, verb.value)) return answer("alreadyTrue", null, { readings: readings(before, now.rev) });
  if (!rebound && now.rev !== verb.expectRev) return answer("stale", "the field changed since it was walked");
  if (disabled) return answer("failed", "the field is disabled or read-only");
  const rec = records.begin(verb.taskId, el, before, verb.value, now.rev, trusted0);
  const keep = (): void => {
    rec.revAfter = revs.caretWrote(el, el.value, revs.trustedCount(el) !== trusted0, equivalentFor({ numeric }, el.value, verb.value));
    rec.trustedAfter = revs.trustedCount(el);
  };
  const pushed = await pushValue(el, verb.value, check, gate, () => (el.value !== before ? answer("stale", "the page changed the field when it took focus") : null), keep);
  if (!pushed.done) {
    if (!pushed.went) records.pop(verb.taskId, el);
    return pushed.answer;
  }
  keep();
  const r = readings(el.value, rec.revAfter);
  if (r.typedBetween) return answer("failed", "your input reached the field while Caret wrote it", { readings: r });
  if (r.landed || r.equivalent) return answer("ok", null, { readings: r });
  return answer("failed", r.sameAsBefore ? "the page kept the old value" : "the page holds another value than Caret wrote", { readings: r });
}

/**
 * pageRestore: the undo of Caret's newest text write to this field in the task, checked and done in the page. The
 * record must be there and be of this element; no trusted event of the user's reached the field since; its rev is the
 * one Caret's write left; and its text is equivalent to what Caret wrote. Rechecked after focus, the one stage page
 * code runs in before the setter. Then the page-held `before` goes back in as a write does, and is read back.
 */
async function restoreText(el: HTMLInputElement | HTMLTextAreaElement, verb: Extract<ActVerb, { kind: "pageRestore" }>, disabled: boolean, check: () => ActAnswer | null, gate: Gate): Promise<ActAnswer> {
  const numeric = numericOf(el);
  const refused = (why: RestoreRefusal): ActAnswer => answer(why === "gone" || why === "noRecord" ? "notSameElement" : "stale", RESTORE_SAYS[why], { restore: { outcome: "refused", why } });
  const state = (): { rev: number; trusted: number; text: string; numeric: boolean } => ({ rev: readNow(el, verb.control, false).rev, trusted: revs.trustedCount(el), text: el.value, numeric });
  const why = (): RestoreRefusal | null => {
    const rec = records.newest(verb.taskId, el);
    if (rec !== undefined && rec.wrote !== verb.wrote) return "noRecord";
    return restoreCheck(rec, el, state(), verb.exact === true);
  };
  const first = why();
  if (first !== null) return refused(first);
  const rec = records.newest(verb.taskId, el) as NonNullable<ReturnType<typeof records.newest>>;
  if (disabled) return answer("failed", "the field is disabled or read-only");
  const trusted0 = revs.trustedCount(el);
  const pushed = await pushValue(el, rec.before, check, gate, () => {
    const w = why();
    return w === null ? null : refused(w);
  }, () => void revs.caretWrote(el, el.value, revs.trustedCount(el) !== trusted0, el.value === rec.before));
  /**
   * Settles the record once the setter ran: the field holds this write's `before`, with no input of the user's, so
   * this undo is done and the write before it, if any, is next from here, whether or not the act ran to its end. A
   * stop after the setter otherwise left this record on top, and blocked every earlier undo (Greptile, PR #52).
   */
  const settled = (): { rev: number; restored: boolean } => {
    const typed = revs.trustedCount(el) !== trusted0;
    const rev = revs.caretWrote(el, el.value, typed, el.value === rec.before);
    const restored = !typed && el.value === rec.before;
    if (restored) {
      records.pop(verb.taskId, el);
      const prior = records.newest(verb.taskId, el);
      if (prior !== undefined) {
        prior.revAfter = rev;
        prior.trustedAfter = revs.trustedCount(el);
      }
    }
    return { rev, restored };
  };
  if (!pushed.done) {
    if (pushed.went) settled();
    return pushed.answer;
  }
  const { rev, restored } = settled();
  if (revs.trustedCount(el) !== trusted0) return answer("failed", "your input reached the field while Caret put it back");
  if (!restored) return answer("failed", "the page holds other text than Caret put back");
  return answer("ok", null, { restore: { outcome: "restored", rev } });
}

/** A restore refusal in words, naming no text of the field. */
const RESTORE_SAYS: Record<RestoreRefusal, string> = {
  changed: "the field holds other text now than Caret wrote",
  mayIncludeInput: "your input reached the field after Caret wrote it",
  gone: "the field Caret wrote is gone",
  reloaded: "the page reloaded since Caret wrote the field",
  noRecord: "this page keeps no record of Caret's write there",
};

/**
 * Whether another button of the radio's own choice is checked: a native radio's same-named buttons in its form (or its
 * root, outside one), or an ARIA radio's siblings in its radiogroup.
 */
function otherChecked(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "radio") {
    if (el.name === "") return false;
    // The whole tree, filtered by form owner: a peer outside the form element can belong to it by its form attribute
    // (D2-04 second review), and one in another form is another choice.
    const root = el.getRootNode() as Document | ShadowRoot;
    const peers = [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)].filter((x) => x !== el && (x as HTMLInputElement).form === el.form);
    return peers.some((x) => (x as HTMLInputElement).checked);
  }
  const group = el.closest('[role="radiogroup"]');
  return group !== null && [...group.querySelectorAll('[role="radio"]')].some((x) => x !== el && x.getAttribute("aria-checked") === "true");
}

/**
 * The undo of a radio pick (D2-04): the checked setter, then input and change, as a framework's listeners expect after
 * a change; read on the next frame. A page whose own state put the button back (a controlled React radio) reads as
 * "the page kept the old state", which the helper reports as not restored.
 */
async function clearRadio(el: HTMLInputElement, gate: Gate): Promise<ActAnswer> {
  const ready = await gate("before the radio was cleared");
  if (ready !== null) return ready;
  if (!el.checked) return answer("alreadyTrue", null);
  (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set as (this: HTMLInputElement, v: boolean) => void).call(el, false);
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  return checkedOf(el) === false ? answer("ok", null) : answer("failed", "the page kept the old state");
}

const currentOption = (el: HTMLSelectElement): string => el.selectedOptions[0]?.value ?? "";

type Pushed = { done: true } | { done: false; went: boolean; answer: ActAnswer };

/**
 * Focus, gate, `ready`, set, input; gate, change, gate, blur; recheck. A gate or recheck that fails after the value
 * went in stops there and reports `failed` without readings: the field may now be one Caret never reads (a handler
 * can turn it into a password field), so nothing of it leaves the frame, and the helper re-reads the page instead
 * of assuming nothing landed (W1 review, round 2, #3). A grant that ended is one such stop (W3). `went` runs right
 * after the setter, so the page's records know the value went in even if a later stage stops.
 */
async function pushValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, check: () => ActAnswer | null, gate: Gate, ready: () => ActAnswer | null, went: () => void): Promise<Pushed> {
  el.focus();
  const afterFocus = await gate("after focus, before the value went in");
  if (afterFocus !== null) return { done: false, went: false, answer: afterFocus };
  const notReady = ready();
  if (notReady !== null) return { done: false, went: false, answer: notReady };
  setterFor(el)(value);
  went();
  el.dispatchEvent(el instanceof HTMLSelectElement ? new Event("input", { bubbles: true, composed: true }) : new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
  await settle();
  const stopped = (why: ActAnswer): Pushed => ({ done: false, went: true, answer: answer("failed", `the write went in, then ${why.detail ?? why.outcome}; Caret stopped there`) });
  const midway = await gate("after input, before change");
  if (midway !== null) return stopped(midway);
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const afterChange = await gate("after change, before blur");
  if (afterChange !== null) return stopped(afterChange);
  el.blur();
  await settle();
  const end = check();
  if (end !== null) return stopped({ ...end, detail: `${end.detail ?? end.outcome} (after blur)` });
  return { done: true };
}

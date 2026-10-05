// The helper's core, independent of sockets: it applies reader messages to the screen model,
// feeds the rolling text window, the transfer detector and the shadow logger, and asks for
// grounded fill proposals. server.ts connects it to the socket; tests drive it directly.
// Everything the helper sends consumers leaves through `publish`, which checks every offer for the
// host against the protocol before it goes and records it for the host's offerAccept.
import { ScreenModel } from "./model.ts";
import { MEMORY_SNIPPETS, SnippetLedger, forgetWindow, forgetWindows, readWindow } from "./privacy.ts";
import { RollingText } from "./rolling-text.ts";
import { TransferDetector, type Transfer } from "./transfers.ts";
import { ShadowLogger } from "./shadow.ts";
import type { Store } from "./store.ts";
import type { AskJev, JevRequest } from "./fill/jev.ts";
import { describeInput, emptyInput, FillError, formAsksFor, formFields, memoryValue, parseMemoryRef, proposeFill, type FillErrorWhy } from "./fill/fill.ts";
import {
  HOST_OFFER_TYPES,
  HelperMessage,
  PROTOCOL_VERSION,
  type ActivityReply,
  type ActivityRequest,
  type FillAll,
  type GoalAccept,
  type HelperError,
  type GoalProgress,
  type GoalRequest,
  type FillProposal,
  type FillResult,
  type FillRequest,
  type FirstLook,
  type FirstLookReply,
  type Focus,
  type MemoryDocument,
  type MemoryDocumentReply,
  type MemoryDocumentRequest,
  type MemoryNotRight,
  type MemoryProvenance,
  type MemoryReply,
  type MemoryRequest,
  type Node,
  type RoutingContext as RoutingContextMessage,
  RouteDecision,
  type OfferAccept,
  type OfferControl,
  type OfferStop,
  type OfferWithdrawn,
  type OfferPopup,
  type PlanProposal,
  type PlanRequest,
  type AskAnswer,
  AskQuestion,
  type HelperToReader,
  type ReaderMessage,
  type ReaderVerb,
  type VerbResult,
  type RunPlan,
  type Settings,
  type SkillAnswer,
  type TaskControl,
  type TaskCause,
  type TaskPhase,
  type TaskState,
} from "./protocol.ts";
import type { Change, WindowState } from "./model.ts";
import { Executor, type Authorization, type ExecutorDeps, type Revocation, type TaskEvent, type TaskResult, type UndoResult } from "./executor/executor.ts";
import { ReaderCalendar, SocketReaderLink, type CalendarPort, type ReaderLink, type UrlOpener } from "./executor/means.ts";
import { RecoveryJournal, type JournalRecord } from "./executor/journal.ts";
import { MemoryError, MemoryStore } from "./patterns/memory.ts";
import { MemoryConflictError, MemoryDocumentError, type DocumentInfo } from "./memory/documents.ts";
import type { DocId } from "./memory/parse.ts";
import { PatternEngine, type HeldPatternOffer } from "./patterns/engine.ts";
import { TaskRegistry, TransitionError } from "./tasks/registry.ts";
import { PendingWatcher } from "./tasks/pending.ts";
import { Audit } from "./audit.ts";
import { HostOfferRegistry, acceptRefusal, type AcceptHandler, type AcceptResult, type HostOffer } from "./offers/registry.ts";
import { buildFillPopup, fieldLabel, fillPlan, fillPopupEligible, recheckFill, writtenFields, type GroundedProposal } from "./offers/fill-popup.ts";
import { aboutValues, type AboutValue } from "./fill/about.ts";
import type { PopupSpecT } from "./popup.ts";
import { describeField } from "./fill/descriptor.ts";
import { OpenAppOffers } from "./offers/open-app.ts";
import { EventCards } from "./offers/event-card.ts";
import { DEFAULT_SETTINGS, LEVELS, OfferGate, type Family, type UserSettings } from "./offers/settings.ts";
import { FirstLookRunner } from "./offers/first-look.ts";
import { expired } from "./offers/lifetimes.ts";
import { offerField } from "./offers/field.ts";
import { planTask, requestedWindow, type PlanDraft, type PlanTaskOptions } from "./planner/planner.ts";
import { PlannerError, validatePlan } from "./planner/validate.ts";
import { planWithCode } from "./planner/codeplan.ts";
import { GoalRuns } from "./goals/runs.ts";
import { planGoal } from "./goals/propose.ts";
import { GoalError, type DonePress } from "./goals/lower.ts";
import type { GoalPlan, LeftItem } from "./goals/plan.ts";
import { macClock } from "./offers/event-time.ts";
import { planAsk } from "./planner/ask.ts";
import { fillSays } from "./planner/says.ts";
import { jevIntentMaker, writerIntentMaker } from "./planner/intent-makers.ts";
import { headsIntentMaker } from "./planner/intent-heads.ts";
import { splitName } from "./fill/derive.ts";
import type { WriterPort } from "./writer/port.ts";
import type { PlanErrorCode } from "./protocol.ts";

/** The planner's failures that mean it could not ground the instruction, after which the code-mode writer is tried. */
const CODE_PLAN_AFTER: ReadonlySet<PlanErrorCode> = new Set(["unsure", "nothingToDo"]);
import { planError, proposed } from "./planner/proposal.ts";
import type { MemoryValue } from "./planner/trace.ts";
import { AskAsks, AskRefused, wireOptions, type AskDraft, type AskGoal, type AskOptions, type AskQuestionDraft } from "./planner/ask.ts";
import type { AskFixed } from "./planner/intent.ts";
import { RoutingCoordinator, type Decision } from "./routing/coordinator.ts";
import { ASK_ROUTES, type RouteCandidate, type TaskEvidence } from "./routing/routes.ts";
import { ConsentLedger, type Consent } from "./routing/consent.ts";
import type { RoutingContext } from "./routing/context.ts";
import { FILLABLE_ROLES, neverTypedNode } from "./fill/fill.ts";
import { fieldKinds, valueKinds, words } from "./fill/kinds.ts";
import { labelledLines } from "./fill/candidates.ts";
import { fieldAsksFor } from "./fill/about.ts";
import type { ValueKind } from "./protocol.ts";
import { OFFER_WHEN, sentences, type EventCandidate, type SentenceSource } from "./offers/event-card.ts";
import { nodeText } from "./model.ts";
import { createHash } from "node:crypto";

/**
 * The router above the producers (routing/coordinator.ts). With it, no producer makes an ambient offer on its own: a
 * focus, a finished sentence, a heard conversation line, a held pattern offer or a resolved watch is a candidate the
 * router decides about once per context.
 */
export interface RoutingOptions {
  /** Whether a connected host consumes write decisions; write is not a legal outcome until one does. */
  hostWrites?: () => boolean;
  /** Replaces setTimeout for the routers' cooldown, for tests and evaluations with a fake clock. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Sees every decision, for evaluations. */
  onDecision?: (d: Decision) => void;
}

export interface HelperOptions {
  store: Store;
  /** Null disables Jev entirely: no fill proposals are made. */
  askJev: AskJev | null;
  /** Force shadow mode regardless of what the reader's hello says. */
  shadow: boolean;
  /**
   * Accept focus events from apps that are not frontmost as fill triggers. Only for fixture
   * evaluations, where the fixture must not take focus away from whoever is using the Mac.
   */
  allowBackgroundFocus: boolean;
  /** Overrides FILL_CUTOFF, for calibration runs that need every agreed choice. */
  fillCutoff?: number;
  /** Sends a command, act grant or revoke to the connected reader; false when none is connected. Without it the executor cannot act. */
  sendToReader?: (m: HelperToReader) => boolean;
  /** Replaces the socket link to the reader, for tests that simulate the reader in process. */
  readerLink?: ReaderLink;
  /**
   * The reader's socket link when `readerLink` wraps it (the page engines' RoutedReaderLink, main.ts): the reader's
   * verbResults are answered here, and a reader counts as connected only from its hello, as without `readerLink`.
   */
  readerAnswers?: SocketReaderLink;
  /**
   * Whether a page engine is connected for this browser process (engines/registry.ts forBrowser). A reader focus in
   * such a browser then asks for no fill: that browser's pages are filled from the page engine (engines/page-focus.ts).
   */
  pageCovers?: (pid: number) => boolean;
  /**
   * Where calendar end states are written: a port, "reader" for the reader's EventKit adapter over the
   * same link the executor acts through (ReaderCalendar), or null for none.
   */
  calendar?: CalendarPort | "reader" | null;
  /** Memory entries, the decision log and reactions. Defaults to a store beside `store`'s database. */
  memory?: MemoryStore;
  /**
   * The markdown memory folder for the default store (M1). Defaults to "Memory" inside the data directory, so a
   * helper on a temporary directory never opens the user's real folder; main.ts passes the app's.
   */
  memoryDir?: string;
  /** Watch the memory folder for edits (main.ts); reads check revisions either way. */
  watchMemory?: boolean;
  /** Where runs are saved before each act, for recovery after a crash (B23). Defaults to one beside `store`'s database. */
  journal?: RecoveryJournal;
  urls?: UrlOpener | null;
  /**
   * Runs the read-only audit beside the helper (src/audit.ts). Only with shadow mode and Jev off,
   * since the audit's numbers are about what the helper would have done, not what it did.
   */
  audit?: boolean;
  /** For the audit: how often to probe the generator on the real windows (Audit.tick); absent for never. */
  auditProbeEveryMs?: number;
  /** The user's settings until the host sends its own; DEFAULT_SETTINGS (the host's defaults) when absent. */
  settings?: UserSettings;
  /** The calendar event cards add to; "Caret" when absent. The calendar port writes only to a calendar it created (B16). */
  eventCalendar?: string;
  /**
   * D2-06: a page window's document generation (its frames' documents and navigations), so a goal plan that a reload
   * overtook stops as a reload. main.ts reads it from the page engines; absent, a reload stops a goal as a changed field.
   */
  pageDocument?: (windowId: string) => string | null;
  /** Fault-injection seam for the planner evaluation; see PlanTaskOptions.beforeCheck. Never set in normal use. */
  plannerHooks?: Pick<PlanTaskOptions, "beforeCheck">;
  /**
   * The code-mode plan writer (writer/, B24). When set, an instruction the deterministic planner cannot ground
   * (unsure or nothing to do) goes to it (planner/codeplan.ts). Absent: those instructions fail as before.
   */
  writer?: WriterPort | null;
  /**
   * How an Ask's instruction becomes an intent (B25, planner/ask.ts): Jev's staged questions, or the writer's
   * strict JSON through this port. Absent or null: Ask runs the planner, then the code-mode writer, as before B25.
   */
  ask?: { maker: "jev" | "heads" } | { maker: "writer"; writer: WriterPort } | null;
  /** Fault-injection seams for the executor evaluation; see ExecutorDeps. */
  executorHooks?: Pick<ExecutorDeps, "beforeStep" | "beforeAct" | "targetCutoff">;
  /** Replaces the level's offers per hour (OfferGate), for fixture evaluations that make dozens of offers in minutes. Never set in normal use. */
  offersPerHour?: number;
  /** Makes the random part of proposal and watch ids, so tests can expect exact messages. */
  newId?: () => string;
  /** The helper's clock for message times, fill proposals and the task feed. Tests pass a fake one. */
  now?: () => number;
  /**
   * The router (routing/coordinator.ts). Absent or null: each producer triggers itself, as before D2-02; unit tests and
   * producer evaluations use that to measure one producer alone. main.ts routes whenever Jev is on.
   */
  routing?: RoutingOptions | null;
  publish: (m: HelperMessage) => void;
  warn?: (line: string) => void;
}

/** The activity state each executor phase puts its task in. */
const PHASE_STATE: Record<TaskPhase, TaskState> = {
  started: "running",
  skipped: "running",
  acting: "running",
  verified: "running",
  paused: "paused",
  handoff: "needsYou",
  stopped: "failed",
  done: "done",
  undone: "undone",
};

/** A host-reported insert and the transfer it explains are this close in time. Assumed: the transfer is judged after SETTLE_MS. */
const CARET_FILL_MATCH_MS = 10_000;
/** Proposals are remembered this long so a late fillResult can still be matched. Assumed. */
const PROPOSAL_KEEP_MS = 10 * 60 * 1000;
/** How long an Ask's question waits for the user's pick (B29). Assumed, not measured: as long as a proposal is kept. */
const ASK_QUESTION_MS = PROPOSAL_KEEP_MS;

/** A value the host reported inserting for Caret, and the transfer it was matched to, if any yet. */
interface CaretFill {
  proposalId: string;
  at: number;
  value: string;
  /** When the host reported the undo. Only edits from before it belong to the fill. */
  undoneAt: number | null;
  /** Every transfer the fill explains: usually one, more when the inserted text holds several values. */
  transfers: Transfer[];
}

const fieldId = (windowId: string, key: string): string => `${windowId}\u0000${key}`;

/** Whether a transfer comes from this fill: the same field (checked by the caller), close in time, overlapping values, and an edit made before any undo. */
function fillMatches(f: CaretFill, t: Transfer): boolean {
  if (f.undoneAt !== null && t.at > f.undoneAt) return false;
  return Math.abs(t.at - f.at) <= CARET_FILL_MATCH_MS && (f.value.includes(t.value) || t.value.includes(f.value));
}

/**
 * Re-asking Jev for the same form inside this window returns nothing new. Assumed. An About entry added
 * since the form was last asked about is something new, so a form with a field it fits is asked again
 * inside the window (B21: A14's walk found a form seen in the 30 s before onboarding's Continue got no offer).
 */
const FILL_REPEAT_MS = 30_000;
const PRUNE_EVERY_MS = 10_000;

export class Helper {
  readonly model = new ScreenModel();
  readonly text = new RollingText();
  readonly transfers: TransferDetector;
  readonly shadowLogger: ShadowLogger;
  readonly recentTransfers: Transfer[] = [];
  mode: "live" | "shadow";
  private readonly opts: HelperOptions;
  private readonly lastFill = new Map<string, number>();
  private readonly inflight = new Set<string>();
  /** When each About entry was added through memoryRequest add, by id: the newer entries a form has not been asked about (B21). */
  private readonly aboutAddedAt = new Map<string, number>();
  /**
   * The memory entries each offer was built from, by offer key (a patternOffer's id): taking it confirms the noticed
   * ones (lead decision 3), and its memoryProvenance names them.
   */
  private readonly offerMemory = new Map<string, string[]>();
  /** Forms whose fill was in flight when an About entry was added; the focused field is asked about again when that fill ends. */
  private readonly refillAfter = new Set<string>();
  /** Recent proposals, by id: the window and each proposed field's value, so fillResult can be checked and matched. */
  private readonly proposals = new Map<string, { at: number; windowId: string; values: Map<string, string>; labels: Map<string, string>; app: string | null; proposal: FillProposal }>();
  /** Every Jev request goes through this, which records it as a use of "Read and prepare" (B17). Null when Jev is off. */
  private readonly ask: AskJev | null;
  /** The configured plan writer, wrapped so each request is recorded (recordRead). */
  private readonly writer: WriterPort | null;
  /** How an Ask makes its intent; the writer's port is wrapped like the plan writer's. Null: the planner as before B25. */
  private readonly askConfig: { maker: "jev" | "heads" } | { maker: "writer"; writer: WriterPort } | null;
  /** What the last "Read and prepare" use's request declared, so the two asks of one question, which declare the same text, count once. */
  private lastRead: { declared: string; at: number } | null = null;
  /** Offers already recorded as a use of "Show in Caret's UI", by key; bounded. */
  private readonly shown = new Set<string>();
  /** Host-reported inserts, by window and field. */
  private readonly caretFills = new Map<string, CaretFill>();
  private lastPrune = 0;
  /** Bumped on each reader hello; a fill whose Jev answer arrives in a later session is dropped. */
  private readerSession = 0;
  readonly executor: Executor;
  readonly memory: MemoryStore;
  /** Runs saved before each act; what a crash left in it is recovered at start (recoverInterrupted). */
  readonly journal: RecoveryJournal;
  readonly patterns: PatternEngine;
  /** Every piece of Caret's work and its state, published as activity messages. */
  readonly tasks: TaskRegistry;
  /** Watches on windows the user left while they showed unfinished work. */
  readonly pending: PendingWatcher;
  private readonly socketLink: SocketReaderLink | null;
  private readonly changeListeners = new Set<(changes: readonly Change[]) => void>();
  /** Accepted goal plans, one segment at a time (D2-06, goals/runs.ts). */
  readonly goals: GoalRuns;
  /** The read-only audit, when the helper runs one. */
  readonly audit: Audit | null;
  /** Field values of a window just before a focus walk replaced them, for the shadow logger. */
  private preFocus: { windowId: string; values: Map<string, string> } | null = null;
  /** Every alternatives, action and popup message published and not yet withdrawn. */
  readonly offers: HostOfferRegistry;
  /**
   * Fill pop-ups on offer, by offerKey, with the form's field keys when each was made. A pop-up has no
   * timer (OFFER_LIFETIMES.fill): focus in another field ends it, and so does any change to the form
   * or a source; see checkFills and onFillFocus.
   */
  private readonly fillPopups = new Map<string, { p: GroundedProposal; form: string }>();
  /**
   * Each fill request in flight, with every focus in an editable field of the app the user is in since
   * it began, so a pop-up whose Jev answer arrives late can see whether one of them left the form.
   */
  private readonly pendingFills = new Set<{ windowId: string; key: string }[]>();
  private readonly now: () => number;
  /** "Open <app>" action lines for watched windows that finished or need the user. */
  readonly openApp: OpenAppOffers;
  /** Event cards for sentences with a time and a person. */
  readonly events: EventCards;
  /** The event cards' work for the latest snapshot, for tests and evaluations to await. */
  eventsSettled: Promise<void> = Promise.resolve();
  /** The user's settings and the hourly offer budget, which every producer asks before it offers. */
  readonly gate: OfferGate;
  /** Answers the host's firstLook. */
  readonly firstLookRunner: FirstLookRunner;
  /** Offers a first look found and recorded, by key, until taken, expired or withdrawn, with the engine offer each reports, if any. */
  private readonly firstLooks = new Map<string, { at: number; family: Family; underlying: string | null }>();
  /**
   * Planned tasks on offer, by offerKey: the draft, when it was proposed, and what each field it writes
   * held then, so a field the user changes before the run's first read stops it.
   */
  private readonly planOffers = new Map<string, { at: number; draft: PlanDraft; instruction: string; expect: Record<string, Record<string, string>> }>();
  private planSeq = 0;
  /**
   * Ask questions waiting for the user's pick (B29), by question id: the connection that may answer, when the question
   * lapses, and what continues the Ask. Each is answered once; a reader restart drops them all, as it drops plan offers.
   */
  private readonly askQuestions = new Map<string, { session: string | undefined; expires: number; draft: AskQuestionDraft }>();
  private askSeq = 0;
  /** A reader is on the socket: set by its hello, cleared when it disconnects. An in-process reader link is always there. */
  private readerConnected: boolean;
  /**
   * Host sessions connected now (S1 audit #5, B23): consumers whose hello says `host: true`, and any in-process
   * session a test or evaluation registers as the host. Only these count as "host connected", and a run with no
   * Tab binds to them alone.
   */
  private readonly hosts = new Set<string>();
  /** Every consumer session connected now, hosts included: the work each accepts is bound to it and revoked when it closes. */
  private readonly sessions = new Set<string>();
  /** Skill runs that ended and whose recovery rows go once the skill has counted them (journal drop above). */
  private readonly dropWhenCounted = new Set<string>();
  /**
   * The host sessions each task is bound to, by task id: the session that accepted, took, ran, resumed or
   * undid it, or for a run a skill started with no Tab, every session connected when it started. If any of
   * them disconnects, the task is revoked. A task with no entry was started in process, outside a session.
   */
  private readonly taskHosts = new Map<string, ReadonlySet<string>>();
  /**
   * What each run from an offer depends on beyond its grant (B22 review): the settings family of the offer it
   * came from, and for a routine's, the routine. Turning that family off, or forgetting or pausing the routine
   * or its skill, revokes it, a run the user accepted with Tab included.
   */
  private readonly taskDeps = new Map<string, { family: Family | null; routineId: string | null }>();
  /** Decides once per moment which producer, if any, makes an offer; null when producers trigger themselves. */
  readonly routing: RoutingCoordinator | null;
  /** The window the user's own focus is in, from snapshots of the frontmost app (or of any app while that is unknown). */
  private userFocus: string | null = null;
  /** What the user consented to, from the helper's own records: what passes the routers with no question (R2). */
  readonly consent: ConsentLedger;
  /** Host sessions whose hello declared ROUTING_CAPABILITY: they take route decisions, so write is legal while one is here. */
  private readonly routingHosts = new Set<string>();

  constructor(opts: HelperOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.offers = new HostOfferRegistry(this.now);
    this.gate = new OfferGate(opts.settings ?? DEFAULT_SETTINGS, { load: () => opts.store.offerTimes(), record: (at) => opts.store.recordOffer(at) }, opts.offersPerHour ?? null);
    this.readerConnected = opts.readerLink !== undefined && opts.readerAnswers === undefined;
    if (opts.audit === true && (!opts.shadow || opts.askJev !== null)) throw new Error("the audit runs only in shadow mode with Jev off");
    const jev = opts.askJev;
    // Recorded once the request has gone and been answered, or as failed: a client that throws before
    // sending (no key) must not leave a use that says text was sent.
    this.ask =
      jev === null
        ? null
        : async (req) => {
            try {
              const r = await jev(req);
              this.recordRead(req, "done");
              return r;
            } catch (e) {
              this.recordRead(req, "failed");
              throw e;
            }
          };
    // The plan writer's requests are recorded as Jev's are, from the declarations the planner attached, whether
    // the plan then succeeds or not (fix-check review).
    const recorded = (writer: WriterPort, who: string): WriterPort => ({
      route: writer.route,
      write: async (req) => {
        try {
          const r = await writer.write(req);
          this.recordRead({ snippets: req.disclosed ?? [] }, "done", who);
          return r;
        } catch (e) {
          this.recordRead({ snippets: req.disclosed ?? [] }, "failed", who);
          throw e;
        }
      },
    });
    const writer = opts.writer ?? null;
    this.writer = writer === null ? null : recorded(writer, "the plan writer");
    const askOpt = opts.ask ?? null;
    this.askConfig = askOpt === null || askOpt.maker !== "writer" ? askOpt : { maker: "writer", writer: recorded(askOpt.writer, "the intent writer") };
    this.mode = opts.shadow ? "shadow" : "live";
    const routed = opts.routing != null && this.ask !== null;
    // A producer's candidate arrived outside the user's own field (a held pattern offer, a resolved watch, a heard line):
    // the router reads the moment again once the producer's own work has returned, never in the middle of it.
    const candidatesChanged = (): void => {
      this.routing?.candidatesChanged();
      queueMicrotask(() => this.routing?.observe());
    };
    const heldForRouter = routed ? { held: candidatesChanged } : undefined;
    this.transfers = new TransferDetector(this.model, this.text);
    this.shadowLogger = new ShadowLogger(this.model, this.text, opts.store);
    this.socketLink = opts.readerLink === undefined ? new SocketReaderLink(opts.sendToReader ?? (() => false)) : null;
    this.tasks = new TaskRegistry((m) => this.publish(m), this.now);
    this.executor = new Executor({
      model: this.model,
      reader: opts.readerLink ?? (this.socketLink as SocketReaderLink),
      calendar: opts.calendar === "reader" ? new ReaderCalendar(opts.readerLink ?? (this.socketLink as SocketReaderLink)) : (opts.calendar ?? null),
      urls: opts.urls ?? null,
      askJev: this.ask,
      publish: (m) => {
        this.publish(m);
        this.goals.onProgress(m);
      },
      onTask: (e) => this.onTaskEvent(e),
      onUse: (u) => this.memory.recordUse(u.action, { at: this.now(), says: u.says, app: u.app, outcome: u.outcome }),
      // Any active About or people entry: a fill copies typed About values (trimmed when kept), a plan copies any.
      // A plan may write a first, middle or last name code split from a remembered name (B24): the entry must
      // still give exactly that part, by the same split, not any substring.
      memoryHolds: (ref, value) => this.memoryHolds(ref, value),
      authorize: (a) => this.authorize(a),
      ...(opts.warn === undefined ? {} : { warn: opts.warn }),
      // The in-progress skill marker rides on each saved run: the skill it counts for, if any.
      journal: {
        save: (r) => this.journal.save({ ...r, skillId: this.patterns.skills.skillOf(r.taskId) }),
        // A skill's run keeps its row until the skill has counted it (Skills.afterRun), which is after the run ends: a
        // crash in between would leave a failed run's skill on its own with nothing saying so (B23 review).
        drop: (id) => {
          if (this.patterns.skills.awaitingCount(id)) this.dropWhenCounted.add(id);
          else this.journal.drop(id);
        },
      },
      onChanges: (l) => {
        this.changeListeners.add(l);
        return () => this.changeListeners.delete(l);
      },
      ...opts.executorHooks,
    });
    this.memory =
      opts.memory ??
      new MemoryStore(opts.store.dir, {
        ...(opts.memoryDir === undefined ? {} : { documents: opts.memoryDir }),
        watch: opts.watchMemory === true,
        warn: (line) => opts.warn?.(line),
      });
    if (this.memory.migration.outcome === "failed") opts.store.count("memory.migration_failed", 1);
    if (this.memory.migration.outcome === "migrated" || this.memory.migration.outcome === "resumed") opts.store.count("memory.migrated", this.memory.migration.moved);
    // An edit in an editor or the memory window withdraws the offers that used it and revokes tasks that copy it.
    this.memory.onOutsideChange = (changes) => this.memoryChangedOutside(changes);
    this.goals = new GoalRuns({
      executor: this.executor,
      model: this.model,
      publish: (m) => {
        if (this.mode === "live") this.opts.publish(m);
      },
      now: () => this.now(),
      readerSession: () => this.readerSession,
      bind: (taskId, session) => this.bindNew(taskId, session),
      memoryHolds: (ref, value) => this.memoryHolds(ref, value),
      ...(opts.pageDocument === undefined ? {} : { pageDocument: opts.pageDocument }),
      replan: (r) => this.replanGoal(r.goalId, r.instruction, r.pressed, r.owed),
    });
    this.journal = opts.journal ?? new RecoveryJournal(opts.store.dir);
    this.memory.routineSightings = this.gate.rules.routineSightings ?? (LEVELS.balanced.routineSightings as number);
    this.patterns = new PatternEngine({
      model: this.model,
      text: this.text,
      memory: this.memory,
      hash: (t) => opts.store.hash(t),
      publish: (m, accept) => {
        if (this.mode !== "live") return;
        this.publish(m, accept);
        this.onPatternMessage(m);
      },
      // Every pattern run starts from an accepted offer (offerControl take or the host's offerAccept), or
      // from a skill the user agreed to let run on its own (B19), which is the approval its grant rests on.
      // A run with no Tab is bound to every host session connected as it starts (S1 audit #5); with none,
      // authorize refuses its first act. The engine does not start one while no host is connected.
      run: (taskId, plan, slots, expect, opts) => {
        if (opts !== undefined) this.taskDeps.set(taskId, { family: opts.family, routineId: opts.routineId });
        if (opts?.unprompted === true) this.taskHosts.set(taskId, new Set(this.hosts));
        return this.executor.run(taskId, plan, slots, expect, { grant: true, unprompted: opts?.unprompted === true });
      },
      hostConnected: () => this.hostPresent,
      // A run of a skill that just went back on Tab, still going with no Tab, is revoked now (B22 review).
      onSkillReset: () => this.executor.recheck(),
      onRunCounted: (id) => {
        if (this.dropWhenCounted.delete(id)) this.journal.drop(id);
      },
      taken: (id) => this.idTaken(id),
      askJev: this.ask,
      shadow: () => this.mode === "shadow",
      gate: this.gate,
      routed: heldForRouter,
      enteredByUser: (id) => {
        if (this.tasks.get(id)?.state === "ready") this.tasks.update(id, { state: "done", cause: "you", detail: "you entered the values yourself" });
      },
      // Read only: without it a routine still learns its finish from the window's buttons, so a failure is a warning.
      watchPresses: (windows) =>
        void this.readerVerb({ kind: "watchPresses", windows }).then(
          (r) => {
            if (r.outcome !== "ok" || r.detail !== null) this.opts.warn?.(`patterns: watchPresses answered ${r.outcome}${r.detail === null ? "" : ` (${r.detail})`}`);
          },
          (e: unknown) => this.opts.warn?.(`patterns: watchPresses failed: ${String(e)}`),
        ),
    });
    this.pending = new PendingWatcher({
      model: this.model,
      askJev: this.ask,
      tasks: this.tasks,
      reader: (v) => this.readerVerb(v),
      live: () => this.mode === "live" && this.gate.enabled("pending"),
      onResolved: (e) => this.openApp.resolved(e),
      ...(opts.newId === undefined ? {} : { newId: opts.newId }),
      ...(opts.warn === undefined ? {} : { warn: opts.warn }),
    });
    // The open-app line runs only from the host's offerAccept.
    this.openApp = new OpenAppOffers({ model: this.model, publish: (m, accept) => this.publish(m, accept), run: (taskId, plan, slots) => this.runFrom("pending", taskId, plan, slots), gate: this.gate, now: this.now, routed: heldForRouter });
    this.events = new EventCards({
      model: this.model,
      askJev: this.ask,
      publish: (m, accept) => this.publish(m, accept),
      // An event card runs only from the host's offerAccept.
      run: (taskId, plan, slots) => this.runFrom("event", taskId, plan, slots),
      gate: this.gate,
      people: () => this.memory.list("people").flatMap((e) => (e.kind === "people" && e.status !== "paused" ? [{ id: e.id, label: e.fields.alias, text: e.fields.name }] : [])),
      calendar: opts.eventCalendar ?? "Caret",
      taken: (id) => this.idTaken(id),
      live: () => this.mode === "live",
      now: this.now,
      count: (name) => opts.store.count(name, 1),
      routed: routed ? { heard: candidatesChanged } : undefined,
      onJudged: (work) => {
        this.eventsSettled = Promise.all([this.eventsSettled, work]).then(() => undefined);
      },
    });
    this.firstLookRunner = new FirstLookRunner({
      model: this.model,
      askJev: this.ask,
      walk: (pid, windowId) => this.readerVerb({ kind: "walk", pid, windowId }),
      readerConnected: () => this.readerConnected,
      live: () => this.mode === "live",
      paused: () => this.gate.settings.paused,
      resolvedWatches: () => this.openApp.resolvedWindows(),
      patterns: this.patterns,
      events: this.events,
      // A first look's offer runs only from the host's offerAccept.
      // The family is recorded when the offer is withdrawn as taken, just before this (withdrawFirstLook).
      run: (taskId, plan, slots, expect) => this.executor.run(taskId, plan, slots, expect, { grant: true }),
      record: (msg, family, accept, underlying) => {
        this.offers.record(msg, accept);
        this.firstLooks.set(msg.offerKey, { at: this.now(), family, underlying });
      },
      withdraw: (offerKey, reason) => this.withdrawFirstLook(offerKey, reason),
      about: () => this.aboutValues(),
      aboutNow: this.aboutNow,
      now: this.now,
    });
    this.audit = opts.audit === true ? new Audit({ model: this.model, reader: (v) => this.readerVerb(v), ...(opts.auditProbeEveryMs === undefined ? {} : { probeEveryMs: opts.auditProbeEveryMs }) }) : null;
    const ro = opts.routing ?? null;
    this.consent = new ConsentLedger({ memory: this.memory, task: (id) => this.tasks.get(id) });
    this.routing =
      ro === null || this.ask === null
        ? null
        : new RoutingCoordinator({
            model: this.model,
            // Through the recording wrapper: a router's request carries screen text, so it is a "Read and prepare" use.
            askJev: this.ask,
            candidates: (ctx) => this.routeCandidates(ctx),
            consented: (ctx) => this.consentedCandidates(ctx),
            // A connected host that takes route decisions, or an evaluation that says it plays one.
            hostWrites: () => [...this.routingHosts].some((h) => this.hosts.has(h)) || (ro.hostWrites?.() ?? false),
            wordsOn: () => this.gate.settings.roles.includes("words"),
            paused: () => this.gate.settings.paused,
            live: () => this.mode === "live",
            readerSession: () => this.readerSession,
            now: this.now,
            ...(ro.setTimer === undefined ? {} : { setTimer: ro.setTimer }),
            count: (m, n) => opts.store.count(m, n ?? 1),
            onDecision: (d) => {
              // A consented offer, or a task offered beside a kept write session, is not the context's decision.
              if (d.published) this.publishRouteDecision({ context: d.gen, windowId: d.windowId, key: d.key, textRevision: d.textRevision, outcome: d.outcome, route: d.outcome === "act" ? d.route : null, ...(d.failure === null ? {} : { failure: d.failure }) });
              ro.onDecision?.(d);
            },
            onWriteEnded: (w) => this.publishRouteDecision({ context: w.gen, windowId: w.windowId, key: w.key, textRevision: w.textRevision, outcome: null, route: null }),
            ...(opts.warn === undefined ? {} : { warn: opts.warn }),
          });
    this.recoverInterrupted();
  }

  /**
   * What a crash left in the journal (B23, S1 audit #11): runs that were under way or paused when the helper
   * stopped. Each skill such a run counted for goes back on Tab, as a run that did not end clean does. Each run is
   * listed as stopped, "at step N of M" naming the first step it had not verified, and the executor takes it back
   * so its undo restores what it wrote, through the elements the reader recorded. Nothing runs again.
   */
  private recoverInterrupted(): void {
    const now = this.now();
    const { records, unreadable, skills, unknownSkill } = this.journal.load(now);
    for (const id of unreadable) this.opts.warn?.(`recovery: the saved run ${id} cannot be read; its undo is lost and it is left in the journal`);
    // Every skill a row names, expired and unreadable rows' too, goes back on Tab first (B23 review). A row that cannot be
    // read and predates the clear skill column could be any skill's, so then every skill that runs on its own goes back.
    const back = new Set(skills);
    if (unknownSkill) for (const e of this.memory.list("skill")) if (e.kind === "skill" && e.fields.onItsOwn) back.add(e.id);
    for (const skillId of back) this.patterns.skills.interrupted(skillId, now);
    // Only now, with every marker acted on, are expired rows deleted.
    this.journal.pruneExpired(now);
    // A recovered run keeps its id, which the reader's calendar knows its events by. Offer and event ids count from 1
    // in every helper process, so the generators skip ids in use (idTaken): the crash test caught a new offer taking it.
    for (const r of records) {
      this.executor.recover(r);
      this.tasks.create(recoveredRecord(r));
      this.opts.store.count("recovery.interrupted_run", 1);
    }
  }

  /**
   * Whether a task may act now (Executor.authorize). Caret paused stops every task, the one the user
   * accepted too: a pause means Caret does nothing. A run a skill started with no Tab also needs its skill
   * still on its own and the permission for where its next act lands, as the user stands now
   * (Skills.whyNotOnItsOwn). A run the user accepted answered "ask" for its writes; it needs only that the
   * permission is not one Caret always hands off.
   */
  private authorize(a: Authorization): Revocation | null {
    // A goal's running segment acts only while the screen it was accepted on still holds (D2-06, goals/runs.ts).
    const moved = this.goals.blocked(a.taskId);
    if (moved !== null) return moved;
    const bound = this.taskHosts.get(a.taskId);
    if (bound !== undefined && [...bound].some((h) => !this.sessions.has(h))) return { why: "the host that started it disconnected", by: "host" };
    if (a.unprompted && (bound === undefined || bound.size === 0)) return { why: "no host was connected to show it", by: "host" };
    if (this.gate.settings.paused) return { why: "you paused Caret", by: "you" };
    const deps = this.taskDeps.get(a.taskId);
    if (deps?.family != null && this.gate.holds(deps.family, this.now()).some((h) => h === "roleOff" || h === "levelOff")) {
      return { why: "your settings no longer let Caret do this kind of work", by: "you" };
    }
    if (deps?.routineId != null) {
      const why = this.patterns.skills.whyTabRunMayNotContinue(a.taskId, deps.routineId);
      if (why !== null) return { why, by: "you" };
    }
    if (a.unprompted) {
      const action = a.action === "writeHere" || a.action === "writeElsewhere" ? a.action : null;
      if (a.action !== null && action === null) return { why: `a skill with no Tab never acts under ${a.action}`, by: "you" };
      const why = this.patterns.skills.whyRunMayNotAct(a.taskId, action);
      return why === null ? null : { why, by: "you" };
    }
    if (a.action !== null && this.memory.permission(a.action) === "handoff") return { why: `your rule for ${a.action} hands it to you`, by: "you" };
    return null;
  }

  private readonly readerListeners = new Set<(m: ReaderMessage) => void>();

  /** Sees every reader message before the helper handles it (the page engines' presence signal, main.ts). Returns the way to stop. */
  onReaderMessage(l: (m: ReaderMessage) => void): () => void {
    this.readerListeners.add(l);
    return () => this.readerListeners.delete(l);
  }

  /** Returns the fill proposal promise when the message triggered one, for tests and evals. */
  handleReader(m: ReaderMessage): Promise<FillProposal | null> | null {
    const store = this.opts.store;
    for (const l of this.readerListeners) l(m);
    switch (m.type) {
      case "hello":
        // A new reader numbers windows from scratch and walks everything again, so the old session's
        // windows, text and open edits are judged now and then forgotten.
        this.record(this.transfers.flush());
        this.shadowLogger.close();
        this.model.reset();
        forgetWindows();
        this.text.clear();
        this.executor.readerRestarted(m.session);
        this.patterns.readerRestarted();
        this.pending.readerRestarted();
        this.openApp.readerRestarted();
        this.events.readerRestarted();
        // Whatever is still offered (a fill pop-up) names windows and fields of the old session, whose
        // ids the new reader may give to other windows.
        for (const id of this.offers.keys()) this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id, reason: "stale" });
        this.fillPopups.clear();
        this.readerSession++;
        this.audit?.readerRestarted(this.now());
        this.firstLooks.clear();
        this.planOffers.clear();
        this.askQuestions.clear();
        this.goals.readerRestarted();
        this.routing?.readerRestarted();
        this.readerConnected = true;
        if (m.mode === "shadow") this.mode = "shadow";
        store.count(`reader.hello_${m.mode}`, 1);
        return null;
      case "snapshot": {
        const prevFocused = this.model.focusedWindowId;
        if (m.reason === "focus") {
          const prior = this.model.windows.get(m.window.windowId);
          this.preFocus = { windowId: m.window.windowId, values: new Map(prior === undefined ? [] : [...prior.nodes].map(([k, n]) => [k, n.value ?? ""])) };
        }
        const changes = this.model.apply(m);
        if (changes.length > 0) for (const l of this.changeListeners) l(changes);
        // A dialog in a running goal segment's app, or a source of its values that changed, stops it (D2-06).
        this.goals.onChanges(changes);
        const w = this.model.windows.get(m.window.windowId);
        if (w !== undefined) {
          this.text.observe(w, m.at);
          readWindow(w);
        }
        store.count(`reader.snapshot_${m.reason}`, 1, m.at);
        store.count("reader.nodes", m.nodes.length, m.at);
        if (m.stats.truncated) store.count("reader.truncated", 1, m.at);
        const cleared = this.transfers.onChanges(changes);
        this.patterns.onChanges(changes);
        if (this.mode === "live") this.eventsSettled = this.events.onChanges(changes);
        // Recorded after the pattern engine has seen the edits, the order tick-judged transfers arrive in.
        this.record(cleared);
        if (this.mode === "shadow") this.shadowLogger.onChanges(changes);
        const moved = prevFocused !== this.model.focusedWindowId;
        // Only when the user is in that app: a request walk marks a background app's own window focused.
        if (moved && this.model.focusedWindowId !== null && this.model.frontmostPid === m.app.pid) this.openApp.onFocusedWindow(this.model.focusedWindowId);
        if (prevFocused !== null && moved) this.record(this.transfers.flush(prevFocused));
        this.pending.onSnapshot(m.window.windowId, m.stats.truncated);
        this.checkFills(m.window.windowId);
        this.audit?.onSnapshot(m);
        // The user left a window: the reader's leave walk of it, or focus arriving in another window.
        if (m.reason === "leave") this.left(m.window.windowId, m.at);
        // The user's own focus moved: a background app's request walk reports its own window focused, so a snapshot
        // of an app known not to be frontmost moves nothing (a watch it started would be consent: routing/consent.ts).
        const background = this.model.frontmostPid !== null && this.model.frontmostPid !== m.app.pid;
        if (m.focused && !background && this.userFocus !== m.window.windowId) {
          const was = this.userFocus;
          this.userFocus = m.window.windowId;
          if (was !== null) this.left(was, m.at);
        }
        // Where the user is decides a write's permission: a run with no Tab whose next write is no longer where they are is revoked now (B22 review).
        if (moved) this.executor.recheck();
        // Another window changed while the user is in an empty field: a source may have arrived, so fill may be listed now.
        if (this.routing !== null && this.routing.context?.field?.empty === true && m.window.windowId !== this.routing.context.windowId) this.routing.candidatesChanged();
        this.routing?.observe();
        return null;
      }
      case "focus": {
        if (this.mode === "shadow") {
          const before = this.preFocus?.windowId === m.windowId && m.key !== null ? this.preFocus.values.get(m.key) : undefined;
          this.shadowLogger.onFocus(m, before);
        }
        this.preFocus = null;
        if (m.frontmost) this.model.frontmostPid = m.app.pid;
        if (m.frontmost) this.executor.recheck();
        this.audit?.onFocus(m);
        store.count(m.editable ? "reader.focus_editable" : "reader.focus_other", 1, m.at);
        if (this.mode === "live") {
          this.openApp.onFocus(m);
          this.onFillFocus(m);
        }
        if (this.routing !== null) {
          // Routed, a focus is a breakpoint: the router lists fill among the candidates and decides (routeCandidates).
          if (m.frontmost || this.opts.allowBackgroundFocus) this.routing.onFocus({ windowId: m.windowId, key: m.key, role: m.role, editable: m.editable });
          this.routing.observe();
          return null;
        }
        // A browser with a page engine is filled from the engine's own page window, not from Accessibility's view of it.
        const pageCovered = !m.windowId.startsWith("page:") && this.opts.pageCovers?.(m.app.pid) === true;
        const triggers = this.mode === "live" && m.editable && m.empty && m.key !== null && (m.frontmost || this.opts.allowBackgroundFocus) && !pageCovered;
        if (!triggers || m.key === null) return null;
        return this.fill(m.windowId, m.key, false);
      }
      case "appSwitch":
        this.model.frontmostPid = m.to.pid;
        if (this.mode === "shadow") this.shadowLogger.onAppSwitch(m);
        // The app being left may send no leave walk when its window did not change; its focused window was left all the same.
        if (m.from !== null) for (const w of this.model.windows.values()) if (w.app.pid === m.from.pid && w.focused) this.left(w.window.windowId, m.at);
        this.executor.recheck();
        store.count("reader.app_switch", 1, m.at);
        this.routing?.observe();
        return null;
      case "windowClosed": {
        this.record(this.transfers.flush(m.windowId));
        // The shadow logger judges an open episode in this window before the window leaves the model,
        // since the judgment reads the window's typed values.
        if (this.mode === "shadow") this.shadowLogger.onWindowClosing(m.windowId);
        this.patterns.onWindowClosed(m.windowId, m.at);
        this.pending.onWindowClosed(m.windowId);
        this.openApp.onWindowClosed(m.windowId);
        this.audit?.onWindowClosed(m.windowId, m.at);
        this.model.close(m.windowId, m.at);
        forgetWindow(m.windowId);
        // A goal segment that copies from this window, or acts in it, stops now (D2-06).
        this.goals.onChanges([]);
        this.checkFills(m.windowId);
        this.routing?.candidatesChanged();
        this.routing?.observe();
        return null;
      }
      case "pasteboard":
        store.count("reader.pasteboard_change", 1, m.at);
        return null;
      case "verbResult":
        (this.socketLink ?? this.opts.readerAnswers)?.answer(m);
        return null;
      case "userInput":
        this.executor.onUserInput(m);
        return null;
      case "userPress":
        this.patterns.onUserPress(m);
        return null;
    }
  }

  /** The user left a window: the pending watch, and the audit when one runs, look for markers. */
  private left(windowId: string, at: number): void {
    this.pending.left(windowId);
    this.audit?.left(windowId, at);
  }

  handleConsumer(m: FillRequest): Promise<FillProposal | null> {
    return this.fill(m.windowId, m.fieldKey, true);
  }

  /**
   * Sends one verb to the reader and resolves with its answer. For evaluation scripts that play the
   * user through the reader's pid-checked AX writes; the executor uses the same link.
   */
  readerVerb(verb: ReaderVerb): Promise<VerbResult> {
    return (this.opts.readerLink ?? (this.socketLink as SocketReaderLink)).run(verb);
  }

  /**
   * The host's settings message. It applies to the next decision of every producer; offers of families it
   * no longer allows are withdrawn as `settings` now, and turning the watch role off ends every watch. `from`: the
   * session that sent it. Only a host session's records the watch role as the user's consent (routing/consent.ts).
   */
  handleSettings(m: Settings, from?: string): void {
    this.consent.settings(m.roles, from !== undefined && this.hosts.has(from));
    const off = this.gate.apply(m);
    this.memory.routineSightings = this.gate.rules.routineSightings ?? (LEVELS.balanced.routineSightings as number);
    this.opts.store.count("settings.applied", 1);
    this.withdrawFamilies(off);
    // A pause holds every offer, a planned task's included.
    if (m.paused) for (const k of [...this.planOffers.keys()]) this.withdrawPlan(k, "settings");
    if (!m.roles.includes("watch")) this.pending.stopAll("you turned off watching");
    // Watches ask nothing while Caret is paused; once it is not, a window that changed meanwhile is asked about.
    else if (this.gate.enabled("pending")) this.pending.resumeAsks();
    // A pause, or routines turned off, ends the work that depended on them now, not at its next act (S1 audit #4).
    this.executor.recheck();
    this.routing?.settingsChanged();
    this.routing?.observe();
  }

  /** Whether a task id is in use by a run or an activity record: new offer ids skip these (B23). */
  private idTaken(id: string): boolean {
    return this.executor.has(id) || this.tasks.get(id) !== undefined;
  }

  /** Whether a host session is connected (a consumer whose hello says `host: true`, or an in-process host). */
  get hostPresent(): boolean {
    return this.hosts.size > 0;
  }

  /** Whether a reader is connected, as the first look sees it. */
  get hasReader(): boolean {
    return this.readerConnected;
  }

  /** The reader's connection closed. A first look then answers that no reader is connected. */
  readerClosed(): void {
    this.readerConnected = false;
  }

  /**
   * A host session connected: a consumer on the socket (HelperServer), or an in-process caller that plays
   * the host, such as an evaluation that answers offers itself. Runs with no Tab start only while one is.
   */
  hostConnected(session: string, routing = false): void {
    this.sessions.add(session);
    this.hosts.add(session);
    if (routing) {
      this.routingHosts.add(session);
      // Write is legal from now: the moment is decided again with it.
      this.routing?.settingsChanged();
      this.routing?.observe();
    }
  }

  /**
   * The host's routingContext: the selection, input method and text revision of the field the user is in, and a
   * sentence or paragraph end it saw. Only the field it names is affected (routing/context.ts).
   */
  handleRoutingContext(m: RoutingContextMessage): void {
    if (this.routing === null) return;
    this.routing.hostEditing({ windowId: m.windowId, key: m.key, selection: m.selection, composing: m.composing, textRevision: m.textRevision }, m.breakpoint !== null);
    this.routing.observe();
  }

  /** Sends a routeDecision; the server gives it only to hosts that declared ROUTING_CAPABILITY. */
  private publishRouteDecision(d: Pick<RouteDecision, "context" | "windowId" | "key" | "textRevision" | "outcome" | "route" | "failure">): void {
    const at = this.now();
    const msg = RouteDecision.safeParse({ type: "routeDecision", v: PROTOCOL_VERSION, at, ...d, expires: at + ROUTE_DECISION_HOLDS_MS });
    if (!msg.success) return this.opts.warn?.(`routing: a routeDecision failed the protocol check: ${msg.error.issues[0]?.message ?? "invalid"}`);
    this.opts.publish(msg.data);
  }

  /**
   * A consumer that is not the host connected (its hello has no `host: true`), such as an evaluation script or the
   * page engine. The work it accepts is bound to it, but it never counts as the host, so it keeps no run with no
   * Tab alive (B23).
   */
  consumerConnected(session: string): void {
    this.sessions.add(session);
  }

  /**
   * A host session closed (S1 audit #5): every task bound to it is revoked now, its grant first, so an act
   * already queued in the reader is refused; a run stops at its next step boundary, a paused one at once.
   */
  hostDisconnected(session: string): void {
    this.hosts.delete(session);
    if (this.routingHosts.delete(session)) {
      // What that host said about the field (selection, composing) no longer holds, and write is not legal without it.
      this.routing?.hostEditing(null);
      this.routing?.settingsChanged();
      this.routing?.observe();
    }
    if (!this.sessions.delete(session)) return;
    this.goals.hostGone(session);
    // The binding stays, naming a session that is gone, so authorize also refuses a task whose run has not begun.
    for (const [taskId, bound] of [...this.taskHosts]) {
      if (bound.has(session)) this.executor.revoke(taskId, { why: "the host that started it disconnected", by: "host" });
    }
  }

  /** Runs an accepted offer of this settings family under a grant, recording the family it depends on. */
  private runFrom(family: Family | null, taskId: string, plan: unknown, slots: Record<string, string>, expect?: Record<string, Record<string, string>>): Promise<TaskResult> {
    if (family !== null) this.taskDeps.set(taskId, { family, routineId: null });
    return this.executor.run(taskId, plan, slots, expect, { grant: true });
  }

  /**
   * Binds a task that does not exist yet to the session about to start it (accept, take, runPlan). One that
   * exists keeps its binding: a second take or accept from another session is refused, and must not take the
   * task away from the host that started it (B22 review). In process (no session), nothing.
   */
  private bindNew(taskId: string, session: string | undefined): void {
    if (session !== undefined && !this.executor.has(taskId)) this.taskHosts.set(taskId, new Set([session]));
  }

  /** Binds an existing task to the session that resumes or undoes it, once the executor would accept the request. */
  private rebind(taskId: string, session: string | undefined, refusal: string | null): void {
    if (session !== undefined && refusal === null) this.taskHosts.set(taskId, new Set([session]));
  }

  /** The host's first look: the best offer across the windows open now, answered to the asker only. */
  async handleFirstLook(m: FirstLook): Promise<FirstLookReply> {
    this.opts.store.count("firstLook.request", 1);
    const r = await this.firstLookRunner.run(m);
    this.opts.store.count(`firstLook.${r.outcome}`, 1);
    // Shown from this reply, not published, so recorded here as a use of "Show in Caret's UI".
    if (r.found !== null) this.recordShownOffer(r.found.offerKey, r.found.window.windowId, specSays(r.found.spec));
    return r;
  }

  /** Whether memory entry `ref` (an id, or "id#first" for a name's part) still gives exactly `value`. */
  private memoryHolds(ref: string, value: string): boolean {
    const { id, part } = parseMemoryRef(ref);
    const text = this.memory.text(id);
    if (text === null || text === undefined) return false;
    // A whole value stays exact; a part is the same part by the same split (fix-check review: a name that
    // changed from "Riley Ade Okafor" to "Morgan Riley" must not still give "Riley" as a first name).
    return memoryValue(text, part) === value;
  }

  /** Memory the planner may copy from: About values and people's names, not paused. */
  private plannerMemory(): MemoryValue[] {
    const out: MemoryValue[] = [];
    for (const e of [...this.memory.list("about"), ...this.memory.list("people")]) {
      if (e.status === "paused") continue;
      if (e.kind === "about") out.push({ id: e.id, label: e.fields.label, text: e.fields.value, whose: "user" });
      else if (e.kind === "people") out.push({ id: e.id, label: e.fields.alias, text: e.fields.name, whose: "other" });
    }
    return out;
  }

  /**
   * A goal plan (D2-06): the writer's program over the windows the goal may act in and the calendar, lowered to
   * segments. The reply, to the asker only, previews the first segment, which runs only after goalAccept; or says
   * why no plan is offered.
   */
  async handleGoalRequest(m: GoalRequest, session?: string): Promise<GoalProgress> {
    this.opts.store.count("goal.request", 1);
    return this.offerGoal(m.requestId, m.instruction, session, null);
  }

  /**
   * Plans `instruction` as a goal and offers its first segment to `session`, as the reply to `requestId`: a goalRequest's,
   * or an Ask's whose intent route is plan (B30), which names the window the Ask was about so the goal reads it first.
   */
  private async offerGoal(requestId: string, instruction: string, session: string | undefined, first: string | null): Promise<GoalProgress> {
    let goalId = `goal-${++this.planSeq}-${requestId}`.slice(0, 200);
    while (this.idTaken(`${goalId}:s0`)) goalId = `goal-${++this.planSeq}-${requestId}`.slice(0, 200);
    const refuse = (says: string): GoalProgress => this.goals.refused(goalId, requestId, says);
    if (this.writer === null) return refuse("No plan writer is configured, so Caret cannot plan this");
    if (this.mode !== "live") return refuse("Caret is in shadow mode");
    if (this.gate.settings.paused) return refuse("Caret is paused");
    if (!this.readerConnected) return refuse("No screen reader is connected");
    const session0 = this.readerSession;
    try {
      const plan = await this.goalPlan(goalId, instruction, [], first);
      if (session0 !== this.readerSession) return refuse("The screen reader restarted while Caret planned, so the plan's windows no longer apply");
      this.opts.store.count("goal.proposed", 1);
      return this.goals.propose(plan, session, requestId);
    } catch (e) {
      if (!(e instanceof GoalError)) throw e;
      this.opts.store.count(`goal.refused_${e.code}`, 1);
      this.opts.warn?.(`goal ${goalId}: ${e.message}`);
      return refuse(e.says.charAt(0).toUpperCase() + e.says.slice(1));
    }
  }

  /**
   * The host's acceptance of one goal segment. A refusal goes back as an error naming why, to `reply` (the asker's own
   * connection) when given, else published as in-process callers read it; nothing runs.
   */
  async handleGoalAccept(m: GoalAccept, session?: string, reply?: (e: HelperError) => void): Promise<TaskResult | null> {
    const r = await this.goals.accept(m, session);
    if ("refused" in r) {
      this.opts.store.count("goal.acceptRefused", 1);
      const e: HelperError = { type: "error", v: PROTOCOL_VERSION, at: this.now(), message: `goalAccept refused: ${r.refused}` };
      if (reply === undefined) this.opts.publish(e);
      else reply(e);
      return null;
    }
    return r.result;
  }

  /** Whether calendar end states have somewhere to go (HelperOptions.calendar). */
  private get executorHasCalendar(): boolean {
    return this.opts.calendar !== undefined && this.opts.calendar !== null;
  }

  /**
   * The windows a goal may act in: `first` (the window an Ask was about) or else the user's own, then the most recently
   * used ones with a field or a button.
   */
  private goalWindows(first: string | null = null): string[] {
    const usable = (w: { nodes: Map<string, { editable?: boolean; role: string }> }): boolean => [...w.nodes.values()].some((n) => n.editable === true || n.role === "AXButton");
    const lead = (first === null ? undefined : this.model.windows.get(first)) ?? this.model.userWindow();
    // A window with no field or button (the email the user is reading) is a source, not where the goal acts: listed
    // first, its own values would be left out of the inventory (planner/codeplan.ts valueList reads other windows').
    // B30's cases asked from the email, and no plan could copy its sender into the reply's To.
    const user = lead !== null && lead !== undefined && usable(lead) ? lead : null;
    const rest = [...this.model.windows.values()].filter((w) => w !== user && usable(w)).sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
    return [...(user === null ? [] : [user]), ...rest].map((w) => w.window.windowId);
  }

  private goalPlan(goalId: string, instruction: string, done: readonly DonePress[] = [], first: string | null = null, carried: readonly LeftItem[] = []): ReturnType<typeof planGoal> {
    const writer = this.writer;
    if (writer === null) throw new GoalError("nothingToDo", "no plan writer is configured");
    const calendar = this.executorHasCalendar ? (this.opts.eventCalendar ?? "Caret") : null;
    return planGoal(this.model, {
      goalId,
      instruction,
      writer,
      askJev: this.ask,
      windows: this.goalWindows(first),
      memory: this.plannerMemory(),
      calendar,
      clock: macClock(new Date(this.now())),
      now: this.now(),
      readerSession: this.readerSession,
      ...(this.opts.pageDocument === undefined ? {} : { pageDocument: this.opts.pageDocument }),
      done,
      carried,
    });
  }

  /** A fresh plan for a stopped goal's instruction, from the screen as it is now; null when none can be offered. */
  private async replanGoal(goalId: string, instruction: string, done: readonly DonePress[], carried: readonly LeftItem[]): Promise<GoalPlan | null> {
    if (this.writer === null || this.mode !== "live" || this.gate.settings.paused) return null;
    try {
      return await this.goalPlan(goalId, instruction, done, null, carried);
    } catch (e) {
      if (!(e instanceof GoalError)) throw e;
      this.opts.warn?.(`goal ${goalId}: no fresh plan: ${e.message}`);
      return null;
    }
  }

  /**
   * The user asked Caret to do something. The planner drafts a plan against the screen model and memory
   * and checks it (planner/); a plan that passes is recorded as an offer under its key and runs only when
   * the host accepts it. The reply goes to the asker only.
   */
  async handlePlanRequest(m: PlanRequest): Promise<PlanProposal>;
  async handlePlanRequest(m: PlanRequest, from: string | undefined, canAsk: boolean): Promise<PlanProposal | AskQuestion>;
  async handlePlanRequest(m: PlanRequest, from: string | undefined, canAsk: boolean, canGoal: boolean): Promise<PlanProposal | AskQuestion | GoalProgress>;
  async handlePlanRequest(m: PlanRequest, from?: string, canAsk = false, canGoal = false): Promise<PlanProposal | AskQuestion | GoalProgress> {
    this.opts.store.count("plan.request", 1);
    let windowId: string | null = null;
    try {
      windowId = requestedWindow(this.model, m);
    } catch (e) {
      if (!(e instanceof PlannerError)) throw e;
      return this.planFailed(m.requestId, e.code, e.message);
    }
    return this.planAndPropose(m.requestId, m.instruction, windowId, undefined, from, canAsk, canGoal);
  }

  /**
   * The user's pick in answer to an Ask's question (B29): the question must be one this connection was asked and not
   * yet answered or lapsed, and every pick one of its options (one for a single-choice question). The picks fix that
   * part, and the same Ask goes on from there: its reply is a proposal, a refusal, or the next question.
   */
  async handleAskAnswer(m: AskAnswer, from?: string, canGoal = false): Promise<PlanProposal | AskQuestion | GoalProgress> {
    this.opts.store.count("plan.askAnswer", 1);
    const q = this.askQuestions.get(m.questionId);
    if (q === undefined || q.session !== from || q.expires <= this.now()) return this.planFailed(m.requestId, "questionGone", `no open question ${m.questionId} for this connection`);
    this.askQuestions.delete(m.questionId);
    const ids = new Set(m.picks);
    const picked = q.draft.options.filter((c) => ids.has(c.option.id));
    if (picked.length !== m.picks.length || ids.size !== m.picks.length || (q.draft.pick === "one" && picked.length !== 1)) {
      return this.planFailed(m.requestId, "schema", `the answer picks ${m.picks.join(", ")}, which question ${m.questionId} did not list as ${q.draft.pick === "one" ? "one choice" : "choices"}`);
    }
    // Each pick fixes only the part it names: the fields picked, else the one window or person.
    const fixed: AskFixed = { ...q.draft.resume.fixed };
    for (const c of picked) {
      if (c.fixes.fields !== undefined) fixed.fields = [...(fixed.fields ?? []), ...c.fixes.fields];
      if (c.fixes.source !== undefined) fixed.source = c.fixes.source;
      if (c.fixes.person !== undefined) fixed.person = c.fixes.person;
    }
    const resume = { ...q.draft.resume, fixed };
    return this.planAndPropose(m.requestId, resume.instruction, resume.windowId, resume, from, true, canGoal);
  }

  private planFailed(requestId: string, code: Parameters<typeof planError>[1], detail: string): PlanProposal {
    this.opts.store.count(`plan.error_${code}`, 1);
    return planError(requestId, code, detail, this.now());
  }

  /**
   * Plans an Ask or a planner task and offers it; an Ask that asks a question returns it to a consumer that can answer,
   * and an Ask whose route is plan, asked by a host that runs goal plans (`canGoal`), is offered as a goal (B30).
   */
  private async planAndPropose(requestId: string, instruction: string, windowId: string | null, resume: AskOptions["resume"], from: string | undefined, canAsk: boolean, canGoal = false): Promise<PlanProposal | AskQuestion | GoalProgress> {
    const store = this.opts.store;
    const fail = (code: Parameters<typeof planError>[1], detail: string): PlanProposal => this.planFailed(requestId, code, detail);
    const ask = this.ask;
    if (ask === null) return fail("unavailable", "Jev is off");
    if (this.mode !== "live") return fail("unavailable", "the helper is in shadow mode");
    if (this.gate.settings.paused) return fail("unavailable", "Caret is paused");
    if (!this.readerConnected) return fail("unavailable", "no reader is connected");
    let offerKey = `plan-${++this.planSeq}-${requestId}`;
    while (this.idTaken(offerKey)) offerKey = `plan-${++this.planSeq}-${requestId}`;
    const session = this.readerSession;
    let draft: PlanDraft;
    const askConfig = this.askConfig;
    if (askConfig !== null) {
      // B25: an intent, checked by code, then the scoped fill or the planner (planner/ask.ts).
      try {
        const maker = askConfig.maker === "writer" ? writerIntentMaker(askConfig.writer, () => offerKey) : askConfig.maker === "heads" ? headsIntentMaker(ask) : jevIntentMaker(ask);
        const d: AskDraft | AskGoal = await planAsk(instruction, this.model, { values: () => this.plannerMemory() }, this.aboutValues(), { askJev: ask, maker, writer: this.writer, offerKey, now: this.now(), goals: canGoal, ...(windowId === null ? {} : { windowId }), ...(resume === undefined ? {} : { resume }), ...this.opts.plannerHooks });
        store.count(`plan.ask_${d.route}`, 1);
        this.countAskRoute(d.route === "goal" ? "plan" : d.route);
        if (d.route === "goal") {
          if (session !== this.readerSession) return fail("unknownWindow", "the reader restarted while Caret planned, so the plan's window ids no longer apply");
          return await this.offerGoal(requestId, instruction, from, d.windowId);
        }
        draft = d;
      } catch (e) {
        if (!(e instanceof PlannerError)) throw e;
        if (e instanceof AskRefused && e.intent !== null) this.countAskRoute(e.intent.route);
        // B29: a question with choices, to a consumer that said it can answer one; anyone else reads the refusal.
        if (e instanceof AskAsks && canAsk && session === this.readerSession) return this.askQuestion(requestId, e.question, from);
        return fail(e.code, e.message);
      }
    } else if (resume !== undefined) {
      return fail("questionGone", "Ask is not configured, so no question can be continued");
    } else try {
      draft = await planTask(instruction, this.model, { values: () => this.plannerMemory() }, {
        askJev: ask,
        offerKey,
        now: this.now(),
        ...(windowId === null ? {} : { windowId }),
        ...this.opts.plannerHooks,
      });
    } catch (e) {
      if (!(e instanceof PlannerError)) throw e;
      // An instruction the planner could not ground goes to the code-mode writer, when one is configured (B24).
      // The plan it builds is checked by the same validatePlan and offered the same way; on failure the
      // planner's own error stands, with the writer's reason added.
      const writer = this.writer;
      const codeWindow = CODE_PLAN_AFTER.has(e.code) && writer !== null ? (e.windowId ?? windowId) : null;
      if (writer === null || codeWindow === null) return fail(e.code, e.message);
      store.count("plan.codeMode", 1);
      try {
        draft = await planWithCode(instruction, this.model, { values: () => this.plannerMemory() }, { writer, askJev: ask, offerKey, windowId: codeWindow, now: this.now() });
        store.count("plan.codeModeProposed", 1);
      } catch (e2) {
        if (!(e2 instanceof PlannerError)) throw e2;
        store.count(`plan.codeMode_${e2.code}`, 1);
        return fail(e.code, `${e.message}; the plan writer did not help either: ${e2.message}`);
      }
    }
    // Window ids start over with a new reader; a plan drafted in the old session names other windows now.
    if (session !== this.readerSession) return fail("unknownWindow", "the reader restarted while Caret planned, so the plan's window ids no longer apply");
    if (this.mode !== "live" || this.gate.settings.paused) return fail("unavailable", this.mode !== "live" ? "the helper is in shadow mode" : "Caret is paused");
    const reply = proposed(requestId, draft, this.now());
    const w = draft.checked.window;
    const anchor = draft.checked.writes[0]?.node.key ?? draft.checked.handoff?.node.key ?? w.window.windowId;
    const spec = reply.spec;
    if (spec === null) return fail("schema", "the proposal has no pop-up");
    // Recorded, not published: the host shows the proposal from this reply, and its offerAccept reaches acceptPlan.
    const msg: OfferPopup = { type: "popup", v: PROTOCOL_VERSION, offerKey, at: reply.at, field: offerField(w, anchor), spec };
    const checked = HelperMessage.safeParse(msg);
    if (!checked.success) return fail("schema", `the proposal's pop-up failed the protocol check: ${checked.error.issues[0]?.message ?? "invalid"}`);
    this.offers.record(msg, () => this.acceptPlan(offerKey));
    this.rememberOfferMemory(offerKey, msg);
    this.recordShownOffer(offerKey, w.window.windowId, specSays(spec));
    const expect = { [w.window.windowId]: Object.fromEntries(draft.checked.writes.map((wr) => [wr.node.key, wr.node.value ?? ""])) };
    this.planOffers.set(offerKey, { at: this.now(), draft, instruction, expect });
    store.count("plan.proposed", 1);
    if (draft.checked.handoff !== null) store.count(`plan.handoff_${draft.checked.handoff.why}`, 1);
    return reply;
  }

  /** Keeps a question for its answer and builds its message; the options carry ids only, never keys or window ids. */
  private askQuestion(requestId: string, q: AskQuestionDraft, from: string | undefined): AskQuestion | PlanProposal {
    const at = this.now();
    const questionId = `ask-${++this.askSeq}-${requestId}`.slice(0, 240);
    const msg = AskQuestion.safeParse({ type: "askQuestion", v: PROTOCOL_VERSION, requestId, at, questionId, part: q.part, text: q.text, pick: q.pick, options: wireOptions(q), window: q.window, expires: at + ASK_QUESTION_MS });
    if (!msg.success) return this.planFailed(requestId, "schema", `the question failed the protocol check: ${msg.error.issues[0]?.message ?? "invalid"}`);
    this.askQuestions.set(questionId, { session: from, expires: msg.data.expires, draft: q });
    this.opts.store.count(`plan.asked_${q.part}`, 1);
    return msg.data;
  }

  /**
   * The user's Ask skips Router 1 (they asked, so it is act), and B25's intent maker is its Router 2: its route is
   * logged in Router 2's words (routing/routes.ts ASK_ROUTES), so Ask and ambient decisions share one vocabulary.
   */
  private countAskRoute(route: keyof typeof ASK_ROUTES): void {
    const r = ASK_ROUTES[route];
    this.opts.store.count(`route.ask_${r.outcome === "ask" ? "ask" : r.kind}`, 1);
  }

  /**
   * Runs an accepted plan as the task with the offer's key, under an act grant for its one window. The
   * plan is checked again against the screen and memory as they are now; a check that fails refuses the
   * accept with its code, and nothing is written.
   */
  private async acceptPlan(offerKey: string): Promise<AcceptResult> {
    const p = this.planOffers.get(offerKey);
    if (p === undefined) return { refused: "the plan was withdrawn" };
    this.withdrawPlan(offerKey, "taken");
    try {
      const now = validatePlan(p.draft.plan, p.draft.slots, { model: this.model, memory: this.plannerMemory(), instruction: p.instruction });
      // The plan names its window by app and title; a window that replaced the proposed one under the same
      // title is another window, and the destinations' expected values were read from the first.
      const proposed = p.draft.checked.window.window.windowId;
      if (now.window.window.windowId !== proposed) return { refused: `unknownWindow: the window the plan was made for (${proposed}) closed; nothing was written` };
    } catch (e) {
      if (e instanceof PlannerError) return { refused: `${e.code}: ${e.message}; nothing was written` };
      throw e;
    }
    return this.executor.run(offerKey, p.draft.plan, p.draft.slots, p.expect, { grant: true });
  }

  private withdrawPlan(offerKey: string, reason: "taken" | "expired" | "settings" | "stale"): void {
    if (!this.planOffers.delete(offerKey)) return;
    this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id: offerKey, reason });
  }

  /** Ends an offer a first look recorded: its key leaves the registry and consumers get offerWithdrawn. */
  private withdrawFirstLook(offerKey: string, reason: Exclude<OfferWithdrawn["reason"], "reoffered">): void {
    const f = this.firstLooks.get(offerKey);
    if (f === undefined) return;
    this.firstLooks.delete(offerKey);
    // Taken: the run that follows depends on this offer's family (B22 review).
    if (reason === "taken") this.taskDeps.set(offerKey, { family: f.family, routineId: null });
    this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id: offerKey, reason });
  }

  /** Withdraws every offer shown of these families, as `settings`. */
  private withdrawFamilies(families: readonly Family[]): void {
    if (families.length === 0) return;
    for (const [k, f] of [...this.firstLooks]) if (families.includes(f.family)) this.withdrawFirstLook(k, "settings");
    if (families.includes("fill")) for (const id of [...this.fillPopups.keys()]) this.withdrawFill(id, "settings");
    if (families.includes("pending")) this.openApp.withdrawAll();
    if (families.includes("event")) this.events.withdrawAll("settings");
    this.patterns.withdrawFamilies(families);
  }

  /** The user's answer to a keep or promote question (B19). A refused answer is published as an error. */
  handleSkillAnswer(m: SkillAnswer): void {
    if (this.mode !== "live") return this.error(`skill offer ${m.id}: the helper is in shadow mode`);
    const refused = this.patterns.skills.answer(m);
    if (refused !== null) this.error(refused);
  }

  /**
   * Takes, dismisses or silences a pattern offer. Resolves when a taken offer's plan has run. `session`: the
   * host session it came from (HelperServer), which a taken offer's run is bound to; absent in process.
   */
  async handleOffer(m: OfferControl, session?: string): Promise<TaskResult | null> {
    if (m.action !== "take") return this.patterns.control(m);
    const stale = this.checkMemoryBeforeAccept(m.offerId);
    if (stale !== null) {
      this.error(`offer ${m.offerId}: ${stale}`);
      return null;
    }
    this.bindNew(m.offerId, session);
    const used = this.offerMemory.get(m.offerId) ?? [];
    const out = await this.patterns.control(m);
    if (out !== null) this.confirmMemory(used);
    return out;
  }

  /**
   * Right before an offer is taken, the memory files are checked by content, not by stat (plan section 6): an edit
   * the watcher has not reported yet withdraws what it invalidates now. Returns why this offer can no longer be
   * taken, or null.
   */
  private checkMemoryBeforeAccept(offerId: string): string | null {
    const changes = [...this.memory.takeOutsideChanges(), ...this.memory.verify()];
    if (changes.length === 0) return null;
    const used = new Set(this.offerMemory.get(offerId) ?? []);
    this.memoryChangedOutside(changes);
    const hit = changes.find((c) => used.has(c.id));
    return hit === undefined ? null : `what it uses from memory (${hit.id}) changed since it was offered`;
  }

  /** The user took an offer: the noticed facts it was built from are confirmed (lead decision 3). */
  private confirmMemory(ids: readonly string[]): void {
    if (ids.length === 0) return;
    // An accept resolves when its run ends, which can be after the helper shut its store: a failed confirmation is
    // said, never thrown into a promise nobody awaits.
    try {
      const confirmed = this.memory.confirm(ids);
      if (confirmed.length > 0) this.opts.store.count("memory.confirmed", confirmed.length);
    } catch (e) {
      this.opts.warn?.(`memory: confirming ${ids.join(", ")} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Memory changed outside Caret: in an editor, the memory window's editor, or by "Not right". Offers built from a
   * changed entry are withdrawn as stale, an edited skill's offers too, and every live task is checked again, so one
   * that copies a changed value or runs a changed skill is revoked before its next act (S1 audit #4).
   */
  private memoryChangedOutside(changes: readonly { id: string; kind: string }[]): void {
    if (changes.length === 0) return;
    this.opts.store.count("memory.outside_change", changes.length);
    for (const c of changes) this.withdrawMemoryOffers(c.id);
    this.patterns.memoryChanged(changes);
    this.executor.recheck();
    this.routing?.memoryChanged();
    this.routing?.observe();
  }

  /** "Not right" on an offer, about one fact it used (memoryNotRight, lead decision 3). The reply goes to the asker only. */
  handleMemoryNotRight(m: MemoryNotRight): MemoryReply {
    const reply = (entries: MemoryReply["entries"], error: string | null): MemoryReply => ({ type: "memoryReply", v: PROTOCOL_VERSION, requestId: m.requestId, error, entries });
    try {
      const kind = this.memory.get(m.memoryId).kind;
      const e = this.memory.notRight(m.memoryId, m.correction, Math.max(this.now(), Date.now()));
      this.opts.store.count(m.correction === null ? "memory.not_right_forget" : "memory.not_right_fix", 1);
      this.memoryChangedOutside([{ id: m.memoryId, kind }]);
      return reply(e === null ? [] : [e], null);
    } catch (e) {
      if (e instanceof MemoryError) return reply([], e.message);
      throw e;
    }
  }

  /**
   * Whether resuming this memory entry would bring back consent the router acts on (routing/consent.ts): a skill, or
   * the routine a skill is made from. Unknown ids carry none; the store answers them with its own error.
   */
  resumeRestoresConsent(id: string | undefined): boolean {
    if (id === undefined) return false;
    try {
      const kind = this.memory.get(id).kind;
      return kind === "skill" || kind === "routine";
    } catch {
      return false;
    }
  }

  /**
   * The memory window's documents: list, read, or save from its editor (memoryDocumentRequest). To the asker only.
   * `fromHost`: the request came from a host session. A skill's document holds its status, which is the user's consent
   * to the router passing its offers (routing/consent.ts), so only the host may save one.
   */
  handleMemoryDocument(m: MemoryDocumentRequest, fromHost: boolean): MemoryDocumentReply {
    const base = { type: "memoryDocumentReply", v: PROTOCOL_VERSION, requestId: m.requestId, folder: this.memory.folder } as const;
    const wire = (d: DocumentInfo): MemoryDocument => ({ doc: d.doc, file: d.file, path: d.path, revision: d.revision, bytes: d.bytes, diagnostics: d.diagnostics.map((x) => ({ line: x.line, field: x.field, severity: x.severity, message: x.message })) });
    const fail = (error: string, conflict: { revision: string | null } | null = null, documents: MemoryDocument[] = []): MemoryDocumentReply => ({ ...base, error, conflict, documents, text: null });
    if (m.op === "save" && m.doc?.startsWith("skills/") === true && !fromHost) return fail("a skill's document is saved only from the host (host: true): its status is your consent to it");
    try {
      switch (m.op) {
        case "list":
          return { ...base, error: null, conflict: null, documents: this.memory.documents().map(wire), text: null };
        case "read": {
          const r = this.memory.readDocument(m.doc as DocId);
          return { ...base, error: null, conflict: null, documents: [wire(r.info)], text: r.text };
        }
        case "save": {
          const info = this.memory.saveDocument(m.doc as DocId, m.baseRevision ?? null, m.text ?? "");
          this.opts.store.count("memory.document_saved", 1);
          // The user's edits reach offers and tasks before the reply goes out.
          this.memoryChangedOutside(this.memory.takeOutsideChanges());
          return { ...base, error: null, conflict: null, documents: [wire(info)], text: null };
        }
      }
    } catch (e) {
      if (e instanceof MemoryConflictError) {
        this.opts.store.count("memory.save_conflict", 1);
        let current: MemoryDocument[] = [];
        try {
          current = [wire(this.memory.readDocument(m.doc as DocId).info)];
        } catch {
          // The reply still says there was a conflict.
        }
        return fail(e.message, { revision: e.current }, current);
      }
      if (e instanceof MemoryDocumentError || e instanceof MemoryError) return fail(e.message);
      throw e;
    }
  }

  /** The noticed facts a plan proposal was built from, sent with it to its asker; null when it used none. */
  provenanceFor(offerKey: string | null): MemoryProvenance | null {
    return offerKey === null ? null : this.provenance(offerKey);
  }

  private provenance(offerKey: string): MemoryProvenance | null {
    const facts = this.memory.noticedAmong(this.offerMemory.get(offerKey) ?? []);
    if (facts.length === 0) return null;
    const now = this.now();
    return {
      type: "memoryProvenance",
      v: PROTOCOL_VERSION,
      at: now,
      offerKey,
      facts: facts.map((f) => ({ memoryId: f.id, kind: f.kind, label: f.label, says: noticedSays(f.noticed.app, f.noticed.at, now), noticed: { app: f.noticed.app, windowTitle: f.noticed.window, at: f.noticed.at } })),
    };
  }

  /**
   * The host took an action of an action line or pop-up. The offer must be live, not yet accepted, and
   * the action and overrides must be ones the host was shown; then the offer's producer runs it as the
   * task whose id is the offerId. Any refusal publishes an error and, unless a run already has that id,
   * a terminal taskProgress, so the host's working line ends. The run is bound to `session`, the host
   * session that accepted it (S1 audit #5).
   */
  async handleOfferAccept(m: OfferAccept, session?: string): Promise<TaskResult | null> {
    if (this.mode !== "live") return this.refuseAccept(m.offerId, "the helper is in shadow mode and does not act");
    const stale = this.checkMemoryBeforeAccept(m.offerId);
    if (stale !== null) return this.refuseAccept(m.offerId, stale);
    const r = this.offers.get(m.offerId);
    if (r === undefined) return this.refuseAccept(m.offerId, "no such offer, or it expired");
    if (r.accepted) return this.refuseAccept(m.offerId, "already accepted");
    const why = acceptRefusal(r, m);
    if (why !== null) return this.refuseAccept(m.offerId, why);
    if (r.accept === null) return this.refuseAccept(m.offerId, "the offer has nothing to run");
    r.accepted = true;
    this.bindNew(m.offerId, session);
    const used = this.offerMemory.get(m.offerId) ?? [];
    let out: AcceptResult;
    try {
      out = await r.accept(m);
    } catch (e) {
      return this.refuseAccept(m.offerId, e instanceof Error ? e.message : String(e));
    }
    if ("refused" in out) return this.refuseAccept(m.offerId, out.refused);
    this.confirmMemory(used);
    return out;
  }

  /**
   * The host's Command-1 on a per-field fill proposal (D2-04, protocol FillAll): the transaction the fill pop-up's Fill
   * all runs, for every field the proposal gives a value Caret writes. The proposal must be one this helper published
   * and still keeps, not run before, and every destination and source must still show what it showed (recheckFill).
   * The run is the task `proposalId`, bound to the host session that asked. A refusal is an error and a stopped
   * taskProgress, as an offerAccept's is.
   */
  async handleFillAll(m: FillAll, session?: string): Promise<TaskResult | null> {
    if (this.mode !== "live") return this.refuseAccept(m.proposalId, "the helper is in shadow mode and does not act");
    const kept = this.proposals.get(m.proposalId);
    if (kept === undefined) return this.refuseAccept(m.proposalId, "no such fill proposal, or it expired");
    if (this.executor.has(m.proposalId)) return this.refuseAccept(m.proposalId, "this proposal was already filled");
    const p = writtenFields(kept.proposal, this.model.windows.get(kept.windowId));
    if (p.fields.length === 0) return this.refuseAccept(m.proposalId, "Caret writes none of this proposal's fields");
    const stale = recheckFill(this.model, p, this.aboutNow);
    if (stale !== null) return this.refuseAccept(m.proposalId, `${stale}; nothing was written`);
    this.bindNew(m.proposalId, session);
    const { plan, slots } = fillPlan(this.model, p);
    // The destinations were empty just now; one the user fills before the run's first read stops it.
    return this.runFrom("fill", m.proposalId, plan, slots, { [p.windowId]: Object.fromEntries(p.fields.map((f) => [f.key, ""])) });
  }

  /** Esc on running work: a stop for the task the offer started. */
  handleOfferStop(m: OfferStop): Promise<TaskResult | UndoResult | null> {
    return this.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: m.offerId, action: "stop" });
  }

  private refuseAccept(offerId: string, reason: string): null {
    this.error(`offer ${offerId}: ${reason}`);
    // A second accept of an offer whose run is still going must not end that run's working line; one
    // after the run finished opened a new line on the host, which this ends.
    if (!this.executor.live(offerId)) {
      this.publish({ type: "taskProgress", v: PROTOCOL_VERSION, at: this.now(), taskId: offerId, planId: offerId, phase: "stopped", step: null, steps: 0, says: null, detail: reason, stopReason: "refused" });
    }
    return null;
  }

  /** Answers a memory request; the server sends the reply to the asking consumer only, since entries hold personal values. */
  handleMemory(m: MemoryRequest): MemoryReply {
    const reply = this.patterns.memoryRequest(m);
    // An offer showing a value the user just edited, paused, forgot or typed again no longer holds: every
    // recorded offer that refers to the entry ({memory: id}, a fill pop-up's or a first look's) is withdrawn.
    // A per-field fillProposal cannot be withdrawn; its write is checked against memory again (recheckFill,
    // Step.memory). The engine withdraws its own loop and routine offers (withdrawDependents).
    if (reply.error === null && (m.op === "edit" || m.op === "pause" || m.op === "forget" || m.op === "add")) {
      const ids = m.op === "add" ? reply.entries.map((e) => e.id) : m.id === undefined ? [] : [m.id];
      for (const id of ids) this.withdrawMemoryOffers(id);
    }
    // A permission changed, a skill put back on Tab, paused or forgotten, or an entry a run copies edited or
    // forgotten: every task that depended on it is revoked now (S1 audit #4).
    if (reply.error === null && m.op !== "list") {
      this.executor.recheck();
      this.routing?.memoryChanged();
    }
    // A name or email the user just told Caret reaches the form they are on now, without a new focus (B21).
    if (reply.error === null && m.op === "add") {
      const at = this.now();
      for (const e of reply.entries) this.aboutAddedAt.set(e.id, at);
      this.refillFocused();
    }
    // Routed, the moment is read again once the entries' add times are known, so an add opens one decision, not two.
    if (reply.error === null && m.op !== "list") this.routing?.observe();
    return reply;
  }

  /**
   * Asks again about the field the user is in, as a focus there would: an empty editable field of the
   * frontmost app's focused window. The form's repeat window still holds unless an entry added since its
   * last ask fits one of its fields (fill, FILL_REPEAT_MS).
   */
  private refillFocused(): void {
    if (this.mode !== "live") return;
    // Routed, the router decides again: the fill candidate's legality reads the entries added since the form was asked.
    if (this.routing !== null) {
      this.routing.candidatesChanged();
      this.routing.observe();
      return;
    }
    // The frontmost app's focused window: focusedWindowId can name a background app's window after a request walk.
    // Tests that allow background focus take the latest focus in any app, as their focus events do.
    const background = this.opts.allowBackgroundFocus && this.model.focusedWindowId !== null ? this.model.windows.get(this.model.focusedWindowId) : undefined;
    const w = background ?? this.model.userWindow();
    if (w === null || w.focusedKey === null) return;
    if (!this.opts.allowBackgroundFocus && (this.model.frontmostPid === null || this.model.frontmostPid !== w.app.pid)) return;
    const id = w.window.windowId;
    const n = w.nodes.get(w.focusedKey);
    if (n?.editable !== true || (n.value ?? "") !== "") return;
    void this.fill(id, w.focusedKey, false, true);
  }

  /** Whether an About entry added at or after `since` fits a field of the form around `key`. */
  private addedSince(since: number, w: WindowState, key: string): boolean {
    const fresh = this.aboutValues().filter((a) => (this.aboutAddedAt.get(a.id) ?? -Infinity) >= since);
    return formAsksFor(w, key, fresh);
  }

  /** Notes which memory entries an offer was built from, by the refs its message carries. */
  private rememberOfferMemory(offerKey: string, m: unknown): void {
    const ids = new Set<string>();
    memoryRefs(m, ids);
    if (ids.size > 0) this.offerMemory.set(offerKey, [...ids]);
    else this.offerMemory.delete(offerKey);
  }

  private withdrawMemoryOffers(memoryId: string): void {
    for (const key of this.offers.keys()) {
      const r = this.offers.get(key);
      if (r === undefined || !refersToMemory(r.message, memoryId)) continue;
      if (this.fillPopups.has(key)) this.withdrawFill(key, "stale");
      else if (this.firstLooks.has(key)) this.withdrawFirstLook(key, "stale");
      else if (this.planOffers.has(key)) this.withdrawPlan(key, "stale");
      else this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id: key, reason: "stale" });
    }
  }

  /** The values the user told Caret that fills may offer: active typed About entries (fill/about.ts). */
  private aboutValues(): AboutValue[] {
    return aboutValues(this.memory.active("about"));
  }

  /** An About entry as aboutValues gives it now, or null when it is gone, paused, not typed or fits no field. */
  private readonly aboutNow = (id: string): AboutValue | null => {
    const a = this.memory.about(id);
    return a === null ? null : (aboutValues([{ id, fields: a }])[0] ?? null);
  };

  /** Answers an activity request; the server sends the reply to the asking consumer only. */
  handleActivity(m: ActivityRequest): ActivityReply {
    return this.tasks.answer(m);
  }

  /**
   * The host's report on one proposed field. `inserted` marks the field's transfer as Caret's,
   * whether the transfer was judged already or is judged later; `undone` removes that transfer from
   * the log and the store again. Other outcomes are counted. A result for a proposal or field this
   * helper never proposed is an error, not a guess.
   */
  handleFillResult(m: FillResult): void {
    const store = this.opts.store;
    const p = this.proposals.get(m.proposalId);
    if (p === undefined) return this.error(`fillResult: unknown or expired proposal ${m.proposalId}`);
    if (p.windowId !== m.windowId) return this.error(`fillResult: proposal ${m.proposalId} is for window ${p.windowId}, not ${m.windowId}`);
    const value = p.values.get(m.fieldKey);
    if (value === undefined) return this.error(`fillResult: proposal ${m.proposalId} proposed no value for ${m.fieldKey}`);
    store.count(`fill.result_${m.outcome}`, 1, m.at);
    // The host writes into the field the user is in: a use of "Write where you are". An undo is the user's, not a use.
    if (m.outcome === "inserted" || m.outcome === "rejected" || m.outcome === "failed") {
      const where = `${p.labels.get(m.fieldKey) ?? "a field"}${p.app === null ? "" : ` in ${p.app}`}`;
      this.memory.recordUse("writeHere", m.outcome === "inserted" ? { at: m.at, says: `Filled ${where}`, app: p.app, outcome: "done" } : { at: m.at, says: `Could not fill ${where}`, app: p.app, outcome: "failed" });
    }
    const id = fieldId(m.windowId, m.fieldKey);
    if (m.outcome === "inserted") {
      const fill: CaretFill = { proposalId: m.proposalId, at: m.at, value, undoneAt: null, transfers: [] };
      this.caretFills.set(id, fill);
      // The transfers may have been judged before the result arrived.
      for (const t of this.recentTransfers) if (fieldId(t.dst.windowId, t.dst.key) === id && fillMatches(fill, t)) this.markCaret(fill, t);
      return;
    }
    if (m.outcome === "undone") {
      const fill = this.caretFills.get(id);
      if (fill === undefined || fill.proposalId !== m.proposalId) return this.error(`fillResult: undone for ${m.fieldKey}, but no insert of proposal ${m.proposalId} was reported`);
      fill.undoneAt = m.at;
      for (const t of fill.transfers) {
        const i = this.recentTransfers.indexOf(t);
        if (i >= 0) this.recentTransfers.splice(i, 1);
        if (t.rowId !== undefined) store.removeTransfer(t.rowId);
      }
      fill.transfers = [];
    }
  }

  private markCaret(fill: CaretFill, t: Transfer): void {
    t.attribution = "caret";
    fill.transfers.push(t);
    if (t.rowId !== undefined) this.opts.store.setAttribution(t.rowId, "caret");
  }

  /** An executor phase becomes a task record: created on the run's first phase, updated on every later one. */
  private onTaskEvent(e: TaskEvent): void {
    const state = PHASE_STATE[e.phase];
    // A task that can no longer act needs no host binding; an undo binds it again to the session asking.
    if (state !== "running" && state !== "paused") {
      this.taskHosts.delete(e.taskId);
      this.taskDeps.delete(e.taskId);
    }
    const cause: TaskCause | null = e.cause ?? (state === "running" ? null : state === "undone" ? "you" : "caret");
    const fields = {
      state,
      cause,
      step: e.step,
      steps: e.steps,
      stepSays: e.says,
      remaining: e.remaining,
      detail: e.detail,
      undoable: e.undoable,
      ...(e.window === null ? {} : { app: e.window.app, windowId: e.window.windowId, windowTitle: e.window.title, frame: e.window.frame }),
    };
    try {
      if (this.tasks.get(e.taskId) === undefined) {
        this.tasks.create({ id: e.taskId, kind: "plan", says: e.title, app: null, windowId: null, windowTitle: null, frame: null, pending: null, ...fields });
      } else this.tasks.update(e.taskId, fields);
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      this.opts.warn?.(`activity: ${err.message}`);
    }
  }

  /**
   * A loopFinish or routine offer is prepared work: it is listed as ready under the offer's id, which
   * is also the task id its run gets when taken. Withdrawn before it ran, it becomes undone.
   */
  private onPatternMessage(m: HelperMessage): void {
    if (m.type === "patternOffer" && (m.kind === "loopFinish" || m.kind === "routine")) {
      const w = this.model.windows.get(m.windowId);
      this.tasks.create({
        id: m.id,
        kind: m.kind,
        state: "ready",
        cause: null,
        says: m.says,
        app: w?.app ?? null,
        windowId: m.windowId,
        windowTitle: w?.window.title ?? null,
        frame: w?.window.frame ?? null,
        step: null,
        steps: null,
        stepSays: null,
        remaining: [],
        detail: null,
        undoable: false,
        pending: null,
      });
    } else if (m.type === "offerWithdrawn" && m.reason !== "taken" && this.tasks.get(m.id)?.state === "ready") {
      const by: TaskCause = m.reason === "dismissed" || m.reason === "diverged" || m.reason === "reoffered" || m.reason === "settings" ? "you" : m.reason === "expired" ? "caret" : "screen";
      const detail = m.reason === "reoffered" ? `you entered some values; the rest are offered as ${m.replacedBy}` : `withdrawn: ${m.reason}`;
      this.tasks.update(m.id, { state: "undone", cause: by, detail });
    }
  }

  /** Runs a plan or controls a task. Errors in the request itself are published, not thrown. */
  /** `session`: the host session it came from; a run, resume or undo is bound to it (S1 audit #5). */
  async handleTask(m: RunPlan | TaskControl, session?: string): Promise<TaskResult | UndoResult | null> {
    if (this.mode !== "live") {
      this.error(`task ${m.taskId}: the helper is in shadow mode and does not act`);
      return null;
    }
    try {
      if (m.type === "runPlan") {
        // A task id names one piece of work in the activity feed; a run may not take over another's record.
        if (this.tasks.get(m.taskId) !== undefined) throw new Error(`task id ${m.taskId} is already in use`);
        this.bindNew(m.taskId, session);
        // No act grant: a consumer's plan is not an offer the user accepted, so the reader acts for it
        // only in --act-pids processes, which only tests start.
        return await this.executor.run(m.taskId, m.plan, m.slots);
      }
      if (m.reason !== undefined && m.action !== "pause") throw new Error(`reason ${m.reason} goes only with pause, not ${m.action}`);
      if (this.pending.has(m.taskId) || this.tasks.get(m.taskId)?.kind === "watch") {
        // A resumed watch can resolve into consent the router acts on (routing/consent.ts): only the host's resume is
        // the user's. In-process callers pass no session.
        if (m.action === "resume" && session !== undefined && !this.hosts.has(session)) throw new Error(`watch ${m.taskId}: only the host resumes a watch, since what it finds passes the router as your consent`);
        this.pending.control(m.taskId, m.action);
        return null;
      }
      switch (m.action) {
        case "resume":
          // A goal's segment runs only from an acceptance of its digest (D2-06): never from a generic resume.
          if (this.goals.owns(m.taskId)) throw new Error(`task ${m.taskId} is a goal's step; a goal goes on only from a fresh acceptance`);
          this.rebind(m.taskId, session, this.executor.resumeRefusal(m.taskId));
          return await this.executor.resume(m.taskId);
        case "undo":
          // Asking to undo a skill's run resets its clean runs and puts it back on Tab (B19), before the restore
          // is awaited: a restore that is refused or fails (a reader restart since the run, S1 audit #15) must
          // not leave the skill running on its own.
          // A run of the same skill still going depends on it running on its own: Skills.reset sweeps (onSkillReset).
          this.patterns.skills.reversed(m.taskId, this.now());
          this.rebind(m.taskId, session, this.executor.undoRefusal(m.taskId));
          return await this.executor.undo(m.taskId);
        case "pause":
        case "takeOver":
          // The run's own promise resolves as paused at the next step boundary.
          this.executor.pause(m.taskId, m.action === "takeOver", m.action === "pause" ? m.reason : undefined);
          return null;
        case "stop":
          this.executor.stop(m.taskId);
          return null;
      }
    } catch (e) {
      this.error(`task ${m.taskId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Periodic work: settled transfers, idle shadow episodes, pruning and count flushes. */
  tick(now = this.now()): void {
    this.record(this.transfers.tick(now));
    this.patterns.tick(now);
    for (const [k, f] of [...this.firstLooks]) if (expired("firstLook", f.at, now)) this.withdrawFirstLook(k, "expired");
    for (const [k, p] of [...this.planOffers]) if (expired("plan", p.at, now)) this.withdrawPlan(k, "expired");
    for (const [k, q] of [...this.askQuestions]) if (q.expires <= now) this.askQuestions.delete(k);
    this.goals.tick(now);
    this.events.tick(now);
    if (this.mode === "shadow") this.shadowLogger.tick(now);
    this.audit?.tick(now);
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.model.prune(now);
      // The reader skips snapshots of unchanged windows, so text still on screen is marked seen here;
      // otherwise a window left untouched for ten minutes would drop out of the text window.
      for (const w of this.model.windows.values()) this.text.observe(w, now);
      this.text.prune(now);
      const cutoff = now - 10 * 60 * 1000;
      while ((this.recentTransfers[0]?.at ?? now) < cutoff) this.recentTransfers.shift();
      for (const [id, p] of this.proposals) if (now - p.at > PROPOSAL_KEEP_MS) this.proposals.delete(id);
      for (const [id, f] of this.caretFills) if (now - f.at > PROPOSAL_KEEP_MS) this.caretFills.delete(id);
      this.tasks.prune(now);
      this.opts.store.flush();
    }
  }

  shutdown(): void {
    // First, so nothing a late reply or a producer's answer starts reaches the router after the stores close (R2).
    this.routing?.stop();
    this.record(this.transfers.flush());
    this.patterns.shutdown();
    this.pending.shutdown();
    this.shadowLogger.close();
    this.opts.store.flush();
  }

  private record(judged: Transfer[]): void {
    const store = this.opts.store;
    const ts: Transfer[] = [];
    for (const t of judged) {
      const fill = this.caretFills.get(fieldId(t.dst.windowId, t.dst.key));
      const caret = fill !== undefined && fillMatches(fill, t);
      // An edit from before the host undid the fill leaves nothing to log: it is gone from the field.
      if (caret && fill.undoneAt !== null) continue;
      if (caret) t.attribution = "caret";
      ts.push(t);
      this.recentTransfers.push(t);
      store.count(`transfer.${t.match}`, 1, t.at);
      t.rowId = store.addTransfer({
        at: t.at,
        valueHash: store.hash(t.value),
        kind: t.kind,
        length: t.value.length,
        match: t.match,
        srcBundle: t.src.bundleId,
        srcWindowKind: t.src.windowKind,
        srcKeyHash: store.hash(t.src.nodeKey),
        dstBundle: t.dst.bundleId,
        dstWindowKind: t.dst.windowKind,
        dstKeyHash: store.hash(t.dst.key),
        ageMs: t.ageMs,
        attribution: t.attribution,
      });
      if (caret) fill.transfers.push(t);
    }
    if (ts.length > 0) this.patterns.onTransfers(ts);
  }

  /** `afterAdd`: asked because an About entry was just added (refillFocused), not because of a focus. */
  private async fill(windowId: string, key: string, explicit: boolean, afterAdd = false): Promise<FillProposal | null> {
    const ask = this.ask;
    const store = this.opts.store;
    if (ask === null || this.mode === "shadow") {
      if (explicit) this.error(`fill unavailable: ${ask === null ? "Jev is disabled" : "helper is in shadow mode"}`);
      return null;
    }
    const now = this.now();
    // A fill the host asked for is its own decision; one a focus triggered is an offer, which the settings may hold.
    if (!explicit) {
      const held = this.gate.holds("fill", now);
      if (held.length > 0) {
        store.count(`fill.held_${held[0]}`, 1, now);
        return null;
      }
    }
    const w = this.model.windows.get(windowId);
    if (w === undefined) {
      this.fillFailed(`unknown window ${windowId}`, "noWindow");
      return null;
    }
    let formKey: string;
    try {
      formKey = `${windowId}|${formFields(w, key).map((n) => n.key).sort().join(",")}`;
    } catch (e) {
      this.fillFailed(e instanceof FillError ? e.message : String(e), e instanceof FillError ? e.why : null);
      return null;
    }
    if (this.inflight.has(formKey)) {
      // The fill under way read memory before the entry arrived; the form is asked again once it ends.
      if (afterAdd) this.refillAfter.add(formKey);
      return null;
    }
    if (!explicit && this.fillCovered(formKey, w, key, now)) return null;
    this.inflight.add(formKey);
    const session = this.readerSession;
    const focuses: { windowId: string; key: string }[] = [];
    this.pendingFills.add(focuses);
    try {
      const asked = await proposeFill(this.model, ask, windowId, key, now, {
        about: this.aboutValues(),
        ...(this.opts.fillCutoff === undefined ? {} : { cutoff: this.opts.fillCutoff }),
        ...(this.opts.newId === undefined ? {} : { newId: this.opts.newId }),
      });
      const p = session === this.readerSession ? this.revalidate(asked) : null;
      this.lastFill.set(formKey, now);
      if (p === null) {
        store.count("fill.stale", 1, now);
        return null;
      }
      // The settings may have changed while Jev answered: a pause or a role turned off then holds this offer too.
      const heldNow = explicit ? [] : this.gate.holds("fill", this.now());
      if (heldNow.length > 0) {
        store.count(`fill.held_${heldNow[0]}`, 1, now);
        return null;
      }
      store.count("fill.request", 1, now);
      store.count("fill.fields", p.fields.length, now);
      store.count("fill.proposed_values", p.fields.filter((f) => f.value !== null).length, now);
      // Every field grounded: the host shows one pop-up and Caret fills them all on Tab, so there is
      // no per-field insert for a fillResult to report, and the proposal is not kept for one. An
      // explicit fillRequest asks for the proposal itself (scripts/fill-eval.ts reads its fields), so it
      // always gets one.
      // The pop-up runs the fields Caret writes: text, and in a page the engine owns, the controls it writes (D2-04).
      // What it leaves to the user, the pop-up lists.
      const written = writtenFields(p, this.model.windows.get(p.windowId));
      if (!explicit && fillPopupEligible(p)) {
        if (this.fillOverBeforeShown(written, formKey, focuses) !== null) {
          store.count("fill.popup_stale", 1, now);
          return p;
        }
        store.count("fill.popup", 1, now);
        if (this.publish(buildFillPopup(this.model, written), () => this.acceptFill(written))) {
          this.fillPopups.set(written.id, { p: written, form: formKey });
          // The hour runs from when the offer is shown, not from when it was asked for.
          this.gate.spoke(this.now());
        }
        return p;
      }
      const valued = p.fields.filter((f) => f.value !== null);
      this.proposals.set(p.id, {
        at: now,
        windowId: p.windowId,
        values: new Map(valued.map((f) => [f.key, f.value as string])),
        // For the use a fillResult records: the field's name and the form's app, as they were when proposed.
        labels: new Map(valued.map((f) => [f.key, fieldLabel(this.model, p.windowId, f.key)])),
        app: this.model.windows.get(p.windowId)?.app.name ?? null,
        // For the host's Command-1 (fillAll), which runs the whole proposal as the pop-up's Fill all does.
        proposal: p,
      });
      this.publish(p);
      if (!explicit && p.fields.some((f) => f.value !== null)) this.gate.spoke(this.now());
      return p;
    } catch (e) {
      store.count("fill.error", 1, now);
      this.fillFailed(e instanceof FillError ? e.message : String(e), e instanceof FillError ? e.why : null);
      return null;
    } finally {
      this.pendingFills.delete(focuses);
      this.inflight.delete(formKey);
      if (this.refillAfter.delete(formKey)) this.refillFocused();
    }
  }

  /**
   * Whether a fill of this form would bring nothing new now: it was asked within FILL_REPEAT_MS and no About entry that
   * fits it was added since, or a pop-up already on offer covers it, however long ago it was made.
   */
  private fillCovered(formKey: string, w: WindowState, key: string, now: number): boolean {
    const last = this.lastFill.get(formKey);
    if (last !== undefined && now - last < FILL_REPEAT_MS && !this.addedSince(last, w, key)) return true;
    return [...this.fillPopups.values()].some((f) => f.form === formKey);
  }

  /** Work a routed decision started (a fill, an event's asks), for tests and evaluations to await. */
  routedSettled: Promise<void> = Promise.resolve();

  private startRouted(work: Promise<unknown>): void {
    this.routedSettled = Promise.all([this.routedSettled, work]).then(() => undefined);
  }

  /**
   * What each producer could do for the user's moment, listed by code with no model call (routing/coordinator.ts):
   *   - fillAll: an empty fillable field in the frontmost app, when fill would ask now (its settings, its repeat window,
   *     no pop-up covering the form) and some other window or a fitting About entry could give a value;
   *   - the event card for the field's last finished sentence, or for a conversation line heard while the user typed,
   *     when code finds a person and a time ahead in it; a time the sentence leaves open is the one question;
   *   - "Open <app>" for a watch that resolved while the user was elsewhere, when they are in a field of another window;
   *   - a loop or routine offer the recognizers held for this window. Held offers for other windows are let go.
   * Each candidate's `run` is the producer's unrouted path from the same point, with all of its own checks.
   */
  private routeCandidates(ctx: RoutingContext): RouteCandidate[] {
    const out: RouteCandidate[] = [];
    const w = this.model.windows.get(ctx.windowId);
    for (const id of this.patterns.heldIds()) if (w === undefined || !this.patterns.heldOffers(ctx.windowId).some((h) => h.id === id)) this.patterns.dropHeld(id);
    if (w === undefined) return out;
    const f = ctx.field;
    const node = f === null ? undefined : w.nodes.get(f.key);
    const now = this.now();
    if (f !== null && node !== undefined && f.editable && !f.secure) {
      const fill = this.fillCandidate(w, f.key, node, now);
      if (fill !== null) out.push(fill);
      if (ctx.sentences > 0 && this.gate.holds("event", now).length === 0) {
        const last = sentences(node.value ?? "", false).at(-1);
        // The event card asks Jev about the sentence through its window's budget; one that will not fit makes no card.
        if (last !== undefined && !this.events.isJudged(w.window.windowId, last) && new SnippetLedger(this.model.windows.values()).cost(w, [last]) !== null) {
          const c = this.events.candidate(w, f.key, last, "typed");
          if (c !== null) {
            const key = f.key;
            out.push({
              id: `event:${w.window.windowId}:${shortHash(last)}`,
              kind: "workflow",
              workflow: "event",
              says: `Add to Calendar the event this sentence the user just finished arranges: "${last}"`,
              plain: "Add to Calendar the event in the sentence the user just finished",
              quotes: [{ window: w, kind: "candidate", texts: [last, c.person] }],
              evidence: eventEvidence(c, "typed", "the user typed it in this field"),
              relevance: 2,
              ...(startOpen(c) ? { question: { fact: "eventStart", says: "which time the sentence means, since it leaves the start open" } } : {}),
              run: () => this.startRouted(this.events.judge(w, key, last, offerField(w, key), "typed")),
            });
          }
        }
      }
      for (const l of this.events.heard()) {
        if (l.field.windowId !== w.window.windowId || l.field.key !== f.key || !this.model.windows.has(l.w.window.windowId)) {
          this.events.forgetHeard(l);
          continue;
        }
        const c = new SnippetLedger(this.model.windows.values()).cost(l.w, [l.sentence]) === null ? null : this.events.candidate(l.w, l.key, l.sentence, "conversation");
        if (c === null) {
          this.events.forgetHeard(l);
          continue;
        }
        out.push({
          id: `event:${l.w.window.windowId}:${shortHash(l.sentence)}`,
          kind: "workflow",
          workflow: "event",
          says: `Add to Calendar the event this line just heard in ${l.w.app.name} arranges: "${l.sentence}"`,
          plain: `Add to Calendar the event in a line just heard in ${l.w.app.name}`,
          quotes: [{ window: l.w, kind: "candidate", texts: [l.sentence, c.person] }],
          evidence: eventEvidence(c, "conversation", `it is a new line in a ${l.w.app.name} conversation the user is in, perhaps written by someone else`),
          relevance: 1,
          ...(startOpen(c) ? { question: { fact: "eventStart", says: "which time the line means, since it leaves the start open" } } : {}),
          run: () => {
            this.events.forgetHeard(l);
            this.startRouted(this.events.judge(l.w, l.key, l.sentence, l.field, "conversation"));
          },
          drop: () => this.events.forgetHeard(l),
        });
      }
      for (const { cand } of this.openAppCandidates(w, f.key, now)) out.push(cand);
    }
    for (const h of this.patterns.heldOffers(w.window.windowId)) out.push(this.patternCandidate(h));
    return out;
  }

  /** "Open <app>" for each watch that resolved while the user was in another window, held for the field they are in now. */
  private openAppCandidates(w: WindowState, key: string, now: number): { cand: RouteCandidate; watchId: string }[] {
    if (this.gate.holds("pending", now).length > 0) return [];
    return this.openApp.heldOffers().flatMap((h) => {
      const watched = this.model.windows.get(h.windowId);
      if (watched === undefined || h.windowId === w.window.windowId) return [];
      const cand: RouteCandidate = {
        id: `openApp:${h.offerKey}`,
        kind: "workflow",
        workflow: "openApp",
        says: `Open ${h.app}, whose window the user was waiting on now says "${h.status}"`,
        plain: `Open ${h.app}, whose window the user was waiting on changed`,
        quotes: [{ window: watched, kind: "candidate", texts: [h.status] }],
        relevance: 0,
        run: () => this.openApp.showHeld(h.offerKey, offerField(w, key)),
      };
      return [{ cand, watchId: h.watchId }];
    });
  }

  /** A loop, routine or kept skill's offer the recognizers held for this window. */
  private patternCandidate(h: HeldPatternOffer): RouteCandidate {
    const from = h.from.join(" and ");
    const plain = h.skill
      ? `Run the user's saved skill "${h.says}" here`
      : h.kind === "loopNext"
        ? `Offer the next row of what the user is copying from ${from}`
        : h.kind === "loopFinish"
          ? `Finish the rest of what the user is copying from ${from} (${h.values} values)`
          : `Fill ${h.values} fields from ${from} the way the user did before`;
    return {
      id: `pattern:${h.id}`,
      kind: "workflow",
      workflow: h.skill ? "skill" : h.kind === "routine" ? "routine" : "loop",
      says: plain,
      plain,
      quotes: [],
      // A kept skill first, then the pattern that matched most often.
      relevance: 10 + (h.skill ? 1000 : 0) + h.hits,
      run: () => this.patterns.release(h.id),
      drop: () => this.patterns.dropHeld(h.id),
    };
  }

  /**
   * The offers the user already consented to, for the router to pass with no question (routing/consent.ts). This is
   * the one place consent is decided: each candidate is built here around the held offer whose own record the ledger
   * checks, so its `run` shows exactly the offer the record is about:
   *   - "Open <app>" for a held open-app offer whose watch (the entry's own watchId) resolved, while a host sent the
   *     watch role;
   *   - a held pattern offer whose routine (the offer's own routineId) the user kept as a skill.
   * Learned loops have no routine and are never here. The router lists the same offers in routeCandidates and routes
   * whichever this does not pass.
   */
  private consentedCandidates(ctx: RoutingContext): { cand: RouteCandidate; consent: Consent }[] {
    const out: { cand: RouteCandidate; consent: Consent }[] = [];
    const w = this.model.windows.get(ctx.windowId);
    if (w === undefined) return out;
    const f = ctx.field;
    const node = f === null ? undefined : w.nodes.get(f.key);
    if (f !== null && node !== undefined && f.editable && !f.secure)
      for (const { cand, watchId } of this.openAppCandidates(w, f.key, this.now())) {
        const consent = this.consent.verify({ kind: "watch", watchId });
        if (consent !== null) out.push({ cand, consent });
      }
    for (const h of this.patterns.heldOffers(w.window.windowId)) {
      if (h.routineId === null) continue;
      const consent = this.consent.verify({ kind: "skill", routineId: h.routineId });
      if (consent !== null) out.push({ cand: this.patternCandidate(h), consent });
    }
    return out;
  }

  /** The fill candidate for the focused field, or null when a focus-triggered fill would not ask (fill's own checks). */
  private fillCandidate(w: WindowState, key: string, node: Node, now: number): RouteCandidate | null {
    if (!FILLABLE_ROLES.has(node.role) || (node.value ?? "") !== "" || this.gate.holds("fill", now).length > 0) return null;
    // A browser with a page engine is filled from the engine's own page window, not from Accessibility's view of it.
    if (!w.window.windowId.startsWith("page:") && this.opts.pageCovers?.(w.app.pid) === true) return null;
    let fields: Node[];
    try {
      fields = formFields(w, key);
    } catch (e) {
      if (e instanceof FillError) return null;
      throw e;
    }
    const formKey = `${w.window.windowId}|${fields.map((n) => n.key).sort().join(",")}`;
    if (this.inflight.has(formKey) || this.fillCovered(formKey, w, key, now)) return null;
    const fillable = fields.filter((n) => neverTypedNode(w, n) === null).length;
    if (fillable === 0) return null;
    const otherText = [...this.model.windows.values()].some((o) => o.window.windowId !== w.window.windowId && [...o.nodes.values()].some((n) => nodeText(n).trim() !== ""));
    const about = this.aboutValues();
    const told = formAsksFor(w, key, about);
    if (!otherText && !told) return null;
    const e = fillEvidence(this.model, w, fields, about);
    // Code relevance: no field visibly fits a value on screen or in memory, and no other field of a form lets fill lean on
    // the window the user just left (fill.ts's anchor). A lone document body with nothing that fits is not a form to fill.
    const left = this.model.windowBefore(w.window.windowId);
    if (e.fields === 0 && (fillable < 2 || left === null)) return null;
    const where = [...(e.apps.length === 0 ? [] : [`on screen in ${andList(e.apps)}`]), ...(e.told > 0 ? ["in what the user told Caret"] : [])];
    const says =
      e.fields === 0
        ? `Fill this form's ${fillable} empty field${fillable === 1 ? "" : "s"}, though no open window shows a value that clearly fits ${fillable === 1 ? "it" : "them"}`
        : `Fill this form: values that fit ${e.fields} of its ${fillable} empty field${fillable === 1 ? "" : "s"} are ${andList(where)}`;
    return {
      id: "fillAll",
      kind: "fillAll",
      says,
      plain: says,
      quotes: [],
      relevance: 0,
      run: () => this.startRouted(this.fill(w.window.windowId, key, false)),
    };
  }

  /**
   * Jev answers in a few hundred milliseconds, and the screen can move meanwhile. A proposal is
   * dropped when the helper left live mode, the window closed, or its trigger field is gone or no
   * longer empty; a field that has since been filled, that now reads differently (an app can reuse a
   * field's key for another field: B13 review), or whose source window closed, is left out.
   */
  private revalidate(p: FillProposal): FillProposal | null {
    if (this.mode !== "live") return null;
    const w = this.model.windows.get(p.windowId);
    const trigger = w?.nodes.get(p.triggerKey);
    if (w === undefined || trigger === undefined || (trigger.value ?? "") !== "") return null;
    const fields = p.fields.filter((f) => {
      // Read the way proposeFill read it, so a control is judged by its own rules (B24 review).
      const input = emptyInput(w, f.key);
      if (input === null || describeInput(w, input) !== f.descriptor) return false;
      const memory = f.memory ?? f.handoff?.memory ?? null;
      const value = f.value ?? f.handoff?.value ?? null;
      if (memory !== null) {
        const now = this.aboutNow(memory.id);
        return now !== null && memoryValue(now.value, memory.part) === value && now.label === memory.label;
      }
      const source = f.source ?? f.handoff?.source ?? null;
      return source === null || this.model.windows.has(source.windowId);
    });
    return { ...p, fields };
  }

  /**
   * "Fill all": every destination still empty and every source still showing its value, then one
   * executor run under the proposal id. The pop-up is withdrawn either way.
   */
  private async acceptFill(p: GroundedProposal): Promise<AcceptResult> {
    const stale = recheckFill(this.model, p, this.aboutNow);
    if (stale !== null) {
      this.withdrawFill(p.id, "stale");
      return { refused: `${stale}; nothing was written` };
    }
    const { plan, slots } = fillPlan(this.model, p);
    this.withdrawFill(p.id, "taken");
    // The destinations were empty just now; one the user fills before the run's first read stops it.
    return this.runFrom("fill", p.id, plan, slots, { [p.windowId]: Object.fromEntries(p.fields.map((f) => [f.key, ""])) });
  }

  /**
   * The form's window or a source window changed or closed: a fill pop-up it no longer matches is
   * withdrawn as stale. It no longer matches when a destination is gone or filled, a source stops
   * showing its value (recheckFill), or the form gained or lost a field.
   */
  private checkFills(windowId: string): void {
    for (const [id, { p, form }] of this.fillPopups) {
      if (p.windowId !== windowId && !p.fields.some((f) => f.source?.windowId === windowId)) continue;
      const w = this.model.windows.get(p.windowId);
      let changed = recheckFill(this.model, p, this.aboutNow) !== null;
      if (!changed && w !== undefined) {
        try {
          changed = `${p.windowId}|${formFields(w, p.triggerKey).map((n) => n.key).sort().join(",")}` !== form;
        } catch {
          changed = true;
        }
      }
      if (changed) this.withdrawFill(id, "stale");
    }
  }

  /**
   * Focus in an editable field the pop-up does not fill, in the app the user is in, ends the pop-up's
   * lifetime. Focus on anything else (a list, a button, another window's text) keeps it: the user may be
   * checking a source.
   */
  private onFillFocus(m: Focus): void {
    if (!m.editable || m.key === null || !(m.frontmost || this.opts.allowBackgroundFocus)) return;
    for (const focuses of this.pendingFills) focuses.push({ windowId: m.windowId, key: m.key });
    for (const [id, { p }] of this.fillPopups) if (!inFillForm(p, m.windowId, m.key)) this.withdrawFill(id, "expired");
  }

  /**
   * Why a pop-up about to be published would already be over, or null: focus moved to a field outside
   * the form while Jev answered, a source stopped showing its value, or the form's fields changed. The
   * events that would have ended it came before it existed.
   */
  private fillOverBeforeShown(p: GroundedProposal, form: string, focuses: readonly { windowId: string; key: string }[]): string | null {
    if (focuses.some((f) => !inFillForm(p, f.windowId, f.key))) return "focus left the form";
    const stale = recheckFill(this.model, p, this.aboutNow);
    if (stale !== null) return stale;
    const w = this.model.windows.get(p.windowId);
    try {
      if (w === undefined || `${p.windowId}|${formFields(w, p.triggerKey).map((n) => n.key).sort().join(",")}` !== form) return "the form changed";
    } catch {
      return "the form changed";
    }
    return null;
  }

  private withdrawFill(id: string, reason: "taken" | "stale" | "expired" | "settings"): void {
    this.fillPopups.delete(id);
    this.publish({ type: "offerWithdrawn", v: PROTOCOL_VERSION, at: this.now(), id, reason });
  }

  /**
   * The one way out to consumers. An alternatives, action or popup message is parsed against the
   * protocol first; one that fails is not sent, and the error names the offer and the first issue's
   * rule and path, never its text. A valid one is recorded with `accept`, how taking it runs; a
   * withdrawal removes the record. Returns false when the message was refused.
   */
  private publish(m: HelperMessage, accept?: AcceptHandler): boolean {
    if (HOST_OFFER_TYPES.has(m.type)) {
      const offerKey = String((m as HostOffer).offerKey);
      const parsed = HelperMessage.safeParse(m);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        this.opts.store.count("offers.refused", 1);
        const message = `offer ${offerKey} refused: ${issue?.message ?? "invalid"} at ${issuePath(issue?.path ?? [])}`;
        this.opts.warn?.(message);
        this.opts.publish({ type: "error", v: PROTOCOL_VERSION, at: this.now(), message });
        return false;
      }
      this.offers.record(m as HostOffer, accept ?? null);
    } else if (m.type === "offerWithdrawn") {
      this.offers.remove(m.id);
      this.offerMemory.delete(m.id);
    }
    this.opts.publish(m);
    this.recordShown(m);
    // Right after an offer built from a noticed fact: where that fact came from, for the offer's "Not right".
    if (HOST_OFFER_TYPES.has(m.type) || m.type === "patternOffer") {
      const key = m.type === "patternOffer" ? m.id : String((m as HostOffer).offerKey);
      this.rememberOfferMemory(key, m);
      const p = this.provenance(key);
      if (p !== null) this.opts.publish(p);
    }
    // A first look's key that reports this offer ends with it.
    if (m.type === "offerWithdrawn") {
      for (const [k, f] of [...this.firstLooks]) if (f.underlying === m.id) this.withdrawFirstLook(k, m.reason === "reoffered" ? "stale" : m.reason);
    }
    return true;
  }

  /**
   * Records a Jev request as a use of "Read and prepare": the apps whose text it carries (privacy.ts
   * snippets), and what the user told Caret. The second ask of a question declares the same text and is
   * not counted again; the comparison is kept in memory only.
   */
  private recordRead(req: Pick<JevRequest, "snippets">, outcome: "done" | "failed", to = "Jev"): void {
    const apps = [...new Set(req.snippets.flatMap((x) => (x.windowId === MEMORY_SNIPPETS || x.windowId === "plan" ? [] : [this.model.windows.get(x.windowId)?.app.name ?? "a closed window"])))];
    const told = req.snippets.some((x) => x.windowId === MEMORY_SNIPPETS);
    const planned = req.snippets.some((x) => x.windowId === "plan");
    const parts = [...(apps.length === 0 ? [] : [`snippets from ${andList(apps)}`]), ...(told ? ["what you told Caret"] : []), ...(planned ? ["your instruction"] : [])];
    const what = parts.length === 0 ? "a question with no screen text" : andList(parts);
    const says = outcome === "done" ? (parts.length === 0 ? `Asked ${to} ${what}` : `Sent ${what} to ${to}`) : `Tried to send ${what} to ${to}; the request failed`;
    const at = this.now();
    const declared = `${outcome}\u0002${req.snippets.map((x) => `${x.windowId}\u0000${x.text}`).sort().join("\u0001")}`;
    if (this.lastRead !== null && this.lastRead.declared === declared && at - this.lastRead.at < READ_REPEAT_MS) return;
    this.lastRead = { declared, at };
    this.memory.recordUse("read", { at, says, app: apps[0] ?? null, outcome });
  }

  /** Records a published offer the user can see as a use of "Show in Caret's UI", once per offer. */
  private recordShown(m: HelperMessage): void {
    let key: string;
    let windowId: string;
    let what: string;
    switch (m.type) {
      case "popup":
        key = m.offerKey;
        windowId = m.field.windowId;
        what = specSays(m.spec);
        break;
      case "action":
        key = m.offerKey;
        windowId = m.field.windowId;
        what = `"${clipUse(m.endState.text)}"`;
        break;
      case "alternatives":
        key = m.offerKey;
        windowId = m.field.windowId;
        what = `${m.candidates.length} values for a field`;
        break;
      case "fillProposal": {
        const n = m.fields.filter((f) => f.value !== null).length;
        if (n === 0) return;
        key = m.id;
        windowId = m.windowId;
        what = n === 1 ? "a value for a field" : `values for ${n} fields`;
        break;
      }
      default:
        return;
    }
    this.recordShownOffer(key, windowId, what);
  }

  /** One "Show in Caret's UI" use for the offer with this key, the first time it is shown. */
  private recordShownOffer(key: string, windowId: string, what: string): void {
    if (this.shown.has(key)) return;
    if (this.shown.size >= SHOWN_KEYS) this.shown.clear();
    this.shown.add(key);
    const app = this.model.windows.get(windowId)?.app.name ?? null;
    this.memory.recordUse("show", { at: this.now(), says: `Offered ${what}${app === null ? "" : ` in ${app}`}`, app, outcome: "done" });
  }

  /**
   * A fill that failed: the user reads a plain sentence (planner/says.ts), and what the check found, with its window
   * and field ids, goes to the log (B27; the early exits before proposeFill published the ids until its second review).
   */
  private fillFailed(detail: string, why: FillErrorWhy | null): void {
    this.opts.warn?.(`fill: ${detail}`);
    this.publish({ type: "error", v: PROTOCOL_VERSION, at: this.now(), message: fillSays(why) });
  }

  private error(message: string): void {
    this.opts.warn?.(message);
    this.publish({ type: "error", v: PROTOCOL_VERSION, at: this.now(), message });
  }
}

/** A Jev request that declares the same text as the last recorded one within this long is the same use: a question's second ask. Assumed. */
const READ_REPEAT_MS = 5000;
/**
 * How long a routeDecision holds at most. A decision ends at the next one; this is the backstop for a host that stops
 * hearing from the helper (a crash, a lost socket), so its writing help does not run on an old decision for good.
 * Assumed, not measured.
 */
const ROUTE_DECISION_HOLDS_MS = 30 * 60 * 1000;
/** Offer keys kept to count each shown offer once; past this the set starts over. Assumed. */
const SHOWN_KEYS = 500;

/**
 * How many of a form's fields an open window or the user's About entries visibly fit, by code: another window shows a
 * typed value of a kind the field's label asks for (an email, a phone, a date), or a "Label: value" line whose label
 * shares a word with the field's, or an About entry fits the field's name. Evidence for the router's description of
 * the fill route, not the fill: fill's own generator and Jev's two asks decide every value.
 *
 * A value some field of the form already holds is no evidence for another of its empty fields. Without this, a form
 * filled from a note still counted its one empty LinkedIn URL as fitting the portfolio address the note shows and the
 * form already has, and Router 1 took the cover-letter box for a fill (D2-02 corpus m18).
 */
function fillEvidence(model: ScreenModel, w: WindowState, fields: readonly Node[], about: readonly AboutValue[]): { fields: number; apps: string[]; told: number } {
  const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
  const held = new Set<string>();
  for (const n of w.nodes.values()) if (n.editable === true && (n.value ?? "").trim() !== "" && !n.states?.includes("secure")) held.add(norm(n.value ?? ""));
  const kinds = new Map<ValueKind, Set<string>>();
  const lines: { words: Set<string>; app: string }[] = [];
  for (const o of model.windows.values()) {
    if (o.window.windowId === w.window.windowId) continue;
    for (const v of o.values) if (!held.has(norm(v.text))) for (const k of valueKinds(v)) (kinds.get(k) ?? kinds.set(k, new Set()).get(k))?.add(o.app.name);
    for (const l of labelledLines(o)) if (!held.has(norm(l.value))) lines.push({ words: new Set(words(l.label)), app: o.app.name });
  }
  const unheld = about.filter((a) => !held.has(norm(a.value)));
  const apps = new Set<string>();
  let fit = 0;
  let told = 0;
  for (const n of fields) {
    if (neverTypedNode(w, n) !== null) continue;
    const d = describeField(w, n);
    const lw = [d.label, d.nearest, d.placeholder];
    const own = new Set(lw.flatMap(words));
    const byKind = [...fieldKinds(lw)].flatMap((k) => [...(kinds.get(k) ?? [])]);
    const byLine = lines.filter((l) => [...own].some((t) => l.words.has(t))).map((l) => l.app);
    const name = d.label ?? d.nearest ?? d.placeholder;
    const byAbout = unheld.some((a) => fieldAsksFor(a, name));
    if (byKind.length + byLine.length === 0 && !byAbout) continue;
    fit++;
    if (byAbout) told++;
    for (const x of [...byKind, ...byLine]) apps.add(x);
  }
  return { fields: fit, apps: [...apps], told };
}

/**
 * Whether an event's start is the one fact Caret must ask (the router's ask outcome): its possible times start at
 * different moments (AM or PM, which day, a repeated hour). A start that is known with only the length open is the
 * event route itself: the card offers the lengths in its own picker and adds nothing until one is chosen (D2-03).
 */
/**
 * What the event card's code checked before listing a sentence, for Router 1's task question (routes.ts `evidence`): the
 * person it found, the time it resolved from the reader's typed values, and where the sentence came from (`where`: typed
 * in the field, or a line of a window conversation.ts recognised). The sentence and the person are quoted through the
 * candidate's `quotes`.
 */
function eventEvidence(c: EventCandidate, source: SentenceSource, where: string): TaskEvidence {
  // A card that asks is listed as a task only when its choices share one start (startOpen): the sentence gave no end.
  const when = c.time.kind === "resolved" ? c.time.time.says : `${c.time.choices.map((t) => t.says).join(" or ")}, the sentence giving no end`;
  return {
    task: "Add an event to the user's calendar",
    sentence: c.sentence,
    found: `Code found in it the person "${c.person}" and the time ${when}; ${where}.`,
    offerWhen: OFFER_WHEN[source],
  };
}

function startOpen(c: EventCandidate): boolean {
  return c.time.kind === "ask" && new Set(c.time.choices.map((t) => t.start)).size > 1;
}

/** A short digest of a sentence for a candidate's id: the id must not carry screen text into the logs. */
function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** "A", "A and B", "A, B and C". */
function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** Whether a value anywhere in an offer message is a {memory: id} ref to this entry (popup.ts PopupRef). */
/**
 * Every memory id an offer message refers to: a popup ref {memory}, a pattern cell's memory list, a fill field's
 * memory {id}.
 */
function memoryRefs(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) memoryRefs(x, out);
    return;
  }
  if (v === null || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === "memory") {
      if (typeof x === "string") out.add(x);
      else if (Array.isArray(x)) {
        for (const y of x) if (typeof y === "string") out.add(y);
      } else if (x !== null && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") out.add((x as { id: string }).id);
    }
    memoryRefs(x, out);
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "from what Caret noticed in Mail, Tue": the app when known, and the day in words near now, else the date. */
export function noticedSays(app: string | null, at: number, now: number): string {
  const day = (t: number): number => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const ago = day(now) - day(at);
  const d = new Date(at);
  const when = ago === 0 ? "today" : ago === 1 ? "yesterday" : ago > 1 && ago < 7 ? (WEEKDAYS[d.getDay()] as string) : `${MONTHS[d.getMonth()] as string} ${d.getDate()}${d.getFullYear() === new Date(now).getFullYear() ? "" : `, ${d.getFullYear()}`}`;
  return `from what Caret noticed${app === null ? "" : ` in ${app}`}, ${when}`;
}

function refersToMemory(v: unknown, id: string): boolean {
  if (Array.isArray(v)) return v.some((x) => refersToMemory(x, id));
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.memory === id && Object.keys(o).length === 1) return true;
  return Object.values(o).some((x) => refersToMemory(x, id));
}

/** The activity row of a run a crash interrupted: stopped by Caret at the first step it had not verified. */
function recoveredRecord(r: JournalRecord): Parameters<TaskRegistry["create"]>[0] {
  const steps = r.plan.steps.length;
  const at = r.next < steps ? r.next : null;
  const where = at === null ? "after its last step" : `at step ${at + 1} of ${steps}`;
  const writes = r.ledger.some((e) => e.kind !== "press") || (r.pending !== null && r.pending.kind !== "press");
  return {
    id: r.taskId,
    kind: "plan",
    state: "failed",
    cause: "caret",
    says: r.plan.title,
    app: r.window?.app ?? null,
    windowId: r.window?.windowId ?? null,
    windowTitle: r.window?.title ?? null,
    frame: r.window?.frame ?? null,
    step: at,
    steps,
    stepSays: at === null ? null : (r.plan.steps[at]?.says ?? null),
    remaining: r.plan.steps.slice(r.next).map((s) => s.says),
    detail: `Stopped when Caret restarted, ${where}`,
    undoable: writes,
    pending: null,
  };
}

/** A pop-up as a use quotes it: its header's title, or "a pop-up". */
function specSays(spec: PopupSpecT): string {
  const head = spec.blocks.find((b) => b.type === "header");
  return head?.type === "header" ? `"${clipUse(head.title.text)}"` : "a pop-up";
}

/** A use's quote of an offer, cut to 60 characters. */
function clipUse(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 59)}…`;
}

/** Whether a field is the pop-up's trigger or one of the fields it fills. */
function inFillForm(p: GroundedProposal, windowId: string, key: string): boolean {
  // A field the pop-up leaves to the user is part of the form too: setting it first keeps the offer (D2-04).
  return windowId === p.windowId && (key === p.triggerKey || p.fields.some((f) => f.key === key) || p.yours.some((y) => y.key === key));
}

/** A zod issue path as a JSON path: ["spec", "blocks", 2, "rows", 0] is spec.blocks[2].rows[0]. */
function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "the message";
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join("");
}

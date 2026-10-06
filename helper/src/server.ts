// Unix socket server. Every client's first line is a hello naming its role. The reader then
// streams ReaderMessages and receives the executor's readerCommands; consumers send fill requests,
// plans, task controls and the host's offerAccept and offerStop, and receive every HelperMessage.
// Invalid lines are answered with an error message and counted, never silently dropped.
//
// B23 (CodeRabbit on PR #4): the reader authenticates the helper before it sends a snapshot or acts on a line.
// Its hello carries a challenge; the helper answers helperAuth, an HMAC of it under the launch secret both got
// on an inherited descriptor (src/launch.ts). The socket's directory is the user's own, mode 0700.
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { ASK_CHOICES_CAPABILITY, ConsumerMessage, FILL_ALL_CAPABILITY, GOAL_FILES_CAPABILITY, GOAL_PLANS_CAPABILITY, Hello, LOCAL_MODEL_CAPABILITY, MEMORY_DOCUMENTS_CAPABILITY, PROTOCOL_VERSION, ReaderMessage, ROUTING_CAPABILITY, type ActRevoke, type HelperAuth, type HelperMessage, type HelperToReader, type LocalTextRequest, type MemoryReply, SAVED_ANSWERS_CAPABILITY, type AnswerSaveReply, type MemoryDocumentReply } from "./protocol.ts";
import { carriesAnswer, withoutAnswers } from "./offers/answer-gate.ts";
import type { Helper } from "./helper.ts";
import type { HostLocalModel } from "./writer/local-port.ts";
import { planError } from "./planner/proposal.ts";

/** One line may carry a whole window; a longer line is a reader bug, not a bigger window. */
const MAX_LINE_CHARS = 32 * 1024 * 1024;

export class HelperServer {
  private readonly consumers = new Set<Socket>();
  /** Consumers whose hello named MEMORY_DOCUMENTS_CAPABILITY (M1). The others never see `noticed` or the new memory messages. */
  private readonly memoryDocuments = new Set<Socket>();
  /** Host connections whose hello declared ROUTING_CAPABILITY: they get routeDecision and may send routingContext. */
  private readonly routing = new Set<Socket>();
  /** Consumers whose hello said host: true. Only they speak for the user where a record becomes consent (routing/consent.ts). */
  private readonly hosts = new Set<Socket>();
  /** Host connections whose hello listed FILL_ALL_CAPABILITY: only they may send fillAll (D2-04). */
  private readonly fillAll = new Set<Socket>();
  /** Consumer connections whose hello listed ASK_CHOICES_CAPABILITY: they get Ask questions and may answer them (B29). */
  private readonly askChoices = new Set<Socket>();
  /** Host connections whose hello listed GOAL_PLANS_CAPABILITY: only they may plan and accept goals, and only they get goalProgress (D2-06). */
  private readonly goalPlans = new Set<Socket>();
  /** P3: goal-planning hosts whose hello also listed GOAL_FILES_CAPABILITY: they show attach rows, send confirmedFile and fileSave, and get fileSaveOffer. */
  private readonly goalFiles = new Set<Socket>();
  /** The most recent host whose hello listed LOCAL_MODEL_CAPABILITY: localTextRequest goes there, and only its replies count (L1). */
  private localModelHost: Socket | null = null;
  /** The local model's requests waiting on that host; null when the helper was started without one. */
  private readonly localModel: HostLocalModel | null;
  /**
   * Host connections whose hello listed SAVED_ANSWERS_CAPABILITY (S1): the only ones sent a saved answer (a fill value
   * from one, a pop-up that writes one, an offer to save one, answers.md in the memory window) and the only ones whose
   * answerSave is the user's consent. A host that has not said it shows an answer whole never gets one to insert.
   */
  private readonly savedAnswers = new Set<Socket>();
  /** The most recent reader connection; commands go there. */
  private reader: Socket | null = null;
  /**
   * Tasks holding a grant on the current reader connection. When another reader says hello, the old
   * connection stays open, so its grants are revoked there: a command still queued in the old reader
   * must not act after the helper has moved on to a new session.
   */
  private granted = new Set<string>();
  private readonly sockets = new Set<Socket>();
  /** Numbers each consumer connection's host session (Helper.hostConnected). */
  private sessions = 0;
  private server: Server | null = null;
  private readonly helper: () => Helper;
  private readonly path: string;
  private readonly warn: (line: string) => void;
  /** The launch secret the reader's challenge is answered with; null answers none, so an authenticating reader refuses this helper. */
  private readonly secret: Buffer | null;

  constructor(path: string, helper: () => Helper, warn: (line: string) => void, secret: Buffer | null = null, localModel: HostLocalModel | null = null) {
    this.path = path;
    this.helper = helper;
    this.warn = warn;
    this.secret = secret;
    this.localModel = localModel;
  }

  /** A local text request, to the host that runs the local model only; false when none is connected. */
  sendLocalText(m: LocalTextRequest): boolean {
    const host = this.localModelHost;
    if (host === null || host.destroyed) return false;
    host.write(JSON.stringify(m) + "\n");
    return true;
  }

  /** Commands, act grants and revokes go to the reader only; no consumer ever receives one. */
  sendToReader(m: HelperToReader): boolean {
    if (this.reader === null || this.reader.destroyed) return false;
    this.reader.write(JSON.stringify(m) + "\n");
    // An act grant and a calendar grant both end with the task's one actRevoke.
    if (m.type === "actGrant" || m.type === "calendarGrant") this.granted.add(m.taskId);
    else if (m.type === "actRevoke") this.granted.delete(m.taskId);
    return true;
  }

  /** Ends every grant the outgoing reader holds, on its own connection, before a new reader takes over. */
  private revokeOnOldReader(old: Socket | null): void {
    if (old !== null && !old.destroyed) {
      for (const taskId of this.granted) old.write(JSON.stringify({ type: "actRevoke", v: PROTOCOL_VERSION, taskId, at: Date.now() } satisfies ActRevoke) + "\n");
    }
    this.granted = new Set();
  }

  publish(m: HelperMessage): void {
    const line = JSON.stringify(m) + "\n";
    // Provenance is new in M1: a consumer that did not ask for it is not sent it.
    // A goal's previews and progress quote values and name windows: only hosts that plan goals get them.
    // A saved answer goes only to a host that shows it whole (S1); any other consumer gets a fill proposal without it.
    if (carriesAnswer(m, (id) => this.helper().writesAnswer(id))) {
      for (const c of this.savedAnswers) c.write(line);
      if (m.type !== "fillProposal") return;
      const stripped = JSON.stringify(withoutAnswers(m)) + "\n";
      for (const c of this.consumers) if (!this.savedAnswers.has(c)) c.write(stripped);
      return;
    }
    // P3: an offer to keep a file names the file, and only a host that shows attach rows may answer it; a preview with an
    // attach row goes only to such hosts too (a host without the capability could not show the row, nor decode it).
    const files = m.type === "fileSaveOffer" || (m.type === "goalProgress" && m.event === "segment" && m.steps.some((x) => x.kind === "attach"));
    for (const c of files ? this.goalFiles : m.type === "memoryProvenance" ? this.memoryDocuments : m.type === "routeDecision" ? this.routing : m.type === "goalProgress" ? this.goalPlans : this.consumers) c.write(line);
  }

  async listen(): Promise<void> {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The directory must be the user's own and closed to others: the reader refuses a socket in any other (B23).
    const st = lstatSync(dir);
    if (!st.isDirectory() || (process.getuid !== undefined && st.uid !== process.getuid())) throw new Error(`the socket directory ${dir} is not a directory this user owns; refusing to listen there`);
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    if (existsSync(this.path)) {
      if (await isAlive(this.path)) throw new Error(`another helper is already listening on ${this.path}`);
      unlinkSync(this.path);
    }
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => resolve());
    });
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    // Every connection, readers included: server.close() waits for all of them to end.
    for (const c of this.sockets) c.destroy();
    await new Promise<void>((r) => (this.server === null ? r() : this.server.close(() => r())));
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  private accept(s: Socket): void {
    this.sockets.add(s);
    let role: "reader" | "consumer" | null = null;
    /** This consumer's host session: the work it accepts is bound to it and revoked when it closes (S1 audit #5). */
    let session: string | null = null;
    let replaced = false;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_CHARS) {
        this.reject(s, `line over ${MAX_LINE_CHARS} characters; closing`);
        s.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          this.reject(s, "invalid JSON line");
          continue;
        }
        if (role === null) {
          const hello = Hello.safeParse(json);
          if (!hello.success) {
            this.reject(s, `first message must be hello: ${hello.error.message}`);
            s.destroy();
            return;
          }
          role = hello.data.role;
          if (role === "consumer") {
            this.consumers.add(s);
            if (hello.data.capabilities?.includes(MEMORY_DOCUMENTS_CAPABILITY) === true) this.memoryDocuments.add(s);
            session = `consumer-${++this.sessions}`;
            // Only the host's hello says so; any other consumer binds its own work but never counts as the host (B23).
            // Routing is the host's: a decision tells its writing help when it may run, so only the host may take one.
            const routing = hello.data.host === true && hello.data.capabilities?.includes(ROUTING_CAPABILITY) === true;
            if (routing) this.routing.add(s);
            if (hello.data.host === true) this.hosts.add(s);
            if (hello.data.host === true && hello.data.capabilities?.includes(FILL_ALL_CAPABILITY) === true) this.fillAll.add(s);
            if (hello.data.capabilities?.includes(ASK_CHOICES_CAPABILITY) === true) this.askChoices.add(s);
            if (hello.data.host === true && hello.data.capabilities?.includes(GOAL_PLANS_CAPABILITY) === true) this.goalPlans.add(s);
            const files = hello.data.host === true && hello.data.capabilities?.includes(GOAL_PLANS_CAPABILITY) === true && hello.data.capabilities.includes(GOAL_FILES_CAPABILITY);
            if (files) this.goalFiles.add(s);
            if (hello.data.host === true && hello.data.capabilities?.includes(LOCAL_MODEL_CAPABILITY) === true) this.localModelHost = s;
            if (hello.data.host === true && hello.data.capabilities?.includes(SAVED_ANSWERS_CAPABILITY) === true) {
              this.savedAnswers.add(s);
              this.helper().setAnswerHosts(this.savedAnswers.size);
            }
            if (hello.data.host === true) this.helper().hostConnected(session, routing, files);
            else this.helper().consumerConnected(session);
          } else {
            // The proof goes first, before any command or grant this connection could carry.
            if (hello.data.challenge !== undefined) {
              if (this.secret === null) {
                this.reject(s, "the reader asked the helper to prove itself, and this helper was started without a launch secret (--auth-fd)");
                s.destroy();
                return;
              }
              s.write(JSON.stringify({ type: "helperAuth", v: PROTOCOL_VERSION, proof: helperProof(this.secret, hello.data.challenge, process.pid), pid: process.pid } satisfies HelperAuth) + "\n");
            }
            this.revokeOnOldReader(this.reader);
            this.reader = s;
            void this.helper().handleReader(hello.data);
          }
          continue;
        }
        if (role === "reader") {
          // A reader another reader replaced numbers windows from its own session: its snapshots and
          // answers would describe windows under ids the current reader may give to others.
          if (s !== this.reader) {
            if (!replaced) this.reject(s, "another reader has connected since; this connection's messages are ignored");
            replaced = true;
            continue;
          }
          const m = ReaderMessage.safeParse(json);
          if (!m.success) {
            this.reject(s, `invalid reader message: ${m.error.message.slice(0, 500)}`);
            continue;
          }
          void this.helper().handleReader(m.data);
        } else {
          const m = ConsumerMessage.safeParse(json);
          if (!m.success) {
            this.reject(s, `invalid consumer message: ${m.error.message.slice(0, 500)}`);
            continue;
          }
          const from = session ?? undefined;
          if (m.data.type === "fillRequest") void this.helper().handleConsumer(m.data);
          else if (m.data.type === "runPlan" || m.data.type === "taskControl") void this.helper().handleTask(m.data, from);
          else if (m.data.type === "offerControl") void this.helper().handleOffer(m.data, from);
          // The work an accept starts reports as taskProgress and activity under the offer id; a refusal as error plus a stopped taskProgress.
          else if (m.data.type === "offerAccept") void this.helper().handleOfferAccept(m.data, from);
          else if (m.data.type === "offerStop") void this.helper().handleOfferStop(m.data);
          // Command-1 on a per-field fill proposal: the whole form in one transaction, reported as an offerAccept's run is.
          else if (m.data.type === "fillAll") {
            if (!this.fillAll.has(s)) this.reject(s, `fillAll needs a host hello with "${FILL_ALL_CAPABILITY}" in its capabilities`);
            else void this.helper().handleFillAll(m.data, from);
          }
          // D2-06: a goal plan's request (answered to the asker only) and each segment's acceptance, from a goal-planning host only.
          else if (m.data.type === "goalRequest" || m.data.type === "goalAccept") {
            if (!this.goalPlans.has(s)) {
              this.reject(s, `${m.data.type} needs a host hello with "${GOAL_PLANS_CAPABILITY}" in its capabilities`);
              continue;
            }
            // P3: a file comes only from a host that shows attach rows, where the user chose or saw it.
            if (m.data.type === "goalAccept" && m.data.confirmedFile !== undefined && !this.goalFiles.has(s)) {
              this.reject(s, `goalAccept.confirmedFile needs a host hello with "${GOAL_FILES_CAPABILITY}" in its capabilities`);
              continue;
            }
            if (m.data.type === "goalAccept") void this.helper().handleGoalAccept(m.data, from, (e) => void (!s.destroyed && s.write(JSON.stringify(e) + "\n")));
            else {
              const requestId = m.data.requestId;
              void this.helper()
                .handleGoalRequest(m.data, from)
                .catch((e: unknown) => {
                  this.warn(`goal ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
                  return this.helper().goals.refused(`goal-failed-${requestId}`.slice(0, 200), requestId, "The planner failed; the helper logged why");
                })
                .then((r) => {
                  if (!s.destroyed) s.write(JSON.stringify(r) + "\n");
                });
            }
          }
          // L1: the local model's answers come only from the host it was asked of.
          else if (m.data.type === "localTextReply") {
            if (s !== this.localModelHost) this.reject(s, `localTextReply needs a host hello with "${LOCAL_MODEL_CAPABILITY}" in its capabilities`);
            else if (this.localModel?.reply(m.data) !== true) this.warn(`localTextReply ${m.data.id}: no request waits for it`);
          }
          else if (m.data.type === "fillResult") this.helper().handleFillResult(m.data);
          // S1: the user's yes to saving an answer. Only a host that shows answers whole speaks for the user here.
          else if (m.data.type === "answerSave") {
            if (!this.savedAnswers.has(s)) this.reject(s, `answerSave needs a host hello with "${SAVED_ANSWERS_CAPABILITY}" in its capabilities`);
            else {
              const requestId = m.data.requestId;
              void this.helper()
                .handleAnswerSave(m.data)
                .catch((e: unknown): AnswerSaveReply => {
                  this.warn(`answerSave ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
                  return { type: "answerSaveReply", v: PROTOCOL_VERSION, requestId, outcome: "refused", answerId: null, why: "unavailable", says: "Caret couldn't save the answer; nothing was saved." };
                })
                .then((r) => {
                  if (!s.destroyed) s.write(JSON.stringify(r) + "\n");
                });
            }
          }
          // P3: the user's yes to keeping a file they attached, from a host that showed the offer.
          else if (m.data.type === "fileSave") {
            if (!this.goalFiles.has(s)) this.reject(s, `fileSave needs a host hello with "${GOAL_FILES_CAPABILITY}" in its capabilities`);
            else {
              const reply = this.helper().handleFileSave(m.data, from);
              if (!s.destroyed) s.write(JSON.stringify(reply) + "\n");
            }
          }
          else if (m.data.type === "settings") this.helper().handleSettings(m.data, from);
          // The user's Keep makes a skill, which is consent the router acts on (routing/consent.ts): only the host,
          // which shows the question, may answer it.
          else if (m.data.type === "skillAnswer") {
            if (!this.hosts.has(s)) this.reject(s, "skillAnswer needs a host hello (host: true): only the host shows keep and promote questions");
            else this.helper().handleSkillAnswer(m.data);
          }
          // The reply names windows and quotes values, so it goes to the asker only, as memory does.
          else if (m.data.type === "firstLook") {
            const requestId = m.data.requestId;
            void this.helper()
              .handleFirstLook(m.data)
              .catch((e: unknown) => {
                this.warn(`first look ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
                return { type: "firstLookReply", v: PROTOCOL_VERSION, requestId, at: Date.now(), outcome: "error", found: null, scanned: null, error: "the look failed" } as const;
              })
              .then((r) => {
                if (!s.destroyed) s.write(JSON.stringify(r) + "\n");
              });
          }
          // A proposal quotes values and names windows, so it goes to the asker only, as a first look's reply does.
          // An askQuestion and an askAnswer's reply go to the asker only too (B29); only a consumer that declared it can
          // answer a question gets one, and only it may answer.
          else if (m.data.type === "planRequest" || m.data.type === "askAnswer") {
            const msg = m.data;
            const requestId = msg.requestId;
            if (msg.type === "askAnswer" && !this.askChoices.has(s)) {
              this.reject(s, `askAnswer needs "${ASK_CHOICES_CAPABILITY}" in the consumer's hello capabilities`);
              continue;
            }
            const canAsk = this.askChoices.has(s);
            // B30: an Ask from a host that runs goal plans is answered with a goal's preview when its route is plan.
            const canGoal = this.goalPlans.has(s);
            void (msg.type === "planRequest" ? this.helper().handlePlanRequest(msg, from, canAsk, canGoal) : this.helper().handleAskAnswer(msg, from, canGoal))
              .catch((e: unknown) => {
                this.warn(`plan ${requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
                return planError(requestId, "internal", "the planner failed; the helper logged why", Date.now());
              })
              .then((r) => {
                if (s.destroyed) return;
                s.write(JSON.stringify(r) + "\n");
                // The noticed facts the plan used, to the asker too, when it understands them.
                const p = r.type === "planProposal" && r.outcome === "proposed" && this.memoryDocuments.has(s) ? this.helper().provenanceFor(r.offerKey) : null;
                if (p !== null) s.write(JSON.stringify(p) + "\n");
              });
          }
          // Records hold window titles and status lines, so a list goes to the asker only, as memory does.
          else if (m.data.type === "activityRequest") {
            // A task that writes a saved answer is listed only to a host that shows answers (S1): its records quote it.
            const r = this.helper().handleActivity(m.data);
            const hide = (id: string): boolean => !this.savedAnswers.has(s) && this.helper().writesAnswer(id);
            s.write(JSON.stringify({ ...r, tasks: r.tasks.filter((t) => !hide(t.id)), events: r.events.filter((e) => !hide(e.task.id)) }) + "\n");
          }
          else if (m.data.type === "memoryRequest") {
            // Resuming a paused skill brings back the consent it rests on; only the host's resume is the user's.
            if (m.data.op === "resume" && !this.hosts.has(s) && this.helper().resumeRestoresConsent(m.data.id)) {
              s.write(JSON.stringify({ type: "memoryReply", v: PROTOCOL_VERSION, requestId: m.data.requestId, error: "resume needs a host hello (host: true): a paused skill comes back only from you", entries: [] }) + "\n");
              continue;
            }
            // A bad request is answered in the reply; this catches only a failure of the store itself.
            try {
              s.write(JSON.stringify(this.forConsumer(s, this.helper().handleMemory(m.data))) + "\n");
            } catch (e) {
              this.reject(s, `memory request ${m.data.requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else if (m.data.type === "routingContext") {
            // Refused by name for a connection that is not a host that declared it takes route decisions.
            if (!this.routing.has(s)) this.reject(s, `routingContext needs a host hello with "${ROUTING_CAPABILITY}" in its capabilities`);
            else this.helper().handleRoutingContext(m.data);
          } else if (m.data.type === "memoryNotRight" || m.data.type === "memoryDocumentRequest") {
            // Refused by name, not half-handled, for a consumer that did not say it understands markdown memory.
            if (!this.memoryDocuments.has(s)) {
              this.reject(s, `${m.data.type} needs "${MEMORY_DOCUMENTS_CAPABILITY}" in the consumer's hello capabilities`);
              continue;
            }
            // answers.md is new in S1: a host that did not ask for saved answers neither sees it listed nor reads it.
            if (m.data.type === "memoryDocumentRequest" && m.data.doc === "answers" && !this.savedAnswers.has(s)) {
              this.reject(s, `the answers document needs "${SAVED_ANSWERS_CAPABILITY}" in the consumer's hello capabilities`);
              continue;
            }
            try {
              const reply = m.data.type === "memoryNotRight" ? this.helper().handleMemoryNotRight(m.data) : this.forAnswers(s, this.helper().handleMemoryDocument(m.data, this.hosts.has(s)));
              s.write(JSON.stringify(reply) + "\n");
            } catch (e) {
              this.reject(s, `${m.data.type} ${m.data.requestId} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }
    });
    s.on("close", () => {
      this.consumers.delete(s);
      this.memoryDocuments.delete(s);
      this.routing.delete(s);
      this.hosts.delete(s);
      this.fillAll.delete(s);
      this.askChoices.delete(s);
      this.goalPlans.delete(s);
      this.goalFiles.delete(s);
      if (this.localModelHost === s) {
        this.localModelHost = null;
        this.localModel?.hostGone();
      }
      if (this.savedAnswers.delete(s)) this.helper().setAnswerHosts(this.savedAnswers.size);
      if (session !== null) this.helper().hostDisconnected(session);
      if (this.reader === s) {
        this.reader = null;
        // The reader drops its grants when its connection closes.
        this.granted = new Set();
        this.helper().readerClosed();
      }
      this.sockets.delete(s);
    });
    s.on("error", (e) => this.warn(`socket error: ${e.message}`));
  }

  /**
   * A memory reply as this consumer can read it: one without MEMORY_DOCUMENTS_CAPABILITY gets a noticed entry as
   * active and no `noticed` key, the shape it knew before M1.
   */
  private forConsumer(s: Socket, r: MemoryReply): MemoryReply {
    if (this.memoryDocuments.has(s)) return r;
    return {
      ...r,
      entries: r.entries.map((e) => {
        if (e.kind !== "about" && e.kind !== "people" && e.kind !== "preference") return e;
        const { noticed: _n, ...rest } = e;
        return { ...rest, status: e.status === "noticed" ? "active" : e.status } as typeof e;
      }),
    };
  }

  /**
   * A document reply as this consumer can read it: a host before S1 refuses any document id it does not know, which
   * would lose it the whole list, so answers.md is left out for a consumer without SAVED_ANSWERS_CAPABILITY.
   */
  private forAnswers(s: Socket, r: MemoryDocumentReply): MemoryDocumentReply {
    if (this.savedAnswers.has(s)) return r;
    return { ...r, documents: r.documents.filter((d) => d.doc !== "answers") };
  }

  private reject(s: Socket, message: string): void {
    this.warn(message);
    s.write(JSON.stringify({ type: "error", v: PROTOCOL_VERSION, at: Date.now(), message }) + "\n");
  }
}

/**
 * The helper's answer to a reader's challenge: base64 HMAC-SHA256 under the launch secret, bound to the helper's pid,
 * which the reader checks against its socket's peer (Emitter.swift), so a relayed proof does not pass.
 */
export function helperProof(secret: Buffer, challenge: string, pid: number): string {
  return createHmac("sha256", secret).update(`caret-helper-proof\n${challenge}\n${pid}`).digest("base64");
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

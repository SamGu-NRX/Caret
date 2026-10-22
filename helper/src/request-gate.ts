// Who may send what on the helper's socket, the inbound half of send-gate.ts. Every consumer line the server accepts
// is looked up here before any work: a request from a role it does not allow is refused with an error line naming why,
// and the refusal is logged. Any same-user process can connect, so only the proven host (host-auth.ts) may make Caret
// act, change what it may do, or be answered with anything derived from the screen or the user's data.
import type { ConsumerMessage } from "./protocol.ts";
import type { SessionRole } from "./send-gate.ts";

/**
 * Who may send a consumer message. `any`: every consumer, for the handshake and for requests that only take trust
 * away. `host`: the proven host only; `because` completes the refusal "<type> needs a host hello (host: true): ".
 */
export type RequestRule = { readonly from: "any" } | { readonly from: "host"; readonly because: string };

const ANY: RequestRule = { from: "any" };
const host = (because: string): RequestRule => ({ from: "host", because });
const MEMORY = host("memory holds what Caret knows about you");
const ASK = host("a plan's proposal or question quotes values and names windows");
const GOAL = host("a goal reads your windows and makes Caret act");

/** Every type a consumer can send, and who may send it. A type missing here fails typecheck and test/request-gate.test.ts. */
export const REQUEST_RULE: { readonly [K in ConsumerMessage["type"]]: RequestRule } = {
  // The opening line; server.ts refuses a second one.
  hello: ANY,
  // Answers this connection's own challenge; server.ts refuses one with no challenge outstanding.
  hostProof: ANY,
  // Clears the owner verdicts given in the host's session (HA2): it only takes trust away.
  sessionLocked: ANY,

  // What makes Caret act, or changes what it may do.
  runPlan: host("a plan writes into your apps"),
  taskControl: host("it pauses, resumes, stops or undoes Caret's work for you"),
  offerAccept: host("accepting an offer makes Caret act"),
  offerStop: host("it stops or undoes what an offer did for you"),
  offerControl: host("it answers an offer for you"),
  settings: host("settings decide what Caret may do"),
  fillResult: host("it tells Caret what went into your fields, which Caret learns from and undoes"),
  fillAll: host("it fills a whole form"),
  goalRequest: GOAL,
  goalAccept: GOAL,
  goalEdit: GOAL,
  pageInsert: host("it writes into a page field"),
  skillAnswer: host("only the host shows keep and promote questions"),
  answerSave: host("saving an answer is your consent"),
  fileSave: host("keeping a file is your consent"),
  routingContext: host("only the host takes route decisions"),
  localTextReply: host("only the host runs the local model"),

  // Answered only with host messages (send-gate.ts), so refused before the work, which can call Jev.
  screenTextRequest: host("screen text is derived from the reader's model"),
  screenTextReply: host("screen text replies are reserved for the helper's response path"),
  fillRequest: host("a fillProposal quotes values and labels from the screen"),
  planRequest: ASK,
  askAnswer: ASK,
  firstLook: host("a first look's offer names a window and quotes its values"),
  firstLookPreviewRequest: host("only the host shows the preview as consent"),
  memoryRequest: MEMORY,
  memoryNotRight: MEMORY,
  memoryDocumentRequest: MEMORY,
  activityRequest: host("activity records hold window titles and status lines"),
  fileConfirm: host("the reply names the file you chose and its path"),
  savedFilesRequest: host("the list names your files and their paths"),
};

/** A type's rule. Throws for a type the table does not list: who may send it is undecided, so nobody may. */
export function ruleOf(type: string): RequestRule {
  if (!Object.hasOwn(REQUEST_RULE, type)) throw new Error(`consumer message type ${JSON.stringify(type)} has no rule in REQUEST_RULE (src/request-gate.ts), so the helper cannot tell who may send it`);
  return REQUEST_RULE[type as ConsumerMessage["type"]];
}

/** Null when a connection in `role` may send a message of `type`; otherwise the refusal it is sent and the log keeps. */
export function refusedBecause(role: SessionRole, type: string): string | null {
  const rule = ruleOf(type);
  if (rule.from === "any" || role === "host") return null;
  return `${type} needs a host hello (host: true): ${rule.because}`;
}

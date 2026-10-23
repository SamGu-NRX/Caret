// Who may be sent what on the helper's socket. Every line the server writes to a connection goes through
// HelperServer.send, which looks the message's type up here and refuses, with a log line naming why, a message the
// connection's role may not receive. Any same-user process can connect to the socket, so a consumer that has not proven
// the launch secret's host key (host-auth.ts) gets only status: nothing derived from the screen or the user's data.
import type { HelperMessage, HelperToReader } from "./protocol.ts";

/**
 * Who a connection has shown itself to be.
 * - host: a consumer whose hostProof checked out (host-auth.ts).
 * - reader: a connection whose hello said role "reader". The reader checks the helper's proof (helperAuth); the helper
 *   has no proof of the reader, so this role is claimed, not proven.
 * - other: any other connection, including a host hello still waiting on its proof and one that has not said hello.
 */
export type SessionRole = "host" | "reader" | "other";

/**
 * What a message reveals, which decides who may be sent it.
 * - status: health without text: protocol versions, the host handshake, counters, and the server's refusal of a line
 *   the connection itself sent.
 * - reader: the reader's commands, act and calendar grants, and the helper's proof to it.
 * - host: anything derived from the screen or the user's data, and any free text the helper cannot vouch for.
 */
export type MessageClass = "status" | "reader" | "host";

/**
 * The server's refusal of a line a connection sent. It goes out as an `error` line, and its text is fixed wording plus
 * what that line held, never the screen's. It has its own type here because the helper's published `error` is free text
 * (a task's failure, a fill's) and goes only to the host.
 */
export interface Refusal {
  type: "refusal";
  message: string;
}

export type Outgoing = HelperMessage | HelperToReader | Refusal;

/** Every type the server sends, and its class. A type missing here fails typecheck and test/send-gate.test.ts. */
export const MESSAGE_CLASS: { readonly [K in Outgoing["type"]]: MessageClass } = {
  refusal: "status",
  hostChallenge: "status",
  hostAuthenticated: "status",
  // Calls, failures, tokens and cost of model use: counters without text.
  spend: "status",

  readerCommand: "reader",
  actGrant: "reader",
  actRevoke: "reader",
  calendarGrant: "reader",
  helperAuth: "reader",

  fillProposal: "host",
  error: "host",
  taskProgress: "host",
  patternOffer: "host",
  offerWithdrawn: "host",
  memoryReply: "host",
  activity: "host",
  activityReply: "host",
  alternatives: "host",
  action: "host",
  popup: "host",
  firstLookReply: "host",
  firstLookPreview: "host",
  planProposal: "host",
  skillOffer: "host",
  // Names the browser the user is in and says whether they typed there: what the user does, not the helper's health.
  pageEngine: "host",
  memoryProvenance: "host",
  memoryDocumentReply: "host",
  routeDecision: "host",
  fileConfirmReply: "host",
  askQuestion: "host",
  goalProgress: "host",
  pageField: "host",
  localTextRequest: "host",
  answerSaveOffer: "host",
  answerSaveReply: "host",
  fileSaveOffer: "host",
  fileSaveReply: "host",
  pageInsertReply: "host",
  savedFilesReply: "host",
  screenTextReply: "host",
  screenTextRevision: "host",
};

const RECEIVES: { readonly [R in SessionRole]: ReadonlySet<MessageClass> } = {
  host: new Set(["status", "host"]),
  reader: new Set(["status", "reader"]),
  other: new Set(["status"]),
};

/** A type's class. Throws for a type the table does not list: who may receive it is undecided, so nobody is sent it. */
export function classOf(type: string): MessageClass {
  if (!Object.hasOwn(MESSAGE_CLASS, type)) throw new Error(`message type ${JSON.stringify(type)} has no class in MESSAGE_CLASS (src/send-gate.ts), so the helper cannot tell who may be sent it`);
  return MESSAGE_CLASS[type as Outgoing["type"]];
}

/** Null when a connection in `role` may be sent a message of `type`; otherwise why not, for the log. */
export function withheldBecause(role: SessionRole, type: string): string | null {
  const cls = classOf(type);
  if (RECEIVES[role].has(cls)) return null;
  if (cls === "host") return `${type} is derived from the screen or the user's data, and only a host whose proof checked out is sent that`;
  if (cls === "reader") return `${type} is the reader's, and this connection is not the reader`;
  return `a ${role} connection is not sent ${cls} messages`;
}

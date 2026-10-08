import type { PageVerb, ToHelper } from "../src/shared/messages.ts";
import type { FromHelper } from "../src/worker/wire.ts";

const target = { tabId: 3, frameId: 0, documentId: "fixture-document", id: "field-1", control: "text" as const, name: "First name", taskId: "fixture-task" };
export const verbs = [
  { kind: "pageWalk", tabId: 3 },
  { kind: "pageWrite", ...target, expect: "", value: "Ada" },
  { kind: "pagePress", ...target },
  { kind: "pageSelect", ...target, expect: "", value: "A" },
  { kind: "pageChooseOption", ...target, expect: "", value: "A", question: "Choose a letter" },
  { kind: "pageSetChecked", ...target, checked: true },
  { kind: "pageAttachFile", ...target, file: { name: "fixture.txt", type: "text/plain", size: 1, sha256: "a".repeat(64), data: "QQ==" } },
  { kind: "pageInsertText", ...target, expect: "Hello ", text: "Ada" },
] satisfies PageVerb[];

export const incoming = [
  { type: "engineReady", v: 1, engine: "fixture-engine" },
  { type: "pageCommand", v: 1, id: "fixture-command", expires: 1000, verb: verbs[0]! },
  { type: "scopedActGrant", v: 1, taskId: "fixture-task", at: 10, expires: 1000, scope: { kind: "page", engine: "fixture-engine", tabId: 3, frameId: 0, origin: "https://fixture.invalid", navGen: 1 } },
  { type: "actRevoke", v: 1, taskId: "fixture-task", at: 20 },
  { type: "pagePing", v: 1, id: "fixture-ping" },
  { type: "pageChunk", v: 1, id: "fixture-chunks", index: 0, count: 2, data: "e30=" },
  { type: "pageSitesOff", v: 1, origins: ["https://fixture.invalid"] },
  { type: "pageReadText", v: 1, id: "fixture-read", expires: 1000, tabId: 3 },
] satisfies (FromHelper & { v: 1; at?: number })[];

export const outgoing = [
  { type: "pageHello", v: 1, extensionId: "fixture-extension", version: "0.1.0", profile: "fixture-profile", instance: "fixture-instance", startedAt: 10, capabilities: ["pageWalk"] },
  { type: "pagePong", v: 1, id: "fixture-ping", at: 20, instance: "fixture-instance", startedAt: 10 },
  { type: "pageFocus", v: 1, at: 20, tabId: 3, frameId: 0 },
  { type: "pageInput", v: 1, at: 20, tabId: 3, frameId: 0, kind: "key" },
  { type: "pageResult", v: 1, id: "fixture-command", at: 20, outcome: "ok", detail: null,
    readings: { before: "", afterInput: "Ada", afterBlur: "Ada", invalid: false, error: null },
    choice: { flavor: "aria", matches: ["Ada"], expanded: false, hiddenInput: "set" },
    attached: { via: "input", file: { name: "fixture.txt", size: 1 }, shown: true },
    text: { tabId: 3, leftAt: 10, title: "Fixture", frames: [{ frameId: 0, origin: "https://fixture.invalid" }], selection: ["Synthetic"], blocks: ["Fixture text"], cut: false, docsText: null } },
  { type: "pageSnapshot", v: 1, id: "fixture-command", at: 20, tabId: 3, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Fixture",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "fixture-document", origin: "https://fixture.invalid", path: "/", navGen: 1, title: "Fixture", headings: ["Synthetic form"],
      controls: [{ id: "field-1", key: "fixture-key", strongKey: null, kind: "text", role: "textbox", name: "First name", value: "Ada", checked: false,
        options: [{ value: "Ada", label: "Ada", selected: true }], form: null, rect: [0, 0, 100, 20], required: true, disabled: true, invalid: true, shadow: "open", group: { id: "fixture-group", name: "Name" }, pressed: false }],
      iframes: [{ src: "https://fixture.invalid/frame", rect: [0, 20, 100, 100] }], excluded: { password: 1 }, truncated: false }],
    missing: [{ frameId: 4, reason: "fixture missing frame" }], focused: { frameId: 0, id: "field-1", selection: [0, 3] } },
] satisfies ToHelper[];

export const examples = [...incoming, ...outgoing, ...verbs.slice(1).map((verb) => ({ type: "pageCommand" as const, v: 1 as const, id: `fixture-${verb.kind}`, expires: 1000, verb }))];

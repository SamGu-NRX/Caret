import type { ToHelper } from "./messages.ts";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string";
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const integer = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const bool = (v: unknown): v is boolean => typeof v === "boolean";
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(string);
const nullableString = (v: unknown): boolean => v === null || string(v);
const tuple = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(number);
const optional = (o: ObjectValue, key: string, test: (v: unknown) => boolean): boolean => o[key] === undefined || test(o[key]);
const array = (v: unknown, test: (v: unknown) => boolean): boolean => Array.isArray(v) && v.every(test);
const controlKinds = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea", "select", "checkbox", "radio", "combobox", "button", "link", "file", "contenteditable", "range", "color"]);
const outcomes = new Set(["ok", "alreadyTrue", "notAllowed", "stale", "failed", "handoff", "noElement", "notSameElement", "excluded", "unsupported", "error", "siteOff"]);

function control(v: unknown): boolean {
  return object(v) && string(v.id) && string(v.key) && nullableString(v.strongKey) && string(v.kind) && controlKinds.has(v.kind)
    && string(v.role) && string(v.name) && nullableString(v.form) && tuple(v.rect, 4)
    && optional(v, "value", string) && optional(v, "checked", bool)
    && optional(v, "options", (x) => array(x, (o) => object(o) && string(o.value) && string(o.label) && bool(o.selected)))
    && ["required", "disabled", "invalid", "numeric"].every((k) => optional(v, k, (x) => x === true))
    && optional(v, "shadow", (x) => x === "open" || x === "closed")
    && optional(v, "group", (x) => object(x) && string(x.id) && string(x.name)) && optional(v, "pressed", bool)
    && optional(v, "maxLength", integer) && optional(v, "entry", (x) => ["typed", "pasted", "other"].includes(String(x)))
    && optional(v, "accept", strings) && optional(v, "autocomplete", string) && optional(v, "sections", strings)
    && optional(v, "excluded", (x) => ["password", "payment", "oneTimeCode"].includes(String(x)));
}
function frame(v: unknown): boolean {
  return object(v) && integer(v.frameId) && integer(v.parentFrameId) && string(v.documentId) && string(v.origin) && string(v.path)
    && integer(v.navGen) && string(v.title) && strings(v.headings) && array(v.controls, control)
    && array(v.iframes, (x) => object(x) && string(x.src) && tuple(x.rect, 4))
    && object(v.excluded) && Object.values(v.excluded).every(integer) && bool(v.truncated);
}
function tabText(v: unknown): boolean {
  return object(v) && integer(v.tabId) && integer(v.leftAt) && string(v.title)
    && array(v.frames, (x) => object(x) && integer(x.frameId) && string(x.origin)) && strings(v.selection) && strings(v.blocks)
    && bool(v.cut) && (v.docsText === null || v.docsText === "on" || v.docsText === "off");
}
function answer(v: ObjectValue): boolean {
  return string(v.outcome) && outcomes.has(v.outcome) && nullableString(v.detail)
    && optional(v, "text", tabText)
    && optional(v, "readings", (x) => object(x) && string(x.before) && string(x.afterInput) && string(x.afterBlur) && bool(x.invalid) && nullableString(x.error))
    && optional(v, "risk", (x) => ["outbound", "destructive", "money", "system", "unclassified", "submitsForm", "pageScript"].includes(String(x)))
    && optional(v, "choice", (x) => object(x) && ["aria", "reactSelect", "pressGroup"].includes(String(x.flavor)) && strings(x.matches) && (x.expanded === null || bool(x.expanded)) && ["set", "unchanged", "none"].includes(String(x.hiddenInput)))
    && optional(v, "attached", (x) => object(x) && ["input", "drop"].includes(String(x.via)) && bool(x.shown) && (x.file === null || object(x.file) && string(x.file.name) && integer(x.file.size)))
    && optional(v, "pageChanged", (x) => array(x, (s) => ["navigated", "navigationStarted", "documentGone", "beforeunload", "pagehide", "submit"].includes(String(s))))
    && optional(v, "insert", (x) => x === "unchanged" || x === "unverified");
}

/** Check the outgoing wire before Native Messaging. Preserve extension fields not read by the Swift mirror. */
export function parseToHelper(v: unknown): ToHelper | null {
  if (!object(v) || v.v !== 1) return null;
  let valid = false;
  switch (v.type) {
    case "pageHello":
      valid = [v.extensionId, v.version, v.profile, v.instance].every(string) && integer(v.startedAt) && strings(v.capabilities);
      break;
    case "pagePong":
      valid = string(v.id) && integer(v.at) && string(v.instance) && integer(v.startedAt);
      break;
    case "pageFocus":
    case "pageInput":
      valid = integer(v.at) && integer(v.tabId) && integer(v.frameId) && (v.type === "pageFocus" || v.kind === "key" || v.kind === "mouse");
      break;
    case "pageResult":
      valid = string(v.id) && integer(v.at) && answer(v);
      break;
    case "pageSnapshot":
      valid = string(v.id) && integer(v.at) && integer(v.tabId) && integer(v.browserWindowId) && bool(v.active) && bool(v.inFocusedWindow)
        && string(v.title) && array(v.frames, frame) && array(v.missing, (x) => object(x) && integer(x.frameId) && string(x.reason))
        && (v.focused === null || object(v.focused) && integer(v.focused.frameId) && string(v.focused.id) && (v.focused.selection === null || tuple(v.focused.selection, 2)));
      break;
  }
  return valid ? v as ToHelper : null;
}

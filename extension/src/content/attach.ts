// pageAttachFile without the debugger (memo section 2, "File inputs"): the bytes the worker checked become a File in
// a DataTransfer. A file input takes it as input.files, then input and change; any other control gets dragenter,
// dragover and drop carrying it, the way a dropzone receives a dragged file. Verified by input.files[0]'s name and
// size (an input) and by the page now showing the file's name near the control where it did not before (both).
import type { ActAnswer, ActVerb, Attached } from "../shared/messages.ts";
import { composedParent } from "./names.ts";
import { dropEvents, settle, until } from "./dom.ts";

/** How long the page may take to show the file's name. Assumed: an upload widget renders it within a second. */
const SHOWN_WAIT_MS = 1500;

type AttachVerb = Extract<ActVerb, { kind: "pageAttachFile" }>;

/** Base64 to bytes. */
export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Where the page would show the name: the nearest enclosing form section (fieldset, section, a group, the form),
 * else four levels up. The control's own text counts, which is where a dropzone usually shows it.
 */
function shownScope(el: Element): Element {
  let p: Element | null = el;
  for (let i = 0; p !== null && i < 8; i++, p = composedParent(p)) {
    if (p !== el && p.matches("fieldset, section, [role=group], form, li")) return p;
  }
  let q: Element = el;
  for (let i = 0; i < 4; i++) q = composedParent(q) ?? q;
  return q;
}

function occurrences(scope: Element, name: string): number {
  const text = scope.textContent ?? "";
  let n = 0;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + name.length)) n++;
  return n;
}

export async function attachFile(el: Element, verb: AttachVerb, check: () => ActAnswer | null, alive: () => Promise<boolean>): Promise<ActAnswer> {
  const { name, size, type } = verb.file;
  const via: Attached["via"] = el instanceof HTMLInputElement && el.type === "file" ? "input" : "drop";
  const answer = (outcome: ActAnswer["outcome"], detail: string | null, attached?: Attached): ActAnswer => ({ outcome, detail, ...(attached === undefined ? {} : { attached }) });
  if (via === "input") {
    const input = el as HTMLInputElement;
    if (input.disabled) return answer("failed", "the file input is disabled");
    const had = input.files?.[0];
    if (had !== undefined && had.name === name && had.size === size) return answer("alreadyTrue", null, { via, file: { name, size }, shown: true });
  }
  const bytes = fromBase64(verb.file.data);
  if (bytes.length !== size) return answer("error", `the file arrived with ${bytes.length} bytes, not ${size}`);
  const data = new DataTransfer();
  data.items.add(new File([bytes], name, { type, lastModified: Date.now() }));
  const scope = shownScope(el);
  const shownBefore = occurrences(scope, name);

  if (!(await alive())) return answer("notAllowed", "the task's grant ended before the file went in");
  const ready = check();
  if (ready !== null) return ready;
  if (via === "input") {
    const input = el as HTMLInputElement;
    input.files = data.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    dropEvents(el, data);
  }
  await settle();
  const shown = (await until(() => (occurrences(scope, name) > shownBefore ? true : null), SHOWN_WAIT_MS)) === true;
  const after = check();
  if (after !== null) return answer("failed", `the file went in, then ${after.detail ?? after.outcome}; Caret stopped there`);
  if (via === "drop") {
    const attached: Attached = { via, file: null, shown };
    return shown ? answer("ok", null, attached) : answer("failed", "the page shows no sign of the dropped file", attached);
  }
  const got = (el as HTMLInputElement).files?.[0];
  const attached: Attached = { via, file: got === undefined ? null : { name: got.name, size: got.size }, shown };
  if (got === undefined) return answer("failed", "the page cleared the file input", attached);
  if (got.name !== name || got.size !== size) return answer("failed", `the input holds '${got.name}' (${got.size} bytes), not the file Caret attached`, attached);
  return answer("ok", shown ? null : "the page shows no file name of its own beside the input", attached);
}

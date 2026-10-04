// pageAttachFile without the debugger (memo section 2, "File inputs"): the bytes the worker checked become a File in
// a DataTransfer. A file input takes it as input.files, then input and change. A dropzone gets dragenter, dragover
// and drop carrying it, the way it receives a dragged file; a dropzone here is a control that holds its own file
// input (react-dropzone's root, Greenhouse's resume box), and no other control is ever handed a file (W2 review #4).
// Verified by input.files[0]'s name and size (an input) and by the page newly showing the file's name in rendered
// text near the control (both); an input whose page renders no name is reported with shown false.
import type { ActAnswer, ActVerb, Attached } from "../shared/messages.ts";
import { composedParent } from "./names.ts";
import { dropEvents, settle, until } from "./dom.ts";
import { shadowRootOf, visible } from "./walker.ts";

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
 * Where the page shows the name: a dropzone's own content, or the element around a file input (an upload widget's
 * row beside it). Kept that close so a name the page adds elsewhere (an error message for a rejected drop) is not
 * taken as the widget showing it (W2 review 2 #7).
 */
function shownScope(el: Element, via: Attached["via"]): Element {
  return via === "drop" ? el : (composedParent(el) ?? el);
}

/** Occurrences of `name` in the scope's text nodes that a person could see (walker.visible on each one's element). */
function occurrences(scope: Element, name: string): number {
  let n = 0;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t !== null; t = walker.nextNode()) {
    const text = t.textContent ?? "";
    const parent = t.parentElement;
    if (!text.includes(name) || parent === null || !visible(parent)) continue;
    for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + name.length)) n++;
  }
  return n;
}

/** Whether the element holds a file input of its own, in its light tree or a shadow root under it. */
function holdsFileInput(el: Element): boolean {
  if (el.querySelector('input[type="file"]') !== null) return true;
  for (const d of el.querySelectorAll("*")) {
    const sr = shadowRootOf(d);
    if (sr !== null && sr.querySelector('input[type="file"]') !== null) return true;
  }
  const own = shadowRootOf(el);
  return own !== null && own.querySelector('input[type="file"]') !== null;
}

export async function attachFile(el: Element, verb: AttachVerb, check: () => ActAnswer | null, alive: () => Promise<boolean>): Promise<ActAnswer> {
  const { name, size, type } = verb.file;
  // Always attached anew: a file already there with the same name and size may hold other bytes.
  const via: Attached["via"] = el instanceof HTMLInputElement && el.type === "file" ? "input" : "drop";
  const answer = (outcome: ActAnswer["outcome"], detail: string | null, attached?: Attached): ActAnswer => ({ outcome, detail, ...(attached === undefined ? {} : { attached }) });
  if (via === "input" && (el as HTMLInputElement).disabled) return answer("failed", "the file input is disabled");
  if (via === "drop" && !holdsFileInput(el)) return answer("unsupported", "Caret drops a file only on a dropzone that holds its own file input; attach it yourself here");
  const bytes = fromBase64(verb.file.data);
  if (bytes.length !== size) return answer("error", `the file arrived with ${bytes.length} bytes, not ${size}`);
  const data = new DataTransfer();
  data.items.add(new File([bytes], name, { type, lastModified: Date.now() }));
  const scope = shownScope(el, via);
  const shownBefore = occurrences(scope, name);

  if (!(await alive())) return answer("notAllowed", "the task's grant ended before the file went in");
  const ready = check();
  if (ready !== null) return ready;
  // The page had the await to change the target: it must still hold its own file input (W2 review 2 #4).
  if (via === "drop" && !holdsFileInput(el)) return answer("unsupported", "the dropzone no longer holds a file input; attach it yourself here");
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

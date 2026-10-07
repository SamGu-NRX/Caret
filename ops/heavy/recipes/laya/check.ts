// Caret's own post-pick kind checks for a value picked for a field, the same ones narrow.ts applies before Laya sees the
// options (kinds.ts misfit for text fields and dropdowns, controls.ts optionInText for menus and radio groups), so a
// pick from any engine is judged by the same code. Reads JSON lines {id, control, descriptor, label, nearest,
// placeholder, text}; writes {id, ok}.
//   CARET_HELPER_SRC=<pinned worktree>/helper/src node check.ts < picks.jsonl > checked.jsonl
// Ported to ops/heavy from ~/.caret-run/evidence/screen/ly1: the two checks load from the job's pinned worktree
// (CARET_HELPER_SRC) instead of a fixed path to caret-v2-screen. Nothing else changed.
import { readFileSync } from "node:fs";
const helper = process.env.CARET_HELPER_SRC;
if (!helper) throw new Error("CARET_HELPER_SRC is not set");
const { misfit } = (await import(`${helper}/fill/kinds.ts`)) as { misfit: (text: string, words: (string | null)[]) => unknown };
const { optionInText } = (await import(`${helper}/fill/controls.ts`)) as { optionInText: (opts: string[], text: string) => unknown };

const menuOptions = (d: string): string[] => {
  const m = /Options: (.+?)\.?$/u.exec(d);
  return m === null ? [] : [...(m[1] as string).matchAll(/'((?:[^']|'(?!,|$|\.))*)'/gu)].map((x) => x[1] as string);
};
const out: string[] = [];
for (const line of readFileSync(0, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const p = JSON.parse(line) as { id: string; control: string; descriptor: string; label: string | null; nearest: string | null; placeholder: string | null; text: string };
  const labelWords = [p.label, p.label === null ? p.nearest : null, p.placeholder];
  let ok = true;
  if (p.control === "text" || p.control === "combobox") ok = misfit(p.text, labelWords) === null;
  else if (p.control === "select" || p.control === "radio") {
    const opts = menuOptions(p.descriptor);
    if (opts.length > 0) ok = optionInText(opts, p.text) !== null;
  }
  out.push(JSON.stringify({ id: p.id, ok }));
}
process.stdout.write(out.join("\n") + "\n");

// The lines a git diff adds, grouped by the file they land in, for scripts/leak-check.ts.
//
// A `+++ b/path` line names the file only in a file's header, between `diff --git` and its first
// `@@` hunk. Inside a hunk the same prefix is an added source line that began with `++ `, so it is
// returned like any other addition rather than skipped.
export const addedLines = (diff: string): Map<string, string> => {
  const out = new Map<string, string>();
  let file = "";
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      file = "";
    } else if (!inHunk && line.startsWith("+++ ")) file = `diff:${line.slice(6)}`;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+") && file !== "") out.set(file, `${out.get(file) ?? ""}${line.slice(1)}\n`);
  }
  return out;
};

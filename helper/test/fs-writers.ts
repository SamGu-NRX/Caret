// The structural check behind test/store-writers.test.ts (INT1 review 3): which modules under helper/src can write a
// file, read from their imports and calls, not from a pattern over call shapes. A module's TypeScript is stripped to
// JavaScript (node:module stripTypeScriptTypes) and parsed (acorn); every binding it imports from node:fs,
// node:fs/promises or node:sqlite is followed to its uses.
//
// Write-capable: the sync, callback and promise forms of write, writev, writeFile, append, appendFile, copyFile,
// rename, cp, truncate, ftruncate, link, symlink and createWriteStream; open, and createReadStream with a flags
// option, unless their flags are a literal read-only mode or an expression of read-only O_* constants only (a flag in
// a variable counts as write-capable); a namespace or default import of fs used in any of those ways, or passed on
// whole; a dynamic import or require of fs; DatabaseSync from node:sqlite; and SQL text holding ATTACH or VACUUM INTO,
// which writes a file the statement names.
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";

const FS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const SQLITE = new Set(["sqlite", "node:sqlite"]);
const WRITES = new Set([
  "write", "writeSync", "writev", "writevSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync", "copyFile", "copyFileSync",
  "rename", "renameSync", "cp", "cpSync", "truncate", "truncateSync", "ftruncate", "ftruncateSync", "link", "linkSync", "symlink", "symlinkSync",
  "createWriteStream",
]);
const OPENS = new Set(["open", "openSync"]);
const READ_MODES = new Set(["r", "rs", "sr"]);
const READ_FLAGS = new Set(["O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC", "O_SYMLINK", "O_DIRECTORY", "O_NOCTTY"]);
// SQL's ATTACH takes DATABASE or a file name next (a quote or a parameter); English "attach my resume" does not.
const SQL_WRITES = /\bATTACH\s+(?:DATABASE\b|['"`?:@$])|\bVACUUM\b[^;]*?\bINTO\b/iu;

type AstNode = { type: string; [k: string]: unknown };

function children(n: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "start" || k === "end") continue;
    if (Array.isArray(v)) for (const x of v) if (x !== null && typeof x === "object" && typeof (x as AstNode).type === "string") out.push(x as AstNode);
    if (v !== null && typeof v === "object" && typeof (v as AstNode).type === "string") out.push(v as AstNode);
  }
  return out;
}

/** Whether an open's flags are read-only: a literal "r", or O_* constants that only read, joined by `|`. */
function readOnlyFlags(f: AstNode | undefined): boolean {
  if (f === undefined) return true; // open(path) opens for reading
  if (f.type === "Literal") return typeof f.value === "string" ? READ_MODES.has(f.value) : f.value === 0;
  if (f.type === "MemberExpression") return f.computed !== true && READ_FLAGS.has((f.property as AstNode).name as string);
  if (f.type === "BinaryExpression" && f.operator === "|") return readOnlyFlags(f.left as AstNode) && readOnlyFlags(f.right as AstNode);
  return false;
}

/** The write-capable uses in one module's source, each said in words with its line; [] when there are none. */
export function fsWrites(source: string): string[] {
  const js = stripTypeScriptTypes(source, { mode: "strip" });
  const ast = parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true }) as unknown as AstNode;
  const named = new Map<string, string>(); // local name -> fs export
  const spaces = new Set<string>(); // namespace or default imports of fs
  const sqlite = new Set<string>(); // local names of DatabaseSync
  const out: string[] = [];
  const line = (n: AstNode): number => ((n.loc as { start: { line: number } }).start.line);
  for (const s of ast.body as AstNode[]) {
    if (s.type !== "ImportDeclaration") continue;
    const from = (s.source as AstNode).value as string;
    for (const sp of s.specifiers as AstNode[]) {
      const local = (sp.local as AstNode).name as string;
      if (FS.has(from)) {
        if (sp.type === "ImportSpecifier") named.set(local, ((sp.imported as AstNode).name ?? (sp.imported as AstNode).value) as string);
        else spaces.add(local);
      } else if (SQLITE.has(from) && sp.type === "ImportSpecifier" && ((sp.imported as AstNode).name as string) === "DatabaseSync") sqlite.add(local);
      else if (SQLITE.has(from)) spaces.add(local);
    }
  }
  for (const [local, name] of named) if (WRITES.has(name)) out.push(`imports ${name} as ${local}`);
  const fsMember = (n: AstNode): string | null => {
    // fs.X, fs.promises.X, or fsPromises.X where fs is a namespace or default import
    if (n.type !== "MemberExpression") return null;
    const obj = n.object as AstNode;
    const isFs = (o: AstNode): boolean => o.type === "Identifier" && spaces.has(o.name as string);
    if (n.computed === true) return isFs(obj) || (obj.type === "MemberExpression" && isFs(obj.object as AstNode)) ? "(computed)" : null;
    const prop = (n.property as AstNode).name as string;
    if (obj.type === "Identifier" && spaces.has(obj.name as string)) return prop;
    if (obj.type === "MemberExpression" && obj.computed !== true && ((obj.property as AstNode).name as string) === "promises" && (obj.object as AstNode).type === "Identifier" && spaces.has((obj.object as AstNode).name as string)) return prop;
    return null;
  };
  const visit = (n: AstNode, parent: AstNode | null): void => {
    if (n.type === "Literal" && typeof n.value === "string" && SQL_WRITES.test(n.value)) out.push(`SQL that writes a file (line ${line(n)})`);
    if (n.type === "TemplateElement" && SQL_WRITES.test(((n.value as { cooked?: string }).cooked ?? "") as string)) out.push(`SQL that writes a file (line ${line(n)})`);
    if (n.type === "ImportExpression" && (n.source as AstNode).type === "Literal" && FS.has((n.source as AstNode).value as string)) out.push(`imports fs dynamically (line ${line(n)})`);
    if (n.type === "ImportExpression" && (n.source as AstNode).type !== "Literal") out.push(`imports a module named at run time (line ${line(n)})`);
    if (n.type === "CallExpression" && (n.callee as AstNode).type === "Identifier" && (n.callee as AstNode).name === "require") {
      const a = (n.arguments as AstNode[])[0];
      if (a === undefined || a.type !== "Literal" || FS.has(a.value as string) || SQLITE.has(a.value as string)) out.push(`requires fs or a module named at run time (line ${line(n)})`);
    }
    if (n.type === "NewExpression" && (n.callee as AstNode).type === "Identifier" && sqlite.has((n.callee as AstNode).name as string)) out.push(`opens a database file (line ${line(n)})`);
    if (n.type === "NewExpression" && (n.callee as AstNode).type === "MemberExpression" && fsMember(n.callee as AstNode) === "DatabaseSync") out.push(`opens a database file (line ${line(n)})`);
    if (n.type === "CallExpression") {
      const callee = n.callee as AstNode;
      const args = n.arguments as AstNode[];
      const name = callee.type === "Identifier" ? (named.get(callee.name as string) ?? null) : fsMember(callee);
      if (name !== null) {
        if (name === "(computed)") out.push(`calls fs by a computed name (line ${line(n)})`);
        else if (WRITES.has(name)) out.push(`calls ${name} (line ${line(n)})`);
        else if (OPENS.has(name) && !readOnlyFlags(args[1])) out.push(`calls ${name} with flags that may write (line ${line(n)})`);
        else if (name === "createReadStream") {
          const opts = args[1];
          const flags = opts?.type === "ObjectExpression" ? (opts.properties as AstNode[]).find((p) => ((p.key as AstNode | undefined)?.name ?? (p.key as AstNode | undefined)?.value) === "flags") : undefined;
          if (opts !== undefined && opts.type !== "ObjectExpression" && opts.type !== "Literal") out.push(`calls createReadStream with options that may write (line ${line(n)})`);
          else if (flags !== undefined && !readOnlyFlags(flags.value as AstNode)) out.push(`calls createReadStream with flags that may write (line ${line(n)})`);
        }
      }
    }
    // A namespace import used other than as `ns.member` (passed on, spread, assigned) can reach any write.
    if (n.type === "Identifier" && spaces.has(n.name as string) && parent !== null) {
      const usedAsObject = parent.type === "MemberExpression" && parent.object === n;
      const declared = parent.type === "ImportNamespaceSpecifier" || parent.type === "ImportDefaultSpecifier";
      if (!usedAsObject && !declared) out.push(`passes the fs module on (line ${line(n)})`);
    }
    for (const c of children(n)) visit(c, n);
  };
  visit(ast, null);
  return [...new Set(out)];
}

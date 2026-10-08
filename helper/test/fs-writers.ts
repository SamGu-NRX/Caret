// The import rule behind test/store-writers.test.ts: outside a short allowlist, a module under helper/src may import
// from node:fs only the functions below, which cannot put content into a file, nothing from node:sqlite (a database
// writes its file), and no loader from node:module (createRequire would reach either). Every other binding, a namespace
// or default import, `promises`, a re-export, and a dynamic import or require of these modules breaks it. Read from the
// module's imports after its TypeScript is stripped, so `import type` and type-only names do not count.
// Out of scope: a read function called with write flags (readFileSync(p, { flag: "w+" })) is deliberate misuse, not the
// accidental drift this guards against.
import { stripTypeScriptTypes } from "node:module";
import { parse, type AnyNode } from "acorn";

const FS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const SQLITE = new Set(["sqlite", "node:sqlite"]);
const MODULE = new Set(["module", "node:module"]);
/** What a module may import from node:module: nothing that loads a module. */
const MODULE_PERMITTED: ReadonlySet<string> = new Set(["stripTypeScriptTypes", "isBuiltin", "builtinModules"]);

/**
 * What a module may import from node:fs: reads, inspection and descriptors' reads, and the folder, mode and removal
 * calls, none of which writes a file's content. A module that makes a folder checks its path first; this rule does not
 * see that.
 */
export const PERMITTED: ReadonlySet<string> = new Set([
  "readFileSync", "readFile", "existsSync", "statSync", "lstatSync", "fstatSync", "statfsSync", "readdirSync", "realpathSync", "readlinkSync",
  "createReadStream", "readSync", "closeSync", "watch", "constants",
  "mkdirSync", "chmodSync", "unlinkSync", "rmSync", "rmdirSync",
]);

function isNode(v: unknown): v is AnyNode {
  return typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";
}

function* nodes(n: AnyNode): Generator<AnyNode> {
  yield n;
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) {
      for (const x of v) if (isNode(x)) yield* nodes(x);
    } else if (isNode(v)) yield* nodes(v);
  }
}

const moduleName = (n: AnyNode | null | undefined): string | null => (n?.type === "Literal" && typeof n.value === "string" ? n.value : null);

/** What in a module's source breaks the import rule, each with its line; [] when nothing does. */
export function fsImportViolations(source: string): string[] {
  const js = stripTypeScriptTypes(source, { mode: "strip" });
  const out: string[] = [];
  for (const n of nodes(parse(js, { ecmaVersion: "latest", sourceType: "module", locations: true }))) {
    const line = n.loc?.start.line ?? 0;
    if (n.type === "ImportDeclaration") {
      const from = moduleName(n.source) ?? "";
      if (SQLITE.has(from) && n.specifiers.length > 0) out.push(`imports from ${from} (line ${line})`);
      if (MODULE.has(from)) {
        for (const sp of n.specifiers) {
          const name = sp.type === "ImportSpecifier" ? (sp.imported.type === "Identifier" ? sp.imported.name : String(sp.imported.value)) : null;
          if (name === null || !MODULE_PERMITTED.has(name)) out.push(`imports ${name ?? "the module loader"} from ${from} (line ${line})`);
        }
      }
      if (!FS.has(from)) continue;
      for (const sp of n.specifiers) {
        if (sp.type !== "ImportSpecifier") out.push(`imports ${from} whole (line ${line})`);
        else {
          const name = sp.imported.type === "Identifier" ? sp.imported.name : String(sp.imported.value);
          if (!PERMITTED.has(name)) out.push(`imports ${name} from ${from} (line ${line})`);
        }
      }
    } else if ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source !== null && n.source !== undefined) {
      const from = moduleName(n.source) ?? "";
      if (FS.has(from) || SQLITE.has(from)) out.push(`re-exports ${from} (line ${line})`);
    } else if (n.type === "ImportExpression") {
      const from = moduleName(n.source);
      if (from === null || FS.has(from) || SQLITE.has(from)) out.push(`imports ${from ?? "a module named at run time"} dynamically (line ${line})`);
    } else if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require") {
      const from = n.arguments[0]?.type === "Literal" ? moduleName(n.arguments[0]) : null;
      if (from === null || FS.has(from) || SQLITE.has(from)) out.push(`requires ${from ?? "a module named at run time"} (line ${line})`);
    }
  }
  return out;
}

// Turns a writer's TypeScript program into JavaScript for the sandbox, outside the sandbox and without
// running it. Types are erased by Node's own stripper (strip mode, so enums, namespaces and other syntax
// that needs a transform are refused). The JavaScript is then parsed as a script, so `import`
// declarations are a syntax error, and checked against an allowlist of syntax: one top-level
// `async function main(caret)` built from plain statements, arrows and calls. This is a shape check that
// keeps refusals early and specific. It is not the isolation boundary; QuickJS is, and the sandbox
// tests run hostile JavaScript that skips this step.
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";
import { DEFAULT_LIMITS } from "./limits.ts";

export type CompileResult = { ok: true; js: string; digest: string } | { ok: false; detail: string };

/** Syntax a plan-building program can use. Anything else is refused by name. */
const ALLOWED = new Set([
  "Program",
  "FunctionDeclaration",
  "ArrowFunctionExpression",
  "BlockStatement",
  "ExpressionStatement",
  "EmptyStatement",
  "VariableDeclaration",
  "VariableDeclarator",
  "ReturnStatement",
  "IfStatement",
  "SwitchStatement",
  "SwitchCase",
  "ForStatement",
  "ForOfStatement",
  "WhileStatement",
  "BreakStatement",
  "ContinueStatement",
  "ThrowStatement",
  "TryStatement",
  "CatchClause",
  "Identifier",
  "Literal",
  "TemplateLiteral",
  "TemplateElement",
  "ArrayExpression",
  "ObjectExpression",
  "Property",
  "SpreadElement",
  "RestElement",
  "ArrayPattern",
  "ObjectPattern",
  "AssignmentPattern",
  "MemberExpression",
  "ChainExpression",
  "CallExpression",
  "AwaitExpression",
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "UpdateExpression",
  "ConditionalExpression",
  "AssignmentExpression",
  "NewExpression",
]);

/** Constructors a program may call with `new`. Writers reach for Map and Set to index refs. */
const NEW_ALLOWED = new Set(["Map", "Set", "Error"]);

/** Names that reach the host, the global object, constructors or clocks. The sandbox lacks or removes them too. */
const DENIED_NAMES = new Set([
  "eval",
  "Function",
  "globalThis",
  "window",
  "self",
  "global",
  "constructor",
  "__proto__",
  "prototype",
  "arguments",
  "require",
  "module",
  "exports",
  "process",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebAssembly",
  "Proxy",
  "Reflect",
  "Atomics",
  "SharedArrayBuffer",
  "Date",
  "setTimeout",
  "setInterval",
  "queueMicrotask",
]);

const UNARY = new Set(["!", "-", "+", "typeof"]);

interface AstNode {
  type: string;
  start: number;
  loc?: { start: { line: number; column: number } };
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";

function where(n: AstNode): string {
  return n.loc === undefined ? `offset ${n.start}` : `line ${n.loc.start.line}:${n.loc.start.column + 1}`;
}

/** First rule the node breaks, or null. Parent is null only for Program. */
function breaks(n: AstNode, parent: AstNode | null): string | null {
  if (n.type === "ImportExpression") return "dynamic import() is not allowed";
  if (n.type === "MetaProperty") return "import.meta is not allowed";
  if (!ALLOWED.has(n.type)) return `${n.type} is not allowed in a plan program`;
  switch (n.type) {
    case "FunctionDeclaration":
      if (parent?.type !== "Program") return "functions other than main must be arrow functions";
      return null;
    case "VariableDeclaration":
      return n.kind === "const" || n.kind === "let" ? null : "use const or let";
    case "Literal":
      if (n.regex !== undefined) return "regular expressions are not allowed";
      if (n.bigint !== undefined) return "bigint literals are not allowed";
      return null;
    case "Property":
      return n.kind === "init" && n.method === false ? null : "getters, setters and methods are not allowed in object literals";
    case "NewExpression": {
      const callee = n.callee as AstNode;
      return callee.type === "Identifier" && NEW_ALLOWED.has(callee.name as string) ? null : "new is allowed only for Map, Set and Error";
    }
    case "UnaryExpression":
      return UNARY.has(n.operator as string) ? null : `the ${String(n.operator)} operator is not allowed`;
    case "Identifier":
      // The property name of `w.window` is this node too; see MemberExpression.
      if (n.name === "window" && parent?.type === "MemberExpression" && parent.computed === false && parent.property === n) return null;
      return DENIED_NAMES.has(n.name as string) ? `${String(n.name)} is not available to a plan program` : null;
    case "MemberExpression": {
      const p = n.property as AstNode;
      const name = n.computed ? (p.type === "Literal" && typeof p.value === "string" ? p.value : null) : (p.name as string);
      // A ReadWindow's own `window` ref (plan-prompt.ts PLAN_API) is a property, not the global, which is still denied as
      // a name: B30's live goal programs read it for draft() and were refused, as one D2-06 program was.
      if (name === "window" && !n.computed) return null;
      return name !== null && DENIED_NAMES.has(name) ? `.${name} is not available to a plan program` : null;
    }
    default:
      return null;
  }
}

function checkProgram(root: AstNode): string | null {
  const body = root.body as AstNode[];
  const main = body[0];
  if (body.length !== 1 || main === undefined || main.type !== "FunctionDeclaration") {
    return "a plan program is exactly one declaration: async function main(caret) { ... }";
  }
  const id = main.id as AstNode | null;
  const params = main.params as AstNode[];
  if (id?.name !== "main" || main.async !== true || main.generator === true || params.length !== 1 || params[0]?.type !== "Identifier") {
    return `the declaration at ${where(main)} must be: async function main(caret) { ... }`;
  }
  // Iterative walk: a deeply nested program must not overflow the host's own stack here.
  const stack: [AstNode, AstNode | null][] = [[root, null]];
  while (stack.length > 0) {
    const [n, parent] = stack.pop()!;
    const broken = breaks(n, parent);
    if (broken !== null) return `${broken} (${where(n)})`;
    for (const [key, v] of Object.entries(n)) {
      if (key === "loc") continue;
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) stack.push([c, n]);
      } else if (isNode(v)) stack.push([v, n]);
    }
  }
  return null;
}

export function compileProgram(source: string, maxBytes = DEFAULT_LIMITS.sourceBytes): CompileResult {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > maxBytes) return { ok: false, detail: `program is ${bytes} bytes; the limit is ${maxBytes}` };
  let js: string;
  try {
    js = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (e) {
    return { ok: false, detail: `type erasure refused the program: ${(e as Error).message}` };
  }
  let root: AstNode;
  try {
    root = parse(js, { ecmaVersion: 2023, sourceType: "script", locations: true }) as unknown as AstNode;
  } catch (e) {
    const msg = (e as Error).message;
    if (/'import' and 'export' may appear only with 'sourceType: module'/.test(msg)) return { ok: false, detail: `import and export are not allowed: ${msg}` };
    return { ok: false, detail: `not valid JavaScript after type erasure: ${msg}` };
  }
  const broken = checkProgram(root);
  if (broken !== null) return { ok: false, detail: broken };
  return { ok: true, js, digest: createHash("sha256").update(source).digest("hex") };
}

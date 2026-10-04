// M1: personal memory as markdown. The parser reads only typed records under a stable comment, the store saves by
// compare-and-swap and refuses what is not a plain file in its folder, and Caret never writes a secret into it.
// Every directory is a fresh temporary one; nothing here touches the user's real memory folder.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, MemoryConflictError, MemoryDocumentError, MemoryDocumentStore, revisionOf, sensitiveLine } from "../src/memory/documents.ts";
import { applyRecord, formatDiagnostic, isDocId, newDocument, parseDocument, recordDigest, removeRecord, type MemoryRecord } from "../src/memory/parse.ts";
import { labelKind, sensitiveKind, valueKind } from "../src/memory/sensitive.ts";

const NOTICED = { app: "Mail", window: "Re: dinner on Friday", at: Date.UTC(2026, 9, 3, 15, 20) };
const RECORDS: MemoryRecord[] = [
  { id: "about-1a2b3c4d", kind: "about", status: "active", noticed: null, fields: { label: "Name", value: "Dana Whitfield", source: "typed" } },
  { id: "about-5e6f7a8b", kind: "about", status: "noticed", noticed: NOTICED, fields: { label: "Guest", value: "  Marcus Lowe (ops)", source: "edit" } },
  { id: "about-9c0d1e2f", kind: "about", status: "paused", noticed: { app: null, window: null, at: 1 }, fields: { label: "Work email", value: '"quoted" text', source: "contacts" } },
];

describe("the memory markdown parser", () => {
  it("reads back every field, status and provenance it renders, for every kind", () => {
    const people: MemoryRecord = { id: "people-0a1b2c3d", kind: "people", status: "noticed", noticed: NOTICED, fields: { alias: "Dana", name: "Dana Reyes" } };
    const prefs: MemoryRecord[] = [
      { id: "preference-1", kind: "preference", status: "active", noticed: null, fields: { rule: "format", valueKind: "phone", template: "(###) ###-####" } },
      { id: "preference-2", kind: "preference", status: "noticed", noticed: NOTICED, fields: { rule: "useInstead", field: "Guest", aboutId: "about-5e6f7a8b" } },
      { id: "preference-3", kind: "preference", status: "active", noticed: null, fields: { rule: "dontOffer", offerKind: "routine", bundleId: "dev.caret.mail", appName: "Mail Fixture" } },
    ];
    const skill: MemoryRecord = { id: "skill-4e5f6a7b", kind: "skill", status: "paused", noticed: null, fields: { name: "Copy tracking", trigger: "a Tracker window opens with Order empty" } };
    for (const [doc, rs] of [["about-me", RECORDS], ["people", [people]], ["preferences", prefs], ["skills/skill-4e5f6a7b", [skill]]] as const) {
      const p = parseDocument(doc, newDocument(doc, rs));
      expect(p.diagnostics, doc).toEqual([]);
      expect(p.records.map((x) => x.record)).toEqual(rs);
    }
  });

  it("never takes a value from prose, and says which field is missing, on which line", () => {
    const text = ["# About me", "", "## Name <!-- caret:id=about-1a2b3c4d kind=about -->", "My name is Dana Whitfield.", "- Label: Name", "- Source: typed", "- Status: active", ""].join("\n");
    const p = parseDocument("about-me", text);
    expect(p.records).toEqual([]);
    expect(p.broken.has("about-1a2b3c4d")).toBe(true);
    expect(p.diagnostics.map(formatDiagnostic)).toEqual(["about-me.md:3: Value: is missing"]);
  });

  it("warns about a field it does not read, and an 'On its own' typed into a skill grants nothing", () => {
    const text = newDocument("skills/skill-4e5f6a7b", [{ id: "skill-4e5f6a7b", kind: "skill", status: "active", noticed: null, fields: { name: "Copy tracking", trigger: "a Tracker opens" } }]) + "- On its own: true\n- onItsOwn: true\n";
    const p = parseDocument("skills/skill-4e5f6a7b", text);
    expect(p.records[0]?.record.fields).toEqual({ name: "Copy tracking", trigger: "a Tracker opens" });
    expect(p.diagnostics.map((d) => [d.severity, d.field, d.message])).toEqual([
      ["warning", "On its own", "not a field Caret reads in a skill record; it changes nothing"],
      ["warning", "onItsOwn", "not a field Caret reads in a skill record; it changes nothing"],
    ]);
  });

  it("names file, line and field for each kind of error, and disables only the broken record", () => {
    const lines = [
      "# About me",
      "## Ok <!-- caret:id=about-ok kind=about -->",
      "- Label: Ok",
      "- Value: fine",
      "- Source: typed",
      "- Status: active",
      "## Bad status <!-- caret:id=about-bad kind=about -->",
      "- Label: X",
      "- Value: y",
      "- Source: typed",
      "- Status: sure",
      "## Twice <!-- caret:id=about-twice kind=about -->",
      "- Label: A",
      "- Label: B",
      "### Level three <!-- caret:id=about-l3 kind=about -->",
      "## Person <!-- caret:id=people-x1 kind=people -->",
      "## Malformed <!-- caret:kind=about id=about-m -->",
      "## Noticed <!-- caret:id=about-n kind=about -->",
      "- Label: N",
      "- Value: v",
      "- Source: edit",
      "- Status: noticed",
      "- Noticed on: yesterday",
    ];
    const p = parseDocument("about-me", lines.join("\n"));
    expect(p.records.map((r) => r.record.id)).toEqual(["about-ok"]);
    expect(p.diagnostics.map(formatDiagnostic)).toEqual([
      "about-me.md:11: Status: must be active, noticed or paused",
      "about-me.md:14: Label: appears twice in this record (first at line 13)",
      "about-me.md:15: a record's heading starts with ## (two #)",
      "about-me.md:16: about-me.md holds about records, not people",
      "about-me.md:17: the comment must read <!-- caret:id=… kind=… -->",
      "about-me.md:23: Noticed on: must be a date and time like 2026-10-04T15:20:00.000Z",
    ]);
  });

  it("quarantines both records that share an id", () => {
    const one = newDocument("people", [{ id: "people-dup", kind: "people", status: "active", noticed: null, fields: { alias: "Dana", name: "Dana Reyes" } }]);
    const two = `${one}\n## Dana again <!-- caret:id=people-dup kind=people -->\n- Alias: Dana\n- Name: Dana Smith\n- Status: active\n`;
    const p = parseDocument("people", two);
    expect(p.records).toEqual([]);
    expect(p.diagnostics.filter((d) => d.severity === "error").map((d) => d.line).sort((a, b) => a - b)).toEqual([5, 10]);
  });

  it("ignores record headings inside fenced code", () => {
    const text = newDocument("about-me", [RECORDS[0] as MemoryRecord]) + "\n```\n## Fake <!-- caret:id=about-fake kind=about -->\n- Label: Fake\n```\n";
    expect(parseDocument("about-me", text).records.map((r) => r.record.id)).toEqual(["about-1a2b3c4d"]);
  });

  it("changes only the record's own lines when Caret writes it, keeping prose, other records, a custom title and CRLF", () => {
    const base = newDocument("about-me", RECORDS).replace("## Name <!--", "## What I go by <!--").replace(/\n/g, "\r\n");
    const withProse = base.replace("- Status: active\r\n", "- Status: active\r\nI use this name in messages.\r\n- Mood: sunny\r\n");
    const p = parseDocument("about-me", withProse);
    const edited: MemoryRecord = { ...(RECORDS[0] as MemoryRecord & { kind: "about" }), status: "noticed", noticed: NOTICED, fields: { label: "Name", value: "Dana W.", source: "typed" } };
    const out = applyRecord(p, edited);
    const block = (t: string): string[] => {
      const ls = t.split("\r\n");
      const at = ls.findIndex((l) => l.includes("caret:id=about-1a2b3c4d"));
      const end = ls.findIndex((l, i) => i > at && l.startsWith("## "));
      return ls.slice(at, end);
    };
    expect(block(out)).toEqual([
      "## What I go by <!-- caret:id=about-1a2b3c4d kind=about -->",
      "- Label: Name",
      "- Value: Dana W.",
      "- Source: typed",
      "- Status: noticed",
      "- Noticed in: Mail",
      "- Window: Re: dinner on Friday",
      "- Noticed on: 2026-10-03T15:20:00.000Z",
      "I use this name in messages.",
      "- Mood: sunny",
      "",
    ]);
    // Everything outside the record is byte for byte the same.
    const outside = (t: string): string => t.replace(block(t).join("\r\n"), "");
    expect(outside(out)).toBe(outside(withProse));
    expect(parseDocument("about-me", out).records.map((r) => r.record)).toEqual([edited, RECORDS[1], RECORDS[2]]);
    // Removing a record takes its prose with it and leaves the others byte for byte.
    const removed = removeRecord(parseDocument("about-me", out), "about-1a2b3c4d");
    expect(removed).not.toContain("Dana");
    expect(removed).toContain(newDocument("about-me", [RECORDS[1] as MemoryRecord, RECORDS[2] as MemoryRecord]).split("\n").slice(4).join("\r\n").trimEnd());
  });

  it("names documents only by their fixed names or a skill id, never a path", () => {
    for (const ok of ["about-me", "people", "preferences", "skills/skill-1a2b"]) expect(isDocId(ok), ok).toBe(true);
    for (const no of ["../about-me", "skills/../people", "skills/a/b", "skills/", "about-me.md", "/etc/passwd", "skills/.hidden", "Memory/people"]) expect(isDocId(no), no).toBe(false);
  });

  it("gives the same digest to the same record however it is laid out, and another to any change", () => {
    const r = RECORDS[1] as MemoryRecord;
    expect(recordDigest(r)).toBe(recordDigest(structuredClone(r)));
    expect(recordDigest({ ...r, status: "active" })).not.toBe(recordDigest(r));
  });
});

describe("what Caret never keeps", () => {
  it("refuses passwords, card and account numbers, government IDs, one-time codes and API keys by label or shape", () => {
    expect(labelKind("Password")).toBe("password");
    expect(labelKind("Card number")).toBe("cardNumber");
    expect(labelKind("Routing number")).toBe("accountNumber");
    expect(labelKind("SSN")).toBe("governmentId");
    expect(labelKind("Passport no.")).toBe("governmentId");
    expect(labelKind("Verification code")).toBe("oneTimeCode");
    expect(labelKind("API key")).toBe("apiKey");
    expect(valueKind("4111 1111 1111 1111")).toBe("cardNumber");
    expect(valueKind("123-45-6789")).toBe("governmentId");
    expect(valueKind("GB82 WEST 1234 5698 7654 32")).toBe("accountNumber");
    expect(valueKind("sk-proj-abcdefghijklmnopqrstuvwxyz012345")).toBe("apiKey");
    expect(valueKind("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("apiKey");
    expect(valueKind("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("apiKey");
    // Everyday values pass: a name, an email, a phone, a date, an order number, an address.
    for (const [label, v] of [["Name", "Dana Whitfield"], ["Email", "dana@example.com"], ["Phone", "+1 (512) 555-0142"], ["Date", "2026-10-04"], ["Order", "1234567890"], ["Address", "455 Congress Ave, Austin"], ["Pinned", "yes"]] as const) {
      expect(sensitiveKind(label, v), `${label}: ${v}`).toBeNull();
    }
  });

  it("disables a record that holds one, saying why, and refuses a save with one anywhere in it", () => {
    const text = newDocument("about-me", [{ id: "about-pw", kind: "about", status: "active", noticed: null, fields: { label: "Bank password", value: "hunter2", source: "typed" } }]);
    const p = parseDocument("about-me", text);
    expect(p.records).toEqual([]);
    expect(p.diagnostics.map(formatDiagnostic)).toEqual(["about-me.md:7: Value: Caret doesn't keep passwords in memory, so this record is not used"]);
    expect(sensitiveLine("about-me", text)).toBe("about-me.md:7: Value: Caret doesn't keep passwords in memory, so this record is not used");
    expect(sensitiveLine("people", "# People\n\nmy card 4111-1111-1111-1111\n")).toBe("people.md:3: Caret doesn't keep card numbers in memory");
    // A word in a sentence is not a secret.
    expect(sensitiveLine("people", "# People\n\nI keep my passwords in a manager.\n")).toBeNull();
  });
});

describe("the memory document store", () => {
  let dir: string;
  let root: string;
  let store: MemoryDocumentStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-memdocs-"));
    root = join(dir, "Memory");
    store = new MemoryDocumentStore(root);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const about = (id: string, value: string, status: MemoryRecord["status"] = "active"): MemoryRecord => ({ id, kind: "about", status, noticed: status === "noticed" ? NOTICED : null, fields: { label: `L ${id}`, value, source: "typed" } });

  it("keeps the folder 0700 and its files 0600, and tightens a file made readable to others", () => {
    store.put(about("about-aaa", "one"));
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, "skills")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, "about-me.md")).mode & 0o777).toBe(0o600);
    chmodSync(join(root, "about-me.md"), 0o644);
    store.refresh("about", true);
    expect(lstatSync(join(root, "about-me.md")).mode & 0o777).toBe(0o600);
    // No temporary or aside file is left behind.
    expect(readdirSync(root).sort()).toEqual(["about-me.md", "skills"]);
  });

  it("refuses a symlinked file, a FIFO and a folder in a file's place, naming what it found, and disables their records", () => {
    const outside = join(dir, "elsewhere.md");
    writeFileSync(outside, newDocument("people", [{ id: "people-x1", kind: "people", status: "active", noticed: null, fields: { alias: "A", name: "B" } }]));
    symlinkSync(outside, join(root, "people.md"));
    execFileSync("mkfifo", [join(root, "preferences.md")]);
    mkdirSync(join(root, "about-me.md"));
    store.refresh("all", true);
    expect(store.records("people")).toEqual([]);
    expect(store.info("people").diagnostics[0]?.message).toBe("people.md is a symlink; Caret reads only real files in the memory folder");
    expect(store.info("preferences").diagnostics[0]?.message).toBe("preferences.md is a FIFO, not a markdown file");
    expect(store.info("about-me").diagnostics[0]?.message).toBe("about-me.md is a folder, not a markdown file");
    expect(() => store.put({ id: "people-x2", kind: "people", status: "active", noticed: null, fields: { alias: "C", name: "D" } })).toThrow(/symlink/);
    // The file outside the folder was not written through the link.
    expect(readFileSync(outside, "utf8")).not.toContain("people-x2");
  });

  it("refuses a memory folder that is a symlink", () => {
    const real = join(dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(dir, "linked"));
    expect(() => new MemoryDocumentStore(join(dir, "linked"))).toThrow(/is a symlink; Caret keeps memory only in a real folder/);
  });

  it("refuses an oversized file and one that is not UTF-8", () => {
    writeFileSync(join(root, "people.md"), "x".repeat(MAX_FILE_BYTES + 1));
    writeFileSync(join(root, "preferences.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    store.refresh("all", true);
    expect(store.info("people").diagnostics[0]?.message).toBe(`people.md is ${MAX_FILE_BYTES + 1} bytes; the limit is ${MAX_FILE_BYTES}`);
    expect(store.info("preferences").diagnostics[0]?.message).toBe("preferences.md is not UTF-8 text");
    expect(() => store.save("people", null, "y".repeat(MAX_FILE_BYTES + 1))).toThrow(MemoryDocumentError);
  });

  it("saves only from the revision the file is at, and never over a newer one", () => {
    const rev1 = store.save("people", null, "# People\n");
    expect(() => store.save("people", null, "# Mine\n")).toThrow(MemoryConflictError);
    const rev2 = store.save("people", rev1, "# People\n\nTwo\n");
    expect(() => store.save("people", rev1, "# Stale\n")).toThrow(MemoryConflictError);
    expect(readFileSync(join(root, "people.md"), "utf8")).toBe("# People\n\nTwo\n");
    expect(rev2).toBe(revisionOf("# People\n\nTwo\n"));
  });

  it("an editor saving while Caret saves: an edit elsewhere is merged; an edit to the same record wins with a conflict", () => {
    store.put(about("about-aaa", "one"));
    store.put(about("about-bbb", "two"));
    const path = join(root, "about-me.md");
    // The user changes another record at the moment Caret installs a noticed fact.
    let once = true;
    store.hooks.beforeInstall = () => {
      if (!once) return;
      once = false;
      writeFileSync(path, readFileSync(path, "utf8").replace("- Value: two", "- Value: two, edited by hand"));
    };
    store.put(about("about-ccc", "three", "noticed"), null);
    const merged = parseDocument("about-me", readFileSync(path, "utf8")).records.map((r) => [r.record.id, (r.record.fields as { value: string }).value]);
    expect(merged).toEqual([["about-aaa", "one"], ["about-bbb", "two, edited by hand"], ["about-ccc", "three"]]);

    // The user changes the very record Caret is about to change: Caret's write is refused and the user's stays.
    const seen = store.digest("about-aaa");
    writeFileSync(path, readFileSync(path, "utf8").replace("- Value: one", "- Value: one, mine"));
    expect(() => store.put({ ...about("about-aaa", "one, Caret's"), status: "noticed", noticed: NOTICED }, seen)).toThrow(/changed outside Caret \(it was edited\); keeping that version/);
    expect(readFileSync(path, "utf8")).toContain("- Value: one, mine");
    expect(readFileSync(path, "utf8")).not.toContain("Caret's");
    // And the user's edit is reported as an external change, once.
    const changes = store.takeChanges().map((c) => [c.id, (c.before?.fields as { value: string } | undefined)?.value, (c.after?.fields as { value: string } | undefined)?.value]);
    expect(changes).toEqual([["about-bbb", "two", "two, edited by hand"], ["about-aaa", "one", "one, mine"]]);
    expect(store.takeChanges()).toEqual([]);
  });

  it("an editor replacing the file between Caret's compare and its install loses nothing: the save is refused", () => {
    store.put(about("about-aaa", "one"));
    const path = join(root, "about-me.md");
    const base = revisionOf(readFileSync(path));
    // The swap happens after the aside rename: the editor's atomic save creates a new file at the path.
    store.hooks.beforeInstall = () => writeFileSync(path, "# About me\n\nwritten by the editor\n");
    expect(() => store.save("about-me", base, "# About me\n\nCaret's\n")).toThrow(MemoryConflictError);
    expect(readFileSync(path, "utf8")).toBe("# About me\n\nwritten by the editor\n");
  });

  it("an editor creating the file after Caret renamed it aside wins: the exclusive link refuses Caret's install", () => {
    store.put(about("about-aaa", "one"));
    const path = join(root, "about-me.md");
    const base = revisionOf(readFileSync(path));
    store.hooks.afterAside = () => writeFileSync(path, "# About me\n\nsaved by the editor just now\n");
    expect(() => store.save("about-me", base, "# About me\n\nCaret's\n")).toThrow(/was written outside Caret while it saved; keeping that version/);
    expect(readFileSync(path, "utf8")).toBe("# About me\n\nsaved by the editor just now\n");
    expect(readdirSync(root).sort()).toEqual(["about-me.md", "skills"]);
  });

  it("does not report its own writes as changes, and reports an external edit, removal and a new duplicate id", () => {
    store.put(about("about-aaa", "one"));
    store.put({ id: "people-p1", kind: "people", status: "active", noticed: null, fields: { alias: "Dana", name: "Dana Reyes" } });
    store.refresh("all");
    expect(store.takeChanges()).toEqual([]);
    const path = join(root, "about-me.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("- Status: active", "- Status: paused"));
    store.refresh("about");
    expect(store.takeChanges().map((c) => [c.id, c.before?.status, c.after?.status])).toEqual([["about-aaa", "active", "paused"]]);
    rmSync(join(root, "people.md"));
    store.refresh("people");
    expect(store.takeChanges().map((c) => [c.id, c.after])).toEqual([["people-p1", null]]);
    // A layout-only edit (a blank line, a new prose line) is not a change.
    writeFileSync(path, readFileSync(path, "utf8") + "\nJust a note.\n");
    store.refresh("about");
    expect(store.takeChanges()).toEqual([]);
  });

  it("disables an id used in two files", () => {
    store.put(about("dup-1234", "one"));
    writeFileSync(join(root, "people.md"), newDocument("people", []) + "\n## X <!-- caret:id=dup-1234 kind=people -->\n- Alias: X\n- Name: Y\n- Status: active\n");
    store.refresh("all", true);
    expect(store.record("dup-1234")).toBeNull();
    expect(store.disabledWhy("dup-1234", "about")).toBe("the id dup-1234 is used in about-me.md and people.md; neither record is used");
    expect(store.takeChanges().map((c) => [c.id, c.after])).toEqual([["dup-1234", null]]);
    expect(() => store.put(about("dup-1234", "two"))).toThrow(/neither record is used/);
  });

  it("refuses to write a record holding a secret, naming the field", () => {
    expect(() => store.put({ id: "about-cc", kind: "about", status: "active", noticed: null, fields: { label: "Card", value: "4111 1111 1111 1111", source: "typed" } })).toThrow("Value: Caret doesn't keep card numbers in memory");
    expect(existsSync(join(root, "about-me.md"))).toBe(false);
  });

  it("puts back a file a crash left renamed aside, and drops an unfinished temporary file", () => {
    store.put(about("about-aaa", "one"));
    store.close();
    const path = join(root, "about-me.md");
    const body = readFileSync(path);
    // As if Caret died between renaming the file aside and linking the new one in.
    writeFileSync(join(root, ".about-me.md.caret-1-abcdef.old"), body);
    rmSync(path);
    writeFileSync(join(root, ".about-me.md.caret-1-123456.tmp"), "half");
    store = new MemoryDocumentStore(root);
    expect(readFileSync(path)).toEqual(body);
    expect(readdirSync(root).sort()).toEqual(["about-me.md", "skills"]);
    expect(store.record("about-aaa")).not.toBeNull();
  });

  it("calls the watcher's hint when a file changes", async () => {
    store.put(about("about-aaa", "one"));
    let hint = false;
    store.watch(() => (hint = true));
    const path = join(root, "about-me.md");
    const original = readFileSync(path, "utf8");
    // An FSEvents stream can miss a write made as it starts, so the edit is repeated until a hint comes (5 s at most).
    for (let n = 0; !hint && n < 25; n++) {
      writeFileSync(path, original.replace("- Value: one", `- Value: uno ${n}`));
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(hint).toBe(true);
    store.refresh("about");
    expect(store.takeChanges().map((c) => c.id)).toEqual(["about-aaa"]);
  });
});

describe("review findings (M1 fresh review)", () => {
  let dir: string;
  let root: string;
  let store: MemoryDocumentStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-memdocs-review-"));
    root = join(dir, "Memory");
    store = new MemoryDocumentStore(root);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const about = (id: string, value: string): MemoryRecord => ({ id, kind: "about", status: "active", noticed: null, fields: { label: `L ${id}`, value, source: "typed" } });
  const path = (): string => join(root, "about-me.md");

  it("#1 an editor writing in place after the compare: its bytes are kept as a conflict copy and the save says so", () => {
    store.put(about("about-aaa", "one"));
    const base = revisionOf(readFileSync(path()));
    store.hooks.beforeDrop = (aside) => writeFileSync(aside, "# About me\n\nwritten in place by the editor\n");
    expect(() => store.save("about-me", base, "# About me\n\nCaret's\n")).toThrow(/was edited outside Caret while it saved; that version is kept as about-me \(conflict \d{8} \d{6}\)\.md/);
    const copies = readdirSync(root).filter((f) => f.includes("(conflict"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(root, copies[0] as string), "utf8")).toBe("# About me\n\nwritten in place by the editor\n");
    expect(readdirSync(root).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("#1 a crash leftover that differs from the installed file is kept, not deleted", () => {
    store.put(about("about-aaa", "one"));
    store.close();
    writeFileSync(join(root, ".about-me.md.caret-1-abcdef.old"), "# About me\n\nan edit that landed in the old file\n");
    store = new MemoryDocumentStore(root);
    const copies = readdirSync(root).filter((f) => f.includes("(conflict"));
    expect(copies.map((c) => readFileSync(join(root, c), "utf8"))).toEqual(["# About me\n\nan edit that landed in the old file\n"]);
  });

  it("#2 removing a record the user edits meanwhile is a conflict on every attempt, never a deletion of their edit", () => {
    store.put({ id: "skill-abc1", kind: "skill", status: "active", noticed: null, fields: { name: "Copy", trigger: "a window opens" } });
    const file = join(root, "skills", "skill-abc1.md");
    let once = true;
    store.hooks.beforeInstall = () => {
      if (!once) return;
      once = false;
      writeFileSync(file, readFileSync(file, "utf8").replace("- Name: Copy", "- Name: Copy, renamed by hand"));
    };
    expect(() => store.remove("skill-abc1", "skill")).toThrow(/changed outside Caret \(it was edited\)/);
    expect(readFileSync(file, "utf8")).toContain("- Name: Copy, renamed by hand");
  });

  it("#6 a skills folder swapped for a symlink, or a memory folder replaced by one, disables what was read through it", () => {
    store.put({ id: "skill-abc1", kind: "skill", status: "active", noticed: null, fields: { name: "Copy", trigger: "a window opens" } });
    store.put(about("about-aaa", "one"));
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "skill-abc1.md"), readFileSync(join(root, "skills", "skill-abc1.md")));
    rmSync(join(root, "skills"), { recursive: true });
    symlinkSync(elsewhere, join(root, "skills"));
    store.refresh("skill", true);
    expect(store.record("skill-abc1")).toBeNull();
    expect(store.info("skills/skill-abc1").diagnostics[0]?.message).toMatch(/skills is a symlink/);
    // The whole folder swapped for a symlink to a copy of itself.
    const copy = join(dir, "copy");
    cpSync(root, copy, { recursive: true, dereference: false });
    rmSync(root, { recursive: true });
    symlinkSync(copy, root);
    store.refresh("about", true);
    expect(store.record("about-aaa")).toBeNull();
    expect(store.info("about-me").diagnostics[0]?.message).toMatch(/Memory is a symlink/);
  });

  it("#8 a broken record still has its secret refused, on save and when read", () => {
    const text = "# About me\n\n## Bank <!-- caret:id=about-bank kind=about -->\n- Label: Password\n- Value: hunter2\n- Source: typed\n- Status: active\n- Status: active\n";
    expect(sensitiveLine("about-me", text)).toBe("about-me.md:5: Value: Caret doesn't keep passwords in memory, so this record is not used");
  });

  it("#9 fences close only with their own marker, at least as long, and nothing after it", () => {
    const rec = "## Name <!-- caret:id=about-n1 kind=about -->\n- Label: Name\n- Source: typed\n- Status: active\n";
    for (const fence of ["````\n```\n- Value: FROM_CODE\n````\n", "```\n```not-a-closer\n- Value: FROM_CODE\n```\n", "~~~\n```\n- Value: FROM_CODE\n~~~\n"]) {
      const p = parseDocument("about-me", `# About me\n\n${rec}${fence}`);
      expect(p.records, fence).toEqual([]);
      expect(p.diagnostics.map((d) => d.message), fence).toContain("is missing");
    }
  });

  it("#10 an indented heading ends a record, a nested record heading does not lend it fields, and a commented-out record is inactive", () => {
    const rec = "## Name <!-- caret:id=about-n1 kind=about -->\n- Label: Name\n- Source: typed\n- Status: active\n";
    for (const tail of ["  ## Unrelated section\n- Value: NOT_MINE\n", "### Nested <!-- caret:id=about-n2 kind=about -->\n- Value: NOT_MINE\n"]) {
      const p = parseDocument("about-me", `# About me\n\n${rec}${tail}`);
      expect(p.records.map((r) => r.record.id), tail).toEqual([]);
    }
    const commented = `# About me\n\n<!--\n${rec}- Value: Hidden\n-->\n`;
    expect(parseDocument("about-me", commented).records).toEqual([]);
  });

  it("#11 an editor replacing the file right after Caret's install is seen by the next plain refresh", () => {
    store.hooks.afterInstall = () => writeFileSync(path(), readFileSync(path(), "utf8").replace("- Value: two", "- Value: owt"));
    store.put(about("about-aaa", "one"));
    store.put(about("about-aaa", "two"));
    store.hooks.afterInstall = undefined;
    store.refresh("about");
    expect((store.record("about-aaa")?.fields as { value: string }).value).toBe("owt");
    expect(store.takeChanges().map((c) => c.id)).toEqual(["about-aaa"]);
  });

  it("#12 mixed line endings outside the record survive a patch byte for byte", () => {
    const head = "# About me\r\n\nmixed\r\nendings\n\n";
    const text = `${head}${newDocument("about-me", [about("about-aaa", "one")]).split("\n").slice(4).join("\n")}\r\ntrailer\r\n`;
    const p = parseDocument("about-me", text);
    const out = applyRecord(p, about("about-aaa", "uno"));
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith("\r\ntrailer\r\n")).toBe(true);
    expect(out.replace("- Value: uno", "- Value: one")).toBe(text);
  });

  it("#13 a secret in an alias is reported on the alias's own line", () => {
    const text = "# People\n\n## X <!-- caret:id=people-x1 kind=people -->\n- Alias: sk-proj-abcdefghijklmnopqrstuvwxyz012345\n- Name: Dana\n- Status: active\n";
    expect(parseDocument("people", text).diagnostics.map(formatDiagnostic)).toEqual(["people.md:4: Alias: Caret doesn't keep API keys or tokens in memory, so this record is not used"]);
  });
});

describe("fix-check findings (M1 second review)", () => {
  let dir: string;
  let root: string;
  let store: MemoryDocumentStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-memdocs-fixcheck-"));
    root = join(dir, "Memory");
    store = new MemoryDocumentStore(root);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("N2 an aside that became unreadable after the compare (over the size limit) is kept, not deleted", () => {
    store.put({ id: "about-aaa", kind: "about", status: "active", noticed: null, fields: { label: "Name", value: "one", source: "typed" } });
    const base = revisionOf(readFileSync(join(root, "about-me.md")));
    store.hooks.beforeDrop = (aside) => writeFileSync(aside, "x".repeat(MAX_FILE_BYTES + 10));
    expect(() => store.save("about-me", base, "# About me\n\nCaret's\n")).toThrow(/that version is kept as about-me \(conflict/);
    const copies = readdirSync(root).filter((f) => f.includes("(conflict"));
    expect(copies.map((c) => lstatSync(join(root, c)).size)).toEqual([MAX_FILE_BYTES + 10]);
  });

  it("N4 a value holding '<!--' round-trips and hides nothing after it", () => {
    const rs: MemoryRecord[] = [
      { id: "about-c1", kind: "about", status: "active", noticed: null, fields: { label: "Marker", value: "Use <!-- as the opening marker", source: "typed" } },
      { id: "about-c2", kind: "about", status: "active", noticed: null, fields: { label: "Next", value: "still read", source: "typed" } },
    ];
    expect(parseDocument("about-me", newDocument("about-me", rs)).records.map((r) => r.record)).toEqual(rs);
  });

  it("N5 a second Label, or a field Caret does not read, cannot carry a password past a save", () => {
    const rec = "## Bank <!-- caret:id=about-bank kind=about -->\n";
    expect(sensitiveLine("about-me", `# About me\n\n${rec}- Label: Note\n- Label: Password\n- Value: hunter2\n- Source: typed\n- Status: active\n`)).toBe("about-me.md:6: Value: Caret doesn't keep passwords in memory, so this record is not used");
    expect(sensitiveLine("about-me", `# About me\n\n${rec}- Label: Note\n- Value: x\n- Password: hunter2\n- Source: typed\n- Status: active\n`)).toBe("about-me.md:6: Password: Caret doesn't keep passwords in memory, so this record is not used");
    expect(sensitiveLine("about-me", "# About me\n\n- PIN: 4821\n")).toBe("about-me.md:3: Caret doesn't keep passwords in memory");
  });
});

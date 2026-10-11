// CodeRabbit on PR #5, the helper's start: the data directory is closed to other users even when it already existed,
// and a status interval that would flood the log stops the helper before it listens.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

describe("the helper's start", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-start-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("closes a data directory that already existed open to others", () => {
    const data = join(dir, "data");
    mkdirSync(data, { mode: 0o755 });
    chmodSync(data, 0o755);
    const store = new Store(data);
    store.close();
    expect(statSync(data).mode & 0o777).toBe(0o700);
  });

  it.each(["0", "-5", "soon", "2147484"])("refuses --status-every %s before it listens", (every) => {
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const sock = join(dir, "sock", "s.sock");
    const r = spawnSync(process.execPath, [main, "--no-jev", "--socket", sock, "--data-dir", join(dir, "data"), `--status-every=${every}`], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`--status-every must be a positive number of seconds up to 2147483, not '${every}'`);
    expect(existsSync(sock)).toBe(false);
  });
});

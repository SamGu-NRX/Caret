// Where the evaluation scripts exec caret-fixture: inside its app bundle, so macOS can activate it for
// a --foreground run (it will not activate the bare executable). Built by
// apps/screen-reader/scripts/bundle-fixture.sh.
import { existsSync } from "node:fs";
import { join } from "node:path";

export function fixtureExecutable(bin: string): string {
  const exe = join(bin, "CaretFixture.app", "Contents", "MacOS", "caret-fixture");
  if (!existsSync(exe)) throw new Error(`no ${exe}; build it with apps/screen-reader/scripts/bundle-fixture.sh ${bin}`);
  return exe;
}

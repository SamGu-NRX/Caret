// Points the task registry and fixture reads at the held-out pages, in memory, without repository writes.
// From ~/.caret-run/evidence/screen/i1/heldout-hook.mjs; the fixture and held-out paths now come from the recipe
// (CARET_HELDOUT_FIXTURE, CARET_HELDOUT_ROOT) instead of being fixed to caret-v2-wrongs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const fixture = process.env.CARET_HELDOUT_FIXTURE;
const root = process.env.CARET_HELDOUT_ROOT?.replace(/\/?$/, '/');
assert.ok(fixture?.endsWith('/') && root, 'CARET_HELDOUT_FIXTURE (ending in /) and CARET_HELDOUT_ROOT must be set');
const siteURL = new URL('tasks/site.ts', `file://${fixture}`).href;
const manifest = JSON.parse(readFileSync(`${root}manifest.json`, 'utf8'));

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `Task loader changed; expected one occurrence of ${before}`);
  return source.replace(before, after);
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== siteURL) return result;
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    source = replaceOnce(source,
      'export const EXPECT_DIR = fileURLToPath(new URL("./expect/", import.meta.url));',
      `export const EXPECT_DIR = ${JSON.stringify(`${root}tasks/expect/`)};`);
    const start = source.indexOf('export const TASK_PAGES: readonly TaskPage[] = [');
    const end = source.indexOf('\n];', start);
    assert.ok(start >= 0 && end > start, 'Task registry declaration changed');
    source = source.slice(0, start) + `export const TASK_PAGES: readonly TaskPage[] = ${JSON.stringify(manifest)};` + source.slice(end + 3);
    const routes = manifest.map(p => `${JSON.stringify(p.path)}: [${JSON.stringify(`${root}public/tasks/${p.files[0]}`)}, "text/html"],`).join('\n');
    source = replaceOnce(source, 'const STATIC: Record<string, [file: string, type: string]> = {',
      `const STATIC: Record<string, [file: string, type: string]> = {\n${routes}`);
    source = replaceOnce(source, 'readFileSync(`${PUBLIC}${file[0]}`, "utf8")',
      'readFileSync(file[0].startsWith("/") ? file[0] : `${PUBLIC}${file[0]}`, "utf8")');
    return { ...result, source };
  },
});

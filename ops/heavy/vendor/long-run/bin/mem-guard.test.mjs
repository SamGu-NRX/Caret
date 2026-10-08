import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG, decide, danger, parseMemory, parseSwap, readSnapshot, parseProcessTable, readProcessTable,
  identifyProcess, appendLog, perform, runHook, hookFor, createGuard, ownerHookArgs, orphanHookArgs, orphanAlert,
  parseFootprints, readFootprints, topArgs, wantsFootprint, trackFootprints, runawayLimits, runawayRule,
  restartableAppHelper, runawayProtected, ownerOnlyLeaseOwners, decideRunaways, performRunaway,
  postNotification, notifyTimeoutMs, admitNotification, signalPid } from './mem-guard.mjs';
import { spawn } from 'node:child_process';

const GiB = 1024 ** 3;
const now = Date.UTC(2026, 9, 3, 8, 0, 0); // wall clock
const mono0 = 1000000; // monotonic clock
const ctx = { uid: 501, home: '/Users/test', guardPid: 900, ramBytes: 24 * GiB }; // this Mac: 24 GiB
const mode = { ...ctx, unattended: true, dangerSince: null, lastStepAt: null, pending: null };
const createdAt = now - 10000;
// The owner is a script run from a login shell, as a lead would start one.
const shellRow = { pid: 50, ppid: 40, uid: 501, startMs: createdAt - 3600000, command: '-zsh' };
const ownerRow = { pid: 101, ppid: 50, uid: 501, startMs: createdAt - 60000,
  command: '/bin/bash /Users/test/Programming Projects/task/run.sh' };
const child = (pid, parent, changes = {}) => ({ pid, ppid: parent.pid, uid: 501, startMs: parent.startMs + 1000,
  command: '/bin/sleep 60', ...changes });
const sleeper = child(103, ownerRow);
const lease = { id: 'lease-old', ownerPid: 101, run: 'caret-test', kind: 'heavy', createdAt, expiresAt: now + 1e12 };
const id = p => ({ pid: p.pid, startMs: p.startMs });
const sample = (pressure = 1, changes = {}) => ({ now, mono: mono0, pressure, memoryUsedBytes: 18 * GiB,
  diskFreeBytes: 20 * GiB, swapUsedBytes: 8 * GiB, swapTotalBytes: 10 * GiB, ...changes });
const sequence = (count, pressure = 4, changes = {}) => Array.from({ length: count }, (_, index) => {
  const back = (count - 1 - index) * CONFIG.sampleMs;
  return sample(pressure, { ...changes, now: now - back, mono: mono0 - back });
});
const table0 = [shellRow, ownerRow, sleeper];
const run = (history, leases = [lease], table = table0, changes = {}, time = now) =>
  decide(history, leases, table, { ...mode, ...changes }, time);
const nightDanger = () => sequence(3);
// A pending stop whose current stage began 45 seconds ago with danger throughout.
const pendingState = (stage, changes = {}) => ({
  dangerSince: mono0 - CONFIG.killMs,
  pending: { lease: { id: lease.id, run: lease.run, kind: lease.kind, createdAt }, owner: id(ownerRow),
    members: [id(ownerRow), id(sleeper)], stage, stageAt: mono0 - CONFIG.killMs, ...changes },
});
const assertOnlyPositivePids = calls => {
  for (const call of calls.filter(c => c[0] === 'signal')) assert.ok(Number.isSafeInteger(call[1]) && call[1] > 1, `signalled ${call[1]}`);
};

function fakeEffects(changes = {}) {
  const calls = [];
  const rows = changes.rows ?? table0;
  return { calls, context: ctx, identify: pid => rows.find(p => p.pid === pid) ?? null, table: () => rows,
    signal: (pid, signal) => { calls.push(['signal', pid, signal]); return true; },
    release: leaseId => calls.push(['release', leaseId]), leases: () => [lease], stillDanger: () => true,
    hook: async () => { calls.push('hook'); return { code: 0 }; }, ...changes };
}

// Drives createGuard with fake clocks, readers, writers and effects.
function harness({ inventory = { leases: [lease], table: table0 }, effects = {}, io = {} } = {}) {
  const clock = { wall: now, mono: mono0, pressure: 4, inventory };
  const out = { events: [], readings: [], stderr: [], records: [] };
  const calls = [];
  const guard = createGuard({
    observational: false, once: false, context: ctx, running: () => true, unattended: () => true,
    readReading: () => sample(clock.pressure, { now: clock.wall, mono: clock.mono }),
    readInventory: () => clock.inventory, wallNow: () => clock.wall, monoNow: () => clock.mono,
    readFootprints: () => [], notify: () => {}, recordRunaway: () => {},
    writeReading: entry => out.readings.push(entry), writeEvent: entry => out.events.push(entry),
    stderr: text => out.stderr.push(text), print: () => {}, record: entry => out.records.push(entry),
    setInterval: () => 0, clearInterval: () => {},
    effects: { identify: pid => clock.inventory.table.find(p => p.pid === pid) ?? null, table: () => clock.inventory.table,
      signal: (pid, signal) => { calls.push(['signal', pid, signal]); return true; },
      release: leaseId => calls.push(['release', leaseId]), leases: () => clock.inventory.leases,
      hook: async () => ({ code: 1 }), ...effects },
    ...io,
  });
  const step = ({ monoMs = CONFIG.sampleMs, wallMs = monoMs, pressure = 4 } = {}) => {
    clock.mono += monoMs;
    clock.wall += wallMs;
    clock.pressure = pressure;
    return guard.tick();
  };
  return { guard, clock, out, calls, step };
}

// Triggers and modes (unchanged contract).

for (const [name, history] of [
  ['normal', sequence(10, 1)], ['yellow', sequence(10, 2)], ['one critical', sequence(1)], ['two critical', sequence(2)],
]) {
  test(`${name} does not trigger night action with sufficient disk and below ceiling`, () => {
    assert.equal(run(history).type, 'none');
  });
}

test('night third critical reading triggers; an intervening normal or unknown breaks the sequence', () => {
  assert.equal(run(nightDanger()).type, 'term');
  const history = nightDanger();
  for (const replacement of [sample(1, { mono: mono0 - 5000 }), { now, mono: mono0 - 5000, unknown: true }]) {
    assert.equal(run([history[0], replacement, history[2]]).type, 'none');
  }
});

test('critical continuity uses monotonic gaps of at most 2.5 intervals, ignoring wall time', () => {
  const limit = CONFIG.sampleMs * CONFIG.gapFactor;
  const spaced = gap => [sample(4, { mono: mono0 - 5000 - gap }), sample(4, { mono: mono0 - 5000 }), sample(4)];
  assert.equal(run(spaced(limit)).type, 'term');
  assert.equal(run(spaced(limit + 1)).type, 'none');
  // Wall readings an hour apart do not break, or create, continuity.
  assert.equal(run(nightDanger().map((r, i) => ({ ...r, now: now + i * 3600000 }))).type, 'term');
});

test('night disk-and-swap rule is strict below 6 GiB, requires warn/red, and is independent of existing swap total', () => {
  assert.equal(run([sample(2, { diskFreeBytes: 6 * GiB - 1, swapTotalBytes: 100 * GiB })]).type, 'term');
  assert.equal(run([sample(2, { diskFreeBytes: 6 * GiB })]).type, 'none');
  assert.equal(run([sample(1, { diskFreeBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 })]).type, 'none');
});

test('night decimal 23.8 GB ceiling requires critical pressure and includes equality', () => {
  const memoryUsedBytes = CONFIG.unattended.ceilingBytes;
  assert.equal(memoryUsedBytes, 23.8 * 1000 ** 3);
  assert.equal(run([sample(4, { memoryUsedBytes })]).type, 'term');
  assert.equal(run([sample(4, { memoryUsedBytes: memoryUsedBytes - 1 })]).type, 'none');
  assert.equal(run([sample(2, { memoryUsedBytes })]).type, 'none');
});

test('day acts on six critical readings but not five, or any amount of yellow', () => {
  const day = { unattended: false };
  assert.equal(run(sequence(6), [lease], table0, day).type, 'term');
  assert.equal(run(sequence(5), [lease], table0, day).type, 'none');
  assert.equal(run(sequence(100, 2, { diskFreeBytes: 0, memoryUsedBytes: 24 * GiB }), [lease], table0, day).type, 'none');
});

test('day disk trigger requires critical pressure strictly below 4 GiB; night ceiling does not apply', () => {
  const day = { unattended: false };
  assert.equal(run([sample(4, { diskFreeBytes: 4 * GiB - 1 })], [lease], table0, day).type, 'term');
  assert.equal(run([sample(4, { diskFreeBytes: 4 * GiB })], [lease], table0, day).type, 'none');
  assert.equal(run([sample(4, { memoryUsedBytes: 24 * GiB })], [lease], table0, day).type, 'none');
});

test('unreadable sysctl is unknown, not safe or dangerous, and breaks critical continuity', () => {
  const reading = readSnapshot(() => { throw new Error('secret error contents'); }, undefined, now, mono0);
  assert.deepEqual(reading, { now, mono: mono0, unknown: true, error: 'machine reading unavailable or invalid' });
  assert.equal(run([reading]).type, 'unknown');
  assert.equal(danger([reading]), null);
  assert.equal(run([reading, ...sequence(2)]).type, 'none');
  assert.equal(run([sample(4, { memoryUsedBytes: NaN })]).type, 'unknown');
  assert.equal(run([sample(4, { mono: undefined })]).type, 'unknown');
  assert.equal(run(nightDanger(), null, null).type, 'alert');
  assert.equal(run(nightDanger(), null, null, pendingState('owner')).type, 'alert');
  assert.equal(run([sample()], null, null, pendingState('owner')).type, 'none');
});

// Victim selection.

test('only leased jobs are victims: with no live lease, danger is alert-only, even for a big launchd child', () => {
  const browser = { pid: 300, ppid: 1, uid: 501, startMs: createdAt - 1000,
    command: '/Users/test/Library/Caches/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium' };
  const action = run(nightDanger(), [], [shellRow, browser]);
  assert.equal(action.type, 'alert');
  assert.match(action.reason, /no live leased job/);
});

test('alert-only danger goes to events.log and stderr and signals nothing', async () => {
  const h = harness({ inventory: { leases: [], table: table0 } });
  for (let i = 0; i < 3; i++) await h.step();
  assert.equal(h.out.events.at(-1).type, 'alert');
  assert.match(h.out.stderr.at(-1), /mem-guard alert/);
  assert.deepEqual(h.calls, []);
});

test('youngest live eligible lease wins; expired, unsupported, dead, future and undated leases do not', () => {
  const young = { ...lease, id: 'lease-young', kind: 'vm', ownerPid: 102, createdAt: createdAt + 5000 };
  const table = [...table0, { ...ownerRow, pid: 102 }];
  assert.equal(run(nightDanger(), [lease, young], table).lease.id, young.id);
  const ineligible = [{ ...young, expiresAt: now }, { ...young, id: 'dead', ownerPid: 999 }, { ...young, id: 'kind', kind: 'unknown' },
    { ...young, id: 'future', createdAt: now + 1 }, { ...young, id: 'undated', createdAt: undefined }];
  const action = run(nightDanger(), [lease, ...ineligible], table);
  assert.equal(action.lease.id, lease.id);
  assert.deepEqual(action.skipped.map(s => [s.lease, s.reason]), [['future', 'lease createdAt is in the future'],
    ['dead', 'owner not running']]);
  // An undated lease sorts last, so check it alone.
  const undated = run(nightDanger(), [ineligible.at(-1)], table);
  assert.deepEqual([undated.type, undated.skipped[0].reason], ['alert', 'lease has no valid createdAt']);
});

test('finding: a Safari row whose start time is after the lease createdAt is never signalled', async () => {
  const safari = { ...ownerRow, ppid: 1, startMs: createdAt + 60000, command: '/Applications/Safari.app/Contents/MacOS/Safari' };
  const action = run(nightDanger(), [lease], [shellRow, safari]);
  assert.equal(action.type, 'alert');
  assert.deepEqual(action.skipped, [{ lease: lease.id, run: lease.run, ownerPid: 101, reason: 'owner pid reused: process started after the lease' }]);
  // Same pid reused by a non-protected process: still skipped. Tolerance is 2 seconds.
  const reused = startMs => run(nightDanger(), [lease], [shellRow, { ...ownerRow, startMs }]).type;
  assert.equal(reused(createdAt + CONFIG.ownerStartToleranceMs), 'term');
  assert.equal(reused(createdAt + CONFIG.ownerStartToleranceMs + 1), 'alert');
  // Reuse between decision and signal: the re-check sees the later start and skips.
  const term = run(nightDanger());
  const effects = fakeEffects({ rows: [shellRow, safari] });
  const result = await perform(term, false, effects);
  assert.deepEqual(effects.calls, []);
  assert.equal(result.type, 'ineligible');
});

for (const [name, changes, reason = 'owner is a protected process'] of [
  ['Claude', { command: 'node /Users/test/.local/bin/claude --resume' }],
  ['Codex', { command: '/opt/homebrew/bin/codex exec' }],
  ['T3 Code', { command: '/Users/test/Library/Application Support/T3 Code/worker' }],
  ['Safari', { command: '/Applications/Safari.app/Contents/MacOS/Safari' }],
  ['Google Chrome', { command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer' }],
  ['user app', { command: '/Users/test/Applications/Chrome Apps.localized/Mail.app/Contents/MacOS/app_mode_loader' }],
  ['system app', { command: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder' }],
  ['libexec', { command: '/usr/libexec/trustd' }],
  ['other user', { uid: 0 }],
  ['guard pid', { pid: ctx.guardPid }],
  ['guard script', { command: 'node /Users/test/.long-run/bin/mem-guard.mjs' }],
  ['golden VM', { command: '/Users/test/.local/share/lume/lume.app/Contents/MacOS/lume run rig-golden' }],
  ['Lume storage path', { command: 'qemu-system-aarch64 -drive file=/Users/test/.lume/rig-run-3/disk.img' }],
  ['Lume tilde path', { command: 'tool ~/.lume/rig-run-3' }],
  ['empty command', { command: '' }],
  ['zombie', { command: '<defunct>' }, 'owner not running'],
]) {
  test(`a ${name} lease owner is never chosen`, () => {
    const row = { ...ownerRow, ...changes };
    const action = run(nightDanger(), [{ ...lease, ownerPid: row.pid }], [shellRow, row]);
    assert.equal(action.type, 'alert');
    assert.equal(action.skipped[0].reason, reason);
  });
}

test('Xcode and Simulator owners are allowed despite living under /Applications', () => {
  for (const command of ['/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test',
    '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator',
    '/Applications/Xcode-beta.app/Contents/Developer/usr/bin/xcodebuild build']) {
    assert.equal(run(nightDanger(), [lease], [shellRow, { ...ownerRow, command }]).type, 'term', command);
  }
});

test('finding: a protected process in the owner tree is never signalled, and neither is its subtree', async () => {
  const agent = child(102, ownerRow, { command: 'node /Users/test/.local/bin/claude' });
  const agentChild = child(104, agent, { command: '/bin/zsh -c make' });
  const golden = child(105, ownerRow, { command: '/Users/test/.local/share/lume/lume.app/Contents/MacOS/lume run rig-golden' });
  const goldenChild = child(106, golden);
  const table = [shellRow, ownerRow, agent, sleeper, agentChild, golden, goldenChild];
  const term = run(nightDanger(), [lease], table);
  assert.deepEqual(term.members.map(m => m.pid), [101, 103]);
  const escalate = run(nightDanger(), [lease], table, pendingState('owner', { members: term.members }));
  assert.deepEqual(escalate.targets.map(t => t.pid), [101, 103]);
  const effects = fakeEffects({ rows: table });
  await perform(escalate, false, effects);
  assert.deepEqual(effects.calls, [['signal', 101, 'SIGTERM'], ['signal', 103, 'SIGTERM']]);
  // A target that became protected since the decision (exec into codex) is skipped at the re-check.
  const execd = fakeEffects({ rows: [shellRow, ownerRow, { ...sleeper, command: 'codex' }] });
  const result = await perform(escalate, false, execd);
  assert.deepEqual(execd.calls, [['signal', 101, 'SIGTERM']]);
  assert.deepEqual(result.skippedPids, [103]);
});

test('a child that started before its parent is a stale ppid link and is skipped with its subtree', () => {
  const stale = child(107, ownerRow, { startMs: ownerRow.startMs - 1000 });
  const grandchild = child(108, stale);
  assert.deepEqual(run(nightDanger(), [lease], [...table0, stale, grandchild]).members.map(m => m.pid), [101, 103]);
});

test('finding: a pid missing from the snapshot is never signalled; only seen and re-verified pids are', async () => {
  const vanished = { pid: 107, startMs: ownerRow.startMs + 2000 };
  const state = pendingState('owner', { members: [id(ownerRow), id(sleeper), vanished] });
  const escalate = run(nightDanger(), [lease], table0, state);
  assert.deepEqual(escalate.targets.map(t => t.pid), [101, 103]);
  const identified = [];
  const effects = fakeEffects({ identify: pid => { identified.push(pid); return table0.find(p => p.pid === pid) ?? null; } });
  const forged = { ...escalate, targets: [id(ownerRow), vanished, { pid: -101, startMs: 0 }, { pid: 1, startMs: 0 }, { pid: 0, startMs: 0 }] };
  const result = await perform(forged, false, effects);
  assert.deepEqual(effects.calls, [['signal', 101, 'SIGTERM']]);
  assert.deepEqual(result.skippedPids, [107, -101, 1, 0]);
  assert.deepEqual(identified, [101]);
});

test('new victims are spaced by 90 monotonic seconds, including the exact boundary', () => {
  assert.equal(run(nightDanger(), [lease], table0, { lastStepAt: mono0 - 89999 }).type, 'wait');
  assert.equal(run(nightDanger(), [lease], table0, { lastStepAt: mono0 - 90000 }).type, 'term');
});

for (const kind of ['heavy', 'gui', 'vm', 'container', 'browser']) {
  test(`${kind} lease uses the owner ladder and is released only after owner exit`, async () => {
    const theLease = { ...lease, kind };
    const h = harness({ inventory: { leases: [theLease], table: table0 } });
    for (let i = 0; i < 3; i++) await h.step();
    assert.equal(h.guard.state.pending.lease.kind, kind);
    assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM']]);
    for (let i = 0; i < 8; i++) assert.equal((await h.step()).type, 'wait');
    assert.equal((await h.step()).type, 'escalate');
    assert.deepEqual(h.calls.slice(1), [['signal', 101, 'SIGTERM'], ['signal', 103, 'SIGTERM']]);
    for (let i = 0; i < 8; i++) assert.equal((await h.step()).type, 'wait');
    assert.equal((await h.step()).type, 'kill');
    assert.deepEqual(h.calls.slice(3), [['signal', 101, 'SIGKILL'], ['signal', 103, 'SIGKILL']]);
    h.clock.inventory = { leases: [theLease], table: [shellRow] };
    assert.equal((await h.step({ pressure: 1 })).type, 'finished');
    assert.deepEqual(h.calls.at(-1), ['release', theLease.id]);
    assert.equal(h.guard.state.pending, null);
    assertOnlyPositivePids(h.calls);
  });
}

test('browser victim selection keeps heavy owner verification and TTL rules', async () => {
  const browser = { ...lease, kind: 'browser' };
  assert.equal(run(nightDanger(), [{ ...browser, expiresAt: now }]).type, 'alert');
  assert.equal(run(nightDanger(), [{ ...browser, expiresAt: now + 1 }]).type, 'term');
  const dead = run(nightDanger(), [browser], [shellRow]);
  assert.equal(dead.type, 'alert');
  assert.match(dead.skipped[0].reason, /owner not running/);
  const reused = { ...ownerRow, startMs: createdAt + CONFIG.ownerStartToleranceMs + 1 };
  const skipped = run(nightDanger(), [browser], [shellRow, reused]);
  assert.equal(skipped.type, 'alert');
  assert.match(skipped.skipped[0].reason, /owner pid reused/);
  const effects = fakeEffects({ rows: [shellRow, reused], leases: () => [browser] });
  assert.equal((await perform(run(nightDanger(), [browser]), false, effects)).type, 'ineligible');
  assert.deepEqual(effects.calls, []);
});

test('browser owner tree stops cached Playwright but protects Applications Chrome and its subtree', async () => {
  const browser = { ...lease, kind: 'browser' };
  const cached = child(104, ownerRow, {
    command: '/Users/test/Library/Caches/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless' });
  const chrome = child(105, ownerRow, {
    command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless' });
  const chromeChild = child(106, chrome);
  const rows = [...table0, cached, chrome, chromeChild];
  const term = run(nightDanger(), [browser], rows);
  assert.deepEqual(term.members.map(p => p.pid), [101, 103, 104]);
  const effects = fakeEffects({ rows, leases: () => [browser] });
  await perform(term, false, effects);
  const escalate = run(nightDanger(), [browser], rows, pendingState('owner', { lease: term.lease, members: term.members }));
  await perform(escalate, false, effects);
  assert.deepEqual(effects.calls, [['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGTERM'],
    ['signal', 103, 'SIGTERM'], ['signal', 104, 'SIGTERM']]);
});

// Ladder and timing.

test('the ladder: SIGTERM owner, then its tracked tree, then SIGKILL of that same set', async () => {
  const worker = child(102, ownerRow, { command: 'node worker.mjs' });
  const table = [...table0, worker];
  const term = run(nightDanger(), [lease], table);
  assert.deepEqual([term.owner.pid, term.members.map(m => m.pid)], [101, [101, 103, 102]]);
  const effects = fakeEffects({ rows: table });
  await perform(term, false, effects);
  assert.deepEqual(effects.calls, [['signal', 101, 'SIGTERM']]);
  // 45 s later: a new child appeared, and the worker was reparented to launchd.
  // Neither is reachable from the owner as a tracked identity, so neither is a target.
  const newChild = child(109, ownerRow, { startMs: ownerRow.startMs + 50000 });
  const later = [shellRow, ownerRow, sleeper, { ...worker, ppid: 1 }, newChild];
  const state = pendingState('owner', { members: term.members });
  assert.equal(run(nightDanger(), [lease], later, { ...state, dangerSince: mono0 - 44999 }).type, 'wait');
  const escalate = run(nightDanger(), [lease], later, state);
  assert.deepEqual(escalate.targets.map(t => t.pid), [101, 103]);
  // The kill step is the escalation set, rebuilt from the owner again.
  const kill = run(nightDanger(), [lease], later, pendingState('tree', { targets: escalate.targets }));
  assert.deepEqual([kill.type, kill.targets.map(t => t.pid)], ['kill', [101, 103]]);
  const killEffects = fakeEffects({ rows: later });
  await perform(kill, false, killEffects);
  assert.deepEqual(killEffects.calls, [['signal', 101, 'SIGKILL'], ['signal', 103, 'SIGKILL']]);
  assertOnlyPositivePids([...effects.calls, ...killEffects.calls]);
});

test('blocking: a worker that execs into a protected program takes its subtree out of steps 2 and 3', async () => {
  const worker = child(102, ownerRow, { command: 'node worker.mjs' });
  const grandchild = child(104, worker, { command: '/bin/sleep 600' });
  const before = [...table0, worker, grandchild];
  const term = run(nightDanger(), [lease], before);
  assert.deepEqual(term.members.map(m => m.pid), [101, 103, 102, 104]);
  const after = [...table0, { ...worker, command: 'node /Users/test/.local/bin/claude' }, grandchild];
  // Step 2, decided after the exec.
  const escalate = run(nightDanger(), [lease], after, pendingState('owner', { members: term.members }));
  assert.deepEqual(escalate.targets.map(t => t.pid), [101, 103]);
  // Step 2, decided before the exec and performed after it: the fresh snapshot in perform drops 102 and 104.
  const stale = { ...escalate, targets: term.members };
  const effects = fakeEffects({ rows: after });
  const result = await perform(stale, false, effects);
  assert.deepEqual(effects.calls, [['signal', 101, 'SIGTERM'], ['signal', 103, 'SIGTERM']]);
  assert.deepEqual(result.skippedPids, [102, 104]);
  // Step 3, same rule.
  const kill = run(nightDanger(), [lease], after, pendingState('tree', { targets: term.members }));
  assert.deepEqual(kill.targets.map(t => t.pid), [101, 103]);
  const killEffects = fakeEffects({ rows: after });
  await perform({ ...kill, targets: term.members }, false, killEffects);
  assert.deepEqual(killEffects.calls, [['signal', 101, 'SIGKILL'], ['signal', 103, 'SIGKILL']]);
});

test('perform: an owner that shows Claude at its signal-time re-check aborts steps 1, 2 and 3 with nothing signalled', async () => {
  const claude = { ...ownerRow, command: 'node /Users/test/.local/bin/claude' };
  // The snapshot still shows the owner unprotected; only the per-pid re-check sees Claude.
  const reCheck = pid => pid === 101 ? claude : table0.find(p => p.pid === pid) ?? null;
  const term = run(nightDanger());
  const steps = [term, { ...term, type: 'escalate', targets: term.members }, { ...term, type: 'kill', targets: term.members }];
  for (const action of steps) {
    const effects = fakeEffects({ identify: reCheck });
    const result = await perform(action, false, effects);
    assert.deepEqual([result.type, effects.calls], ['ineligible', []], action.type);
  }
  // Step 1 with a hook: eligible before the hook, Claude at the re-check after it.
  let checks = 0;
  const hooked = fakeEffects({ rows: rigTable, leases: () => [rigLease],
    identify: pid => (pid === 101 && checks++ > 0 ? claude : rigTable.find(p => p.pid === pid) ?? null),
    hook: async () => ({ code: 1 }) });
  const result = await perform(rigAction(), false, hooked);
  assert.deepEqual([result.type, hooked.calls], ['ineligible', []]);
});

test('perform: a middle process that shows protected at re-check takes its subtree out; siblings proceed', async () => {
  const worker = child(102, ownerRow, { command: 'node worker.mjs' });
  const grandchild = child(104, worker, { command: '/bin/sleep 600' });
  const greatGrandchild = child(106, grandchild, { command: '/bin/sleep 600' });
  const rows = [...table0, worker, grandchild, greatGrandchild];
  const targets = [id(ownerRow), id(sleeper), id(worker), id(grandchild), id(greatGrandchild)];
  for (const type of ['escalate', 'kill']) {
    const effects = fakeEffects({ rows, identify: pid => pid === 102 ? { ...worker, command: 'codex exec' } : rows.find(p => p.pid === pid) ?? null });
    const result = await perform({ ...run(nightDanger(), [lease], rows), type, targets }, false, effects);
    const signal = type === 'kill' ? 'SIGKILL' : 'SIGTERM';
    assert.deepEqual(effects.calls, [['signal', 101, signal], ['signal', 103, signal]], type);
    assert.deepEqual(result.skippedPids, [102, 104, 106]);
  }
});

test('an owner that becomes protected while a stop is pending ends the stop without signals or release', async () => {
  const state = pendingState('owner');
  const execd = [shellRow, { ...ownerRow, command: 'codex exec' }, sleeper];
  assert.equal(run(nightDanger(), [lease], execd, state).type, 'ineligible');
  const h = harness();
  for (let i = 0; i < 3; i++) await h.step();
  h.clock.inventory = { leases: [lease], table: execd };
  assert.equal((await h.step()).type, 'ineligible');
  assert.equal(h.guard.state.pending, null);
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM']]);
});

test('finding: a forward wall-clock jump triggers nothing early', async () => {
  // Pure decision: stage began 10 monotonic seconds ago; the wall clock says a day passed.
  const state = pendingState('owner', { stageAt: mono0 - 10000 });
  assert.equal(run(nightDanger().map(r => ({ ...r, now: r.now + 86400000 })), [lease], table0, state, now + 86400000).type, 'wait');
  assert.equal(run(nightDanger(), [lease], table0, { lastStepAt: mono0 - 1000 }, now + 86400000).type, 'wait');
  // Loop: each tick after the first stop jumps the wall clock by an hour.
  const h = harness();
  for (let i = 0; i < 3; i++) await h.step();
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM']]);
  const types = [];
  for (let i = 0; i < 9; i++) types.push((await h.step({ wallMs: 3600000 })).type);
  assert.deepEqual(types, [...Array(8).fill('wait'), 'escalate']);
});

test('finding: escalation resumes after an interrupted danger period, counted from the resumption', async () => {
  // Pure decision: danger resumed 30 s after the stop.
  const resumed = mono0 - CONFIG.killMs + 1;
  const state = pendingState('owner', { stageAt: resumed - 30000 });
  assert.equal(run(nightDanger(), [lease], table0, { ...state, dangerSince: resumed }).type, 'wait');
  assert.equal(run(nightDanger(), [lease], table0, { ...state, dangerSince: resumed - 1 }).type, 'escalate');
  // Loop: stop at tick 3, three more critical ticks, one normal tick, then danger again.
  const h = harness();
  for (let i = 0; i < 3; i++) await h.step();
  for (let i = 0; i < 3; i++) await h.step();
  assert.equal((await h.step({ pressure: 1 })).type, 'none');
  for (let i = 0; i < 3; i++) await h.step(); // third critical reading: danger resumes here
  const types = [];
  for (let i = 0; i < 9; i++) types.push((await h.step()).type);
  assert.deepEqual(types, [...Array(8).fill('wait'), 'escalate']);
});

test('a pending victim that exited is cleared and its lease released', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.step();
  h.clock.inventory = { leases: [lease], table: [shellRow] };
  const result = await h.step({ pressure: 1 });
  assert.equal(result.type, 'finished');
  assert.equal(h.guard.state.pending, null);
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM'], ['release', lease.id]]);
});

test('finding: release waits for a fresh check that the owner exited or its pid was reused later', async () => {
  const killEffects = fakeEffects();
  await perform(run(nightDanger(), [lease], table0, pendingState('tree', { targets: [id(ownerRow)] })), false, killEffects);
  assert.deepEqual(killEffects.calls, [['signal', 101, 'SIGKILL']]);
  assert.equal(run([sample()], [lease], table0, pendingState('killed')).type, 'none');
  assert.equal(run(nightDanger(), [lease], table0, pendingState('killed')).type, 'alert');
  // Owner gone: finished even if a former child survives, since nothing is reached except through the owner.
  assert.equal(run([sample()], [lease], [shellRow, { ...sleeper, ppid: 1 }], pendingState('killed')).type, 'finished');
  assert.equal(run([sample()], [lease], [shellRow], pendingState('killed')).type, 'finished');
  const reused = [shellRow, { ...ownerRow, ppid: 1, startMs: ownerRow.startMs + 5000, command: 'Safari' }];
  const finished = run([sample()], [lease], reused, pendingState('killed'));
  assert.equal(finished.type, 'finished');
  assert.equal(run([sample()], [lease], [shellRow, { ...ownerRow, command: '<defunct>' }], pendingState('killed')).type, 'finished');
  const effects = fakeEffects();
  assert.equal((await perform(finished, false, effects)).released, true);
  assert.deepEqual(effects.calls, [['release', lease.id]]);
});

// Stop hook.

const rigLease = { ...lease, id: 'lease-rig', run: 'rig', kind: 'vm' };
const otherRigOwner = { ...ownerRow, pid: 201 };
const otherRig = { ...rigLease, id: 'lease-rig-2', ownerPid: 201, createdAt: createdAt - 5000 };
const rigTable = [...table0, otherRigOwner];
const rigAction = () => run(nightDanger(), [rigLease, otherRig], rigTable);

test('finding: the hook matches the exact run name rig; right-sizing does not', () => {
  assert.equal(hookFor({ run: 'right-sizing' }), undefined);
  assert.equal(hookFor({ run: 'rig-clone' }), undefined);
  assert.equal(hookFor({ run: 'constructor' }), undefined);
  assert.equal(hookFor({ run: 'rig' }), CONFIG.stopHooks.rig);
  assert.equal(run(nightDanger(), [{ ...lease, run: 'right-sizing' }]).hook, undefined);
  const action = rigAction();
  assert.equal(action.owner.pid, 101);
  assert.deepEqual(action.hook, { command: '~/.long-run/rig/bin/rig-stop', timeoutMs: 60000 });
});

for (const [name, hookResult, described] of [
  ['non-zero exit', { code: 1 }, 'exit 1'],
  ['unknown-option exit', { code: 64 }, 'exit 64'],
  ['timeout', { timedOut: true, code: null, signal: 'SIGKILL' }, 'timed out; hook process group killed'],
  ['spawn failure', { error: 'stop hook could not start' }, 'stop hook could not start'],
]) {
  test(`finding: rig-stop ${name} with the lease present falls back to SIGTERM of that owner alone`, async () => {
    const effects = fakeEffects({ rows: rigTable, leases: () => [rigLease, otherRig],
      hook: async (hook, args) => { effects.calls.push(['hook', args]); return hookResult; } });
    const result = await perform(rigAction(), false, effects);
    assert.equal(result.type, 'term');
    assert.equal(result.hookResult, described);
    assert.deepEqual(effects.calls, [['hook', ['--only', '101', '--grace', '0']], ['signal', 101, 'SIGTERM']]);
  });
}

test('rig-stop that released the lease, unreadable leases, or ended danger send no signal', async () => {
  const released = fakeEffects({ leases: () => [otherRig], hook: async () => ({ code: 1 }) });
  assert.equal((await perform(rigAction(), false, released)).type, 'hook-released');
  const unreadable = fakeEffects({ leases: () => { throw new Error('unreadable'); }, hook: async () => ({ code: 1 }) });
  assert.equal((await perform(rigAction(), false, unreadable)).type, 'alert');
  const calm = fakeEffects({ leases: () => [rigLease], stillDanger: () => false, hook: async () => ({ code: 1 }) });
  assert.equal((await perform(rigAction(), false, calm)).type, 'aborted');
  assert.deepEqual([...released.calls, ...unreadable.calls, ...calm.calls], []);
});

for (const [name, changes] of [
  ['Claude', { command: 'node /Users/test/.local/bin/claude bin/rig-run' }],
  ['Codex', { command: 'codex exec bin/rig-run' }],
  ['T3', { command: '/Users/test/Library/T3 Code/worker bin/rig-run' }],
  ['rig-golden', { command: '/bin/bash /Users/test/.long-run/rig/bin/rig-run rig-golden' }],
  ['~/.lume', { command: '/bin/bash /Users/test/.long-run/rig/bin/rig-run /Users/test/.lume/rig-run-7' }],
  ['another uid', { uid: 0 }],
  ['a changed identity', { startMs: ownerRow.startMs + 1000 }],
  ['gone', null],
]) {
  test(`blocking: a rig owner that is now ${name} gets no hook and no signal`, async () => {
    const rows = changes ? [shellRow, { ...ownerRow, ...changes }, otherRigOwner] : [shellRow, otherRigOwner];
    const effects = fakeEffects({ rows, leases: () => [rigLease, otherRig],
      hook: async () => { effects.calls.push('hook'); return { code: 0 }; } });
    const result = await perform(rigAction(), false, effects);
    assert.equal(result.type, 'ineligible');
    assert.deepEqual(effects.calls, []);
  });
}

test('blocking: an ineligible owner at hook time is logged, leaves no pending stop, and does not use the 90-second spacing', async () => {
  const hooks = [];
  const h = harness({ inventory: { leases: [rigLease], table: table0 },
    effects: { identify: pid => pid === 101 ? { ...ownerRow, command: 'node /Users/test/.local/bin/claude' } : null,
      hook: async (hook, args) => { hooks.push(args); return { code: 0 }; } } });
  for (let i = 0; i < 3; i++) await h.step();
  assert.equal(h.out.events.at(-1).type, 'ineligible');
  assert.deepEqual([h.guard.state.pending, h.guard.state.lastStepAt, hooks, h.calls], [null, null, [], []]);
});

const lumeChild = child(105, ownerRow, { command: '/Users/test/.local/share/lume/lume.app/Contents/MacOS/lume run rig-run-7' });

test('ruling: a rig lease gets an owner-only ladder, so its Lume child is never signalled', async () => {
  const rows = [...table0, lumeChild, otherRigOwner];
  const term = run(nightDanger(), [rigLease], rows);
  assert.deepEqual(term.members.map(m => m.pid), [101]);
  const rigPending = stage => ({ dangerSince: mono0 - CONFIG.killMs, pending: { lease: { id: rigLease.id, run: 'rig', kind: 'vm', createdAt },
    owner: id(ownerRow), members: term.members, targets: term.members, stage, stageAt: mono0 - CONFIG.killMs } });
  assert.deepEqual(run(nightDanger(), [rigLease], rows, rigPending('owner')).targets.map(t => t.pid), [101]);
  const kill = run(nightDanger(), [rigLease], rows, rigPending('tree'));
  assert.deepEqual(kill.targets.map(t => t.pid), [101]);
  // Even a forged target list cannot reach the Lume child.
  const effects = fakeEffects({ rows });
  await perform({ ...kill, targets: [id(ownerRow), id(lumeChild)] }, false, effects);
  assert.deepEqual(effects.calls, [['signal', 101, 'SIGKILL']]);
});

// Runs the loop through SIGKILL of the owner, then shows the owner gone.
async function ladderThenExit(orphanResult, run = 'rig', orphanSweep = true) {
  const theLease = { ...rigLease, run };
  const hooks = [];
  const h = harness({ inventory: { leases: [theLease], table: [...table0, lumeChild] },
    effects: { orphanSweep, hook: async (hook, args) => { hooks.push([...args]); return args[0] === '--orphans' ? orphanResult : { code: 1 }; } } });
  let result;
  for (let i = 0; i < 40 && result?.type !== 'kill'; i++) result = await h.step();
  assert.equal(result.type, 'kill');
  h.clock.inventory = { leases: [theLease], table: [shellRow, { ...lumeChild, ppid: 1 }] };
  result = await h.step();
  await h.step();
  return { h, hooks, result };
}

test('caret: rig-stop --orphans runs once after a rig owner is SIGKILLed and confirmed gone', async () => {
  const { h, hooks, result } = await ladderThenExit({ code: 0 });
  assert.equal(result.type, 'finished');
  assert.deepEqual(hooks, [ownerHookArgs(101), [...orphanHookArgs]]);
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGKILL'], ['release', rigLease.id]]);
  assert.equal(h.out.events.some(e => e.reason === orphanAlert), false);
});

test('caret: other runs never call rig-stop --orphans', async () => {
  const { hooks, result } = await ladderThenExit({ code: 0 }, 'caret-test');
  assert.equal(result.type, 'finished');
  assert.deepEqual(hooks, []);
  // No sweep when the owner exited without a SIGKILL from the guard.
  const exited = run([sample()], [rigLease], [shellRow], { pending: { lease: { id: rigLease.id, run: 'rig', kind: 'vm', createdAt },
    owner: id(ownerRow), members: [id(ownerRow)], targets: [id(ownerRow)], stage: 'killed', stageAt: mono0, ownerKilled: false } });
  assert.deepEqual([exited.type, exited.orphanSweep], ['finished', undefined]);
});

for (const [name, orphanResult] of [['non-zero exit', { code: 64 }], ['timeout', { code: null, signal: 'SIGKILL', timedOut: true }],
  ['spawn failure', { error: 'stop hook could not start' }]]) {
  test(`caret: rig-stop --orphans ${name} writes the alert and signals nothing more`, async () => {
    const { h, result } = await ladderThenExit(orphanResult);
    assert.equal(result.alert, orphanAlert);
    const alert = h.out.events.find(e => e.type === 'alert' && e.reason === orphanAlert);
    assert.deepEqual([alert.lease.id, alert.owner.pid], [rigLease.id, 101]);
    assert.ok(h.out.stderr.some(line => line.includes(orphanAlert)));
    assert.deepEqual(h.calls.slice(3), [['release', rigLease.id]]);
    assertOnlyPositivePids(h.calls);
    assert.equal(h.calls.some(c => c[1] === lumeChild.pid), false);
  });
}

test('switch: CONFIG.orphanSweep is on, so a rig SIGKILL is followed by rig-stop --orphans', async () => {
  assert.equal(CONFIG.orphanSweep, true);
  const { h, hooks, result } = await ladderThenExit({ code: 0 }, 'rig', null); // null: no override, use CONFIG
  assert.equal(result.type, 'finished');
  assert.deepEqual(hooks, [ownerHookArgs(101), [...orphanHookArgs]]);
  assert.equal(h.out.events.some(e => e.reason === orphanAlert), false);
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGKILL'], ['release', rigLease.id]]);
});

test('switch: with the sweep off, after a rig SIGKILL only the alert is written', async () => {
  const { h, hooks, result } = await ladderThenExit({ code: 0 }, 'rig', false);
  assert.equal(result.type, 'finished');
  assert.deepEqual(hooks, [ownerHookArgs(101)]);
  const alert = h.out.events.find(e => e.type === 'alert' && e.reason === orphanAlert);
  assert.deepEqual([alert.lease.id, alert.owner.pid], [rigLease.id, 101]);
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGTERM'], ['signal', 101, 'SIGKILL'], ['release', rigLease.id]]);
});

test('caret: a rig-stop --orphans timeout kills only the hook process group', async () => {
  const { calls, timers, hookChild, deps } = fakeHookDeps();
  const pending = runHook(CONFIG.stopHooks.rig, orphanHookArgs, deps);
  assert.equal(timers[0].ms, 60000);
  timers[0].fn();
  hookChild.emit('exit', null, 'SIGKILL');
  assert.equal((await pending).timedOut, true);
  assert.deepEqual(calls, [
    ['spawn', '/Users/test/.long-run/rig/bin/rig-stop', ['--orphans', '--grace', '0'], { detached: true, stdio: 'ignore' }],
    ['kill', -4242, 'SIGKILL'],
  ]);
});

function fakeHookDeps() {
  const calls = [], timers = [];
  const hookChild = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
  const deps = { home: '/Users/test',
    spawn: (file, args, options) => { calls.push(['spawn', file, args, options]); return hookChild; },
    kill: (pid, signal) => { calls.push(['kill', pid, signal]); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} };
  return { calls, timers, hookChild, deps };
}

test('finding: a hook timeout kills only the hook process group', async () => {
  const { calls, timers, hookChild, deps } = fakeHookDeps();
  const pending = runHook(CONFIG.stopHooks.rig, ownerHookArgs(101), deps);
  assert.equal(timers[0].ms, 60000);
  timers[0].fn();
  hookChild.signalCode = 'SIGKILL';
  hookChild.emit('exit', null, 'SIGKILL');
  assert.deepEqual(await pending, { code: null, signal: 'SIGKILL', timedOut: true });
  assert.deepEqual(calls, [
    ['spawn', '/Users/test/.long-run/rig/bin/rig-stop', ['--only', '101', '--grace', '0'], { detached: true, stdio: 'ignore' }],
    ['kill', -4242, 'SIGKILL'],
  ]);
});

test('a hook that already exited, or failed to start, is never killed', async () => {
  const exited = fakeHookDeps();
  const pending = runHook(CONFIG.stopHooks.rig, ownerHookArgs(101), exited.deps);
  exited.hookChild.exitCode = 1;
  exited.hookChild.emit('exit', 1, null);
  assert.deepEqual(await pending, { code: 1, signal: null, timedOut: false });
  exited.timers[0].fn();
  const failed = fakeHookDeps();
  const failing = runHook(CONFIG.stopHooks.rig, ownerHookArgs(101), failed.deps);
  failed.hookChild.pid = undefined;
  failed.hookChild.emit('error', new Error('ENOENT'));
  assert.deepEqual(await failing, { error: 'stop hook could not start' });
  failed.timers[0].fn();
  assert.deepEqual([...exited.calls, ...failed.calls].filter(c => c[0] === 'kill'), []);
});

// Loop robustness.

test('finding: log, record and stderr writes that throw keep the loop alive', async () => {
  const fail = () => { throw new Error('disk full'); };
  const h = harness({ io: { writeReading: fail, writeEvent: fail, record: fail, stderr: fail, print: fail } });
  const types = [];
  for (let i = 0; i < 4; i++) types.push((await h.step()).type);
  assert.deepEqual(types, ['none', 'none', 'term', 'wait']);
  assert.deepEqual(h.calls, [['signal', 101, 'SIGTERM']]);
  assert.equal(h.guard.state.pending.owner.pid, 101);
});

test('a failed reading or inventory is contained, and the next tick proceeds', async () => {
  let broken = true;
  const h = harness({ io: { readInventory: () => { if (broken) throw new Error('ps failed'); return { leases: [lease], table: table0 }; } } });
  for (let i = 0; i < 2; i++) await h.step();
  assert.equal((await h.step()).type, 'alert');
  broken = false;
  const flaky = harness({ io: { readReading: () => { throw new Error('sysctl'); } } });
  assert.equal((await flaky.step()).reason, 'guard step failed');
  assert.equal(flaky.guard.state.dangerSince, null);
  assert.equal((await h.step()).type, 'term');
});

test('dry-run does not run hooks, signals, lease release or re-checks', async () => {
  const effects = new Proxy({}, { get() { throw new Error('dry-run side effect'); } });
  const term = rigAction();
  for (const action of [term, { ...term, type: 'escalate', targets: term.members }, { ...term, type: 'kill', targets: term.members },
    { ...term, type: 'finished' }]) {
    assert.equal(await perform(action, true, effects), action);
  }
});

test('decide is pure and actions carry no command text', () => {
  const table = [shellRow, ownerRow, sleeper].map(p => Object.freeze({ ...p, command: `${p.command} --token secret-token` }));
  const history = nightDanger().map(Object.freeze);
  const inputs = [history, [Object.freeze(lease)], table, Object.freeze({ ...mode }), now];
  const before = JSON.stringify(inputs);
  const result = decide(...inputs);
  assert.equal(result.type, 'term');
  assert.equal(JSON.stringify(inputs), before);
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

// Parsers and logs.

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 100.\nPages purgeable: 10.\nPages wired down: 20.\nPages occupied by compressor: 30.\nPages stored in compressor: 999999.\n`;
test('memory parser counts app minus purgeable, wired and physical compressor with dynamic page size', () => {
  assert.equal(parseMemory(vmStat), 140 * 16384);
  assert.equal(parseMemory(vmStat.replace('16384', '4096')), 140 * 4096);
  assert.throws(() => parseMemory('unreadable'), /page size/);
  assert.throws(() => parseMemory(vmStat.replace('Pages purgeable: 10.', 'Pages purgeable: 101.')), /invalid/);
});

test('swap and snapshot parsers expose byte units, carry both clocks, and mark malformed output unknown', () => {
  assert.deepEqual(parseSwap('total = 1024.00M used = 768.00M free = 256.00M'), { swapUsedBytes: 0.75 * GiB, swapTotalBytes: GiB });
  assert.throws(() => parseSwap('total = 1G used = 2G'), /exceeds/);
  const machine = (file, args) => file.endsWith('vm_stat') ? vmStat : args[1] === 'vm.swapusage' ? 'total = 2G used = 1G' : '2';
  const reading = readSnapshot(machine, () => ({ bavail: 10n, bsize: 4096n }), now, mono0);
  assert.deepEqual([reading.pressure, reading.diskFreeBytes, reading.swapUsedBytes, reading.now, reading.mono], [2, 40960, GiB, now, mono0]);
  assert.equal(readSnapshot(() => 'not a sysctl', undefined, now, mono0).unknown, true);
});

test('process table comes from one UTC ps call and parses pid, ppid, pgid, uid, start and command', () => {
  const text = '  101    50   101   501 Sat Oct  3 08:00:00 2026     /bin/bash /x/run.sh --token secret\n' +
    '    7     1     7    -2 Thu Jan  1 00:00:05 2026 /usr/libexec/thing\n  300   101   101   501 Sat Oct  3 08:00:01 2026     <defunct>\n';
  const calls = [];
  const rows = readProcessTable((...args) => { calls.push(args); return text; });
  assert.deepEqual(calls, [['/bin/ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,command='], { TZ: 'UTC', LC_ALL: 'C' }]]);
  assert.deepEqual(rows[0], { pid: 101, ppid: 50, pgid: 101, uid: 501, startMs: Date.UTC(2026, 9, 3, 8, 0, 0), command: '/bin/bash /x/run.sh --token secret' });
  assert.deepEqual([rows[1].uid, rows[1].startMs], [-2, Date.UTC(2026, 0, 1, 0, 0, 5)]);
  assert.equal(rows[2].command, '<defunct>');
  assert.throws(() => parseProcessTable('garbage'), /unreadable/);
  assert.throws(() => parseProcessTable('1 1 1 1 Sat Foo  3 08:00:00 2026 x'), /unreadable/);
  assert.throws(() => parseProcessTable('  101    50   501 Sat Oct  3 08:00:00 2026 /bin/bash'), /unreadable/, 'the old five-column form');
});

test('identifyProcess returns only the asked-for pid and treats any failure as unverified', () => {
  const row = '  101    50   101   501 Sat Oct  3 08:00:00 2026 /bin/bash run.sh';
  assert.equal(identifyProcess(101, () => row).startMs, Date.UTC(2026, 9, 3, 8, 0, 0));
  assert.equal(identifyProcess(102, () => row), null);
  assert.equal(identifyProcess(101, () => { throw new Error('exit 1'); }), null);
  assert.equal(identifyProcess(101, () => ''), null);
});

test('logs rotate at 5 MB with one backup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-guard-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'readings.log');
  fs.writeFileSync(file, 'x'.repeat(CONFIG.rotateBytes));
  appendLog(file, { now, pressure: 1 });
  assert.equal(fs.statSync(`${file}.1`).size, CONFIG.rotateBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { now, pressure: 1 });
  fs.writeFileSync(file, 'y'.repeat(CONFIG.rotateBytes));
  appendLog(file, { now: now + 1 });
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8')[0], 'y');
});

// Brief 45: runaway processes.

const MiB = 1024 ** 2;
// Real readings from ~/.long-run/mem-guard/readings.log, 4 October 2026, CDT (UTC-5):
// [time, pressure, memoryUsedBytes, swapUsedBytes, swapTotalBytes, diskFreeBytes].
// The guard logs normal-pressure readings once a minute, so 02:04:13 to 02:04:28 were
// not logged; they repeat 02:04:08. 02:05:24, a re-read before a leased stop, is left out.
const oct4 = [
  ['02:04:08', 1, 21243641856, 7067727298.56, 8589934592, 14170271744],
  ['02:04:13', 1, 21243641856, 7067727298.56, 8589934592, 14170271744],
  ['02:04:18', 1, 21243641856, 7067727298.56, 8589934592, 14170271744],
  ['02:04:23', 1, 21243641856, 7067727298.56, 8589934592, 14170271744],
  ['02:04:28', 1, 21243641856, 7067727298.56, 8589934592, 14170271744],
  ['02:04:33', 2, 22257074176, 6983841218.56, 8589934592, 14093213696],
  ['02:04:38', 2, 22503440384, 7432306688, 8589934592, 14104952832],
  ['02:04:43', 2, 22476980224, 8659927040, 9663676416, 13023031296],
  ['02:04:48', 2, 21968371712, 9741145210.88, 10737418240, 11937619968],
  ['02:04:53', 2, 22425321472, 9811127173.12, 10737418240, 11931492352],
  ['02:04:58', 2, 22368468992, 11101735485.44, 11811160064, 10996387840],
  ['02:05:03', 2, 22358032384, 12419795517.44, 12884901888, 10228813824],
  ['02:05:08', 2, 22176628736, 13114540032, 13958643712, 9185632256],
  ['02:05:13', 2, 22279880704, 14296547328, 15032385536, 8124981248],
  ['02:05:18', 2, 22407217152, 15794238914.56, 16106127360, 7049502720],
  ['02:05:23', 2, 22597697536, 16372591493.12, 17179869184, 5977513984],
  ['02:05:28', 4, 22308077568, 17326732738.56, 18253611008, 4915671040],
  ['02:05:33', 4, 22841409536, 17758808965.12, 18253611008, 4906708992],
  ['02:05:38', 4, 22216392704, 18524730818.56, 19327352832, 3840122880],
  ['02:05:43', 4, 22515728384, 19218426757.12, 20401094656, 2748272640],
].map(([time, pressure, memoryUsedBytes, swapUsedBytes, swapTotalBytes, diskFreeBytes]) => {
  const [h, m, s] = time.split(':').map(Number);
  const wall = Date.UTC(2026, 9, 4, h + 5, m, s);
  return { now: wall, mono: mono0 + (wall - Date.UTC(2026, 9, 4, 7, 4, 8)), pressure, memoryUsedBytes, diskFreeBytes, swapUsedBytes, swapTotalBytes };
});
const cdt = wall => new Date(wall - 5 * 3600000).toISOString().slice(11, 19);
const growthStart = Date.UTC(2026, 9, 4, 7, 4, 38); // 02:04:38 CDT, when swap began to climb
const longAgo = oct4[0].now - 3600000;
// What top prints: whole MiB below 10000 MiB, else whole GiB, rounded (humanize_number).
const topCell = bytes => Math.round(bytes / MiB) < 10000 ? `${Math.round(bytes / MiB)}M` : `${Math.round(bytes / GiB)}G`;
const topText = rows => 'Processes: 1233 total, 8 running, 1225 sleeping, 6691 threads\n2026/10/04 02:05:03\n\nPID    MEM   COMMAND         \n' +
  [...rows].sort((a, b) => b.bytes - a.bytes).map(r => `${String(r.pid).padEnd(7)}${topCell(r.bytes).padEnd(6)}${r.name.slice(0, 16)}`).join('\n') + '\n';

const T3 = '/Applications/T3 Code (Nightly).app';
const t3Main = { pid: 782, ppid: 1, uid: 501, startMs: longAgo, command: `${T3}/Contents/MacOS/T3 Code (Nightly)` };
const helperExe = `${T3}/Contents/Frameworks/T3 Code (Nightly) Helper.app/Contents/MacOS/T3 Code (Nightly) Helper`;
// The runaway is always pid 1156 (the panic report's pid); its command varies by test.
const t3Child = command => ({ pid: 1156, ppid: 782, uid: 501, startMs: longAgo + 1000, command });
const t3 = {
  gpu: t3Child(`${helperExe} --type=gpu-process --user-data-dir=/Users/test/Library/T3 --secret-token=abc`),
  network: t3Child(`${helperExe} --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US`),
  nodeService: t3Child(`${helperExe} --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US`),
  renderer: t3Child(`${T3}/Contents/Frameworks/T3 Code (Nightly) Helper (Renderer).app/Contents/MacOS/T3 Code (Nightly) Helper (Renderer) --type=renderer`),
  // T3's server today: the main executable run again as a child of the main process, with no --type.
  server: t3Child(`${T3}/Contents/MacOS/T3 Code (Nightly) ${T3}/Contents/Resources/app.asar/server.mjs`),
  main: { ...t3Main, pid: 1156 },
};
const nodeRunaway = { pid: 1156, ppid: 50, uid: 501, startMs: longAgo,
  command: '/opt/homebrew/bin/node /Users/test/Programming Projects/app/record-preview.mjs --secret-token=abc' };
// Other rows from a real top read today, so the runaway is not alone in the table.
const background = [
  { row: { pid: 430, ppid: 1, uid: 88, startMs: longAgo, command: '/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon' }, bytes: 1185 * MiB, name: 'WindowServer' },
  { row: { pid: 1574, ppid: 1, uid: 501, startMs: longAgo, command: '/Applications/Snipaste.app/Contents/MacOS/Snipaste' }, bytes: 721 * MiB, name: 'Snipaste' },
  { row: { pid: 87620, ppid: 50, uid: 501, startMs: longAgo, command: '/opt/homebrew/bin/codex' }, bytes: 405 * MiB, name: 'codex' },
];

// Replays the 4 October readings through createGuard, with a stubbed footprint table
// in which the runaway grows 1.2 GiB per 5 s from 02:04:38. extraTicks repeats the
// last reading 5 s apart to cover more than a minute.
async function replay({ runaway = nodeRunaway, name = 'node', base = 937 * MiB, footprintAt, killHelpers, observational = false,
  extraTicks = 0, identify, notify, onSignal, monoNow, signalResult, table: extraRows = [] } = {}) {
  const readings = [...oct4, ...Array.from({ length: extraTicks }, (_, k) =>
    ({ ...oct4.at(-1), now: oct4.at(-1).now + (k + 1) * 5000, mono: oct4.at(-1).mono + (k + 1) * 5000 }))];
  const grow = footprintAt ?? (wall => wall < growthStart ? base : base + Math.floor((wall - growthStart) / 5000) * 1.2 * GiB);
  const live = { table: [shellRow, t3Main, ...background.map(b => b.row), ...extraRows, runaway] };
  const out = { events: [], stderr: [], notes: [], records: [], reads: [], calls: [] };
  let i = 0;
  const guard = createGuard({
    observational, once: false, context: ctx, running: () => true, unattended: () => true,
    readReading: () => readings[i], readInventory: () => ({ leases: [], table: live.table }),
    readFootprints: () => {
      out.reads.push(cdt(readings[i].now));
      const present = live.table.some(p => p.pid === runaway.pid);
      return parseFootprints(topText([...background.map(b => ({ pid: b.row.pid, bytes: b.bytes, name: b.name })), ...(present ? [{ pid: runaway.pid, bytes: grow(readings[i].now), name }] : [])]));
    },
    wallNow: () => readings[i].now, monoNow: monoNow ? () => monoNow(readings[i]) : () => readings[i].mono,
    writeReading: () => {}, writeEvent: entry => out.events.push(entry), stderr: text => out.stderr.push(text), print: () => {},
    record: entry => out.records.push(entry), recordRunaway: entry => out.records.push(entry),
    notify: notify ?? ((title, message) => out.notes.push(message)),
    setInterval: () => 0, clearInterval: () => {}, runawayKillAppHelpers: killHelpers,
    effects: { identify: identify ?? (pid => live.table.find(p => p.pid === pid) ?? null), table: () => live.table,
      signal: (pid, signal) => { out.calls.push([cdt(readings[i].now), pid, signal]); onSignal?.(pid, signal, live); return signalResult ? signalResult(pid, signal, readings[i]) : true; },
      release: () => {}, leases: () => [], hook: async () => ({ code: 1 }) },
  });
  for (; i < readings.length; i++) await guard.tick();
  return { out, guard, live };
}
const runawayNotes = out => out.notes.filter(n => /runaway|app helper/i.test(n));

test('brief 45: on the 4 October readings, an unprotected runaway gets SIGTERM at 02:05:03, then SIGKILL 10 s later', async () => {
  const { out, guard } = await replay();
  assert.deepEqual(out.calls, [['02:05:03', 1156, 'SIGTERM'], ['02:05:13', 1156, 'SIGKILL']]);
  assert.ok(out.calls[0][0] <= '02:05:10');
  // Footprints were read only from the first danger sign (pressure 2 at 02:04:33).
  assert.equal(out.reads[0], '02:04:33');
  assert.deepEqual(out.records.map(r => r.type), ['runaway-term', 'runaway-kill']);
  assert.match(out.records[0].reason, /grew at least .* within 30 s/);
  assert.equal(runawayNotes(out).length, 3); // SIGTERM, SIGKILL, and "still present" (the fake process never exits)
  // The leased rule still runs: no lease, disk under 6 GiB at 02:05:23, one notification for it.
  assert.equal(out.notes.filter(n => n.startsWith('Memory danger, nothing leased to stop')).length, 1);
  assert.equal(guard.state.lastStepAt, null, 'a runaway stop does not use the 90-second leased spacing');
  assert.equal(JSON.stringify([out.events, out.notes, out.records]).includes('secret'), false);
});

test('brief 45: the worst case, growth from a zero footprint, still gets SIGTERM by 02:05:10', async () => {
  const { out } = await replay({ base: 0 });
  assert.deepEqual(out.calls[0], ['02:05:08', 1156, 'SIGTERM']);
});

test('brief 45: a runaway that exits after SIGTERM is finished and recorded; one that shrinks is not killed', async () => {
  const exits = await replay({ onSignal: (pid, signal, live) => { live.table = live.table.filter(p => p.pid !== pid); } });
  assert.deepEqual(exits.out.calls, [['02:05:03', 1156, 'SIGTERM']]);
  assert.deepEqual(exits.out.records.map(r => r.type), ['runaway-term', 'runaway-finished']);
  assert.deepEqual(exits.guard.state.runaways, []);
  const shrinks = await replay({ footprintAt: wall => wall <= Date.UTC(2026, 9, 4, 7, 5, 3)
    ? 937 * MiB + Math.max(0, Math.floor((wall - growthStart) / 5000)) * 1.2 * GiB : 2 * GiB });
  assert.deepEqual(shrinks.out.calls, [['02:05:03', 1156, 'SIGTERM']]);
  assert.ok(shrinks.out.events.some(e => e.type === 'runaway-released'));
});

test('the helper kill is on by default since 4 October (the 02:10 panic was T3\'s GPU process)', () => {
  assert.equal(CONFIG.runawayKillAppHelpers, true);
});

test('brief 45: a protected runaway with runawayKillAppHelpers false only alerts, one notification per minute', async () => {
  // Explicit false: the default is now true, and this path must still alert only.
  const { out } = await replay({ runaway: t3.gpu, name: 'T3 Code (Nightly) Helper', extraTicks: 14, killHelpers: false });
  assert.deepEqual(out.calls, []);
  const alerts = out.events.filter(e => e.type === 'runaway-alert');
  assert.equal(cdt(alerts[0].now), '02:05:03');
  assert.equal(alerts[0].protected, true);
  assert.ok(out.stderr.some(line => line.includes('runaway-alert')));
  // 02:05:03 to 02:06:53: alerts every 5 s, notifications at 02:05:03 and 02:06:03 only.
  assert.equal(runawayNotes(out).length, 2);
  assert.equal(out.records.length, 0);
  assert.equal(JSON.stringify([out.events, out.notes]).includes('secret'), false);
});

for (const kind of ['renderer', 'main', 'server', 'nodeService']) {
  test(`brief 45: a protected ${kind} is never signalled, with runawayKillAppHelpers either way`, async () => {
    for (const killHelpers of [false, true]) {
      const { out } = await replay({ runaway: t3[kind], name: 'T3 Code (Nightly', killHelpers });
      assert.deepEqual(out.calls, [], `killHelpers ${killHelpers}`);
      assert.ok(out.events.some(e => e.type === 'runaway-alert'));
    }
  });
}

for (const kind of ['gpu', 'network']) {
  test(`brief 45: with runawayKillAppHelpers true, a ${kind} helper is SIGKILLed once and nothing else is`, async () => {
    const { out, guard } = await replay({ runaway: t3[kind], name: 'T3 Code (Nightly', killHelpers: true });
    assert.deepEqual(out.calls, [['02:05:03', 1156, 'SIGKILL']]);
    assert.equal(out.records[0].type, 'runaway-helper-kill');
    assert.deepEqual(out.records[0].parent, { pid: 782, startMs: longAgo });
    assert.equal(guard.state.runaways[0].stage, 'killed');
    assert.ok(out.events.some(e => e.reason === 'runaway still present after SIGKILL'));
  });
}

test('brief 45: the app-helper test needs the bundle layout, the main parent, one allowed --type and this user', () => {
  const ok = row => restartableAppHelper(row, t3Main, ctx);
  assert.equal(ok(t3.gpu), true);
  assert.equal(ok(t3.network), true);
  for (const kind of ['renderer', 'main', 'server', 'nodeService']) assert.equal(ok(t3[kind]), false, kind);
  assert.equal(ok({ ...t3.gpu, command: `${t3.gpu.command} --type=renderer` }), false, 'two --type flags');
  assert.equal(ok({ ...t3.gpu, command: t3.gpu.command.replace('--type=gpu-process', '--type=gpu-processx') }), false);
  assert.equal(ok({ ...t3.gpu, ppid: 1 }), false, 'not a child of the main process');
  assert.equal(ok({ ...t3.gpu, uid: 0 }), false, 'another user');
  assert.equal(ok({ ...t3.gpu, startMs: longAgo - 1000 }), false, 'started before its parent: stale ppid');
  assert.equal(ok({ ...t3.gpu, pid: ctx.guardPid }), false, 'the guard itself');
  assert.equal(restartableAppHelper(t3.gpu, { ...t3Main, command: '/Applications/Other.app/Contents/MacOS/Other' }, ctx), false, 'another app');
  assert.equal(restartableAppHelper(t3.gpu, { ...t3Main, command: `${t3Main.command} --type=utility` }, ctx), false, 'parent is a helper');
  assert.equal(ok({ ...t3.gpu, command: `/Users/test/Applications/T3.app/Contents/Frameworks/H.app/Contents/MacOS/H --type=gpu-process` }), false);
  assert.equal(ok({ ...t3.gpu, command: `${T3}/Contents/MacOS/T3 Code (Nightly) --type=gpu-process` }), false, 'not under Frameworks');
});

test('brief 45: a pid reused by a different process is never signalled', async () => {
  // Reused between the decision and the signal: the re-check sees a later start time.
  const reused = pid => pid === 1156 ? { ...nodeRunaway, startMs: nodeRunaway.startMs + 5000 } : null;
  const replayed = await replay({ identify: reused });
  assert.deepEqual(replayed.out.calls, []);
  assert.ok(replayed.out.events.some(e => e.type === 'runaway-ineligible'));
  const helper = await replay({ runaway: t3.gpu, name: 'T3', killHelpers: true,
    identify: pid => pid === 1156 ? { ...t3.gpu, startMs: t3.gpu.startMs + 5000 } : pid === 782 ? t3Main : null });
  assert.deepEqual(helper.out.calls, []);
  // Every action type, against a pid now held by Safari, or by a process at the same start but a different parent.
  const effects = { context: ctx, identify: pid => (pid === 1156 ? { ...nodeRunaway, startMs: nodeRunaway.startMs + 1000, command: '/Applications/Safari.app/Contents/MacOS/Safari' } : t3Main),
    signal: () => { throw new Error('signalled'); } };
  const target = { pid: 1156, startMs: nodeRunaway.startMs };
  for (const type of ['runaway-term', 'runaway-kill', 'runaway-helper-kill']) {
    const result = performRunaway({ type, target, name: 'x', parent: { pid: 782, startMs: longAgo } }, false, effects, true);
    assert.equal(result.type, 'runaway-ineligible', type);
  }
  // A reused pid starts a fresh footprint history, so it inherits no growth.
  const first = trackFootprints(new Map(), [nodeRunaway], [{ pid: 1156, lowBytes: 1 * GiB, highBytes: 1 * GiB, name: 'node' }], mono0);
  const reusedRow = { ...nodeRunaway, startMs: nodeRunaway.startMs + 3000 };
  const second = trackFootprints(first, [reusedRow], [{ pid: 1156, lowBytes: 7 * GiB, highBytes: 7 * GiB, name: 'node' }], mono0 + 5000);
  assert.deepEqual([...second.values()][0].samples.length, 1);
  assert.equal(decideRunaways(second, [reusedRow], { ...mode, runaways: [] }, mono0 + 5000).length, 0);
  // A pid in top but not in the earlier ps snapshot is not tracked at all.
  assert.equal(trackFootprints(new Map(), [shellRow], [{ pid: 1156, lowBytes: 20 * GiB, highBytes: 20 * GiB, name: 'x' }], mono0).size, 0);
});

test('brief 45: the guard, launchd, kernel and other users are never signalled as runaways', () => {
  const huge = row => trackFootprints(new Map(), [row], [{ pid: row.pid, lowBytes: 20 * GiB, highBytes: 20 * GiB, name: 'x' }], mono0);
  for (const row of [{ ...nodeRunaway, pid: ctx.guardPid }, { ...nodeRunaway, command: 'node /Users/test/.long-run/bin/mem-guard.mjs' },
    { ...nodeRunaway, uid: 0 }, { ...nodeRunaway, pid: 1 }, { ...nodeRunaway, pid: 0 }, background[0].row]) {
    const actions = decideRunaways(huge(row), [row], { ...mode, runaways: [] }, mono0, { killHelpers: true });
    assert.deepEqual(actions.map(a => a.type), ['runaway-alert'], row.command);
  }
  // Forged actions are re-checked at signal time.
  const effects = { context: ctx, identify: pid => [{ ...nodeRunaway, pid: ctx.guardPid }].find(p => p.pid === pid) ?? null,
    signal: () => { throw new Error('signalled'); } };
  for (const pid of [ctx.guardPid, 1, 0, -1156]) {
    assert.equal(performRunaway({ type: 'runaway-kill', target: { pid, startMs: nodeRunaway.startMs }, name: 'x' }, false, effects, true).type, 'runaway-ineligible');
  }
  assert.equal(performRunaway({ type: 'runaway-helper-kill', target: id(t3.gpu), parent: id(t3Main), name: 'x' }, false,
    { context: ctx, identify: pid => [t3.gpu, t3Main].find(p => p.pid === pid), signal: () => { throw new Error('signalled'); } }, false).type,
  'runaway-ineligible', 'the switch is re-checked at signal time');
});

test('brief 45: a notification failure does not throw or stop the stop', async () => {
  const { out } = await replay({ notify: () => { throw new Error('osascript missing'); } });
  assert.deepEqual(out.calls.map(c => c[2]), ['SIGTERM', 'SIGKILL']);
  assert.ok(out.events.some(e => e.type === 'notify-failed'));
});

test('brief 45: dry run decides and logs a runaway but never signals, records or notifies', async () => {
  const { out } = await replay({ observational: true });
  assert.deepEqual([out.calls, out.records, out.notes], [[], [], []]);
  assert.deepEqual(out.events.filter(e => e.type.startsWith('runaway-')).slice(0, 2).map(e => [cdt(e.now), e.type]),
    [['02:05:03', 'runaway-term'], ['02:05:13', 'runaway-kill']]);
});

test('brief 45: footprints are read only on pressure 2 or more, a 0.5 GiB swap rise, or a pending stop', () => {
  const calm = sample(1), rise = changes => [calm, sample(1, { mono: mono0 + 5000, ...changes })];
  assert.equal(wantsFootprint([calm], false), false);
  assert.equal(wantsFootprint([sample(2)], false), true);
  assert.equal(wantsFootprint(rise({ swapUsedBytes: calm.swapUsedBytes + 0.5 * GiB - 1 }), false), false);
  assert.equal(wantsFootprint(rise({ swapUsedBytes: calm.swapUsedBytes + 0.5 * GiB }), false), true);
  assert.equal(wantsFootprint([{ now, mono: mono0, unknown: true }], false), false);
  assert.equal(wantsFootprint([{ now, mono: mono0, unknown: true }], true), true);
});

test('brief 45: a failed footprint read is logged, signals nothing, and leaves a pending stop waiting', async () => {
  let fail = false;
  const h = harness({ io: { readFootprints: () => { if (fail) throw new Error('top timed out'); return []; } } });
  fail = true;
  assert.equal((await h.step()).type, 'none');
  assert.ok(h.out.events.some(e => e.reason === 'footprint reading unavailable'));
  const waiting = decideRunaways(null, [nodeRunaway], { ...mode, runaways: [{ target: id(nodeRunaway), name: 'node', stage: 'term', stageAt: mono0 - 10000 }] }, mono0);
  assert.deepEqual(waiting.map(a => a.type), ['runaway-wait']);
});

test('brief 45: the rule takes the low end of a rounded reading and needs growth within 30 s', () => {
  const limits = runawayLimits(24 * GiB);
  assert.deepEqual(limits, { floorBytes: 6 * GiB, hugeBytes: 12 * GiB });
  assert.deepEqual(runawayLimits(64 * GiB), { floorBytes: 16 * GiB, hugeBytes: 32 * GiB });
  assert.throws(() => runawayLimits(undefined), /RAM size/);
  const read = (text, mono) => ({ mono, ...parseFootprints(`PID MEM COMMAND\n1156 ${text} x\n`)[0] });
  // "12G" may be 11.5 GiB: not half of RAM. "13G" is at least 12.5 GiB.
  assert.equal(runawayRule([read('12G', mono0)], limits), null);
  assert.equal(runawayRule([read('13G', mono0)], limits).rule, 'half-ram');
  assert.equal(runawayRule([read('5000M', mono0 - 30000), read('7000M', mono0)], limits).rule, 'growth');
  assert.equal(runawayRule([read('5000M', mono0 - 30001), read('7000M', mono0)], limits), null, 'outside the window');
  assert.equal(runawayRule([read('6144M', mono0 - 5000), read('7168M', mono0)], limits), null, 'exactly 1 GiB displayed is not proven');
  assert.equal(runawayRule([read('6000M', mono0 - 5000), read('6143M', mono0)], limits), null, 'below the floor');
  assert.equal(runawayRule([read('7000M', mono0)], limits), null, 'no earlier sample');
});

test('brief 45: top output parses as footprint ranges; the read is one top call', () => {
  const real = 'Processes: 1233 total, 8 running\nPhysMem: 22G used\n\nPID    MEM   COMMAND         \n430    1185M WindowServer    \n' +
    '1038   937M  T3 Code (Nightly\n1156   25G+  T3 Code (Nightly\n7      12K   tiny\n8      512B  bytes\n';
  const rows = parseFootprints(real);
  assert.deepEqual(rows.map(r => [r.pid, r.name]), [[430, 'WindowServer'], [1038, 'T3 Code (Nightly'], [1156, 'T3 Code (Nightly'], [7, 'tiny'], [8, 'bytes']]);
  assert.ok(rows[2].lowBytes >= 24.49 * GiB && rows[2].lowBytes < 24.5 * GiB && rows[2].highBytes > 25.5 * GiB);
  assert.deepEqual([rows[4].lowBytes, rows[4].highBytes], [512, 512]);
  assert.throws(() => parseFootprints('no header'), /unreadable/);
  assert.throws(() => parseFootprints('PID MEM COMMAND\n1 1.5G x\n'), /unreadable/);
  const calls = [];
  readFootprints((...args) => { calls.push(args); return real; });
  assert.deepEqual(calls, [['/usr/bin/top', [...topArgs], { LC_ALL: 'C' }]]);
});

test('brief 45: a runaway is still stopped while a 60-second stop hook runs', async () => {
  let interval, releaseHook;
  const reads = [5000 * MiB, 5000 * MiB, 5000 * MiB, 7000 * MiB];
  const runawayRow = { ...nodeRunaway, pid: 1156 };
  const table = [...table0, runawayRow];
  const h = harness({ inventory: { leases: [rigLease], table },
    effects: { hook: () => new Promise(resolve => { releaseHook = resolve; }) },
    io: { setInterval: fn => { interval = fn; return 1; },
      readFootprints: () => parseFootprints(topText([{ pid: 1156, bytes: reads.shift() ?? 7000 * MiB, name: 'node' }])) } });
  for (let i = 0; i < 2; i++) await h.step();
  const third = h.step(); // the third critical reading starts the rig hook, which does not return
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof interval, 'function');
  assert.deepEqual(h.calls, []);
  h.clock.mono += CONFIG.sampleMs;
  interval();
  assert.deepEqual(h.calls, [['signal', 1156, 'SIGTERM']]);
  releaseHook({ code: 0 });
  await third;
});

test('brief 45: nice is 0', () => {
  assert.equal(CONFIG.nice, 0);
});

// Fixes from the fresh review of the runaway rule.

test('review: a direct child of a protected app and any Lume process are protected; deeper agent and shell work is not', async () => {
  const table = rows => new Map(rows.map(p => [p.pid, p]));
  const appChild = { ...nodeRunaway, ppid: 782, command: '/opt/homebrew/bin/node /tmp/server.mjs' };
  assert.equal(runawayProtected(appChild, table([t3Main, appChild]), ctx), true);
  const { out } = await replay({ runaway: appChild });
  assert.deepEqual(out.calls, []);
  assert.ok(out.events.some(e => e.type === 'runaway-alert'));
  for (const command of ['/Users/test/.local/share/lume/lume.app/Contents/MacOS/lume run rig-run-7', '/opt/homebrew/bin/lume serve']) {
    const row = { ...nodeRunaway, command };
    assert.equal(runawayProtected(row, table([shellRow, row]), ctx), true, command);
    assert.deepEqual((await replay({ runaway: row })).out.calls, [], command);
  }
  assert.equal(runawayProtected({ ...nodeRunaway, command: '/usr/bin/volume-tool' }, table([shellRow]), ctx), false);
  // A T3 terminal's command, an agent's tool, and an Xcode child stay eligible.
  const t3Shell = { pid: 2000, ppid: 782, uid: 501, startMs: longAgo + 2000, command: '/bin/zsh -il' };
  const claudeCli = { pid: 3000, ppid: 50, uid: 501, startMs: longAgo, command: 'node /Users/test/.local/bin/claude' };
  const xcodebuild = { pid: 4000, ppid: 50, uid: 501, startMs: longAgo, command: '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test' };
  for (const parent of [t3Shell, claudeCli, xcodebuild]) {
    const row = { ...nodeRunaway, ppid: parent.pid };
    assert.equal(runawayProtected(row, table([t3Main, parent, row]), ctx), false, parent.command);
  }
  const viaShell = await replay({ runaway: { ...nodeRunaway, ppid: 2000 }, table: [t3Shell] });
  assert.deepEqual(viaShell.out.calls[0], ['02:05:03', 1156, 'SIGTERM']);
});

test('review: the 10 seconds before SIGKILL count from the SIGTERM, even when the reads were slow', async () => {
  const sizes = [5000, 5000, 7000], slowAt = 3;
  let reads = 0;
  const h = harness({ inventory: { leases: [], table: [...table0, nodeRunaway] },
    io: { readFootprints: () => {
      reads += 1;
      if (reads === slowAt) h.clock.mono += 10200; // ps and top took 10.2 s on the tick that sends SIGTERM
      return parseFootprints(topText([{ pid: 1156, bytes: (sizes[reads - 1] ?? 8000) * MiB, name: 'node' }]));
    } } });
  for (let i = 0; i < 3; i++) await h.step();
  assert.deepEqual(h.calls, [['signal', 1156, 'SIGTERM']]);
  await h.step({ monoMs: 1 }); // the late loop samples again at once: 1 ms after the SIGTERM
  await h.step();
  assert.deepEqual(h.calls, [['signal', 1156, 'SIGTERM']]);
  await h.step();
  assert.deepEqual(h.calls, [['signal', 1156, 'SIGTERM'], ['signal', 1156, 'SIGKILL']]);
});

test('review: the helper rule needs a launchd-started main parent, and re-reads the target last', () => {
  const server = { ...t3.server, pid: 1500 };
  assert.equal(restartableAppHelper({ ...t3.gpu, ppid: 1500, startMs: server.startMs }, server, ctx), false, 'server as parent');
  assert.equal(restartableAppHelper({ ...t3.gpu }, { ...t3Main, ppid: 50 }, ctx), false, 'main not started by launchd');
  const order = [];
  const result = performRunaway({ type: 'runaway-helper-kill', target: id(t3.gpu), parent: id(t3Main), name: 'x' }, false,
    { context: ctx, identify: pid => { order.push(pid); return [t3.gpu, t3Main].find(p => p.pid === pid); }, signal: () => true }, true);
  assert.deepEqual([order, result.signalled], [[782, 1156], [1156]]);
});

test('review: the runaway rule never signals a live rig lease owner; its stop stays with rig-stop and the leased ladder', async () => {
  const hooks = [], sizes = [5000, 5000, 7000];
  const h = harness({ inventory: { leases: [rigLease], table: table0 },
    effects: { hook: async (hook, args) => { hooks.push([...args]); return { code: 1 }; } },
    io: { readFootprints: () => parseFootprints(topText([{ pid: 101, bytes: (sizes.shift() ?? 9000) * MiB, name: 'bash' }])) } });
  for (let i = 0; i < 5; i++) await h.step();
  // Only the leased ladder acted: rig-stop, then its SIGTERM fallback. No runaway SIGTERM or SIGKILL.
  assert.deepEqual([hooks, h.calls], [[ownerHookArgs(101)], [['signal', 101, 'SIGTERM']]]);
  assert.ok(h.out.events.some(e => e.type === 'runaway-alert' && e.target.pid === 101));
  assert.deepEqual(ownerOnlyLeaseOwners([rigLease, { ...rigLease, ownerPid: 7, expiresAt: now }, { ...lease, ownerPid: 8 }], now), new Set([101]));
  assert.deepEqual(ownerOnlyLeaseOwners(null, now), new Set());
});

test('review: a runaway that execs into Lume after SIGTERM is not SIGKILLed', async () => {
  const lume = '/Users/test/.local/share/lume/lume.app/Contents/MacOS/lume serve';
  const { out } = await replay({ onSignal: (pid, signal, live) => {
    live.table = live.table.map(p => p.pid === pid ? { ...p, command: lume } : p);
  } });
  assert.deepEqual(out.calls, [['02:05:03', 1156, 'SIGTERM']]);
  assert.ok(out.events.some(e => e.type === 'runaway-ineligible' && /became protected/.test(e.reason)));
  // The signal-time re-check alone also refuses it.
  const result = performRunaway({ type: 'runaway-kill', target: id(nodeRunaway), name: 'node' }, false,
    { context: ctx, identify: () => ({ ...nodeRunaway, command: lume }), signal: () => { throw new Error('signalled'); } }, false);
  assert.equal(result.type, 'runaway-ineligible');
});

test('review: a signal that was not delivered does not advance the stop and is retried', async () => {
  const failOnce = new Set(['02:05:03 SIGTERM', '02:05:18 SIGKILL']);
  const { out, guard } = await replay({ signalResult: (pid, signal, r) => !failOnce.has(`${cdt(r.now)} ${signal}`) });
  assert.deepEqual(out.calls, [['02:05:03', 1156, 'SIGTERM'], ['02:05:08', 1156, 'SIGTERM'],
    ['02:05:18', 1156, 'SIGKILL'], ['02:05:23', 1156, 'SIGKILL']]);
  assert.equal(out.events.filter(e => e.type === 'runaway-signal-failed').length, 2);
  assert.equal(out.notes.filter(n => n.startsWith('SIGKILL sent')).length, 1);
  assert.deepEqual(out.records.map(r => r.type), ['runaway-term', 'runaway-kill']);
  assert.equal(guard.state.runaways[0].stage, 'killed');
});

test('review: missing from top\'s list releases a pending stop only when the smallest listed entry is below the floor', () => {
  const state = { ...mode, runaways: [{ target: id(nodeRunaway), name: 'node', stage: 'term', stageAt: mono0 - 10000 }] };
  const types = absent => decideRunaways(new Map(), [nodeRunaway], state, mono0, { absentAtMostBytes: absent }).map(a => a.type);
  assert.deepEqual(types(7 * GiB), ['runaway-wait']);
  assert.deepEqual(types(Infinity), ['runaway-wait']);
  assert.deepEqual(types(300 * MiB), ['runaway-released']);
});

test('review: a stopping guard sends no runaway signal from the hook interval', async () => {
  let interval, releaseHook, running = true;
  const reads = [5000 * MiB, 5000 * MiB, 5000 * MiB, 7000 * MiB];
  const h = harness({ inventory: { leases: [rigLease], table: [...table0, nodeRunaway] },
    effects: { hook: () => new Promise(resolve => { releaseHook = resolve; }) },
    io: { running: () => running, setInterval: fn => { interval = fn; return 1; },
      readFootprints: () => parseFootprints(topText([{ pid: 1156, bytes: reads.shift() ?? 7000 * MiB, name: 'node' }])) } });
  for (let i = 0; i < 2; i++) await h.step();
  const third = h.step();
  await new Promise(resolve => setImmediate(resolve));
  running = false;
  h.clock.mono += CONFIG.sampleMs;
  interval();
  assert.deepEqual(h.calls, []);
  releaseHook({ code: 0 });
  await third;
});

// A stand-in for osascript's ChildProcess, with timers the test fires by hand.
function fakeNotifier({ spawnThrows = false } = {}) {
  const children = [], timers = [];
  const deps = {
    spawn: (file, args, options) => {
      if (spawnThrows) throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
      const child = Object.assign(new EventEmitter(), { file, args, options, exitCode: null, signalCode: null, killedWith: null,
        kill(signal) { this.killedWith = signal; return true; }, unref() {} });
      children.push(child);
      return child;
    },
    // fire() runs the callback only if it was not cleared, as a real timer would.
    setTimeout: (fn, ms) => { const timer = { ms, cleared: false, fire() { if (!this.cleared) fn(); }, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  };
  return { children, timers, deps };
}

const failureModes = {
  'spawn error': (child, timer) => child.emit('error', Object.assign(new Error('spawn /usr/bin/osascript ENOENT'), { code: 'ENOENT' })),
  'non-zero exit': (child, timer) => { child.exitCode = 1; child.emit('exit', 1, null); },
  'timeout': (child, timer) => timer.fire(),
};
const failureReasons = {
  'spawn error': 'osascript could not start: ENOENT',
  'non-zero exit': 'osascript exited 1',
  'timeout': `osascript timed out after ${notifyTimeoutMs / 1000} s; killed`,
};

for (const [kind, fail] of Object.entries(failureModes)) {
  test(`notification: a ${kind} is reported once, after postNotification has returned`, () => {
    const { children, timers, deps } = fakeNotifier();
    const failures = [];
    assert.equal(postNotification('mem-guard', 'secret message', reason => failures.push(reason), deps), undefined);
    assert.deepEqual(failures, [], 'nothing is reported synchronously, so the caller never waits');
    assert.equal(children[0].file, '/usr/bin/osascript');
    assert.equal(children[0].options.timeout, undefined, 'timed by the guard, not by spawn');
    assert.equal(timers[0].ms, notifyTimeoutMs);
    fail(children[0], timers[0]);
    // Whatever follows the failure (exit after a kill, error after exit) adds nothing.
    children[0].emit('exit', null, 'SIGKILL');
    children[0].emit('error', new Error('late'));
    timers[0].fire();
    assert.deepEqual(failures, [failureReasons[kind]]);
    assert.equal(failures[0].includes('secret'), false);
    assert.equal(children[0].killedWith, kind === 'timeout' ? 'SIGKILL' : null);
    if (kind !== 'timeout') assert.equal(timers[0].cleared, true);
  });

  test(`notification: the guard logs one notify-failed event per failed post (${kind}) and still stops the runaway`, async () => {
    const { children, timers, deps } = fakeNotifier();
    let reportedDuringPost = 0;
    const { out } = await replay({ notify: (title, message, onFailure) => {
      let posting = true;
      postNotification(title, message, reason => { if (posting) reportedDuringPost++; onFailure(reason); }, deps);
      posting = false;
      // Fail later, while the replay's clock is still in range.
      const k = children.length - 1;
      queueMicrotask(() => { fail(children[k], timers[k]); children[k].emit('exit', null, 'SIGKILL'); timers[k].fire(); });
    } });
    assert.equal(reportedDuringPost, 0);
    assert.deepEqual(out.calls.map(c => c[2]), ['SIGTERM', 'SIGKILL']);
    assert.ok(children.length >= 2);
    const failed = out.events.filter(e => e.type === 'notify-failed');
    assert.equal(failed.length, children.length);
    for (const entry of failed) {
      assert.equal(entry.reason, failureReasons[kind]);
      assert.equal(typeof entry.notification, 'string');
    }
  });
}

test('notification: a clean exit reports nothing; a spawn that throws is reported and does not throw', () => {
  const ok = fakeNotifier(), failures = [];
  postNotification('mem-guard', 'hello', reason => failures.push(reason), ok.deps);
  ok.children[0].exitCode = 0;
  ok.children[0].emit('exit', 0, null);
  assert.equal(ok.timers[0].cleared, true);
  assert.deepEqual(failures, []);
  const throwing = fakeNotifier({ spawnThrows: true });
  assert.doesNotThrow(() => postNotification('mem-guard', 'hello', reason => failures.push(reason), throwing.deps));
  assert.deepEqual(failures, ['osascript could not start: EAGAIN']);
  // A failure callback that throws is contained too.
  const bad = fakeNotifier();
  postNotification('mem-guard', 'hello', () => { throw new Error('log down'); }, bad.deps);
  assert.doesNotThrow(() => bad.children[0].emit('exit', 2, null));
});

test('notification rate limit: keys 10 periods old are pruned on write; recent keys still rate-limit', () => {
  const every = CONFIG.runaway.notifyEveryMs, map = new Map();
  assert.equal(admitNotification(map, 'old', 0), true);
  assert.equal(admitNotification(map, 'edge', 0.5 * every), true);
  assert.equal(admitNotification(map, 'recent', 9.8 * every), true);
  assert.equal(admitNotification(map, 'recent', 10 * every), false, 'within one period: limited');
  assert.deepEqual([...map.keys()], ['old', 'edge', 'recent'], 'a refused write prunes nothing');
  assert.equal(admitNotification(map, 'new', 10.5 * every), true);
  // old is 10.5 periods old and edge exactly 10: both go. recent (0.7 periods) stays.
  assert.deepEqual([...map.keys()].sort(), ['new', 'recent']);
  assert.equal(admitNotification(map, 'recent', 10.5 * every), false, 'a kept recent key still rate-limits');
  assert.equal(admitNotification(map, 'recent', 10.8 * every), true, 'and is admitted again after one period');
  assert.equal(map.get('recent'), 10.8 * every);
});

// The one test that sends a real signal. It signals only the /bin/sleep child it
// spawned, and only through performRunaway with the guard's real effects:
// identifyProcess (ps, pid plus start time) and signalPid (main's signal effect).
test('real signal: SIGTERM reaches a verified child; a mismatched start time is refused and the child survives', async t => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  // Cleanup touches only this child, and only while it is unreaped, so its pid cannot be reused.
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pid = child.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
  // Wait until ps shows the exec'd command, so the start time is the child's own.
  let row = null;
  for (let tries = 0; tries < 50 && row?.command !== '/bin/sleep 30'; tries++) {
    row = identifyProcess(pid);
    if (row?.command !== '/bin/sleep 30') await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(row?.command, '/bin/sleep 30');
  const effects = { context: { uid: process.getuid(), home: os.homedir(), guardPid: process.pid },
    identify: p => (p === pid ? identifyProcess(p) : null), // never reads, so never signals, another pid
    signal: (p, signal) => { assert.equal(p, pid, 'only the child is ever signalled'); return signalPid(p, signal); } };

  const refused = performRunaway({ type: 'runaway-term', target: { pid, startMs: row.startMs + 1000 }, name: 'sleep' }, false, effects, false);
  assert.equal(refused.type, 'runaway-ineligible');
  assert.deepEqual(refused.signalled, []);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.deepEqual(identifyProcess(pid), row, 'the same process is still running');

  const sent = performRunaway({ type: 'runaway-term', target: { pid, startMs: row.startMs }, name: 'sleep' }, false, effects, false);
  assert.equal(sent.signal, 'SIGTERM');
  assert.deepEqual(sent.signalled, [pid]);
  assert.deepEqual(await exited, { code: null, signal: 'SIGTERM' });
});

// Stop targets. The owner is the queue runner (ownerRow, pid 101). Its job leads group 201; 202 is in that group;
// 203 is 202's child that left the group with setsid. The job started after the lease was created.
const leaderStartMs = createdAt + 2000;
const jobLeader = { pid: 201, ppid: 101, pgid: 201, uid: 501, startMs: leaderStartMs, command: '/usr/bin/python3 job.py' };
const jobMember = { pid: 202, ppid: 201, pgid: 201, uid: 501, startMs: leaderStartMs + 1000, command: '/usr/bin/node build.mjs' };
const jobEscapee = { pid: 203, ppid: 202, pgid: 203, uid: 501, startMs: leaderStartMs + 2000, command: '/usr/bin/node worker.mjs' };
const runnerRow = { ...ownerRow, pgid: 101 };
const jobTable = [shellRow, runnerRow, jobLeader, jobMember, jobEscapee];
const targetLease = { ...lease, run: 'heavy-job-queue', stopTarget: { pgid: 201, leaderStartMs, setAt: createdAt + 3000 } };
const pids = list => list.map(t => t.pid);

test('browser stop target stops its group through SIGKILL without signalling or releasing its owner', async () => {
  const browser = { ...targetLease, kind: 'browser', run: 'headless-browser-batch' };
  const h = harness({ inventory: { leases: [browser], table: jobTable } });
  for (let i = 0; i < 3; i++) await h.step();
  assert.equal(h.guard.state.pending.lease.kind, 'browser');
  assert.deepEqual(h.guard.state.pending.stopTarget, { pgid: 201, leaderStartMs });
  assert.deepEqual(h.calls, [['signal', 201, 'SIGTERM'], ['signal', 202, 'SIGTERM'], ['signal', 203, 'SIGTERM']]);
  for (let i = 0; i < 8; i++) assert.equal((await h.step()).type, 'wait');
  assert.equal((await h.step()).type, 'escalate');
  for (let i = 0; i < 8; i++) assert.equal((await h.step()).type, 'wait');
  assert.equal((await h.step()).type, 'kill');
  assert.deepEqual(h.calls.slice(6), [['signal', 201, 'SIGKILL'], ['signal', 202, 'SIGKILL'], ['signal', 203, 'SIGKILL']]);
  h.clock.inventory = { leases: [browser], table: [shellRow, runnerRow] };
  const finished = await h.step({ pressure: 1 });
  assert.equal(finished.type, 'finished');
  assert.equal(finished.released, false);
  assert.equal(h.guard.state.pending, null);
  assert.equal(h.calls.length, 9);
  assert.ok(h.calls.every(c => c[0] === 'signal' && c[1] !== runnerRow.pid));
  assertOnlyPositivePids(h.calls);
});

test('stop target: the job group and its escapee are stopped; the runner never is', async () => {
  const term = run(nightDanger(), [targetLease], jobTable);
  assert.equal(term.type, 'term');
  assert.deepEqual(term.stopTarget, { pgid: 201, leaderStartMs });
  assert.equal(term.owner.pid, 101, 'the owner stays the identity of the stop');
  assert.deepEqual(pids(term.members).sort(), [201, 202, 203]);
  const effects = fakeEffects({ rows: jobTable, leases: () => [targetLease] });
  const result = await perform(term, false, effects);
  assert.deepEqual(effects.calls.map(c => c[1]).sort(), [201, 202, 203]);
  assert.ok(effects.calls.every(c => c[0] === 'signal' && c[2] === 'SIGTERM'));
  assert.ok(!effects.calls.some(c => c[1] === 101), 'the runner is never signalled');
  assert.deepEqual(result.signalled.sort(), [201, 202, 203]);
});

for (const [name, table, reason] of [
  ['its leader pid now belongs to a later process', [shellRow, runnerRow, { ...jobLeader, startMs: leaderStartMs + 5000 }, jobMember],
    /leader pid now belongs to a later process/],
  ['the group is empty', [shellRow, runnerRow], /no members/],
]) {
  test(`stop target is skipped, and the owner is not stopped instead, when ${name}`, async () => {
    const decision = run(nightDanger(), [targetLease], table);
    assert.equal(decision.type, 'alert');
    assert.match(decision.skipped[0].reason, reason);
    const effects = fakeEffects({ rows: table, leases: () => [targetLease] });
    await perform(decision, false, effects);
    assert.deepEqual(effects.calls, []);
  });
}

test('stop target: a dead or reused owner means the lease is skipped, as for an untargeted lease', () => {
  const dead = run(nightDanger(), [targetLease], [shellRow, jobLeader, jobMember]);
  assert.equal(dead.type, 'alert');
  assert.match(dead.skipped[0].reason, /owner not running/);
  const reused = run(nightDanger(), [targetLease], [shellRow, { ...runnerRow, startMs: createdAt + 60000 }, jobLeader]);
  assert.equal(reused.type, 'alert');
  assert.match(reused.skipped[0].reason, /owner pid reused/);
});

test('stop target ladder: each step rebuilds the group, SIGKILL reaches only the group, and finishing releases nothing', async () => {
  const target = { pgid: 201, leaderStartMs };
  const state = stage => ({ dangerSince: mono0 - CONFIG.killMs, pending: { lease: { id: targetLease.id, run: targetLease.run,
    kind: 'heavy', createdAt }, owner: id(runnerRow), members: [], stopTarget: target, stage, stageAt: mono0 - CONFIG.killMs } });
  // A process forked into the group after the SIGTERM is reached by the next step.
  const late = { pid: 204, ppid: 201, pgid: 201, uid: 501, startMs: leaderStartMs + 40000, command: '/bin/sleep 60' };
  const table = [...jobTable, late];
  assert.equal(run(nightDanger(), [targetLease], table, { ...state('owner'), dangerSince: mono0 - 44999 }).type, 'wait');
  const escalate = run(nightDanger(), [targetLease], table, state('owner'));
  assert.equal(escalate.type, 'escalate');
  assert.deepEqual(pids(escalate.targets).sort(), [201, 202, 203, 204]);
  const kill = run(nightDanger(), [targetLease], table, state('tree'));
  assert.equal(kill.type, 'kill');
  const effects = fakeEffects({ rows: table, leases: () => [targetLease] });
  await perform(kill, false, effects);
  assert.deepEqual(effects.calls.map(c => c[1]).sort(), [201, 202, 203, 204]);
  assert.ok(effects.calls.every(c => c[2] === 'SIGKILL'));
  // The group is gone and the runner lives on: finished, and the runner, not mem-guard, releases the lease.
  const finished = run(sequence(3, 1), [targetLease], [shellRow, runnerRow], state('killed'));
  assert.equal(finished.type, 'finished');
  const done = fakeEffects({ rows: [shellRow, runnerRow] });
  const performed = await perform(finished, false, done);
  assert.deepEqual(done.calls, []);
  assert.equal(performed.released, false);
});

test('stop target: the guard loop stops the group, keeps the runner and its lease, and clears the pending stop', async () => {
  const h = harness({ inventory: { leases: [targetLease], table: jobTable } });
  for (let i = 0; i < 3; i++) await h.step();
  assert.deepEqual(h.calls.map(c => c[1]).sort(), [201, 202, 203]);
  assert.equal(h.guard.state.pending.stopTarget.pgid, 201);
  h.clock.inventory = { leases: [targetLease], table: [shellRow, runnerRow] };
  const result = await h.step({ pressure: 1 });
  assert.equal(result.type, 'finished');
  assert.equal(h.guard.state.pending, null);
  assert.ok(!h.calls.some(c => c[0] === 'release'), 'mem-guard leaves the release to the runner');
  assert.ok(!h.calls.some(c => c[1] === 101));
});

test('stop target: an owner that exits mid-ladder finishes the stop without signals or release', async () => {
  const target = { pgid: 201, leaderStartMs };
  const state = { dangerSince: mono0 - CONFIG.killMs, pending: { lease: { id: targetLease.id, run: targetLease.run, kind: 'heavy', createdAt },
    owner: id(runnerRow), members: [], stopTarget: target, stage: 'owner', stageAt: mono0 - CONFIG.killMs } };
  const finished = run(nightDanger(), [targetLease], [shellRow, jobLeader, jobMember], state);
  assert.equal(finished.type, 'finished');
  const effects = fakeEffects({ rows: [shellRow, jobLeader, jobMember] });
  await perform(finished, false, effects);
  assert.deepEqual(effects.calls, []);
});

// Review fixes (Astra, 2026-10-07).
const pendingTarget = (stage, changes = {}) => ({ dangerSince: mono0 - CONFIG.killMs, pending: { lease: { id: targetLease.id,
  run: targetLease.run, kind: 'heavy', createdAt }, owner: id(runnerRow), members: [], stopTarget: { pgid: 201, leaderStartMs },
  stage, stageAt: mono0 - CONFIG.killMs, ...changes } });

test('review: an owner stop decided from a lease read before its target was set is called off', async () => {
  const untargeted = { ...targetLease, stopTarget: undefined };
  const term = run(nightDanger(), [untargeted], jobTable);
  assert.deepEqual([term.type, term.owner.pid, term.stopTarget], ['term', 101, undefined]);
  const effects = fakeEffects({ rows: jobTable, leases: () => [targetLease] });
  const result = await perform(term, false, effects);
  assert.equal(result.type, 'ineligible');
  assert.match(result.reason, /gained a stop target/);
  assert.deepEqual(effects.calls, [], 'the runner is not signalled');
});

test('review: a released or retargeted lease ends a pending targeted stop, even with a reused group in view', async () => {
  // Group 201's leader is gone; an unrelated later process now sits in a reused group 201.
  const reused = { pid: 250, ppid: 1, pgid: 201, uid: 501, startMs: leaderStartMs + 600000, command: '/bin/sleep 600' };
  const table = [shellRow, runnerRow, reused];
  const released = run(nightDanger(), [], table, pendingTarget('tree'));
  assert.equal(released.type, 'finished');
  const retargeted = run(nightDanger(), [{ ...targetLease, stopTarget: { pgid: 777, leaderStartMs, setAt: createdAt } }], table,
    pendingTarget('tree'));
  assert.equal(retargeted.type, 'finished');
  assert.equal(run(nightDanger(), null, table, pendingTarget('tree')).type, 'alert', 'no inventory, no signals');
  const effects = fakeEffects({ rows: table, leases: () => [] });
  // Tracked identities come from earlier steps of this stop: the original job, long gone.
  const performed = await perform({ ...released, type: 'kill', targets: [id(jobMember)] }, false, effects);
  assert.equal(performed.type, 'ineligible');
  assert.deepEqual(effects.calls, []);
});

test('review: a setsid escapee that ignored SIGTERM stays a target after its group is gone', async () => {
  const orphan = { ...jobEscapee, ppid: 1 };
  const table = [shellRow, runnerRow, orphan];
  const escalate = run(nightDanger(), [targetLease], table, pendingTarget('owner', { members: [id(jobLeader), id(jobMember), id(jobEscapee)] }));
  assert.equal(escalate.type, 'escalate');
  assert.deepEqual(pids(escalate.targets), [203]);
  const kill = run(nightDanger(), [targetLease], table, pendingTarget('tree', { targets: escalate.targets }));
  const effects = fakeEffects({ rows: table, leases: () => [targetLease] });
  await perform(kill, false, effects);
  assert.deepEqual(effects.calls, [['signal', 203, 'SIGKILL']]);
  const gone = run(nightDanger(), [targetLease], [shellRow, runnerRow], pendingTarget('killed', { targets: escalate.targets }));
  assert.equal(gone.type, 'finished');
  // A reused pid 203 is a different process and is not tracked.
  const reusedPid = run(nightDanger(), [targetLease], [shellRow, runnerRow, { ...orphan, startMs: orphan.startMs + 90000 }],
    pendingTarget('killed', { targets: escalate.targets }));
  assert.equal(reusedPid.type, 'finished');
});

test('review: a member whose process group changed between snapshot and signal is skipped', async () => {
  const term = run(nightDanger(), [targetLease], jobTable);
  const moved = { ...jobMember, pgid: 999 };
  const effects = fakeEffects({ rows: jobTable, leases: () => [targetLease],
    identify: pid => (pid === 202 ? moved : jobTable.find(p => p.pid === pid) ?? null) });
  const result = await perform(term, false, effects);
  assert.ok(!effects.calls.some(c => c[1] === 202));
  assert.ok(result.skippedPids.includes(202));
  assert.deepEqual(result.signalled.sort(), [201, 203]);
});

// Second review round (Astra, 2026-10-07).
test('review 2: a reused group number cannot pull in a process that does not descend from the runner', async () => {
  // The lease is still current, the original leader is gone, and an unrelated process sits in group 201.
  const unrelated = { pid: 260, ppid: 1, pgid: 201, uid: 501, startMs: leaderStartMs + 600000, command: '/bin/sleep 600' };
  const decision = run(nightDanger(), [targetLease], [shellRow, runnerRow, unrelated]);
  assert.equal(decision.type, 'alert');
  assert.match(decision.skipped[0].reason, /no members/);
  const kill = run(nightDanger(), [targetLease], [shellRow, runnerRow, unrelated], pendingTarget('tree'));
  assert.equal(kill.type, 'finished');
  const effects = fakeEffects({ rows: [shellRow, runnerRow, unrelated], leases: () => [targetLease] });
  const performed = await perform({ ...kill, type: 'kill', targets: [] }, false, effects);
  assert.equal(performed.type, 'ineligible');
  assert.deepEqual(effects.calls, []);
});

test('review 2: a tracked escapee is still stopped after the runner released the lease', async () => {
  const orphan = { ...jobEscapee, ppid: 1 };
  const table = [shellRow, runnerRow, orphan];
  const tracked = { members: [id(jobLeader), id(jobMember), id(jobEscapee)] };
  const escalate = run(nightDanger(), [], table, pendingTarget('owner', tracked));
  assert.deepEqual([escalate.type, pids(escalate.targets)], ['escalate', [203]]);
  const effects = fakeEffects({ rows: table, leases: () => [] });
  await perform({ ...escalate, type: 'kill' }, false, effects);
  assert.deepEqual(effects.calls, [['signal', 203, 'SIGKILL']]);
  assert.equal(run(nightDanger(), [], [shellRow, runnerRow], pendingTarget('killed', tracked)).type, 'finished');
});

test('review 2: a quarantined targeted lease is never a new victim and leaves a pending stop with tracked processes only', () => {
  const quarantined = { ...targetLease, state: 'quarantined', cleanupRequired: true };
  const decision = run(nightDanger(), [quarantined], jobTable);
  assert.equal(decision.type, 'alert');
  assert.match(decision.skipped[0].reason, /quarantined/);
  const pending = run(nightDanger(), [quarantined], jobTable, pendingTarget('owner', { members: [id(jobMember)] }));
  assert.deepEqual([pending.type, pids(pending.targets)], ['escalate', [202]]);
});

test('review 2: the owner re-check happens at its own signal, and an unreadable inventory keeps today\'s behaviour', async () => {
  const untargeted = { ...targetLease, stopTarget: undefined };
  const term = run(nightDanger(), [untargeted], jobTable);
  const unreadable = fakeEffects({ rows: jobTable, leases: () => { throw new Error('EIO'); } });
  const result = await perform(term, false, unreadable);
  assert.deepEqual(unreadable.calls, [['signal', 101, 'SIGTERM']]);
  assert.equal(result.type, 'term');
  // The decision came from an inventory read before the runner set its target; by signal time the lease has one.
  const racing = fakeEffects({ rows: jobTable, leases: () => [targetLease] });
  const calledOff = await perform(term, false, racing);
  assert.equal(calledOff.type, 'ineligible');
  assert.deepEqual(racing.calls, []);
});

test('review 2: through the guard loop, a child first seen at the escalation signal is still killed after it leaves the group', async () => {
  // 206 appears only in the snapshot the escalation step takes when it signals, not in the decision's inventory.
  const child206 = { pid: 206, ppid: 202, pgid: 201, uid: 501, startMs: leaderStartMs + 20000, command: '/bin/sleep 60' };
  let h, extra = [];
  const rows = () => [...h.clock.inventory.table, ...extra];
  h = harness({ inventory: { leases: [targetLease], table: jobTable },
    effects: { table: () => rows(), identify: pid => rows().find(p => p.pid === pid) ?? null } });
  const until = async type => {
    for (let i = 0; i < 20; i++) { const r = await h.step(); if (r.type === type) return r; }
    assert.fail(`no ${type} step`);
  };
  await until('term');
  for (let i = 0; i < 8; i++) assert.equal((await h.step()).type, 'wait');
  extra = [child206];
  const escalate = await h.step();
  assert.equal(escalate.type, 'escalate');
  assert.ok(escalate.signalled.includes(206));
  assert.ok(h.guard.state.pending.targets.some(t => t.pid === 206), 'the escalation step carries 206 into the pending stop');
  // 206 leaves the group and is reparented; only tracking can still reach it.
  extra = [];
  h.clock.inventory = { leases: [targetLease], table: [...jobTable, { ...child206, ppid: 1, pgid: 206 }] };
  const kill = await until('kill');
  assert.ok(kill.signalled.includes(206), 'the SIGKILL step reaches the tracked child');
});

test('with the leader still holding the number, a member older than the leader makes the target stale and nothing is signalled', async () => {
  const older = { ...jobMember, startMs: leaderStartMs - 5000 };
  const table = [shellRow, runnerRow, jobLeader, older];
  const decision = run(nightDanger(), [targetLease], table);
  assert.equal(decision.type, 'alert');
  assert.match(decision.skipped[0].reason, /member started before its leader/);
  const effects = fakeEffects({ rows: table, leases: () => [targetLease] });
  await perform(decision, false, effects);
  assert.deepEqual(effects.calls, []);
});

// Third review round (Astra, 2026-10-07).
test('review 3: a released lease whose runner moved on to a targeted job calls the owner stop off; other runs keep today\'s behaviour', async () => {
  const untargeted = { ...targetLease, stopTarget: undefined };
  const term = run(nightDanger(), [untargeted], jobTable);
  const jobB = { ...targetLease, id: 'lease-b', stopTarget: { pgid: 301, leaderStartMs, setAt: createdAt } };
  const movedOn = fakeEffects({ rows: jobTable, leases: () => [jobB] });
  const calledOff = await perform(term, false, movedOn);
  assert.equal(calledOff.type, 'ineligible');
  assert.match(calledOff.reason, /owner now runs a job with a stop target/);
  assert.deepEqual(movedOn.calls, []);
  const released = fakeEffects({ rows: jobTable, leases: () => [] });
  await perform(term, false, released);
  assert.deepEqual(released.calls, [['signal', 101, 'SIGTERM']], 'an owner with no targeted lease is stopped as today');
});

test('review 3: while the leader is held (alive or a zombie) every group member counts, including a reparented one', () => {
  const zombieLeader = { ...jobLeader, command: '<defunct>' };
  const orphan = { ...jobMember, ppid: 1 };
  const decision = run(nightDanger(), [targetLease], [shellRow, runnerRow, zombieLeader, orphan]);
  assert.deepEqual([decision.type, pids(decision.members)], ['term', [202]]);
  // The same orphan with the leader row gone is reachable only by descent, which it no longer has.
  assert.equal(run(nightDanger(), [targetLease], [shellRow, runnerRow, orphan]).type, 'alert');
});

test('review 3: a stale group still leaves tracked escapees to stop', () => {
  const replacement = { ...jobLeader, startMs: leaderStartMs + 600000 };
  const orphan = { ...jobEscapee, ppid: 1 };
  const escalate = run(nightDanger(), [targetLease], [shellRow, runnerRow, replacement, orphan],
    pendingTarget('owner', { members: [id(jobEscapee)] }));
  assert.deepEqual([escalate.type, pids(escalate.targets)], ['escalate', [203]]);
});

test('review 3: a targeted step takes its process snapshot before reading the lease', async () => {
  const order = [];
  const term = run(nightDanger(), [targetLease], jobTable);
  const effects = fakeEffects({ rows: jobTable, table: () => { order.push('table'); return jobTable; },
    leases: () => { order.push('leases'); return [targetLease]; } });
  await perform(term, false, effects);
  assert.deepEqual(order.slice(0, 2), ['table', 'leases']);
});

// Fresh Sol audit of the final patches (2026-10-07).
test('audit: a reused group number whose new leader started in the neighbouring second is stale, not a target', async () => {
  // Unrelated, launchd-parented, one whole ps second after the recorded leader.
  const impostor = { pid: 201, ppid: 1, pgid: 201, uid: 501, startMs: leaderStartMs + 1000, command: '/bin/sleep 600' };
  const table = [shellRow, runnerRow, impostor];
  const decision = run(nightDanger(), [targetLease], table);
  assert.equal(decision.type, 'alert');
  assert.match(decision.skipped[0].reason, /leader pid now belongs to a later process/);
  const effects = fakeEffects({ rows: table, leases: () => [targetLease] });
  await perform({ type: 'term', reason: 'test', lease: { id: targetLease.id, run: targetLease.run, kind: 'heavy', createdAt },
    owner: id(runnerRow), stopTarget: { pgid: 201, leaderStartMs }, members: [] }, false, effects);
  assert.deepEqual(effects.calls, []);
});

test('audit: a group member one ps second older than its leader makes the target stale', () => {
  const older = { ...jobMember, startMs: leaderStartMs - 1000 };
  const decision = run(nightDanger(), [targetLease], [shellRow, runnerRow, jobLeader, older]);
  assert.equal(decision.type, 'alert');
  assert.match(decision.skipped[0].reason, /member started before its leader/);
});

test('audit: through the guard loop, a child first seen at SIGKILL stays tracked until it is gone', async () => {
  const late = { pid: 205, ppid: 202, pgid: 201, uid: 501, startMs: leaderStartMs + 30000, command: '/bin/sleep 60' };
  let h;
  // 205 joins another group between the SIGKILL snapshot and its own per-pid check, so it is skipped there.
  const identify = pid => {
    const row = h.clock.inventory.table.find(p => p.pid === pid) ?? null;
    return pid === 205 && row ? { ...row, pgid: 999 } : row;
  };
  h = harness({ inventory: { leases: [targetLease], table: jobTable }, effects: { identify } });
  const until = async type => {
    for (let i = 0; i < 20; i++) { const r = await h.step(); if (r.type === type) return r; }
    assert.fail(`no ${type} step`);
  };
  await until('term');
  await until('escalate');
  h.clock.inventory = { leases: [targetLease], table: [...jobTable, late] };
  const kill = await until('kill');
  assert.ok(kill.skippedPids.includes(205), 'the regrouped child is skipped at its own check');
  assert.ok(h.guard.state.pending.targets.some(t => t.pid === 205), 'but it stays tracked in the pending stop');
  // The group is gone and the runner released the lease; 205 lives on, reparented and regrouped.
  h.clock.inventory = { leases: [], table: [shellRow, runnerRow, { ...late, ppid: 1, pgid: 999 }] };
  const after = await h.step();
  assert.notEqual(after.type, 'finished');
  assert.notEqual(h.guard.state.pending, null);
  h.clock.inventory = { leases: [], table: [shellRow, runnerRow] };
  assert.equal((await h.step()).type, 'finished');
  assert.equal(h.guard.state.pending, null);
});

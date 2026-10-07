/*
Memory guard for the shared Mac.
Start: nohup node ~/.long-run/bin/mem-guard.mjs >/dev/null 2>&1 &
Preview: node ~/.long-run/bin/mem-guard.mjs --dry-run --once
Bounded preview: node ~/.long-run/bin/mem-guard.mjs --dry-run --duration-seconds 120
Unattended mode is on only while ~/.long-run/UNATTENDED exists. The lead creates
it only on Sam's instruction; removing it restores the attended triggers.
Logs: ~/.long-run/mem-guard/readings.log and events.log, each with one .1 backup.
Alerts also go to stderr. STOPPED-*.md files there tell a stopped run's lead what to rerun.
Stop: find the guard's PID with ps, then kill that PID with SIGTERM.
Real mode holds a lockf singleton lock. Dry runs never run hooks, signal, release
leases or post notifications.

Runaway processes, in both modes, with or without a lease:
When the cheap reading shows danger signs (pressure warn or worse, or swap up
0.5 GiB since the previous sample), the guard asks top for the largest processes'
physical footprint. That is the memory figure Activity Monitor shows, and unlike
resident size it includes memory that has been compressed or swapped out.
A process is a runaway when its footprint is at least max(6 GiB, a quarter of RAM)
and grew by at least 1 GiB within 30 seconds, or when it holds half of RAM or
more. top rounds large values to a whole GiB, so the rule takes the low end of the
current reading and the high end of the earlier one.
  - Not protected: SIGTERM at once, without the 90-second spacing. At the first
    check 10 s or more after the signal, if it is still the same process and still at
    least max(6 GiB, a quarter of RAM), SIGKILL. A STOPPED-runaway-*.md record
    says what was stopped and why.
  - Protected: the list below, plus Lume processes, any direct child of a
    protected app process (an /Applications app or T3), which is part of that
    app, and the owner of a live rig lease, which is stopped only through
    rig-stop. Never signalled; alert only. Only when
    CONFIG.runawayKillAppHelpers is true, a protected /Applications app's GPU
    process or Chromium utility service is SIGKILLed instead, because the app
    restarts those. It must have --type=gpu-process or --type=utility, live in
    the app's Contents/Frameworks, and be a child of the app's main process,
    which launchd started.
    Renderers, main processes, servers and Electron utilityProcess (NodeService)
    children are never signalled.
  Each signal goes to one pid, after re-checking that pid's start time.
Every runaway action and every "no live leased job to stop" alert also posts a
macOS notification through osascript, at most one per reason per minute.

Leased jobs: only the owner of a live lease of kind vm, heavy, gui or
container, plus that owner's descendants. The owner counts only if it started no
later than the lease's createdAt (2-second tolerance); a later start means its pid
was reused. Protected processes (Claude, Codex, T3, /Applications apps other than
Xcode and Simulator, system paths, golden VMs) and their subtrees are never
signalled. With no such lease, danger is alert-only.

One victim's ladder, timed with the monotonic clock:
  1. A lease whose run is exactly "rig" first gets rig-stop --only <owner pid> --grace 0.
     Any other lease, or rig-stop leaving the lease in place: SIGTERM the owner.
  2. After 45 s of continued danger: SIGTERM the owner's remaining tree.
  3. After 45 more seconds of continued danger: SIGKILL that same set.
  Each step rebuilds its targets from the live owner in a fresh snapshot. Rig
  leases never signal descendants, only the owner; after a rig owner is SIGKILLed
  and has exited, rig-stop --orphans --grace 0 sweeps its VM clone.
  The lease is released once the owner has exited.
A break in danger restarts the 45-second count from the moment danger resumes.
At most one new victim per 90 seconds.
*/
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readLeases } from './lr-lease-core.mjs';

const GiB = 1024 ** 3;

export const CONFIG = Object.freeze({
  sampleMs: 5000, // Brief 23, item 1: read every five seconds.
  gapFactor: 2.5, // Brief 23b, item 5: a gap over 2.5 sampling intervals breaks continued danger.
  logMs: 60000, // Brief 23, item 1: one normal-pressure line per minute.
  rotateBytes: 5 * 1000 ** 2, // Brief 23, item 1: 5 MB, decimal bytes.
  attended: Object.freeze({
    criticalCount: 6, // Sam's day-mode revision: six red readings, about 30 seconds.
    diskFloorBytes: 4 * 1024 ** 3, // Sam's day-mode revision: red with disk under 4 GiB.
  }),
  unattended: Object.freeze({
    criticalCount: 3, // Brief 23, item 2: three consecutive critical readings.
    diskFloorBytes: 6 * 1024 ** 3, // Brief 23, item 2: warn/red with disk under 6 GiB.
    ceilingBytes: 23.8 * 1000 ** 3, // Sam's example, not measured; GB is decimal.
  }),
  // Brief 23b, item 2: ps lstart has one-second resolution and the lease's
  // createdAt is wall time in milliseconds; 2 seconds covers truncation.
  ownerStartToleranceMs: 2000,
  stopHooks: Object.freeze({
    // Brief 23b, item 4: exact run name only. The hook's contract is the Caret
    // lead's and is not verified here; any non-zero exit falls back to signals.
    rig: Object.freeze({ command: '~/.long-run/rig/bin/rig-stop', timeoutMs: 60000 }),
  }),
  // Lead's ruling on the 23b re-review: these runs get an owner-only ladder
  // (hook, SIGTERM, SIGKILL on the owner alone). rig-run's exit trap stops its
  // VM clone, so no Lume descendant, whose storage may not be named on its
  // command line, is ever signalled. Exact run names.
  ownerOnlyRuns: Object.freeze(['rig']),
  // On since 3 October 2026. rig-stop --orphans sweeps a clone only when its
  // owner is confirmed gone (kill(pid, 0) gives ESRCH) or replaced (start time
  // more than 1000 ms off); an owner it can't verify is left alone with exit 1.
  // Earlier drafts called unreadable arguments or a failed `ps` "gone"; both have
  // tests in rig/bin/test-rig-stop-orphans.sh (10/10). With the sweep off, a rig
  // owner SIGKILLed past its trap leaves a 4 GB VM clone running. Not yet run
  // against a real VM. Set false to go back to the alert-only step.
  orphanSweep: true,
  stepMs: 90000, // Brief 23, item 4: at most one new victim per 90 seconds.
  killMs: 45000, // Brief 23, item 4: each escalation needs 45 seconds of continued danger.
  // Brief 45: was 10, marked unmeasured. On 4 October every machine reading failed
  // from 02:08:20 under thrash (readings.log), and a guard that yields CPU to the
  // processes it watches sees less, not more. 0 is the default priority. No run shows
  // that 0 keeps the guard readable under thrash; it only removes the handicap.
  nice: 0,
  // Brief 45's runaway rule. Judgment values after the 4 October panic, not
  // measured or tuned: there is one incident, and no normal-load footprint survey.
  runaway: Object.freeze({
    // Read footprints only on danger signs, because top costs about 0.5 s of CPU.
    readPressure: 2, // Warn or worse: the compressor is already under strain.
    // One sample of fast swap growth is a danger sign even at normal pressure. On
    // 4 October swap rose 1.14 GiB between 02:04:38 and 02:04:43.
    readSwapRiseBytes: 0.5 * GiB,
    // Below this, normal big apps (browsers, Xcode, T3) live. On 24 GiB the two
    // floors agree; the RAM share scales it on a bigger Mac.
    minBytes: 6 * GiB,
    minRamFraction: 0.25,
    // Normal work does not grow 1 GiB in 30 s for long. The 4 October helper grew
    // about 1.2 GiB per 5 s (swap and disk moved about 240 MB/s), so this fires
    // within two samples of crossing the floor.
    growthBytes: 1 * GiB,
    growthWindowMs: 30000,
    // Half of RAM in one process leaves too little for the rest, growing or not.
    hugeRamFraction: 0.5,
    // Time for a clean exit after SIGTERM. At the 4 October rate, 10 s adds about
    // 2.4 GiB of swap, and the disk had about 13 GiB free when growth began.
    killAfterMs: 10000,
    notifyEveryMs: 60000, // Brief 45: one notification per reason per minute.
  }),
  // On since 4 October 2026, by the lead on Sam's "use your best judgment". The 02:10
  // panic that day was T3's GPU process at 25 GB (pingdotgg/t3code#13610, unfixed); with
  // this off, the guard could only alert while the disk filled. When true, a protected
  // app's GPU process or Chromium utility service may be SIGKILLed (see
  // restartableAppHelper); the app restarts it. Never its main process, renderer or
  // server. Set false to return to alert-only for protected apps.
  runawayKillAppHelpers: true,
});
const root = path.join(os.homedir(), '.long-run');
const kinds = ['vm', 'heavy', 'gui', 'container'];
const maxGapMs = CONFIG.sampleMs * CONFIG.gapFactor;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const command = (file, args, env) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 4000, maxBuffer: 8 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'],
  ...(env ? { env: { ...process.env, ...env } } : {}),
}).trim();
// UTC removes the repeated local hour at the end of daylight saving time; C keeps month names English.
const psEnv = Object.freeze({ TZ: 'UTC', LC_ALL: 'C' });
const psColumns = 'pid=,ppid=,pgid=,uid=,lstart=,command=';
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseMemory(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = name => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\.?$`, 'm').exec(text);
    if (!match) throw new Error(`missing vm_stat field: ${name}`);
    return Number(match[1]);
  };
  if (!pageSize) throw new Error('missing vm_stat page size');
  // Anonymous pages approximate app memory. Purgeable pages are reclaimable;
  // count physical compressor pages, not the uncompressed pages stored inside it.
  const app = pages('Anonymous pages') - pages('Pages purgeable');
  if (app < 0) throw new Error('invalid vm_stat app memory');
  return (app + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
}

export function parseSwap(text) {
  const bytes = field => {
    const match = new RegExp(`\\b${field}\\s*=\\s*([\\d.]+)([KMGT])\\b`).exec(text);
    const result = match ? Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2]) + 1) : NaN;
    if (!nonnegative(result)) throw new Error(`invalid swap ${field}`);
    return result;
  };
  const swapUsedBytes = bytes('used'), swapTotalBytes = bytes('total');
  if (swapUsedBytes > swapTotalBytes) throw new Error('swap used exceeds total');
  return { swapUsedBytes, swapTotalBytes };
}

// now is wall time, for logs only. mono is monotonic time, for every duration.
export function readSnapshot(run = command, disk = () => fs.statfsSync('/', { bigint: true }), now = Date.now(), mono = performance.now()) {
  try {
    const pressure = Number(run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']));
    if (![1, 2, 4].includes(pressure)) throw new Error('unknown memory pressure');
    const memoryUsedBytes = parseMemory(run('/usr/bin/vm_stat', []));
    const swap = parseSwap(run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']));
    const stat = disk();
    const diskFreeBytes = Number(stat.bavail * stat.bsize);
    if (!nonnegative(diskFreeBytes)) throw new Error('invalid free disk');
    return { now, mono, pressure, memoryUsedBytes, diskFreeBytes, ...swap };
  } catch {
    // Do not include child stderr or commands: they can contain secrets.
    return { now, mono, unknown: true, error: 'machine reading unavailable or invalid' };
  }
}

function known(reading) {
  return reading && !reading.unknown && [1, 2, 4].includes(reading.pressure) &&
    ['now', 'mono', 'memoryUsedBytes', 'diskFreeBytes', 'swapUsedBytes', 'swapTotalBytes'].every(key => nonnegative(reading[key]));
}
const contiguous = (earlier, later) => later.mono > earlier.mono && later.mono - earlier.mono <= maxGapMs;

export function danger(history, unattended = true) {
  const current = history.at(-1);
  if (!known(current)) return null;
  const rule = unattended ? CONFIG.unattended : CONFIG.attended;
  if (current.pressure >= (unattended ? 2 : 4) && current.diskFreeBytes < rule.diskFloorBytes) {
    return `pressure with disk below ${unattended ? 6 : 4} GiB`;
  }
  if (unattended && current.pressure === 4 && current.memoryUsedBytes >= rule.ceilingBytes) return 'critical pressure at memory ceiling';
  const tail = history.slice(-rule.criticalCount);
  if (tail.length === rule.criticalCount &&
      tail.every((r, i) => known(r) && r.pressure === 4 && (i === 0 || contiguous(tail[i - 1], r)))) {
    return `${rule.criticalCount} consecutive critical readings`;
  }
  return null;
}

// The never-choose list. ctx carries uid, home and guardPid.
export function protectedProcess(p, ctx) {
  const text = p?.command ?? '';
  return !p || !Number.isSafeInteger(p.pid) || p.pid <= 1 || p.uid !== ctx.uid || p.pid === ctx.guardPid ||
    text === '' || text === '<defunct>' ||
    /claude|codex|\bt3[ -]?code\b|mem-guard\.mjs/i.test(text) ||
    // Any /Applications path except Xcode (which contains Simulator) or Simulator itself.
    /\/Applications\/(?!(?:Xcode[^/]*|Simulator)\.app(?:\/|\s|$))/.test(text) ||
    /^\/(?:System|Library\/Apple|usr\/libexec|usr\/sbin|sbin)\//.test(text) ||
    /rig-golden/i.test(text) || text.includes(`${ctx.home}/.lume`) || /~\/\.lume\b/.test(text);
}

export function hookFor(lease) {
  return Object.hasOwn(CONFIG.stopHooks, lease.run) ? CONFIG.stopHooks[lease.run] : undefined;
}

const identity = p => ({ pid: p.pid, startMs: p.startMs });

// Walks children by ppid from the given rows. A child that started before its
// parent cannot be that parent's child (the ppid is stale), so it is skipped
// with its subtree. A protected process and its whole subtree are dropped.
function tree(roots, table, ctx) {
  const children = new Map();
  for (const p of table) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const queue = roots.filter(p => !protectedProcess(p, ctx)), seen = new Set(), result = [];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    result.push(identity(p));
    for (const child of children.get(p.pid) ?? []) {
      if (child.pid !== p.pid && child.startMs >= p.startMs && !protectedProcess(child, ctx)) queue.push(child);
    }
  }
  return result;
}

const sameProcess = (row, target) => Boolean(row) && row.pid === target.pid && row.startMs === target.startMs && row.command !== '<defunct>';
const verifiedRow = (row, target, ctx) => sameProcess(row, target) && !protectedProcess(row, ctx);

// The processes that may be signalled at an escalation step: rebuilt from the
// verified owner in one fresh snapshot, with protected subtrees dropped, then
// intersected with the identities (pid and start time) tracked so far. A tracked
// pid is never a root of its own, so a process under a worker that has since
// exec'd into a protected program falls out with that worker's subtree.
// Owner-only runs (rig) never yield more than the owner.
export function ownerTargets(lease, owner, tracked, table, ctx) {
  const row = table.find(p => p.pid === owner.pid);
  if (!verifiedRow(row, owner, ctx)) return [];
  const allowed = new Set(tracked.map(t => `${t.pid}:${t.startMs}`));
  const reachable = CONFIG.ownerOnlyRuns.includes(lease.run) ? [identity(row)] : tree([row], table, ctx);
  return reachable.filter(t => allowed.has(`${t.pid}:${t.startMs}`));
}

// A lease's stopTarget (set by its owner through lr-lease target) names the process group doing the leased work.
// mem-guard then stops that group and never the owner, whose liveness still decides whether the lease counts.
// Start times are compared exactly: lr-lease records the leader's start with the same whole-second ps lstart reading
// this table uses, so any difference, even one second, means a different process.
const targetOf = target => ({ pgid: target.pgid, leaderStartMs: target.leaderStartMs });

// The processes to signal for a stop target, from one process snapshot taken before the lease was read.
// - The group part counts only while the lease is current (present, not quarantined, same target).
//   - If a row with pid pgid exists with the recorded start time, the number is still held by the original leader,
//     live or a zombie (the queue keeps its leader unreaped until the group is empty), so no other group can have it:
//     every live member counts, including one reparented to launchd.
//   - If that row is gone, the number may have been reused, so only members that descend from the owner by ppid
//     count. The runner spawned its job; a process that later took the number elsewhere cannot qualify.
//   - A row with pid pgid but another start time means the number now belongs to a later process: the group part is
//     stale and contributes nothing.
// - Processes seen in an earlier step of the same stop stay members while they are the same process (pid and start
//   time), whatever the lease or group now says: a setsid child that ignored SIGTERM is still the job's.
// The owner and protected processes are never members. An empty or stale result is skipped and never turned back
// into a stop of the owner, whose other queued work is not the problem.
export function targetMembers(target, owner, table, ctx, tracked = [], leaseCurrent = true) {
  const byPid = new Map(table.map(p => [p.pid, p]));
  const members = [], listed = new Set();
  const add = t => {
    if (listed.has(t.pid) || t.pid === owner.pid) return;
    listed.add(t.pid);
    members.push({ pid: t.pid, startMs: t.startMs, pgid: byPid.get(t.pid).pgid });
  };
  let stale = null;
  if (leaseCurrent) {
    const leader = byPid.get(target.pgid);
    if (leader && leader.startMs !== target.leaderStartMs) {
      stale = 'stop target stale: its leader pid now belongs to a later process';
    } else {
      let group = table.filter(p => p.pgid === target.pgid && p.command !== '<defunct>');
      if (!leader) {
        const ownerRow = byPid.get(owner.pid);
        const descendants = new Set(ownerRow ? tree([ownerRow], table, ctx).map(t => t.pid) : []);
        group = group.filter(p => descendants.has(p.pid));
      }
      if (group.some(p => p.startMs < target.leaderStartMs)) {
        stale = 'stop target stale: a member started before its leader';
      } else {
        for (const t of tree(group, table, ctx)) add(t);
      }
    }
  }
  for (const t of tracked) if (verifiedRow(byPid.get(t.pid), t, ctx)) add(t);
  if (members.length) return { members };
  return { skip: stale ?? 'stop target has no members' };
}

const sameTarget = (a, b) => Boolean(a && b) && a.pgid === b.pgid && a.leaderStartMs === b.leaderStartMs;
// A quarantining release keeps the record, so quarantine also means the owner has let the group go.
const targetCurrent = (lease, target) => Boolean(lease) && lease.state !== 'quarantined' && sameTarget(lease.stopTarget, target);

// A leased owner whose parent is launchd (ppid 1) stays eligible: the lease is
// the opt-in, and a job reparented after its launching shell exited is still that job.
function verifiedOwner(lease, byPid, ctx, now) {
  if (!nonnegative(lease.createdAt)) return { skip: 'lease has no valid createdAt' };
  // A createdAt in the future means the wall clock moved back; start times can't be compared.
  if (lease.createdAt > now) return { skip: 'lease createdAt is in the future' };
  const row = byPid.get(lease.ownerPid);
  if (!row || row.command === '<defunct>') return { skip: 'owner not running' };
  // Documented residual risk: createdAt and the owner's start time are both wall
  // time. If the clock moved back between the owner's start and a later reuse of
  // its pid, by less than the "future createdAt" check above can see, a reused
  // pid can pass this comparison.
  // TODO: when lr-lease records the owner's start time in the optional lease field
  // ownerStartMs (epoch ms; name and unit agreed with the Caret lead), require
  // |row.startMs - lease.ownerStartMs| <= 1000, not equality: ps lstart has
  // whole-second resolution, so both values are multiples of 1000. Fall back to
  // this createdAt rule only when the field is missing.
  if (!(row.startMs <= lease.createdAt + CONFIG.ownerStartToleranceMs)) return { skip: 'owner pid reused: process started after the lease' };
  if (protectedProcess(row, ctx)) return { skip: 'owner is a protected process' };
  return { row };
}

const leaseSummary = lease => ({ id: lease.id, run: lease.run, kind: lease.kind, createdAt: lease.createdAt });

// Pure. state carries mode and ladder state; history and all other inputs are
// read only. now is wall time, used only for lease expiry; durations use the
// latest reading's monotonic time. Actions carry pids and start times, never
// command lines.
export function decide(history, leases, table, state, now) {
  const current = history.at(-1);
  if (!known(current)) return { type: 'unknown', reason: 'machine reading unavailable or invalid' };
  const reason = danger(history, state.unattended);
  if (state.pending) return decidePending(reason, table, state, current.mono, leases);
  if (!reason) return { type: 'none', reason: 'no danger' };
  if (!table || !leases) return { type: 'alert', reason: `${reason}; victim inventory unavailable` };
  if (state.lastStepAt != null && current.mono - state.lastStepAt < CONFIG.stepMs) {
    return { type: 'wait', reason: `${reason}; 90-second spacing` };
  }
  const byPid = new Map(table.map(p => [p.pid, p]));
  const order = lease => Number.isFinite(lease.createdAt) ? lease.createdAt : -Infinity;
  const live = leases.filter(lease => kinds.includes(lease.kind) && lease.expiresAt > now)
    .sort((a, b) => order(b) - order(a) || String(a.id).localeCompare(String(b.id)));
  const skipped = [];
  for (const lease of live) {
    const owner = verifiedOwner(lease, byPid, state, now);
    if (owner.skip) {
      skipped.push({ lease: lease.id, run: lease.run, ownerPid: lease.ownerPid, reason: owner.skip });
      continue;
    }
    if (lease.stopTarget) {
      const target = lease.state === 'quarantined' ? { skip: 'lease quarantined: its owner already saw the group empty' }
        : targetMembers(lease.stopTarget, owner.row, table, state);
      if (target.skip) {
        skipped.push({ lease: lease.id, run: lease.run, ownerPid: lease.ownerPid, reason: target.skip });
        continue;
      }
      return { type: 'term', reason, lease: leaseSummary(lease), owner: identity(owner.row),
        stopTarget: targetOf(lease.stopTarget), members: target.members, ...(skipped.length ? { skipped } : {}) };
    }
    const hook = hookFor(lease);
    const members = CONFIG.ownerOnlyRuns.includes(lease.run) ? [identity(owner.row)] : tree([owner.row], table, state);
    return { type: 'term', reason, lease: leaseSummary(lease), owner: identity(owner.row),
      members, ...(hook ? { hook } : {}), ...(skipped.length ? { skipped } : {}) };
  }
  return { type: 'alert', reason: `${reason}; no live leased job to stop`, ...(skipped.length ? { skipped } : {}) };
}

function decidePending(reason, table, state, mono, leases) {
  const pending = state.pending;
  if (!table) {
    return reason ? { type: 'alert', reason: `${reason}; process table unavailable for the pending stop` }
      : { type: 'none', reason: 'no danger; process table unavailable' };
  }
  if (pending.stopTarget) return decideTargetPending(reason, table, state, mono, leases);
  const base = { lease: pending.lease, owner: pending.owner };
  const row = table.find(p => p.pid === pending.owner.pid);
  // Gone: missing, a zombie, or the pid now belongs to a process that started
  // later. Targets are only ever reached through the live owner, so once it is
  // gone nothing more can be signalled, and the stop is finished.
  if (!row || row.command === '<defunct>' || row.startMs > pending.owner.startMs) {
    const sweep = pending.ownerKilled && CONFIG.ownerOnlyRuns.includes(pending.lease.run) && hookFor(pending.lease);
    return { type: 'finished', reason: 'owner exited', ...base, ...(sweep ? { orphanSweep: sweep } : {}) };
  }
  if (!verifiedRow(row, pending.owner, state)) {
    return { type: 'ineligible', reason: 'owner not eligible: identity changed or it became a protected process', ...base };
  }
  if (!reason) return { type: 'none', reason: 'no danger; waiting for the stopped job to exit' };
  // Escalation counts from the later of the last step and the start of the
  // current danger period, so an interruption restarts the count.
  const since = Math.max(pending.stageAt, state.dangerSince ?? Infinity);
  if (!(mono - since >= CONFIG.killMs)) return { type: 'wait', reason: `${reason}; waiting for 45 seconds of continued danger` };
  if (pending.stage === 'owner') return { type: 'escalate', reason, ...base, targets: ownerTargets(pending.lease, pending.owner, pending.members, table, state) };
  if (pending.stage === 'tree') return { type: 'kill', reason, ...base, targets: ownerTargets(pending.lease, pending.owner, pending.targets, table, state) };
  return { type: 'alert', reason: `${reason}; stopped job still present after SIGKILL` };
}

export function parseProcessTable(text) {
  return text.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})(?:\s+(.*))?$/.exec(line);
    const month = months.indexOf(match?.[5]);
    if (!match || month < 0) throw new Error('unreadable process table');
    const [, pid, ppid, pgid, uid, , day, hour, minute, second, year, text = ''] = match;
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid),
      startMs: Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)), command: text.trim() };
  });
}

// One ps call, so parent links, start times and commands come from one snapshot.
export function readProcessTable(run = command) {
  return parseProcessTable(run('/bin/ps', ['-axo', psColumns], psEnv));
}

export function identifyProcess(pid, run = command) {
  try {
    const rows = parseProcessTable(run('/bin/ps', ['-o', psColumns, '-p', String(pid)], psEnv));
    return rows.length === 1 && rows[0].pid === pid ? rows[0] : null;
  } catch {
    return null; // ps exits non-zero for a missing pid; any failure means "not verified".
  }
}

// Runaway rule. top's MEM column is the physical footprint (top/libtop.c reads
// phys_footprint). It is printed by humanize_number into five characters with no
// decimals (top/memstats.c, top/uinteger.c): whole MiB below about 9.77 GiB, whole
// GiB above, rounded to nearest. Each value is kept as a [low, high] range.
const footprintUnits = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
export const topArgs = Object.freeze(['-l', '1', '-o', 'mem', '-n', '15', '-F', '-R', '-stats', 'pid,mem,command']);

export function parseFootprints(text) {
  const lines = text.split('\n');
  const header = lines.findIndex(line => /^\s*PID\s+MEM\s+COMMAND\s*$/.test(line));
  if (header < 0) throw new Error('unreadable footprint table');
  return lines.slice(header + 1).filter(line => line.trim()).map(line => {
    // A trailing + or - marks change since a previous sample; -l 1 has none, but allow it.
    const match = /^\s*(\d+)\s+(\d+)([BKMGT])[+-]?\s+(.*?)\s*$/.exec(line);
    if (!match) throw new Error('unreadable footprint table');
    const unit = footprintUnits[match[3]], bytes = Number(match[2]) * unit;
    // Rounding to nearest loses at most half a unit; truncation of the smaller
    // units on the way adds less than 1/1024 of a unit.
    const slack = unit === 1 ? 0 : unit / 2 + unit / 1024;
    // The name is the process name, not its arguments.
    return { pid: Number(match[1]), lowBytes: Math.max(0, bytes - slack), highBytes: bytes + slack, name: match[4] };
  });
}

export function readFootprints(run = command) {
  return parseFootprints(run('/usr/bin/top', [...topArgs], { LC_ALL: 'C' }));
}

// Read footprints only on danger signs, or while a runaway stop is pending.
export function wantsFootprint(history, pending) {
  if (pending) return true;
  const current = history.at(-1), previous = history.at(-2);
  if (!known(current)) return false;
  if (current.pressure >= CONFIG.runaway.readPressure) return true;
  return Boolean(known(previous)) && current.swapUsedBytes - previous.swapUsedBytes >= CONFIG.runaway.readSwapRiseBytes;
}

const identityKey = t => `${t.pid}:${t.startMs}`;

// Joins top's rows to a ps snapshot taken BEFORE top ran. With that order, a pid
// reused between the two reads gets the new process's footprint under the old
// identity, and the old identity is already dead, so the signal-time re-check
// refuses it. The other order could pin an old process's footprint on a new one.
// Samples are keyed by pid and start time, so a reused pid starts a fresh history.
// Returns only processes seen in this read, each with samples from the window.
export function trackFootprints(previous, table, rows, mono) {
  const byPid = new Map(table.map(p => [p.pid, p]));
  const next = new Map();
  for (const f of rows) {
    const p = byPid.get(f.pid);
    if (!p || p.command === '<defunct>') continue;
    const key = identityKey(p);
    const earlier = (previous?.get(key)?.samples ?? [])
      .filter(s => s.mono < mono && mono - s.mono <= CONFIG.runaway.growthWindowMs);
    next.set(key, { target: identity(p), name: f.name,
      samples: [...earlier, { mono, lowBytes: f.lowBytes, highBytes: f.highBytes }] });
  }
  return next;
}

export function runawayLimits(ramBytes) {
  const r = CONFIG.runaway;
  if (!(ramBytes > 0)) throw new Error('runaway rule needs the machine RAM size');
  return { floorBytes: Math.max(r.minBytes, r.minRamFraction * ramBytes), hugeBytes: r.hugeRamFraction * ramBytes };
}

const gib = bytes => `${(bytes / GiB).toFixed(1)} GiB`;

export function runawayRule(samples, limits) {
  const current = samples.at(-1);
  if (current.lowBytes >= limits.hugeBytes) {
    return { rule: 'half-ram', footprintBytes: current.lowBytes, reason: `footprint at least ${gib(current.lowBytes)}, half of RAM or more` };
  }
  if (current.lowBytes < limits.floorBytes) return null;
  let grewBytes = -Infinity;
  for (const s of samples) {
    if (s.mono < current.mono && current.mono - s.mono <= CONFIG.runaway.growthWindowMs) {
      grewBytes = Math.max(grewBytes, current.lowBytes - s.highBytes);
    }
  }
  if (!(grewBytes >= CONFIG.runaway.growthBytes)) return null;
  return { rule: 'growth', footprintBytes: current.lowBytes, grewBytes,
    reason: `footprint at least ${gib(current.lowBytes)} and grew at least ${gib(grewBytes)} within 30 s` };
}

// The runaway rule acts outside any lease, so it lacks the leased ladder's
// owner-only and protected-subtree limits. It adds two protections instead:
// - a direct child of a protected app process (an /Applications app or T3) is part
//   of that app, such as a server it started with a plain node command;
// - Lume processes, because a VM's storage may not be named on its command line
//   (Brief 23b), and rig VM clones are stopped only through rig-stop.
// - the owner of a live lease whose run gets the owner-only ladder (rig). Its stop
//   goes through rig-stop, and a SIGKILL from outside that ladder would skip the
//   orphan sweep that removes its VM clone. rigOwners comes from the lease files;
//   if they can't be read it is empty, because missing a runaway is worse than a
//   leftover clone. Rig owners are shell scripts and their VMs' memory sits in a
//   protected system process, so this costs the rule no coverage in practice.
// Deeper descendants stay eligible: an agent's tools run under claude or codex, and
// a terminal's commands under a shell, and those are the workloads the rule stops.
// Limit: an app server started through a shell (app, sh, node) is not recognised.
const appProcess = p => /\/Applications\//.test(p.command) || /\bt3[ -]?code\b/i.test(p.command);
const lumeProcess = p => /(?:^|\/)lume(?:\.app\/|\s|$)/.test(p.command);
export function ownerOnlyLeaseOwners(leases, now) {
  return new Set((leases ?? []).filter(lease => CONFIG.ownerOnlyRuns.includes(lease.run) && lease.expiresAt > now)
    .map(lease => lease.ownerPid));
}
export function runawayProtected(row, byPid, ctx, rigOwners = new Set()) {
  if (protectedProcess(row, ctx) || lumeProcess(row) || rigOwners.has(row.pid)) return true;
  const parent = byPid.get(row.ppid);
  return Boolean(parent) && parent.pid > 1 && protectedProcess(parent, ctx) && appProcess(parent);
}

const tokens = text => text.split(/\s+/).filter(Boolean);

// A protected app's Chromium/Electron child that the app restarts when it dies:
// the GPU process or a Chromium utility service (network, audio, storage...).
// Electron's utilityProcess runs the app's own code (it may be the app's server)
// and is not restarted for it, so its node.mojom.NodeService sub-type is excluded.
// The executable must be inside /Applications/<App>.app/Contents/Frameworks/, and
// the parent must be that bundle's main executable with no --type, started by
// launchd (ppid 1). That rules out renderers, the main process itself, and the main
// executable re-run as a server, whose parent is the main process.
export function restartableAppHelper(row, parent, ctx) {
  if (!row || !parent || !Number.isSafeInteger(row.pid) || row.pid <= 1 || row.pid === ctx.guardPid ||
      row.uid !== ctx.uid || parent.uid !== ctx.uid || row.ppid !== parent.pid || parent.pid <= 1 || parent.ppid !== 1 ||
      !(row.startMs >= parent.startMs) || row.command === '<defunct>' || parent.command === '<defunct>') return false;
  const bundle = /^\/Applications\/[^/]+\.app(?=\/Contents\/Frameworks\/[^\n]*?\.app\/Contents\/MacOS\/)/.exec(row.command)?.[0];
  if (!bundle || !parent.command.startsWith(`${bundle}/Contents/MacOS/`)) return false;
  const args = tokens(row.command), types = args.filter(a => a.startsWith('--type='));
  if (types.length !== 1 || !['--type=gpu-process', '--type=utility'].includes(types[0])) return false;
  if (args.some(a => a.startsWith('--utility-sub-type=node.mojom.NodeService'))) return false;
  return !tokens(parent.command).some(a => a.startsWith('--type='));
}

// Pure. footprints is trackFootprints' result for this tick, or null when the read
// failed; table is the ps snapshot it was joined to, or null. state.runaways holds
// pending stops. mono is taken after the reads. absentAtMostBytes is the high end of
// the smallest footprint top listed: a process missing from the list is no larger.
// rigOwners is ownerOnlyLeaseOwners' result.
// Actions carry pids, start times and top's process name, never command lines.
export function decideRunaways(footprints, table, state, mono, { killHelpers = false, absentAtMostBytes = Infinity, rigOwners = new Set() } = {}) {
  const actions = [];
  const limits = runawayLimits(state.ramBytes);
  const byPid = new Map((table ?? []).map(p => [p.pid, p]));
  for (const pending of state.runaways) {
    const base = { target: pending.target, name: pending.name };
    if (!table) { actions.push({ type: 'runaway-wait', reason: 'process table unavailable for a pending runaway stop', ...base }); continue; }
    const row = byPid.get(pending.target.pid);
    if (!sameProcess(row, pending.target)) { actions.push({ type: 'runaway-finished', reason: 'runaway process exited', ...base }); continue; }
    if (pending.stage === 'killed') { actions.push({ type: 'runaway-alert', reason: 'runaway still present after SIGKILL', ...base }); continue; }
    if (!(mono - pending.stageAt >= CONFIG.runaway.killAfterMs)) { actions.push({ type: 'runaway-wait', ...base }); continue; }
    // It may have exec'd into a protected program, or taken a rig lease, since the SIGTERM.
    if (runawayProtected(row, byPid, state, rigOwners)) {
      actions.push({ type: 'runaway-ineligible', reason: 'became protected after SIGTERM; not killed', ...base });
      continue;
    }
    if (!footprints) { actions.push({ type: 'runaway-wait', reason: 'footprint unavailable 10 s after SIGTERM', ...base }); continue; }
    const now = footprints.get(identityKey(pending.target))?.samples.at(-1);
    // Missing from top's list proves it is below the floor only if the list's smallest entry is.
    if (!now && !(absentAtMostBytes < limits.floorBytes)) {
      actions.push({ type: 'runaway-wait', reason: 'not in top\'s list, which cannot show it is below the floor', ...base });
      continue;
    }
    if (!now || now.lowBytes < limits.floorBytes) {
      actions.push({ type: 'runaway-released', reason: 'below the runaway floor 10 s after SIGTERM; not killed', ...base });
      continue;
    }
    actions.push({ type: 'runaway-kill', reason: `still at least ${gib(now.lowBytes)} 10 s after SIGTERM`, ...base, footprintBytes: now.lowBytes });
  }
  if (!footprints || !table) return actions;
  const pendingKeys = new Set(state.runaways.map(r => identityKey(r.target)));
  for (const [key, track] of footprints) {
    if (pendingKeys.has(key)) continue;
    const found = runawayRule(track.samples, limits);
    if (!found) continue;
    const row = byPid.get(track.target.pid);
    if (!sameProcess(row, track.target)) continue;
    const action = { target: track.target, name: track.name, ...found };
    // Parent links are judged here, from the snapshot; the signal-time re-check
    // repeats the row's own protection. A parent can only change by exiting.
    if (!runawayProtected(row, byPid, state, rigOwners)) {
      actions.push({ type: 'runaway-term', ...action });
    } else if (killHelpers && restartableAppHelper(row, byPid.get(row.ppid), state)) {
      actions.push({ type: 'runaway-helper-kill', ...action, parent: identity(byPid.get(row.ppid)) });
    } else {
      actions.push({ type: 'runaway-alert', ...action, protected: true, reason: `${found.reason}; protected process, not signalled` });
    }
  }
  return actions;
}

// Signals at most one pid, after re-reading it. effects.context carries uid, home
// and guardPid; killHelpers is re-checked here, not trusted from the decision.
export function performRunaway(action, dryRun, effects, killHelpers) {
  if (dryRun || !['runaway-term', 'runaway-kill', 'runaway-helper-kill'].includes(action.type)) return action;
  const ctx = effects.context, target = action.target;
  const valid = t => Boolean(t) && Number.isSafeInteger(t.pid) && t.pid > 1;
  let eligible;
  if (action.type === 'runaway-helper-kill') {
    // Parent first, target last, so only the accepted gap below separates the
    // target's re-check from its signal.
    const parent = valid(action.parent) ? effects.identify(action.parent.pid) : null;
    const row = valid(target) ? effects.identify(target.pid) : null;
    eligible = killHelpers === true && sameProcess(row, target) && sameProcess(parent, action.parent) && restartableAppHelper(row, parent, ctx);
  } else {
    const row = valid(target) ? effects.identify(target.pid) : null;
    eligible = verifiedRow(row, target, ctx) && !lumeProcess(row);
  }
  if (!eligible) {
    return { ...action, type: 'runaway-ineligible', signalled: [],
      reason: 'not signalled: exited, identity changed, or no longer eligible at signal time' };
  }
  const signal = action.type === 'runaway-term' ? 'SIGTERM' : 'SIGKILL';
  // Accepted residual risk, as for leased victims: the re-check above and the
  // signal below are two operations with no identity-bound signal on macOS.
  if (!effects.signal(target.pid, signal)) {
    // ESRCH or EPERM: nothing was delivered, so the stop does not advance.
    return { ...action, type: 'runaway-signal-failed', signal, signalled: [], reason: `${signal} not delivered` };
  }
  return { ...action, signal, signalled: [target.pid] };
}

export function appendLog(file, entry) {
  const line = JSON.stringify(entry) + '\n';
  let size = 0;
  try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (size + Buffer.byteLength(line) > CONFIG.rotateBytes) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, line, { mode: 0o600 });
}

const expandHome = (file, home) => file.startsWith('~/') ? path.join(home, file.slice(2)) : file;

export const ownerHookArgs = ownerPid => ['--only', String(ownerPid), '--grace', '0'];
// Caret lead's addition: after a rig owner is SIGKILLed its exit trap never runs,
// so its clone's lume process can keep a VM alive. This sweep stops clones whose
// recorded owner is gone. Unverified here: any non-zero exit only raises an alert.
export const orphanHookArgs = Object.freeze(['--orphans', '--grace', '0']);
export const orphanAlert = 'orphan VM clone may remain; rig-stop --orphans unavailable';

// Resolves { code, signal, timedOut } or { error }; never rejects.
export function runHook(hook, args, deps) {
  return new Promise(resolve => {
    let settled = false, timedOut = false, timer, grace, child;
    const finish = result => {
      if (settled) return;
      settled = true;
      deps.clearTimeout(timer);
      deps.clearTimeout(grace);
      resolve(result);
    };
    try {
      // detached gives the hook a new session and process group whose id is its own pid.
      child = deps.spawn(expandHome(hook.command, deps.home), [...args], { detached: true, stdio: 'ignore' });
    } catch {
      finish({ error: 'stop hook could not start' });
      return;
    }
    child.once('error', () => finish({ error: 'stop hook could not start' }));
    child.once('exit', (code, signal) => finish({ code, signal, timedOut }));
    timer = deps.setTimeout(() => {
      timedOut = true;
      const group = child.pid;
      // The one negative pid this guard sends: the hook's own group, which the
      // guard just created, never a victim's. exitCode and signalCode are set in
      // the same synchronous step that reaps the hook, so while both are null its
      // pid, and thus its group id, cannot have been reused.
      if (Number.isSafeInteger(group) && group > 1 && child.exitCode === null && child.signalCode === null) {
        try { deps.kill(-group, 'SIGKILL'); } catch { /* group already gone */ }
      }
      grace = deps.setTimeout(() => finish({ code: null, signal: 'SIGKILL', timedOut: true }), 5000);
    }, hook.timeoutMs);
  });
}

function describeHook(result) {
  if (result.error) return result.error;
  if (result.timedOut) return 'timed out; hook process group killed';
  return result.code === 0 ? 'exit 0' : `exit ${result.code ?? result.signal}`;
}

// Effects are injected so tests never touch real processes. effects.context
// carries uid, home and guardPid for the protection re-check.
// A targeted stop follows the owner ladder's timing, but each step rebuilds the members from the verified group in a
// fresh snapshot, so a process forked into the group after a SIGTERM is still reached. It is finished when the group
// has no members, or when the owner is gone: a dead runner's lease no longer counts, exactly as for an untargeted one.
// The owner releases the lease itself once it sees the group empty, so a finished targeted stop releases nothing.
function decideTargetPending(reason, table, state, mono, leases) {
  const pending = state.pending;
  const base = { lease: pending.lease, owner: pending.owner, stopTarget: pending.stopTarget };
  // The target is only as current as its lease. Once the owner released the lease, which it does after seeing the
  // group empty, the group number may be reused, so a released or retargeted lease ends the stop without signals.
  if (!leases) return { type: 'alert', reason: 'lease inventory unavailable for the pending targeted stop', ...base };
  const leaseCurrent = targetCurrent(leases.find(lease => lease.id === pending.lease.id), pending.stopTarget);
  const row = table.find(p => p.pid === pending.owner.pid);
  if (!row || row.command === '<defunct>' || row.startMs > pending.owner.startMs) {
    return { type: 'finished', reason: 'owner exited; its lease no longer counts', ...base };
  }
  if (!verifiedRow(row, pending.owner, state)) {
    return { type: 'ineligible', reason: 'owner not eligible: identity changed or it became a protected process', ...base };
  }
  const tracked = [...(pending.members ?? []), ...(pending.targets ?? [])];
  const found = targetMembers(pending.stopTarget, pending.owner, table, state, tracked, leaseCurrent);
  if (found.skip === 'stop target has no members') {
    return { type: 'finished', reason: leaseCurrent ? 'stop target group and its tracked processes are gone'
      : 'lease released or retargeted, and no tracked process remains', ...base };
  }
  if (found.skip) return { type: 'ineligible', reason: found.skip, ...base };
  if (!reason) return { type: 'none', reason: 'no danger; waiting for the stopped group to exit' };
  const since = Math.max(pending.stageAt, state.dangerSince ?? Infinity);
  if (!(mono - since >= CONFIG.killMs)) return { type: 'wait', reason: `${reason}; waiting for 45 seconds of continued danger` };
  if (pending.stage === 'owner') return { type: 'escalate', reason, ...base, targets: found.members };
  if (pending.stage === 'tree') return { type: 'kill', reason, ...base, targets: found.members };
  return { type: 'alert', reason: `${reason}; stopped group still present after SIGKILL` };
}

// Signals a targeted stop's members, never the owner. The owner is re-verified first, and the members are rebuilt
// from one fresh snapshot; each is then checked by pid and start time immediately before its signal.
function performTarget(action, effects) {
  const signal = action.type === 'kill' ? 'SIGKILL' : 'SIGTERM';
  const ineligible = reason => ({ ...action, type: 'ineligible', signal, signalled: [], reason });
  if (!verifiedRow(effects.identify(action.owner.pid), action.owner, effects.context)) {
    return ineligible('owner not eligible at signal time: exited, identity changed or it became a protected process');
  }
  // Snapshot first, lease second (see readInventory). An unreadable inventory cannot confirm the group, so then only
  // tracked processes are signalled.
  let table;
  try { table = effects.table(); }
  catch { return { ...action, type: 'alert', reason: `${action.reason}; process table unavailable before signalling` }; }
  let leaseCurrent = false;
  try { leaseCurrent = targetCurrent(effects.leases().find(lease => lease.id === action.lease.id), action.stopTarget); }
  catch { /* leaseCurrent stays false */ }
  const tracked = [...(action.members ?? []), ...(action.targets ?? [])];
  const found = targetMembers(action.stopTarget, action.owner, table, effects.context, tracked, leaseCurrent);
  if (found.skip) return ineligible(found.skip);
  const signalled = [], skippedPids = [];
  for (const target of found.members) {
    const row = Number.isSafeInteger(target.pid) && target.pid > 1 ? effects.identify(target.pid) : null;
    // Same pid, start time and process group as the snapshot the members came from.
    if (!verifiedRow(row, target, effects.context) || row.pgid !== target.pgid || row.pid === action.owner.pid) {
      skippedPids.push(target.pid);
      continue;
    }
    if (effects.signal(target.pid, signal)) signalled.push(target.pid);
    else skippedPids.push(target.pid);
  }
  // Both fields carry the fresh set, so the pending stop tracks members first seen at this step.
  return { ...action, signal, signalled, skippedPids, members: found.members, targets: found.members };
}

// Why an owner stop decided earlier must not go ahead, or null. The lease may have gained a stop target since the
// decision, or have been released while the same owner, a runner, went on to a job whose lease has one. Either way
// the processes to stop are a group, not the owner. Any other case, including an unreadable inventory, leaves today's
// behaviour for every run that never sets a target.
function ownerStopCalledOff(action, effects) {
  let leases;
  try { leases = effects.leases(); } catch { return null; }
  const current = leases.find(lease => lease.id === action.lease.id);
  if (current?.stopTarget) return 'lease gained a stop target; the next decision stops its group instead of the owner';
  if (!current && leases.some(lease => lease.ownerPid === action.owner.pid && lease.stopTarget)) {
    return 'lease released and its owner now runs a job with a stop target';
  }
  return null;
}

export async function perform(action, dryRun, effects) {
  if (dryRun || !['term', 'escalate', 'kill', 'finished'].includes(action.type)) return action;
  if (action.stopTarget) return action.type === 'finished' ? { ...action, released: false } : performTarget(action, effects);
  if (action.type === 'finished') {
    // decide returns finished only after a fresh snapshot shows the owner gone or reused.
    let orphans = {};
    // effects.orphanSweep overrides the switch only in tests.
    if (action.orphanSweep && !(effects.orphanSweep ?? CONFIG.orphanSweep)) {
      orphans = { orphanResult: 'sweep switched off (CONFIG.orphanSweep)', alert: orphanAlert };
    } else if (action.orphanSweep) {
      const sweep = await effects.hook(action.orphanSweep, orphanHookArgs);
      // On failure, alert only: Lume and VM processes are never signalled directly.
      orphans = { orphanResult: describeHook(sweep), ...(sweep.code === 0 && !sweep.timedOut ? {} : { alert: orphanAlert }) };
    }
    effects.release(action.lease.id);
    return { ...action, released: true, ...orphans };
  }
  let result = action;
  if (action.type === 'term') {
    // Re-read the owner in one snapshot before any hook or signal. The guard is
    // the safety boundary; it does not rely on the hook's own owner check.
    if (!verifiedRow(effects.identify(action.owner.pid), action.owner, effects.context)) {
      return { ...action, type: 'ineligible', reason: 'owner not eligible: exited, identity changed or it became a protected process' };
    }
  }
  if (action.type === 'term' && action.hook) {
    const hookResult = describeHook(await effects.hook(action.hook, ownerHookArgs(action.owner.pid)));
    let present;
    try { present = effects.leases().some(lease => lease.id === action.lease.id); }
    catch { return { ...action, type: 'alert', reason: `${action.reason}; lease inventory unreadable after stop hook`, hookResult }; }
    if (!present) return { ...action, type: 'hook-released', hookResult };
    // The hook may take 60 seconds; fall back to signals only if danger still holds.
    if (!effects.stillDanger()) return { ...action, type: 'aborted', reason: 'danger ended while the stop hook ran', hookResult };
    result = { ...action, hookResult };
  }
  const signal = action.type === 'kill' ? 'SIGKILL' : 'SIGTERM';
  // Targets in tree order, owner first, plus the snapshot's ppid links for dropping subtrees.
  let order = [action.owner];
  const children = new Map();
  if (action.type !== 'term') {
    // Rebuild from the owner in one new snapshot; never trust the decision's list alone.
    let table;
    try { table = effects.table(); }
    catch { return { ...action, type: 'alert', reason: `${action.reason}; process table unavailable before signalling` }; }
    order = ownerTargets(action.lease, action.owner, action.targets, table, effects.context);
    for (const p of table) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p.pid);
    }
  }
  const ineligible = { ...result, type: 'ineligible', signal, signalled: [],
    reason: 'owner not eligible at signal time: exited, identity changed or it became a protected process' };
  if (order[0]?.pid !== action.owner.pid) return ineligible;
  const key = t => `${t.pid}:${t.startMs}`;
  const listed = new Set(order.map(key));
  const signalled = [], skippedPids = action.type === 'term' ? [] : action.targets.filter(t => !listed.has(key(t))).map(t => t.pid);
  const dropped = new Set();
  const dropSubtree = pid => {
    const stack = [pid];
    while (stack.length) {
      const next = stack.pop();
      if (dropped.has(next)) continue;
      dropped.add(next);
      stack.push(...(children.get(next) ?? []));
    }
  };
  for (const target of order) {
    if (dropped.has(target.pid)) {
      skippedPids.push(target.pid);
      continue;
    }
    const row = Number.isSafeInteger(target.pid) && target.pid > 1 ? effects.identify(target.pid) : null;
    if (!verifiedRow(row, target, effects.context)) {
      // The owner is first, so failing here means nothing has been signalled yet.
      if (target.pid === action.owner.pid) return ineligible;
      // A process that is protected, changed or gone takes its whole subtree out of this step.
      dropSubtree(target.pid);
      skippedPids.push(target.pid);
      continue;
    }
    // The decision may come from a lease read before the owner set a stop target, or released since. The owner is
    // first in order, so calling the step off here means nothing has been signalled.
    const calledOff = target.pid === action.owner.pid ? ownerStopCalledOff(action, effects) : null;
    if (calledOff) return { ...result, type: 'ineligible', signal, signalled: [], reason: calledOff };
    // Accepted residual risk: the identity check above and the signal below are
    // two operations, and macOS has no identity-bound signal (no pidfd). The pid
    // could in principle exit and be reused in between. macOS assigns pids in
    // increasing order and wraps only after 99,999, so reuse within that gap is
    // practically impossible.
    if (effects.signal(target.pid, signal)) signalled.push(target.pid);
    else skippedPids.push(target.pid);
  }
  return { ...result, signal, signalled, skippedPids };
}

// The notification rate limit: true when key may notify at monotonic time at, and
// then records it. Keys include a pid and start time, so a long-lived guard would
// otherwise keep one entry per process it ever saw. Entries 10 rate-limit periods
// old are dropped on each write; past one period they no longer limit anything, so
// dropping them changes no decision.
export function admitNotification(notifiedAt, key, at) {
  const every = CONFIG.runaway.notifyEveryMs, last = notifiedAt.get(key);
  if (last !== undefined && at - last < every) return false;
  for (const [k, t] of notifiedAt) if (!(at - t < 10 * every)) notifiedAt.delete(k);
  notifiedAt.set(key, at);
  return true;
}

// The sampling loop around decide and perform. io supplies every clock, reader,
// writer and effect, so tests drive it with fakes.
export function createGuard(io) {
  const state = { ...io.context, unattended: false, dangerSince: null, lastStepAt: null, pending: null, runaways: [] };
  const history = [];
  let lastReadingLogAt = -Infinity;
  let footprintTracks = new Map();
  const notifiedAt = new Map();
  // A failed write falls back to stderr; a failed stderr write is dropped.
  const emit = (write, entry) => {
    try { write(entry); return; } catch { /* fall through to stderr */ }
    try { io.stderr(JSON.stringify({ ...entry, logWriteFailed: true })); } catch { /* nothing left to report to */ }
  };
  const event = entry => {
    const line = { now: io.wallNow(), dryRun: io.observational, ...entry };
    emit(io.writeEvent, line);
    if (line.type === 'alert' || line.type === 'runaway-alert') emit(io.stderr, `mem-guard alert: ${JSON.stringify(line)}`);
  };
  // At most one notification per reason per minute, never in dry runs. The time is
  // taken before posting, so a failing notifier is rate-limited too. A failure,
  // thrown now or reported later by io.notify's callback, is logged and otherwise
  // ignored. reason is the failure; notification is the rate-limit key.
  const notify = (key, message) => {
    if (io.observational) return;
    if (!admitNotification(notifiedAt, key, io.monoNow())) return;
    const failed = reason => { try { event({ type: 'notify-failed', reason, notification: key }); } catch { /* nothing left to report to */ } };
    try { io.notify('mem-guard', message, failed); }
    catch { failed('notifier threw'); }
  };

  // replace: re-read before a step without adding a reading to the history,
  // so a re-read cannot count toward the consecutive-critical rule.
  function sample(replace = false) {
    const unattended = Boolean(io.unattended());
    if (state.unattended !== unattended) state.dangerSince = null;
    state.unattended = unattended;
    const previous = replace ? history.at(-2) : history.at(-1);
    const reading = io.readReading();
    if (replace && history.length) history[history.length - 1] = reading;
    else history.push(reading);
    if (history.length > CONFIG.attended.criticalCount) history.shift();
    const broken = previous !== undefined && !(known(previous) && known(reading) && contiguous(previous, reading));
    if (!danger(history, unattended)) state.dangerSince = null;
    else if (state.dangerSince == null || broken) state.dangerSince = reading.mono;
    if (reading.unknown || reading.pressure !== 1 || !(reading.mono - lastReadingLogAt < CONFIG.logMs)) {
      emit(io.writeReading, { ...reading, dryRun: io.observational });
      lastReadingLogAt = reading.mono;
    }
    return reading;
  }

  const effects = {
    ...io.effects,
    context: state,
    hook: async (hook, args) => {
      // Keep sampling while the hook runs, so continued danger is measured, not
      // assumed, and so a runaway is still caught during a 60-second hook.
      const timer = io.setInterval(() => {
        try { sample(); } catch { state.dangerSince = null; return; }
        if (!io.running || io.running()) runawayStep(); // a stopping guard sends no new signals
      }, CONFIG.sampleMs);
      try { return await io.effects.hook(hook, args); }
      finally { io.clearInterval(timer); }
    },
    stillDanger: () => {
      if (io.running && !io.running()) return false;
      sample(true);
      return Boolean(danger(history, state.unattended));
    },
  };

  const loadInventory = () => {
    try { return io.readInventory(); } catch { return { leases: null, table: null }; }
  };

  function apply(planned, result) {
    const at = io.monoNow();
    // An ineligible owner was not acted on, so it does not use up the 90-second spacing.
    if (planned.type === 'term' && result.type !== 'ineligible') state.lastStepAt = at;
    if (result.type === 'term') {
      state.pending = { lease: result.lease, owner: result.owner, members: result.members, stage: 'owner', stageAt: at,
        ...(result.stopTarget ? { stopTarget: result.stopTarget } : {}) };
    } else if (result.type === 'escalate') state.pending = { ...state.pending, targets: result.targets, stage: 'tree', stageAt: at };
    else if (result.type === 'kill') {
      // A targeted SIGKILL step carries the members it found, including one first seen in its snapshot and skipped at
      // its own check, so the stop is not declared finished while that process lives.
      state.pending = { ...state.pending, stage: 'killed', stageAt: at,
        ownerKilled: Boolean(result.signalled?.includes(state.pending.owner.pid)),
        ...(state.pending.stopTarget && result.targets ? { targets: result.targets } : {}) };
    } else if (['finished', 'hook-released', 'ineligible'].includes(result.type)) state.pending = null;
  }

  const runawayNotice = {
    'runaway-term': a => `Stopping runaway ${a.name} (pid ${a.target.pid}): ${a.reason}. SIGKILL in 10 s if it stays large.`,
    'runaway-kill': a => `SIGKILL sent to runaway ${a.name} (pid ${a.target.pid}): ${a.reason}.`,
    'runaway-helper-kill': a => `SIGKILL sent to app helper ${a.name} (pid ${a.target.pid}): ${a.reason}.`,
    'runaway-alert': a => `Runaway ${a.name} (pid ${a.target.pid}) NOT stopped: ${a.reason}. Quit it to protect the disk.`,
  };

  // A failed signal (runaway-signal-failed) changes nothing, so the next tick retries.
  function applyRunaway(result) {
    const key = identityKey(result.target);
    const others = state.runaways.filter(r => identityKey(r.target) !== key);
    // Taken after the signal, so the 10 seconds count from the SIGTERM itself.
    const entry = stage => ({ target: result.target, name: result.name, stage, stageAt: io.monoNow() });
    if (result.type === 'runaway-term') state.runaways = [...others, entry('term')];
    else if (result.type === 'runaway-kill' || result.type === 'runaway-helper-kill') state.runaways = [...others, entry('killed')];
    else if (['runaway-finished', 'runaway-released', 'runaway-ineligible'].includes(result.type)) state.runaways = others;
  }

  // Synchronous, so it can also run from the hook's sampling interval without
  // interleaving. Contained: a failure here never stops the leased logic.
  function runawayStep() {
    const results = [];
    try {
      const reading = history.at(-1);
      if (!reading || !wantsFootprint(history, state.runaways.length > 0)) return results;
      let table = null, footprints = null, rows = [];
      try { table = io.effects.table(); } catch { /* reported below */ }
      if (table) { try { rows = io.readFootprints(); } catch { rows = null; } }
      // After the reads, which can take seconds under thrash: every duration in the
      // rule counts from here.
      const mono = io.monoNow();
      if (table && rows) footprints = trackFootprints(footprintTracks, table, rows, mono);
      const absentAtMostBytes = rows?.length ? Math.min(...rows.map(r => r.highBytes)) : Infinity;
      if (footprints) {
        footprintTracks = footprints;
        const largest = [...footprints.values()].sort((a, b) => b.samples.at(-1).lowBytes - a.samples.at(-1).lowBytes).slice(0, 5)
          .map(t => ({ pid: t.target.pid, name: t.name, lowBytes: t.samples.at(-1).lowBytes }));
        emit(io.writeReading, { now: reading.now, mono, footprints: largest, dryRun: io.observational });
      } else {
        event({ type: 'unknown', reason: table ? 'footprint reading unavailable' : 'process table unavailable for the runaway check' });
      }
      const killHelpers = (io.runawayKillAppHelpers ?? CONFIG.runawayKillAppHelpers) === true;
      let leases = null;
      try { leases = io.effects.leases(); } catch { /* unreadable: no rig owners known; see runawayProtected */ }
      const rigOwners = ownerOnlyLeaseOwners(leases, io.wallNow());
      for (const action of decideRunaways(footprints, table, state, mono, { killHelpers, absentAtMostBytes, rigOwners })) {
        if (action.type === 'runaway-wait' && !action.reason) continue; // the quiet 10-second wait
        event(action);
        const result = performRunaway(action, io.observational, effects, killHelpers);
        applyRunaway(result);
        if (result !== action) event(result);
        if (runawayNotice[result.type]) notify(`${result.type}:${identityKey(result.target)}`, runawayNotice[result.type](result));
        if (!io.observational && (result.signalled?.length || result.type === 'runaway-finished')) {
          emit(entry => io.recordRunaway(entry, reading), result);
        }
        results.push(result);
      }
    } catch {
      try { event({ type: 'unknown', reason: 'runaway check failed' }); } catch { /* nothing left to report to */ }
    }
    return results;
  }

  async function tick() {
    try {
      sample();
      // Before the leased logic, whose stop hook can take 60 seconds.
      const runaway = runawayStep();
      let inventory = { leases: [], table: [] };
      if (danger(history, state.unattended) || state.pending) inventory = loadInventory();
      let action = decide(history, inventory.leases, inventory.table, state, io.wallNow());
      if (['term', 'escalate', 'kill'].includes(action.type)) {
        sample(true);
        inventory = loadInventory();
        action = decide(history, inventory.leases, inventory.table, state, io.wallNow());
      }
      if (io.once) emit(io.print, { reading: history.at(-1), action, runaway, dryRun: true });
      if (action.type !== 'none') event(action);
      if (action.type === 'alert' && action.reason.endsWith('no live leased job to stop')) {
        notify(action.reason, `Memory danger, nothing leased to stop: ${action.reason.replace(/; no live leased job to stop$/, '')}.`);
      }
      const result = await perform(action, io.observational, effects);
      apply(action, result);
      if (result !== action) event(result);
      if (result.alert) event({ type: 'alert', reason: result.alert, lease: result.lease, owner: result.owner, orphanResult: result.orphanResult });
      if (!io.observational && ['term', 'hook-released', 'escalate', 'kill', 'finished'].includes(result.type)) {
        emit(entry => io.record(entry, history.at(-1)), result);
      }
      return result;
    } catch {
      state.dangerSince = null;
      const failure = { type: 'unknown', reason: 'guard step failed' };
      event(failure);
      if (io.once) emit(io.print, { action: failure, dryRun: true });
      return failure;
    }
  }
  return { state, history, sample, tick };
}

function writeRecord(directory, action, reading) {
  const label = String(action.lease.run).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const file = path.join(directory, `STOPPED-${label}-${Date.now()}-${action.type}.md`);
  const lines = [
    `# Stopped leased job ${label}`, '',
    `${action.type}: lease ${action.lease.id} (${action.lease.kind}), owner PID ${action.owner.pid}.`,
    ...(action.hookResult ? [`Stop hook: ${action.hookResult}.`] : []),
    ...(action.orphanResult ? [`Orphan clone sweep (rig-stop --orphans): ${action.orphanResult}.`] : []),
    ...(action.alert ? [`ALERT: ${action.alert}.`] : []),
    ...(action.signal ? [`${action.signal} sent to PIDs [${action.signalled.join(', ')}]; skipped after re-check: [${action.skippedPids.join(', ')}].`] : []),
    ...(action.released ? ['Lease released after the owner exited.'] : []),
    `Reason: ${action.reason}.`,
    `Readings: ${JSON.stringify(reading)}`, '',
    `Ask the lead of run ${label} to rerun the leased task.`,
    'Command arguments are omitted because they may contain secrets.', '',
  ];
  fs.writeFileSync(file, lines.join('\n'), { flag: 'wx', mode: 0o600 });
}

function writeRunawayRecord(directory, action, reading) {
  const label = String(action.name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  // The pid keeps two same-name records from one millisecond apart; 'wx' would otherwise throw on the second.
  const file = path.join(directory, `STOPPED-runaway-${label}-${action.target.pid}-${Date.now()}-${action.type}.md`);
  const lines = [
    `# Runaway process ${label}`, '',
    `${action.type}: ${action.name}, PID ${action.target.pid}, started ${new Date(action.target.startMs).toISOString()}.`,
    ...(action.parent ? [`Helper of protected app main PID ${action.parent.pid}; CONFIG.runawayKillAppHelpers is on.`] : []),
    ...(action.signal ? [`${action.signal} sent to PIDs [${action.signalled.join(', ')}] after re-checking pid and start time.`] : []),
    `Why: ${action.reason}.`,
    'Rule: physical footprint (top MEM, includes compressed and swapped memory) at least max(6 GiB, a quarter of RAM)',
    'that grew at least 1 GiB within 30 s, or at least half of RAM.',
    `Readings: ${JSON.stringify(reading)}`, '',
    'No lease is involved. If this process belonged to a run, ask that run\'s lead to rerun it.',
    'Command arguments are omitted because they may contain secrets.', '',
  ];
  fs.writeFileSync(file, lines.join('\n'), { flag: 'wx', mode: 0o600 });
}

export const notifyTimeoutMs = 10000;

// Posts a notification without waiting for it. The text goes in as arguments, never
// into the script source. A notification that never shows is otherwise invisible,
// so a failed spawn, a non-zero exit or a timeout each call onFailure once, with a
// reason built from fixed text and codes only (never the message). Nothing here
// throws or blocks: all three are reported from callbacks after this returns.
// The guard times osascript itself, not through spawn's timeout option, because a
// timeout kill and any other SIGKILL look the same at 'exit'.
export function postNotification(title, message, onFailure = () => {}, deps = { spawn, setTimeout, clearTimeout }) {
  let settled = false, timer, child;
  const settle = reason => {
    if (settled) return;
    settled = true;
    deps.clearTimeout(timer);
    if (reason) { try { onFailure(reason); } catch { /* nothing left to report to */ } }
  };
  try {
    child = deps.spawn('/usr/bin/osascript', ['-e', 'on run argv', '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message],
    { stdio: 'ignore' });
  } catch (error) {
    settle(`osascript could not start: ${error?.code ?? 'spawn threw'}`);
    return;
  }
  // on, not once: a later 'error' (such as a failed kill) with no listener would crash the guard.
  child.on('error', error => settle(`osascript could not start: ${error?.code ?? 'spawn error'}`));
  child.once('exit', (code, signal) => settle(code === 0 ? null : `osascript exited ${code ?? signal}`));
  timer = deps.setTimeout(() => {
    // exitCode and signalCode are set when the child is reaped, so while both are
    // null its pid cannot have been reused, and this kills only osascript.
    if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    settle(`osascript timed out after ${notifyTimeoutMs / 1000} s; killed`);
  }, notifyTimeoutMs);
  timer?.unref?.();
  child.unref?.();
}

// main's signal effect, exported so a test can run it against a real child.
export function signalPid(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('refusing to signal a group, launchd or invalid pid');
  try { process.kill(pid, signal); return true; }
  catch (error) { if (error.code === 'ESRCH' || error.code === 'EPERM') return false; throw error; }
}

async function main(args) {
  let durationMs = Infinity;
  const durationIndex = args.indexOf('--duration-seconds');
  if (durationIndex !== -1) {
    const value = args[durationIndex + 1];
    if (!args.includes('--dry-run') || !/^\d+$/.test(value ?? '') || Number(value) <= 0 || !Number.isSafeInteger(Number(value) * 1000)) {
      throw new Error('--duration-seconds requires --dry-run and positive integer seconds');
    }
    durationMs = Number(value) * 1000;
    args = [...args.slice(0, durationIndex), ...args.slice(durationIndex + 2)];
  }
  const allowed = ['--dry-run', '--once', '--locked'];
  if (args.some(arg => !allowed.includes(arg)) || new Set(args).size !== args.length) throw new Error('usage: mem-guard.mjs [--dry-run] [--once] [--duration-seconds N]');
  const dryRun = args.includes('--dry-run'), once = args.includes('--once');
  // --once is always observational, even without --dry-run.
  const observational = dryRun || once;
  const directory = path.join(root, 'mem-guard');
  const leaseDirectory = path.join(root, 'leases');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!observational && !args.includes('--locked')) {
    const child = spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', path.join(directory, '.mutex'),
      process.execPath, fileURLToPath(import.meta.url), '--locked'], { stdio: 'inherit' });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 75;
    return;
  }
  // Non-fatal since nice became 0: an unprivileged process can't raise its own
  // priority, so a guard started under nice keeps running at the inherited level.
  try { os.setPriority(0, CONFIG.nice); }
  catch { process.stderr.write(`mem-guard: could not set priority ${CONFIG.nice}; continuing at the inherited priority\n`); }
  let running = true;
  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });
  const home = os.homedir();
  const guard = createGuard({
    observational, once,
    context: { uid: process.getuid(), home, guardPid: process.pid, ramBytes: os.totalmem() },
    running: () => running,
    unattended: () => fs.existsSync(path.join(root, 'UNATTENDED')),
    readReading: () => readSnapshot(command, undefined, Date.now(), performance.now()),
    readFootprints: () => readFootprints(),
    notify: postNotification,
    recordRunaway: (action, reading) => writeRunawayRecord(directory, action, reading),
    // The process table is read before the leases. A lease still present after the snapshot was not yet released when
    // the snapshot was taken, so its owner had not moved on to a later job: the snapshot's processes in its target
    // group are that lease's job, not a later one that reused the number.
    readInventory: () => { const table = readProcessTable(); return { table, leases: readLeases(leaseDirectory) }; },
    wallNow: () => Date.now(),
    monoNow: () => performance.now(),
    writeReading: entry => appendLog(path.join(directory, 'readings.log'), entry),
    writeEvent: entry => appendLog(path.join(directory, 'events.log'), entry),
    stderr: text => process.stderr.write(`${text}\n`),
    print: entry => process.stdout.write(`${JSON.stringify(entry)}\n`),
    record: (action, reading) => writeRecord(directory, action, reading),
    setInterval, clearInterval,
    effects: {
      identify: pid => identifyProcess(pid),
      table: () => readProcessTable(),
      signal: signalPid,
      release: id => command(path.join(root, 'bin', 'lr-lease'), ['release', id]),
      leases: () => readLeases(leaseDirectory),
      hook: (hook, args) => runHook(hook, args, {
        spawn, home, kill: (pid, signal) => process.kill(pid, signal), setTimeout, clearTimeout,
      }),
    },
  });
  const deadline = performance.now() + durationMs;
  do {
    const tickAt = performance.now();
    const result = await guard.tick();
    if (once && result.reason === 'guard step failed') process.exitCode = 1;
    if (once || !running || performance.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve,
      Math.max(0, Math.min(deadline - performance.now(), CONFIG.sampleMs - (performance.now() - tickAt)))));
  } while (running);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('mem-guard failed to start; check options, priority and log directory'); process.exitCode = 1; });
}

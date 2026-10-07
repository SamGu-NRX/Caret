import * as fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const GB = 1024 ** 3;
export const KINDS = ['heavy', 'gui', 'vm', 'container'];
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 10000 }).trim();
const nonnegative = value => Number.isFinite(value) && value >= 0;
export const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);

export function parseSwap(text) {
  const match = /free\s*=\s*([\d.]+)([KMGT])\b/.exec(text);
  if (!match) throw new Error('cannot parse vm.swapusage free');
  return Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2]) + 1) / GB;
}

export function parsePressure(text) {
  const level = Number(text.trim());
  if (![1, 2, 4].includes(level)) throw new Error('unknown memory pressure level');
  return { 1: 'normal', 2: 'warning', 4: 'critical' }[level];
}

export function parseQuiet(text) {
  const first = text.trim().split(/\s+/)[0];
  if (!/^\d+(\.\d+)?$/.test(first) || !nonnegative(Number(first))) {
    throw new Error('QUIET-UNTIL must start with epoch seconds');
  }
  return Number(first) * 1000;
}

export function machineReaders(root) {
  return {
    now: () => Date.now(),
    diskGB: () => {
      const stat = fs.statfsSync(root, { bigint: true });
      return Number(stat.bavail * stat.bsize) / GB;
    },
    swapGB: () => parseSwap(command('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])),
    pressure: () => parsePressure(command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])),
    quietUntil: () => {
      try { return parseQuiet(fs.readFileSync(path.join(root, 'QUIET-UNTIL'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    },
    pidAlive: pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
    },
    // Start time in epoch ms (whole seconds, as ps reports it), or null when ps cannot say. The reaper uses it
    // to tell a live owner from a reused pid.
    pidStartedAt: pid => {
      let text;
      try {
        text = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)],
          { encoding: 'utf8', timeout: 10000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
      } catch { return null; }
      const at = Date.parse(`${text.replace(/\s+/g, ' ')} UTC`);
      return Number.isFinite(at) ? at : null;
    },
  };
}

// mem-guard and rig-stop use the same rule: the owner started after the lease was created means its pid was reused.
const START_TOLERANCE_MS = 2000;

export function readPolicy(file) {
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!nonnegative(policy.defaultTtlMinutes) || policy.defaultTtlMinutes === 0) throw new Error('invalid policy TTL');
  for (const kind of KINDS) {
    const rule = policy.kinds?.[kind];
    if (!rule || !Number.isInteger(rule.maxCount) || rule.maxCount < 0 ||
        !nonnegative(rule.diskFloorGB) || !nonnegative(rule.swapFloorGB)) {
      throw new Error(`invalid policy for ${kind}`);
    }
  }
  return policy;
}

export function readLeases(directory) {
  return fs.readdirSync(directory).filter(name => validId(name.replace(/\.json$/, '')) && name.endsWith('.json')).map(name => {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw new Error(`lease is not a regular file: ${name}`);
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (lease.id !== name.slice(0, -5) || !KINDS.includes(lease.kind) ||
        typeof lease.run !== 'string' || !lease.run || !Number.isInteger(lease.ownerPid) || lease.ownerPid <= 0 ||
        !nonnegative(lease.estMemGB) || !nonnegative(lease.estDiskGB) || !nonnegative(lease.expiresAt)) {
      throw new Error(`invalid lease record: ${name}`);
    }
    return lease;
  });
}

export function snapshot(readers) {
  const readings = { now: readers.now(), diskGB: readers.diskGB(), swapGB: readers.swapGB(),
    pressure: readers.pressure(), quietUntil: readers.quietUntil() };
  for (const key of ['now', 'diskGB', 'swapGB', 'quietUntil']) {
    if (!nonnegative(readings[key])) throw new Error(`invalid reading: ${key}`);
  }
  if (!['normal', 'warning', 'critical'].includes(readings.pressure)) throw new Error('invalid pressure reading');
  return readings;
}

export function decision(kind, estMemGB, estDiskGB, leases, policy, readings) {
  const rule = policy.kinds[kind];
  if (rule.maxCount === 0) return 'disabled by policy';
  if (leases.filter(lease => lease.kind === kind).length >= rule.maxCount) return `count limit ${rule.maxCount} reached`;
  if (kind !== 'heavy' && readings.quietUntil > readings.now) return `quiet window until ${new Date(readings.quietUntil).toISOString()}`;
  if (readings.pressure === 'critical') return 'critical memory pressure';
  // Outstanding estimates stay reserved until release/reap. This may double-count resources already consumed,
  // but prevents concurrent kinds from promising the same remaining disk or swap.
  const reservedDisk = leases.reduce((sum, lease) => sum + lease.estDiskGB, 0);
  const reservedMem = leases.reduce((sum, lease) => sum + lease.estMemGB, 0);
  const diskAfter = readings.diskGB - reservedDisk - estDiskGB;
  if (diskAfter < rule.diskFloorGB) return `low disk: ${diskAfter.toFixed(2)} GiB after reservations, need ${rule.diskFloorGB} GiB`;
  // macOS adds swap files on demand, so current free swap understates headroom (a peer saw total swap grow
  // 14 -> 16 GB in one day with 38 GB disk free). Under normal pressure, memory estimates are charged against
  // disk, where swap would grow. Under warning pressure, free swap must also cover them.
  const diskAfterSwapGrowth = diskAfter - reservedMem - estMemGB;
  if (diskAfterSwapGrowth < rule.diskFloorGB) return `low disk for swap growth: ${diskAfterSwapGrowth.toFixed(2)} GiB after memory estimates, need ${rule.diskFloorGB} GiB`;
  if (readings.pressure === 'warning') {
    const swapAfter = readings.swapGB - reservedMem - estMemGB;
    if (swapAfter < rule.swapFloorGB) return `low swap under warning pressure: ${swapAfter.toFixed(2)} GiB after reservations, need ${rule.swapFloorGB} GiB`;
  }
  return null;
}

// The caller must hold the common lockf mutex across this entire operation.
export function acquire(directory, policy, readers, request) {
  if (!KINDS.includes(request.kind) || typeof request.run !== 'string' || !request.run.trim() || /[\r\n]/.test(request.run) ||
      !nonnegative(request.estMemGB) || !nonnegative(request.estDiskGB) ||
      !Number.isInteger(request.ownerPid) || request.ownerPid <= 0) throw new Error('invalid acquisition request');
  const ttl = request.ttlMinutes ?? policy.defaultTtlMinutes;
  if (!nonnegative(ttl) || ttl === 0) throw new Error('TTL must be positive minutes');
  const readings = snapshot(readers);
  if (!readers.pidAlive(request.ownerPid)) return { reason: 'owner pid is dead' };
  const reason = decision(request.kind, request.estMemGB, request.estDiskGB, readLeases(directory), policy, readings);
  if (reason) return { reason };
  const lease = { id: randomUUID(), ownerPid: request.ownerPid, run: request.run, kind: request.kind,
    estMemGB: request.estMemGB, estDiskGB: request.estDiskGB, createdAt: readings.now, expiresAt: readings.now + ttl * 60000 };
  if (!Number.isFinite(lease.expiresAt) || lease.expiresAt > 8640000000000000) throw new Error('TTL exceeds supported date range');
  const temporary = path.join(directory, `.${lease.id}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(lease) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, `${lease.id}.json`));
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { lease };
}

export function release(directory, id) {
  // Show what arrived, so a caller whose shell variable was empty or mangled can see it.
  if (!validId(id)) throw new Error(`invalid lease ID ${JSON.stringify(String(id).slice(0, 60))} (length ${String(id).length})`);
  // Idempotent: releasing a lease that is already gone (reaped, or released twice) is not an error.
  try { fs.unlinkSync(path.join(directory, `${id}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Extends a live lease's expiresAt for its own owner. Expiry no longer reaps a live owner (see reap), but mem-guard
// only picks victims among leases whose expiresAt is in the future, so a long job renews to stay stoppable.
export function renew(directory, id, ownerPid, ttlMinutes, now) {
  if (!validId(id)) throw new Error(`invalid lease ID ${JSON.stringify(String(id).slice(0, 60))} (length ${String(id).length})`);
  if (!nonnegative(ttlMinutes) || ttlMinutes === 0) throw new Error('TTL must be positive minutes');
  if (!nonnegative(now)) throw new Error('invalid time reading');
  // The same bound acquire applies: readLeases accepts any nonnegative expiresAt, so an unrepresentable one must stop here.
  const expiresAt = now + ttlMinutes * 60000;
  if (!Number.isFinite(expiresAt) || expiresAt > 8640000000000000) throw new Error('TTL exceeds supported date range');
  const lease = readLeases(directory).find(record => record.id === id);
  if (!lease) return { reason: 'no such lease' };
  if (lease.ownerPid !== ownerPid) return { reason: `lease is owned by pid ${lease.ownerPid}, not ${ownerPid}` };
  const renewed = { ...lease, expiresAt };
  const temporary = path.join(directory, `.${id}.renew.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(renewed) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, `${id}.json`));
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { lease: renewed };
}

// A lease is reaped only when its owner is confirmed gone: no such pid, or the pid now belongs to a process that
// started after the lease was created (reused). Expiry alone no longer reaps it. 2026-10-07, Caret's wrapper review
// (STATE.md, WRAPPER REVIEW a221c41d, blocker 3): with-heavy's 60-minute TTL was shorter than 120-minute jobs, so the
// reaper handed a running job's heavy lease to the next rig-run. A live owner whose start time cannot be read is kept.
export function reap(directory, readers, run) {
  const now = readers.now();
  if (!nonnegative(now)) throw new Error('invalid time reading');
  const removed = [];
  for (const lease of readLeases(directory)) {
    if (run !== undefined && lease.run !== run) continue;
    let reason = null;
    if (!readers.pidAlive(lease.ownerPid)) reason = 'owner dead';
    else {
      const started = readers.pidStartedAt(lease.ownerPid);
      if (started !== null && started > lease.createdAt + START_TOLERANCE_MS) reason = 'owner pid reused';
    }
    if (reason) {
      fs.unlinkSync(path.join(directory, `${lease.id}.json`));
      removed.push({ id: lease.id, reason });
    }
  }
  return removed;
}

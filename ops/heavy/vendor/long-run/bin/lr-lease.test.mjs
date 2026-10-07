import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquire, release, renew, renewByToken, ack, oblige, reap, readLeases, readPolicy, decision, parsePressure, parseSwap, parseQuiet, machineReaders } from './lr-lease-core.mjs';

const bin = path.dirname(fileURLToPath(import.meta.url));
// Tests pin the counts they assert. The live policy's thresholds are reused, but its counts are tuned
// by the lead (vm.maxCount went 0 -> 1 on 2026-10-03), and tuning them must not break these tests.
const policy = structuredClone(readPolicy(path.join(bin, '..', 'lease-policy.json')));
policy.kinds.vm.maxCount = 0;
policy.kinds.heavy.maxCount = 1;
const readings = { now: 1000000, diskGB: 100, swapGB: 100, pressure: 'normal', quietUntil: 0 };
const request = { run: 'lease-unit-test', kind: 'heavy', estMemGB: 2, estDiskGB: 3, ownerPid: process.pid };
function readers(overrides = {}) {
  const r = { ...readings, ...overrides };
  // Owners started before the lease was created unless a test says otherwise.
  return { ...Object.fromEntries(Object.entries(r).map(([key, value]) => [key, () => value])), pidAlive: () => true,
    pidStartedAt: () => readings.now - 1000 };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(bin, '.lr-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

for (const [name, changes, kind, reason] of [
  ['low disk', { diskGB: 10 }, 'heavy', /low disk/],
  ['critical pressure', { pressure: 'critical' }, 'heavy', /critical memory/],
  ['low swap under warning pressure', { swapGB: 1, pressure: 'warning' }, 'heavy', /low swap under warning/],
  ['low disk for swap growth', { diskGB: 12 }, 'heavy', /swap growth/],
  ['quiet gui', { quietUntil: readings.now + 1 }, 'gui', /quiet window/],
  ['quiet container', { quietUntil: readings.now + 1 }, 'container', /quiet window/],
  ['disabled vm', {}, 'vm', /disabled/],
]) {
  test(`refuses ${name} without writing a lease`, t => {
    const directory = fixture(t);
    const result = acquire(directory, policy, readers(changes), { ...request, kind });
    assert.match(result.reason, reason);
    assert.equal(readLeases(directory).length, 0);
  });
}

test('grant records owner, estimates and default TTL; release deletes exactly that record', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), request);
  assert.equal(lease.ownerPid, process.pid);
  assert.equal(lease.expiresAt, readings.now + 45 * 60000);
  assert.equal(lease.estMemGB, 2);
  assert.equal(lease.estDiskGB, 3);
  assert.deepEqual(readLeases(directory), [lease]);
  release(directory, lease.id);
  assert.deepEqual(readLeases(directory), []);
});

test('count limit blocks a second grant', t => {
  const directory = fixture(t);
  acquire(directory, policy, readers(), request);
  assert.match(acquire(directory, policy, readers(), request).reason, /count limit/);
  assert.equal(readLeases(directory).length, 1);
});

test('boundary floors grant; warning pressure is allowed; past quiet does not block', t => {
  const directory = fixture(t);
  // disk 13: 13 - 3 (disk) = 10 >= 8, and 10 - 2 (memory as swap growth) = 8 >= 8; warning swap 2 - 2 = 0 >= 0.
  assert.ok(acquire(directory, policy, readers({ diskGB: 13, swapGB: 2, pressure: 'warning', quietUntil: readings.now }), request).lease);
});

test('heavy is allowed during quiet; configurable TTL is respected', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers({ quietUntil: readings.now + 500 }), { ...request, ttlMinutes: 1 });
  assert.equal(lease.expiresAt, readings.now + 60000);
});

test('enabled VM uses the policy floor and quiet gate', () => {
  const enabled = structuredClone(policy);
  enabled.kinds.vm.maxCount = 1;
  const floor = enabled.kinds.vm.diskFloorGB;
  assert.match(decision('vm', 0, 1, [], enabled, { ...readings, diskGB: floor }), /low disk/);
  assert.equal(decision('vm', 0, 1, [], enabled, { ...readings, diskGB: floor + 1 }), null);
  assert.match(decision('vm', 0, 0, [], enabled, { ...readings, quietUntil: readings.now + 1 }), /quiet window/);
});

test('outstanding estimates are reserved across kinds and policy can add a swap floor', () => {
  const lease = { ...request, estDiskGB: 5, estMemGB: 4 };
  assert.match(decision('gui', 0, 0, [lease], policy, { ...readings, diskGB: 12 }), /low disk/);
  assert.match(decision('gui', 1, 0, [lease], policy, { ...readings, swapGB: 4, pressure: 'warning' }), /low swap/);
  // Normal pressure: low free swap alone no longer refuses, because macOS grows swap into free disk.
  assert.equal(decision('gui', 1, 0, [lease], policy, { ...readings, swapGB: 0.5 }), null);
  const changed = structuredClone(policy);
  changed.kinds.gui.swapFloorGB = 2;
  assert.match(decision('gui', 1, 0, [], changed, { ...readings, swapGB: 2, pressure: 'warning' }), /low swap/);
});

test('reaper removes dead owners and keeps a live owner past its TTL, and unrelated files', t => {
  const directory = fixture(t);
  const unlimited = structuredClone(policy);
  unlimited.kinds.heavy.maxCount = 5;
  const dead = acquire(directory, unlimited, readers(), { ...request, ownerPid: 111 }).lease;
  const expiredLive = acquire(directory, unlimited, readers(), { ...request, ownerPid: 222, ttlMinutes: 1 }).lease;
  const live = acquire(directory, unlimited, readers(), { ...request, ownerPid: 333 }).lease;
  fs.writeFileSync(path.join(directory, 'unrelated-file'), 'untouched');
  const injected = readers({ now: readings.now + 120 * 60000 });
  injected.pidAlive = pid => pid !== 111;
  const removed = reap(directory, injected);
  assert.deepEqual(removed, [{ id: dead.id, reason: 'owner dead' }]);
  assert.deepEqual(new Set(readLeases(directory).map(lease => lease.id)), new Set([expiredLive.id, live.id]));
  assert.equal(fs.readFileSync(path.join(directory, 'unrelated-file'), 'utf8'), 'untouched');
});

test('reaper treats a pid that started after the lease as reused; unreadable start time keeps the lease', t => {
  const directory = fixture(t);
  const unlimited = structuredClone(policy);
  unlimited.kinds.heavy.maxCount = 5;
  const reused = acquire(directory, unlimited, readers(), { ...request, ownerPid: 444 }).lease;
  const tolerated = acquire(directory, unlimited, readers(), { ...request, ownerPid: 555 }).lease;
  const unknown = acquire(directory, unlimited, readers(), { ...request, ownerPid: 666 }).lease;
  const injected = readers({ now: readings.now + 60000 });
  injected.pidStartedAt = pid => ({ 444: readings.now + 5000, 555: readings.now + 2000, 666: null })[pid];
  assert.deepEqual(reap(directory, injected), [{ id: reused.id, reason: 'owner pid reused' }]);
  assert.deepEqual(new Set(readLeases(directory).map(lease => lease.id)), new Set([tolerated.id, unknown.id]));
});

test('renew extends only its own owner\'s lease', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), { ...request, ttlMinutes: 1 });
  assert.match(renew(directory, lease.id, process.pid + 1, 5, readings.now + 30000).reason, /owned by pid/);
  assert.equal(readLeases(directory)[0].expiresAt, lease.expiresAt);
  const renewed = renew(directory, lease.id, process.pid, 5, readings.now + 30000).lease;
  assert.equal(renewed.expiresAt, readings.now + 30000 + 5 * 60000);
  assert.deepEqual(readLeases(directory), [renewed]);
  assert.match(renew(directory, '00000000-0000-4000-8000-000000000000', process.pid, 5, readings.now).reason, /no such lease/);
  assert.throws(() => renew(directory, lease.id, process.pid, 0, readings.now), /TTL/);
});

test('renew refuses an expiry it cannot represent, and a bad clock reading', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), { ...request, ttlMinutes: 1 });
  // 8640000000000000 ms is the largest Date; a TTL past it, or a non-finite now, must not reach the record.
  assert.throws(() => renew(directory, lease.id, process.pid, 1e15, readings.now), /date range/);
  assert.throws(() => renew(directory, lease.id, process.pid, 5, NaN), /invalid time reading/);
  assert.throws(() => renew(directory, lease.id, process.pid, 5, -1), /invalid time reading/);
  assert.throws(() => renew(directory, lease.id, process.pid, Infinity, readings.now), /TTL|date range/);
  assert.deepEqual(readLeases(directory), [lease]);
  // The last representable expiry is accepted.
  const max = 8640000000000000;
  const edge = renew(directory, lease.id, process.pid, 1, max - 60000).lease;
  assert.equal(edge.expiresAt, max);
  assert.throws(() => renew(directory, lease.id, process.pid, 1, max - 59999), /date range/);
});

test('real readers: a live child past its TTL keeps its lease, and is reaped once it has exited', async t => {
  const directory = fixture(t);
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const exited = new Promise(resolve => proc.on('close', resolve));
  t.after(() => proc.kill('SIGKILL'));
  const real = machineReaders(bin);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const started = real.pidStartedAt(proc.pid);
  assert.ok(started !== null && Math.abs(started - Date.now()) < 10000, `start time ${started}`);
  const { lease } = acquire(directory, policy, readers({ now: Date.now() }), { ...request, ownerPid: proc.pid, ttlMinutes: 1 });
  const later = { ...real, now: () => Date.now() + 10 * 60000 };
  assert.deepEqual(reap(directory, later), []);
  assert.deepEqual(readLeases(directory), [lease]);
  proc.kill('SIGKILL');
  await exited;
  assert.deepEqual(reap(directory, later), [{ id: lease.id, reason: 'owner dead' }]);
});

test('run-filtered reaper leaves other runs, even when their owner is dead', t => {
  const directory = fixture(t);
  const first = acquire(directory, policy, readers(), { ...request, ttlMinutes: 1 }).lease;
  const other = acquire(directory, policy, readers(), { ...request, kind: 'gui', run: 'other-test-run', ttlMinutes: 1 }).lease;
  const dead = readers({ now: readings.now + 60000 });
  dead.pidAlive = () => false;
  const removed = reap(directory, dead, request.run);
  assert.equal(removed[0].id, first.id);
  assert.deepEqual(readLeases(directory), [other]);
});

test('readers fail closed; dead owner, invalid estimate, TTL and path traversal are rejected', t => {
  const directory = fixture(t);
  assert.throws(() => acquire(directory, policy, readers({ diskGB: NaN }), request), /invalid reading/);
  const failed = readers();
  failed.pressure = () => { throw new Error('pressure unavailable'); };
  assert.throws(() => acquire(directory, policy, failed, request), /unavailable/);
  failed.pressure = () => 'normal';
  failed.pidAlive = () => false;
  assert.match(acquire(directory, policy, failed, request).reason, /owner pid is dead/);
  assert.throws(() => acquire(directory, policy, readers(), { ...request, estMemGB: -1 }), /invalid/);
  assert.throws(() => acquire(directory, policy, readers(), { ...request, ttlMinutes: 0 }), /TTL/);
  assert.throws(() => release(directory, '../outside'), /invalid lease ID/);
});

test('malformed lease fails closed instead of being deleted', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), request);
  const file = path.join(directory, `${lease.id}.json`);
  fs.writeFileSync(file, '{');
  assert.throws(() => reap(directory, readers()));
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('machine parsers handle macOS units, pressure flags and quiet first field', () => {
  assert.equal(parseSwap('total = 1024.00M used = 768.00M free = 256.00M (encrypted)'), 0.25);
  assert.equal(parseSwap('free = 2.00G'), 2);
  assert.equal(parsePressure('1\n'), 'normal');
  assert.equal(parsePressure('2'), 'warning');
  assert.equal(parsePressure('4'), 'critical');
  assert.throws(() => parsePressure('0'), /unknown/);
  assert.throws(() => parseSwap('unavailable'), /cannot parse/);
  assert.equal(parseQuiet('2000000 presentation\n'), 2000000000);
  assert.throws(() => parseQuiet('not-a-time'), /epoch seconds/);
  assert.equal(machineReaders(bin).pidAlive(process.pid), true);
});

// Cleanup-required leases (2026-10-07, Caret's heavy-job design): a lease whose owner dies without a confirmed clean
// becomes quarantined, keeps its reservation, blocks its kind, and is never reaped; only an acknowledgement carrying the
// attempt id and the secret token (whose SHA-256 the record holds) removes it.
const token = 'synthetic-cleanup-token-not-a-credential';
const cleanup = { attempt: 'attempt-1', tokenSha256: createHash('sha256').update(token).digest('hex') };

test('a cleanup-required lease records the attempt and the token digest, never the token', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), { ...request, cleanup });
  assert.equal(lease.cleanupRequired, true);
  assert.equal(lease.attempt, 'attempt-1');
  assert.equal(lease.tokenSha256, cleanup.tokenSha256);
  assert.ok(!fs.readFileSync(path.join(directory, `${lease.id}.json`), 'utf8').includes(token));
  assert.throws(() => acquire(directory, policy, readers(), { ...request, cleanup: { attempt: 'x', tokenSha256: 'short' } }), /invalid/);
});

test('owner death quarantines a cleanup-required lease: kept, counted, blocking its kind, never reaped', t => {
  const directory = fixture(t);
  const unlimited = structuredClone(policy);
  unlimited.kinds.heavy.maxCount = 5;
  const { lease } = acquire(directory, unlimited, readers(), { ...request, ownerPid: 777, cleanup });
  const dead = readers({ now: readings.now + 60000 });
  dead.pidAlive = () => false;
  assert.deepEqual(reap(directory, dead), [{ id: lease.id, reason: 'quarantined: owner dead' }]);
  const [kept] = readLeases(directory);
  assert.equal(kept.state, 'quarantined');
  assert.match(decision('heavy', 0, 0, [kept], unlimited, readings), /quarantined lease .* blocks heavy/);
  assert.equal(decision('gui', 0, 0, [kept], unlimited, readings), null);
  assert.deepEqual(reap(directory, dead), []);  // stays, and is not quarantined twice
  assert.equal(readLeases(directory).length, 1);
  // A plain release (mem-guard's after the owner exits) quarantines too, rather than dropping the reservation.
  const second = acquire(directory, unlimited, readers({ diskGB: 1000 }), { ...request, kind: 'gui', cleanup }).lease;
  assert.deepEqual(release(directory, second.id), { quarantined: true });
  assert.equal(readLeases(directory).find(l => l.id === second.id).state, 'quarantined');
});

test('only the attempt and the token acknowledge a clean; renewal by token keeps a live lease', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), { ...request, cleanup, ttlMinutes: 1 });
  assert.match(ack(directory, lease.id, 'attempt-2', token).reason, /attempt/);
  assert.match(ack(directory, lease.id, 'attempt-1', 'wrong-token').reason, /token/);
  assert.equal(readLeases(directory).length, 1);
  assert.match(renewByToken(directory, lease.id, 'attempt-1', 'wrong-token', 5, readings.now).reason, /token/);
  const renewed = renewByToken(directory, lease.id, 'attempt-1', token, 5, readings.now + 1000).lease;
  assert.equal(renewed.expiresAt, readings.now + 1000 + 5 * 60000);
  assert.deepEqual(ack(directory, lease.id, 'attempt-1', token), { acked: true });
  assert.deepEqual(readLeases(directory), []);
  // A quarantined lease is acknowledged the same way; renewal does not revive it.
  const q = acquire(directory, policy, readers(), { ...request, ownerPid: 888, cleanup }).lease;
  const dead = readers();
  dead.pidAlive = () => false;
  reap(directory, dead);
  assert.match(renewByToken(directory, q.id, 'attempt-1', token, 5, readings.now).reason, /quarantined/);
  assert.deepEqual(ack(directory, q.id, 'attempt-1', token), { acked: true });
  assert.deepEqual(readLeases(directory), []);
});

test('a lease without cleanup_required keeps today\'s behaviour', t => {
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), { ...request, ownerPid: 999 });
  assert.match(ack(directory, lease.id, 'attempt-1', token).reason, /not cleanup-required/);
  const dead = readers();
  dead.pidAlive = () => false;
  assert.deepEqual(reap(directory, dead), [{ id: lease.id, reason: 'owner dead' }]);
});

test('oblige makes an active lease cleanup-required for one attempt, whoever owns it', t => {
  // The queue holds a job's lease (owner: its runner); the job's supervisor obliges it before any work starts, so the
  // reservation outlives the runner's release until the job's cleanup is acknowledged.
  const directory = fixture(t);
  const { lease } = acquire(directory, policy, readers(), { ...request, ownerPid: 777 });
  assert.throws(() => oblige(directory, lease.id, 'attempt-1', 'short'), /invalid/);
  assert.throws(() => oblige(directory, lease.id, 'bad attempt!', cleanup.tokenSha256), /invalid/);
  assert.deepEqual(oblige(directory, '00000000-0000-4000-8000-000000000000', 'attempt-1', cleanup.tokenSha256),
    { reason: 'no such lease' });
  const obliged = oblige(directory, lease.id, 'attempt-1', cleanup.tokenSha256).lease;
  assert.deepEqual([obliged.cleanupRequired, obliged.attempt, obliged.tokenSha256, obliged.ownerPid],
    [true, 'attempt-1', cleanup.tokenSha256, 777]);
  assert.deepEqual(readLeases(directory), [obliged]);
  assert.match(oblige(directory, lease.id, 'attempt-2', cleanup.tokenSha256).reason, /already cleanup-required for attempt attempt-1/);
  // The owner's plain release now quarantines it; only the attempt's token clears it.
  assert.deepEqual(release(directory, lease.id), { quarantined: true });
  assert.match(oblige(directory, lease.id, 'attempt-1', cleanup.tokenSha256).reason, /already cleanup-required/);
  assert.deepEqual(ack(directory, lease.id, 'attempt-1', token), { acked: true });
  assert.deepEqual(readLeases(directory), []);
  // Acknowledged before the owner releases: the owner's release is then the usual idempotent no-op.
  const second = acquire(directory, policy, readers(), { ...request, ownerPid: 777 }).lease;
  oblige(directory, second.id, 'attempt-1', cleanup.tokenSha256);
  assert.deepEqual(ack(directory, second.id, 'attempt-1', token), { acked: true });
  assert.deepEqual(release(directory, second.id), {});
});

test('CLI: the token travels on stdin only', t => {
  const home = fixture(t);
  const root = path.join(home, '.long-run');
  fs.mkdirSync(root);
  const cliPolicy = structuredClone(policy);
  for (const kind of Object.keys(cliPolicy.kinds)) cliPolicy.kinds[kind].diskFloorGB = 0;
  fs.writeFileSync(path.join(root, 'lease-policy.json'), JSON.stringify(cliPolicy));
  const env = { ...process.env, HOME: home };
  const lr = (args, input) => spawnSync(path.join(bin, 'lr-lease'), args, { env, encoding: 'utf8', input });
  const got = lr(['acquire', '--run', 'cli-test', '--kind', 'heavy', '--est-mem', '0', '--est-disk', '0',
    '--owner-pid', String(process.pid), '--cleanup-attempt', 'attempt-1', '--cleanup-token-sha256', cleanup.tokenSha256]);
  assert.equal(got.status, 0, got.stdout);
  const id = got.stdout.trim();
  assert.equal(lr(['renew', id, '--attempt', 'attempt-1', '--ttl', '5'], token + '\n').status, 0);
  assert.equal(lr(['ack', id, '--attempt', 'attempt-1'], 'wrong\n').status, 75);
  const acked = lr(['ack', id, '--attempt', 'attempt-1'], token + '\n');
  assert.equal(acked.status, 0, acked.stdout);
  assert.equal(readLeases(path.join(root, 'leases')).length, 0);
  // oblige carries only the digest in argv; the acknowledgement still takes the token on stdin.
  const plain = lr(['acquire', '--run', 'cli-test', '--kind', 'heavy', '--est-mem', '0', '--est-disk', '0',
    '--owner-pid', String(process.pid)]).stdout.trim();
  const obliged = lr(['oblige', plain, '--attempt', 'attempt-1', '--cleanup-token-sha256', cleanup.tokenSha256]);
  assert.equal(obliged.status, 0, obliged.stdout);
  assert.equal(lr(['oblige', plain, '--attempt', 'attempt-1', '--cleanup-token-sha256', cleanup.tokenSha256]).status, 75);
  assert.equal(readLeases(path.join(root, 'leases'))[0].cleanupRequired, true);
  assert.equal(lr(['ack', plain, '--attempt', 'attempt-1'], token + '\n').status, 0);
  assert.equal(readLeases(path.join(root, 'leases')).length, 0);
});

function child(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

test('two concurrent lockf acquires produce exactly one lease, repeated 20 times', async t => {
  const directory = fixture(t);
  const mutex = path.join(directory, '.mutex');
  const policyFile = path.join(directory, '.policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const args = ['-k', '-s', '-t', '10', mutex, process.execPath, path.join(bin, 'lr-lease-race-worker.mjs'),
    directory, policyFile, String(process.pid)];
  for (let iteration = 0; iteration < 20; iteration++) {
    const results = await Promise.all([child('/usr/bin/lockf', args), child('/usr/bin/lockf', args)]);
    assert.deepEqual(results.map(result => result.code).sort((a, b) => a - b), [0, 75]);
    assert.equal(readLeases(directory).length, 1);
    const winner = results.find(result => result.code === 0);
    assert.equal(readLeases(directory)[0].id, winner.stdout);
    assert.match(results.find(result => result.code === 75).stdout, /^refused: count limit/);
    release(directory, winner.stdout);
    assert.ok(fs.existsSync(mutex));
  }
});

test('isolated CLI refusal, status, acquire, release and reaper work end to end', t => {
  const home = fixture(t);
  const root = path.join(home, '.long-run');
  fs.mkdirSync(root);
  // Zero floors: this test is about the CLI's plumbing, not this Mac's free disk (it failed at 7.98 GiB free).
  const cliPolicy = structuredClone(policy);
  for (const kind of Object.keys(cliPolicy.kinds)) cliPolicy.kinds[kind].diskFloorGB = 0;
  fs.writeFileSync(path.join(root, 'lease-policy.json'), JSON.stringify(cliPolicy));
  const env = { ...process.env, HOME: home };
  const result = spawnSync(path.join(bin, 'lr-lease'), ['acquire', '--run', 'cli-test', '--kind', 'vm', '--est-mem', '0', '--est-disk', '0'], { env, encoding: 'utf8' });
  assert.equal(result.status, 75);
  assert.match(result.stdout.trim(), /^refused: disabled by policy$/);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(readLeases(path.join(root, 'leases')).length, 0);
  const status = spawnSync(path.join(bin, 'lr-lease'), ['status'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0);
  for (const kind of ['heavy', 'gui', 'vm', 'container']) assert.match(status.stdout, new RegExp(`^${kind}: (GRANT|REFUSE):`, 'm'));
  const granted = spawnSync(path.join(bin, 'lr-lease'), ['acquire', '--run', 'cli-test', '--kind', 'heavy',
    '--est-mem', '0', '--est-disk', '0', '--ttl', '1', '--owner-pid', String(process.pid)], { env, encoding: 'utf8' });
  assert.equal(granted.status, 0, granted.stdout);
  const records = readLeases(path.join(root, 'leases'));
  assert.equal(records.length, 1);
  assert.equal(records[0].ownerPid, process.pid);
  assert.equal(records[0].id, granted.stdout.trim());
  const renewed = spawnSync(path.join(bin, 'lr-lease'), ['renew', records[0].id, '--owner-pid', String(process.pid), '--ttl', '30'], { env, encoding: 'utf8' });
  assert.equal(renewed.status, 0, renewed.stdout);
  assert.ok(readLeases(path.join(root, 'leases'))[0].expiresAt > records[0].expiresAt);
  const stranger = spawnSync(path.join(bin, 'lr-lease'), ['renew', records[0].id, '--owner-pid', '1', '--ttl', '30'], { env, encoding: 'utf8' });
  assert.equal(stranger.status, 75);
  assert.match(stranger.stdout, /^refused: lease is owned by pid/);
  const released = spawnSync(path.join(bin, 'lr-lease'), ['release', records[0].id], { env, encoding: 'utf8' });
  assert.equal(released.status, 0);
  assert.equal(readLeases(path.join(root, 'leases')).length, 0);
  const reaper = spawnSync(path.join(bin, 'lr-reap'), ['--run', 'cli-test'], { env, encoding: 'utf8' });
  assert.equal(reaper.status, 0);
});

test('real PID liveness reader recognizes a child after exit', async () => {
  const proc = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', resolve);
  });
  assert.equal(machineReaders(bin).pidAlive(proc.pid), false);
});

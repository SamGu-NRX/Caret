import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { KINDS, machineReaders, readPolicy, readLeases, snapshot, decision, acquire, release, renew, reap } from './lr-lease-core.mjs';

const root = path.join(os.homedir(), '.long-run');
const directory = path.join(root, 'leases');
const file = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

function options(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key) || args[i + 1] === undefined || args[i + 1].startsWith('--')) {
      throw new Error(`invalid or duplicate option: ${key}`);
    }
    result[key] = args[i + 1];
  }
  return result;
}
function number(value, name) {
  if (value === undefined || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(`${name} must be a nonnegative number`);
  }
  return Number(value);
}

try {
  // Keep the mutex inode: lockf's default unlink can let waiters lock different files.
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (args[0] !== '--locked') {
    const child = spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '10', path.join(directory, '.mutex'),
      process.execPath, file, '--locked', String(process.ppid), ...args], { encoding: 'utf8' });
    if (child.error) throw child.error;
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.status !== 0 && !child.stdout) process.stdout.write('refused: admission unavailable or mutex busy\n');
    process.exit(child.status ?? 75);
  }
  const [, owner, mode, verb, ...rest] = args;
  const readers = machineReaders(root);
  if (mode === 'reap') {
    const opts = options([verb, ...rest].filter(value => value !== undefined), ['--run']);
    for (const removed of reap(directory, readers, opts['--run'])) console.log(`${removed.id} ${removed.reason}`);
  } else if (mode === 'lease' && verb === 'acquire') {
    const opts = options(rest, ['--run', '--kind', '--est-mem', '--est-disk', '--ttl', '--owner-pid']);
    const result = acquire(directory, readPolicy(path.join(root, 'lease-policy.json')), readers, {
      run: opts['--run'], kind: opts['--kind'], estMemGB: number(opts['--est-mem'], '--est-mem'),
      estDiskGB: number(opts['--est-disk'], '--est-disk'),
      ttlMinutes: opts['--ttl'] === undefined ? undefined : number(opts['--ttl'], '--ttl'),
      ownerPid: opts['--owner-pid'] === undefined ? Number(owner) : number(opts['--owner-pid'], '--owner-pid'),
    });
    if (result.reason) { console.log(`refused: ${result.reason}`); process.exitCode = 75; }
    else console.log(result.lease.id);
  } else if (mode === 'lease' && verb === 'release' && rest.length === 1) {
    release(directory, rest[0]);
  } else if (mode === 'lease' && verb === 'renew' && rest.length === 5) {
    const opts = options(rest.slice(1), ['--owner-pid', '--ttl']);
    const result = renew(directory, rest[0], number(opts['--owner-pid'], '--owner-pid'), number(opts['--ttl'], '--ttl'), readers.now());
    if (result.reason) { console.log(`refused: ${result.reason}`); process.exitCode = 75; }
    else console.log(result.lease.id);
  } else if (mode === 'lease' && verb === 'status' && rest.length === 0) {
    const policy = readPolicy(path.join(root, 'lease-policy.json'));
    const readings = snapshot(readers);
    const leases = readLeases(directory);
    console.log(`Readings ${new Date(readings.now).toISOString()}: disk=${readings.diskGB.toFixed(2)} GiB free, swap=${readings.swapGB.toFixed(2)} GiB free, pressure=${readings.pressure}`);
    console.log(`Quiet until: ${readings.quietUntil ? new Date(readings.quietUntil).toISOString() : 'none'}`);
    console.log(`Leases: ${leases.length}`);
    for (const lease of leases) console.log(JSON.stringify(lease));
    console.log('Decisions for a zero-estimate request, including outstanding reservations:');
    for (const kind of KINDS) {
      const reason = decision(kind, 0, 0, leases, policy, readings);
      console.log(`${kind}: ${reason ? `REFUSE: ${reason}` : 'GRANT: disk, pressure, swap, count and quiet checks pass'}`);
    }
  } else throw new Error('usage: lr-lease acquire --run NAME --kind heavy|gui|vm|container --est-mem GiB --est-disk GiB [--ttl MIN] [--owner-pid PID] | release ID | renew ID --owner-pid PID --ttl MIN | status; lr-reap [--run NAME]');
} catch (error) {
  console.log(`refused: ${error.message.replace(/[\r\n]+/g, ' ')}`);
  process.exitCode = 75;
}

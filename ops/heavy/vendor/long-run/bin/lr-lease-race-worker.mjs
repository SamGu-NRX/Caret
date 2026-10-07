// Test-only worker: real lockf and filesystem, injected machine readings.
import { acquire, readPolicy } from './lr-lease-core.mjs';
const [directory, policyFile, owner] = process.argv.slice(2);
const readers = { now: () => 1000000, diskGB: () => 100, swapGB: () => 100,
  pressure: () => 'normal', quietUntil: () => 0, pidAlive: () => true };
const result = acquire(directory, readPolicy(policyFile), readers, {
  run: 'lease-race-test', kind: 'heavy', estMemGB: 1, estDiskGB: 1, ownerPid: Number(owner),
});
console.log(result.reason ? `refused: ${result.reason}` : result.lease.id);
process.exitCode = result.reason ? 75 : 0;

// The packaging gate for the privacy promise (privacy.ts ownerNoteGate): exits 1, saying why, when the helper sends more
// than the promise discloses. scripts/package_mac.py runs it before building the app. Usage: node scripts/privacy-gate.ts
import { ownerNoteGate } from "../src/privacy.ts";

const why = ownerNoteGate();
if (why !== null) {
  console.error(`privacy gate: refusing to package: ${why}`);
  process.exit(1);
}
console.log("privacy gate: the promise discloses everything the helper sends");

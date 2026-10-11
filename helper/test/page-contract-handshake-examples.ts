import type { EngineChallenge, EngineHello, EngineWelcome } from "../src/protocol.ts";

export const handshakeExamples = [
  { type: "engineChallenge", v: 1, nonce: "a".repeat(64) } satisfies EngineChallenge,
  { type: "engineHello", v: 1, role: "page", browser: { pid: 4100, bundleId: "dev.caret.fixture", name: "Fixture browser" },
    extensionId: "a".repeat(32), bridgeVersion: "0.1.0", nonce: "b".repeat(64), proof: "c".repeat(64) } satisfies EngineHello,
  { type: "engineWelcome", v: 1, engine: "fixture-engine", proof: "d".repeat(64), pid: 4242 } satisfies EngineWelcome,
];

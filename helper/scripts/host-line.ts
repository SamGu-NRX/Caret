// A script's own connection to a helper it started with a launch secret, as the proven host. The helper takes runPlan,
// taskControl, settings and every other command only from the host (src/request-gate.ts), and sends proposals and
// progress only to it (src/send-gate.ts), so a script that drives the helper over the socket proves the host key first.
import { createConnection, type Socket } from "node:net";
import { hostKey, hostProof } from "../src/host-auth.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

/**
 * Connects to `path`, says hello with `host: true`, answers the hostChallenge under `launchSecret`'s host key, and
 * resolves once the helper sends hostAuthenticated. Every line after that goes to `onLine`. Rejects, quoting the
 * helper's error lines, if the connection closes first.
 */
export function connectAsHost(path: string, launchSecret: Buffer, version: string, onLine: (m: Record<string, unknown>) => void = () => undefined): Promise<Socket> {
  const key = hostKey(launchSecret);
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const errors: string[] = [];
    let authenticated = false;
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        if (authenticated) onLine(m);
        else if (m.type === "hostChallenge") s.write(JSON.stringify({ type: "hostProof", v: PROTOCOL_VERSION, proof: hostProof(key, String(m.nonce)) }) + "\n");
        else if (m.type === "hostAuthenticated") {
          authenticated = true;
          resolve(s);
        } else if (m.type === "error") errors.push(String(m.message));
      }
    });
    s.once("connect", () => s.write(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: process.pid, version, host: true }) + "\n"));
    s.once("error", (e) => reject(e));
    s.once("close", () => {
      if (!authenticated) reject(new Error(`the helper at ${path} closed the connection before it took ${version} as the host: ${errors.join("; ") || "no reason given"}`));
    });
  });
}

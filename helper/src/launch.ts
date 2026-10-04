// caret-launch: starts the helper and caret-screen with one launch secret between them (B23, CodeRabbit on PR #4).
//   node src/launch.ts --reader PATH/caret-screen [--socket PATH] [-- helper args...] [--- reader args...]
// The secret is 32 random bytes made here, written to each child's standard input and closed (--auth-fd 0), so it is
// never on a command line or in an environment another process can read. The reader then accepts a helper only if
// it proves it holds the secret (Emitter.swift). Stopping this process stops both; either one exiting stops the other.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

/** A new launch secret. */
export function newLaunchSecret(): Buffer {
  return randomBytes(32);
}

/** Hands a child started with `--auth-fd 0` its launch secret on standard input, then closes it. */
export function sendSecret(child: ChildProcessWithoutNullStreams, secret: Buffer): void {
  child.stdin.end(secret);
}

function main(argv: string[]): void {
  const split = (marker: string, xs: string[]): [string[], string[]] => {
    const i = xs.indexOf(marker);
    return i < 0 ? [xs, []] : [xs.slice(0, i), xs.slice(i + 1)];
  };
  const [own, rest] = split("--", argv);
  const [helperArgs, readerArgs] = split("---", rest);
  const opt = (name: string): string | undefined => {
    const i = own.indexOf(name);
    return i < 0 ? undefined : own[i + 1];
  };
  const readerPath = opt("--reader");
  if (readerPath === undefined) throw new Error("usage: node src/launch.ts --reader PATH/caret-screen [--socket PATH] [-- helper args] [--- reader args]");
  const socket = opt("--socket");
  const sock = socket === undefined ? [] : ["--socket", socket];
  const secret = newLaunchSecret();
  const helperMain = fileURLToPath(new URL("./main.ts", import.meta.url));
  const helper = spawn(process.execPath, [helperMain, "--auth-fd", "0", ...sock, ...helperArgs]);
  const reader = spawn(readerPath, ["--auth-fd", "0", ...sock, ...readerArgs]);
  for (const [name, child] of [["helper", helper], ["reader", reader]] as const) {
    sendSecret(child, secret);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.once("exit", (code, signal) => {
      process.stderr.write(`[caret-launch] ${name} exited (${signal ?? code}); stopping the other\n`);
      helper.kill("SIGTERM");
      reader.kill("SIGTERM");
      process.exitCode = code ?? 1;
    });
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      helper.kill("SIGTERM");
      reader.kill("SIGTERM");
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

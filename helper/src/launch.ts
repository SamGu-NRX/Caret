// caret-launch: starts the helper and caret-screen with one launch secret between them (B23, CodeRabbit on PR #4).
//   node src/launch.ts --reader PATH/caret-screen [--socket PATH] [-- helper args...] [--- reader args...]
// The secret is 32 random bytes made here, written to each child's standard input and closed (--auth-fd 0), so it is
// never on a command line or in an environment another process can read. The reader then accepts a helper only if
// it proves it holds the secret (Emitter.swift).
//
// A helper that exits on its own (a crash) is started again with the same secret: the reader, still running, takes
// it back, and the elements it recorded let the new helper undo a run the crash cut off (executor/journal.ts). At
// most RESTARTS restarts in RESTART_WINDOW_MS, then both stop. The reader exiting, or this process being stopped,
// stops both.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newLocalSecret } from "./privacy/local-secret.ts";

/** Restarts of a crashed helper allowed in RESTART_WINDOW_MS before the launcher gives up. Assumed. */
const RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
/** Wait before starting a crashed helper again. Assumed: the reader retries its connection every second. */
const RESTART_DELAY_MS = 1000;

/** A new launch secret: 32 random bytes, registered as this process's own (privacy/local-secret.ts). */
export function newLaunchSecret(): Buffer {
  return newLocalSecret(32);
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
  const say = (line: string): boolean => process.stderr.write(`[caret-launch] ${line}\n`);
  let stopping = false;
  const restarts: number[] = [];
  let helper: ChildProcessWithoutNullStreams;
  const startHelper = (): void => {
    helper = spawn(process.execPath, [helperMain, "--auth-fd", "0", ...sock, ...helperArgs]);
    sendSecret(helper, secret);
    helper.stdout.pipe(process.stdout);
    helper.stderr.pipe(process.stderr);
    helper.once("exit", (code, signal) => {
      if (stopping) return;
      const now = Date.now();
      while (restarts.length > 0 && now - (restarts[0] as number) > RESTART_WINDOW_MS) restarts.shift();
      if (restarts.length >= RESTARTS) {
        say(`the helper exited (${signal ?? code}) ${RESTARTS + 1} times within ${RESTART_WINDOW_MS / 1000} s; stopping`);
        stop(1);
        return;
      }
      restarts.push(now);
      say(`the helper exited (${signal ?? code}); starting it again with the same secret`);
      setTimeout(() => (stopping ? undefined : startHelper()), RESTART_DELAY_MS);
    });
  };
  const reader = spawn(readerPath, ["--auth-fd", "0", ...sock, ...readerArgs]);
  const stop = (code: number): void => {
    stopping = true;
    helper.kill("SIGTERM");
    reader.kill("SIGTERM");
    process.exitCode = code;
  };
  startHelper();
  sendSecret(reader, secret);
  reader.stdout.pipe(process.stdout);
  reader.stderr.pipe(process.stderr);
  reader.once("exit", (code, signal) => {
    if (stopping) return;
    say(`the reader exited (${signal ?? code}); stopping the helper`);
    stop(code ?? 1);
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => stop(0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

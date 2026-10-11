// Starting a Caret that a script's own helper takes as its host (src/host-auth.ts). Every acceptance script that runs
// a HelperServer in process, or starts one with a launch secret, starts Caret through spawnCaret with that secret.
//
// The host key, HMAC-SHA256(secret, "caret-host-key"), goes to the child on one extra pipe after its standard streams;
// CARET_HOST_KEY_FD names that descriptor, and Caret reads 32 bytes from it once and closes it (HostAuth.swift
// readInheritedKey). The key is never on argv, in a file or in an environment value: the environment holds only the
// descriptor's number. A Caret started with plain spawn has no key and connects as a plain consumer, without
// routing, page text, saved answers or any other capability only the host is granted.
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import type { Writable } from "node:stream";
import { hostKey } from "../src/host-auth.ts";

/** HostAuth.keyDescriptorVariable in apps/caret. */
export const HOST_KEY_FD_VARIABLE = "CARET_HOST_KEY_FD";

type StdioEntry = Exclude<StdioOptions, string>[number];

/** The caller's stdio as an array, so the key's pipe can go after the standard three. */
function stdioArray(given: StdioOptions | undefined): StdioEntry[] {
  if (given === undefined) return ["pipe", "pipe", "pipe"];
  if (typeof given === "string") return [given, given, given];
  const out = [...given];
  // An absent standard stream is a pipe, as spawn treats it.
  while (out.length < 3) out.push("pipe");
  return out;
}

/**
 * spawn(command, args, options) for a Caret attached to a helper holding `secret`, with the host key on an inherited
 * pipe. `options.env` defaults to this process's environment; CARET_HOST_KEY_FD is added to it, and any value it
 * already had is replaced.
 */
export function spawnCaret(command: string, args: readonly string[], secret: Buffer, options: SpawnOptions = {}): ChildProcess {
  const stdio = stdioArray(options.stdio);
  const fd = stdio.length;
  stdio.push("pipe");
  const env = { ...(options.env ?? process.env), [HOST_KEY_FD_VARIABLE]: String(fd) };
  const child = spawn(command, [...args], { ...options, stdio, env });
  const pipe = child.stdio[fd] as Writable | null;
  if (pipe === null) throw new Error(`spawnCaret: no pipe at descriptor ${fd} for ${command}`);
  // A Caret that exits before it reads its key fails on its own terms, in its log; the script reports that, not EPIPE.
  pipe.on("error", () => undefined);
  pipe.end(hostKey(secret));
  return child;
}

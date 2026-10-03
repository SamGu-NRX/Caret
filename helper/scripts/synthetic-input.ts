// Input an evaluation posts to a process it started (CGEventPostToPid: a click, typed characters, a paste) resets
// the Mac's HIDIdleTime exactly as a person's input does (B20, measured: a key posted to the posting process
// itself took HIDIdleTime from 196 s to 0.3 s). The GUI gate stops a run when idle drops under 5 s, so it must
// tell this script's own input from someone using the Mac: input is the user's only when the last event came
// after the script's last post. The time of that post is shared through CARET_SYNTHETIC_FILE with the gate
// that runs the script (gui.sh), as "busy" while posting and the end time in epoch milliseconds after.
import { readFileSync, writeFileSync } from "node:fs";

/** Slack between the post ending and the last event the system recorded for it. Assumed. */
const MARGIN_MS = 700;

let busy = false;
let lastPostAt = 0;

function share(content: string): void {
  const file = process.env.CARET_SYNTHETIC_FILE;
  if (file !== undefined && file !== "") writeFileSync(file, content);
}

/** Runs `post`, which sends input to a process this script started, and records when it ended. */
export async function posting<T>(post: () => Promise<T>): Promise<T> {
  busy = true;
  share("busy");
  try {
    return await post();
  } finally {
    busy = false;
    lastPostAt = Date.now();
    share(String(lastPostAt));
  }
}

/** The batch's shared mark: "busy", the end of the last post by any script in the batch, or 0 when there is none. */
function sharedMark(): number | "busy" {
  const file = process.env.CARET_SYNTHETIC_FILE;
  if (file === undefined || file === "") return 0;
  try {
    const t = readFileSync(file, "utf8").trim();
    return t === "busy" ? "busy" : Number(t) || 0;
  } catch {
    return 0;
  }
}

/**
 * Whether HID idle this low means someone used the Mac: the last event came after the last post by this script
 * or by an earlier step of the same batch (a click the step before posted is still in HID idle at the next start).
 */
export function userInput(idleSeconds: number, now = Date.now()): boolean {
  const mark = sharedMark();
  if (busy || mark === "busy") return false;
  const lastEventAt = now - idleSeconds * 1000;
  return lastEventAt > Math.max(lastPostAt, mark) + MARGIN_MS;
}

// Input an evaluation posts to a process it started (CGEventPostToPid: a click, typed characters, a paste) resets
// the Mac's HIDIdleTime exactly as a person's input does (B20, measured: a key posted to the posting process
// itself took HIDIdleTime from 196 s to 0.3 s). The GUI gate stops a run when idle drops under 5 s, so it must
// tell the run's own input from someone using the Mac. The programs that post (experiments/write-candidates.swift,
// experiments/press-observe.swift) write CARET_SYNTHETIC_FILE right around each post: "busy DEADLINE" while
// posting, then the end time, both in epoch milliseconds. Input is the user's when the last event came more than
// MARGIN_MS after the last post, or while no post is under way. A "busy" past its deadline (a poster that died
// mid-post) excuses nothing. gui.sh reads the same file the same way.
import { readFileSync } from "node:fs";

/** Slack between a post ending and the last event the system recorded for it. Assumed. */
const MARGIN_MS = 700;

type Mark = { busyUntil: number } | { postedAt: number };

function readMark(file: string | undefined): Mark {
  if (file === undefined || file === "") return { postedAt: 0 };
  let t: string;
  try {
    t = readFileSync(file, "utf8").trim();
  } catch {
    return { postedAt: 0 };
  }
  const busy = /^busy (\d+)$/.exec(t);
  if (busy?.[1] !== undefined) return { busyUntil: Number(busy[1]) };
  return { postedAt: Number(t) || 0 };
}

/** Whether HID idle this low means someone used the Mac rather than the run's own posted input. */
export function userInput(idleSeconds: number, now = Date.now(), file = process.env.CARET_SYNTHETIC_FILE): boolean {
  const mark = readMark(file);
  if ("busyUntil" in mark) return now > mark.busyUntil;
  return now - idleSeconds * 1000 > mark.postedAt + MARGIN_MS;
}

// Synthetic accessibility trees shaped like the agent-thread windows the B6 census measured on Sam's
// Mac (counts only, ~/.caret-run/evidence/screen/b6/census): T3 Code and Codex, both Electron, and a
// browser chat. Roles, nesting, label shapes and where things sit come from the census; every word of
// text is invented.
//
//   - T3 Code: a sidebar of threads, each a button holding its title and a status text ("Working" for
//     a thread that runs), and a stop button of its own; the open thread's transcript in a web area;
//     a composer at the bottom with "Stop generation" while a turn runs and "Send message" otherwise.
//   - Codex: the same shape, with each thread's status in a group inside its button, a thread title
//     that can end in an ellipsis, and a composer button labelled "Stop" or "Send".
//   - Browser chat: a page whose history links fill a sidebar, a transcript, and a composer with
//     "Stop streaming" (ChatGPT) or "Stop response" (Claude) while it answers, "Send prompt" otherwise.
import type { AppRef, Frame, Node } from "../src/protocol.ts";
import { snap, type SnapOpts } from "./builders.ts";

export const T3: AppRef = { pid: 8101, bundleId: "com.t3tools.t3code", name: "T3 Code" };
export const CODEX: AppRef = { pid: 8202, bundleId: "com.openai.codex", name: "Codex" };
export const BROWSER: AppRef = { pid: 8303, bundleId: "net.imput.helium", name: "Helium" };
/** Agent windows are wide: the census's sidebar rule needs 700 points. */
export const WINDOW: Frame = [0, 0, 1400, 900];

interface Thread {
  title: string;
  /** The sidebar status text, if any: "Working" while it runs. */
  status?: string;
}

class Tree {
  readonly nodes: Node[] = [];
  private n = 0;
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }
  add(role: string, frame: Frame, extra: Partial<Node> = {}, parent: string | null = null): string {
    const key = `${this.prefix}/${role.slice(2).toLowerCase()}~${this.n++}`;
    this.nodes.push({ key, parent, role, frame, ...extra });
    return key;
  }
}

/** A transcript of `lines` lines in the main pane, oldest first, ending with `last`. */
function transcript(t: Tree, parent: string, lines: number, last: string[]): void {
  for (let i = 0; i < lines; i++) t.add("AXStaticText", [340, 60 + (i % 30) * 22, 900, 18], { label: `Step ${i}: edited the seating chart and checked the venue notes` }, parent);
  for (const l of last) t.add("AXStaticText", [340, 700, 900, 18], { label: l }, parent);
}

export interface AgentWindow {
  /** The open thread is mid-turn: the composer shows the stop button. */
  running: boolean;
  /** Other threads in the sidebar, with their own statuses. */
  threads?: Thread[];
  /** Lines of transcript before the end; 450 puts the composer past the first 400 lines. */
  transcriptLines?: number;
  /** The transcript's last lines. */
  last?: string[];
  /** A text in the transcript area other than the sidebar, such as an approval prompt. */
  extra?: Node[];
}

/** A T3 Code window. */
export function t3Window(o: AgentWindow): Node[] {
  const t = new Tree("com.t3tools.t3code/standard");
  for (const [i, th] of (o.threads ?? []).entries()) {
    const y = 80 + i * 40;
    const b = t.add("AXButton", [10, y, 280, 36], { label: th.title });
    t.add("AXStaticText", [20, y + 8, 160, 18], { label: th.title }, b);
    if (th.status !== undefined) {
      t.add("AXStaticText", [190, y + 8, 60, 18], { label: th.status }, b);
      t.add("AXButton", [260, y + 8, 20, 20], { label: `Stop ${th.title}` });
    }
  }
  const area = t.add("AXWebArea", [320, 0, 1080, 900], { label: "T3 Code" });
  transcript(t, area, o.transcriptLines ?? 40, o.last ?? []);
  for (const n of o.extra ?? []) t.nodes.push({ ...n, parent: area });
  t.add("AXTextArea", [340, 780, 960, 80], { editable: true, placeholder: "Ask anything" }, area);
  if (o.running) t.add("AXButton", [1310, 820, 32, 32], { label: "Stop generation" }, area);
  else t.add("AXButton", [1310, 820, 32, 32], { label: "Send message", states: ["disabled"] }, area);
  return t.nodes;
}

/** A Codex window. */
export function codexWindow(o: AgentWindow): Node[] {
  const t = new Tree("com.openai.codex/standard");
  for (const [i, th] of (o.threads ?? []).entries()) {
    const y = 80 + i * 40;
    const b = t.add("AXButton", [10, y, 280, 36], { label: th.title });
    const g = t.add("AXGroup", [20, y + 4, 260, 28], { label: th.title }, b);
    t.add("AXStaticText", [20, y + 8, 180, 18], { label: th.title }, g);
    if (th.status !== undefined) t.add("AXStaticText", [210, y + 8, 60, 18], { label: th.status }, g);
  }
  // Codex shows "Thinking" by the sidebar header while any thread thinks, outside the thread buttons.
  if ((o.threads ?? []).some((th) => th.status !== undefined)) t.add("AXStaticText", [20, 40, 100, 18], { label: "Thinking" });
  const area = t.add("AXWebArea", [320, 0, 1080, 900], { label: "Codex" });
  transcript(t, area, o.transcriptLines ?? 40, o.last ?? []);
  for (const n of o.extra ?? []) t.nodes.push({ ...n, parent: area });
  t.add("AXTextArea", [340, 780, 960, 80], { editable: true, placeholder: "Ask Codex anything" }, area);
  t.add("AXButton", [1310, 820, 32, 32], { label: o.running ? "Stop" : "Send" }, area);
  return t.nodes;
}

/** A browser chat: ChatGPT's labels by default, Claude's with `claude`. */
export function browserChat(o: AgentWindow & { claude?: boolean }): Node[] {
  const t = new Tree("net.imput.helium/standard");
  const area = t.add("AXWebArea", [0, 0, 1400, 900], { label: "Chat" });
  const nav = t.add("AXGroup", [0, 40, 260, 860], { label: "Chat history" }, area);
  for (const [i, th] of (o.threads ?? []).entries()) {
    t.add("AXLink", [10, 80 + i * 30, 240, 24], { label: th.title }, nav);
    // A history entry that is still answering in another tab shows a status beside it.
    if (th.status !== undefined) t.add("AXStaticText", [200, 80 + i * 30, 50, 18], { label: th.status }, nav);
  }
  transcript(t, area, o.transcriptLines ?? 30, o.last ?? []);
  for (const n of o.extra ?? []) t.nodes.push({ ...n, parent: area });
  t.add("AXTextArea", [380, 790, 760, 60], { editable: true, label: o.claude === true ? "Write your prompt to Claude" : "Message ChatGPT" }, area);
  const stop = o.claude === true ? "Stop response" : "Stop streaming";
  t.add("AXButton", [1100, 805, 32, 32], { label: o.running ? stop : "Send prompt" }, area);
  return t.nodes;
}

export function agentSnap(app: AppRef, nodes: Node[], o: Omit<SnapOpts, "app">): ReturnType<typeof snap> {
  const s = snap(nodes, { ...o, app });
  return { ...s, window: { ...s.window, frame: WINDOW } };
}

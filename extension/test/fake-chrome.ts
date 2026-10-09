type Listener = (...a: never[]) => unknown;
export interface Frame {
  frameId: number;
  parentFrameId: number;
  documentId: string;
  url: string;
}

/** A fake of the chrome APIs the worker uses, with every listener kept so a test can fire the events. */
export function fakeChrome() {
  const listeners = new Map<string, Listener[]>();
  const on = (name: string) => ({ addListener: (f: Listener) => void listeners.set(name, [...(listeners.get(name) ?? []), f]) });
  const fire = async (name: string, ...a: unknown[]): Promise<void> => {
    for (const f of listeners.get(name) ?? []) await (f as (...x: unknown[]) => unknown)(...a);
  };
  const sentToHelper: Record<string, unknown>[] = [];
  const port = { onMessage: on("port.message"), onDisconnect: on("port.disconnect"), postMessage: (m: Record<string, unknown>) => void sentToHelper.push(m) };
  const frames = new Map<number, Frame[]>();
  /** What each frame's content script answers, by `${tabId}:${frameId}:${op}`; every message it got is kept. */
  const answers = new Map<string, unknown>();
  const asked: { tabId: number; frameId: number; op: string; msg: Record<string, unknown> }[] = [];
  /** Run while a frame answers (a test changes the world mid-read here). */
  let duringAnswer: (op: string, frameId: number) => void = () => {};
  const state = { focusedWindow: 9, active: new Map<number, number>([[9, 1]]), titles: new Map<number, string>() };
  const chrome = {
    runtime: { id: "x", getManifest: () => ({ version: "0" }), connectNative: () => port, onMessage: on("runtime.message"), onInstalled: on("runtime.installed"), lastError: undefined },
    storage: { local: { get: async () => ({ profile: "p" }), set: async () => {} } },
    tabs: {
      query: async () => [...state.active].map(([windowId, id]) => ({ id, windowId, active: true })),
      get: async (id: number) => ({ id, windowId: 9, active: state.active.get(9) === id, title: state.titles.get(id) ?? "" }),
      sendMessage: async (tabId: number, msg: Record<string, unknown>, opts: { frameId: number }) => {
        asked.push({ tabId, frameId: opts.frameId, op: String(msg.op), msg });
        duringAnswer(String(msg.op), opts.frameId);
        return answers.get(`${tabId}:${opts.frameId}:${String(msg.op)}`);
      },
      onActivated: on("tabs.activated"),
      onRemoved: on("tabs.removed"),
      onReplaced: on("tabs.replaced"),
      onDetached: on("tabs.detached"),
      onZoomChange: on("tabs.zoom"),
      // H10's walk reads the tab's zoom for the viewport's screen frame.
      getZoom: async () => 1,
    },
    windows: { WINDOW_ID_NONE: -1, getLastFocused: async () => ({ id: state.focusedWindow, focused: true }), onFocusChanged: on("windows.focus"), onRemoved: on("windows.removed") },
    webNavigation: {
      getAllFrames: async ({ tabId }: { tabId: number }) => frames.get(tabId) ?? [],
      getFrame: async ({ tabId, frameId }: { tabId: number; frameId: number }) => frames.get(tabId)?.find((x) => x.frameId === frameId) ?? null,
      onCommitted: on("nav.committed"),
      onHistoryStateUpdated: on("nav.history"),
      onReferenceFragmentUpdated: on("nav.fragment"),
      onBeforeNavigate: on("nav.before"),
    },
    scripting: { executeScript: async () => [] },
    dom: undefined,
  };
  return { chrome, fire, sentToHelper, frames, answers, asked, state, setDuring: (f: typeof duringAnswer) => void (duringAnswer = f) };
}

export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// Headless Chrome for Testing for the task pages' own tests and journeys (F1): a temporary profile, the network sink
// as its proxy, a DevTools pipe, and no extension. accept.ts has the same pieces but runs its whole acceptance when
// imported, so the few needed are here. The pinned build and cache are accept.ts's (CFT_BUILD, .browsers/).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Browser, computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";

export const CFT_BUILD = "154.0.8037.92";
const CACHE = fileURLToPath(new URL("../.browsers", import.meta.url));

/** The pinned Chrome for Testing's executable, installed into .browsers/ when missing. */
export async function chromeForTesting(): Promise<string> {
  const platform = detectBrowserPlatform();
  if (platform === undefined) throw new Error("cannot detect the platform for Chrome for Testing");
  await install({ browser: Browser.CHROME, buildId: CFT_BUILD, cacheDir: CACHE, platform });
  return computeExecutablePath({ browser: Browser.CHROME, buildId: CFT_BUILD, cacheDir: CACHE, platform });
}

/** The Chrome DevTools Protocol over --remote-debugging-pipe: requests on fd 3, answers on fd 4, each NUL-terminated. */
export class Cdp {
  private next = 1;
  private buf = "";
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private readonly out: Writable;

  constructor(out: Writable, inp: Readable) {
    this.out = out;
    inp.setEncoding("utf8");
    inp.on("data", (d: string) => {
      this.buf += d;
      for (let i = this.buf.indexOf("\0"); i >= 0; i = this.buf.indexOf("\0")) {
        const m = JSON.parse(this.buf.slice(0, i)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
        this.buf = this.buf.slice(i + 1);
        const p = m.id === undefined ? undefined : this.pending.get(m.id);
        if (p === undefined || m.id === undefined) continue;
        this.pending.delete(m.id);
        if (m.error !== undefined) p.reject(new Error(m.error.message));
        else p.resolve(m.result ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method} got no answer within 10 s`))), 10_000);
      this.pending.set(id, { resolve: (r) => (clearTimeout(timer), resolve(r)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })}\0`);
    });
  }
}

/**
 * One page target, attached with a flat session. Each task page's probe holds a long poll open per frame, and Chrome
 * allows six connections per host, so close tabs you are done with.
 */
export class Tab {
  readonly cdp: Cdp;
  readonly sessionId: string;
  readonly targetId: string;

  constructor(cdp: Cdp, sessionId: string, targetId: string) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  async close(): Promise<void> {
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** Evaluates `expression` in the page's main world (top frame) and returns its value; a thrown error is thrown here. */
  async evaluate<T>(expression: string): Promise<T> {
    const r = (await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
    if (r.exceptionDetails !== undefined) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      if ((await this.evaluate<string>("location.href + ' ' + document.readyState").catch(() => "")) === `${url} complete`) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${url} did not finish loading within 5 s`);
  }

  /**
   * A trusted left click at the centre of the element `locate` (an expression returning an Element) finds. The element
   * may be in a same-origin frame (reached through contentDocument): its frames' offsets are added.
   */
  async click(locate: string): Promise<void> {
    const [x, y] = await this.evaluate<[number, number]>(`(() => {
      const el = ${locate};
      if (!el) throw new Error("nothing to click");
      el.scrollIntoView({ block: "center" });
      const b = el.getBoundingClientRect();
      let x = b.x + b.width / 2, y = b.y + b.height / 2;
      for (let f = el.ownerDocument.defaultView.frameElement; f; f = f.ownerDocument.defaultView.frameElement) {
        const r = f.getBoundingClientRect();
        x += r.x + f.clientLeft; y += r.y + f.clientTop;
      }
      return [x, y];
    })()`);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** Trusted typing into whatever has focus. */
  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  /** A trusted key press (Enter, ArrowDown, Tab...) on whatever has focus. */
  async key(key: string): Promise<void> {
    const codes: Record<string, number> = { Enter: 13, ArrowDown: 40, ArrowUp: 38, Tab: 9, Escape: 27, Backspace: 8 };
    const code = codes[key];
    if (code === undefined) throw new Error(`Tab.key does not know ${key}`);
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(key === "Enter" ? { text: "\r" } : {}) });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
}

export interface Headless {
  proc: ChildProcess;
  cdp: Cdp;
  /** Opens `url` in a new tab and attaches to it. */
  open(url: string): Promise<Tab>;
  stop(): Promise<void>;
}

/** Launches headless Chrome for Testing on a fresh temporary profile; `extra` adds flags (the sink's proxy). */
export async function launchHeadless(extra: string[] = []): Promise<Headless> {
  const exe = await chromeForTesting();
  const profile = mkdtempSync(join(tmpdir(), "caret-f1-"));
  const flags = [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    // The browser's own traffic would otherwise reach the network sink as off-site requests: autofill's server,
    // sign-in, phishing checks, component and variations updates, translation.
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-component-extensions-with-background-pages",
    "--disable-field-trial-config",
    "--metrics-recording-only",
    "--no-pings",
    "--disable-features=AutofillServerCommunication,Translate,OptimizationHints,MediaRouter,SigninInterception,ChromeWhatsNewUI",
    "--window-size=1280,1600",
    "--remote-debugging-pipe",
    ...extra,
    "about:blank",
  ];
  const proc = spawn(exe, flags, { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pid = proc.pid;
  if (pid === undefined) throw new Error("Chrome for Testing did not start");
  const cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
  const stop = async (): Promise<void> => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      for (let i = 0; i < 50 && proc.exitCode === null && proc.signalCode === null; i++) await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(profile, { recursive: true, force: true });
  };
  const open = async (url: string): Promise<Tab> => {
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const tab = new Tab(cdp, sessionId, targetId);
    await tab.send("Page.enable");
    await tab.navigate(url);
    return tab;
  };
  return { proc, cdp, open, stop };
}

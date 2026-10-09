// A minimal Chrome DevTools Protocol client over Node's WebSocket, for evaluation scripts that start their own
// Chrome with a temporary profile and read its pages' true state.

export class Cdp {
  private n = 0;
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private readonly ws: WebSocket;
  /** The error a request that gets no answer fails with; a caller can turn it into its own abort. */
  private readonly timeoutError: (method: string) => Error;

  private constructor(ws: WebSocket, timeoutError: (method: string) => Error) {
    this.ws = ws;
    this.timeoutError = timeoutError;
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.fail(new Error("the DevTools connection closed"));
      this.pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error !== undefined) p?.fail(new Error(m.error.message));
      else p?.ok(m.result);
    });
  }

  static connect(url: string, timeoutError: (method: string) => Error = (m) => new Error(`no DevTools answer to ${m} within 15 s`)): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        rej(new Error(`no DevTools connection to ${url} within 15 s`));
      }, 15_000);
      ws.addEventListener("open", () => (clearTimeout(t), res(new Cdp(ws, timeoutError))));
      ws.addEventListener("error", () => (clearTimeout(t), rej(new Error(`cannot reach ${url}`))));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((ok, fail) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        fail(this.timeoutError(method));
      }, 15_000);
      this.pending.set(id, {
        ok: (v) => (clearTimeout(t), ok(v)),
        fail: (e) => (clearTimeout(t), fail(e)),
      });
    });
  }

  /** Evaluates `expr` in a page session and returns its value, passed through JSON.stringify. */
  async evaluate(sessionId: string, expr: string): Promise<unknown> {
    const r = (await this.send("Runtime.evaluate", { expression: `JSON.stringify(${expr})`, returnByValue: true }, sessionId)) as { result: { value?: string }; exceptionDetails?: unknown };
    if (r.exceptionDetails !== undefined || r.result.value === undefined) throw new Error(`page: ${JSON.stringify(r.exceptionDetails ?? r.result)}`);
    return JSON.parse(r.result.value) as unknown;
  }

  close(): void {
    this.ws.close();
  }
}

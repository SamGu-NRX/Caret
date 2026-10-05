// LocalModelPort (L1 lead decision 5): words for one field from the on-device model. In: the request's kind, prompt
// parts, an optional GBNF grammar, the output cap and a deadline. Out: the text, the model's name, its time, and token
// counts where the implementation knows them. Two implementations, and neither stands in for the other:
//   - HostLocalModel, the product's: localTextRequest to the host over the helper's socket, since the host already
//     loaded the Gemma for ghost text and there must be one copy in memory. The host side is a later batch.
//   - toolLocalModel, for development and evaluations: G1's caret-local-model (writer/local-model.ts), which reads the
//     GGUF by path. It renders the prompt the way writer/local-draft.ts says the host should.
// A failure is LocalModelUnavailable, which says why; nothing retries.
import { LocalTextRequest, PROTOCOL_VERSION, type LocalTextReply } from "../protocol.ts";
import type { LocalModelTool as LocalTool } from "./local-model.ts";
import { renderDraftPrompt } from "./local-draft.ts";

/** One request's content: localTextRequest without its envelope. */
export type LocalTextAsk = Omit<LocalTextRequest, "type" | "v" | "id">;

export interface LocalText {
  model: string;
  text: string;
  latencyMs: number;
  /** Null when the implementation does not report them (the host's reply carries none). */
  promptTokens: number | null;
  outputTokens: number | null;
  /** Why decoding stopped, when known: `maxTokens` means the text may be an unfinished sentence. */
  stop: "eog" | "maxTokens" | null;
}

export interface LocalModelPort {
  readonly via: "host" | "tool";
  complete(ask: LocalTextAsk, signal?: AbortSignal): Promise<LocalText>;
}

/**
 * No text came back. `why` is the host's outcome, or: `noHost` (no host declared the localModel capability), `hostGone`
 * (it disconnected while the request waited), `aborted` (the caller gave up), `failed` (the tool broke or refused).
 */
export class LocalModelUnavailable extends Error {
  readonly why: Exclude<LocalTextReply["outcome"], "ok"> | "noHost" | "hostGone" | "aborted" | "failed";
  constructor(why: LocalModelUnavailable["why"], message: string) {
    super(message);
    this.why = why;
  }
}

/** Time past the request's deadline the helper still waits for the host's own timeout reply. Assumed, not measured. */
const DEADLINE_GRACE_MS = 1000;

/** The host's local model over the socket. HelperServer routes the host's replies to `reply` and its close to `hostGone`. */
export class HostLocalModel implements LocalModelPort {
  readonly via = "host" as const;
  private seq = 0;
  private readonly pending = new Map<string, (r: LocalTextReply | LocalModelUnavailable) => void>();
  private readonly send: (m: LocalTextRequest) => boolean;
  private readonly now: () => number;

  /** `send` writes to the host that declared the capability, and is false when there is none. */
  constructor(send: (m: LocalTextRequest) => boolean, now: () => number = Date.now) {
    this.send = send;
    this.now = now;
  }

  async complete(ask: LocalTextAsk, signal?: AbortSignal): Promise<LocalText> {
    const id = `lt-${++this.seq}`;
    // Parsed here, so a request the host would refuse by schema fails in the helper, naming the field.
    const msg = LocalTextRequest.parse({ type: "localTextRequest", v: PROTOCOL_VERSION, id, ...ask });
    return new Promise<LocalText>((resolve, reject) => {
      const timer = setTimeout(() => settle(new LocalModelUnavailable("timeout", `the host's local model did not answer by its deadline (+${DEADLINE_GRACE_MS} ms)`)), Math.max(0, msg.deadlineMs - this.now()) + DEADLINE_GRACE_MS);
      const onAbort = (): void => settle(new LocalModelUnavailable("aborted", "the local text request was cancelled"));
      const settle = (r: LocalTextReply | LocalModelUnavailable): void => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (r instanceof LocalModelUnavailable) return reject(r);
        if (r.outcome !== "ok" || r.text === null) return reject(new LocalModelUnavailable(r.outcome === "ok" ? "failed" : r.outcome, `the host's local model answered ${r.outcome}${r.model === "" ? "" : ` (${r.model})`}`));
        resolve({ model: r.model, text: r.text, latencyMs: r.latencyMs, promptTokens: null, outputTokens: null, stop: null });
      };
      this.pending.set(id, settle);
      if (signal?.aborted === true) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.send(msg)) settle(new LocalModelUnavailable("noHost", 'no host that runs the local model is connected (hello capability "localModel")'));
    });
  }

  /** The host's answer. False when no request waits for this id: it came after the helper gave up, or was never asked. */
  reply(m: LocalTextReply): boolean {
    const settle = this.pending.get(m.id);
    if (settle === undefined) return false;
    settle(m);
    return true;
  }

  /** The host that runs the model disconnected: every waiting request fails now. */
  hostGone(): void {
    for (const settle of [...this.pending.values()]) settle(new LocalModelUnavailable("hostGone", "the host that runs the local model disconnected"));
  }
}

/**
 * G1's caret-local-model as a LocalModelPort, for development and evaluations. The tool needs a grammar on every
 * request and composes only drafts (renderDraftPrompt); anything else is refused before it reaches the tool.
 */
export function toolLocalModel(tool: LocalTool): LocalModelPort {
  return {
    via: "tool",
    async complete(ask, signal) {
      if (ask.kind !== "draft") throw new LocalModelUnavailable("refused", `caret-local-model composes drafts only, not a ${ask.kind}`);
      if (ask.grammar === null) throw new LocalModelUnavailable("refused", "caret-local-model needs a grammar on every request");
      let r: Awaited<ReturnType<LocalTool["complete"]>>;
      try {
        const deadline = AbortSignal.timeout(Math.max(1, ask.deadlineMs - Date.now()));
        r = await tool.complete({ ...renderDraftPrompt(ask.prompt), grammar: ask.grammar, maxTokens: ask.maxTokens }, signal === undefined ? deadline : AbortSignal.any([signal, deadline]));
      } catch (e) {
        throw new LocalModelUnavailable(e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : "failed", `caret-local-model: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { model: tool.model, text: r.text, latencyMs: r.ms.total, promptTokens: r.prefixTokens + r.promptTokens, outputTokens: r.outputTokens, stop: r.stop };
    },
  };
}

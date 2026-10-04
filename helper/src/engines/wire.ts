// Joins the page engines to a running Helper (W2): page focus into the fill path, the host's presence signal, and the
// gate that keeps a covered browser's Accessibility focus from asking for fills. main.ts and the fixture acceptance
// both call this once the Helper exists; pageHost (host.ts) made the link the Helper was built with.
import type { HelperMessage } from "../protocol.ts";
import type { Helper } from "../helper.ts";
import type { PageHost } from "./host.ts";
import { PageFocus } from "./page-focus.ts";
import { BrowserPresence } from "./presence.ts";

export interface WiredPages {
  focus: PageFocus;
  presence: BrowserPresence;
  /** Stops listening; the sessions themselves are the server's to close. */
  stop: () => void;
}

export function wirePageEngines(opts: { host: PageHost; helper: Helper; publish: (m: HelperMessage) => void; warn: (line: string) => void; allowBackground?: boolean }): WiredPages {
  const { host, helper } = opts;
  const focus = new PageFocus({ model: helper.model, focus: (m) => void helper.handleReader(m), warn: opts.warn, ...(opts.allowBackground === undefined ? {} : { allowBackground: opts.allowBackground }) });
  const presence = new BrowserPresence({ publish: opts.publish, hasEngine: (pid) => host.registry.forBrowser(pid) !== undefined });
  for (const s of host.registry.list()) if (s.hello !== null) focus.attach(s);
  const unlisten = host.registry.listen({
    onHello: (s) => {
      focus.attach(s);
      presence.engineConnected(s.info.browser);
    },
    onRemove: (s) => presence.engineGone(s.info.browser),
  });
  const untap = helper.onReaderMessage((m) => presence.onReader(m));
  return {
    focus,
    presence,
    stop: () => {
      unlisten();
      untap();
    },
  };
}

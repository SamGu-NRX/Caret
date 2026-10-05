// Joins the page engines to a running Helper (W2): page focus into the fill path, the host's presence signal, and the
// gate that keeps a covered browser's Accessibility focus from asking for fills. W3 adds the user's own input in a
// page under a grant, which pauses every task acting in that tab as the reader's userInput does. main.ts and the fixture acceptance
// both call this once the Helper exists; pageHost (host.ts) made the link the Helper was built with.
import type { HelperMessage } from "../protocol.ts";
import type { Helper } from "../helper.ts";
import type { PageHost } from "./host.ts";
import { PageFocus } from "./page-focus.ts";
import { BrowserPresence } from "./presence.ts";
import type { EngineSession } from "./session.ts";
import { pageWindowId } from "./windows.ts";

export interface WiredPages {
  focus: PageFocus;
  presence: BrowserPresence;
  /** Stops listening; the sessions themselves are the server's to close. */
  stop: () => void;
}

export function wirePageEngines(opts: { host: PageHost; helper: Helper; publish: (m: HelperMessage) => void; warn: (line: string) => void; allowBackground?: boolean }): WiredPages {
  const { host, helper } = opts;
  const focus = new PageFocus({ model: helper.model, focus: (m) => void helper.handleReader(m), publish: opts.publish, warn: opts.warn, ...(opts.allowBackground === undefined ? {} : { allowBackground: opts.allowBackground }) });
  const presence = new BrowserPresence({ publish: opts.publish, hasEngine: (pid) => host.registry.forBrowser(pid) !== undefined });
  const attach = (s: EngineSession): void => {
    focus.attach(s);
    s.onInput = (m) => helper.executor.onPageInput(pageWindowId(s.info.engine, m.tabId), m.kind);
  };
  for (const s of host.registry.list()) if (s.hello !== null) attach(s);
  const unlisten = host.registry.listen({
    onHello: (s) => {
      attach(s);
      presence.engineConnected(s.info.browser);
    },
    onRemove: (s) => presence.engineGone(s.info.browser),
  });
  const untap = helper.onReaderMessage((m) => presence.onReader(m));
  // The host's "Not on this site" list, from its settings, to every engine (registry.ts sends it after each hello too).
  const unsites = helper.onSitesOff((origins) => host.registry.setSitesOff(origins));
  return {
    focus,
    presence,
    stop: () => {
      unlisten();
      untap();
      unsites();
    },
  };
}

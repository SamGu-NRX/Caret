// Wires the page engines into a Helper: the registry, page.sock, and the routed link the executor uses. The helper's
// own entry point (main.ts) is untouched in W1; the fixture acceptance (fixtures/web-form/accept.ts) uses this, and
// the lead decides at merge whether main.ts starts page.sock by default.
import { join, dirname } from "node:path";
import type { Snapshot, WindowClosed } from "../protocol.ts";
import { RoutedReaderLink, type ReaderLink } from "../executor/means.ts";
import { EngineRegistry } from "./registry.ts";
import { EngineServer } from "./server.ts";

export interface PageHost {
  registry: EngineRegistry;
  server: EngineServer;
  /** Pass to Helper as `readerLink`: page windows to their engine, everything else to `reader`. */
  link: RoutedReaderLink;
}

/** page.sock beside the reader's socket. */
export function defaultPageSocket(screenSocket: string): string {
  return join(dirname(screenSocket), "page.sock");
}

export function pageHost(opts: { path: string; reader: ReaderLink; apply: (m: Snapshot | WindowClosed) => void; warn: (line: string) => void }): PageHost {
  const registry = new EngineRegistry({ apply: opts.apply });
  const server = new EngineServer({ path: opts.path, registry, warn: opts.warn });
  return { registry, server, link: new RoutedReaderLink(opts.reader, registry) };
}

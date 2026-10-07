// Wires the page engines into a Helper: the registry, page.sock, and the routed link the executor uses. main.ts starts
// it by default (--no-page turns it off), and the fixture acceptance (fixtures/web-form/accept.ts) uses it directly.
import { join, dirname } from "node:path";
import type { Snapshot, WindowClosed } from "../protocol.ts";
import { RoutedReaderLink, type ReaderLink } from "../executor/means.ts";
import { EngineRegistry } from "./registry.ts";
import { EngineServer } from "./server.ts";
import type { VerbTiming } from "./page-link.ts";

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

/** `secret` is the launch secret (src/launch.ts); page.sock's key is derived from it (auth.ts pageKey). */
export function pageHost(opts: { path: string; secret: Buffer; reader: ReaderLink; apply: (m: Snapshot | WindowClosed) => void; purge: (s: Snapshot) => void; warn: (line: string) => void; onTiming?: (t: VerbTiming) => void }): PageHost {
  const registry = new EngineRegistry({ apply: opts.apply, purge: opts.purge, ...(opts.onTiming === undefined ? {} : { onTiming: opts.onTiming }) });
  const server = new EngineServer({ path: opts.path, launchSecret: opts.secret, registry, warn: opts.warn });
  return { registry, server, link: new RoutedReaderLink(opts.reader, registry) };
}

// The writers the helper starts with (L1). By default there is no program writer and Ask's intents come from Jev, so
// no default path calls Groq or any other chat provider. A developer may name one route with --dev-writer; the helper
// then says so on start, and a missing key stops the start rather than leaving that writer off or picking another.
import { WRITER_ROUTE } from "./config.ts";
import { devWriterRoute } from "./routes.ts";
import { readKey } from "./env.ts";
import { processEnv, type HostEnv } from "../host-env.ts";
import { makeWriterPort, type WriterPort } from "./port.ts";

export interface StartWriters {
  /** Code-mode plans and goal programs; null when no developer named a route. */
  plan: WriterPort | null;
  /** How Ask makes its intent (helper.ts HelperOptions.ask). */
  ask: { maker: "heads" };
}

/**
 * `devWriter` is main.ts's --dev-writer ("groq:<model>" or "gateway:<model>"), undefined without it. `say` writes one
 * line to the helper's log.
 */
export function writersOnStart(devWriter: string | undefined, say: (line: string) => void, env: HostEnv = processEnv()): StartWriters {
  if (devWriter === undefined) {
    // Configured routes are null since L1; a non-null one is explicit configuration, used as written.
    const plan = WRITER_ROUTE === null ? null : makeWriterPort(WRITER_ROUTE);
    const ask = { maker: "heads" as const };
    say(`writers: ${plan === null ? "no program writer, so goals say they are not available" : `program writer ${WRITER_ROUTE?.provider} ${WRITER_ROUTE?.model}`}; Ask's intents from Jev in one request (writer/config.ts)`);
    return { plan, ask };
  }
  const route = devWriterRoute(devWriter);
  try {
    readKey(route.keyName, env);
  } catch (e) {
    throw new Error(`--dev-writer ${devWriter} cannot start: ${e instanceof Error ? e.message : String(e)}`);
  }
  const plan = makeWriterPort(route);
  say(`DEVELOPER FLAG --dev-writer: plan and goal programs go to ${route.provider} ${route.model}. This is not a default path.`);
  return { plan, ask: { maker: "heads" } };
}

// The writers the helper starts with (L1). By default there is no program writer and Ask's intents come from Jev, so
// no default path calls Groq or any other chat provider. A developer may name one route with --dev-writer; the helper
// then says so on start, and a missing key stops the start rather than leaving that writer off or picking another.
import { ASK_MAKER, devWriterRoute } from "./config.ts";
import { readKey } from "./env.ts";
import { makeWriterPort, type WriterPort } from "./port.ts";

export interface StartWriters {
  /** Code-mode plans and goal programs; null when no developer named a route. */
  plan: WriterPort | null;
  /** How Ask makes its intent (helper.ts HelperOptions.ask). */
  ask: { maker: "jev" } | { maker: "writer"; writer: WriterPort };
}

/**
 * `devWriter` is main.ts's --dev-writer ("groq:<model>" or "gateway:<model>"), undefined without it. `say` writes one
 * line to the helper's log.
 */
export function writersOnStart(devWriter: string | undefined, say: (line: string) => void, env: NodeJS.ProcessEnv = process.env): StartWriters {
  if (devWriter === undefined) {
    if (ASK_MAKER === "writer") throw new Error("writer/config.ts ASK_MAKER is \"writer\", which needs a route: start with --dev-writer provider:model");
    say("writers: no program writer, so goals say they are not available; Ask's intents come from Jev (writer/config.ts)");
    return { plan: null, ask: { maker: "jev" } };
  }
  const route = devWriterRoute(devWriter);
  try {
    readKey(route.keyName, env);
  } catch (e) {
    throw new Error(`--dev-writer ${devWriter} cannot start: ${e instanceof Error ? e.message : String(e)}`);
  }
  const plan = makeWriterPort(route);
  say(`DEVELOPER FLAG --dev-writer: plan and goal programs go to ${route.provider} ${route.model}${ASK_MAKER === "writer" ? ", and Ask's intents too" : ""}. This is not a default path.`);
  return { plan, ask: ASK_MAKER === "writer" ? { maker: "writer", writer: plan } : { maker: "jev" } };
}

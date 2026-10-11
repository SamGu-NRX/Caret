// Lists Vercel AI Gateway's free models and tries one tiny completion (L1 lead decision 4). The gateway route is off
// by default; this says whether turning it on would work today.
//   CARET_ENV_FILE=… node scripts/gateway-probe.ts [--model ID] [--out FILE]
// A model is free when the listing prices both input and output at 0. The call asks for at most 8 tokens from the
// first free model (or --model) and costs nothing on a free model. The key is read at call time and never printed.
// Exit status: 0 the call was served, 3 the gateway needs a card on file (chat.ts GatewayNeedsCard), 1 anything else.
import { writeStore } from "../src/privacy/send.ts";
import { Disclosure, registryOf } from "../src/privacy/disclosure.ts";
import { seal } from "../src/privacy/send.ts";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as z from "zod";
import { chat, chatSink, GatewayNeedsCard, type ChatRoute } from "../src/writer/chat.ts";
import { GATEWAY_BASE_URL } from "../src/writer/routes.ts";
import { readKey } from "../src/writer/env.ts";

const { values: a } = parseArgs({ options: { model: { type: "string" }, out: { type: "string" } } });

const Price = z.union([z.string(), z.number()]).optional();
const Listing = z.object({ data: z.array(z.object({ id: z.string(), type: z.string().optional(), pricing: z.object({ input: Price, output: Price }).loose().optional() }).loose()) });

const res = await fetch(`${GATEWAY_BASE_URL}/models`, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) throw new Error(`the gateway's model list answered HTTP ${res.status}`);
const models = Listing.parse(await res.json()).data;
const zero = (p: string | number | undefined): boolean => p !== undefined && Number(p) === 0;
const free = models.filter((m) => zero(m.pricing?.input) && zero(m.pricing?.output));
const lines = [`${new Date().toISOString()} gateway lists ${models.length} models, ${free.length} free (input and output priced 0):`, ...free.map((m) => `  ${m.id}${m.type === undefined ? "" : ` (${m.type})`}`)];

const model = a.model ?? free.find((m) => m.type === undefined || m.type === "language")?.id;
let exit = 1;
if (model === undefined) lines.push("no free language model to try");
else {
  const route: ChatRoute = { provider: "gateway", baseUrl: GATEWAY_BASE_URL, keyName: "AI_GATEWAY_API_KEY", model, maxTokensParam: "max_tokens", extraBody: {}, pricing: { inputUsdPerMTok: 0, outputUsdPerMTok: 0, source: "the gateway's listing, free" } };
  try {
    // The probe's one message is Caret's own wording, a request with no purpose (privacy/shapes.ts UNNAMED).
    // No screen is read, so its registry holds no window: the seal measures the probe against nothing.
    const d = new Disclosure(registryOf([]));
    const sealed = seal({ req: { disclosure: d }, wire: { probe: d.own("Say OK.") } }, chatSink(route, (w) => [{ role: "user", content: (w as { probe: string }).probe }], [], 8));
    const r = await chat(route, readKey(route.keyName), sealed, AbortSignal.timeout(20_000));
    lines.push(`call ${model}: served by ${r.servedModel} in ${Math.round(r.latencyMs)} ms, ${r.inputTokens} in / ${r.outputTokens} out tokens`);
    exit = 0;
  } catch (e) {
    lines.push(`call ${model}: ${e instanceof Error ? e.message : String(e)}`);
    exit = e instanceof GatewayNeedsCard ? 3 : 1;
  }
}
const report = lines.join("\n") + "\n";
process.stdout.write(report);
if (a.out !== undefined) writeStore(a.out, report);
process.exitCode = exit;

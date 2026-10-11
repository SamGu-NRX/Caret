// Writes schemas/screen-protocol.schema.json from the zod schemas in protocol.ts, and
// schemas/plan.schema.json from executor/schema.ts.
// test/schema.test.ts fails when the committed file is stale, so rerun `pnpm schema` after editing protocol.ts.
import { writeLocalFile } from "./privacy/store-path.ts";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { ConsumerMessage, HelperMessage, HelperToReader, PROTOCOL_VERSION, PageFieldText, ReaderMessage } from "./protocol.ts";
import { EndState, Plan } from "./executor/schema.ts";

export const SCHEMA_PATH = fileURLToPath(new URL("../schemas/screen-protocol.schema.json", import.meta.url));
export const PLAN_SCHEMA_PATH = fileURLToPath(new URL("../schemas/plan.schema.json", import.meta.url));

/** The executor's plan and end-state schemas, for whoever writes plans outside the helper. */
export function renderPlanJsonSchema(): string {
  const doc = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Caret executor plan",
    description: "Generated from helper/src/executor/schema.ts. Do not edit by hand.",
    $defs: { Plan: z.toJSONSchema(Plan), EndState: z.toJSONSchema(EndState) },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function protocolJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `Caret screen protocol v${PROTOCOL_VERSION}`,
    description: "Generated from helper/src/protocol.ts. Do not edit by hand.",
    $defs: {
      ReaderMessage: z.toJSONSchema(ReaderMessage),
      ConsumerMessage: z.toJSONSchema(ConsumerMessage),
      HelperMessage: z.toJSONSchema(HelperMessage),
      HelperToReader: z.toJSONSchema(HelperToReader),
      // P4: the text part of the host's pageField (H10's PageField on v2/host carries it).
      PageFieldText: z.toJSONSchema(PageFieldText),
    },
  };
}

export function renderProtocolJsonSchema(): string {
  return JSON.stringify(protocolJsonSchema(), null, 2) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeLocalFile(SCHEMA_PATH, renderProtocolJsonSchema());
  writeLocalFile(PLAN_SCHEMA_PATH, renderPlanJsonSchema());
  console.log(`wrote ${SCHEMA_PATH} and ${PLAN_SCHEMA_PATH}`);
}

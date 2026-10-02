// Writes schemas/screen-protocol.schema.json from the zod schemas in protocol.ts.
// test/schema.test.ts fails when the committed file is stale, so rerun `pnpm schema` after editing protocol.ts.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, ReaderMessage } from "./protocol.ts";

export const SCHEMA_PATH = fileURLToPath(new URL("../schemas/screen-protocol.schema.json", import.meta.url));

export function protocolJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `Caret screen protocol v${PROTOCOL_VERSION}`,
    description: "Generated from helper/src/protocol.ts. Do not edit by hand.",
    $defs: {
      ReaderMessage: z.toJSONSchema(ReaderMessage),
      ConsumerMessage: z.toJSONSchema(ConsumerMessage),
      HelperMessage: z.toJSONSchema(HelperMessage),
    },
  };
}

export function renderProtocolJsonSchema(): string {
  return JSON.stringify(protocolJsonSchema(), null, 2) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(SCHEMA_PATH, renderProtocolJsonSchema());
  console.log(`wrote ${SCHEMA_PATH}`);
}

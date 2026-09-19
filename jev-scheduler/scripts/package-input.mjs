// Writes jev-input.json: the exact POST body for the extract pass (paste into the TypeSafe playground or curl it).
import { writeFileSync } from "node:fs";
import { extractRequest } from "../lib/pipeline.ts";

const body = extractRequest();
writeFileSync("jev-input.json", JSON.stringify(body, null, 2) + "\n");
console.log(`jev-input.json written: ${Object.keys(body.questions).length} questions, state ${JSON.stringify(body.state).length} chars`);
console.log(`curl -s https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" -d @jev-input.json`);

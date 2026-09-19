import { NextResponse } from "next/server";
import { loadInputs } from "@/lib/inputs";
import { extractRequest, runPipeline } from "@/lib/pipeline";
import { jevMode } from "@/lib/jev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const inputs = loadInputs();
  return NextResponse.json({ mode: jevMode(), inputs, jev_input: extractRequest() });
}

export async function POST() {
  try {
    return NextResponse.json(await runPipeline());
  } catch (error) {
    return NextResponse.json({ status: "error", error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

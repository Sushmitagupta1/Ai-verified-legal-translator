import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createLlmClient, providerDisplayName } from "@/lib/llm";
import { describeBackends } from "@/lib/pipeline/backends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let provider: string;
  let available = false;
  try {
    const llm = createLlmClient();
    provider = providerDisplayName(llm);
    available = llm.available;
  } catch {
    provider = `${config.llm.provider} (unavailable)`;
  }

  return NextResponse.json({
    ok: true,
    provider,
    providerId: config.llm.provider,
    model: config.llm.model || null,
    llmAvailable: available,
    ...describeBackends(),
  });
}

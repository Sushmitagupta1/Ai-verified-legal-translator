import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { all, get } from "@/lib/db";
import { createLlmClient, providerDisplayName } from "@/lib/llm";
import { describeBackends } from "@/lib/pipeline/backends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operational health for the operator, not for the LLM: is the provider there,
 * which model does which job, and is the queue moving.
 */
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

  let queue: { running: number; queued: number; failedLast24h: number } | null = null;
  try {
    const running =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`)?.n ?? 0;
    const queued =
      get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`)?.n ?? 0;
    const failedLast24h =
      all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM jobs
          WHERE status = 'failed' AND finished_at >= ?`,
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      )[0]?.n ?? 0;
    queue = { running, queued, failedLast24h };
  } catch {
    queue = null;
  }

  return NextResponse.json({
    ok: available,
    provider,
    providerId: config.llm.provider,
    model: config.llm.model || null,
    judgeModel: config.llm.judgeModel || null,
    judgeFastModel: config.llm.judgeFastModel || null,
    repairModel: config.llm.repairModel || null,
    narrativeModel: config.report.narrativeLlm ? "llm" : "deterministic",
    queueConcurrency: config.pipeline.queueConcurrency,
    llmAvailable: available,
    queue,
    uptimeSeconds: Math.round(process.uptime()),
    ...describeBackends(),
  });
}

import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { cancelJob } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stop a queued or running job.
 *
 * Anything already produced stays on disk: cancelling the audit after the Word
 * file is ready must not delete the deliverable.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const exists = get<{ id: string }>("SELECT id FROM documents WHERE id = ?", id);
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });

  const result = cancelJob(id);
  return NextResponse.json(result, { status: result.cancelled ? 202 : 409 });
}

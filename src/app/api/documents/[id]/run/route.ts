import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { isRunning, startJob } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const exists = get<{ id: string }>(`SELECT id FROM documents WHERE id = ?`, id);
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    if (isRunning(id)) {
      return NextResponse.json({ job: startJob(id), alreadyRunning: true });
    }
    return NextResponse.json({ job: startJob(id) }, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

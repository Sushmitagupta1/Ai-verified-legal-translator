import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { getStageTimings } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the time went, stage by stage, for one document. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const exists = get<{ id: string }>("SELECT id FROM documents WHERE id = ?", id);
  if (!exists) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ timings: getStageTimings(id) });
}

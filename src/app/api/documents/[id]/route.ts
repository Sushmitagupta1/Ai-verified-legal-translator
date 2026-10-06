import { NextResponse } from "next/server";
import { get, type SqlValue } from "@/lib/db";
import {
  loadBlocks,
  loadFindings,
  loadReport,
  loadTranslation,
} from "@/lib/pipeline/run";
import { getJobState } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DocumentRow {
  [key: string]: SqlValue;
  id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  declared_type: string | null;
  detected_type: string | null;
  type_confidence: number | null;
  page_count: number;
  status: string;
  stage: string | null;
  error: string | null;
  fidelity: number | null;
  fidelity_band: string | null;
  gate_status: string;
  human_review: string;
  created_at: string;
  updated_at: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const document = get<DocumentRow>(
    `SELECT id, file_name, mime, size_bytes, declared_type, detected_type, type_confidence,
            page_count, status, stage, error, fidelity, fidelity_band, gate_status,
            human_review, created_at, updated_at
       FROM documents
      WHERE id = ?`,
    id,
  );
  if (!document) return NextResponse.json({ error: "not found" }, { status: 404 });

  const report = loadReport(id);
  const segments = loadTranslation(id);
  const findings = loadFindings(id);
  const blocks = loadBlocks(id);

  const bySeverity = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    document,
    job: getJobState(id),
    report,
    segmentCount: segments.length,
    blockCount: blocks.length,
    segments,
    findings,
    findingsBySeverity: bySeverity,
  });
}

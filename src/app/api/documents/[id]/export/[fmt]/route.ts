import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { exportDocument, type ExportFormat } from "@/lib/pipeline/export";
import { loadBlocks, loadReport } from "@/lib/pipeline/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fmt: string }> },
) {
  const { id, fmt } = await params;
  if (!(fmt in CONTENT_TYPES)) {
    return NextResponse.json({ error: "format must be pdf, docx or txt" }, { status: 400 });
  }

  const document = get<{ file_name: string }>(
    `SELECT file_name FROM documents WHERE id = ?`,
    id,
  );
  if (!document) return NextResponse.json({ error: "not found" }, { status: 404 });

  const report = loadReport(id);
  if (!report) {
    return NextResponse.json(
      { error: "The verification report is not ready yet — run the pipeline first." },
      { status: 409 },
    );
  }

  try {
    const format = fmt as ExportFormat;
    const result = await exportDocument(
      { docId: id, fileName: document.file_name, blocks: loadBlocks(id), report },
      format,
    );
    const bytes = fs.readFileSync(result.path);
    const base = path
      .basename(document.file_name, path.extname(document.file_name))
      .replace(/[^\w.-]+/g, "_");

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${base}-verification-report.${format}"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

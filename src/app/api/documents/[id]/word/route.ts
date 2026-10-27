import fs from "node:fs";
import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { exportDocument } from "@/lib/pipeline/export";
import { loadBlocks, loadReport } from "@/lib/pipeline/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The deliverable, under the one URL the UI links to: the English translation
 * as an editable .docx. It is the same builder as the export route, kept here so
 * the main flow never has to know about `?kind=` or report/TCR formats.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const document = get<{ file_name: string; company_name: string | null }>(
    `SELECT file_name, company_name FROM documents WHERE id = ?`,
    id,
  );
  if (!document) return NextResponse.json({ error: "That file is not in the library." }, { status: 404 });

  const blocks = loadBlocks(id);
  // The Word file is the deliverable, not the audit. It becomes downloadable as
  // soon as the translation is on disk; the report may still be running.
  if (blocks.length === 0 || !blocks.some((b) => (b.targetText ?? "").trim())) {
    return NextResponse.json(
      { error: "The English file is not ready yet — wait for the translation to finish, then download again." },
      { status: 409 },
    );
  }

  try {
    const result = await exportDocument(
      {
        docId: id,
        fileName: document.file_name,
        blocks,
        report: loadReport(id),
        companyName: document.company_name ?? "",
      },
      "docx",
      "translation",
    );
    const bytes = fs.readFileSync(result.path);

    const original = document.file_name.replace(/\.[^.]+$/, "");
    const asciiBase = original.replace(/[^\w.-]+/g, "_") || "document";
    const utfName = encodeURIComponent(`${original}-english.docx`);

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${asciiBase}-english.docx"; filename*=UTF-8''${utfName}`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

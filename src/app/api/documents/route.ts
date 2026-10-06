import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { config, ensureDirs } from "@/lib/config";
import { all, get, type SqlValue } from "@/lib/db";
import { createDocument } from "@/lib/pipeline/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIMES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
};

interface DocumentSummary {
  [key: string]: SqlValue;
  id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  declared_type: string | null;
  detected_type: string | null;
  company_name: string | null;
  type_confidence: number | null;
  page_count: number;
  status: string;
  stage: string | null;
  fidelity: number | null;
  fidelity_band: string | null;
  gate_status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function GET() {
  ensureDirs();
  const documents = all<DocumentSummary>(
    `SELECT id, file_name, mime, size_bytes, declared_type, detected_type, company_name, type_confidence,
            page_count, status, stage, fidelity, fidelity_band, gate_status, error,
            created_at, updated_at
       FROM documents
      ORDER BY created_at DESC`,
  );
  return NextResponse.json({ documents });
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const raw = form.get("file");
    const file =
      raw && typeof raw === "object" && "arrayBuffer" in raw ? (raw as File) : null;
    if (!file) return NextResponse.json({ error: "No file field in the form." }, { status: 400 });

    const ext = path.extname(file.name).toLowerCase();
    const mime = MIMES[ext];
    if (!mime) {
      return NextResponse.json(
        { error: `Unsupported extension "${ext || "(none)"}". Use ${Object.keys(MIMES).join(", ")}.` },
        { status: 400 },
      );
    }
    if (ext === ".doc") {
      return NextResponse.json(
        { error: "Legacy .doc is not supported — save it as .docx first (Word: Save As → Word Document)." },
        { status: 400 },
      );
    }
    if (file.size > config.maxUploadBytes) {
      return NextResponse.json(
        { error: `File is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.` },
        { status: 413 },
      );
    }

    const declared = form.get("type");
    const declaredType = typeof declared === "string" && declared.trim() ? declared.trim() : null;

    const company = form.get("companyName");
    const companyName = typeof company === "string" && company.trim() ? company.trim() : null;

    ensureDirs();
    const buffer = Buffer.from(await file.arrayBuffer());
    const id = createDocument({
      fileName: file.name,
      mime,
      sizeBytes: buffer.length,
      declaredType,
      companyName,
    });

    const stored =
      get<{ stored_name: string }>(`SELECT stored_name FROM documents WHERE id = ?`, id)
        ?.stored_name ?? `${id}${ext}`;
    fs.writeFileSync(path.join(config.uploadDir, stored), buffer);

    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

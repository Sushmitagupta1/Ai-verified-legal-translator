import fs from "node:fs";
import path from "node:path";

/**
 * Run the full pipeline against a real document on disk.
 *
 *   npx tsx scripts/run-file.ts <path> [path...]
 *
 * Provider comes from NYD_LLM_PROVIDER; it is not overridden here so the same
 * script drives ollama, anthropic, openai, fixture and stub runs alike.
 * Outputs land in NYD_DATA_DIR (default ./data) and are gitignored.
 */

const MIMES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
};

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("usage: npx tsx scripts/run-file.ts <path> [path...]");
  process.exit(2);
}

async function runOne(file: string): Promise<string> {
  const out: string[] = [];
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`not found: ${abs}`);

  const ext = path.extname(abs).toLowerCase();
  const mime = MIMES[ext];
  if (!mime) throw new Error(`unsupported extension "${ext}" — use ${Object.keys(MIMES).join(", ")}`);
  if (ext === ".doc") throw new Error("legacy .doc is not supported — convert to .docx first (Word: Save As -> Word Document)");

  const buffer = fs.readFileSync(abs);
  out.push(`── ${path.basename(abs)} ──`);
  out.push(`size = ${buffer.length} bytes   mime = ${mime}`);

  const { createDocument, runPipeline, loadTranslation, loadReport, loadBlocks } = await import(
    "../src/lib/pipeline/run"
  );
  const { exportDocument } = await import("../src/lib/pipeline/export");

  const doc = createDocument({ fileName: path.basename(abs), mime, sizeBytes: buffer.length });
  const started = Date.now();
  const log: string[] = [];

  const result = await runPipeline({
    documentId: doc,
    buffer,
    fileName: path.basename(abs),
    mime,
    onProgress: (stage, detail, pct) => log.push(`  ${stage} ${pct}% ${detail}`),
  });

  out.push("");
  out.push("── progress ──");
  out.push(...log);

  out.push("");
  out.push("── result ──");
  out.push(`elapsed          = ${Math.round((Date.now() - started) / 1000)}s`);
  out.push(`stage            = ${result.stage}`);
  out.push(`gateStatus       = ${result.gateStatus}`);
  out.push(`grade            = ${result.grade}`);
  out.push(`fidelity         = ${result.fidelity}`);
  out.push(`detectedType     = ${result.detectedType} (${result.detectedTypeLabel}) conf=${result.typeConfidence}`);
  out.push(`provider         = ${result.provider}`);
  out.push(`pageCount        = ${result.pageCount}`);
  out.push(`blocks/segments  = ${result.blockCount}/${result.segmentCount}`);
  out.push(`critical/findings= ${result.criticalCount}/${result.findings}`);
  out.push(`blocked          = ${result.blocked}`);
  if (result.warnings.length) out.push(`warnings         = ${JSON.stringify(result.warnings, null, 2)}`);
  if (result.preflightWarnings.length)
    out.push(`preflight        = ${JSON.stringify(result.preflightWarnings, null, 2)}`);

  out.push("");
  out.push("── coverage ──");
  out.push(`ratio            = ${result.verification.coverage.ratio}`);
  out.push(`stuntedBlocks    = ${JSON.stringify(result.verification.coverage.stuntedBlocks)}`);
  out.push(`emptyBlocks      = ${JSON.stringify(result.verification.coverage.emptyBlocks)}`);

  out.push("");
  out.push("── datum conservation ──");
  const datums = result.verification.datums;
  const byStatus = datums.reduce<Record<string, number>>((a, d) => {
    a[d.status] = (a[d.status] ?? 0) + 1;
    return a;
  }, {});
  out.push(`total datums = ${datums.length} ${JSON.stringify(byStatus)}`);
  for (const d of datums.filter((x) => x.status !== "matched").slice(0, 15)) {
    out.push(`  [${d.status}] ${d.kind} src=${JSON.stringify(d.surface)} -> tgt=${JSON.stringify(d.targetSurface ?? "")}`);
  }

  out.push("");
  out.push("── findings by check ──");
  const byCode = result.verification.findings.reduce<Record<string, number>>((a, f) => {
    a[f.check] = (a[f.check] ?? 0) + 1;
    return a;
  }, {});
  out.push(JSON.stringify(byCode, null, 2));

  const rep = loadReport(doc) ?? result.report;
  out.push("");
  out.push("── report ──");
  out.push(`indicator value   = ${rep.fidelityIndicator.value}`);
  out.push(`indicator grade   = ${rep.fidelityIndicator.grade}`);
  out.push(`components        = ${JSON.stringify(rep.fidelityIndicator.components)}`);
  out.push(`mechChecks        = ${rep.mechanicalChecks.length}`);
  out.push(`report.findings   = ${rep.findings.length}`);
  out.push(`certified claim   = ${/certified|court-certified/i.test(rep.narrative.executiveSummary) ? "YES (BUG)" : "no"}`);

  out.push("");
  out.push("── sample segments ──");
  const segs = loadTranslation(doc);
  for (const s of segs.slice(0, 6)) {
    out.push(`[${s.index}] GU: ${s.source.slice(0, 90)}`);
    out.push(`       EN: ${s.target.slice(0, 90)}`);
  }
  if (segs.length > 6) out.push(`  ... ${segs.length - 6} more segments`);

  out.push("");
  out.push("── exports ──");
  const exportInput = { docId: doc, fileName: path.basename(abs), blocks: loadBlocks(doc), report: rep };
  const paths: string[] = [];
  for (const fmt of ["txt", "pdf", "docx"] as const) {
    try {
      const r = await exportDocument(exportInput, fmt);
      out.push(`${fmt.padEnd(5)} ok  ${r.bytes} bytes  ${r.path ?? ""}`);
      if (r.path) paths.push(r.path);
    } catch (e) {
      out.push(`${fmt.padEnd(5)} FAIL ${(e as Error).message}`);
    }
  }

  return out.join("\n");
}

async function main() {
  const results: string[] = [];
  for (const f of inputs) {
    try {
      results.push(await runOne(f));
    } catch (e) {
      results.push(`── ${f} ──\nERROR: ${(e as Error).message}`);
    }
    results.push("");
  }
  console.log(results.join("\n"));
}

main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  console.error((e as Error).stack ?? "");
  process.exit(1);
});

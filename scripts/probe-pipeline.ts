import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the DB and uploads so a probe run never touches real data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nyayadoot-probe-"));
process.env.NYD_DATA_DIR = tmp;
process.env.NYD_LLM_PROVIDER = "stub";
process.env.NYD_OCR_PROVIDER = "none";

import { runPipeline, loadTranslation, loadReport, loadBlocks, createDocument } from "../src/lib/pipeline/run";
import { exportDocument } from "../src/lib/pipeline/export";

const GUJARATI = [
  "માનનીય સ્રી રમેશ કિશોર શાહ, માર્ગ દરજ્જો, ગાંધી રોડ, અમદાવાદ.",
  "આ વકાલતનામું તારીખ 12/03/2024 ના રોજ આપવામાં આવ્યું છે.",
  "અતિકાલમાં ચુકવણી રૂ. ૫૦,૦૦૦ સમાનનો દંડ થાય છે.",
  "આ કાયદો કલમ 302 ની સંબંધમાં છે.",
  "તમારે ૧૫ દિવસમાં જવાબ આપવો અનિવાર્ય છે.",
  "સ્થાન: અમદાવાદ",
  "તા. 12/03/2024",
  "- ૧ -",
];

const out: string[] = [];
const log: string[] = [];

async function main() {
  const buf = Buffer.from(GUJARATI.join("\n"), "utf8");
  const doc = createDocument({ fileName: "probe.txt", mime: "text/plain", sizeBytes: buf.length });

  const result = await runPipeline({
    documentId: doc,
    buffer: buf,
    fileName: "probe.txt",
    mime: "text/plain",
    onProgress: (stage, detail, pct) => log.push(`  ${stage} ${pct}% ${detail}`),
  });

  out.push("── progress ──");
  out.push(...log);
  out.push("");
  out.push("── result ──");
  out.push(`stage            = ${result.stage}`);
  out.push(`gateStatus       = ${result.gateStatus}`);
  out.push(`grade            = ${result.grade}`);
  out.push(`fidelity         = ${result.fidelity}`);
  out.push(`detectedType     = ${result.detectedType} (${result.detectedTypeLabel}) conf=${result.typeConfidence}`);
  out.push(`provider         = ${result.provider}`);
  out.push(`blocks/segments  = ${result.blockCount}/${result.segmentCount}`);
  out.push(`critical/findings= ${result.criticalCount}/${result.findings}`);
  out.push(`blocked          = ${result.blocked}`);
  out.push(`warnings         = ${JSON.stringify(result.warnings)}`);
  out.push(`preflight        = ${JSON.stringify(result.preflightWarnings)}`);

  out.push("");
  out.push("── coverage ──");
  out.push(`ratio            = ${result.verification.coverage.ratio}`);
  out.push(`emptyBlocks      = ${JSON.stringify(result.verification.coverage.emptyBlocks)}`);
  out.push(`stuntedBlocks    = ${JSON.stringify(result.verification.coverage.stuntedBlocks)}`);

  out.push("");
  out.push("── segments (persisted) ──");
  for (const s of loadTranslation(doc)) {
    out.push(`[${s.index}] locked=${s.locked ?? false}`);
    out.push(`  GU: ${s.source.slice(0, 78)}`);
    out.push(`  EN: ${s.target.slice(0, 78)}`);
  }

  out.push("");
  out.push("── datum conservation ──");
  const datums = result.verification.datums;
  const byStatus = datums.reduce<Record<string, number>>((a, d) => {
    a[d.status] = (a[d.status] ?? 0) + 1;
    return a;
  }, {});
  out.push(`total datums = ${datums.length} ${JSON.stringify(byStatus)}`);
  for (const d of datums.filter((x) => x.status !== "matched").slice(0, 10)) {
    out.push(`  [${d.status}] ${d.kind} src=${JSON.stringify(d.surface)} -> tgt=${JSON.stringify(d.targetSurface ?? "")}`);
  }

  out.push("");
  out.push("── findings by check ──");
  const byCode = result.verification.findings.reduce<Record<string, number>>((a, f) => {
    a[f.check] = (a[f.check] ?? 0) + 1;
    return a;
  }, {});
  out.push(JSON.stringify(byCode, null, 2));

  out.push("");
  out.push("── report ──");
  const rep = loadReport(doc) ?? result.report;
  out.push(`indicator value   = ${rep.fidelityIndicator.value}`);
  out.push(`indicator grade   = ${rep.fidelityIndicator.grade}`);
  out.push(`components        = ${JSON.stringify(rep.fidelityIndicator.components)}`);
  out.push(`mechChecks        = ${rep.mechanicalChecks.length}`);
  out.push(`report.findings   = ${rep.findings.length}`);
  out.push(`narrative words   = ${rep.narrative.executiveSummary.split(/\s+/).length}`);
  out.push(`cert block present= ${rep.humanCertification.completed === false}`);
  out.push(`certified claim   = ${/certified|court-certified/i.test(rep.narrative.executiveSummary) ? "YES (BUG)" : "no"}`);

  out.push("");
  out.push("── exports ──");
  const exportInput = {
    docId: doc,
    fileName: "probe.txt",
    blocks: loadBlocks(doc),
    report: rep,
  };
  for (const fmt of ["txt", "pdf", "docx"] as const) {
    try {
      const r = await exportDocument(exportInput, fmt);
      out.push(`${fmt.padEnd(5)} ok  ${r.bytes} bytes`);
    } catch (e) {
      out.push(`${fmt.padEnd(5)} FAIL ${(e as Error).message}`);
    }
  }

  out.push("");
  out.push(`blocks loaded = ${loadBlocks(doc).length}`);
  out.push(`tmpDir = ${tmp}`);
  console.log(out.join("\n"));
}

main().catch((e) => {
  out.push(`FATAL: ${(e as Error).message}`);
  out.push((e as Error).stack ?? "");
  console.log(out.join("\n"));
  process.exit(1);
});
import fs from "node:fs";
import path from "node:path";
import type PDFKitType from "pdfkit";
import { config, ensureDirs } from "../config";
import { DISCLAIMER } from "../domain/glossary";
import { normalizeWhitespace, transliterateGujarati } from "../domain/gujarati";
import { detectReportPattern, patternHeader, patternParts, type PatternPart, type ReportPattern } from "../domain/letterhead";
import type { Block, Finding } from "../domain";
import type { VerificationReport } from "./report";

export interface ExportInput {
  docId: string;
  fileName: string;
  blocks: Block[];
  report: VerificationReport;
  /** Findings keyed by block id for inline annotation. */
  findingsByBlock?: Map<string, Finding[]>;
  /**
   * Resolved company/addressee name the report is addressed to. Supplied by the
   * operator at upload or detected from the document; see `resolveCompanyName`.
   */
  companyName?: string;
}

/** Which document is being produced: the review report or the clean translation. */
export type ExportKind = "verification" | "translation";

type RenderRole = "h1" | "h2" | "p";

function roleOf(b: Block): RenderRole {
  if (b.kind === "document_title" || b.kind === "heading_1") return "h1";
  if (b.kind === "heading_2" || b.kind === "heading_3" || b.kind === "table_header") return "h2";
  return "p";
}

/** English body text; an untranslated block stays in the source and says so. */
function englishOf(b: Block): string {
  const target = normalizeWhitespace(b.targetText ?? "");
  if (target) return target;
  return `${normalizeWhitespace(b.sourceText)} [not translated]`;
}

function patternOf(input: ExportInput): ReportPattern {
  return detectReportPattern(input.blocks);
}

function headerOf(input: ExportInput, voice: "source" | "target"): string[] {
  return patternHeader(patternOf(input), input.companyName ?? "", voice);
}

function partsOf(input: ExportInput, voice: "source" | "target") {
  return patternParts(patternOf(input), input.companyName ?? "", voice);
}

/** The blocks that make up the document body, i.e. everything after the header. */
function bodyOf(input: ExportInput): Block[] {
  return input.blocks.slice(patternOf(input).bodyStart).filter((b) => b.kind !== "page_break");
}

function indicatorLine(r: VerificationReport): string {
  const i = r.fidelityIndicator;
  return `${(i.value * 100).toFixed(1)}% (${i.grade.toUpperCase()})`;
}

/** Closing block carried by every export: indicator, certification status, disclaimer. */
function closingLines(r: VerificationReport): string[] {
  return [
    "=".repeat(78),
    `Automated quality indicator : ${indicatorLine(r)}`,
    "Certification status        : NOT CERTIFIED — human review required",
    "",
    DISCLAIMER,
    "",
    `Source SHA-256 : ${r.sourceSha256}`,
    `Generated      : ${r.generatedAt}`,
  ];
}

const DRAFT_NOTICE =
  "Machine-generated English draft — NOT CERTIFIED. Human review required before relying on it.";

const SEVERITY_MARK: Record<string, string> = {
  critical: "[CRITICAL]",
  major: "[MAJOR]",
  minor: "[MINOR]",
  info: "[INFO]",
};

// ── Plain text ───────────────────────────────────────────────────────────────

export function buildTextExport(input: ExportInput): string {
  const { blocks, report } = input;
  const out: string[] = [];

  // Address the report the way the source document is addressed: its own
  // letterhead and title, then "To, / The Manager, / <company>".
  const header = headerOf(input, "source");
  out.push(...header);
  if (header.length) {
    out.push("=".repeat(78));
  }

  out.push("VERIFICATION REPORT — GUJARATI → ENGLISH LEGAL TRANSLATION");
  out.push("=".repeat(78));
  out.push(`Source file          : ${input.fileName}`);
  out.push(`Document type        : ${report.docTypeLabel}`);
  out.push(`Pages                : ${report.pageCount}`);
  out.push(`Translation segments : ${report.segmentCount}`);
  out.push(`Translation provider : ${report.provider}`);
  out.push(`Source SHA-256       : ${report.sourceSha256}`);
  out.push(`Report generated     : ${report.generatedAt}`);
  out.push("");
  out.push(`Automated quality indicator : ${(report.fidelityIndicator.value * 100).toFixed(1)}% (${report.fidelityIndicator.grade.toUpperCase()})`);
  out.push(`Certification status        : NOT CERTIFIED — human review required`);
  out.push("");
  out.push(DISCLAIMER);
  out.push("");
  out.push("AUTOMATED CHECKS PERFORMED");
  out.push("-".repeat(78));
  for (const c of report.mechanicalChecks) {
    out.push(`[${c.passed ? "PASS" : "FLAG"}] ${c.check} (${c.count} item(s))`);
    out.push(`       ${c.description}`);
  }
  out.push("");

  if (report.findings.length > 0) {
    out.push(`FINDINGS (${report.findings.length})`);
    out.push("-".repeat(78));
    for (const f of report.findings) {
      out.push(`${SEVERITY_MARK[f.severity] ?? "[?]"} ${f.title}`);
      out.push(`  Location  : ${f.location}`);
      out.push(`  Check     : ${f.check}`);
      out.push(`  Detail    : ${f.detail}`);
      out.push(`  Action    : ${f.suggestion}`);
      if (f.sourceExcerpt) out.push(`  Gujarati  : ${f.sourceExcerpt}`);
      if (f.targetExcerpt) out.push(`  English   : ${f.targetExcerpt}`);
      out.push("");
    }
  } else {
    out.push("No findings were raised by the automated checks.");
    out.push("");
  }

  out.push("SIDE-BY-SIDE TRANSLATION");
  out.push("-".repeat(78));
  for (const b of blocks) {
    const blockFindings = input.findingsByBlock?.get(b.id) ?? [];
    out.push("");
    out.push(`[Page ${b.pageNumber} | ${b.kind} | ${b.id}]`);
    out.push(`GUJARATI: ${b.sourceText}`);
    out.push(`ENGLISH : ${b.targetText || "(no translation)"}`);
    if (blockFindings.length > 0) {
      out.push(`FINDINGS : ${blockFindings.map((f) => SEVERITY_MARK[f.severity] ?? "").filter(Boolean).join(" ")}`);
      for (const f of blockFindings) out.push(`  - ${f.title}`);
    }
  }

  out.push("");
  out.push("=".repeat(78));
  out.push("CERTIFICATION (to be completed by a qualified translator)");
  out.push("-".repeat(78));
  const hc = report.humanCertification;
  out.push(`Certified translator   : ${hc.certifierName || "____________________________"}`);
  out.push(`Qualifications         : ${hc.qualifications || "____________________________"}`);
  out.push(`Registration number    : ${hc.registrationNumber || "____________________________"}`);
  out.push(`Place                  : ${hc.place || "____________________________"}`);
  out.push(`Date                   : ${hc.date || "____________________________"}`);
  out.push(`Signature              : ${hc.signature || "____________________________"}`);
  out.push("");
  out.push(
    "Signature of this block indicates that the translator has compared this translation " +
      "against the original Gujarati document and accepts responsibility for its accuracy.",
  );
  out.push("");

  return out.join("\n");
}

// ── Clean translation ────────────────────────────────────────────────────────

/**
 * The final deliverable: the English document on its own paper.
 *
 * Structure is taken from the source — letterhead, date, report title, addressee
 * — so what comes out of the pipeline reads like the document it was given, not
 * like a tool's UI. The certification language moves to the foot, where a real
 * report carries its disclaimers.
 */
export function buildTranslationText(input: ExportInput): string {
  const out: string[] = [];

  out.push(...headerOf(input, "target"));
  if (out.length) out.push("");
  out.push(`--- ${DRAFT_NOTICE} ---`);
  out.push("");

  let lastRole: RenderRole | null = null;
  for (const b of bodyOf(input)) {
    const role = roleOf(b);
    const text = englishOf(b);
    if (!text.trim()) continue;

    if (role === "h1") {
      out.push("");
      out.push(text.toUpperCase());
      out.push("-".repeat(Math.min(78, Math.max(8, text.length))));
      out.push("");
    } else if (role === "h2") {
      out.push("");
      out.push(text);
      out.push("");
    } else {
      out.push(text);
      if (lastRole === "h2") out.push("");
    }
    lastRole = role;
  }

  out.push("");
  out.push(...closingLines(input.report));
  return out.join("\n");
}

// ── PDF ──────────────────────────────────────────────────────────────────────

/**
 * PDF export via pdfkit.
 *
 * Uses the built-in Helvetica rather than embedding a font because pdfkit cannot
 * render Gujarati without a complex-script font file that is not bundled here.
 * The Gujarati source column is therefore romanised in the PDF with a clear marker,
 * and the PDF always carries the source SHA-256 so the reviewer can confirm they
 * hold the same document. Silently dropping the Gujarati would be worse; this is
 * the compromise, and it is stated in the export itself.
 */
export async function buildPdfExport(input: ExportInput): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  ensureDirs();

  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: "Verification Report" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  const W = doc.page.width - 84;

  const header = partsOf(input, "source");
  if (header.length) {
    drawPatternHeader(doc, header, W);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor("#000")
      .stroke();
    doc.moveDown(0.6);
  }

  doc.font("Helvetica-Bold").fontSize(15).text("VERIFICATION REPORT", { align: "center" });
  doc.moveDown(0.2);
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor("#444")
    .text("Gujarati → English legal translation — automated verification and human review", { align: "center" });
  doc.moveDown(0.8);

  const meta: Array<[string, string]> = [
    ["Source file", input.fileName],
    ["Document type", input.report.docTypeLabel],
    ["Pages", String(input.report.pageCount)],
    ["Translation segments", String(input.report.segmentCount)],
    ["Translation provider", input.report.provider],
    ["Source SHA-256", input.report.sourceSha256],
    ["Report generated", input.report.generatedAt],
  ];
  for (const [k, v] of meta) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text(`${k}: `, { continued: true });
    doc.font("Helvetica").fillColor("#222").text(v);
  }

  doc.moveDown(0.6);
  const ind = input.report.fidelityIndicator;
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(ind.grade === "green" ? "#166534" : ind.grade === "yellow" ? "#92400e" : "#991b1b")
    .text(`Automated quality indicator: ${(ind.value * 100).toFixed(1)}% (${ind.grade.toUpperCase()}) — NOT CERTIFIED`, {
      align: "center",
    });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(8.5).fillColor("#444").text(ind.interpretation, { align: "center", width: W });
  doc.moveDown(0.5);
  doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#333").text(DISCLAIMER, { width: W, align: "center" });

  doc.addPage();
  sectionTitle(doc, "AUTOMATED CHECKS PERFORMED");
  for (const c of input.report.mechanicalChecks) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(c.passed ? "#166534" : "#991b1b").text(`${c.passed ? "PASS" : "FLAG"} — ${c.check} (${c.count})`);
    doc.font("Helvetica").fontSize(8.5).fillColor("#333").text(c.description, { width: W - 10 });
    doc.moveDown(0.35);
  }

  if (input.report.findings.length > 0) {
    doc.addPage();
    sectionTitle(doc, `FINDINGS (${input.report.findings.length})`);
    for (const f of input.report.findings) {
      if (doc.y > doc.page.height - 150) doc.addPage();
      const color = f.severity === "critical" ? "#991b1b" : f.severity === "major" ? "#92400e" : "#444";
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(color).text(`${f.severity.toUpperCase()} — ${f.title}`);
      doc.font("Helvetica").fontSize(8.5).fillColor("#333").text(`${f.location} · ${f.check}`, { width: W });
      doc.font("Helvetica").fontSize(8.5).fillColor("#111").text(f.detail, { width: W });
      doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#444").text(`Action: ${f.suggestion}`, { width: W });
      if (f.sourceExcerpt) {
        doc.font("Helvetica").fontSize(8).fillColor("#555").text(`Gujarati: ${romanise(f.sourceExcerpt)}`, { width: W });
      }
      if (f.targetExcerpt) {
        doc.font("Helvetica").fontSize(8).fillColor("#555").text(`English: ${f.targetExcerpt}`, { width: W });
      }
      doc.moveDown(0.6);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#e5e5e5").stroke();
      doc.moveDown(0.5);
    }
  }

  doc.addPage();
  sectionTitle(doc, "SIDE-BY-SIDE TRANSLATION");
  doc.font("Helvetica-Oblique").fontSize(8).fillColor("#666").text(
    "Gujarati source is romanised in this PDF because the embedded font does not support Gujarati script. " +
      "Confirm against the original using the SHA-256 above before relying on any block.",
    { width: W },
  );
  doc.moveDown(0.5);

  for (const b of input.blocks) {
    if (doc.y > doc.page.height - 140) doc.addPage();
    const bf = input.findingsByBlock?.get(b.id) ?? [];
    const hasFinding = bf.some((f) => f.severity === "critical" || f.severity === "major");

    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(hasFinding ? "#991b1b" : "#333")
      .text(`Page ${b.pageNumber} · ${b.kind.replace(/_/g, " ")}${hasFinding ? "  ⚑ findings" : ""}`);

    doc.font("Helvetica").fontSize(9).fillColor("#111").text(normalizeWhitespace(b.targetText || "(no translation)"), { width: W });
    doc.font("Helvetica").fontSize(7.5).fillColor("#777").text(`Gujarati: ${romanise(normalizeWhitespace(b.sourceText))}`, { width: W });
    doc.moveDown(0.6);
  }

  doc.addPage();
  sectionTitle(doc, "CERTIFICATION");
  doc.font("Helvetica").fontSize(8.5).fillColor("#444").text(
    "This block is to be completed and signed by a qualified legal translator who has compared this translation " +
      "against the original Gujarati document. Until it is signed, this document is an unverified machine draft.",
    { width: W },
  );
  doc.moveDown(1);
  for (const label of ["Certified translator", "Qualifications", "Registration number", "Place", "Date", "Signature"]) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000").text(`${label}:`);
    doc.moveDown(0.2).moveTo(200, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#999").stroke();
    doc.moveDown(0.7);
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor("#888")
      .text(`Page ${i + 1} of ${range.count}`, doc.page.width - 140, doc.page.height - 40, { width: 100, align: "right" });
    doc.text("Nyayadoot — AI translation, not certified", doc.page.margins.left, doc.page.height - 40, { width: 260, align: "left" });
  }

  doc.end();
  await new Promise<void>((resolve) => doc.on("end", resolve));
  return Buffer.concat(chunks);
}

/**
 * The clean translation as PDF: source masthead, translated body, certification
 * notice at the foot.
 */
export async function buildTranslationPdf(input: ExportInput): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  ensureDirs();

  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: "English Translation" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const W = doc.page.width - 84;

  const header = partsOf(input, "target");
  if (header.length) {
    drawPatternHeader(doc, header, W);
    doc.moveDown(0.3);
  }

  doc.font("Helvetica-Oblique").fontSize(8.5).fillColor("#991b1b").text(DRAFT_NOTICE, { align: "center", width: W });
  doc.moveDown(0.8);

  for (const b of bodyOf(input)) {
    const role = roleOf(b);
    const text = englishOf(b);
    if (!text.trim()) continue;
    if (doc.y > doc.page.height - 120) doc.addPage();

    if (role === "h1") {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#000").text(text.toUpperCase(), { width: W });
      doc
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .strokeColor("#000")
        .stroke();
      doc.moveDown(0.4);
    } else if (role === "h2") {
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000").text(text, { width: W });
      doc.moveDown(0.2);
    } else {
      doc.font("Helvetica").fontSize(10).fillColor("#111").text(text, { width: W, align: "justify" });
      doc.moveDown(0.35);
    }
  }

  doc.moveDown(0.8);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor("#000")
    .stroke();
  doc.moveDown(0.5);

  const ind = input.report.fidelityIndicator;
  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(ind.grade === "green" ? "#166534" : ind.grade === "yellow" ? "#92400e" : "#991b1b")
    .text(`Automated quality indicator: ${indicatorLine(input.report)} — NOT CERTIFIED`, { width: W });
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(8.5).fillColor("#333").text(DISCLAIMER, { width: W, align: "center" });
  doc.moveDown(0.25);
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#555")
    .text(`Source SHA-256: ${input.report.sourceSha256}   ·   Generated: ${input.report.generatedAt}`, { width: W });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor("#888")
      .text(`Page ${i + 1} of ${range.count}`, doc.page.width - 140, doc.page.height - 40, { width: 100, align: "right" });
    doc.text("Nyayadoot — AI translation, not certified", doc.page.margins.left, doc.page.height - 40, { width: 260, align: "left" });
  }

  doc.end();
  await new Promise<void>((resolve) => doc.on("end", resolve));
  return Buffer.concat(chunks);
}

/**
 * Draw the source document's own masthead: name in bold, contact lines beneath,
 * then the report title, then the addressee flush left — the same order a
 * printed legal report uses.
 */
function drawPatternHeader(doc: InstanceType<typeof PDFKitType>, parts: PatternPart[], W: number): void {
  let firstLetterhead = true;
  for (const p of parts) {
    if (p.kind === "letterhead") {
      doc
        .font(firstLetterhead ? "Helvetica-Bold" : "Helvetica")
        .fontSize(firstLetterhead ? 12 : 9)
        .fillColor("#000")
        .text(p.text, { align: "center", width: W });
      firstLetterhead = false;
    } else if (p.kind === "title") {
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(14).fillColor("#000").text(p.text.toUpperCase(), { align: "center", width: W });
      doc.moveDown(0.3);
    } else {
      doc.font("Helvetica").fontSize(10).fillColor("#111").text(p.text, { width: W });
    }
  }
  if (parts.length) doc.moveDown(0.6);
}

function sectionTitle(doc: InstanceType<typeof PDFKitType>, title: string): void {
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#000").text(title);
  doc.moveDown(0.2);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor("#000").stroke();
  doc.moveDown(0.6);
}

/**
 * Render Gujarati as readable Latin for the PDF/DOCX columns.
 *
 * Not a substitute for the original: the transliteration is approximate and is
 * labelled as such wherever it appears. It exists so a reviewer without the
 * Gujarati source in front of them can still follow which block is being discussed.
 */
function romanise(s: string): string {
  return transliterateGujarati(s) || s;
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

export async function buildDocxExport(input: ExportInput): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } =
    (await import("docx")) as typeof import("docx");

  ensureDirs();

  const ind = input.report.fidelityIndicator;
  // A docx body is a flat list of block-level items, so headings/paragraphs
  // share the array with tables; `File` accepts either.
  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];

  const masthead = partsOf(input, "source");
  masthead.forEach((p, i) => {
    if (p.kind === "letterhead") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: p.text, bold: i === 0, size: i === 0 ? 24 : 18 })],
        }),
      );
    } else if (p.kind === "title") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 160 },
          children: [new TextRun({ text: p.text.toUpperCase(), bold: true, size: 26 })],
        }),
      );
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: p.text, size: 20 })] }));
    }
  });
  if (masthead.length) {
    children.push(new Paragraph({ spacing: { before: 200, after: 120 }, children: [] }));
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: "Verification Report", bold: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "Gujarati → English legal translation — automated verification and human review", italics: true, size: 18 })],
    }),
  );

  const rows: Array<[string, string]> = [
    ["Source file", input.fileName],
    ["Document type", input.report.docTypeLabel],
    ["Pages", String(input.report.pageCount)],
    ["Translation segments", String(input.report.segmentCount)],
    ["Translation provider", input.report.provider],
    ["Source SHA-256", input.report.sourceSha256],
    ["Report generated", input.report.generatedAt],
    ["Automated quality indicator", `${(ind.value * 100).toFixed(1)}% (${ind.grade.toUpperCase()}) — NOT CERTIFIED`],
  ];

  children.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map(
        ([k, v]) =>
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: k, bold: true, size: 18 })] })], width: { size: 32, type: WidthType.PERCENTAGE } }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: v, size: 18 })] })] }),
            ],
          }),
      ),
    }),
  );

  children.push(
    new Paragraph({ children: [new TextRun({ text: DISCLAIMER, italics: true, size: 16, color: "666666" })] }),
  );

  children.push(new Paragraph({ text: "Automated checks performed", heading: HeadingLevel.HEADING_2 }));
  for (const c of input.report.mechanicalChecks) {
    children.push(
      new Paragraph({
        bullet: { level: 0 },
        children: [
          new TextRun({ text: `${c.passed ? "PASS" : "FLAG"} — ${c.check} (${c.count}): `, bold: true }),
          new TextRun({ text: c.description }),
        ],
      }),
    );
  }

  if (input.report.findings.length > 0) {
    children.push(new Paragraph({ text: `Findings (${input.report.findings.length})`, heading: HeadingLevel.HEADING_2 }));
    for (const f of input.report.findings) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `${f.severity.toUpperCase()} — ${f.title}`, bold: true })],
        }),
        new Paragraph({ children: [new TextRun({ text: `${f.location} · ${f.check}`, size: 16, color: "555555" })] }),
        new Paragraph({ children: [new TextRun({ text: f.detail })] }),
        new Paragraph({ children: [new TextRun({ text: `Action: ${f.suggestion}`, italics: true })] }),
        ...(f.sourceExcerpt ? [new Paragraph({ children: [new TextRun({ text: `Gujarati: ${f.sourceExcerpt}`, size: 16, color: "555555" })] })] : []),
        ...(f.targetExcerpt ? [new Paragraph({ children: [new TextRun({ text: `English: ${f.targetExcerpt}`, size: 16, color: "555555" })] })] : []),
      );
    }
  }

  children.push(
    new Paragraph({ text: "Side-by-side translation", heading: HeadingLevel.HEADING_2 }),
    new Paragraph({
      children: [
        new TextRun({
          text: "The Gujarati column is romanised because this document's font does not cover Gujarati script. Confirm against the original using the SHA-256 above.",
          italics: true,
          size: 16,
          color: "666666",
        }),
      ],
    }),
  );

  for (const b of input.blocks) {
    const bf = input.findingsByBlock?.get(b.id) ?? [];
    const flagged = bf.some((f) => f.severity === "critical" || f.severity === "major");
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `Page ${b.pageNumber} · ${b.kind.replace(/_/g, " ")}`, bold: true, size: 17, color: flagged ? "991B1B" : "333333" }),
          ...(flagged ? [new TextRun({ text: "  ⚑ findings", bold: true, size: 17, color: "991B1B" })] : []),
        ],
      }),
      new Paragraph({ children: [new TextRun({ text: b.targetText || "(no translation)" })] }),
      new Paragraph({ children: [new TextRun({ text: `Gujarati: ${romanise(normalizeWhitespace(b.sourceText))}`, size: 15, color: "777777" })] }),
    );
  }

  children.push(
    new Paragraph({ text: "Certification", heading: HeadingLevel.HEADING_2 }),
    new Paragraph({
      children: [
        new TextRun({
          text: "To be completed and signed by a qualified legal translator who has compared this translation against the original Gujarati document. Until signed, this is an unverified machine draft.",
          italics: true,
          size: 16,
          color: "666666",
        }),
      ],
    }),
  );
  for (const label of ["Certified translator", "Qualifications", "Registration number", "Place", "Date", "Signature"]) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${label}: `, bold: true }),
          new TextRun({ text: "______________________________________________", color: "999999" }),
        ],
      }),
    );
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

/**
 * The clean translation as DOCX: source masthead, translated body styled with
 * real heading levels, certification notice at the foot.
 */
export async function buildTranslationDocx(input: ExportInput): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } =
    (await import("docx")) as typeof import("docx");

  ensureDirs();

  const children: Array<InstanceType<typeof Paragraph>> = [];

  const masthead = partsOf(input, "target");
  masthead.forEach((p, i) => {
    if (p.kind === "letterhead") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: p.text, bold: i === 0, size: i === 0 ? 24 : 18 })],
        }),
      );
    } else if (p.kind === "title") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 160 },
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: p.text.toUpperCase(), bold: true })],
        }),
      );
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: p.text, size: 20 })] }));
    }
  });
  if (masthead.length) children.push(new Paragraph({ spacing: { before: 160 }, children: [] }));

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: DRAFT_NOTICE, italics: true, color: "991B1B", size: 17 })],
    }),
    new Paragraph({ children: [] }),
  );

  for (const b of bodyOf(input)) {
    const text = englishOf(b);
    if (!text.trim()) continue;
    const role = roleOf(b);
    if (role === "h1") {
      children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 240 } }));
    } else if (role === "h2") {
      children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 180 } }));
    } else {
      children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text })] }));
    }
  }

  const ind = input.report.fidelityIndicator;
  const band = ind.grade === "green" ? "166534" : ind.grade === "yellow" ? "92400E" : "991B1B";
  children.push(
    new Paragraph({
      spacing: { before: 360 },
      children: [new TextRun({ text: `Automated quality indicator: ${indicatorLine(input.report)} — NOT CERTIFIED`, bold: true, color: band })],
    }),
    new Paragraph({ children: [new TextRun({ text: DISCLAIMER, italics: true, size: 16, color: "666666" })] }),
    new Paragraph({
      children: [new TextRun({ text: `Source SHA-256: ${input.report.sourceSha256}   ·   Generated: ${input.report.generatedAt}`, size: 15, color: "555555" })],
    }),
  );

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type ExportFormat = "pdf" | "docx" | "txt";

const SUFFIX: Record<ExportKind, string> = {
  verification: "verification-report",
  translation: "english-translation",
};

export async function exportDocument(
  input: ExportInput,
  format: ExportFormat,
  kind: ExportKind = "verification",
): Promise<{ path: string; bytes: number }> {
  ensureDirs();
  const base = safeName(input.docId);

  const suffix = SUFFIX[kind];
  const wantsTranslation = kind === "translation";

  if (format === "txt") {
    const p = path.join(config.exportDir, `${base}-${suffix}.txt`);
    fs.writeFileSync(p, wantsTranslation ? buildTranslationText(input) : buildTextExport(input), "utf8");
    return { path: p, bytes: fs.statSync(p).size };
  }

  if (format === "pdf") {
    const buf = wantsTranslation ? await buildTranslationPdf(input) : await buildPdfExport(input);
    const p = path.join(config.exportDir, `${base}-${suffix}.pdf`);
    fs.writeFileSync(p, buf);
    return { path: p, bytes: buf.length };
  }

  const buf = wantsTranslation ? await buildTranslationDocx(input) : await buildDocxExport(input);
  const p = path.join(config.exportDir, `${base}-${suffix}.docx`);
  fs.writeFileSync(p, buf);
  return { path: p, bytes: buf.length };
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}
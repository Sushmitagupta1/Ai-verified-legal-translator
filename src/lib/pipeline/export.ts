import fs from "node:fs";
import path from "node:path";
import type PDFKitType from "pdfkit";
import { config, ensureDirs } from "../config";
import { DISCLAIMER } from "../domain/glossary";
import { normalizeWhitespace } from "../domain/gujarati";
import { detectReportPattern, patternHeader, patternParts, type PatternPart, type ReportPattern } from "../domain/letterhead";
import type { Block, Finding } from "../domain";
import type { VerificationReport } from "./report";
import { extractTcr, type TcrItem } from "./tcr";
import { buildTcrReportItems } from "./tcrReport";
import type { IBordersOptions } from "docx";

export interface ExportInput {
  docId: string;
  fileName: string;
  blocks: Block[];
  /**
   * The verification report. Null while a run is still verifying: the Word
   * translation is finished and downloadable before the report exists, and the
   * deliverable must not wait for the audit.
   */
  report: VerificationReport | null;
  /** Findings keyed by block id for inline annotation. */
  findingsByBlock?: Map<string, Finding[]>;
  /**
   * Resolved company/addressee name the report is addressed to. Supplied by the
   * operator at upload or detected from the document; see `resolveCompanyName`.
   */
  companyName?: string;
}

/** Report-backed exports cannot be built before verification finishes. */
function requireReport(input: ExportInput): VerificationReport {
  if (!input.report) {
    throw new Error("The verification report is not ready yet. Wait for the run to finish, then download again.");
  }
  return input.report;
}

/** Which document is being produced: the review report, the clean translation, or the Title Clearance Report. */
export type ExportKind = "verification" | "translation";

type RenderRole = "h1" | "h2" | "p";

function roleOf(b: Block): RenderRole {
  if (b.kind === "document_title" || b.kind === "heading_1") return "h1";
  if (b.kind === "heading_2" || b.kind === "heading_3" || b.kind === "table_header") return "h2";
  return "p";
}

/**
 * English body text.
 *
 * An untranslated block must never drop its Gujarati source into the English
 * deliverable. Doing that put OCR garble from a rotated stamp page straight into
 * the document a reviewer hands to a client. Point at the source page and the
 * report instead: the reviewer can read the original there, and the report
 * already lists the block as a coverage finding.
 */
function englishOf(b: Block): string {
  const target = normalizeWhitespace(b.targetText ?? "");
  if (target) return target;
  return `[No English was produced for this passage — check page ${b.pageNumber} of the source against the verification report.]`;
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
function closingLines(r: VerificationReport | null): string[] {
  const lines = ["=".repeat(78)];
  if (r) {
    lines.push(`Automated quality indicator : ${indicatorLine(r)}`);
  } else {
    lines.push("Automated quality indicator : not yet available (verification still running)");
  }
  if (r) {
    lines.push(`Report status               : ${reportStatusLine(r)}`);
  }
  lines.push("Certification status        : NOT CERTIFIED — human review required", "", DISCLAIMER);
  if (r) {
    lines.push("", `Source SHA-256 : ${r.sourceSha256}`, `Generated      : ${r.generatedAt}`);
  }
  return lines;
}

const DRAFT_NOTICE =
  "Machine-generated English draft — NOT CERTIFIED. Human review required before relying on it.";

/** One line that keeps a draft from being read as a finished audit. */
function reportStatusLine(report: VerificationReport): string {
  const status = report.status ?? "final";
  const audit = report.semanticAudit ?? "not recorded";
  return `${status} · meaning-level review ${audit}`;
}

// ── Plain text ───────────────────────────────────────────────────────────────

/**
 * The audit report, rendered as the advocate's title-clearance report.
 *
 * The numbered legal sections, the certificate and the signature block follow
 * the report pattern a bank receives from an advocate. The automated
 * verification is folded into that structure: each finding is attached to the
 * paragraph it affects, the adverse remarks sit in paragraph 18, and the full
 * register is annexed so nothing the machine found is lost.
 */
export function buildTextExport(input: ExportInput): string {
  return renderTcrText(reportItems(input));
}

function reportItems(input: ExportInput): TcrItem[] {
  const report = requireReport(input);
  const generated = new Date(report.generatedAt);
  return buildTcrReportItems({
    data: extractTcr(input.blocks, input.companyName ?? ""),
    report,
    blocks: input.blocks,
    companyName: input.companyName,
    generatedAt: Number.isNaN(generated.getTime()) ? new Date() : generated,
  });
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
  return renderTcrPdf(reportItems(input), "Title Clearance Report");
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

  if (input.report) {
    const ind = input.report.fidelityIndicator;
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(ind.grade === "green" ? "#166534" : ind.grade === "yellow" ? "#92400e" : "#991b1b")
      .text(`Automated quality indicator: ${indicatorLine(input.report)} — NOT CERTIFIED`, { width: W });
    doc.moveDown(0.25);
  }
  doc.font("Helvetica").fontSize(8.5).fillColor("#333").text(DISCLAIMER, { width: W, align: "center" });
  doc.moveDown(0.25);
  if (input.report) {
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#555")
      .text(`Source SHA-256: ${input.report.sourceSha256}   ·   Generated: ${input.report.generatedAt}`, { width: W });
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

// ── DOCX ─────────────────────────────────────────────────────────────────────

export async function buildDocxExport(input: ExportInput): Promise<Buffer> {
  return renderTcrDocx(reportItems(input));
}

/**
 * The clean translation as DOCX: source masthead, translated body styled with
 * real heading levels, certification notice at the foot.
 */
export async function buildTranslationDocx(input: ExportInput): Promise<Buffer> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Header,
    Footer,
    PageNumber,
    PageBreak,
    BorderStyle,
  } = (await import("docx")) as typeof import("docx");

  ensureDirs();

  const children: Array<InstanceType<typeof Paragraph>> = [];
  const report = input.report;
  const title = partsOf(input, "target").find((p) => p.kind === "title")?.text
    ?? partsOf(input, "target").find((p) => p.kind === "letterhead")?.text
    ?? input.fileName.replace(/\.[^.]+$/, "");
  const sourceBase = input.fileName.replace(/\.[^.]+$/, "");
  const issued = report?.generatedAt ?? new Date().toISOString();

  const coverRule = (): InstanceType<typeof Paragraph> =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 120 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "1f3d33" } },
      children: [new TextRun({ text: "", size: 2 })],
    });

  // ── Cover ────────────────────────────────────────────────────────────────
  // A legal translation is handed over as a document, not as loose pages. The
  // cover carries the names and the non-certification notice so the reader
  // cannot mistake the file for a certified translation.
  children.push(
    new Paragraph({ spacing: { before: 1500 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: (input.companyName?.trim() || sourceBase).toUpperCase(),
          bold: true,
          size: 22,
          color: "1f3d33",
          font: "Georgia",
        }),
      ],
    }),
    coverRule(),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 220, after: 80 },
      children: [
        new TextRun({ text: "ENGLISH TRANSLATION", bold: true, size: 44, color: "14261f", font: "Georgia" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 260 },
      children: [new TextRun({ text: title, size: 26, color: "334155", font: "Georgia", italics: true })],
    }),
    coverRule(),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [
        new TextRun({ text: `Source file  ·  ${input.fileName}`, size: 19, color: "475569", font: "Georgia" }),
      ],
    }),
    report
      ? new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: `${report.docTypeLabel}  ·  ${report.pageCount} page(s)  ·  ${report.segmentCount} segment(s)`,
              size: 19,
              color: "475569",
              font: "Georgia",
            }),
          ],
        })
      : new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `${input.blocks.length} block(s)`, size: 19, color: "475569", font: "Georgia" })],
        }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Issued ${new Date(issued).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`,
          size: 19,
          color: "475569",
          font: "Georgia",
        }),
      ],
    }),
    new Paragraph({ spacing: { before: 900 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: "WORKING TRANSLATION — NOT CERTIFIED", bold: true, size: 18, color: "991B1B", font: "Georgia" }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 60 },
      children: [
        new TextRun({
          text: "Machine-generated draft for professional review. Not a certified or court-certified translation.",
          size: 16,
          color: "7f1d1d",
          italics: true,
          font: "Georgia",
        }),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // ── Masthead from the source document ────────────────────────────────────
  const masthead = partsOf(input, "target");
  masthead.forEach((p, i) => {
    if (p.kind === "letterhead") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: p.text, bold: i === 0, size: i === 0 ? 24 : 18, font: "Georgia", color: "1f2937" })],
        }),
      );
    } else if (p.kind === "title") {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 120 },
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: p.text.toUpperCase(), bold: true, font: "Georgia", color: "14261f", size: 30 })],
        }),
      );
    } else {
      children.push(new Paragraph({ children: [new TextRun({ text: p.text, size: 20, font: "Georgia" })] }));
    }
  });
  if (masthead.length) {
    children.push(
      new Paragraph({
        spacing: { before: 140, after: 220 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" } },
        children: [new TextRun({ text: "", size: 2 })],
      }),
    );
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  for (const b of bodyOf(input)) {
    const text = englishOf(b);
    if (!text.trim()) continue;
    const role = roleOf(b);
    if (role === "h1") {
      children.push(
        new Paragraph({
          spacing: { before: 280, after: 120 },
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text, bold: true, font: "Georgia", color: "14261f", size: 28 })],
        }),
      );
    } else if (role === "h2") {
      children.push(
        new Paragraph({
          spacing: { before: 200, after: 80 },
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text, bold: true, font: "Georgia", color: "1f3d33", size: 24 })],
        }),
      );
    } else {
      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 140, line: 300 },
          children: [new TextRun({ text, font: "Georgia", size: 22 })],
        }),
      );
    }
  }

  // ── Closing block ────────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      spacing: { before: 380 },
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: "1f3d33" } },
      children: [new TextRun({ text: "", size: 2 })],
    }),
    new Paragraph({
      spacing: { before: 120 },
      children: [
        new TextRun({
          text: "About this translation",
          bold: true,
          size: 20,
          font: "Georgia",
          color: "14261f",
        }),
      ],
    }),
  );

  if (report) {
    const ind = report.fidelityIndicator;
    const band = ind.grade === "green" ? "166534" : ind.grade === "yellow" ? "92400E" : "991B1B";
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Automated quality indicator: ${indicatorLine(report)} — NOT CERTIFIED`,
            bold: true,
            color: band,
            size: 18,
            font: "Georgia",
          }),
        ],
      }),
      new Paragraph({
        spacing: { after: 80 },
        children: [
          new TextRun({
            text: `Reviewed as: ${report.status ?? "final"}  ·  Semantic audit: ${report.semanticAudit ?? "see report"}  ·  Provider: ${report.provider}`,
            size: 16,
            color: "475569",
            font: "Georgia",
          }),
        ],
      }),
    );
  } else {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "Automated quality indicator: not yet available — verification is still running.",
            size: 18,
            color: "92400E",
            font: "Georgia",
          }),
        ],
      }),
    );
  }

  children.push(
    new Paragraph({
      spacing: { before: 80 },
      children: [new TextRun({ text: DISCLAIMER, italics: true, size: 16, color: "475569", font: "Georgia" })],
    }),
  );
  if (report) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Source SHA-256: ${report.sourceSha256}   ·   Generated: ${report.generatedAt}`,
            size: 14,
            color: "64748b",
            font: "Consolas",
          }),
        ],
      }),
    );
  }

  const headerName = (input.companyName?.trim() || sourceBase).slice(0, 90);
  const doc = new Document({
    creator: "Nyayadoot",
    title: `${sourceBase} — English translation`,
    description: "Machine-generated English translation for professional review. Not certified.",
    styles: {
      default: {
        document: {
          run: { font: "Georgia", size: 22, color: "111827" },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1247, right: 1418, bottom: 1247, left: 1418, header: 708, footer: 708 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "cbd5e1" } },
                children: [
                  new TextRun({ text: headerName, size: 16, color: "64748b", font: "Georgia" }),
                  new TextRun({ text: "\t\tEnglish translation — working draft", size: 16, color: "94a3b8", font: "Georgia" }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: "e2e8f0" } },
                children: [
                  new TextRun({
                    text: "Not certified — review against the Gujarati original before use.",
                    size: 14,
                    color: "94a3b8",
                    font: "Georgia",
                  }),
                  new TextRun({ text: "\t\tPage ", size: 14, color: "64748b", font: "Georgia" }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 14, color: "64748b", font: "Georgia" }),
                  new TextRun({ text: " of ", size: 14, color: "64748b", font: "Georgia" }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: "64748b", font: "Georgia" }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ── Title Clearance Report renderers ────────────────────────────────────────

type TcrAlign = NonNullable<Extract<TcrItem, { t: "p" }>["align"]>;

function tcrAlignment(a?: TcrAlign): "left" | "center" | "right" | "justify" {
  return a ?? "left";
}

/** Render the report model as plain text (the .txt export). */
function renderTcrText(items: TcrItem[]): string {
  const out: string[] = [];
  for (const it of items) {
    switch (it.t) {
      case "page":
        out.push("\f");
        break;
      case "h1":
        out.push("", it.text, "=".repeat(Math.max(8, Math.min(78, it.text.length))), "");
        break;
      case "h2":
        out.push("", it.text, "");
        break;
      case "p":
        out.push(it.text.replace(/\t/g, "  "));
        break;
      case "bullets":
        for (const b of it.items) out.push("•  " + b);
        out.push("");
        break;
      case "borders":
        for (const [k, v] of it.rows) out.push(`${k}\t:\t${v}`);
        out.push("");
        break;
      case "table": {
        out.push(it.header.join("  |  "));
        out.push("-".repeat(78));
        for (const row of it.rows) out.push(row.join("  |  "));
        out.push("");
        break;
      }
      case "sig":
        break;
    }
  }
  return out.join("\n");
}

/** Render the report model as PDF. */
async function renderTcrPdf(items: TcrItem[], title: string): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  ensureDirs();

  const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: title } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  const W = doc.page.width - 84;

  for (const it of items) {
    const align = it.t === "p" ? tcrAlignment(it.align) : "left";
    switch (it.t) {
      case "page":
        doc.addPage();
        break;
      case "h1":
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(0.6);
        doc.font("Helvetica-Bold").fontSize(15).text(it.text, { align: "center", width: W });
        doc.moveDown(0.7);
        break;
      case "h2":
        if (doc.y > doc.page.height - 140) doc.addPage();
        doc.moveDown(0.45);
        doc.font("Helvetica-Bold").fontSize(10.5).fillColor("#000").text(it.text, { width: W });
        doc.moveDown(0.25);
        break;
      case "p": {
        if (doc.y > doc.page.height - 110) doc.addPage();
        const t = it.text.replace(/\t/g, "      ");
        const size = it.size ? it.size / 2 : it.italic ? 8.5 : it.bold ? 9.5 : 10;
        doc
          .font(it.bold ? "Helvetica-Bold" : it.italic ? "Helvetica-Oblique" : "Helvetica")
          .fontSize(size)
          .fillColor("#000")
          .text(t, { width: W, align });
        doc.moveDown(0.2);
        break;
      }
      case "bullets":
        if (doc.y > doc.page.height - 160) doc.addPage();
        for (const b of it.items) {
          if (doc.y > doc.page.height - 110) doc.addPage();
          doc.font("Helvetica").fontSize(9.5).fillColor("#111").text("•  " + b, { width: W - 24, indent: 12 });
          doc.moveDown(0.2);
        }
        doc.moveDown(0.4);
        break;
      case "borders":
        if (doc.y > doc.page.height - 160) doc.addPage();
        for (const [k, v] of it.rows) {
          doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111").text(`${k}:  `, { continued: true });
          doc.font("Helvetica").text(v, { width: W - 90 });
          doc.moveDown(0.15);
        }
        doc.moveDown(0.4);
        break;
      case "table": {
        if (doc.y > doc.page.height - 200) doc.addPage();
        drawTcrTable(doc, it.header, it.rows);
        doc.moveDown(0.6);
        break;
      }
      case "sig":
        break;
    }
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

function drawTcrTable(
  doc: InstanceType<typeof PDFKitType>,
  header: string[],
  rows: Array<string[] & { length: number }>,
): void {
  const W = doc.page.width - 84;
  const x0 = doc.page.margins.left;
  // First column (check / label) gets more room; the rest share what is left.
  const weights = header.map((_, i) => (i === 0 ? 1.5 : i === 2 && header.length > 3 ? 0.7 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.floor((W * w) / total));
  const pad = 3;

  const drawRow = (cells: string[], opts: { bold: boolean }): void => {
    const heights = cells.map((c, i) => doc.heightOfString(c, { width: widths[i] - pad * 2 }));
    const rowH = Math.max(...heights) + pad * 2;
    if (doc.y + rowH > doc.page.height - 60) doc.addPage();
    const top = doc.y;
    for (let i = 0; i < cells.length; i++) {
      const cx = x0 + widths.slice(0, i).reduce((a, b) => a + b, 0);
      doc.rect(cx, top, widths[i], rowH).stroke();
      const cx2 = cx + widths[i] - pad * 2;
      doc
        .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(8)
        .fillColor("#000")
        .text(cells[i], cx + pad, top + pad, { width: cx2 - cx, align: "left" });
    }
    doc.y = top + rowH;
  };

  drawRow(header, { bold: true });
  for (const row of rows) drawRow(row, { bold: false });
}

/** Render the report model as DOCX on the advocate's letterhead stock. */
async function renderTcrDocx(items: TcrItem[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } =
    (await import("docx")) as typeof import("docx");

  ensureDirs();

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];

  type DocxAlign = (typeof AlignmentType)[keyof typeof AlignmentType];

  const alignOf = (a?: TcrAlign): DocxAlign => {
    switch (a) {
      case "center":
        return AlignmentType.CENTER;
      case "right":
        return AlignmentType.RIGHT;
      case "justify":
        return AlignmentType.JUSTIFIED;
      default:
        return AlignmentType.LEFT;
    }
  };

  const cellBorders = (): IBordersOptions => ({
    top: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  });

  const cell = (text: string, opts: { bold?: boolean; italic?: boolean } = {}): InstanceType<typeof TableCell> =>
    new TableCell({
      borders: cellBorders(),
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: 17 })],
        }),
      ],
    });

  for (const it of items) {
    switch (it.t) {
      case "page":
        children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
        break;
      case "h1":
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 200 },
            children: [new TextRun({ text: it.text, bold: true, size: 32 })],
          }),
        );
        break;
      case "h2":
        children.push(
          new Paragraph({
            spacing: { before: 220, after: 80 },
            children: [new TextRun({ text: it.text, bold: true, size: 22 })],
          }),
        );
        break;
      case "p": {
        const t = it.text.replace(/\t/g, "      ");
        children.push(
          new Paragraph({
            alignment: alignOf(it.align),
            spacing: { after: 80, line: 300 },
            children: [new TextRun({ text: t, bold: it.bold, italics: it.italic, size: it.size ?? 20 })],
          }),
        );
        break;
      }
      case "bullets":
        for (const b of it.items) {
          children.push(
            new Paragraph({
              bullet: { level: 0 },
              alignment: AlignmentType.JUSTIFIED,
              spacing: { after: 60, line: 300 },
              children: [new TextRun({ text: b, size: 19 })],
            }),
          );
        }
        children.push(new Paragraph({ children: [] }));
        break;
      case "borders":
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: it.rows.map(
              ([k, v]) =>
                new TableRow({
                  children: [
                    cell(k, { bold: true }),
                    new TableCell({
                      borders: cellBorders(),
                      margins: { top: 80, bottom: 80, left: 100, right: 100 },
                      children: [new Paragraph({ children: [new TextRun({ text: v, size: 18 })] })],
                    }),
                  ],
                }),
            ),
          }),
        );
        children.push(new Paragraph({ children: [] }));
        break;
      case "table":
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({ tableHeader: true, children: it.header.map((h) => cell(h, { bold: true })) }),
              ...it.rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
            ],
          }),
        );
        children.push(new Paragraph({ children: [] }));
        break;
      case "sig":
        break;
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Bookman Old Style", size: 20 },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11907, height: 16839 },
            margin: { top: 993, right: 1134, bottom: 1560, left: 1440, header: 720, footer: 720 },
          },
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export type ExportFormat = "pdf" | "docx" | "txt";

const SUFFIX: Record<ExportKind, string> = {
  verification: "title-clearance-report",
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
    const body = wantsTranslation ? buildTranslationText(input) : buildTextExport(input);
    fs.writeFileSync(p, body, "utf8");
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
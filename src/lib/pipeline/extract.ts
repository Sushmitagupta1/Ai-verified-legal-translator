import {
  detectDocType,
  preflightDocument,
  type DocumentPreflight,
  type TypeDetection,
} from "../domain/classify";
import { config } from "../config";
import { normalizeWhitespace } from "../domain/gujarati";
import { lookupGlossary } from "../domain/glossary";
import type { Block, BlockKind } from "../domain";
import { BACKEND } from "./backends";

export interface PageText {
  pageNumber: number;
  kind: "text" | "scanned" | "mixed" | "empty";
  text: string;
  /** Mean OCR confidence in [0,1]; null when the page had an embedded text layer. */
  confidence: number | null;
  engine: string | null;
  warnings: string[];
  /** Set by `attachFooterDetection` so page numbers never reach translation. */
  footerMatch?: RegExp | null;
}

export interface ExtractResult {
  pages: PageText[];
  pageCount: number;
  kind: "pdf" | "image" | "docx" | "text";
  hasEmbeddedText: boolean;
  meanOcrConfidence: number | null;
  warnings: string[];
}

/**
 * Extract text from an uploaded file.
 *
 * The critical branch is scanned-vs-digital. A scanned PDF with a thin text layer
 * (many court PDFs have a 1-character-per-page ghost layer) is the classic trap:
 * the PDF "has text" so we skip OCR, then the translation is built on garbage.
 * Hence the `minCharsPerPage` threshold rather than a boolean has-text check.
 */
export async function extractFromBuffer(
  buffer: Buffer,
  fileName: string,
  mime: string,
): Promise<ExtractResult> {
  const lower = fileName.toLowerCase();
  const warnings: string[] = [];

  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    return extractPdf(buffer, warnings);
  }
  if (mime.startsWith("image/") || /\.(png|jpe?g|tiff?|bmp|webp)$/.test(lower)) {
    const ocr = await BACKEND.ocr.ocrImage(buffer, mime);
    warnings.push(...ocr.warnings);
    return {
      pages: [
        {
          pageNumber: 1,
          kind: "scanned",
          text: ocr.text,
          confidence: ocr.confidence,
          engine: ocr.engine,
          warnings: ocr.warnings,
        },
      ],
      pageCount: 1,
      kind: "image",
      hasEmbeddedText: false,
      meanOcrConfidence: ocr.confidence,
      warnings,
    };
  }
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    /\.(docx?|rtf)$/.test(lower)
  ) {
    return extractDocx(buffer, warnings);
  }
  if (mime.startsWith("text/") || /\.txt$/i.test(lower)) {
    const text = normalizeWhitespace(buffer.toString("utf8"));
    return {
      pages: [{ pageNumber: 1, kind: "text", text, confidence: null, engine: null, warnings: [] }],
      pageCount: 1,
      kind: "text",
      hasEmbeddedText: true,
      meanOcrConfidence: null,
      warnings,
    };
  }

  throw new Error(
    `Unsupported file type "${mime || "unknown"}". Upload a PDF, DOC/DOCX, image (JPG/PNG/TIFF), or plain text.`,
  );
}

const MIN_CHARS_PER_PAGE = 120;

/**
 * Minimal structural view of the pdfjs legacy build.
 *
 * pdfjs ships untyped `.mjs` with no declarations, and its surface has moved
 * between releases; a narrow local shape keeps the compile honest about the
 * handful of members actually used here.
 */
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>;
  /** Frees the operator list after OCR; absent in some pdfjs builds. */
  cleanup?(): void;
}

async function extractPdf(buffer: Buffer, warnings: string[]): Promise<ExtractResult> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc> };
  };

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;

  const pages: PageText[] = [];
  let textPages = 0;
  let ocrPages = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if ("hasEOL" in item && item.hasEOL) text += "\n";
      else text += " ";
    }
    text = normalizeWhitespace(text);

    // A real Gujarati/Hindi document yields far more than 120 characters per
    // page. Below that, the text layer is decoration (a scan's ghost layer).
    if (text.length >= MIN_CHARS_PER_PAGE) {
      textPages++;
      pages.push({
        pageNumber: p,
        kind: "text",
        text,
        confidence: null,
        engine: null,
        warnings: [],
      });
    } else {
      const pageWarnings: string[] = [];
      if (text.length > 0) {
        pageWarnings.push(
          `Page ${p} has only ${text.length} embedded characters, which is below the ${MIN_CHARS_PER_PAGE}-character threshold. Treated as a scanned page.`,
        );
      }
      const rendered = await BACKEND.pdf.renderPageToImage(buffer, p, config.ocr.renderDpi);
      const ocr = await BACKEND.ocr.ocrImage(rendered, "image/png");
      ocrPages++;
      pages.push({
        pageNumber: p,
        kind: "scanned",
        text: ocr.text,
        confidence: ocr.confidence,
        engine: ocr.engine,
        warnings: [...pageWarnings, ...ocr.warnings],
      });
    }

    page.cleanup?.();
  }

  await doc.destroy();

  if (ocrPages > 0) {
    warnings.push(
      `${ocrPages} of ${doc.numPages} page(s) were scanned images requiring OCR. OCR output can contain errors that propagate into the translation.`,
    );
  }

  const confidences = pages.map((p) => p.confidence).filter((c): c is number => c !== null);
  const meanOcrConfidence =
    confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;

  return {
    pages,
    pageCount: doc.numPages,
    kind: "pdf",
    hasEmbeddedText: textPages > 0,
    meanOcrConfidence,
    warnings,
  };
}

async function extractDocx(buffer: Buffer, warnings: string[]): Promise<ExtractResult> {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml({ buffer });

  if (result.messages.length > 0) {
    warnings.push(
      `DOCX conversion reported ${result.messages.length} formatting note(s). Table and heading fidelity may be reduced.`,
    );
  }

  const blocks: string[] = [];
  const pageBreakIdx: number[] = [];
  const tokens = result.value.split(/(<\/?(?:p|h[1-6]|tr|table|br)\b[^>]*>)/gi);

  for (const t of tokens) {
    if (/^<br\s*\/?>$/i.test(t)) continue;
    const isBreak = /^<p[^>]*page-break-before:\s*always/i.test(t) || /pagebreakbefore/i.test(t);
    if (isBreak) {
      pageBreakIdx.push(blocks.length);
      continue;
    }
    if (/^<\//.test(t) || /^<[a-z]/i.test(t)) continue;
    const text = normalizeWhitespace(
      t
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"'),
    );
    if (text) blocks.push(text);
  }

  const joined = blocks.join("\n\n");
  const approxPages = Math.max(1, Math.ceil(joined.length / 1800));
  const perPage = Math.ceil(blocks.length / approxPages);
  const pages: PageText[] = [];
  for (let i = 0; i < approxPages; i++) {
    const slice = blocks.slice(i * perPage, (i + 1) * perPage);
    pages.push({
      pageNumber: i + 1,
      kind: "text",
      text: slice.join("\n\n"),
      confidence: null,
      engine: null,
      warnings: [],
    });
  }

  return {
    pages,
    pageCount: pages.length,
    kind: "docx",
    hasEmbeddedText: true,
    meanOcrConfidence: null,
    warnings,
  };
}

// ── Structure detection ───────────────────────────────────────────────────────

const HEADING_MARKERS = [
  { re: /^(?:નિર્ણય|આદેશ|આદેશસૂચિ|જાહેર સૂચના|સલામ|નમસ્કાર|વિગત|અરજી)\s*$/, kind: "heading_1" as BlockKind },
  { re: /^(?:vakalatnama|वकीलनामा|હવેલી|વકાલતનામું)$/i, kind: "heading_1" as BlockKind },
  { re: /^(?:SCC OnLine|S\.C\.C\.|AIR |\d+\s+SCC|\d+\s+AIR)\s/i, kind: "case_number" as BlockKind },
];

const COURT_NAME_RE =
  /(?:સર્વોચ્ચ\s+ન્યાયાલય|ઉચ્ચ\s+ન્યાયાલય|જિલ્લા\s+ન્યાયાલય|તાલુકા\s+ન્યાયાલય|કોર્ટ|ન્યાયાલય|ફોરમ)\b/;

const CASE_NO_RE = /\b(?:CRL\.?\s*A\.?|CRA|R\.?\s*A\.?|C\.?\s?R\.?|C\.?\s?O\.?|S\.?\s?C\.?C\.?|O\.?\s?X?I{1,3})\s*(?:No\.?)?\s*\d+(?:\/\d{4})?/i;

/** Leading clause label, e.g. "12.", "12.1", "12)", "(3)", "iv." */
const CLAUSE_LABEL_RE = /^\s*(\(?\d{1,3}(?:\.\d{1,3}){0,4}[.)]?|\(?[a-z]\)|\([ivx]+\)|[ivx]+\.)\s+/i;

const SIGNATURE_RE =
  /(?:\(sd\/f\)|\bSD\/F\b|સહી\/સત્યકર|સહી|નોટરી|નોટરાઈઝ|સાધીનિ?\s*ધારના|સાધી|ખાસ\s*કામગીરી|\bDictated\b|\bTranscribed\b|\bCorrect\b|\bJUDGE\b|\bMember\s+Secretary\b|કલેક્ટર)/i;

const SEAL_RE = /(?:court seal|ન્યાયાલય\s*છાપ|સિક્કા|છાપ|\(seal\)|\bstamp\b)/i;

const CITATION_RE = /\b(?:Section|Article|Order|Rule|Schedule|Chapter|Part)\s+\d+|\b\d{1,3}\s+SCC\b|\b\d{1,3}\s+SCR\b|\bAIR\s+\d{4}\s+\w+/;

const QUOTE_RE = /^["“'']|[,:;.!?]["“'']$/;

/**
 * Turn a page of text into ordered blocks.
 *
 * Structure detection from plain text is inherently heuristic. The rules below
 * are ordered by confidence and every block records the visual cues used, so a
 * reviewer can see *why* something was labelled a heading. Where the pipeline has
 * real PDF layout metrics it overrides the size-based heuristics.
 */
export function detectStructure(
  pages: PageText[],
  opts: { sourceFromOcr?: boolean } = {},
): Block[] {
  const blocks: Block[] = [];
  let ordinal = 0;

  for (const page of pages) {
    if (page.text.trim().length === 0) continue;

    const rawLines = page.text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (rawLines.length === 0) continue;

    // A page arriving as one paragraph with embedded newlines needs splitting.
    const lines = expandDenseParagraph(rawLines);
    const avgLen = lines.reduce((a, l) => a + l.length, 0) / lines.length;

    // Court name is usually the first meaningful line.
    if (ordinal === 0 && COURT_NAME_RE.test(lines[0] ?? "") && lines[0]!.length < 140) {
      blocks.push(mk(ordinal++, page, "court_name", lines[0]!, { fromOcr: opts.sourceFromOcr ?? page.kind === "scanned" }));
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      if (page.footerMatch && page.footerMatch.test(line) && line.length < 100) {
        blocks.push(mk(ordinal++, page, "footer", line, {}));
        continue;
      }

      const heading = HEADING_MARKERS.find((h) => h.re.test(line));
      if (heading && line.length < 200) {
        blocks.push(mk(ordinal++, page, heading.kind, line, {}));
        continue;
      }

      if (CASE_NO_RE.test(line) && line.length < 90) {
        blocks.push(mk(ordinal++, page, "case_number", line, {}));
        continue;
      }

      if (SEAL_RE.test(line) && line.length < 80) {
        blocks.push(mk(ordinal++, page, "seal_note", line, {}));
        continue;
      }

      if (SIGNATURE_RE.test(line) && line.length < 200) {
        blocks.push(mk(ordinal++, page, "signature_block", line, {}));
        continue;
      }

      if (CITATION_RE.test(line) && line.length < avgLen * 0.8 && line.length < 160) {
        blocks.push(mk(ordinal++, page, "citation", line, {}));
        continue;
      }

      const clause = line.match(CLAUSE_LABEL_RE);
      if (clause) {
        const depth = (clause[1] ?? "").split(".").length;
        blocks.push(
          mk(ordinal++, page, depth > 1 ? "sub_clause" : "clause", line, {
            clauseLabel: clause[1]?.trim(),
            clauseDepth: depth,
          }),
        );
        continue;
      }

      if (/^[•\-*–—o]\s+/.test(line) && line.length < avgLen * 1.5) {
        blocks.push(mk(ordinal++, page, "list_item", line, {}));
        continue;
      }

      if (QUOTE_RE.test(line) && line.length < 400) {
        blocks.push(mk(ordinal++, page, "quotation", line, {}));
        continue;
      }

      if (line.length < 120 && isAllCaps(line) && hasIndic(line)) {
        blocks.push(mk(ordinal++, page, "heading_2", line, {}));
        continue;
      }

      blocks.push(
        mk(ordinal++, page, "body", line, {
          fromOcr: opts.sourceFromOcr ?? page.kind === "scanned",
        }),
      );
    }

    // Page footer / page-number block, emitted last for the page.
    if (page.pageNumber > 1) {
      blocks.push(mk(ordinal++, page, "footer", `— ${page.pageNumber} —`, { synthetic: true }));
    }
  }

  return blocks;
}

function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return false;
  return letters === letters.toUpperCase();
}

function hasIndic(s: string): boolean {
  return /[ऀ-ॿ઀-૿]/.test(s);
}

/**
 * A "paragraph" that survived OCR as one 3000-character line is untranslatable
 * and unreadable. Split it on Gujarati/English sentence terminators.
 */
function expandDenseParagraph(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= 900) {
      out.push(line);
      continue;
    }
    const parts = line
      .split(/(?<=[।.])\s+(?=[઀-૿A-Z0-9"“])/u)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      let buf = "";
      for (const p of parts) {
        if ((buf + " " + p).length > 900) {
          out.push(buf.trim());
          buf = p;
        } else {
          buf = buf ? `${buf} ${p}` : p;
        }
      }
      if (buf.trim()) out.push(buf.trim());
    } else {
      // No sentence boundary found: hard-wrap so downstream stages see units.
      for (let i = 0; i < line.length; i += 900) out.push(line.slice(i, i + 900).trim());
    }
  }
  return out.filter(Boolean);
}

function mk(
  ordinal: number,
  page: PageText,
  kind: BlockKind,
  text: string,
  meta: Partial<Block["meta"]>,
): Block {
  const src = text.replace(/^[\s]+/, "");
  return {
    id: `b${ordinal + 1}`,
    ordinal,
    pageNumber: page.pageNumber,
    kind,
    sourceText: src,
    targetText: "",
    translationState: "pending",
    tokenCount: 0,
    meta: { ...meta, pageConfidence: page.confidence ?? undefined } as Block["meta"],
  };
}

// ── Document-level assembly ────────────────────────────────────────────────────

export interface PreparedDocument {
  blocks: Block[];
  pageCount: number;
  preflight: DocumentPreflight;
  detection: TypeDetection;
  fullText: string;
  meanOcrConfidence: number | null;
  /** Set when preflight blocked translation. */
  blocked: boolean;
  blockReasons: string[];
}

/** Join blocks into a form the type classifier can read. */
export function blocksToText(blocks: Block[]): string {
  return blocks.map((b) => b.sourceText).join("\n");
}

/**
 * Page-level pattern matching is done on the raw page text rather than on blocks
 * so footers can be identified before they become translation units.
 */
export function attachFooterDetection(pages: PageText[]): void {
  for (const p of pages) {
    p.footerMatch = /^[\s\-—–_]*(\d{1,3}|page\s*\d{1,3}|પાના\s*\d{1,3})[\s\-—–_]*$/i;
  }
}

export function prepare(
  pages: PageText[],
  opts: { declaredType?: string | null; fileName?: string } = {},
): PreparedDocument {
  attachFooterDetection(pages);
  const blocks = detectStructure(pages);

  // Structural / page-number blocks are not content: they must not be translated.
  const translatable = blocks.filter((b) => b.kind !== "footer");

  const fullText = translatable.map((b) => b.sourceText).join("\n");
  const preflight = preflightDocument(fullText);
  const detection = detectDocType(fullText);

  const confidences = pages.map((p) => p.confidence).filter((c): c is number => c !== null);
  const meanOcrConfidence =
    confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;

  const blockReasons = preflight.warnings.filter((w) => w.severity === "block").map((w) => w.message);

  return {
    blocks: translatable,
    pageCount: pages.length,
    preflight,
    detection: opts.declaredType
      ? { ...detection, type: opts.declaredType as TypeDetection["type"] }
      : detection,
    fullText,
    meanOcrConfidence,
    blocked: blockReasons.length > 0,
    blockReasons,
  };
}

/** Convenience for the text-paste path. */
export function prepareText(text: string, declaredType?: string | null): PreparedDocument {
  const normalized = normalizeWhitespace(text);
  return prepare(
    [
      {
        pageNumber: 1,
        kind: "text",
        text: normalized,
        confidence: null,
        engine: null,
        warnings: [],
      },
    ],
    { declaredType },
  );
}

/** Glossary hit count used for the dashboard's "terminology density" figure. */
export function glossaryDensity(text: string): { hits: number; per1000: number } {
  let hits = 0;
  const words = text.split(/\s+/).filter(Boolean);
  for (const w of words) {
    const clean = w.replace(/[^\p{L}\p{M}]/gu, "");
    if (clean.length >= 2 && lookupGlossary(clean)) hits++;
  }
  return { hits, per1000: words.length === 0 ? 0 : Math.round((hits / words.length) * 1000) };
}
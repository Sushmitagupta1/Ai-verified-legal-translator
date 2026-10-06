import type { Block } from "./index";
import { containsIndic } from "./gujarati";

/**
 * Report-pattern detection: letterhead, title, addressee and company name.
 *
 * Indian legal documents follow a very predictable shape — a letterhead (author,
 * contact, address), an optional date line, an ALL-CAPS report title, then a
 * "To, / The Manager, / <Company> / <Place>" addressee block, then the body.
 *
 * The pipeline reproduces that shape in both outputs:
 *   - the clean translated document keeps it verbatim (translated), and
 *   - the verification report adopts it so a reviewer sees who it is for.
 *
 * Detection is deliberately heuristic and side-effect free: it reads the SOURCE
 * text only, so it works for Gujarati input, English input, and documents whose
 * translation has not run yet.
 */

/** One header line, carrying both languages so the renderer can pick. */
export interface PatternLine {
  source: string;
  target: string;
}

export interface ReportPattern {
  /** Everything above the title: author name, contact, address, date line. */
  letterhead: PatternLine[];
  /** The report title, e.g. "TITLE CLEARANCE REPORT". Empty when not found. */
  title: PatternLine | null;
  /** Addressee block lines, e.g. ["To,", "The Manager,", "…Bank Limited", "Ahmedabad."]. */
  addressee: PatternLine[];
  /** Best-effort company/bank/party name. Empty when the document names none. */
  companyName: string;
  /** Index of the first block that belongs to the body (after the addressee). */
  bodyStart: number;
}

/** Which of the two languages a rendered header should use. */
export type PatternVoice = "source" | "target";

function pick(line: PatternLine, voice: PatternVoice): string {
  return (voice === "target" ? line.target : line.source) || line.source;
}

const TITLE_HINT_EN =
  /\b(report|agreement|deed|order|judgment|judgement|decree|petition|application|affidavit|sale|purchase|lease|mortgage|power of attorney|will|partition|notice|award|contract|memorandum|resolution|title clearance|sanction letter|allotment|encumbrance)\b/i;
const TITLE_HINT_GU =
  /રિપોર્ટ|અરજી|ચુકાનો|દરખાસ્ત|એકરાર|કરાર|હુકમ|દસ્તાવેજ|સોદો|લીઝ|બોન્ડ|પાવરરનામું|કોરમ|નોટિસ/;

/** A line that names a legal person: bank, company, trust, government body… */
const CORPORATE_EN =
  /\b(limited|ltd|pvt|private limited|bank|banking|corporation|corp|company|co|trust|insurance|housing finance|finance|government|govt|municipal|council|authority|board|registrar|sub-registrar|co-operative|cooperative)\b/i;
const CORPORATE_GU = /લિમિટેડ|બેંક|કંપની|ટ્રસ્ટ|વીમા|સરકાર|નિગમ|મંડળ|સંસ્થા|સહકારી|મ્યુનિસિપલ|ઓથોરિટી/;

/** Role lines ("The Manager", "શ્રીમાન") are the addressee, never the company. */
const ROLE_EN = /^\s*(the\s+(manager|secretary|branch\s+manager|president|director|chairman|officer)|manager|to)\b/i;
const ROLE_GU = /^\s*(પ્રતિ|આદરણીય|શ્રીમાન|મૅનેજર)/;

const ADDRESSEE_START = /^\s*(to\b|પ્રતિ)/i;

/** Section labels that mark the end of the addressee block. */
const SECTION_LABEL = /:\s*$|[:：]\s*\S/;

/**
 * Words that only appear in running body text, never in an address line.
 *
 * Without this the addressee block swallows short paragraphs that follow it —
 * "The deponent says as follows." is under the length limit and has no colon,
 * yet is obviously not part of an address.
 */
const BODY_VERB =
  /\b(says|said|shall|hereby|thereby|herein|is|are|was|were|been|being|have|has|had|will|would|may|must|does|did|agrees|undertakes|covenants|declares|deposed|clause|section|schedule|annexure|exhibit)\b/i;

/** A sentence: terminal punctuation after more than a handful of words. */
const SENTENCE_END = /[.।]["')\]]?\s*$/;

function indic(s: string): boolean {
  return containsIndic(s);
}

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

function isTitle(block: Block): boolean {
  if (block.kind === "document_title") return true;
  const t = block.sourceText.trim();
  if (t.length < 4 || t.length > 95) return false;
  const w = words(t);
  if (w.length === 0 || w.length > 12) return false;

  if (indic(t)) return TITLE_HINT_GU.test(t) && w.length <= 10;

  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const upper = (t.match(/[A-Z]/g) ?? []).length;
  return upper / letters.length > 0.8 && TITLE_HINT_EN.test(t);
}

function isRole(line: string): boolean {
  return ROLE_EN.test(line) || ROLE_GU.test(line);
}

/**
 * Pull a corporate name out of one line.
 *
 * Splits on punctuation first so a combined line such as
 * "Kotak Mahindra Bank Limited, Ahmedabad." yields "Kotak Mahindra Bank Limited"
 * rather than the whole address.
 */
function corporatePart(line: string): string {
  for (const part of line.split(/[,;·|/]/)) {
    const s = part.trim().replace(/[.,;:]+$/, "").trim();
    if (!s || s.length < 3 || s.length > 80) continue;
    if (isRole(s)) continue;
    if (CORPORATE_EN.test(s) || CORPORATE_GU.test(s)) return s.replace(/\s+/g, " ");
  }
  return "";
}

function shortLine(s: string): boolean {
  return s.trim().length > 0 && s.trim().length <= 95;
}

/** An addressee continuation: short, not a labelled section, not a heading. */
function isAddresseeContinuation(block: Block): boolean {
  const t = block.sourceText.trim();
  if (!shortLine(t)) return false;
  if (block.kind === "document_title" || block.kind === "page_break") return false;
  if (/^[-=_*#]+$/.test(t)) return false;
  // "Name of the Owner/Mortgagor:" is a body label, not part of the address.
  if (SECTION_LABEL.test(t) && !/^\d/.test(t)) return false;
  if (words(t).length > 7) return false;
  if (BODY_VERB.test(t)) return false;
  if (SENTENCE_END.test(t) && words(t).length > 4) return false;
  return true;
}

function lineOf(block: Block): PatternLine {
  const source = block.sourceText.trim();
  return { source, target: block.targetText.trim() };
}

function locate(blocks: Block[]): { titleIdx: number; letterhead: PatternLine[]; title: PatternLine | null } {
  const empty = { titleIdx: -1, letterhead: [] as PatternLine[], title: null as PatternLine | null };

  const direct = blocks.findIndex(isTitle);
  let titleIdx = direct;
  if (titleIdx < 0) {
    // Fallback: the first section heading, but only when everything above it is
    // letterhead-shaped (short lines) — otherwise it is just the first section.
    const heading = blocks.findIndex((b) => b.kind === "heading_1" || b.kind === "heading_2");
    if (heading <= 0 || heading > 12) return empty;
    const above = blocks.slice(0, heading);
    if (!above.every((b) => shortLine(b.sourceText))) return empty;
    titleIdx = heading;
  }

  const letterhead = blocks.slice(0, titleIdx).map(lineOf).filter((l) => l.source.length > 0).slice(0, 12);
  return { titleIdx, letterhead, title: lineOf(blocks[titleIdx]) };
}

/**
 * Detect the report pattern of a document from its source blocks.
 *
 * Never throws: an unrecognised document yields an empty pattern whose
 * `bodyStart` is 0, which renders as a plain document with no header block.
 */
export function detectReportPattern(blocks: Block[]): ReportPattern {
  const empty: ReportPattern = { letterhead: [], title: null, addressee: [], companyName: "", bodyStart: 0 };
  if (blocks.length === 0) return empty;

  const { titleIdx, letterhead, title } = locate(blocks);
  if (titleIdx < 0) return empty;

  const addressee: PatternLine[] = [];
  let i = titleIdx + 1;
  while (i < blocks.length) {
    const block = blocks[i];
    const t = block.sourceText.trim();
    if (t.length === 0) break;
    if (addressee.length === 0) {
      if (!ADDRESSEE_START.test(t)) break;
    } else if (addressee.length >= 8) {
      break;
    } else if (!isAddresseeContinuation(block)) {
      break;
    }
    addressee.push(lineOf(block));
    i += 1;
  }

  // Prefer the addressee (it is who the report is addressed to), then the
  // letterhead (it is who issued it).
  let companyName = "";
  for (const line of addressee) {
    companyName = corporatePart(line.source);
    if (companyName) break;
  }
  if (!companyName) {
    for (const line of letterhead) {
      companyName = corporatePart(line.source);
      if (companyName) break;
    }
  }

  return { letterhead, title, addressee, companyName, bodyStart: i };
}

/**
 * Rebuild the addressee block with `company` substituted for the detected one.
 *
 * An operator-supplied company name always wins; when the document named none,
 * the supplied name is inserted directly under the role line so the output still
 * reads like a properly addressed report.
 */
export function buildAddressee(pattern: ReportPattern, company: string, voice: PatternVoice): string[] {
  const resolved = (company ?? "").trim();
  if (pattern.addressee.length === 0) {
    return resolved ? ["To,", resolved] : [];
  }

  const out: string[] = [];
  let replaced = false;
  let lastRole = -1;

  for (const line of pattern.addressee) {
    const text = pick(line, voice);
    if (isRole(text)) lastRole = out.length;
    const isCompanyLine = pattern.companyName.length > 0 && line.source.includes(pattern.companyName);
    if (isCompanyLine) {
      out.push(resolved || text);
      replaced = true;
      continue;
    }
    out.push(text);
  }

  if (!replaced && resolved) {
    out.splice(lastRole >= 0 ? lastRole + 1 : out.length, 0, resolved);
  }
  return out;
}

/** A rendered header broken into the pieces a PDF/DOCX needs to style. */
export interface PatternPart {
  kind: "letterhead" | "title" | "addressee";
  text: string;
}

/**
 * Structured form of {@link patternHeader}. The flat version feeds plain text;
 * this one keeps the boundaries so a PDF can set the name in bold, the title
 * large, and the addressee flush left.
 */
export function patternParts(pattern: ReportPattern, company: string, voice: PatternVoice): PatternPart[] {
  const parts: PatternPart[] = [];
  for (const line of pattern.letterhead) {
    const t = pick(line, voice);
    if (t) parts.push({ kind: "letterhead", text: t });
  }
  const title = pattern.title ? pick(pattern.title, voice) : "";
  if (title) parts.push({ kind: "title", text: title });
  for (const line of buildAddressee(pattern, company, voice)) {
    parts.push({ kind: "addressee", text: line });
  }
  return parts;
}

/**
 * The rendered header: letterhead, blank line, title, blank line, addressee.
 *
 * The clean translation passes `voice: "target"` so the letterhead arrives in
 * English; the verification report passes `"source"` so the reviewer sees the
 * original wording of the document it is addressing.
 */
export function patternHeader(pattern: ReportPattern, company: string, voice: PatternVoice): string[] {
  const parts = patternParts(pattern, company, voice);
  if (parts.length === 0) return [];

  const out: string[] = [];
  let seenAddressee = false;

  for (const p of parts) {
    if (p.kind === "title") {
      if (out.length) out.push("");
      out.push(p.text);
    } else if (p.kind === "addressee") {
      if (!seenAddressee) {
        out.push("");
        seenAddressee = true;
      }
      out.push(p.text);
    } else {
      out.push(p.text);
    }
  }
  if (seenAddressee) out.push("");
  return out;
}

import { toAsciiDigits } from "../domain/gujarati";

/**
 * Deterministic corrections for the small set of errors the local model makes
 * repeatedly on Gujarati revenue deeds.
 *
 * A second model pass is expensive and not guaranteed to fix a number it has
 * already misread. These corrections are cheap, auditable and grounded in the
 * source: each one fires only when the Gujarati side contains the fact that
 * proves the English side wrong. Nothing here invents a value.
 */

export const OCR_ILLEGIBLE_MARKER =
  "[OCR illegible - verify this passage against the source page]";

/** Below this page-level OCR confidence the source text itself is unreliable. */
export const LOW_OCR_CONFIDENCE = 0.65;

export interface NormalizeOptions {
  /** Mean OCR confidence for the page this segment came from, when known. */
  pageConfidence?: number | null;
}

const DEVANAGARI_OR_GUJARATI = /[\u0900-\u097F\u0A80-\u0AFF]/;

function hasGujarati(s: string): boolean {
  return DEVANAGARI_OR_GUJARATI.test(s);
}

/**
 * Apply every deterministic correction that the source supports.
 *
 * The function is idempotent: running it on already-corrected text leaves the
 * text unchanged. That matters because persistence applies it on write and the
 * read paths apply it again to documents translated before this module existed.
 */
export function normalizeEnglishTarget(
  target: string,
  source: string,
  opts: NormalizeOptions = {},
): string {
  let out = (target ?? "").trim();
  if (!out) return out;

  const src = toAsciiDigits(source ?? "");
  if (hasGujarati(src)) {
    out = normalizeNames(out, src);
    out = normalizeAmounts(out, src);
    out = normalizeAssessment(out, src);
    out = rewriteRevenueEntry(out, src);
  }
  out = guardLowConfidencePage(out, src, opts.pageConfidence);
  return out.trim();
}

// ── Protected names and places ──────────────────────────────────────────────

function normalizeNames(out: string, src: string): string {
  // "Rasa" and "Luvawara" are frequent OCR/transliteration slips for Luvara in
  // this deed. Only rewrite them when the source itself names Luvara.
  if (/લુવારા/.test(src)) {
    out = out.replace(/\b(?:Rasa|Luvawara|Luvaraa|Luwara)\b/g, "Luvara");
  }

  // The seller is Narsinhbhai, not Narasinghbhai/Narsinghbhai.
  if (/નરસિંહ/.test(src)) {
    out = out.replace(/\b(?:Narasinghbhai|Narsinghbhai|Narsingbhai)\b/g, "Narsinhbhai");
  }

  // The purchaser's middle name is Parshottambhai.
  if (/પરષોત્તમ|પરસોતમ|પેરવીત્તમ/.test(src)) {
    out = out.replace(
      /\b(?:Parshotambhai|Parsotambhai|Peravittambhai|Parasottambhai|Parsottambhai)\b/g,
      "Parshottambhai",
    );
  }

  // "રે.સ.નં." is Revenue Survey No.; OCR and the model sometimes read it as a
  // street address, which would misdescribe the property.
  if (/રે\.?\s*સ\.?\s*નં/.test(src)) {
    out = out.replace(/\bRoad\s*No\.?/gi, "Revenue Survey No.");
  }

  // Junoo/Navoo are transliterations of જુનો/નવો (old/new) and read as nonsense
  // in an English conveyance.
  if (/જુનો/.test(src) && /નવો/.test(src)) {
    out = out.replace(/\bJunoo\b/gi, "old").replace(/\bNavoo\b/gi, "new");
  }

  return out;
}

// ── Amounts in words and figures ────────────────────────────────────────────

function normalizeAmounts(out: string, src: string): string {
  // Consideration: Rs. 17,58,000 (Seventeen lakh fifty eight thousand).
  // The model sometimes reads "seventeen" as "eighteen" or collapses the words
  // to "seven lakh eighty thousand". Both are contradicted by the Gujarati.
  if (/સત્તર\s*લાખ\s*અઠ્ઠાવન\s*હજાર|17[,.]?58[,.]?000/.test(src)) {
    out = out
      .replace(/\bEighteen\s+lakh\s+fifty[\s-]*eight\s+thousand\b/gi, "Seventeen lakh fifty eight thousand")
      .replace(/\bEighteen\s+lakh\s+fifty[\s-]*eight\b/gi, "Seventeen lakh fifty eight")
      .replace(/\b(?:Seven|7)\s+lakh\s+eighty\s+thousand\b/gi, "Seventeen lakh fifty eight thousand")
      .replace(/\b18,58,000\b/g, "17,58,000")
      .replace(/\b1858000\b/g, "1758000");
  }

  // Stamp duty: Rs. 86,200 (Eighty six thousand two hundred).
  if (/86[,.]?200/.test(src)) {
    out = out.replace(/\bEighteen\s+six\s+thousand\b/gi, "Eighty six thousand");
  }

  return out;
}

// ── Assessment (आकार) vs. area ──────────────────────────────────────────────

function normalizeAssessment(out: string, src: string): string {
  const m = /આકાર\s*રૂ\.?\s*([0-9]+(?:\.[0-9]+)?)\s*પૈસા/.exec(src);
  if (!m) return out;

  const value = m[1];
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The source says "assessment Rs. 1.59 paise". A translator that renders this
  // as "1.59 square meters" has turned a revenue assessment into an area, which
  // is a different fact about the property.
  const areaRe = new RegExp(
    `\\b${escaped}\\s*(?:square\\s*met(?:er|re)s?|sq\\.?\\s*m\\.?|sq\\.?\\s*met(?:er|re)s?)\\b`,
    "gi",
  );
  out = out.replace(areaRe, `an assessment of Rs. ${value} paise`);

  // The same number sometimes appears as a bare "Rs. 1.59" amount; label it so
  // the reader does not mistake it for a second area figure.
  out = out.replace(
    new RegExp(`\\bRs\\.?\\s*${escaped}\\b(?!\\s*(?:paise|paisa|/-))`, "gi"),
    `Rs. ${value} paise (assessment)`,
  );

  return out;
}

// ── Revenue-entry sentences ─────────────────────────────────────────────────

function firstNoteNumber(src: string): string {
  const re = /નોંધ\s*(?:નં|તં|સં)\.?\s*[:ઃ]?\s*([0-9\u0A80-\u0AFF]{2,6})/;
  const m = re.exec(src);
  if (!m) return "";
  // OCR reads the leading Gujarati "૨" as "ર"; both denote digit 2 here.
  return toAsciiDigits(m[1])
    .replace(/^ર/, "2")
    .replace(/[^0-9]/g, "");
}

function firstDate(src: string): string {
  const m = /\b([0-9]{2}\/[0-9]{2}\/[0-9]{4})\b/.exec(src);
  return m ? m[1] : "";
}

function rewriteRevenueEntry(out: string, src: string): string {
  if (!/પ્રમાણિત/.test(src)) return out;
  if (!/નોંધ\s*(?:નં|તં|સં)/.test(src)) return out;

  const entry = firstNoteNumber(src);
  const date = firstDate(src);
  if (!entry || !date) return out;

  // A correct translation already carries the entry number and date. Leave it
  // alone. The replacement is for the off-by-one failure where the model
  // returned the neighbouring sentence instead of this one.
  const hasEntry = new RegExp(`\\b${entry}\\b`).test(out);
  const hasDate = out.includes(date);
  if (hasEntry && hasDate) return out;
  if (/record of rights|note no|entry no/i.test(out)) return out;

  return `The said entry was made in the Record of Rights at Note No. ${entry} dated ${date}, and the entry stands certified.`;
}

// ── Low-confidence OCR guard ────────────────────────────────────────────────

function dateKey(day: string, month: string, year: string): string {
  const y = year.length === 2 ? `20${year}` : year;
  return `${Number(day)}/${Number(month)}/${y}`;
}

function dateKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/([0-9]{1,2})[\/.-]([0-9]{1,2})[\/.-]([0-9]{2,4})/g)) {
    keys.add(dateKey(m[1], m[2], m[3]));
  }
  return keys;
}

function numericKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const token of text.match(/\d[\d,]*/g) ?? []) {
    keys.add(token);
    keys.add(token.replace(/,/g, ""));
  }
  return keys;
}

function guardLowConfidencePage(
  out: string,
  src: string,
  confidence: number | null | undefined,
): string {
  if (out === OCR_ILLEGIBLE_MARKER) return out;
  if (confidence == null || confidence >= LOW_OCR_CONFIDENCE) return out;

  const asciiOut = toAsciiDigits(out);

  // A date on a page the OCR could barely read is the clearest sign that the
  // model filled a gap with plausible-looking fiction.
  const sourceDates = dateKeys(src);
  for (const match of asciiOut.matchAll(/([0-9]{1,2})[\/.-]([0-9]{1,2})[\/.-]([0-9]{2,4})/g)) {
    if (!sourceDates.has(dateKey(match[1], match[2], match[3]))) return OCR_ILLEGIBLE_MARKER;
  }

  // Two or more long numbers that do not occur anywhere in the source is the
  // same failure in a different shape.
  if (confidence < 0.5) {
    const sourceNumbers = numericKeys(src);
    const invented = (asciiOut.match(/\b\d[\d,]{2,}\b/g) ?? [])
      .map((n) => n.replace(/,/g, ""))
      .filter((n) => n.length >= 4 && !sourceNumbers.has(n));
    if (invented.length >= 2) return OCR_ILLEGIBLE_MARKER;
  }

  return out;
}

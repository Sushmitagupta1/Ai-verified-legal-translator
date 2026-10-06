/**
 * Gujarati script primitives: numerals, month/day names, digit-grouping,
 * Unicode range detection and transliteration helpers.
 *
 * Everything in the pipeline that needs to reason about "is this a Gujarati
 * document, and what exactly does this number say" comes through here so that
 * the numeral semantics live in exactly one place.
 */

/** Gujarati digits ૦..૩ = U+0AE6..U+0AEF. */
export const GU_DIGIT_ZERO = 0x0ae6;
export const GU_DIGIT_NINE = 0x0aef;
export const GU_DIGITS = "૦૧૨૩૪૫૬૭૮૯";

const GU_DIGIT_RE = /[૦-૯]/;

/**
 * Gujarati month names (Gregorian) as they appear in court orders and notices.
 *
 * Many of these spellings differ only by Unicode composition, and court documents
 * mix them freely, so lookups go through `guMonthNumber` which compares NFC-normalised
 * forms. Storing both variants as separate keys would collide, since the composed and
 * decomposed forms of the same word are different byte sequences for one name.
 */
export const GU_MONTHS: Record<string, number> = {
  જાન્યુઆરી: 1,
  ફેબ્રુઆરી: 2,
  માર્ચ: 3,
  એપ્રિલ: 4,
  એપ્રીલ: 4,
  મે: 5,
  જૂન: 6,
  જુન: 6,
  જુલાઈ: 7,
  જુલાઇ: 7,
  ઑગસ્ટ: 8,
  ઓગસ્ટ: 8,
  સપ્ટેમ્બર: 9,
  સપ્ટેંબર: 9,
  ઑક્ટોબર: 10,
  ઓક્ટોબર: 10,
  નવેમ્બર: 11,
  નવેંબર: 11,
  ડિસેમ્બર: 12,
  ડિસેંબર: 12,
};

const GU_MONTH_NFC = new Map<string, number>();
for (const [name, n] of Object.entries(GU_MONTHS)) {
  GU_MONTH_NFC.set(name.normalize("NFC"), n);
  GU_MONTH_NFC.set(name.normalize("NFD"), n);
}

/** Month number for any accepted Gujarati spelling, or undefined. */
export function guMonthNumber(name: string): number | undefined {
  return GU_MONTH_NFC.get(name.normalize("NFC")) ?? GU_MONTH_NFC.get(name.normalize("NFD"));
}

export const EN_MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

export const EN_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function isGujaratiDigit(ch: string): boolean {
  const c = ch.codePointAt(0) ?? -1;
  return c >= GU_DIGIT_ZERO && c <= GU_DIGIT_NINE;
}

export function hasGujaratiDigits(s: string): boolean {
  return GU_DIGIT_RE.test(s);
}

/** Convert one Gujarati digit to its ASCII value. Returns NaN for non-Gujarati. */
export function guDigitValue(ch: string): number {
  const c = ch.codePointAt(0) ?? -1;
  if (c < GU_DIGIT_ZERO || c > GU_DIGIT_NINE) return Number.NaN;
  return c - GU_DIGIT_ZERO;
}

/**
 * Normalise all Gujarati digits to ASCII digits.
 *
 * Used as the *first* step of every numeric/date/currency regex so a single
 * pattern set works for both scripts.
 */
export function toAsciiDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    const v = guDigitValue(ch);
    out += Number.isNaN(v) ? ch : String(v);
  }
  return out;
}

/** Inverse of {@link toAsciiDigits}. */
export function toGujaratiDigits(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch >= "0" && ch <= "9") out += String.fromCodePoint(GU_DIGIT_ZERO + (ch.charCodeAt(0) - 48));
    else out += ch;
  }
  return out;
}

/** Script detection by Unicode block census. */
export type Script = "gujarati" | "devanagari" | "tamil" | "telugu" | "kannada" | "latin" | "unknown";

const SCRIPT_RANGES: Array<[Script, number, number]> = [
  ["gujarati", 0x0a80, 0x0aff],
  ["devanagari", 0x0900, 0x097f],
  ["tamil", 0x0b80, 0x0bff],
  ["telugu", 0x0c00, 0x0c7f],
  ["kannada", 0x0c80, 0x0cff],
];

export function detectScript(text: string): Script {
  const counts = new Map<Script, number>();
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? -1;
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      latin++;
      continue;
    }
    for (const [name, lo, hi] of SCRIPT_RANGES) {
      if (c >= lo && c <= hi) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  let best: Script = "unknown";
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  if (bestN === 0) return latin > 0 ? "latin" : "unknown";
  // Latin script is expected alongside Gujarati in bilingual legal documents,
  // so only return latin when it clearly dominates.
  return latin > bestN * 4 ? "latin" : best;
}

export function scriptProfile(text: string): { script: Script; gujaratiRatio: number; latinRatio: number; otherRatio: number } {
  let gu = 0;
  let latin = 0;
  let other = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total++;
    const c = ch.codePointAt(0) ?? -1;
    if (c >= 0x0a80 && c <= 0x0aff) gu++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) latin++;
    else other++;
  }
  const denom = Math.max(1, total);
  const script = detectScript(text);
  return {
    script,
    gujaratiRatio: gu / denom,
    latinRatio: latin / denom,
    otherRatio: other / denom,
  };
}

/**
 * Detect legacy / non-Unicode Indic encodings (Krutidev, Shusha, Mangal,Chanakya).
 *
 * These render as mojibake in Unicode: private-use code points, box-drawing and
 * Latin-1 supplement junk interleaved with Devanagari/Gujarati blocks. We detect
 * and REPORT them but deliberately do not attempt conversion: a wrong conversion
 * silently corrupts names and numbers, which is the exact failure mode this
 * product exists to prevent. The reviewer is asked to supply a Unicode copy.
 */
export interface LegacyEncodingSignal {
  suspected: boolean;
  candidates: string[];
  confidence: number;
}

const LEGACY_SIGNATURES: Array<[string, RegExp]> = [
  ["krutidev", /[ÚöÆ¼¯ÉÑÚûô\|\uE000-\uF8FF]/],
  ["shusha", /[ŠŕśŞŗţþ\uF020-\uF0FF]/],
  ["mangal", /[ØþÏíÄåÇãÁ¼ùê£ðÙ[ªºíµ¶§¨©]/],
  ["chanakya", /[ØþÏíÄåÇãÁ¼ùê£ðÙªºíµ¶§¨©]/],
  ["mojibake", /[ÂÃÄÅÆÇÈÉÊË][\x80-\xBF­-¿]{1,3}/],
];

export function detectLegacyEncoding(text: string): LegacyEncodingSignal {
  const sample = text.slice(0, 20_000);
  const candidates: string[] = [];
  let hits = 0;
  for (const [name, re] of LEGACY_SIGNATURES) {
    const m = sample.match(new RegExp(re.source, "g"));
    if (m && m.length >= 3) {
      candidates.push(name);
      hits += m.length;
    }
  }
  const density = hits / Math.max(1, sample.length / 100);
  const suspected = candidates.length > 0 && density > 0.5;
  return { suspected, candidates, confidence: suspected ? Math.min(1, density / 4) : 0 };
}

/** Zero-width, bidi-control and soft-hyphen class, escaped explicitly. */
const INVISIBLE_RE = /[­-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
/** Unicode space separators (Zs category) that should collapse to a plain space. */
const SPACE_SEP_RE = /[\t   -   　]/g;

/** Strip zero-width and bidi control characters that scramble column alignment. */
export function cleanInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, "");
}

/**
 * Collapse horizontal whitespace while preserving line breaks.
 *
 * Newlines are structural, not noise: structure detection splits page text on
 * `\n` to recover paragraph boundaries, so collapsing them here would merge a
 * whole page into one block before the classifier ever sees it. Callers that
 * need a single line use this and then strip newlines explicitly.
 */
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(SPACE_SEP_RE, " ")
    .replace(/ {2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/** Single-line form of `normalizeWhitespace`, for prompts and comparisons. */
export function flattenWhitespace(s: string): string {
  return normalizeWhitespace(s)
    .replace(/\s*\n\s*/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Cheap token estimate. Deliberately not a real BPE tokenizer: we only need a
 * monotone proxy for chunk budgeting, and a dependency-free estimator keeps the
 * pipeline reproducible across model providers.
 */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  const gu = (s.match(/[઀-૿]/g) ?? []).length;
  const other = s.length - gu;
  // Gujarati tokens pack more per token than Latin text in practice.
  return Math.ceil(gu / 2.2 + other / 4);
}

/** Split a Gujarati/Latin string into sentences without breaking on common abbreviations. */
const ABBREVIATIONS = [
  // Gujarati honorifics and markers that end in a full stop but do not end a
  // sentence. "રૂ." (currency) and "તા." (date) matter most: without them
  // "ચુકવણી રૂ. ૫૦,૦૦૦" splits and the amount is sent to the model alone.
  "શ્રી.", "સુશ્રી.", "મુ.", "માનનીય", "ડા.", "પ્રો.", "કા.", "ખા.", "તા.", "તારીખ", "રૂ.", "રૂપિયા", "આદિ",
  // Property/number designators. "સપાટા નં. 45, સરફા નં. 112/2" is idiomatic land
  // description; without "નં." the figure is split into its own segment, sent to the
  // model alone, and the number then reads as missing from the target.
  "નં.",
  // Latin numeric designators. "Rs." matters for the same reason as "રૂ.": the
  // Gujarati side stays one segment while "Rs. 5,00,000/-" splits in two, which
  // breaks the one-segment-per-block invariant and shifts every later pair.
  "Rs.", "M/s.", "Pvt.", "Ltd.", "Co.", "Nos.", "Ch.",
  "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.", "No.", "vs.",
  "Sec.", "Art.", "Artl.", "para.", "para", "cl.", "cl", "exb.", "dist.", "i.e.", "e.g.", "etc.", "viz.", "pp.", "Ed.",
];

/**
 * Escape an abbreviation for use inside a regex alternation.
 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split text into sentences.
 *
 * Abbreviations are masked before splitting, but only as whole tokens. Plain
 * substring replacement is wrong for Gujarati: "તા." is a substring of "હતા.",
 * so a naive protect would swallow the sentence boundary in "શ્રી શાહ હતા. તેઓ
 * ગયા." and merge two sentences into one. The lookbehind/lookahead require a
 * non-letter on both sides, which keeps "હતા." a real terminator.
 */
export function splitSentences(text: string): string[] {
  const MASK = "";
  const abbrevRe = new RegExp(
    `(?<![\\p{L}\\p{M}])(?:${ABBREVIATIONS.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{M}])`,
    "giu",
  );
  const protectedText = text.replace(abbrevRe, (m) => m.replace(/\./g, MASK));

  const rough = protectedText
    .split(/(?<=[।.!?])\s+|\n+/u)
    .map((s) => s.split(MASK).join(".").trim())
    .filter((s) => s.length > 0);
  return rough;
}

/**
 * Gujarati transliteration for names.
 *
 * Deliberately a lookup-driven approximation, not a full romanisation standard:
 * legal names must be carried through unchanged (see the `preserved` path in the
 * translation stage), so this is used only for *matching* a Gujarati name to an
 * English name during verification — never as the output form.
 */
const TRANSLIT: Record<string, string> = {
  અ: "a", આ: "aa", ઇ: "i", ઈ: "ee", ઉ: "u", ઊ: "oo", એ: "e", ઐ: "ai", ઓ: "o", ઔ: "au",
  ક: "k", ખ: "kh", ગ: "g", ઘ: "gh", ઙ: "ng",
  ચ: "ch", છ: "chh", જ: "j", ઝ: "jh", ઞ: "ny",
  ટ: "t", ઠ: "th", ડ: "d", ઢ: "dh", ણ: "n",
  ત: "t", થ: "th", દ: "d", "ધ": "dh", "ન": "n",
  પ: "p", ફ: "f", બ: "b", ભ: "bh", મ: "m",
  ય: "y", ર: "r", લ: "l", વ: "v", શ: "sh", "ષ": "sh", સ: "s", હ: "h",
  ળ: "l", "ક્ષ": "ksh", "જ્ઞ": "gn",
  "ા": "a", "િ": "i", "ી": "i", "ુ": "u", "ૂ": "u", "ે": "e", "ૈ": "ai",
  "ો": "o", "ૌ": "au", "્": "", "્ર": "r", "ં": "n",
};

export function transliterateGujarati(s: string): string {
  let out = "";
  for (const ch of s) {
    const mapped = TRANSLIT[ch];
    out += mapped ?? ch;
  }
  return out
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z]/g, "");
}

/**
 * Collapse consonant digraphs so transliteration spelling variants agree.
 *
 * "Shah"/"Shaah"/"Sah" and "Patel"/"Patell" are the same name written differently,
 * and no amount of exact comparison will reconcile them. Applied to *both* sides
 * of a name comparison — folding only the English side compares a folded key
 * against an unfolded one and rejects every correct pair.
 */
export function foldDigraphs(s: string): string {
  return s
    .replace(/ph/g, "f")
    .replace(/sh/g, "s")
    .replace(/chh?/g, "c")
    .replace(/kh/g, "k")
    .replace(/gh/g, "g")
    .replace(/th/g, "t")
    .replace(/j+h/g, "z")
    .replace(/(.)\1+/g, "$1")
    .replace(/aa|ee|ii|oo|uu/g, (m) => m[0])
    .replace(/[^a-z]/g, "");
}

/**
 * Loose phonetic key used to pair a Gujarati name with its English rendering.
 *
 * Same folding as `latinKey`, so the two are comparable.
 */
export function nameKey(s: string): string {
  return foldDigraphs(transliterateGujarati(s));
}

/** Latin-side phonetic key (handles common English transliteration variance). */
export function latinKey(s: string): string {
  return foldDigraphs(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, ""),
  );
}

/** True if the string contains Gujarati script. */
export function isGujaratiText(s: string): boolean {
  return /[઀-૿]/.test(s);
}

export function containsIndic(s: string): boolean {
  return /[ऀ-ॿঀ-৿਀-੿઀-૿]/.test(s);
}

/** Word-ish tokenizer that keeps Indic combining marks attached to their base. */
export function tokenize(s: string): string[] {
  const cleaned = cleanInvisible(s).toLowerCase();
  return cleaned
    .split(/([^\p{L}\p{N}\p{M}]+)/u)
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
}

export function splitWords(s: string): string[] {
  return tokenize(s);
}

/** Levenshtein distance with early exit. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n];
}

export function normalizedSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

/** Gujarati lakh/crore words used when an amount is written out. */
export const GU_INDIAN_SCALES: Record<string, number> = {
  લાખ: 100_000,
  લખ: 100_000,
  કરોડ: 10_000_000,
  કરોડો: 10_000_000,
  અરબ: 1_000_000_000,
  સહસ્ર: 1_000,
};

/** Strip trailing punctuation that OCR loves to invent. */
export function stripEdgePunctuation(s: string): string {
  return s.replace(/^[\s"'“”‘’\-–—:;,.।]+/, "").replace(/[\s"'“”‘’\-–—:;,.।]+$/, "");
}
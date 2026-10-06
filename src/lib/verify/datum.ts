import { GU_MONTHS, nameKey, normalizeWhitespace, toAsciiDigits, transliterateGujarati } from "../domain/gujarati";
import type { Datum, DatumKind } from "../domain";

const DIGIT_CLASS = "[0-9૦-૯]";

/**
 * A written number: digit groups separated by commas or spaces, optional decimal part.
 *
 * Each group must start with a digit, which is what stops `5,00,000` from
 * matching as `5,00` — a trailing separator needs digits after it, so the
 * pattern has to consume whole groups rather than a bounded run.
 */
const NUMBER_SOURCE = String.raw`${DIGIT_CLASS}+(?:[,\s]${DIGIT_CLASS}+)*(?:\.${DIGIT_CLASS}+)?`;

/** Numeric value of a run of ASCII and/or Gujarati digits. */
function digitRunValue(run: string): number {
  let out = 0;
  for (const ch of run) {
    const v = ch.charCodeAt(0);
    out = out * 10 + (v >= 0x0ae6 ? v - 0x0ae6 : v - 48);
  }
  return out;
}

/** Indian digit grouping: last 3, then pairs. */
function fromIndianGrouping(digits: string): number {
  const s = digits.replace(/^0+(?=\d)/, "");
  if (s.length <= 3) return Number(s);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
  return Number(grouped.replace(/,/g, ""));
}

/**
 * Value of a digit run written with Indian grouping.
 * `5,00,000` -> 500000. Bare runs are read as-is.
 */
function digitsToValue(raw: string): number {
  const cleaned = raw.replace(/[,\s]/g, "");
  const hasIndianGroup = /,\d{2}(?:,|\b)/.test(raw) || /,\d{3}(?:,|$)/.test(raw) === false;
  if (hasIndianGroup && /,\d{2}(?:,|$)/.test(raw)) return fromIndianGrouping(cleaned);
  return Number(cleaned);
}

interface Draft {
  kind: DatumKind;
  surface: string;
  normalized: string;
  start: number;
  end: number;
  meta?: Record<string, string | number | boolean>;
  severity: Datum["severity"];
}

type Rule = { kind: DatumKind; re: RegExp; severity: Datum["severity"]; normalize?: (m: RegExpExecArray) => string };

/**
 * Extraction rules, most specific first.
 *
 * Everything is matched on digit-normalized text (Gujarati digits -> ASCII), so a
 * Gujarati `૫,૦૦,૦૦૦` and an English `5,00,000` reach the same normalizer and
 * compare equal.
 */
const RULES: Rule[] = [
  {
    kind: "currency",
    severity: "critical",
    // Rs. 5,00,000 / ₹5,00,000 / Rs.500000 / Rs. 5 lakhs
    // `રૂ.`/`રૂપિયા` are included: a Gujarati source almost never writes "Rs.",
    // so without them every Gujarati amount was silently unverified.
    re: new RegExp(String.raw`(?:₹|\bRs\.?\s*|\bINR\s*|\bRupees\s+|રૂ(?:પિયા?)?\.?\s*)${NUMBER_SOURCE}`, "g"),
    normalize: (m) => {
      const digits = m[0].match(new RegExp(DIGIT_CLASS, "g"))?.join("") ?? "";
      return String(digitsToValue(digits));
    },
  },
  {
    kind: "percentage",
    severity: "critical",
    re: new RegExp(String.raw`${DIGIT_CLASS}+(?:[.,]\d+)?\s*(?:%|ટકા|ટકે|percent|per cent)`, "gi"),
    normalize: (m) => m[0].replace(/\s*(?:%|ટકા|ટકે|percent|per cent)$/i, "").replace(",", "."),
  },
  {
    kind: "case_number",
    severity: "critical",
    // CRL.A. 1234/2019 / R.A. No. 456/2020 / C.R. No. 12/2018 / S.C.C. 1
    re: /\b(?:[A-Z]{1,4}\.?\s*){1,4}(?:No\.?\.?\s*)?[A-Z]?\d+(?:\/\d{2,4})?(?:\s*(?:of|ના|નું)\s*\d{4})?\b/g,
    normalize: (m) => m[0].replace(/\s+/g, "").replace(/\.$/, "").toUpperCase(),
  },
  {
    kind: "statute",
    severity: "major",
    re: new RegExp(
      String.raw`\b(?:${DIGIT_CLASS}+\s*(?:સે|સા)\s*)?(?:IPC|BNS|CrPC|BNSS|CPC|IEA|BSA|NI\s*Act|NIA|SARFAESI|PMLA|POCSO|NDPS|ULAP|GARB|Act|ધારા|કાયદા)(?:\s*,?\s*19\d{2})?\b`,
      "g",
    ),
    normalize: (m) => m[0].replace(/\s+/g, " ").trim(),
  },
  {
    kind: "section_ref",
    severity: "critical",
    // Section 302 IPC / કલમ ૩૦૨ આઈ.પી.સી. / Article 226 / અનુચ્છેદ ૨૨૬ / Order XIII r.4
    re: new RegExp(
      String.raw`(?:Section|Article|Order|Rule|Schedule|Chapter|Part|Clause)\s*(?:${DIGIT_CLASS}+(?:\s*\(\s*${DIGIT_CLASS}+\s*\))?(?:\s*\(\s*[a-z]+\s*\))?)|(?:કલમ|ધારા|અનુચ્છેદ|નિયમ|નિયમન|પ્રકરણ|અંગ|અનુસૂચિ|ખંડ|વિગત)\s*(?:${DIGIT_CLASS}+(?:\s*\(\s*${DIGIT_CLASS}+\s*\))?(?:\s*\(\s*[a-z]\s*\))?)`,
      "g",
    ),
    normalize: (m) => m[0].replace(/\s+/g, " ").trim(),
  },
  {
    kind: "date",
    severity: "critical",
    re: buildDateRegex(),
    normalize: normalizeDate,
  },
  {
    kind: "time",
    severity: "minor",
    re: new RegExp(String.raw`\b(?:${DIGIT_CLASS}{1,2})\s*[:.]\s*(${DIGIT_CLASS}{2})\s*(?:hrs|hour|વાગ્યે|am|pm)?(?:\s*(?:hrs|hours|વાગ્યા))?\b`, "gi"),
    normalize: (m) => `${m[1].padStart(2, "0")}:${m[2]}`,
  },
  {
    kind: "address_pin",
    severity: "minor",
    re: new RegExp(String.raw`\b(?:PIN|Pin\.?|પિન|PINCode)\s*[-\s]?\s*(${DIGIT_CLASS}{6})\b`, "g"),
    normalize: (m) => m[1],
  },
  {
    kind: "number",
    severity: "major",
    re: new RegExp(String.raw`\b${NUMBER_SOURCE}\b`, "g"),
    normalize: (m) => {
      // Keep grouping separators: "5,00,000" and "500,000" are the same value
      // written differently, and `datumsAgree` reports that as a reformatted
      // note rather than a silent pass or a false mismatch.
      const written = m[0].replace(/\s+/g, "");
      const digits = written.match(new RegExp(DIGIT_CLASS, "g"))?.join("") ?? "";
      const intPart = written.split(".")[0] ?? written;
      const hasSep = /[,\s]/.test(intPart);
      const value = digitsToValue(digits);
      return hasSep ? `${value}|${intPart}` : String(value);
    },
  },
];

function buildDateRegex(): RegExp {
  const guMonths = Object.keys(GU_MONTHS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const enMonths = "January|February|March|April|May|June|July|August|September|October|November|December";
  return new RegExp(
    [
      // 2024-03-12 / 2024.03.12 — year-first. Unambiguous by construction, and
      // the form a translator normally reaches for, so it must be recognised or
      // every ISO date in the English degrades to loose numbers and the date
      // comparison silently passes on a translation that dropped it.
      String.raw`\b${DIGIT_CLASS}{4}[-/.]\s*${DIGIT_CLASS}{1,2}[-/.]\s*${DIGIT_CLASS}{1,2}\b`,
      // 12/03/2024, 12-03-2024, 12.03.2024
      String.raw`\b${DIGIT_CLASS}{1,2}[-/.]\s*${DIGIT_CLASS}{1,2}[-/.]\s*${DIGIT_CLASS}{2,4}\b`,
      // 12 માર્ચ 2024 / 12th March 2024
      String.raw`\b${DIGIT_CLASS}{1,2}\s*(?:રા|રી|th|st|nd|rd)?\s*(?:${guMonths}|${enMonths})\s*,?\s*${DIGIT_CLASS}{2,4}\b`,
      // માર્ચ 12, 2024 / March 12, 2024
      String.raw`\b(?:${guMonths}|${enMonths})\s*${DIGIT_CLASS}{1,2}\s*,?\s*${DIGIT_CLASS}{2,4}\b`,
      // 12.03.2024 ના રોજ
      String.raw`\b${DIGIT_CLASS}{1,2}[-/.]\s*${DIGIT_CLASS}{1,2}[-/.]\s*${DIGIT_CLASS}{2,4}\s*(?:ના\s*રોજ|રોજે|on\s+the)\b`,
    ].join("|"),
    "gi",
  );
}

/**
 * Canonical date form: ISO `YYYY-MM-DD`.
 *
 * Deliberately disambiguates the ambiguous `03/04/2024` case by returning a
 * marker rather than guessing. If the source is genuinely ambiguous we must
 * NOT silently pick a day/month order, because that is a changed date.
 */
function normalizeDate(m: RegExpExecArray): string {
  const raw = m[0];
  // Read *runs* of digits, not individual characters. Matching DIGIT_CLASS
  // one character at a time turns "03/04/2024" into [0,3,0,4,2,0,2,4], which
  // then looks like eight separate values: no year is findable, and day/month
  // positions are read from single digits, so every date fell through to "?raw".
  const nums = (raw.match(new RegExp(`${DIGIT_CLASS}+`, "g")) ?? []).map(digitRunValue);

  const months = Object.keys(GU_MONTHS);
  const guMonth = months.find((name) => raw.toLowerCase().includes(name.toLowerCase()));
  if (guMonth) {
    const mth = GU_MONTHS[guMonth];
    const day = nums.find((n) => n <= 31 && n !== mth) ?? nums[0];
    const year = pickYear(nums);
    if (year && day && day <= 31) return iso(year, mth, day);
  }
  const enMonths = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const low = raw.toLowerCase();
  const enIdx = enMonths.findIndex((name) => low.includes(name));
  if (enIdx >= 0) {
    const mth = enIdx + 1;
    const day = nums.find((n) => n <= 31 && n !== mth) ?? nums[0];
    const year = pickYear(nums);
    if (year && day && day <= 31) return iso(year, mth, day);
  }

  if (nums.length >= 3) {
    // Year-first (2024-03-12) is unambiguous by construction. Reading it as
    // day/month/year would report a false ambiguity and can even invert the
    // month and day, so detect the four-digit leading group first.
    if (nums[0] !== undefined && nums[0] >= 1000 && nums[0] <= 2999) {
      const [, mm, dd] = nums;
      if (mm === undefined || dd === undefined) return `?${raw}`;
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return `?${raw}`;
      return iso(nums[0], mm, dd);
    }

    const year = pickYear(nums);
    const a = nums[0];
    const b = nums[1];
    if (!year || a === undefined || b === undefined) return `?${raw}`;
    if (a <= 12 && b <= 12) {
      // Genuinely ambiguous: both readings are valid dates.
      return `AMBIG:${iso(year, a, b)}|${iso(year, b, a)}`;
    }
    if (a > 12 && b <= 12) return iso(year, b, a);
    if (b > 12 && a <= 12) return iso(year, a, b);
    return `?${raw}`;
  }
  return `?${raw}`;
}

function pickYear(nums: number[]): number | undefined {
  const four = nums.find((n) => n >= 1000 && n <= 2999);
  if (four !== undefined) return four;
  const two = nums.find((n) => n >= 0 && n <= 99 && n > 20);
  return two !== undefined ? 2000 + two : undefined;
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface ExtractOptions {
  /** Restrict the rule set; used by targeted re-checks. */
  kinds?: DatumKind[];
  blockId?: string;
  pageNumber?: number;
  /** Which side of the comparison this text is. Discriminates generated ids. */
  origin?: "s" | "t";
}

/**
 * Extract every fact-shaped datum from a block.
 *
 * Overlapping matches are resolved by longest-span-wins, then by the priority
 * order of `RULES`, so `Rs. 5,00,000` yields a single currency datum rather than
 * also emitting a `number` datum for `5` and `00` and `000`.
 */
export function extractDatums(text: string, opts: ExtractOptions = {}): Datum[] {
  const norm = toAsciiDigits(text);
  const candidates: Draft[] = [];

  for (const rule of RULES) {
    if (opts.kinds && !opts.kinds.includes(rule.kind)) continue;
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      candidates.push({
        kind: rule.kind,
        surface: m[0],
        normalized: rule.normalize ? rule.normalize(m) : m[0],
        start: m.index,
        end: m.index + m[0].length,
        severity: rule.severity,
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start || rulePriority(a.kind) - rulePriority(b.kind));

  const accepted: Draft[] = [];
  for (const cand of candidates) {
    const overlaps = accepted.some((a) => cand.start < a.end && a.start < cand.end);
    if (!overlaps) accepted.push(cand);
  }
  accepted.sort((a, b) => a.start - b.start);

  return accepted.map((d, i) => ({
    // `origin` is part of the id because both sides of a block are extracted with
    // the same blockId: without it a source and a target datum can claim
    // `d{blockId}-0` and collide on the primary key.
    id: `d${opts.origin ?? "s"}${opts.blockId ?? "x"}-${i}`,
    kind: d.kind,
    surface: d.surface,
    normalized: d.normalized,
    context: contextAround(text, d.start, d.end),
    blockId: opts.blockId,
    pageNumber: opts.pageNumber,
    status: "unchecked" as const,
    severity: d.severity,
    meta: d.meta,
  }));
}

function rulePriority(kind: DatumKind): number {
  const order: DatumKind[] = ["currency", "percentage", "section_ref", "case_number", "statute", "date", "time", "address_pin", "number"];
  const i = order.indexOf(kind);
  return i === -1 ? 99 : i;
}

function contextAround(text: string, start: number, end: number, pad = 46): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(text.length, end + pad);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`;
}

// ── Person / party names ────────────────────────────────────────────────────────

const GU_PERSON_PREFIX = /(?:^|[\s(])(?:શ્રી|શ્રીમતી|સુશ્રી|કુ\.|ડા\.|મુ\.|પ્રો\.)/;
const GU_CORPORATE_SUFFIX =
  /(?:લિ|લિમિટેડ|પ્રાઇવેટ|કંપની|ટ્રેડિંગ|એન્ટરપ્રાઇઝિસ|સોસાયટી|બેંક|ફાઉન્ડેશન|હોસ્પિટલ|ટ્રસ્ટ|એસોસિએશન|ઇન્સ્ટીટ્યુટ|બેંક)/;

/**
 * Person-name candidates.
 *
 * Legal names are the single highest-risk datum class: a wrong transliteration is
 * a wrong party, which can invalidate a filing. We extract only high-precision
 * candidates — an honorific followed by a name-shaped run, or a run followed by a
 * designator — rather than guessing capitalised words.
 */
export function extractPersonNames(text: string, opts: ExtractOptions = {}): Datum[] {
  const out: Datum[] = [];
  const seen = new Set<string>();

  const honorificRe = /(?:શ્રી|શ્રીમતી|સુશ્રી|કુ\.|ડા\.|મુ\.|પ્રો\.)\s+((?:[઀-૿A-Za-z][઀-૿A-Za-z.'’-]*)(?:\s+(?:[઀-૿A-Za-z][઀-૿A-Za-z.'’-]*)){0,3})/g;
  let m: RegExpExecArray | null;
  while ((m = honorificRe.exec(text)) !== null) {
    const candidate = m[1].trim().replace(/[,.]$/, "");
    if (candidate.length < 3) continue;
    const key = nameKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(makeNameDatum(candidate, m.index, m.index + m[0].length, text, "person_name", undefined, opts));
  }

  const latinHonorificRe = /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Shri|Smt\.)\s+((?:[A-Z][a-z'’-]+)(?:\s+(?:[A-Z][a-z'’-]+)){0,3})/g;
  while ((m = latinHonorificRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    const key = nameKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(makeNameDatum(candidate, m.index, m.index + m[0].length, text, "person_name", undefined, opts));
  }

  return out;
}

/**
 * Party / party-role names, e.g. "આરોપી શ્રી કિશનભાઈ શાહ".
 * Mirrors the person rule but tags the surrounding role.
 */
/**
 * Words that can follow a role without being the name.
 *
 * "જમીનર હેઠળની જમીન સપાટા નં. 45" names a surety *described in* a deed, not a
 * person. Without this guard the postposition "હેઠળની" is captured as the name.
 */
const ROLE_CONNECTORS = new Set([
  "હેઠળ", "હેઠળની", "હેઠળનું", "હેઠળમાં",
  "તરફ", "તરફની", "વિશે", "વિષે", "દ્વારા", "સાથે", "માટે",
  "ના", "ની", "નું", "નું", "માં", "થી", "અને", "તથા", "કે",
  "માટે", "દ્વારા", "વિધે", "સૂચિ",
]);

export function extractPartyNames(text: string, opts: ExtractOptions = {}): Datum[] {
  const out: Datum[] = [];
  const roleRe = new RegExp(
    String.raw`(?:પ્રતિવાદી|આરોપી|વાદી|ફરિયાદકર્તા|હિસ્સેદાર|જમીનર|સત્તાવિહી|પ્રથમ\s+પક્ષ|બીજી\s+પક્ષ|respondent|petitioner|plaintiff|appellant|accused)\s*[–—:-]?\s*((?:શ્રી|શ્રીમતી|સુશ્રી)?\s*(?:[઀-૿A-Za-z][઀-૿A-Za-z.'’-]*)(?:\s+(?:[઀-૿A-Za-z][઀-૿A-Za-z.'’-]*)){0,3})`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = roleRe.exec(text)) !== null) {
    // There is exactly one capture group, holding the name. Reading m[2] threw
    // on every party-role match, which aborted the whole verification run for
    // any document naming a surety, appellant or respondent.
    const raw = m[1];
    if (raw === undefined) continue;
    const candidate = normalizeWhitespace(raw).replace(/[,.]$/, "");
    if (candidate.length < 3) continue;
    const words = candidate.split(/\s+/);
    if (words.length > 4) continue;
    if (ROLE_CONNECTORS.has(words[0].toLowerCase())) continue;
    const key = nameKey(candidate);
    if (!key) continue;
    // The role is the text before the captured name, not the name itself.
    const role = normalizeWhitespace(m[0].slice(0, m[0].length - raw.length)).replace(/[\s–—:-]+$/, "");
    out.push(makeNameDatum(candidate, m.index, m.index + m[0].length, text, "party_name", role || undefined, opts));
  }
  return out;
}

/** Organisations and institutions — preserved verbatim, never translated. */
export function extractInstitutions(text: string, opts: ExtractOptions = {}): Datum[] {
  const out: Datum[] = [];
  const re = /((?:[઀-૿A-Za-z][઀-૿A-Za-z.&'’-]*)(?:\s+(?:[઀-૿A-Za-z][઀-૿A-Za-z.&'’-]*)){0,4}\s+(?:લિ|લિમિટેડ|લિ\.|પ્રાઇવેટ|ટ્રેડિંગ|એન્ટરપ્રાઇઝિસ|સોસાયટી|બેંક|ફાઉન્ડેશન|હોસ્પિટલ|ટ્રસ્ટ|એસોસિએશન|ઇન્સ્ટીટ્યુટ|યુનિવર્સિટી|કોલેજ|ન્યાયાલય|પોલીસ|કલેક્ટરેટ|Limited|Ltd\.?|Private|Pvt\.?|Trading|Enterprises|Society|Bank|Foundation|Hospital|Trust|Association|Institute|University|College|Court|Police))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const candidate = normalizeWhitespace(m[1]);
    if (candidate.length < 4) continue;
    out.push(makeNameDatum(candidate, m.index, m.index + m[0].length, text, "place", undefined, opts));
  }
  return out;
}

function makeNameDatum(
  surface: string,
  start: number,
  end: number,
  text: string,
  kind: DatumKind,
  role?: string,
  opts: ExtractOptions = {},
): Datum {
  return {
    // Offsets alone are not unique: two blocks can place a name at the same
    // index, and the source and target sides reuse the same offsets. The id
    // must carry block and origin or persisting a multi-block document throws
    // on the datums primary key.
    id: `n${opts.origin ?? "s"}${opts.blockId ?? "x"}-${kind}-${start}`,
    kind,
    surface,
    normalized: transliterateGujarati(surface) || surface.toLowerCase().replace(/\s+/g, ""),
    context: contextAround(text, start, end),
    status: "unchecked",
    severity: kind === "party_name" ? "critical" : "major",
    blockId: opts.blockId,
    pageNumber: opts.pageNumber,
    meta: role ? { role } : undefined,
  };
}

/** Gujarati + English written-out counts that must survive translation verbatim. */
export function extractCountPhrases(text: string): Datum[] {
  const map: Record<string, number> = {
    એક: 1, બે: 2, ત્રણ: 3, "ચાર": 4, પાંચ: 5, છ: 6, "સાત": 7, આઠ: 8, નવ: 9,
    "દસ": 10, "અગિયાર": 11, "બાર": 12, "ત્રર": 13, "ચૌદ": 14, "પંદર": 15, "સોળ": 16,
    "સત્તર": 17, "અઢાર": 18, "ઉન્નીસ": 19, "વીસ": 20, "ત્રીસ": 30, "ચાલીસ": 40, "પચાસ": 50, "સાઠ": 60,
    એકસો: 100,
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, twenty: 20, thirty: 30, hundred: 100, thousand: 1000,
  };
  const out: Datum[] = [];
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${keys.map(escapeRe).join("|")})\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      id: `c-${m.index}`,
      kind: "count_phrase",
      surface: m[1],
      normalized: String(map[m[1].toLowerCase()]),
      context: contextAround(text, m.index, m.index + m[1].length),
      status: "unchecked",
      severity: "minor",
    });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All datum classes for one block of text. */
export function extractAllDatums(text: string, opts: ExtractOptions = {}): Datum[] {
  return [
    ...extractDatums(text, opts),
    ...extractPersonNames(text, opts),
    ...extractPartyNames(text, opts),
    ...extractInstitutions(text, opts),
    ...extractCountPhrases(text),
  ].sort((a, b) => a.context.localeCompare(b.context));
}

// ── Comparison helpers ─────────────────────────────────────────────────────────

/** Numeric part of a `number` normalization, ignoring the written-form suffix. */
export function numericValue(normalized: string): number | undefined {
  const head = normalized.split("|")[0] ?? normalized;
  if (head.startsWith("AMBIG:")) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(head)) return undefined;
  return Number(head);
}

export function isAmbiguousDate(normalized: string): boolean {
  return normalized.startsWith("AMBIG:");
}

/** Both candidate readings of an ambiguous date. */
export function ambiguousDateReadings(normalized: string): string[] {
  const m = normalized.match(/AMBIG:(.+)\|(.+)/);
  return m ? [m[1], m[2]] : [];
}

/**
 * Compare a source datum against a target datum.
 *
 * Returns `matched` when the values agree, `ambiguous` when the source is
 * ambiguous but one reading matches, and `changed` otherwise. Written-form
 * variance (Indian vs international grouping) is tolerated but reported.
 */
export function datumsAgree(src: Datum, tgt: Datum): { agree: boolean; note?: string } {
  if (src.kind !== tgt.kind) return { agree: false };
  if (src.normalized === tgt.normalized) return { agree: true };

  if (src.kind === "number") {
    const a = numericValue(src.normalized);
    const b = numericValue(tgt.normalized);
    if (a !== undefined && b !== undefined) {
      if (a === b) {
        const sf = src.normalized.includes("|") ? src.normalized.split("|")[1] : undefined;
        const tf = tgt.normalized.includes("|") ? tgt.normalized.split("|")[1] : undefined;
        if (sf && tf && sf !== tf) {
          return { agree: true, note: `digit grouping reformatted (${sf} -> ${tf})` };
        }
        return { agree: true };
      }
      return { agree: false };
    }
  }

  if (src.kind === "date" && isAmbiguousDate(src.normalized)) {
    const readings = ambiguousDateReadings(src.normalized);
    if (readings.includes(tgt.normalized)) return { agree: true, note: "ambiguous source date; one reading used" };
    return { agree: false };
  }

  // Section/article references are compared on the identifier only.
  if (src.kind === "section_ref" || src.kind === "case_number" || src.kind === "statute") {
    const s = src.normalized.replace(/\s+/g, "").toUpperCase();
    const t = tgt.normalized.replace(/\s+/g, "").toUpperCase();
    if (s === t) return { agree: true };
    const nums = (v: string) => v.match(/\d+/g)?.join(",");
    if (nums(s) && nums(s) === nums(t)) {
      return { agree: true, note: "reference identifier matches; surrounding label differs" };
    }
    return { agree: false };
  }

  if (src.kind === "currency") {
    const a = numericValue(src.normalized);
    const b = numericValue(tgt.normalized);
    if (a !== undefined && b !== undefined) return { agree: a === b };
  }

  if (src.kind === "percentage") {
    return { agree: src.normalized === tgt.normalized };
  }

  /**
 * Canonical institution concept, keyed off the trailing keyword of an extracted
 * `place` span.
 *
 * Institution extraction is asymmetric: the Gujarati side yields
 * "ગુજરાતી ન્યાયાલય" while the English side greedily yields
 * "By order of the Hon'ble Court". Comparing the raw spans reports a false
 * `place_changed` even though both name the same court, so comparison is on the
 * institution concept instead.
 */
const INSTITUTION_CONCEPTS: Array<{ concept: string; tokens: string[] }> = [
  { concept: "court", tokens: ["ન્યાયાલય", "court", "tribunal"] },
  { concept: "police", tokens: ["પોલીસ", "police"] },
  { concept: "collectorate", tokens: ["કલેક્ટરેટ", "collectorate"] },
  { concept: "bank", tokens: ["બેંક", "bank"] },
  { concept: "university", tokens: ["યુનિવર્સિટી", "university"] },
  { concept: "college", tokens: ["કોલેજ", "college"] },
  { concept: "hospital", tokens: ["હોસ્પિટલ", "hospital"] },
  { concept: "trust", tokens: ["ટ્રસ્ટ", "trust"] },
  { concept: "company", tokens: ["લિ.", "લિ", "લિમિટેડ", "પ્રાઇવેટ", "limited", "ltd", "pvt", "private"] },
  { concept: "foundation", tokens: ["ફાઉન્ડેશન", "foundation"] },
  { concept: "org", tokens: ["સોસાયટી", "એસોસિએશન", "ઇન્સ્ટીટ્યુટ", "society", "association", "institute"] },
];

/**
 * Qualifiers that distinguish institutions of the same concept. Without these,
 * "જિલ્લા ન્યાયાલય" vs "Supreme Court" would both resolve to `court` and a real
 * substitution would pass unnoticed.
 */
const INSTITUTION_QUALIFIERS: Array<{ concept: string; tokens: string[] }> = [
  { concept: "district", tokens: ["જિલ્લા", "જિલ્લી", "district"] },
  { concept: "supreme", tokens: ["સુર્વોચ્ચ", "supreme"] },
  { concept: "high", tokens: ["ઉચ્ચ", "high"] },
  { concept: "sub_divisional", tokens: ["પરિશ્રમણજિલ્લા", "subdivisional", "sub-divisional"] },
  { concept: "taluka", tokens: ["તાલુકા", "taluka", "taluka-level"] },
  { concept: "village", tokens: ["ગામ", "village"] },
];

function institutionConcept(surface: string): string | undefined {
  const low = surface.toLowerCase();
  return INSTITUTION_CONCEPTS.find((c) => c.tokens.some((t) => low.includes(t)))?.concept;
}

function institutionQualifiers(surface: string): Set<string> {
  const low = surface.toLowerCase();
  const out = new Set<string>();
  for (const q of INSTITUTION_QUALIFIERS) {
    if (q.tokens.some((t) => low.includes(t))) out.add(q.concept);
  }
  return out;
}

/**
 * Two `place` datums agree when they name the same institution.
 *
 * Exact surface equality still wins outright, which keeps a verbatim-preserved
 * name ("Gujarat High Court" on both sides) from depending on qualifier logic.
 */
function placesAgree(src: Datum, tgt: Datum): boolean {
  if (src.normalized === tgt.normalized) return true;
  const a = institutionConcept(src.surface);
  const b = institutionConcept(tgt.surface);
  if (a === undefined || b === undefined || a !== b) return false;
  // Same concept, but a qualifier present on only one side is a real change.
  const qa = institutionQualifiers(src.surface);
  const qb = institutionQualifiers(tgt.surface);
  for (const q of qa) if (!qb.has(q)) return false;
  for (const q of qb) if (!qa.has(q)) return false;
  return true;
}

if (src.kind === "person_name" || src.kind === "party_name") {
    return { agree: src.normalized === tgt.normalized };
  }

  if (src.kind === "place") {
    return { agree: placesAgree(src, tgt) };
  }

  if (src.kind === "count_phrase") {
    return { agree: src.normalized === tgt.normalized };
  }

  return { agree: false };
}
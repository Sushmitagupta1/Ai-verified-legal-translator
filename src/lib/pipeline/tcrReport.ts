import type { Block } from "../domain";
import { config } from "../config";
import { toAsciiDigits } from "../domain/gujarati";
import { LOW_OCR_CONFIDENCE } from "./englishNormalize";
import type { VerificationReport } from "./report";
import type { TcrData, TcrItem } from "./tcr";

/**
 * The final report, laid out as an advocate's title-clearance report.
 *
 * The document follows the numbered legal sections a bank expects from a title
 * clearance report (owner, constitution, property description, documents
 * scrutinised, flow of title, statutory certificates), and folds the automated
 * verification into that structure: each finding is attached to the section it
 * affects, paragraph 18 carries the adverse remarks, and the complete machine
 * register is reproduced as Annexure B.
 *
 * Two rules govern every sentence here:
 *
 *   1. Nothing is invented. A fact that is not in the source is printed as
 *      missing and left for the Advocate to complete; the extractor has no
 *      fallback figures.
 *   2. The report never certifies itself. The certificate blocks are drafts for
 *      the Advocate's signature and say so, and the automated indicator is
 *      always labelled as a triage signal rather than an accuracy claim.
 */

export interface TcrReportInput {
  data: TcrData;
  report: VerificationReport;
  blocks: Block[];
  companyName?: string;
  generatedAt?: Date;
}

const MISSING = "Not stated in the source — to be confirmed by the Advocate from the original records.";

type Findings = VerificationReport["findings"];
type Finding = Findings[number];

const SEVERITY_LABEL: Record<string, string> = {
  critical: "CRITICAL",
  major: "MAJOR",
  minor: "MINOR",
  info: "INFO",
};

function present(value: string | undefined | null): value is string {
  // Underscores and bare dashes are the placeholders a form or a finding uses
  // for "not recorded"; printing them as if they were a value reads as noise.
  return Boolean(value && value.trim() && !/^[_—–-]+$/.test(value.trim()));
}

function orMissing(value: string | undefined | null): string {
  return present(value) ? value.trim() : MISSING;
}

/** Page-level OCR confidence, taking the worst block on a page. */
function pageConfidenceMap(blocks: Block[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const b of blocks) {
    const c = b.meta?.pageConfidence;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    const existing = map.get(b.pageNumber);
    map.set(b.pageNumber, existing == null ? c : Math.min(existing, c));
  }
  return map;
}

/**
 * True when an English sentence is too damaged to quote as evidence.
 *
 * OCR noise on a badly scanned page reaches the model as plausible-looking
 * prose, but it is not the document's wording. Quoting it in a legal report
 * would present a transcription error as the source's own language.
 */
function looksLikeOcrGarbage(s: string): boolean {
  if (/[\u0A80-\u0AFF\u0900-\u097F]/.test(s)) return true;
  // Asterisks and pipes are not punctuation this deed uses. They are what the
  // model emits when it tries to render a smudged glyph, e.g. "Xe *? AOAL
  // charge", which otherwise reads as plausible legal prose.
  if (/[*|]/.test(s)) return true;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 12) return true;
  const noise = (s.match(/[^A-Za-z0-9\s.,;:'"“”()\[\]\/&%₹$—–-]/g) ?? []).length;
  return noise / s.length > 0.12;
}

/** English sentences available for grounding a section, with their page. */
function englishSentences(blocks: Block[]): Array<{ page: number; text: string }> {
  const out: Array<{ page: number; text: string }> = [];
  const confidence = pageConfidenceMap(blocks);
  for (const b of blocks) {
    const pageConf = confidence.get(b.pageNumber);
    // A page the OCR could barely read is summarised, never quoted.
    if (pageConf != null && pageConf < LOW_OCR_CONFIDENCE) continue;
    const text = (b.targetText ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const sentence of text.split(/(?<=[.;])\s+(?=[A-Z0-9“"(])/)) {
      const s = sentence.trim();
      if (s.length >= 12 && !looksLikeOcrGarbage(s)) out.push({ page: b.pageNumber, text: s });
    }
  }
  return out;
}

/**
 * Quote the source's own wording for a section that the extractor cannot answer.
 *
 * Only the English side is used: dropping Gujarati into this document would
 * violate the English-deliverable rule, and the Gujarati is already reproduced
 * verbatim in the findings register where it is evidence rather than body text.
 */
function evidence(sentences: Array<{ page: number; text: string }>, re: RegExp, limit = 3): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    if (!re.test(s.text)) continue;
    const key = s.text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(`“${s.text}” (page ${s.page})`);
    if (hits.length >= limit) break;
  }
  return hits;
}

function mutationEntries(blocks: Block[]): string[] {
  const text = toAsciiDigits(
    blocks
      .slice()
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((b) => b.sourceText ?? "")
      .join("\n"),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  // "નોંધ નં.139", "નોંધ તં.1181" and OCR variants such as "નોંધ નં.ર546"
  // all label the same revenue entry; the leading "ર" is a misread "2".
  const re = /નોંધ\s*(?:નં|તં|સં)\.?\s*[:ઃ]?\s*([0-9\u0A80-\u0AFF]{2,6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? "").replace(/^ર/, "2");
    const entry = toAsciiDigits(raw).replace(/[^0-9]/g, "");
    // The date follows the entry number on the same line; read it from the tail
    // rather than making the date part of the entry match, which would let the
    // lazy quantifier stop before it.
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 90);
    const date = /\b([0-9]{2}\/[0-9]{2}\/[0-9]{4})\b/.exec(tail)?.[1];
    if (!entry) continue;
    const key = `${entry}|${date ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`Record-of-Rights mutation Entry No. ${entry}${date ? ` dated ${date}` : ""}.`);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Parse a dd/mm/yyyy date into a comparable time, or null when the string has
 * none. Used only to order revenue entries against the conveyance date.
 */
function dmyTime(s: string): number | null {
  const m = /\b([0-9]{2})\/([0-9]{2})\/([0-9]{4})\b/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

/**
 * Attach a finding to the sections whose facts it actually touches.
 *
 * Category alone is too coarse: a "Data fidelity" finding about the survey
 * number belongs under the property description, while one about stamp duty
 * belongs under the documents and the title certificate. Matching the finding's
 * own words against the vocabulary of each section is deliberately simple and
 * auditable — a reviewer can see why a remark appears where it does.
 */
function sectionsForFinding(f: Finding): number[] {
  // A glossary miss says the English chose a synonym, not that a section's fact
  // is wrong. It belongs in the register (and Annexure B), not beside the
  // property description where it reads as a title defect.
  if (f.check.startsWith("terminology.") || f.check.startsWith("term.")) return [18];

  // Structural and meaning-level findings are statements about the translation
  // as a whole ("this block is short", "this passage is untranslated"), not
  // about the property, the parties or the documents. Annotating paragraph 3
  // with "Block 44 is much shorter than its source" tells the reader nothing
  // about the boundaries and makes every section look defective.
  if (
    f.check.startsWith("structure.") ||
    f.check.startsWith("coverage.") ||
    f.check.startsWith("semantic.")
  ) {
    return [18];
  }

  // Match the finding's own claim, not its quoted evidence: an excerpt in a
  // property block mentions "land", so including excerpts attached every
  // finding on that page to the property description.
  const text = `${f.title} ${f.detail}`;
  const out = new Set<number>();

  const property = /\b(survey|block|khata|rsn|area|sq\.?\s*m|hectare|boundar|north|south|east|west|property|plot|parcel|land)\b/i.test(text);
  const owner = /\b(owner|seller|purchaser|vendee|vendor|heir|partition|name|executant|transferor|transferee)\b/i.test(text);
  const mutation = /\b(mutation|entry|note no|record of rights|ror|v\.?f\.?|khata)\b/i.test(text);
  const money = /\b(stamp|registration fee|consideration|challan|payment|amount|rs\.?|rupee|market value)\b/i.test(text);
  const document = /\b(deed|instrument|document|registered|sub-registrar|application|index|search report|encumbrance)\b/i.test(text);
  const possession = /\b(possession|handed over|delivered|occupied)\b/i.test(text);
  const encumbrance = /\b(encumbrance|mortgage|charge|lien|search report|EC)\b/i.test(text);

  if (property) {
    out.add(3);
    out.add(4);
  }
  if (owner) {
    out.add(1);
    out.add(7);
  }
  if (mutation) {
    out.add(4);
    out.add(7);
  }
  if (money) {
    out.add(5);
    out.add(16);
    out.add(19);
    out.add(21);
  }
  if (document) {
    out.add(5);
    out.add(19);
  }
  if (possession) out.add(6);
  if (encumbrance) out.add(14);

  out.add(18);
  return [...out].sort((a, b) => a - b);
}

function pageOfFinding(f: Finding): number | undefined {
  const m = /\bPage\s+(\d+)\b/i.exec(f.location);
  return m ? Number(m[1]) : undefined;
}

/**
 * Paragraph 18 is curated, not a dump of the machine register.
 *
 * The verification raises hundreds of number-difference findings on this deed,
 * most of them OCR artefacts. They stay in Annexure B. Paragraph 18 carries only
 * the remarks that can affect title or that warn the Advocate that a page was
 * unreadable, so the section remains a legal summary rather than a log.
 */
function isCuratedAdverse(f: Finding, d: TcrData, confidence: Map<number, number>): boolean {
  const page = pageOfFinding(f);
  const pageConf = page != null ? confidence.get(page) : undefined;
  const readablePage = pageConf == null || pageConf >= 0.7;
  const serious = f.severity === "critical" || f.severity === "major";

  switch (f.check) {
    case "structure.translation_missing":
      return true;
    case "structure.block_stunted":
    case "semantic.omission":
    case "semantic.scope":
      return serious && readablePage;
    case "terminology.not_present":
      return f.severity === "critical";
    case "datum.name_spelling_drift":
      return true;
    case "datum.currency_missing":
    case "datum.currency_changed": {
      // Money is worth a place at paragraph 18 only when the amount is the
      // consideration, stamp duty or registration fee itself. A stray "Rs. 23"
      // from an OCR-mangled receipt line is not a title remark.
      if (!serious || !readablePage) return false;
      const money = [d.consideration, d.stampDuty, d.regFee]
        .filter(present)
        .map((v) => v.replace(/[^0-9]/g, ""))
        .filter((v) => v.length >= 3);
      const numbers = (f.title.match(/\d[\d,]*/g) ?? []).map((x) => x.replace(/,/g, ""));
      return money.some((m) => numbers.includes(m));
    }
    default:
      return false;
  }
}

/**
 * Keep the per-section annotations to findings a reader can act on in that
 * section. The numeric/date register is exhaustive in Annexure B; repeating 200
 * OCR number differences under paragraph 3 buries the three that matter.
 */
function isMaterialForSection(f: Finding): boolean {
  // Name drift changes who the parties are and belongs beside the owner and
  // title narration. The remaining datum checks are exhaustive in Annexure B
  // and, on a scanned deed, mostly OCR number noise.
  if (f.check === "datum.name_spelling_drift") return true;
  if (f.check.startsWith("datum.")) return false;
  return true;
}

function humanizeCheck(check: string): string {
  return check
    .replace(/^[a-z]+\./, "")
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Strip Gujarati from a finding's prose, keeping the evidence fields untouched. */
function findingTitle(f: Finding): string {
  // A glossary finding names the Gujarati term and, in its detail, the English
  // equivalent the checker expected. Prefer that English term over a bare
  // "[Gujarati]" so paragraph 18 stays readable.
  const expected = /Expected\s+["“]([^"”]+)["”]/i.exec(f.detail)?.[1]?.trim();
  let sanitized = f.title
    .replace(/[“"]\s*[\u0A80-\u0AFF]+\s*[”"]/g, expected ? `“${expected}”` : "")
    .replace(/[\u0A80-\u0AFF]+/g, "[Gujarati]")
    .replace(/\s+/g, " ")
    .replace(/^\[Gujarati\]\s*/, "")
    .trim();
  if (expected) sanitized = sanitized.replace(/\[Gujarati\]/g, `“${expected}”`);
  return /[A-Za-z]{3,}/.test(sanitized) ? sanitized : humanizeCheck(f.check);
}

function englishProse(text: string): string {
  return text.replace(/[\u0A80-\u0AFF]+/g, "[Gujarati]").replace(/\s+/g, " ").trim();
}

/** Group page numbers into readable ranges: 15–17, 21, 23. */
function pageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const page of sorted.slice(1)) {
    if (page === prev + 1) {
      prev = page;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = page;
    prev = page;
  }
  if (start != null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(", ");
}

function severityRank(s: string): number {
  return s === "critical" ? 3 : s === "major" ? 2 : s === "minor" ? 1 : 0;
}

function indicatorText(r: VerificationReport): string {
  return `${(r.fidelityIndicator.value * 100).toFixed(1)}% (${r.fidelityIndicator.grade.toUpperCase()})`;
}

function statusText(r: VerificationReport): string {
  const status = r.status ?? "final";
  const audit = r.semanticAudit ?? "not recorded";
  return `${status === "draft" ? "DRAFT" : "FINAL"} · meaning-level review ${audit}`;
}

function dateText(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

interface Section {
  n: number;
  heading: string;
  body: string[];
  bullets?: string[];
  table?: Array<[string, string]>;
  findings?: Finding[];
}

function sectionHead(text: string): string {
  return text.trim().replace(/\s*:$/, "");
}

export function buildTcrReportItems(input: TcrReportInput): TcrItem[] {
  const { data: d, report: r, blocks } = input;
  const sentences = englishSentences(blocks);
  const confidence = pageConfidenceMap(blocks);
  const lowConfidencePages = [...confidence.entries()]
    .filter(([, c]) => c < LOW_OCR_CONFIDENCE)
    .map(([page]) => page)
    .sort((a, b) => a - b);
  const findings = r.findings;
  const bySection = new Map<number, Finding[]>();
  for (const f of findings) {
    if (!isMaterialForSection(f)) continue;
    for (const n of sectionsForFinding(f)) {
      const list = bySection.get(n) ?? [];
      list.push(f);
      bySection.set(n, list);
    }
  }

  // Paragraph 18 is curated: title-relevant remarks plus a warning for pages the
  // OCR could not read. The full machine register remains Annexure B.
  const adverseTitles = new Set<string>();
  const adverse = findings
    .filter((f) => isCuratedAdverse(f, d, confidence))
    .filter((f) => {
      const key = findingTitle(f);
      if (adverseTitles.has(key)) return false;
      adverseTitles.add(key);
      return true;
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  bySection.set(18, adverse);

  const address = present(input.companyName) ? input.companyName.trim() : present(d.addressee) ? d.addressee.trim() : "";
  const advocateName = config.advocate.name.trim();
  const advocatePhone = config.advocate.phone.trim();
  const advocateAddress = config.advocate.address.trim();
  const place = config.advocate.place.trim();

  const mutation = mutationEntries(blocks);

  // Paragraph 4 asks specifically whether the owner has been mutated in. On a
  // fresh conveyance the source often stops at the preceding re-survey entry and
  // never recites the purchaser's mutation, so the report must say the gap is
  // there rather than let a list of older entries imply it is covered.
  const mutationGap = (() => {
    const deedTime = present(d.deedDate) ? dmyTime(d.deedDate) : null;
    if (deedTime == null || mutation.length === 0) return "";
    const dated = mutation
      .map((m) => ({ m, t: dmyTime(m) }))
      .filter((x): x is { m: string; t: number } => x.t != null);
    if (dated.length === 0) return "";
    const latest = dated.reduce((a, b) => (b.t > a.t ? b : a));
    if (latest.t >= deedTime) return "";
    return (
      `Note: the latest revenue entry recited is ${latest.m.replace(/\.$/, "")}, which predates the conveyance dated ${d.deedDate}. ` +
      `No entry recording that conveyance${present(d.owner) ? ` in the name of ${d.owner}` : ""} is recited; ` +
      "whether the purchaser's name has since been mutated is to be confirmed from the current Record of Rights."
    );
  })();
  const deedLine = present(d.deedNo)
    ? `Registered instrument No. ${d.deedNo}${present(d.deedDate) ? ` dated ${d.deedDate}` : ""}${
        present(d.priorOwner) ? ` executed by ${d.priorOwner}` : ""
      }${present(d.owner) ? ` in favour of ${d.owner}` : ""}.`
    : present(d.owner)
      ? `The instrument or order by which ${d.owner} derives title, as recited in the source.`
      : "";

  const documents: string[] = [];
  if (present(d.rsn) || present(d.khata)) {
    documents.push(
      `Certified copy of the Record of Rights (Village Form No. 6 / 7-12)${
        present(d.rsn) ? ` for Survey No. ${d.rsn}` : ""
      }${present(d.khata) ? `, Khata No. ${d.khata}` : ""}.`,
    );
  }
  for (const m of mutation) documents.push(`Certified copy of ${m}`);
  if (present(d.priorDeedNo) || present(d.priorDeedDate)) {
    const prior = [
      present(d.priorDeedNo) ? `No. ${d.priorDeedNo}` : "",
      present(d.priorDeedDate) ? `dated ${d.priorDeedDate}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    documents.push(
      `Prior registered Sale Deed${prior ? ` ${prior}` : ""}${
        present(d.partitionOwner) ? ` executed by ${d.partitionOwner}` : ""
      }${present(d.priorOwner) ? ` in favour of ${d.priorOwner}` : ""}.`,
    );
  }
  if (deedLine) documents.push(deedLine);
  if (present(d.stampDuty) || present(d.regFee) || present(d.appNo)) {
    const ref = present(d.appNo)
      ? `Application No. ${d.appNo}${present(d.appDate) ? `, printed ${d.appDate}` : ""}`
      : "as recited in the source";
    const paid = [
      present(d.stampDuty) ? `stamp duty ${d.stampDuty}` : "",
      present(d.regFee) ? `registration fee ${d.regFee}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    documents.push(`e-Challan / registration receipt (${ref})${paid ? ` — ${paid} paid` : ""}.`);
  }
  if (documents.length === 0) {
    documents.push("No document list could be derived from the source; annex the title deeds before relying on this paragraph.");
  }

  const possessionEvidence = evidence(sentences, /\b(possession|handed over|delivered)\b/i, 2);
  const sanctionEvidence = evidence(sentences, /\b(sanction|permission|no objection|NOC|approved plan|approval)\b/i, 2);
  const commencementEvidence = evidence(sentences, /\b(commencement|occupation certificate|completion certificate|occupancy)\b/i, 2);
  const taxEvidence = evidence(sentences, /\b(property tax|municipal tax|tax receipt|land revenue)\b/i, 2);
  const governmentEvidence = evidence(sentences, /\b(government (?:claim|due)|revenue due|panchayat due)\b/i, 2);
  const minorEvidence = evidence(sentences, /\b(minor|guardian|minority)\b/i, 2);
  // Only a statement that the property is *free of* an encumbrance belongs
  // under §14. A powers clause that lets the owner "sell, mortgage, lease" also
  // contains the word "mortgage" but says nothing about existing charges.
  const encumbranceEvidence = evidence(
    sentences,
    /(?:not|no|none|never|free from|free of|unencumbered)[^.]{0,80}(?:encumbrance|mortgage|charge|lien)|(?:encumbrance|mortgage|charge|lien)[^.]{0,60}(?:none|not|free|clear)/i,
    2,
  );

  const naEvidence = evidence(sentences, /\b(non-agricultural|N\.A\.|NA order|conversion order)\b/i, 2);
  const agricultural = naEvidence.length
    ? `Non-Agricultural land${naEvidence[0] ? `: ${naEvidence[0]}` : ""}`
    : /\bagricultural\b/i.test(sentences.map((s) => s.text).join(" "))
      ? "Agricultural land, as described in the source."
      : MISSING;

  const propertySentence = present(d.propertyBody) ? d.propertyBody : MISSING;

  const sections: Section[] = [
    {
      n: 1,
      heading: "Name of the Owner/Mortgagor",
      body: [orMissing(d.owner)],
      findings: bySection.get(1),
    },
    {
      n: 2,
      heading: "Constitution of the Owner",
      body: [orMissing(d.constitution)],
    },
    {
      n: 3,
      heading: "Complete description of the property including boundaries",
      body: [propertySentence],
      table: d.boundaries.length
        ? d.boundaries.map((b) => [`Towards ${b.label}`, b.value] as [string, string])
        : ([
            ["Towards North", "Not stated in the source"],
            ["Towards South", "Not stated in the source"],
            ["Towards East", "Not stated in the source"],
            ["Towards West", "Not stated in the source"],
          ] as Array<[string, string]>),
      findings: bySection.get(3),
    },
    {
      n: 4,
      heading:
        "Whether the property has been mutated in the name(s) of the person(s) offering the mortgage, and whether there is any discrepancy in the mutation details and title deed",
      body: mutation.length
        ? ["The source records the following revenue entries in the chain of title:"]
        : ["No mutation entry is recorded in the source, so mutation in the name of the owner is not established by this document alone."],
      bullets: mutation.length ? [...mutation, ...(mutationGap ? [mutationGap] : [])] : undefined,
      findings: bySection.get(4),
    },
    {
      n: 5,
      heading: "Documents scrutinised",
      body: ["The following documents are recited in, or annexed to, the source:"],
      bullets: documents,
      findings: bySection.get(5),
    },
    {
      n: 6,
      heading: "Whether the chain title deeds have been handed over to the mortgagor in terms of the agreement/sale deed",
      body: possessionEvidence.length
        ? possessionEvidence
        : ["Not recorded in the source — to be confirmed by the Advocate from the originals."],
    },
    {
      n: 7,
      heading:
        "Narration on flow of title including document details in chronological order (title derived through partition, will, gift, court order or out of a larger extent of land to be highlighted)",
      body: [
        "The chronological account below is taken from the recitals of the source and from the English translation verified in this report.",
        present(d.propertyBody) ? `The property is described as: ${d.propertyBody}` : MISSING,
      ],
      bullets: d.flow.length
        ? d.flow
        : [
            ...mutation.map((m) => `Revenue record: ${m}`),
            ...(deedLine ? [deedLine] : []),
          ],
      findings: bySection.get(7),
    },
    {
      n: 8,
      heading:
        "Simple mutation as a valid document or not — whether title in favour of the current or any previous owner rests on a simple mutation or notarised/affidavit agreement instead of a registered will, release or probate; compulsory registration of a power of attorney",
      body: [
        present(d.deedNo)
          ? `The instrument recited in the source is registered Sale Deed No. ${d.deedNo}${present(d.deedDate) ? ` dated ${d.deedDate}` : ""}, supported by the revenue mutations recorded at paragraph 4.`
          : "The instrument recited in the source is described at paragraph 5, supported by the revenue mutations recorded at paragraph 4.",
        "Whether any link in the chain rests on a simple mutation alone, or on an unregistered power of attorney, is to be confirmed by the Advocate against the certified Record of Rights and the Sub-Registrar's index.",
      ],
    },
    {
      n: 9,
      heading: "Sanctions / permissions / NOCs / plans from competent authorities, if any, to be obtained",
      body: sanctionEvidence.length
        ? sanctionEvidence
        : ["No sanction, permission, NOC or sanctioned plan is recorded in the source."],
    },
    {
      n: 10,
      heading: "Certificate of commencement / occupation / completion / possession receipt",
      body: commencementEvidence.length
        ? commencementEvidence
        : ["Not recorded in the source — to be obtained from the competent authority where applicable."],
    },
    {
      n: 11,
      heading: "Confirmation on payment of property tax in the name of the current owner",
      body: taxEvidence.length
        ? taxEvidence
        : ["No property-tax receipt is recited in the source. Current receipts in the owner's name should be collected by the Bank."],
    },
    {
      n: 12,
      heading: "Government claims (the Advocate should specify any government claim on the property)",
      body: governmentEvidence.length
        ? governmentEvidence
        : ["No government claim or revenue due is recorded in the source."],
    },
    {
      n: 13,
      heading: "Minors — whether the property is subject to any minor's or other claim",
      body: minorEvidence.length
        ? minorEvidence
        : ["No claim by or on behalf of a minor is recorded in the source."],
    },
    {
      n: 14,
      heading: "Certificate on search reports / encumbrance certificates (EC) scrutinised",
      body: [
        "No search report or encumbrance certificate is annexed to the source. A fresh EC / Sub-Registrar search for not less than 13/30 years before the mortgage must be obtained and any entry it discloses must be read with this report.",
        ...(encumbranceEvidence.length ? [`The source itself records: ${encumbranceEvidence.join(" ")}`] : []),
      ],
    },
    {
      n: 15,
      heading: "Type of mortgage to be created",
      body: [
        "Equitable mortgage by deposit of title deeds — as advised by the Bank. Registration — as advised by the Bank and the Sub-Registrar.",
      ],
    },
    {
      n: 16,
      heading: "Description of the inspection receipt issued by the Sub-Registrar (number, date, and the year-wise search report)",
      body: [
        ...(present(d.appNo) || present(d.deedNo)
          ? [
              `The source records the registration under ${
                present(d.deedNo) ? `Sale Deed No. ${d.deedNo}${present(d.deedDate) ? ` dated ${d.deedDate}` : ""}` : "the instrument described at paragraph 5"
              }${present(d.appNo) ? `, Application No. ${d.appNo}${present(d.appDate) ? ` printed on ${d.appDate}` : ""}` : ""}.`,
            ]
          : []),
        ...(present(d.stampDuty) || present(d.regFee)
          ? [
              `Stamp duty${present(d.stampDuty) ? ` of ${d.stampDuty}` : ""}${
                present(d.regFee) ? ` and registration fee of ${d.regFee}` : ""
              } are recorded as paid in the e-Challan.`,
            ]
          : []),
        "The Sub-Registrar's inspection receipt and the year-wise search report are not part of the source — to be obtained and completed by the Advocate.",
      ],
    },
    {
      n: 17,
      heading:
        "Where the property involves land: whether it is agricultural or non-agricultural (N.A.), whether a conversion order is available, and whether the use matches the sanctioned plan",
      body: [agricultural],
    },
    {
      n: 18,
      heading: "Adverse remarks on title (if any), as per the guidelines affecting title",
      body: [
        ...(adverse.length
          ? [
              `${adverse.length} title-relevant remark(s) arise from the automated verification of the English translation. They are recorded here for the Advocate's decision; they are not findings on title itself.`,
            ]
          : [
              "No title-relevant remark arises from the automated verification. This is not a title opinion: the Advocate must still satisfy himself from the originals.",
            ]),
        ...(lowConfidencePages.length
          ? [
              `${lowConfidencePages.length} source page(s) were read at low OCR confidence (page ${pageRanges(lowConfidencePages)}). Passages from those pages are summarised rather than quoted, and every fact taken from them must be checked against the original before reliance.`,
            ]
          : []),
      ],
      // One line per remark. The sentence-level detail and the recommended
      // action live in the findings register, so repeating them here would
      // double the length of the report without adding anything a reader can
      // act on at paragraph 18.
      bullets: [
        ...adverse.map((f) => {
          const registerNo = findings.indexOf(f) + 1;
          return `[${SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase()}] ${findingTitle(f)}${present(f.location) ? ` — ${f.location}` : ""} (Annexure B, item ${registerNo}).`;
        }),
        ...(lowConfidencePages.length
          ? [
              `[WARNING] Verify pages ${pageRanges(lowConfidencePages)} against the original: the OCR confidence for those pages is below ${Math.round(
                LOW_OCR_CONFIDENCE * 100,
              )}%, so the English there may contain a transcription error rather than the source's wording.`,
            ]
          : []),
      ],
    },
    {
      n: 19,
      heading: "Documents to be deposited for creating equitable mortgage (original / photocopy / certified copy to be specified)",
      body: ["Originals of the registered instrument and certified copies of the revenue record, to be deposited with the Bank:"],
      bullets: documents,
    },
    {
      n: 20,
      heading: "Remarks",
      body: [
        `Automated quality indicator: ${indicatorText(r)} — a review-prioritisation score, not a measure of translation accuracy.   Report status: ${statusText(r)}.`,
        `Meaning-level review: ${r.semanticAudit ?? "not recorded"}.`,
        ...r.narrative.limitations.map((l) => `Limitation: ${l}`),
        "Paragraphs 21 and 22 are drafts for the Advocate's signature. The automated system has not investigated title and does not certify this report.",
        "This report is an automated verification of the English translation. It is not a title search, and no statement in it should be read as a substitute for the Advocate's own search and inspection.",
      ],
    },
    {
      n: 21,
      heading: "Certificate on title & marketability of property",
      body: [
        present(d.owner)
          ? `THIS IS TO CERTIFY that ${d.owner} is the owner of the property more particularly described in paragraph 3 above, having derived title under ${
              present(d.deedNo)
                ? `registered Sale Deed No. ${d.deedNo}${present(d.deedDate) ? ` dated ${d.deedDate}` : ""}`
                : "the registered instrument recited in this report"
            }${present(d.stampDuty) ? `, duly stamped (${d.stampDuty})` : ""}${
              present(d.appNo) ? ` and registered under Application No. ${d.appNo}` : ""
            }, and that on the basis of the documents and recitals referred to above the title is clear and marketable and free from encumbrances${
              adverse.length
                ? ", subject to the remarks recorded at paragraph 18 and Annexure B being resolved"
                : ""
            }.`
          : `THIS IS TO CERTIFY that the owner named in the source is the owner of the property more particularly described in paragraph 3 above, having derived title under the registered instrument recited in this report, subject to the findings recorded at paragraph 18 and Annexure B.`,
      ],
    },
    {
      n: 22,
      heading:
        "Certificate on enforceability of the property under the Securitisation and Reconstruction of Financial Assets and Enforcement of Security Interest Act, 2002 (SARFAESI Act)",
      body: [
        `This is to certify that the property is enforceable under the SARFAESI Act, 2002, subject to the original documents referred to in paragraph 19 being deposited with ${
          address || "the Bank"
        } together with the registered deed of mortgage.`,
      ],
    },
  ];

  const items: TcrItem[] = [];

  // ── Masthead, date, title, addressee ────────────────────────────────────────
  items.push({
    t: "p",
    text: `${advocateName || "________________________________"}\t\t${advocatePhone ? `M: ${advocatePhone}` : ""}`.trimEnd(),
    bold: true,
    align: "center",
    size: 24,
  });
  items.push({ t: "p", text: "(Advocate)", align: "center" });
  items.push({
    t: "p",
    text: advocateAddress ? `Office: ${advocateAddress}` : "Office: ____________________________________________________",
    align: "center",
  });
  items.push({ t: "p", text: `Date: ${dateText(input.generatedAt ?? new Date())}`, bold: true });
  items.push({ t: "h1", text: "TITLE CLEARANCE REPORT" });
  items.push({ t: "p", text: `To,`, bold: true });
  items.push({ t: "p", text: `The Manager,`, bold: true });
  items.push({ t: "p", text: address || "________________________________", bold: true });
  items.push({ t: "p", text: place || "________________", bold: true });
  items.push({ t: "p", text: "", bold: true });
  items.push({
    t: "p",
    text: `${r.docTypeLabel} · ${r.pageCount} page(s) · ${r.segmentCount} translation segment(s) · ${statusText(r)}`,
    italic: true,
    align: "center",
  });
  items.push({ t: "p", text: "" });

  // ── Numbered sections ───────────────────────────────────────────────────────
  for (const section of sections) {
    items.push({ t: "h2", text: `${section.n}.  ${sectionHead(section.heading)}:` });
    for (const para of section.body) items.push({ t: "p", text: para, align: "justify" });
    if (section.table) items.push({ t: "borders", rows: section.table });
    if (section.bullets) items.push({ t: "bullets", items: section.bullets });
    if (section.findings && section.findings.length) {
      const label = section.n === 18 ? "Automated verification" : "Corresponding automated finding(s)";
      items.push({
        t: "p",
        text: `${label}: ${section.findings.length} — ${section.findings
          .slice(0, 4)
          .map((f) => `${SEVERITY_LABEL[f.severity] ?? f.severity}: ${findingTitle(f)}`)
          .join("; ")}${section.findings.length > 4 ? "; …" : ""}. See Annexure B.`,
        italic: true,
        size: 18,
      });
    }
    items.push({ t: "p", text: "" });
  }

  // Signature before the certificates' own blocks is intentionally omitted: the
  // sample signs once, after the certificate, and a second blank block would let
  // a reviewer think the report had already been signed.
  items.push(...signatureBlock(advocateName, place));
  items.push({ t: "page" });

  // ── Annexure A: the mechanical record ──────────────────────────────────────
  items.push({ t: "h1", text: "ANNEXURE A — AUTOMATED VERIFICATION RECORD" });
  items.push({
    t: "p",
    text: "Every check below ran on the English translation and its Gujarati source. A FLAG does not by itself mean the translation is wrong; it identifies the passage a reviewer must read.",
    italic: true,
  });
  items.push({ t: "p", text: "" });
  items.push({
    t: "table",
    header: ["Check", "Result", "Items", "Basis"],
    rows: r.mechanicalChecks.map((c) => [
      c.check,
      c.pending ? "PENDING" : c.passed ? "PASS" : "FLAG",
      String(c.count),
      c.description,
    ]),
  });
  items.push({ t: "p", text: "" });
  items.push({ t: "p", text: "Indicator components", bold: true });
  items.push({
    t: "bullets",
    items: Object.entries(r.fidelityIndicator.components).map(([k, v]) => `${k}: ${(v * 100).toFixed(1)}%`),
  });
  items.push({
    t: "p",
    text: `Automated quality indicator: ${indicatorText(r)}. ${r.fidelityIndicator.interpretation}`,
    italic: true,
  });
  items.push({ t: "page" });

  // ── Annexure B: the findings register ──────────────────────────────────────
  items.push({ t: "h1", text: `ANNEXURE B — FINDINGS REGISTER (${findings.length})` });
  items.push({
    t: "p",
    text: "Each entry states the finding, the passage it affects, and the action required before the translation is relied on. Gujarati excerpts are reproduced verbatim as evidence.",
    italic: true,
  });
  items.push({ t: "p", text: "" });
  if (findings.length === 0) {
    items.push({ t: "p", text: "No findings were raised by the automated checks." });
  } else {
    findings.forEach((f, i) => {
      items.push({
        t: "p",
        text: `${i + 1}.  [${SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase()}]  ${findingTitle(f)}`,
        bold: true,
      });
      items.push({ t: "p", text: [f.location, f.category, f.check].filter((v) => present(v)).join(" · "), size: 18 });
      items.push({ t: "p", text: englishProse(f.detail), align: "justify" });
      if (f.suggestion) items.push({ t: "p", text: `Action: ${englishProse(f.suggestion)}`, italic: true });
      if (f.sourceExcerpt) items.push({ t: "p", text: `Gujarati: ${f.sourceExcerpt}`, size: 17 });
      if (f.targetExcerpt) items.push({ t: "p", text: `English: ${f.targetExcerpt}`, size: 17 });
      items.push({ t: "p", text: "" });
    });
  }

  items.push({ t: "p", text: "" });
  items.push(...signatureBlock(advocateName, place));
  items.push({ t: "p", text: "" });
  items.push({
    t: "p",
    text:
      `Machine-generated draft — NOT CERTIFIED. Automated quality indicator: ${indicatorText(r)}. ` +
      "Prepared from the English translation of the source; it must be checked against the original and signed by the Advocate before it is relied on.",
    italic: true,
    size: 17,
  });
  items.push({
    t: "p",
    text: `${r.docTypeLabel} · Source: ${r.fileName} · SHA-256: ${r.sourceSha256} · Generated: ${r.generatedAt}`,
    italic: true,
    size: 15,
  });

  return items;
}

function signatureBlock(advocateName: string, place: string): TcrItem[] {
  return [
    { t: "p", text: "" },
    { t: "p", text: `Place: ${place || "________________"}`, bold: true },
    { t: "p", text: `Date:  ________________`, bold: true },
    { t: "p", text: "____________________________", align: "right" },
    { t: "p", text: advocateName || "(______________________)", bold: true, align: "right" },
    { t: "p", text: "Advocate", bold: true, align: "right" },
  ];
}

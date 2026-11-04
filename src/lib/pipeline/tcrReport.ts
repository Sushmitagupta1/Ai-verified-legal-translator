import type { Block } from "../domain";
import { config } from "../config";
import { toAsciiDigits } from "../domain/gujarati";
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

/** English sentences available for grounding a section, with their page. */
function englishSentences(blocks: Block[]): Array<{ page: number; text: string }> {
  const out: Array<{ page: number; text: string }> = [];
  for (const b of blocks) {
    const text = (b.targetText ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const sentence of text.split(/(?<=[.;])\s+(?=[A-Z0-9“"(])/)) {
      const s = sentence.trim();
      if (s.length >= 12) out.push({ page: b.pageNumber, text: s });
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
  const text = blocks
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((b) => b.sourceText ?? "")
    .join("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  // "નોંધ નં.139", "નોંધ તં.1181" and OCR variants such as "નોંધ નં.ર546"
  // all label the same revenue entry; the leading "ર" is a misread "2".
  const re = /નોંધ\s*(?:નં|તં|સં)\.?\s*[:ઃ]?\s*([0-9\u0A80-\u0AFF]{2,6})[^\n]{0,40}?(?:તા\.?\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4}))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? "").replace(/^ર/, "2");
    const entry = toAsciiDigits(raw).replace(/[^0-9]/g, "");
    const date = m[2];
    if (!entry) continue;
    const key = `${entry}|${date ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`Record-of-Rights mutation Entry No. ${entry}${date ? ` dated ${date}` : ""}.`);
    if (out.length >= 12) break;
  }
  return out;
}

function sectionsForFinding(f: Finding): number[] {
  switch (f.category) {
    case "Names":
      return [1, 18];
    case "Dates":
      return [3, 18];
    case "Data fidelity":
      return [3, 4, 18];
    case "Coverage":
      return [5, 18];
    case "Terminology":
      return [18];
    case "Semantic fidelity":
      return [18];
    default:
      return [18];
  }
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
  const findings = r.findings;
  const bySection = new Map<number, Finding[]>();
  for (const f of findings) {
    for (const n of sectionsForFinding(f)) {
      const list = bySection.get(n) ?? [];
      list.push(f);
      bySection.set(n, list);
    }
  }

  // Paragraph 18 is the adverse-remarks section: every critical/major finding
  // belongs there, regardless of which other section it also annotates.
  const adverse = findings
    .filter((f) => f.severity === "critical" || f.severity === "major")
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  bySection.set(18, adverse);

  const address = present(input.companyName) ? input.companyName.trim() : present(d.addressee) ? d.addressee.trim() : "";
  const advocateName = config.advocate.name.trim();
  const advocatePhone = config.advocate.phone.trim();
  const advocateAddress = config.advocate.address.trim();
  const place = config.advocate.place.trim();

  const mutation = mutationEntries(blocks);
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
  const encumbranceEvidence = evidence(sentences, /\b(encumbrance|charge|mortgage|lien|search report)\b/i, 2);

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
      bullets: mutation.length ? mutation : undefined,
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
        present(d.deedNo) || present(d.owner)
          ? `By ${deedLine.charAt(0).toLowerCase()}${deedLine.slice(1)}${
              present(d.consideration) ? ` The consideration recited is ${d.consideration}.` : ""
            }`
          : MISSING,
      ],
      bullets: [
        ...(present(d.propertyBody) ? [`The property is described as: ${d.propertyBody}`] : []),
        ...mutation.map((m) => `Revenue record: ${m}`),
        ...(possessionEvidence.length ? [`Possession / handover: ${possessionEvidence.join(" ")}`] : []),
      ],
      findings: bySection.get(7),
    },
    {
      n: 8,
      heading:
        "Simple mutation as a valid document or not — whether title in favour of the current or any previous owner rests on a simple mutation or notarised/affidavit agreement instead of a registered will, release or probate; compulsory registration of a power of attorney",
      body: [
        present(d.deedNo)
          ? "The link in the chain recited in the source is a registered instrument, supported by the revenue mutations recorded above. Whether any earlier link rests on a simple mutation alone, or on an unregistered power of attorney, is to be confirmed by the Advocate against the certified Record of Rights and the Sub-Registrar's index."
          : "No registered instrument number is recited in the source, so the instrument on which the current title rests is not established by this document alone. Whether any link in the chain rests on a simple mutation alone, or on an unregistered power of attorney, is to be confirmed by the Advocate against the certified Record of Rights and the Sub-Registrar's index.",
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
      body: ["Not available from the source — to be completed by the Advocate from the Sub-Registrar's inspection receipts."],
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
      body: adverse.length
        ? [
            `${adverse.length} critical or major finding(s) arise from the automated verification of the English translation. They are recorded here for the Advocate's decision; they are not findings on title itself.`,
          ]
        : [
            "No critical or major finding arises from the automated verification. This is not a title opinion: the Advocate must still satisfy himself from the originals.",
          ],
      // One line per remark. The sentence-level detail and the recommended
      // action live in the findings register, so repeating them here would
      // double the length of the report without adding anything a reader can
      // act on at paragraph 18.
      bullets: adverse.length
        ? adverse.map((f) => {
            const registerNo = findings.indexOf(f) + 1;
            return `[${SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase()}] ${f.title}${present(f.location) ? ` — ${f.location}` : ""} (Annexure B, item ${registerNo}).`;
          })
        : undefined,
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
          ? `THIS IS TO CERTIFY that ${d.owner} is the owner of the property more particularly described in paragraph 3 above, having derived title under the registered instrument recited in this report, and that on the basis of the documents and recitals referred to above the title is clear and marketable and free from encumbrances${
              adverse.length
                ? ", subject to the critical and major findings recorded at paragraph 18 and Annexure B being resolved"
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
          .map((f) => `${SEVERITY_LABEL[f.severity] ?? f.severity}: ${f.title}`)
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
        text: `${i + 1}.  [${SEVERITY_LABEL[f.severity] ?? f.severity.toUpperCase()}]  ${f.title}`,
        bold: true,
      });
      items.push({ t: "p", text: [f.location, f.category, f.check].filter((v) => present(v)).join(" · "), size: 18 });
      items.push({ t: "p", text: f.detail, align: "justify" });
      if (f.suggestion) items.push({ t: "p", text: `Action: ${f.suggestion}`, italic: true });
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

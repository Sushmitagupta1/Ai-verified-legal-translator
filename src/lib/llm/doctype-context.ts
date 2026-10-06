import { DOC_TYPE_META, type DocType, type DocTypeMeta } from "../domain/doctypes";

/** Registers and the voice rules each one implies. */
export const REGISTER_RULES: Record<DocTypeMeta["register"], string> = {
  judgment:
    "A judicial decision. Third person, present/past tense as the court uses it. " +
    "Refer to the bench as 'the learned Court', to parties by their established English designations " +
    "(Plaintiff/Defendant, Petitioner/Respondent, Applicant/Respondent, Accused, Appellant). " +
    "Quote the operative order faithfully and set it out as an operative order.",
  order:
    "A court order. Numbered operative clauses ('ORDER: 1. ... 2. ...'). " +
    "Direct, impersonal, no narrative beyond what the court recorded. Preserve exactly which directions " +
    "are 'directed', 'ordered' or 'observed'.",
  correspondence:
    "A legal notice or letter. Second person for the addressee ('you are hereby put on notice'), " +
    "'the Advises'/'our client' for the sender, imperative mood for the demand, " +
    "'unless otherwise informed' for the deadline clause. Preserve salutation and closing formula.",
  instrument:
    "A deed, agreement or property instrument. Run-on contractual register with 'WHEREAS' recitals, " +
    "first/second party definitions, and operative clauses. Keep the clause numbering and 'set forth' " +
    "operative language verbatim where possible.",
  application:
    "A pleading or application. 'The Applicant/Applicant states that ...' through enumerated paragraphs, " +
    "closing with a prayer ('It is therefore respectfully prayed that ...'). " +
    "Preserve the paragraph numbering because the court orders by reference to it.",
  statutory:
    "A statutory or police form. Follow the form's own field order and wording conventions. " +
    "Preserve statutory short-forms and section numbers exactly as printed.",
};

/** Designations that must stay consistent once the document establishes them. */
export const PARTY_DESIGNATION_NOTES =
  "Once a party is given an English designation in the heading, reuse that exact designation for every " +
  "later mention. Do not alternate between 'the accused', 'the said accused' and 'the Appellant' for the " +
  "same person. If the source switches designation, the target must switch at the same point.";

export const EXHIBIT_NOTES =
  "Exhibit labels (Ex. A, Exhibit P-1, 'Annexure A') are identifiers, not prose. Reproduce them " +
  "unchanged and keep them attached to the same item they label.";

export const docTypeMeta = (t: string): DocTypeMeta =>
  DOC_TYPE_META[t as DocType] ?? DOC_TYPE_META.other_legal;

/** Extra rules layered on top of the base register. */
export function docTypeSpecificNotes(docType: string): string[] {
  switch (docType) {
    case "court_judgment":
      return [
        "Preserve the cause title exactly as printed at the head of the judgment, including 'v.' and any abbreviations.",
        "Findings, issue framing and the final ratio each get their own paragraph; do not merge them.",
        "If the court quotes a statute or a previous judgment, keep the quotation visually distinct.",
      ];
    case "court_order":
      return [
        "If the order recites a prior appearance or a prayer, keep the recitation before the operative directions.",
        "Costs, stay and liberty-to-apply clauses must each remain separately numbered.",
      ];
    case "legal_notice":
      return [
        "The demand, the consequence of default, and the deadline are three distinct elements. Keep all three.",
        "Preserve any 'copy to' list at the end.",
      ];
    case "fir_document":
      return [
        "Preserve the FIR number, police station, and the 'Schedule of Offences' section numbers verbatim.",
        "Section numbers in the schedule are statutory identifiers; never renumber or map them to a new Act.",
      ];
    case "police_report":
      return [
        "Preserve the report's own headings and the order in which statements appear.",
        "Statements attributed to an accused must stay attributed in the target.",
      ];
    case "property_document":
      return [
        "Survey/block/plot numbers, area figures, boundaries and consideration amounts must survive exactly.",
        "If the source is a Gujarati land-record extract (7/12), keep the record heading as printed.",
      ];
    case "agreement":
    case "contract":
      return [
        "Definitions in the interpretation clause govern the rest of the document; apply them consistently.",
        "Clause numbering is contractual structure. Never renumber, merge or split a clause.",
      ];
    case "bail_application":
      return [
        "Distinguish 'bail' (જામીન) from 'remand' (જામીનત જામીન') — conflating them reverses the order.",
        "Keep the specific sections relied on (Section 437A / 438 / 439 / 440 CrPC or BNSS) verbatim.",
      ];
    case "writ_petition":
      return [
        "Name the exact writ sought (mandamus, habeas corpus, certiorari, prohibition, quo warranto) as the source does.",
        "Keep Article 32 / 226 / 227 references verbatim.",
      ];
    case "affidavit":
      return [
        "Preserve the deponent's personal particulars, the verification clause and the seal block verbatim.",
      ];
    default:
      return [];
  }
}

export function buildDocContext(args: {
  docType: string;
  confidence?: number | null;
  pageCount?: number | null;
  fileName?: string;
  ocrConfidence?: number | null;
  totalChars?: number | null;
}): string {
  const m = docTypeMeta(args.docType);
  const bits = [`Document type: ${m.label}`, `Register for this type: ${REGISTER_RULES[m.register]}`];

  const extra = docTypeSpecificNotes(args.docType);
  if (extra.length > 0) {
    bits.push(`Type-specific requirements:\n- ${extra.join("\n- ")}`);
  }

  bits.push(PARTY_DESIGNATION_NOTES, EXHIBIT_NOTES);

  if (args.confidence != null) {
    bits.push(
      `Type-detection confidence ${Math.round(args.confidence * 100)}%. ` +
        (args.confidence < 0.6
          ? "The type was uncertain. Translate conservatively and flag anything the type choice would affect."
          : "The type is well established."),
    );
  }
  if (args.pageCount) bits.push(`Pages: ${args.pageCount}`);
  if (args.fileName) bits.push(`File: ${args.fileName}`);
  if (args.totalChars) bits.push(`Source length: ${args.totalChars.toLocaleString("en-IN")} characters`);
  if (args.ocrConfidence != null) {
    bits.push(
      `The source text was machine-read by OCR at mean confidence ${(args.ocrConfidence * 100).toFixed(1)}%. ` +
        "Where the Gujarati is unclear, prefer the reading that keeps names and numbers intact, and note the " +
        "uncertainty rather than guessing.",
    );
  }

  return bits.join("\n\n");
}
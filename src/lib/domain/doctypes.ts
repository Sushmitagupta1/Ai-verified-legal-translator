/**
 * Canonical types. New document types are added here plus a detection rule in
 * `doctypes.ts`; nothing else in the codebase needs to change.
 */
export const DOC_TYPES = [
  "court_judgment",
  "court_order",
  "legal_notice",
  "fir_document",
  "police_report",
  "government_order",
  "agreement",
  "contract",
  "property_document",
  "legal_application",
  "affidavit",
  "complaint",
  "bail_application",
  "writ_petition",
  "other_legal",
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export interface DocTypeMeta {
  id: DocType;
  label: string;
  /** Short label used in dense table cells. */
  short: string;
  description: string;
  /** Which translation register to use. */
  register: "judgment" | "order" | "correspondence" | "instrument" | "application" | "statutory";
}

export const DOC_TYPE_META: Record<DocType, DocTypeMeta> = {
  court_judgment: {
    id: "court_judgment",
    label: "Court Judgment",
    short: "Judgment",
    description: "A reasoned judicial decision with findings of fact and law.",
    register: "judgment",
  },
  court_order: {
    id: "court_order",
    label: "Court Order",
    short: "Order",
    description: "A disposal order, interim order or procedural order of a court.",
    register: "order",
  },
  legal_notice: {
    id: "legal_notice",
    label: "Legal Notice",
    short: "Notice",
    description: "Pre-litigation notice or legal demand from an advocate or party.",
    register: "correspondence",
  },
  fir_document: {
    id: "fir_document",
    label: "FIR / Police Document",
    short: "FIR",
    description: "First Information Report, its registration extract or related police record.",
    register: "statutory",
  },
  police_report: {
    id: "police_report",
    label: "Police Report",
    short: "Police",
    description: "Investigation report, charge sheet, custody record or police report.",
    register: "statutory",
  },
  government_order: {
    id: "government_order",
    label: "Government Order",
    short: "Govt. Order",
    description: "Notification, GR, circular or administrative order of a government body.",
    register: "order",
  },
  agreement: {
    id: "agreement",
    label: "Agreement",
    short: "Agreement",
    description: "Settlement deed, MOU, lease or other consensual arrangement.",
    register: "instrument",
  },
  contract: {
    id: "contract",
    label: "Contract",
    short: "Contract",
    description: "Contract, purchase agreement or commercial instrument.",
    register: "instrument",
  },
  property_document: {
    id: "property_document",
    label: "Property Document",
    short: "Property",
    description: "Sale deed, mortgage deed, partition deed, land record extract or title document.",
    register: "instrument",
  },
  legal_application: {
    id: "legal_application",
    label: "Legal Application",
    short: "Application",
    description: "Application, petition or affidavit filed in a proceeding.",
    register: "application",
  },
  affidavit: {
    id: "affidavit",
    label: "Affidavit",
    short: "Affidavit",
    description: "Sworn statement of a party or witness.",
    register: "application",
  },
  complaint: {
    id: "complaint",
    label: "Complaint",
    short: "Complaint",
    description: "Plaint, written complaint or grievance representation.",
    register: "application",
  },
  bail_application: {
    id: "bail_application",
    label: "Bail Application",
    short: "Bail",
    description: "Anticipatory or regular bail application with supporting grounds.",
    register: "application",
  },
  writ_petition: {
    id: "writ_petition",
    label: "Writ Petition",
    short: "Writ",
    description: "Writ petition under Article 226 or 227 of the Constitution.",
    register: "application",
  },
  other_legal: {
    id: "other_legal",
    label: "Other Legal Document",
    short: "Other",
    description: "Legal document that did not match a more specific type.",
    register: "instrument",
  },
};

export function docTypeLabel(t: string): string {
  return DOC_TYPE_META[t as DocType]?.label ?? t;
}

export function docTypeRegister(t: string): DocTypeMeta["register"] {
  return DOC_TYPE_META[t as DocType]?.register ?? "instrument";
}
import { describe, expect, it } from "vitest";
import type { Block, BlockKind } from "../src/lib/domain";
import { buildDocxExport, buildTextExport } from "../src/lib/pipeline/export";
import type { VerificationReport } from "../src/lib/pipeline/report";
import type { TcrData } from "../src/lib/pipeline/tcr";
import { buildTcrReportItems } from "../src/lib/pipeline/tcrReport";

let n = 0;
function block(kind: BlockKind, source: string, target = ""): Block {
  n += 1;
  return {
    id: `b${n}`,
    ordinal: n - 1,
    pageNumber: Math.ceil(n / 4),
    kind,
    sourceText: source,
    targetText: target,
    translationState: target ? "ai" : "pending",
    tokenCount: 0,
    meta: {},
  };
}

const GUJARATI = /[\u0A80-\u0AFF]/;

/** The deed the pipeline actually runs on: RSN 572, old block 501, Luvara. */
function deedBlocks(): Block[] {
  n = 0;
  return [
    block(
      "body",
      "દસ્તાવેજનો પ્રકાર: વેચાણ | ગામનું નામ: લુવારા રે.સ.નં.: 467 | બ્લોક નં.: 501(જુનો), 572(નવો)",
      "Document type: Sale. Village: Luvara. Revenue Survey No.: 467. Block No.: 501 (old), 572 (new).",
    ),
    block(
      "body",
      "જે અંગેની નોંધ ગામ નમુના નં.6 નાં હકકપત્રકમાં નોંધ નં.139 થી તા.05/07/1983 નાં રોજ પાડવામાં આવેલ.",
      "The said entry was made in the Record of Rights of Village Form No. 6 as Entry No. 139 dated 05/07/1983.",
    ),
    block(
      "body",
      "વેચનાર:- પ્રતાપભાઇ નરસિંહભાઇ પટેલ",
      "Seller: Pratapbhai Narsinhbhai Patel.",
    ),
  ];
}

function data(overrides: Partial<TcrData> = {}): TcrData {
  return {
    addressee: "Kotak Mahindra Bank Limited",
    owner: "Vipul Peravittambhai Gajera",
    constitution: "Individual (as recorded in the source)",
    village: "Luvara",
    taluka: "Mangrol",
    district: "Surat",
    rsn: "467",
    oldBlock: "501",
    newBlock: "572",
    khata: "",
    area: "14,406 Sq. Mtrs",
    consideration: "17,58,000",
    stampDuty: "86,200",
    regFee: "18,080",
    appNo: "",
    appDate: "",
    deedNo: "9006",
    deedDate: "23/10/2023",
    propertyBody:
      "All that piece and parcel of immovable property bearing Revenue Survey No. 467, old Block No. 501 (now new Block No. 572), admeasuring 14,406 Sq. Mtrs, situate at Village Luvara, Sub-District Mangrol, District Surat, together with all rights, title and interest therein.",
    originalOwner: "Isap Museji Panchbhaya",
    heir: "Mahamad Isapji Panchbhaya",
    partitionOwner: "Suleman Mahamad Panchbhaya",
    priorOwner: "Pratapbhai Narsinhbhai Patel",
    boundaries: [
      { label: "North", value: "Adjacent Block No. 573" },
      { label: "South", value: "Adjacent Block No. 571" },
      { label: "East", value: "Adjacent Block No. 571" },
      { label: "West", value: "Boundary of Pardi village" },
    ],
    docs: [],
    flow: [],
    search: [],
    ...overrides,
  };
}

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    docId: "d-test",
    generatedAt: "2026-11-02T10:00:00.000Z",
    fileName: "Sale Deed no. 9006 Survey no. 572.pdf",
    docType: "property_document",
    docTypeLabel: "Sale Deed",
    pageCount: 23,
    provider: "Ollama (qwen2.5:7b)",
    sourceSha256: "abc123",
    segmentCount: 209,
    status: "final",
    semanticAudit: "complete",
    fidelityIndicator: {
      value: 0.688,
      grade: "red",
      components: { datums: 0.8, terminology: 0.9 },
      interpretation: "Review required.",
    },
    mechanicalChecks: [
      {
        check: "Segment coverage",
        description: "Confirmed every source paragraph produced English output.",
        count: 209,
        passed: true,
      },
    ],
    findings: [
      {
        id: "f1",
        severity: "critical",
        category: "Names",
        check: "datum.name_spelling_drift",
        location: "Page 3, block b3",
        title: "Party name spelling drift",
        detail: "The purchaser's surname is spelled two ways.",
        suggestion: "Confirm the spelling against the registered deed.",
        sourceExcerpt: "વેચનાર:- પ્રતાપભાઇ નરસિંહભાઇ પટેલ",
        targetExcerpt: "Seller: Pratapbhai Narsinhbhai Patel.",
      },
      {
        id: "f2",
        severity: "minor",
        category: "Terminology",
        check: "term.literal",
        location: "Page 5, block b5",
        title: "Terminology: literal rendering of a revenue term",
        detail: "A revenue term was rendered literally.",
        suggestion: "Use the glossary equivalent.",
        sourceExcerpt: "હકકપત્રક",
        targetExcerpt: "rights record",
      },
      {
        id: "f3",
        severity: "major",
        category: "Coverage",
        check: "structure.block_stunted",
        location: "Page 7, block b7",
        title: "English output is much shorter than the source",
        detail: "One clause of the recital has no English.",
        suggestion: "Re-translate the block and confirm the omitted clause.",
        sourceExcerpt: "જે મુજબ બ્લોક નં.501 વાળી જમીન સુલેમાન મહંમદ પાંચભાયાનાં હિસ્સે આવેલ.",
        targetExcerpt: "Block No. 501.",
      },
    ],
    narrative: {
      executiveSummary: "Summary.",
      reviewFocus: [],
      limitations: ["Machine-assisted; not a title opinion."],
      recommendedAction: "Review.",
      modelGenerated: false,
    },
    humanCertification: {
      completed: false,
      certifierName: "",
      qualifications: "",
      registrationNumber: "",
      signature: "",
      place: "",
      date: "",
    },
    ...overrides,
  };
}

function items(overrides: { data?: Partial<TcrData>; report?: Partial<VerificationReport>; blocks?: Block[] } = {}) {
  return buildTcrReportItems({
    data: data(overrides.data),
    report: report(overrides.report),
    blocks: overrides.blocks ?? deedBlocks(),
    companyName: "Kotak Mahindra Bank Limited",
    generatedAt: new Date(2026, 10, 2),
  });
}

describe("title-clearance report layout", () => {
  it("prints the advocate masthead and the sample title", () => {
    const out = items();
    const text = out
      .filter((i): i is Extract<typeof i, { t: "p" }> => i.t === "p")
      .map((i) => i.text);
    expect(text[0]).toBe("________________________________");
    expect(text).toContain("(Advocate)");
    expect(text).toContain("To,");
    expect(text).toContain("The Manager,");
    expect(text).toContain("Kotak Mahindra Bank Limited");
    expect(out.find((i) => i.t === "h1" && i.text === "TITLE CLEARANCE REPORT")).toBeTruthy();
  });

  it("keeps the 22 numbered sections in the order a bank reads them", () => {
    const headings = items()
      .filter((i): i is Extract<ReturnType<typeof items>[number], { t: "h2" }> => i.t === "h2")
      .map((i) => i.text);
    expect(headings).toHaveLength(22);
    expect(headings[0]).toMatch(/^1\.\s+Name of the Owner\/Mortgagor:/);
    expect(headings[2]).toMatch(/^3\.\s+Complete description of the property including boundaries:/);
    expect(headings[4]).toMatch(/^5\.\s+Documents scrutinised:/);
    expect(headings[17]).toMatch(/^18\.\s+Adverse remarks on title/);
    expect(headings[20]).toMatch(/^21\.\s+Certificate on title & marketability of property:/);
    expect(headings[21]).toMatch(/^22\.\s+Certificate on enforceability of the property under the Securitisation/);
  });

  it("maps findings into the section they affect and into the adverse remarks", () => {
    const out = items();
    const section1 = indexOfHeading(out, "1.  Name of the Owner/Mortgagor:");
    const section18 = indexOfHeading(out, "18.  Adverse remarks on title");
    const annexureB = out.findIndex((i) => i.t === "h1" && i.text.startsWith("ANNEXURE B"));
    expect(section1).toBeGreaterThan(-1);
    expect(section18).toBeGreaterThan(-1);
    expect(annexureB).toBeGreaterThan(section18);

    const between = (a: number, b: number) => out.slice(a, b);
    const adverse = between(section18, annexureB)
      .map((i) => (i.t === "bullets" ? i.items.join("\n") : ""))
      .join("\n");
    expect(adverse).toContain("Party name spelling drift");
    expect(adverse).toContain("English output is much shorter than the source");
    expect(adverse).not.toContain("Terminology: literal rendering");
    // Each remark is one line with a pointer into the register; the sentence
    // detail and the recommended action stay in Annexure B only.
    expect(adverse).toContain("(Annexure B, item 1)");
    expect(adverse).toContain("(Annexure B, item 3)");
    expect(adverse).not.toContain("The purchaser's surname is spelled two ways.");
    expect(adverse).not.toContain("Action: Confirm the spelling");

    const annexure = out.slice(annexureB);
    const annexureText = annexure.map((i) => JSON.stringify(i)).join("\n");
    expect(annexureText).toContain("Party name spelling drift");
    expect(annexureText).toContain("Terminology: literal rendering");
    expect(annexureText).toContain("English output is much shorter than the source");
    // The Gujarati excerpt is evidence, so it stays beside its English side.
    expect(annexureText).toContain("વેચનાર:- પ્રતાપભાઇ નરસિંહભાઇ પટેલ");
  });

  it("keeps the English body free of Gujarati; evidence stays in the annexure", () => {
    const text = buildTextExport({ docId: "d-test", fileName: report().fileName, blocks: deedBlocks(), report: report() });
    const body = text.split("ANNEXURE B")[0] ?? "";
    expect(body).not.toMatch(GUJARATI);
    expect(text.split("ANNEXURE B")[1] ?? "").toMatch(GUJARATI);
  });

  it("does not fabricate a figure the source does not contain", () => {
    const out = items({
      data: {
        owner: "",
        rsn: "",
        oldBlock: "",
        newBlock: "",
        area: "",
        consideration: "",
        stampDuty: "",
        regFee: "",
        deedNo: "",
        deedDate: "",
        propertyBody: "",
        boundaries: [],
        priorOwner: "",
      },
      blocks: [],
      report: { findings: [], fileName: "scan.pdf" },
    });
    const text = out.map((i) => JSON.stringify(i)).join("\n");
    expect(text).toContain("Not stated in the source");
    for (const figure of ["9006", "17,58,000", "86,200", "18,080", "14,406"]) {
      expect(text).not.toContain(figure);
    }
    // Adjectives that belong to another deed must not leak in either.
    expect(text).not.toContain("old-tenure agricultural land bearing Revenue Survey No.");
  });

  it("reports a draft as a draft", () => {
    const text = buildTextExport({
      docId: "d-test",
      fileName: report().fileName,
      blocks: deedBlocks(),
      report: report({ status: "draft", semanticAudit: "pending" }),
    });
    expect(text).toContain("DRAFT");
    expect(text).not.toContain("FINAL · meaning-level review pending");
  });

  it("presents the certificate as a draft for the Advocate, never self-certified", () => {
    const text = buildTextExport({ docId: "d-test", fileName: report().fileName, blocks: deedBlocks(), report: report() });
    expect(text).toContain("THIS IS TO CERTIFY");
    expect(text).toContain("NOT CERTIFIED");
    expect(text).toContain("drafts for the Advocate's signature");
    expect(text).toContain("Place:");
    expect(text).toContain("Advocate");
    expect(text).not.toContain("Certified translator");
  });

  it("renders the report as a Word document", async () => {
    const buf = await buildDocxExport({
      docId: "d-test",
      fileName: report().fileName,
      blocks: deedBlocks(),
      report: report(),
    });
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buf.length).toBeGreaterThan(10_000);
  });
});

function indexOfHeading(out: ReturnType<typeof items>, prefix: string): number {
  return out.findIndex((i) => i.t === "h2" && i.text.startsWith(prefix));
}

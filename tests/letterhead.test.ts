import { describe, expect, it } from "vitest";
import type { Block, BlockKind } from "../src/lib/domain";
import {
  buildAddressee,
  detectReportPattern,
  patternHeader,
  patternParts,
} from "../src/lib/domain/letterhead";
import { buildTextExport, buildTranslationText } from "../src/lib/pipeline/export";
import type { VerificationReport } from "../src/lib/pipeline/report";

let n = 0;
function block(kind: BlockKind, source: string, target = ""): Block {
  n += 1;
  return {
    id: `b${n}`,
    ordinal: n - 1,
    pageNumber: 1,
    kind,
    sourceText: source,
    targetText: target,
    translationState: target ? "ai" : "pending",
    tokenCount: 0,
    meta: {},
  };
}

/** The shape of `Dev Arcade-Kalol.docx`: letterhead, date, title, addressee. */
function titleClearance(): Block[] {
  n = 0;
  return [
    block("body", "VISHAL M. KOTHARI", "VISHAL M. KOTHARI"),
    block("body", "M: 9898266089", "M: 9898266089"),
    block("body", "(Advocate)", "(Advocate)"),
    block(
      "body",
      "Office- 18, 2nd floor National Chambers, Near City Gold Cinema Ashram Road, Ahmedabad-380009",
      "Office- 18, 2nd floor National Chambers, Near City Gold Cinema Ashram Road, Ahmedabad-380009",
    ),
    block("body", "Date: 27/07/2023", "Date: 27/07/2023"),
    block("document_title", "TITLE CLEARANCE REPORT", "TITLE CLEARANCE REPORT"),
    block("body", "To,", "To,"),
    block("body", "The Manager,", "The Manager,"),
    block("body", "Kotak Mahindra Bank Limited", "Kotak Mahindra Bank Limited"),
    block("body", "Ahmedabad.", "Ahmedabad."),
    block("heading_2", "Name of the Owner/Mortgagor:", "Name of the Owner/Mortgagor:"),
    block("body", "The bank is the mortgagee of the property.", "The bank is the mortgagee of the property."),
  ];
}

function report(): VerificationReport {
  return {
    docId: "d-test",
    generatedAt: "2026-10-06T10:00:00.000Z",
    fileName: "Dev Arcade-Kalol.docx",
    docType: "property_document",
    docTypeLabel: "Property document",
    pageCount: 2,
    provider: "Ollama (qwen2.5:14b)",
    sourceSha256: "abc123",
    segmentCount: 60,
    fidelityIndicator: {
      value: 0.842,
      grade: "red",
      components: {},
      interpretation: "Review required.",
    },
    mechanicalChecks: [],
    findings: [],
    narrative: {
      executiveSummary: "Summary.",
      reviewFocus: [],
      limitations: [],
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
  };
}

describe("report pattern detection", () => {
  it("separates letterhead, title and addressee", () => {
    const p = detectReportPattern(titleClearance());
    expect(p.letterhead.map((l) => l.source)).toEqual([
      "VISHAL M. KOTHARI",
      "M: 9898266089",
      "(Advocate)",
      "Office- 18, 2nd floor National Chambers, Near City Gold Cinema Ashram Road, Ahmedabad-380009",
      "Date: 27/07/2023",
    ]);
    expect(p.title?.source).toBe("TITLE CLEARANCE REPORT");
    expect(p.addressee.map((l) => l.source)).toEqual([
      "To,",
      "The Manager,",
      "Kotak Mahindra Bank Limited",
      "Ahmedabad.",
    ]);
    expect(p.bodyStart).toBe(10);
  });

  it("reads the company name out of the addressee, not the role line", () => {
    const p = detectReportPattern(titleClearance());
    expect(p.companyName).toBe("Kotak Mahindra Bank Limited");
  });

  it("falls back to the letterhead when the addressee names no company", () => {
    n = 0;
    const blocks = [
      block("body", "Gujarat Housing Finance Limited", "Gujarat Housing Finance Limited"),
      block("body", "M: 1234567890", "M: 1234567890"),
      block("document_title", "LOAN AGREEMENT", "LOAN AGREEMENT"),
      block("body", "Between the parties hereto.", "Between the parties hereto."),
    ];
    const p = detectReportPattern(blocks);
    expect(p.companyName).toBe("Gujarat Housing Finance Limited");
  });

  it("returns an empty pattern when there is no recognisable header", () => {
    n = 0;
    const p = detectReportPattern([
      block("body", "A long paragraph of running text that carries no title at all and is far too long to be one."),
      block("body", "Another long paragraph of running text that also does not look like a report title line."),
    ]);
    expect(p.title).toBeNull();
    expect(p.addressee).toEqual([]);
    expect(p.bodyStart).toBe(0);
  });
});

describe("addressee rendering", () => {
  it("keeps the detected company when no override is given", () => {
    const p = detectReportPattern(titleClearance());
    expect(buildAddressee(p, "", "source")).toEqual([
      "To,",
      "The Manager,",
      "Kotak Mahindra Bank Limited",
      "Ahmedabad.",
    ]);
  });

  it("lets an operator override replace the detected company", () => {
    const p = detectReportPattern(titleClearance());
    expect(buildAddressee(p, "State Bank of India", "source")).toEqual([
      "To,",
      "The Manager,",
      "State Bank of India",
      "Ahmedabad.",
    ]);
  });

  it("inserts an override under the role line when the document named none", () => {
    n = 0;
    const p = detectReportPattern([
      block("body", "ADVOCATE NAME", "ADVOCATE NAME"),
      block("document_title", "AFFIDAVIT", "AFFIDAVIT"),
      block("body", "To,", "To,"),
      block("body", "The Hon'ble Civil Judge,", "The Hon'ble Civil Judge,"),
      block("body", "The deponent says as follows.", "The deponent says as follows."),
    ]);
    expect(p.companyName).toBe("");
    expect(buildAddressee(p, "High Court of Gujarat", "source")).toEqual([
      "To,",
      "High Court of Gujarat",
      "The Hon'ble Civil Judge,",
    ]);
  });
});

describe("clean translation export", () => {
  it("opens with the source pattern in English", () => {
    const text = buildTranslationText({
      docId: "d-test",
      fileName: "Dev Arcade-Kalol.docx",
      blocks: titleClearance(),
      report: report(),
    });
    const lines = text.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "VISHAL M. KOTHARI",
      "M: 9898266089",
      "(Advocate)",
      "Office- 18, 2nd floor National Chambers, Near City Gold Cinema Ashram Road, Ahmedabad-380009",
      "Date: 27/07/2023",
    ]);
    expect(lines[6]).toBe("TITLE CLEARANCE REPORT");
    expect(lines).toContain("Kotak Mahindra Bank Limited");
  });

  it("renders the body once, without repeating the header", () => {
    const text = buildTranslationText({
      docId: "d-test",
      fileName: "Dev Arcade-Kalol.docx",
      blocks: titleClearance(),
      report: report(),
    });
    expect(text.match(/TITLE CLEARANCE REPORT/g)).toHaveLength(1);
    expect(text).toContain("Name of the Owner/Mortgagor:");
    expect(text).toContain("The bank is the mortgagee of the property.");
  });

  it("carries the non-certification notice and disclaimer", () => {
    const text = buildTranslationText({
      docId: "d-test",
      fileName: "Dev Arcade-Kalol.docx",
      blocks: titleClearance(),
      report: report(),
      companyName: "Kotak Mahindra Bank Limited",
    });
    expect(text).toContain("NOT CERTIFIED");
    expect(text).toContain("84.2% (RED)");
    expect(text).toContain("abc123");
  });

  it("substitutes an override company name in the header", () => {
    const text = buildTranslationText({
      docId: "d-test",
      fileName: "Dev Arcade-Kalol.docx",
      blocks: titleClearance(),
      report: report(),
      companyName: "HDFC Bank Limited",
    });
    expect(text).toContain("HDFC Bank Limited");
    expect(text).not.toContain("Kotak Mahindra Bank Limited");
  });
});

describe("verification report adopts the same pattern", () => {
  it("opens with the source letterhead and addressee", () => {
    const text = buildTextExport({
      docId: "d-test",
      fileName: "Dev Arcade-Kalol.docx",
      blocks: titleClearance(),
      report: report(),
      companyName: "Kotak Mahindra Bank Limited",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("VISHAL M. KOTHARI");
    expect(lines).toContain("TITLE CLEARANCE REPORT");
    expect(lines).toContain("Kotak Mahindra Bank Limited");
    expect(text).toContain("VERIFICATION REPORT — GUJARATI → ENGLISH LEGAL TRANSLATION");
  });

  it("still renders a plain report when the source has no pattern", () => {
    n = 0;
    const text = buildTextExport({
      docId: "d-test",
      fileName: "plain.txt",
      blocks: [block("body", "Just a paragraph of source text with no header at all.")],
      report: report(),
    });
    expect(text.startsWith("VERIFICATION REPORT")).toBe(true);
  });
});

describe("pattern parts", () => {
  it("tags every line with the piece it belongs to", () => {
    const parts = patternParts(detectReportPattern(titleClearance()), "", "source");
    expect(parts.map((p) => p.kind)).toEqual([
      "letterhead",
      "letterhead",
      "letterhead",
      "letterhead",
      "letterhead",
      "title",
      "addressee",
      "addressee",
      "addressee",
      "addressee",
    ]);
  });

  it("separates the three groups with blank lines in the flat header", () => {
    const header = patternHeader(detectReportPattern(titleClearance()), "", "source");
    expect(header.indexOf("TITLE CLEARANCE REPORT")).toBe(6);
    expect(header[5]).toBe("");
    expect(header[7]).toBe("");
    expect(header[header.length - 1]).toBe("");
  });
});

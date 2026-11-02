import { describe, expect, it } from "vitest";
import { buildReport, deterministicNarrative } from "../src/lib/pipeline/report";
import type { ReportInput } from "../src/lib/pipeline/report";
import { pendingJudge } from "../src/lib/pipeline/verify";
import type { VerificationResult } from "../src/lib/pipeline/verify";

/**
 * The report used to be written only after the semantic pass and after a model
 * had phrased the narrative. On the 23-page deed that was twelve minutes after
 * the Word file. A draft is now written at translation commit from the
 * deterministic checks, and the narrative is assembled from counts the pipeline
 * already has unless NYD_REPORT_LLM asks for a model.
 */

function verification(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    findings: [
      {
        id: "f-1",
        check: "datum.changed",
        category: "Data integrity",
        severity: "critical",
        blockId: "b2",
        pageNumber: 3,
        title: "Survey number differs",
        detail: "The source says 572, the target says 752.",
        suggestion: "Correct the survey number.",
        sourceExcerpt: "સર્વે નં. ૫૭૨",
        targetExcerpt: "Survey no. 752",
        status: "open",
      },
    ],
    datums: [],
    score: {
      datumIntegrity: 0.8,
      terminology: 0.9,
      coverage: 1,
      semantic: 0.5,
      ocrConfidence: 0.95,
      total: 0.83,
      criticalCount: 1,
      grade: "yellow",
      certifiedReady: false,
    },
    alignment: { pairs: [], method: "positional", unmatchedSource: [], unmatchedTarget: [], exact: true },
    coverage: { totalBlocks: 4, translatedBlocks: 4, emptyBlocks: [], stuntedBlocks: [], ratio: 1 },
    termPlan: [],
    judge: pendingJudge(4),
    warnings: [],
    ...over,
  };
}

function reportInput(v: VerificationResult): ReportInput {
  return {
    docId: "d-report",
    fileName: "sale-deed.pdf",
    docType: "property_document",
    docTypeLabel: "Property document",
    pageCount: 23,
    providerLabel: "ollama:qwen2.5:7b",
    segmentCount: 209,
    verification: v,
    sourceSha256: "abc123",
    translatedAt: new Date().toISOString(),
  };
}

describe("progressive report", () => {
  it("writes a draft from deterministic checks while the meaning review is pending", () => {
    const input = reportInput(verification());
    const narrative = deterministicNarrative(input);
    const report = buildReport(input, narrative, { status: "draft", semanticAudit: "pending" });

    expect(narrative.modelGenerated).toBe(false);
    expect(narrative.executiveSummary).toContain("sale-deed.pdf");
    expect(narrative.executiveSummary).toContain("23 page(s)");
    expect(narrative.executiveSummary).toContain("1 critical");
    expect(report.status).toBe("draft");
    expect(report.semanticAudit).toBe("pending");
    expect(report.completedAt).toBeNull();

    const semanticCheck = report.mechanicalChecks.find(
      (c) => c.check === "Semantic faithfulness review",
    );
    expect(semanticCheck?.pending).toBe(true);
    expect(semanticCheck?.passed).toBe(false);
    expect(semanticCheck?.description.startsWith("Pending.")).toBe(true);
  });

  it("marks the report final once the meaning review has answered", () => {
    const v = verification({
      judge: {
        segments: [{ index: 0, faithful: true, issues: [], confidence: 0.9 }],
        documentNotes: [],
        documentFaithful: true,
        available: true,
        complete: true,
        blocksJudged: 4,
        blocksTotal: 4,
      },
    });
    const input = reportInput(v);
    const report = buildReport(input, deterministicNarrative(input), {
      status: "final",
      semanticAudit: "complete",
    });

    expect(report.status).toBe("final");
    expect(report.semanticAudit).toBe("complete");
    expect(report.completedAt).toBeTruthy();

    const semanticCheck = report.mechanicalChecks.find(
      (c) => c.check === "Semantic faithfulness review",
    );
    expect(semanticCheck?.pending).toBe(false);
    expect(semanticCheck?.passed).toBe(true);
    expect(semanticCheck?.description).toContain("Compared each source segment");
  });

  it("does not call the meaning review a pass when it did not run", () => {
    const v = verification({
      judge: {
        segments: [],
        documentNotes: [],
        documentFaithful: true,
        available: false,
        complete: false,
        blocksJudged: 0,
        blocksTotal: 4,
      },
    });
    const input = reportInput(v);
    const report = buildReport(input, deterministicNarrative(input), {
      status: "final",
      semanticAudit: "skipped",
    });

    const semanticCheck = report.mechanicalChecks.find(
      (c) => c.check === "Semantic faithfulness review",
    );
    expect(semanticCheck?.pending).toBe(false);
    expect(semanticCheck?.passed).toBe(false);
    expect(report.semanticAudit).toBe("skipped");
    expect(deterministicNarrative(input).limitations.join(" ")).toContain(
      "incomplete or absent",
    );
  });
});

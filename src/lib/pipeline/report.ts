import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "../config";
import { buildReportPrompt, REPORT_SYSTEM } from "../llm/prompts";
import { parseJsonLoose } from "../llm/provider";
import type { LlmClient, LlmMessage } from "../llm/provider";
import type { VerificationResult } from "./verify";

export interface ReportNarrative {
  executiveSummary: string;
  reviewFocus: string[];
  limitations: string[];
  recommendedAction: string;
  /** True when the narrative came from a real model. */
  modelGenerated: boolean;
}

export interface ReportInput {
  docId: string;
  fileName: string;
  docType: string;
  docTypeLabel: string;
  pageCount: number;
  providerLabel: string;
  /** Target block list, aligned with `blocks` in the verification result. */
  segmentCount: number;
  verification: VerificationResult;
  /**
   * Structured script/encoding warnings from preflight.
   *
   * The report must not claim the source is Gujarati unless this is empty: a
   * `not_indic` finding on an English document used to be reported as a pass,
   * which reads as a positive assurance on a legal verification report.
   */
  preflightWarnings?: Array<{ code: string; severity: string; message: string }>;
  /** Source hash shown in the report so a reviewer can pin the exact input. */
  sourceSha256: string;
  translatedAt: string;
  reviewer?: string | null;
}

export interface VerificationReport {
  docId: string;
  generatedAt: string;
  fileName: string;
  docType: string;
  docTypeLabel: string;
  pageCount: number;
  provider: string;
  sourceSha256: string;
  segmentCount: number;

  /** Explicitly labelled indicator — never presented as accuracy. */
  fidelityIndicator: {
    value: number;
    grade: "green" | "yellow" | "red";
    components: Record<string, number>;
    interpretation: string;
  };

  mechanicalChecks: Array<{ check: string; description: string; count: number; passed: boolean }>;

  findings: Array<{
    id: string;
    severity: string;
    category: string;
    check: string;
    location: string;
    title: string;
    detail: string;
    suggestion: string;
    sourceExcerpt: string;
    targetExcerpt: string;
  }>;

  narrative: ReportNarrative;

  humanCertification: {
    completed: false;
    certifierName: string;
    qualifications: string;
    registrationNumber: string;
    signature: string;
    place: string;
    date: string;
  };
}

/**
 * Assemble the report.
 *
 * Note what is deliberately absent: there is no "accuracy" field and no percentage
 * that a reader could quote as a quality claim. The indicator is labelled as an
 * automated quality indicator, its components are itemised, and the counts of what
 * was actually checked are printed so the number is auditable rather than magical.
 */
export function buildReport(input: ReportInput, narrative: ReportNarrative): VerificationReport {
  const v = input.verification;
  const datumCount = v.datums.length;
  const changedOrMissing = v.datums.filter((d) => d.status === "changed" || d.status === "missing" || d.status === "added").length;
  const termHits = v.termPlan.reduce((a, t) => a + t.count, 0);
  const preflightIssues = input.preflightWarnings ?? [];
  // Codes that invalidate the "source is Gujarati script" claim below. Anything
  // blocking also invalidates it.
  const scriptConfirmed =
    !preflightIssues.some(
      (w) => w.severity === "block" || ["not_indic", "wrong_script", "legacy_encoding"].includes(w.code),
    ) && !v.findings.some((f) => f.check.startsWith("source."));

  const mechanicalChecks = [
    {
      check: "Script and encoding preflight",
      description: scriptConfirmed
        ? "Confirmed the source is Gujarati script and not a legacy Indic font encoding that would silently corrupt names and digits."
        : `Not confirmed: ${
            preflightIssues.map((w) => w.message).join(" ") ||
            "a source-level verification finding contradicts the Gujarati script claim."
          }`,
      count: preflightIssues.length,
      passed: scriptConfirmed,
    },
    {
      check: "Data extraction and comparison",
      description: "Extracted every number, amount, date, time, percentage, section/article reference, statute reference, case number, person, party, institution and written count from both the Gujarati and the English, and compared them by value.",
      count: datumCount,
      passed: changedOrMissing === 0,
    },
    {
      check: "Terminology compliance",
      description: "Checked that each glossary term in the source appears in the English using the recognised legal equivalent, and that no term was rendered literally.",
      count: termHits,
      passed: v.findings.filter((f) => f.category === "Terminology" && f.severity !== "info").length === 0,
    },
    {
      check: "Segment coverage",
      description: "Confirmed every source paragraph produced English output, and that no output is suspiciously shorter than its source.",
      count: v.coverage.totalBlocks,
      passed: v.coverage.emptyBlocks.length === 0 && v.coverage.stuntedBlocks.length === 0,
    },
    {
      check: "Sentence-level alignment",
      description: "Confirmed the English contains exactly one segment per Gujarati sentence, so that each finding can be attributed to a specific source sentence.",
      count: input.segmentCount,
      passed: v.alignment.exact,
    },
    {
      check: "Untranslated residue",
      description: "Scanned the English output for Gujarati script that should have been translated.",
      count: v.findings.filter((f) => f.check === "structure.untranslated_residue").length,
      passed: v.findings.filter((f) => f.check === "structure.untranslated_residue").length === 0,
    },
    {
      check: "Semantic faithfulness review",
      description: v.judge.available
        ? "Compared each source segment with its English for meaning-level divergence: omission, addition, changed data, altered scope or modality, inverted negation, misidentified participant."
        : "Not run. No language model was available for the meaning-level comparison, so negation, modality and scope changes are not covered by this report.",
      count: v.judge.segments.length,
      passed: v.judge.available && v.judge.documentFaithful,
    },
  ];

  return {
    docId: input.docId,
    generatedAt: new Date().toISOString(),
    fileName: input.fileName,
    docType: input.docType,
    docTypeLabel: input.docTypeLabel,
    pageCount: input.pageCount,
    provider: input.providerLabel,
    sourceSha256: input.sourceSha256,
    segmentCount: input.segmentCount,

    fidelityIndicator: {
      value: v.score.total,
      grade: v.score.grade,
      components: {
        "Data fidelity": v.score.datumIntegrity,
        Terminology: v.score.terminology,
        Coverage: v.score.coverage,
        "Semantic faithfulness": v.score.semantic,
        "Source text confidence": v.score.ocrConfidence,
      },
      interpretation:
        v.score.total >= 0.9
          ? "No critical or major automated finding was raised. This indicates the checks that ran passed; it is not a measure of overall translation accuracy."
          : v.score.total >= 0.7
            ? "Findings require review before this translation is used. The indicator reflects only the checks listed above."
            : "Significant divergence was detected. Do not rely on this translation until the listed findings are resolved.",
    },

    mechanicalChecks,

    findings: v.findings
      .slice()
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
      .map((f) => ({
        id: f.id,
        severity: f.severity,
        category: f.category,
        check: f.check,
        location: f.pageNumber != null ? `Page ${f.pageNumber}${f.blockId ? `, block ${f.blockId}` : ""}` : f.blockId ?? "—",
        title: f.title,
        detail: f.detail,
        suggestion: f.suggestion,
        sourceExcerpt: f.sourceExcerpt,
        targetExcerpt: f.targetExcerpt,
      })),

    narrative,

    humanCertification: {
      completed: false,
      certifierName: input.reviewer ?? "",
      qualifications: "",
      registrationNumber: "",
      signature: "",
      place: "",
      date: "",
    },
  };
}

function severityRank(s: string): number {
  return s === "critical" ? 3 : s === "major" ? 2 : s === "minor" ? 1 : 0;
}

/** Shape the model is asked for; every field optional because it may be omitted. */
interface NarrativeFields {
  executiveSummary?: string;
  reviewFocus?: string[];
  limitations?: string[];
  recommendedAction?: string;
}

/** Prompt the model for the narrative sections only. Counts come from the data. */
export async function generateNarrative(
  llm: LlmClient,
  input: ReportInput,
): Promise<ReportNarrative> {
  const v = input.verification;
  const datumCount = v.datums.length;
  const counts = {
    datumCount,
    termCount: v.termPlan.reduce((a, t) => a + t.count, 0),
    blocks: v.coverage.totalBlocks,
    segments: input.segmentCount,
    findings: v.findings.length,
    critical: v.findings.filter((f) => f.severity === "critical").length,
    major: v.findings.filter((f) => f.severity === "major").length,
    minor: v.findings.filter((f) => f.severity === "minor").length,
  };

  if (!llm.available) {
    return {
      executiveSummary:
        `${input.fileName} was processed as a ${input.docTypeLabel} of ${input.pageCount} page(s). ` +
        `Automated checks examined ${counts.datumCount} data item(s) and ${counts.termCount} terminology occurrence(s) ` +
        `across ${counts.blocks} block(s). ${counts.findings} finding(s) were raised, of which ${counts.critical} are critical. ` +
        "No language model was available, so meaning-level comparison did not run and the fidelity indicator reflects mechanical checks only. " +
        "This translation is not certified and must be reviewed by a qualified legal professional before use.",
      reviewFocus:
        counts.findings > 0
          ? [
              `The ${counts.critical} critical finding(s) listed below, in the order shown.`,
              `The ${counts.major} major finding(s).`,
              "Party and witness names, checked by eye against the original Gujarati.",
            ]
          : ["Every paragraph, since no semantic comparison was performed."],
      limitations: [
        "No language model was available; semantic equivalence, modality and negation were not assessed.",
        "The fidelity indicator reflects the automated checks listed in this report only.",
        "Terminology compliance is measured against a house glossary, which is not a substitute for a qualified review.",
      ],
      recommendedAction:
        "Re-run with a configured translation provider, then have a qualified legal translator review the document against the original.",
      modelGenerated: false,
    };
  }

  const messages: LlmMessage[] = [
    { role: "system", content: REPORT_SYSTEM },
    {
      role: "user",
      content: buildReportPrompt({
        meta:
          `File: ${input.fileName}\nDocument type: ${input.docTypeLabel} (${input.docType})\nPages: ${input.pageCount}\n` +
          `Translation provider: ${input.providerLabel}\nSource SHA-256: ${input.sourceSha256}\nTranslated: ${input.translatedAt}`,
        deterministic:
          counts.datumCount > 0
            ? `${counts.datumCount} data item(s) extracted from both sides and compared by value.\n` +
              `Discrepancies: ${v.datums.filter((d) => d.status === "changed").length} changed, ` +
              `${v.datums.filter((d) => d.status === "missing").length} missing, ` +
              `${v.datums.filter((d) => d.status === "added").length} added.`
            : "No fact-shaped data (numbers, amounts, dates, references, names) were found in this document, so the data-fidelity check had nothing to compare.",
        judgeFindings:
          v.findings.length > 0
            ? v.findings
                .slice(0, 80)
                .map((f) => `- [${f.severity}] ${f.category} / ${f.check}${f.pageNumber ? ` (page ${f.pageNumber})` : ""}: ${f.title}. ${f.detail}`)
                .join("\n")
            : "No findings were raised by the automated checks.",
        metrics:
          `Blocks: ${counts.blocks}\nTranslation segments: ${counts.segments}\n` +
          `Block coverage: ${(v.coverage.ratio * 100).toFixed(1)}%\n` +
          `Findings: ${counts.findings} (critical ${counts.critical}, major ${counts.major}, minor ${counts.minor})\n` +
          `Semantic review: ${v.judge.available ? "ran" : "did not run"}\n` +
          `Source OCR confidence: ${input.verification.warnings.some((w) => w.includes("OCR")) ? "see warnings" : "embedded text layer or high confidence"}`,
      }),
    },
  ];

  try {
    // JSON mode is a hint, not a guarantee: a local model will still answer in
    // prose, invent field names, or be cut off mid-object. One more attempt
    // costs a few minutes but keeps a real narrative in the report; after that
    // the fallback below carries the run instead of failing it.
    let parsed: NarrativeFields | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const raw = await llm.complete(messages, {
        json: true,
        // A truncated object cannot be parsed at all, so leave headroom for a
        // four-section narrative plus a long critical-findings list.
        maxOutputTokens: 4_096,
      });
      parsed = parseJsonLoose<NarrativeFields>(raw);
    }

    if (!parsed) {
      // An unusable response still yields a usable (if blunt) narrative rather
      // than aborting the run: the report must always exist so a human can review.
      return {
        executiveSummary: "Narrative generation returned no usable summary.",
        reviewFocus: ["The findings table below, in severity order."],
        limitations: ["The model's narrative summary could not be read as JSON."],
        recommendedAction: "Review the automated findings manually before relying on this translation.",
        modelGenerated: false,
      };
    }

    return {
      executiveSummary: parsed.executiveSummary ?? "Narrative generation returned no usable summary.",
      reviewFocus: parsed.reviewFocus ?? [],
      limitations: parsed.limitations ?? [],
      recommendedAction: parsed.recommendedAction ?? "Review the automated findings manually before relying on this translation.",
      modelGenerated: Boolean(parsed.executiveSummary),
    };
  } catch (err) {
    return {
      executiveSummary:
        `Automated checks examined ${counts.datumCount} data item(s) and raised ${counts.findings} finding(s). ` +
        `The narrative summary could not be generated (${err instanceof Error ? err.message : "unknown error"}), so this report contains the raw check results only. ` +
        "Read the mechanical checks and findings table directly.",
      reviewFocus: ["The findings table below, in severity order."],
      limitations: ["The narrative summary could not be generated."],
      recommendedAction: "Review the mechanical checks and findings table, then sign the certification block if appropriate.",
      modelGenerated: false,
    };
  }
}

export function writeReportJson(docId: string, report: VerificationReport): string {
  ensureDirs();
  const p = path.join(config.exportDir, `${safe(docId)}-verification-report.json`);
  fs.writeFileSync(p, JSON.stringify(report, null, 2), "utf8");
  return p;
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

export { DISCLAIMER } from "../domain/glossary";
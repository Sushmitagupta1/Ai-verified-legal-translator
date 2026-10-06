import { config } from "../config";
import { DISCLAIMER, type Datum, type Finding, type Severity } from "../domain";
import { normalizeWhitespace } from "../domain/gujarati";
import { VERIFIER_SYSTEM, buildVerifierPrompt } from "../llm/prompts";
import { parseJson } from "../llm/provider";
import type { LlmClient } from "../llm/provider";
import { alignSegments, computeCoverage, namesMatch, type AlignmentResult } from "../verify/alignment";
import {
  ambiguousDateReadings,
  datumsAgree,
  extractAllDatums,
  isAmbiguousDate,
} from "../verify/datum";
import {
  buildTermPlan,
  checkTermCompliance,
  checkTermConsistency,
  type AppliedTerm,
  type TermViolation,
} from "../verify/terminology";
import type { TranslatedSegment } from "./translate";

export interface VerifyInput {
  /** Source text per block, in block order. */
  sourceTexts: string[];
  /** Block id per entry of `sourceTexts`. */
  blockIds: string[];
  /** Page number per entry of `sourceTexts`. */
  pageNumbers: number[];
  translated: TranslatedSegment[];
  /** Translated segments grouped back to blocks. */
  targetByBlock: Map<string, string>;
  docType: string;
  /** Lower the verdict when the source text itself is uncertain (OCR). */
  meanOcrConfidence: number | null;
}

export interface JudgeIssue {
  code: string;
  severity: Severity;
  detail: string;
  quote?: string;
  suggestion?: string;
}

export interface JudgeSegment {
  index: number;
  faithful: boolean;
  issues: JudgeIssue[];
  confidence: number;
}

export interface JudgeResult {
  segments: JudgeSegment[];
  documentNotes: string[];
  documentFaithful: boolean;
  available: boolean;
}

export interface ScoreBreakdown {
  datumIntegrity: number;
  terminology: number;
  coverage: number;
  semantic: number;
  ocrConfidence: number;
  total: number;
  /** Findings that alone prevent certification-ready status. */
  criticalCount: number;
  grade: "green" | "yellow" | "red";
  /** Hard gate: critical findings or empty output exist. */
  certifiedReady: boolean;
}

export interface VerificationResult {
  findings: Finding[];
  datums: Datum[];
  score: ScoreBreakdown;
  alignment: AlignmentResult;
  coverage: ReturnType<typeof computeCoverage>;
  termPlan: AppliedTerm[];
  judge: JudgeResult;
  warnings: string[];
}

// ── Deterministic verification ────────────────────────────────────────────────

/**
 * Datum conservation.
 *
 * Source datums are matched against target datums by *value*, not by position or
 * string identity. That is what allows a correct reformattings (`5,00,000` →
 * `500,000`, `12/03/2024` → `12 March 2024`) to pass while a real change
 * (`5,00,000` → `5,00,000/-`) is caught.
 */
export function verifyDatums(input: VerifyInput): { datums: Datum[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const datums: Datum[] = [];

  for (let i = 0; i < input.sourceTexts.length; i++) {
    const source = input.sourceTexts[i] ?? "";
    const target = input.targetByBlock.get(input.blockIds[i] ?? "") ?? "";
    const blockId = input.blockIds[i];
    const pageNumber = input.pageNumbers[i];

    const srcDatums = extractAllDatums(source, { blockId, pageNumber, origin: "s" });
    const tgtDatums = extractAllDatums(target, { blockId, pageNumber, origin: "t" });

    // Index target datums by (kind, normalized) so each source datum claims at most
    // one target datum; two identical amounts in one sentence must both be found.
    const pool = tgtDatums.map((d, idx) => ({ datum: d, idx, used: false }));

    for (const sd of srcDatums) {
      datums.push({ ...sd, status: "matched" });

      // Names: compare transliterations, tolerate initials forms.
      if (sd.kind === "person_name" || sd.kind === "party_name") {
        const hit = pool.find(
          (c) => !c.used && (c.datum.kind === sd.kind || c.datum.kind === "person_name") && namesMatch(sd.surface, c.datum.surface).match,
        );
        if (hit) {
          hit.used = true;
          const nm = namesMatch(sd.surface, hit.datum.surface);
          sd.status = "matched";
          sd.targetSurface = hit.datum.surface;
          sd.targetBlockId = hit.datum.blockId;
          if (nm.confidence < 0.9) {
            findings.push(
              finding({
                check: "datum.name_spelling_drift",
                category: "Names",
                severity: "major",
                blockId,
                datumId: sd.id,
                pageNumber,
                title: `Name rendered as "${hit.datum.surface}"`,
                detail:
                  `The source name "${sd.surface}" appears in the translation as "${hit.datum.surface}". ` +
                  "These may denote the same person, but a name in a legal filing must be exact.",
                suggestion: `Confirm the intended English spelling and apply it to every occurrence.`,
                sourceExcerpt: sd.context,
                targetExcerpt: hit.datum.context,
              }),
            );
          }
          continue;
        }
        // A name that appears nowhere in the target is usually an omission.
        if (target.trim().length > 0) {
          sd.status = "missing";
          findings.push(
            finding({
              check: "datum.name_missing",
              category: "Names",
              severity: "critical",
              blockId,
              datumId: sd.id,
              pageNumber,
              title: `Name "${sd.surface}" not found in the translation`,
              detail: `The source contains the name "${sd.surface}", which does not appear in the corresponding English. A missing party or witness name can invalidate a document.`,
              suggestion: "Re-translate this segment, or enter the correct name manually.",
              sourceExcerpt: sd.context,
              targetExcerpt: excerpt(target),
            }),
          );
        }
        continue;
      }

      // Ambiguous source dates: a reading that matches is acceptable, but the
      // ambiguity itself must be surfaced, not resolved silently.
      if (sd.kind === "date" && isAmbiguousDate(sd.normalized)) {
        const readings = ambiguousDateReadings(sd.normalized);
        // The target date can be ambiguous too: an English "12/03/2024" is just
        // as ambiguous as the Gujarati one. Comparing the target's readings
        // directly against the source's readings only works when the model
        // disambiguated on its own. Overlap of the two reading sets is the
        // general test, and identical surfaces short-circuit it anyway.
        const hit = pool.find((c) => {
          if (c.used || c.datum.kind !== "date") return false;
          if (c.datum.normalized === sd.normalized) return true;
          if (readings.includes(c.datum.normalized)) return true;
          if (!isAmbiguousDate(c.datum.normalized)) return false;
          return ambiguousDateReadings(c.datum.normalized).some((r) => readings.includes(r));
        });
        if (hit) {
          hit.used = true;
          sd.status = "ambiguous";
          sd.targetSurface = hit.datum.surface;
          findings.push(
            finding({
              check: "datum.date_ambiguous",
              category: "Dates",
              severity: "major",
              blockId,
              datumId: sd.id,
              pageNumber,
              title: `Ambiguous source date "${sd.surface}"`,
              detail:
                `"${sd.surface}" can be read as ${readings.join(" or ")}. The translation used one reading. ` +
                "Confirm the intended date against the original.",
              suggestion: "Verify the date in the original document and, if needed, disambiguate in the English.",
              sourceExcerpt: sd.context,
              targetExcerpt: hit.datum.context,
            }),
          );
        } else {
          // An ambiguous date is not an excuse to skip the check. Falling
          // through silently would let a genuinely dropped date pass.
          findings.push(
            finding({
              check: "datum.date_missing",
              category: "Dates",
              severity: "critical",
              blockId,
              datumId: sd.id,
              pageNumber,
              title: `Ambiguous source date "${sd.surface}" is absent from the translation`,
              detail:
                `"${sd.surface}" can be read as ${readings.join(" or ")}, and no date in the translation ` +
                "matches either reading.",
              suggestion: "Carry the date through into the English and confirm which reading is intended.",
              sourceExcerpt: sd.context,
              targetExcerpt: excerpt(target),
            }),
          );
          sd.status = "missing";
          sd.severity = "critical";
        }
        continue;
      }

      const hit = pool.find(
        (c) => !c.used && c.datum.kind === sd.kind && datumsAgree(sd, c.datum).agree,
      );

      if (hit) {
        hit.used = true;
        sd.targetSurface = hit.datum.surface;
        sd.targetBlockId = hit.datum.blockId;
        const verdict = datumsAgree(sd, hit.datum);
        if (verdict.note) {
          findings.push(
            finding({
              check: "datum.reformatted",
              category: "Data fidelity",
              severity: "info",
              blockId,
              datumId: sd.id,
              pageNumber,
              title: `Formatting difference on "${sd.surface}"`,
              detail: `Value matches but the form differs: ${verdict.note}.`,
              suggestion: "Acceptable as-is provided the value is unchanged.",
              sourceExcerpt: sd.context,
              targetExcerpt: hit.datum.context,
            }),
          );
        }
        continue;
      }

      // Changed vs missing: look for a same-kind target datum at roughly the same
      // spot. "5,00,000 -> 6,00,000" is a changed amount; "Rs." with no digits at
      // all is a missing one. Both are critical and both must be shown.
      const sameKind = pool.filter((c) => !c.used && c.datum.kind === sd.kind);
      const nearby = sameKind[0];

      if (nearby) {
        nearby.used = true;
        sd.status = "changed";
        sd.targetSurface = nearby.datum.surface;
        findings.push(
          finding({
            check: `datum.${sd.kind}_changed`,
            category: categoryFor(sd.kind),
            severity: sd.severity,
            blockId,
            datumId: sd.id,
            pageNumber,
            title: `${labelFor(sd.kind)} changed: "${sd.surface}" → "${nearby.datum.surface}"`,
            detail:
              `The source states "${sd.surface}" but the translation states "${nearby.datum.surface}". ` +
              "A changed figure, date, section or reference is a substantive translation error, not a style issue.",
            suggestion: "Correct the English to match the source exactly, then re-verify.",
            sourceExcerpt: sd.context,
            targetExcerpt: nearby.datum.context,
          }),
        );
        continue;
      }

      if (target.trim().length === 0) {
        sd.status = "missing";
        continue;
      }

      sd.status = "missing";
      findings.push(
        finding({
          check: `datum.${sd.kind}_missing`,
          category: categoryFor(sd.kind),
          severity: sd.severity,
          blockId,
          datumId: sd.id,
          pageNumber,
          title: `${labelFor(sd.kind)} "${sd.surface}" missing from the translation`,
          detail:
            `"${sd.surface}" appears in the Gujarati source but no corresponding ${labelFor(sd.kind).toLowerCase()} ` +
            "was found in the English. It was either dropped or rendered in a form this check cannot recognise.",
          suggestion: "Check this segment manually; if the value is absent, restore it.",
          sourceExcerpt: sd.context,
          targetExcerpt: excerpt(target),
        }),
      );
    }

    // Numbers present only in the target: the classic hallucinated-figure finding.
    for (const c of pool) {
      if (c.used) continue;
      if (c.datum.kind !== "currency" && c.datum.kind !== "number" && c.datum.kind !== "date") continue;
      const srcHasSameKind = srcDatums.some((sd) => sd.kind === c.datum.kind);
      if (!srcHasSameKind) continue;
      c.datum.status = "added";
      datums.push({ ...c.datum, status: "added", blockId, pageNumber });
      findings.push(
        finding({
          check: `datum.${c.datum.kind}_added`,
          category: categoryFor(c.datum.kind),
          severity: "major",
          blockId,
          pageNumber,
          title: `Value "${c.datum.surface}" appears only in the translation`,
          detail:
            `"${c.datum.surface}" is present in the English but there is no corresponding value in the Gujarati source. ` +
            "Material that is added rather than translated is one of the most serious failure modes in legal translation.",
          suggestion: "Remove the added value, or identify where it came from if the source contains it in another form.",
          sourceExcerpt: excerpt(source),
          targetExcerpt: c.datum.context,
        }),
      );
    }
  }

  return { datums, findings };
}

function categoryFor(kind: Datum["kind"]): string {
  switch (kind) {
    case "currency":
      return "Amounts";
    case "date":
    case "time":
      return "Dates";
    case "section_ref":
    case "statute":
    case "case_number":
      return "Legal references";
    case "person_name":
    case "party_name":
      return "Names";
    default:
      return "Data fidelity";
  }
}

function labelFor(kind: Datum["kind"]): string {
  switch (kind) {
    case "currency":
      return "Amount";
    case "date":
      return "Date";
    case "time":
      return "Time";
    case "percentage":
      return "Percentage";
    case "section_ref":
      return "Section reference";
    case "case_number":
      return "Case number";
    case "statute":
      return "Statute reference";
    case "person_name":
      return "Name";
    case "party_name":
      return "Party name";
    case "count_phrase":
      return "Count";
    default:
      return "Number";
  }
}

function verifyTerminology(input: VerifyInput): {
  plan: AppliedTerm[];
  findings: Finding[];
} {
  const plan = buildTermPlan(
    input.sourceTexts.map((t, i) => ({ blockId: input.blockIds[i] ?? "", text: t })),
  );

  const findings: Finding[] = [];

  for (let i = 0; i < input.sourceTexts.length; i++) {
    const blockId = input.blockIds[i] ?? "";
    const pageNumber = input.pageNumbers[i];
    const target = input.targetByBlock.get(blockId) ?? "";
    if (target.trim().length === 0) continue;

    for (const v of checkTermCompliance(plan, target, { sourceText: input.sourceTexts[i] ?? "" })) {
      findings.push(termFinding(v, blockId, pageNumber, input.sourceTexts[i] ?? "", target));
    }
  }

  const perBlock = input.sourceTexts.map((t, i) => ({
    blockId: input.blockIds[i] ?? "",
    sourceText: t,
    targetText: input.targetByBlock.get(input.blockIds[i] ?? "") ?? "",
  }));
  for (const v of checkTermConsistency(perBlock, plan)) {
    findings.push(
      finding({
        check: `terminology.${v.kind}`,
        category: "Terminology",
        severity: v.severity,
        title: `Inconsistent rendering of "${v.surface}"`,
        detail: v.detail,
        suggestion: "Choose one rendering for this term and apply it throughout the document.",
        sourceExcerpt: v.expected,
        targetExcerpt: v.actual,
      }),
    );
  }

  return { plan, findings };
}

function termFinding(
  v: TermViolation,
  blockId: string,
  pageNumber: number,
  sourceText: string,
  targetText: string,
): Finding {
  const titles: Record<TermViolation["kind"], string> = {
    not_present: `Glossary term "${v.surface}" missing from the translation`,
    wrong_target: `Wrong rendering for "${v.surface}"`,
    literal_translation: `Literal rendering: "${v.surface}" → "${v.actual}"`,
    inconsistent_target: `Variant rendering of "${v.surface}"`,
  };
  return finding({
    check: `terminology.${v.kind}`,
    category: "Terminology",
    severity: v.severity,
    blockId,
    pageNumber,
    title: titles[v.kind],
    detail: v.detail,
    suggestion:
      v.kind === "inconsistent_target"
        ? "Confirm the house convention for this term and apply it consistently."
        : `Use "${v.expected}" unless a different rendering is better for this document, in which case record the reason.`,
    sourceExcerpt: excerpt(sourceText, v.surface),
    targetExcerpt: excerpt(targetText, v.actual),
  });
}

/**
 * Structural verification: coverage, stunted output, untranslated residue.
 *
 * Untranslated Gujarati in the English column is caught here rather than by the
 * judge because it is mechanically detectable and unambiguous.
 */
export function verifyStructure(input: VerifyInput): {
  findings: Finding[];
  alignment: AlignmentResult;
  coverage: ReturnType<typeof computeCoverage>;
} {
  const findings: Finding[] = [];

  // Alignment has to compare like with like. `sourceTexts` is one entry per
  // block, but the unit of translation is a sentence (buildSegments splits every
  // block), so a paragraph-heavy document always produced more target segments
  // than source entries and the surplus was reported as hallucinated content —
  // a critical finding against text that was in the source all along. Take the
  // source side from the segments themselves, which is exactly the granularity
  // the translation stage worked in.
  const srcSentences = input.translated.map((t) => t.source).filter((t) => t.trim().length > 0);
  const tgtSentences = input.translated.filter((t) => t.target.trim().length > 0).map((t) => t.target);
  const alignment = alignSegments(srcSentences, tgtSentences);
  const coverage = computeCoverage(input.sourceTexts, input.blockIds.map((b) => input.targetByBlock.get(b) ?? ""));

  for (const idx of coverage.emptyBlocks) {
    const blockId = input.blockIds[idx] ?? "";
    findings.push(
      finding({
        check: "structure.block_empty",
        category: "Coverage",
        severity: "critical",
        blockId,
        pageNumber: input.pageNumbers[idx],
        title: `Block ${idx + 1} has no English`,
        detail: "This paragraph produced no English output at all. Content has been lost from the translation.",
        suggestion: "Re-translate this block. If the block is genuinely non-textual, mark it as such in review.",
        sourceExcerpt: excerpt(input.sourceTexts[idx] ?? ""),
        targetExcerpt: "(empty)",
      }),
    );
  }

  for (const idx of coverage.stuntedBlocks) {
    const blockId = input.blockIds[idx] ?? "";
    const src = input.sourceTexts[idx] ?? "";
    const tgt = input.targetByBlock.get(blockId) ?? "";
    findings.push(
      finding({
        check: "structure.block_stunted",
        category: "Coverage",
        severity: "major",
        blockId,
        pageNumber: input.pageNumbers[idx],
        title: `Block ${idx + 1} is much shorter than its source`,
        detail:
          `The Gujarati source is ${src.length} characters and the English is ${tgt.length}. ` +
          "A substantially shorter translation is the signature of a compressed or summarised passage.",
        suggestion: "Compare line by line and restore any omitted clauses.",
        sourceExcerpt: excerpt(src),
        targetExcerpt: excerpt(tgt),
      }),
    );
  }

  for (const seg of input.translated) {
    const ratio = indicRatio(seg.target);
    if (ratio > 0.08) {
      findings.push(
        finding({
          check: "structure.untranslated_residue",
          category: "Coverage",
          severity: "major",
          title: `Segment ${seg.index + 1} still contains Gujarati`,
          detail:
            `${(ratio * 100).toFixed(0)}% of this English segment is still Gujarati script. ` +
            "Gujarati text left inside the English column is either an untranslated passage or a failed romanisation.",
          suggestion: "Translate the remaining text, or confirm the Gujarati run is an intentional verbatim quotation.",
          sourceExcerpt: "",
          targetExcerpt: excerpt(seg.target),
        }),
      );
    }

    if (/^\s*(?:\[\d+\]|-\s*)?$/.test(seg.target) && seg.target.trim().length > 0) {
      findings.push(
        finding({
          check: "structure.echo_only",
          category: "Coverage",
          severity: "critical",
          title: `Segment ${seg.index + 1} is not a translation`,
          detail: "The output for this segment is effectively empty (it contains only numbering or punctuation).",
          suggestion: "Re-translate this segment.",
          sourceExcerpt: "",
          targetExcerpt: seg.target,
        }),
      );
    }
  }

  if (alignment.unmatchedSource.length > 0) {
    findings.push(
      finding({
        check: "structure.alignment_mismatch",
        category: "Coverage",
        severity: "major",
        title: `${alignment.unmatchedSource.length} source segment(s) have no aligned English`,
        detail:
          "Source and target sentence counts do not agree, so some content cannot be attributed to a specific source sentence. " +
          "Findings in this document are therefore less precise than usual.",
        suggestion: "Re-run translation for the affected chunk; the provider did not honour the one-segment-per-input invariant.",
        sourceExcerpt: "",
        targetExcerpt: "",
      }),
    );
  }

  if (alignment.unmatchedTarget.length > 0) {
    findings.push(
      finding({
        check: "structure.hallucinated_segment",
        category: "Coverage",
        severity: "critical",
        title: `${alignment.unmatchedTarget.length} English segment(s) have no Gujarati source`,
        detail:
          "The translation contains sentences that do not correspond to anything in the source. " +
          "This is the clearest evidence of added content.",
        suggestion: "Identify and remove the added material, or verify it exists in the source in another form.",
        sourceExcerpt: "",
        targetExcerpt: "",
      }),
    );
  }

  return { findings, alignment, coverage };
}

function indicRatio(s: string): number {
  const total = s.replace(/\s/g, "").length;
  if (total === 0) return 0;
  return ((s.match(/[઀-૿ऀ-ॿ]/g) ?? []).length) / total;
}

// ── Semantic judge ───────────────────────────────────────────────────────────

/**
 * LLM faithfulness pass.
 *
 * This is the only stage that can detect meaning-level errors that look
 * structurally perfect: a negation dropped, "may" hardened to "shall", an
 * exception inverted. It is also the least reliable, which is why its output is
 * advisory and every finding it raises still requires human confirmation.
 */
export async function runJudge(
  llm: LlmClient,
  input: VerifyInput,
  opts: { signal?: AbortSignal; model?: string } = {},
): Promise<JudgeResult> {
  if (!llm.available) {
    return {
      segments: [],
      documentNotes: [],
      documentFaithful: true,
      available: false,
    };
  }

  const prompt = buildJudgePrompt(input);

  try {
    const raw = await llm.complete(
      [
        { role: "system", content: VERIFIER_SYSTEM },
        { role: "user", content: prompt },
      ],
      { json: true, signal: opts.signal, model: opts.model ?? (config.llm.judgeModel || undefined), temperature: 0 },
    );

    const parsed = parseJson<{
      segments?: Array<{ index?: number; faithful?: boolean; issues?: JudgeIssue[]; confidence?: number }>;
      documentNotes?: string[];
      documentFaithful?: boolean;
    }>(raw);

    const segments = (parsed.segments ?? []).map((s) => ({
      index: s.index ?? -1,
      faithful: Boolean(s.faithful),
      issues: s.issues ?? [],
      confidence: typeof s.confidence === "number" ? Math.min(1, Math.max(0, s.confidence)) : 0.6,
    }));

    return {
      segments,
      documentNotes: parsed.documentNotes ?? [],
      documentFaithful: segments.every((s) => s.faithful),
      available: true,
    };
  } catch (err) {
    return {
      segments: [],
      documentNotes: [
        `Semantic verification could not run: ${err instanceof Error ? err.message : "unknown error"}. ` +
          "Deterministic checks completed, but meaning-level issues are not covered in this run.",
      ],
      documentFaithful: true,
      available: false,
    };
  }
}

/**
 * Build the semantic judge's prompt.
 *
 * Delegates pair rendering to `buildVerifierPrompt` so the label format has one
 * definition. The offline providers parse the prompt back out of their own
 * response with `parseJudgePairs`, which requires exactly this shape.
 */
export function buildJudgePrompt(input: VerifyInput): string {
  return buildVerifierPrompt({
    segments: input.blockIds.map((blockId, i) => ({
      id: i,
      source: input.sourceTexts[i] ?? "",
      target: input.targetByBlock.get(blockId) ?? "",
    })),
    docContext: "Gujarati → English legal translation under audit.",
    languagePair: "gu-IN → en-IN (Indian legal register)",
  });
}

function judgeFindings(judge: JudgeResult, input: VerifyInput): Finding[] {
  const out: Finding[] = [];

  for (const seg of judge.segments) {
    const i = seg.index;
    if (i < 0 || i >= input.sourceTexts.length) continue;
    const blockId = input.blockIds[i] ?? "";
    const sourceText = input.sourceTexts[i] ?? "";
    const targetText = input.targetByBlock.get(blockId) ?? "";

    for (const issue of seg.issues) {
      out.push(
        finding({
          check: `semantic.${issue.code.toLowerCase()}`,
          category: "Semantic fidelity",
          severity: normalizeSeverity(issue.severity),
          blockId,
          pageNumber: input.pageNumbers[i],
          title: `${issue.code}: segment ${i + 1}`,
          detail: issue.detail,
          suggestion: issue.suggestion ?? "Compare the source and target directly and correct the English.",
          sourceExcerpt: excerpt(sourceText, issue.quote ?? ""),
          targetExcerpt: excerpt(targetText, issue.quote ?? ""),
        }),
      );
    }
  }

  return out;
}

function normalizeSeverity(s: Severity | undefined): Severity {
  if (s === "critical" || s === "major" || s === "minor" || s === "info") return s;
  return "major";
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Fidelity indicator.
 *
 * This is NOT an accuracy percentage and must never be presented as one. It is a
 * weighted indicator over checks that can be automated, with the weights chosen
 * so that unverified data fidelity and terminology cannot be masked by fluent
 * prose. `certifiedReady` is a separate boolean rather than a number, because
 * "82% certified" is not a thing and reporting it would invite exactly the
 * reliance this product must not encourage.
 */
export function scoreVerification(
  findings: Finding[],
  opts: {
    coverage: ReturnType<typeof computeCoverage>;
    judge: JudgeResult;
    meanOcrConfidence: number | null;
    datumCount: number;
    termCount: number;
  },
): ScoreBreakdown {
  const open = findings.filter((f) => f.status === "open");
  const criticalCount = open.filter((f) => f.severity === "critical").length;
  const majorCount = open.filter((f) => f.severity === "major").length;
  const minorCount = open.filter((f) => f.severity === "minor").length;

  const datumIntegrity =
    opts.datumCount === 0
      ? 1
      : Math.max(0, 1 - (criticalCount * 1 + majorCount * 0.5 + minorCount * 0.25) / Math.max(1, opts.datumCount));

  const terminology =
    opts.termCount === 0
      ? 1
      : Math.max(
          0,
          1 - open.filter((f) => f.category === "Terminology").reduce((acc, f) => acc + weight(f.severity), 0) / opts.termCount,
        );

  const coverage = opts.coverage.ratio;

  // No judge means no semantic signal. We must not report a high score for a
  // check that never ran; the score is capped instead.
  const semantic = opts.judge.available
    ? Math.max(0, 1 - open.filter((f) => f.category === "Semantic fidelity").reduce((a, f) => a + weight(f.severity), 0) / Math.max(4, opts.judge.segments.length / 4))
    : 0.55;

  const ocrConfidence = opts.meanOcrConfidence ?? 0.9;

  const total =
    datumIntegrity * 0.3 + terminology * 0.2 + coverage * 0.15 + semantic * 0.3 + ocrConfidence * 0.05;

  const clamped = Math.max(0, Math.min(1, total));
  const grade: ScoreBreakdown["grade"] =
    criticalCount > 0 || clamped < 0.7 ? "red" : criticalCount === 0 && majorCount === 0 && clamped >= 0.9 ? "green" : "yellow";

  return {
    datumIntegrity: round(datumIntegrity),
    terminology: round(terminology),
    coverage: round(coverage),
    semantic: round(semantic),
    ocrConfidence: round(ocrConfidence),
    total: round(clamped),
    criticalCount,
    grade,
    certifiedReady:
      criticalCount === 0 &&
      opts.coverage.ratio === 1 &&
      opts.coverage.emptyBlocks.length === 0 &&
      opts.judge.available &&
      opts.judge.documentFaithful,
  };
}

function weight(s: Severity): number {
  return s === "critical" ? 1 : s === "major" ? 0.5 : s === "minor" ? 0.2 : 0;
}

function round(n: number): number {
  return Number(n.toFixed(3));
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function verifyDocument(
  llm: LlmClient,
  input: VerifyInput,
  opts: { signal?: AbortSignal; judgeModel?: string } = {},
): Promise<VerificationResult> {
  const warnings: string[] = [];

  const structural = verifyStructure(input);
  const { datums, findings: datumFindings } = verifyDatums(input);
  const { plan, findings: termFindings } = verifyTerminology(input);

  const judge = await runJudge(llm, input, { signal: opts.signal, model: opts.judgeModel });
  if (!judge.available) {
    warnings.push("Semantic verification did not run; the fidelity indicator is capped and less meaningful than usual.");
  }

  const findings = [...structural.findings, ...datumFindings, ...termFindings, ...judgeFindings(judge, input)];
  const score = scoreVerification(findings, {
    coverage: structural.coverage,
    judge,
    meanOcrConfidence: input.meanOcrConfidence,
    datumCount: datums.length,
    termCount: plan.reduce((a, t) => a + t.count, 0),
  });

  return {
    findings,
    datums,
    score,
    alignment: structural.alignment,
    coverage: structural.coverage,
    termPlan: plan,
    judge,
    warnings,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let findingSeq = 0;

function finding(f: Omit<Finding, "id" | "status">): Finding {
  findingSeq = (findingSeq + 1) % 1_000_000;
  return { ...f, id: `f${Date.now().toString(36)}${findingSeq.toString(36)}`, status: "open" };
}

function excerpt(text: string, around = ""): string {
  const t = normalizeWhitespace(text);
  if (!around) return t.slice(0, 220) + (t.length > 220 ? "…" : "");
  const i = t.toLowerCase().indexOf(around.toLowerCase());
  if (i < 0) return t.slice(0, 220);
  const s = Math.max(0, i - 80);
  return `${s > 0 ? "…" : ""}${t.slice(s, i + around.length + 100)}${i + around.length + 100 < t.length ? "…" : ""}`;
}

export { DISCLAIMER };
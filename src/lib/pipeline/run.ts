import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "../config";
import { all, get, run, tx } from "../db";
import { docTypeLabel, preflightDocument, type Block, type Datum, type Finding } from "../domain";
import { normalizeWhitespace } from "../domain/gujarati";
import { createLlmClient, providerDisplayName } from "../llm";
import type { LlmClient } from "../llm/provider";
import { describeBackends } from "./backends";
import { extractFromBuffer, prepare, type ExtractResult, type PageText } from "./extract";
import { buildReport, generateNarrative, type ReportInput, type VerificationReport } from "./report";
import { buildSegments, translateSegments, type Segment, type TranslatedSegment } from "./translate";
import { verifyDocument, type VerificationResult } from "./verify";
import { exportDocument, type ExportFormat } from "./export";

export type Stage =
  | "uploaded"
  | "extracted"
  | "structured"
  | "classified"
  | "translated"
  | "verified"
  | "reported"
  | "ready"
  | "blocked"
  | "failed";

export interface RunOptions {
  documentId: string;
  buffer: Buffer;
  fileName: string;
  mime: string;
  /** User-supplied document type, overriding detection. */
  declaredType?: string | null;
  llm?: LlmClient;
  signal?: AbortSignal;
  onProgress?: (stage: Stage, detail: string, pct: number) => void;
  /** Re-verify an existing document without re-translating. */
  verifyOnly?: boolean;
  lockedBlocks?: Map<string, string>;
}

export interface RunResult {
  documentId: string;
  stage: Stage;
  pageCount: number;
  blockCount: number;
  segmentCount: number;
  detectedType: string;
  detectedTypeLabel: string;
  typeConfidence: number;
  fidelity: number;
  grade: "green" | "yellow" | "red";
  gateStatus: string;
  criticalCount: number;
  findings: number;
  warnings: string[];
  preflightWarnings: Array<{ code: string; severity: string; message: string }>;
  provider: string;
  ocrEngine: string;
  report: VerificationReport;
  verification: VerificationResult;
  /** True when translation could not proceed and the source must be fixed. */
  blocked: boolean;
}

/**
 * The full document pipeline.
 *
 * Stage order is not negotiable: preflight before translation (never translate
 * the wrong script), structure before translation (alignment needs units),
 * translation before verification (verification compares the two sides), and
 * report last (it summarises actual results, never predicts them).
 *
 * Persistence is per-stage, not all-or-nothing. A long job that fails at
 * verification should not discard the translation and force a re-run that costs
 * money.
 */
export async function runPipeline(opts: RunOptions): Promise<RunResult> {
  ensureDirs();
  const llm = opts.llm ?? createLlmClient();
  const report = (stage: Stage, detail: string, pct: number) => {
    setStage(opts.documentId, stage, detail);
    opts.onProgress?.(stage, detail, pct);
  };

  const sha256 = createHash("sha256").update(opts.buffer).digest("hex");
  const warnings: string[] = [];

  // ── Extract ────────────────────────────────────────────────────────────────
  report("extracted", "Reading document", 5);

  let extraction: ExtractResult;
  let blocks: Block[];
  let prepared: ReturnType<typeof prepare>;
  let translated: TranslatedSegment[] = [];
  let segments: Segment[] = [];

  if (opts.verifyOnly) {
    const stored = loadBlocks(opts.documentId);
    if (stored.length === 0) {
      throw new Error("Cannot verify without blocks: this document has not been processed yet.");
    }
    blocks = stored;
    prepared = {
      blocks,
      pageCount: loadPageCount(opts.documentId),
      preflight: loadPreflight(opts.documentId),
      detection: loadDetection(opts.documentId),
      fullText: blocks.map((b) => b.sourceText).join("\n"),
      meanOcrConfidence: loadMeanOcrConfidence(opts.documentId),
      blocked: false,
      blockReasons: [],
    };
    extraction = { pages: [], pageCount: prepared.pageCount, kind: "text", hasEmbeddedText: true, meanOcrConfidence: prepared.meanOcrConfidence, warnings: [] };
  } else {
    extraction = await extractFromBuffer(opts.buffer, opts.fileName, opts.mime);
    if (extraction.pageCount > config.maxPages) {
      throw new Error(`Document has ${extraction.pageCount} pages; the configured limit is ${config.maxPages}.`);
    }
    warnings.push(...extraction.warnings);

    prepared = prepare(extraction.pages, { declaredType: opts.declaredType });

    if (prepared.meanOcrConfidence != null && prepared.meanOcrConfidence < config.ocrConfidenceFloor) {
      warnings.push(
        `Mean OCR confidence is ${(prepared.meanOcrConfidence * 100).toFixed(1)}%, below the ${(config.ocrConfidenceFloor * 100).toFixed(0)}% floor. ` +
          "The Gujarati source text itself is unreliable; correct it before relying on the translation.",
      );
    }

    persistExtraction(opts.documentId, sha256, opts, extraction, prepared);
  }

  report("structured", `Detected ${prepared.detection.type}`, 25);

  // ── Preflight gate ─────────────────────────────────────────────────────────
  // Hard stop. Translating Devanagari or a legacy-encoded Gujarati font through
  // this pipeline produces fluent, confident nonsense, which is worse than a
  // refusal because nobody can tell it is wrong.
  if (prepared.blocked) {
    const verification = emptyVerification();
    const narrative = {
      executiveSummary:
        `Translation was not attempted. ${prepared.blockReasons.join(" ")}`,
      reviewFocus: ["Obtain a Unicode copy of the source document and re-upload."],
      limitations: ["No translation or verification was performed."],
      recommendedAction: prepared.blockReasons.join(" "),
      modelGenerated: false,
    };
    const reportDoc = buildReport(
      makeReportInput(opts, prepared, verification, llm, sha256, 0, narrative),
      narrative,
    );
    setBlocked(opts.documentId, prepared.blockReasons);
    return {
      documentId: opts.documentId,
      stage: "blocked",
      pageCount: prepared.pageCount,
      blockCount: prepared.blocks.length,
      segmentCount: 0,
      detectedType: prepared.detection.type,
      detectedTypeLabel: docTypeLabel(prepared.detection.type),
      typeConfidence: prepared.detection.confidence,
      fidelity: 0,
      grade: "red",
      gateStatus: "blocked",
      criticalCount: 0,
      findings: 0,
      warnings,
      preflightWarnings: prepared.preflight.warnings,
      provider: providerDisplayName(llm),
      ocrEngine: describeBackends().ocr,
      report: reportDoc,
      verification,
      blocked: true,
    };
  }

  // ── Translate ──────────────────────────────────────────────────────────────
  segments = buildSegments({ blocks: prepared.blocks });
  if (segments.length === 0) {
    throw new Error("No translatable content was found. The file may be empty or contain only images that OCR could not read.");
  }

  if (!opts.verifyOnly) {
    report("translated", `Translating ${segments.length} segments`, 35);

    const locked = new Map<number, string>();
    if (opts.lockedBlocks && opts.lockedBlocks.size > 0) {
      const byId = new Map(segments.map((s) => [s.blockId, s.index]));
      for (const [blockId, text] of opts.lockedBlocks) {
        const idx = byId.get(blockId);
        if (idx !== undefined) locked.set(idx, text);
      }
    }

    const outcome = await translateSegments(llm, segments, {
      docType: prepared.detection.type,
      lockedSegments: locked,
      signal: opts.signal,
      onProgress: (done, total) => {
        const pct = 35 + Math.round((done / Math.max(1, total)) * 35);
        opts.onProgress?.("translated", `Translated ${done}/${total} segments`, pct);
      },
    });

    translated = outcome.segments;
    warnings.push(...outcome.warnings);
    setStage(opts.documentId, "translated", `Translated ${translated.length} segments`);
    persistTranslation(opts.documentId, prepared.blocks, translated);
  } else {
    translated = loadTranslation(opts.documentId);
    if (translated.length === 0) {
      throw new Error("Cannot verify without a stored translation.");
    }
  }

  // ── Verify ─────────────────────────────────────────────────────────────────
  report("verified", "Running verification", 75);

  const sourceTexts = prepared.blocks.map((b) => b.sourceText);
  const blockIds = prepared.blocks.map((b) => b.id);
  const pageNumbers = prepared.blocks.map((b) => b.pageNumber);

  const targetByBlock = new Map<string, string>();
  for (const block of prepared.blocks) {
    targetByBlock.set(block.id, "");
  }
  for (const seg of translated) {
    targetByBlock.set(seg.blockId, joinTarget(targetByBlock.get(seg.blockId), seg.target));
  }

  const verification = await verifyDocument(
    llm,
    {
      sourceTexts,
      blockIds,
      pageNumbers,
      translated,
      targetByBlock,
      docType: prepared.detection.type,
      meanOcrConfidence: prepared.meanOcrConfidence,
    },
    { signal: opts.signal, judgeModel: config.llm.judgeModel },
  );

  warnings.push(...verification.warnings);
  persistVerification(opts.documentId, verification);

  // ── Report ─────────────────────────────────────────────────────────────────
  report("reported", "Generating report", 90);

  const reportInput = makeReportInput(opts, prepared, verification, llm, sha256, translated.length, null);
  const narrative = await generateNarrative(llm, reportInput);
  const reportDoc = buildReport(reportInput, narrative);
  persistReport(opts.documentId, reportDoc);

  report("ready", "Complete", 100);

  return {
    documentId: opts.documentId,
    stage: "ready",
    pageCount: prepared.pageCount,
    blockCount: prepared.blocks.length,
    segmentCount: translated.length,
    detectedType: prepared.detection.type,
    detectedTypeLabel: docTypeLabel(prepared.detection.type),
    typeConfidence: prepared.detection.confidence,
    fidelity: verification.score.total,
    grade: verification.score.grade,
    gateStatus: verification.score.certifiedReady ? "ready_for_certification" : "blocked_by_findings",
    criticalCount: verification.score.criticalCount,
    findings: verification.findings.length,
    warnings,
    preflightWarnings: prepared.preflight.warnings,
    provider: providerDisplayName(llm),
    ocrEngine: describeBackends().ocr,
    report: reportDoc,
    verification,
    blocked: false,
  };
}

function makeReportInput(
  opts: RunOptions,
  prepared: ReturnType<typeof prepare>,
  verification: VerificationResult,
  llm: LlmClient,
  sha256: string,
  segmentCount: number,
  narrative: Parameters<typeof buildReport>[1] | null,
): ReportInput {
  return {
    docId: opts.documentId,
    fileName: opts.fileName,
    docType: prepared.detection.type,
    docTypeLabel: docTypeLabel(prepared.detection.type),
    pageCount: prepared.pageCount,
    providerLabel: providerDisplayName(llm),
    segmentCount,
    verification,
    sourceSha256: sha256,
    translatedAt: new Date().toISOString(),
    reviewer: get<{ reviewer: string | null }>("SELECT reviewer FROM documents WHERE id = ?", opts.documentId)?.reviewer ?? null,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function persistExtraction(
  documentId: string,
  sha256: string,
  opts: RunOptions,
  extraction: ExtractResult,
  prepared: ReturnType<typeof prepare>,
): void {
  const now = new Date().toISOString();
  const doc = get<{ stored_name: string }>("SELECT stored_name FROM documents WHERE id = ?", documentId);
  if (doc?.stored_name) {
    fs.writeFileSync(path.join(config.uploadDir, doc.stored_name), opts.buffer);
  }

  tx(() => {
    run(
      `UPDATE documents SET sha256 = ?, detected_type = ?, type_confidence = ?, page_count = ?, stage = 'extracted', updated_at = ? WHERE id = ?`,
      sha256,
      prepared.detection.type,
      prepared.detection.confidence,
      prepared.pageCount,
      now,
      documentId,
    );

    run("DELETE FROM pages WHERE document_id = ?", documentId);
    for (const page of extraction.pages) {
      run(
        `INSERT INTO pages (id, document_id, page_number, kind, char_count, ocr_engine, ocr_confidence, needs_review, raw_text, warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${documentId}-p${page.pageNumber}`,
        documentId,
        page.pageNumber,
        page.kind,
        page.text.length,
        page.engine,
        page.confidence,
        page.kind === "scanned" && (page.confidence ?? 1) < config.ocrPageReviewThreshold ? 1 : 0,
        page.text,
        JSON.stringify(page.warnings),
      );
    }

    run("DELETE FROM blocks WHERE document_id = ?", documentId);
    run("DELETE FROM segments WHERE document_id = ?", documentId);
    // Block IDs are globally unique: `blocks.id` is the primary key, so a bare
    // `b1` from a second document would collide with the first and silently
    // overwrite it (or trip the UNIQUE(document_id, ordinal) constraint).
    const idMap = new Map<string, string>();
    for (const block of prepared.blocks) {
      const storedId = `${documentId}-${block.id}`;
      idMap.set(block.id, storedId);
      run(
        `INSERT INTO blocks (id, document_id, page_number, ordinal, kind, source_text, target_text, translation_state, token_count, meta, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        storedId,
        documentId,
        block.pageNumber,
        block.ordinal,
        block.kind,
        block.sourceText,
        "",
        "pending",
        block.tokenCount,
        JSON.stringify(block.meta),
        null,
      );
    }

    log(documentId, "extracted", `${extraction.kind}, ${prepared.pageCount} page(s), ${prepared.blocks.length} block(s)`);
  });
}

/** Map in-memory block IDs (`b1`) to their stored primary keys (`doc-…-b1`). */
export function blockIdMap(documentId: string, blocks: Block[]): Map<string, string> {
  return new Map(blocks.map((b) => [b.id, `${documentId}-${b.id}`]));
}

function persistTranslation(documentId: string, blocks: Block[], translated: TranslatedSegment[]): void {
  const now = new Date().toISOString();
  const idMap = blockIdMap(documentId, blocks);
  const blockById = new Map(blocks.map((b) => [b.id, b]));

  const byBlock = new Map<string, string[]>();
  for (const seg of translated) {
    const arr = byBlock.get(seg.blockId) ?? [];
    if (seg.target.trim().length > 0) arr.push(seg.target);
    byBlock.set(seg.blockId, arr);
  }

  tx(() => {
    // Sentence-level rows first: these are the audit record that lets
    // `verifyOnly` re-check the 1:1 segment invariant without re-running the model.
    run("DELETE FROM segments WHERE document_id = ?", documentId);
    for (const seg of translated) {
      const block = blockById.get(seg.blockId);
      run(
        `INSERT INTO segments (id, document_id, block_id, idx, page_number, source_text, target_text, state, confidence, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${documentId}-s${seg.index}`,
        documentId,
        idMap.get(seg.blockId) ?? `${documentId}-${seg.blockId}`,
        seg.index,
        block?.pageNumber ?? 0,
        seg.source,
        seg.target,
        seg.target.trim().length === 0 ? "failed" : "ai",
        seg.confidence ?? null,
        seg.locked ? 1 : 0,
      );
    }

    for (const block of blocks) {
      const segs = byBlock.get(block.id) ?? [];
      const target = normalizeWhitespace(segs.join(" "));
      const state = target.length === 0 ? "failed" : "ai";
      run(
        "UPDATE blocks SET target_text = ?, translation_state = ? WHERE id = ? AND document_id = ?",
        target,
        state,
        idMap.get(block.id) ?? `${documentId}-${block.id}`,
        documentId,
      );
    }

    run(
      `UPDATE documents SET status = 'translated', stage = 'translated', updated_at = ? WHERE id = ?`,
      now,
      documentId,
    );

    log(documentId, "translated", `${translated.length} segment(s)`);
  });
}

function persistVerification(documentId: string, v: VerificationResult): void {
  const now = new Date().toISOString();

  tx(() => {
    run("DELETE FROM datums WHERE document_id = ?", documentId);
    for (const d of v.datums) {
      run(
        `INSERT INTO datums (id, document_id, origin, kind, block_id, page_number, surface, normalized, context, target_surface, target_block_id, status, severity, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${documentId}-${d.id}`,
        documentId,
        // An "added" datum is a value found only in the English, so it belongs to
        // the target side even though it travels in the same list.
        d.status === "added" ? "target" : "source",
        d.kind,
        d.blockId ?? null,
        d.pageNumber ?? null,
        d.surface,
        d.normalized,
        d.context,
        d.targetSurface ?? null,
        d.targetBlockId ?? null,
        d.status,
        d.severity,
        JSON.stringify(d.meta ?? {}),
      );
    }

    run("DELETE FROM findings WHERE document_id = ?", documentId);
    for (const f of v.findings) {
      run(
        `INSERT INTO findings (id, document_id, "check", category, severity, block_id, datum_id, page_number, title, detail, suggestion, source_excerpt, target_excerpt, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        // Finding ids come from the verifier's per-run counters, so they collide
        // across documents ("f1", "f2", ...) exactly like un-namespaced datum ids
        // did. Namespacing keeps the id unique and keeps block_id/datum_id
        // pointing at the same namespaced rows the other tables store.
        `${documentId}-${f.id}`,
        documentId,
        f.check,
        f.category,
        f.severity,
        f.blockId ? `${documentId}-${f.blockId}` : null,
        f.datumId ? `${documentId}-${f.datumId}` : null,
        f.pageNumber ?? null,
        f.title,
        f.detail,
        f.suggestion,
        f.sourceExcerpt,
        f.targetExcerpt,
        f.status,
        now,
      );
    }

    run(
      `INSERT INTO verification_runs (id, document_id, engine, engine_version, fidelity, components, counts, gate_status, gate_reasons, judge_used, judge_summary, duration_ms, created_at)
       VALUES (?, ?, 'deterministic+llm-judge', '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `${documentId}-vr-${Date.now().toString(36)}`,
      documentId,
      v.score.total,
      JSON.stringify({
        datumIntegrity: v.score.datumIntegrity,
        terminology: v.score.terminology,
        coverage: v.score.coverage,
        semantic: v.score.semantic,
        ocrConfidence: v.score.ocrConfidence,
      }),
      JSON.stringify({
        total: v.findings.length,
        critical: v.score.criticalCount,
        major: v.findings.filter((f) => f.severity === "major").length,
        minor: v.findings.filter((f) => f.severity === "minor").length,
        datums: v.datums.length,
        blocks: v.coverage.totalBlocks,
      }),
      v.score.certifiedReady ? "ready_for_certification" : "blocked_by_findings",
      JSON.stringify(blockingReasons(v)),
      v.judge.available ? 1 : 0,
      v.judge.documentNotes.join(" | "),
      0,
      now,
    );

    run(
      `UPDATE documents SET fidelity = ?, fidelity_band = ?, gate_status = ?, stage = 'verified', updated_at = ? WHERE id = ?`,
      v.score.total,
      v.score.grade,
      v.score.certifiedReady ? "ready_for_certification" : "blocked_by_findings",
      now,
      documentId,
    );

    log(documentId, "verified", `${v.findings.length} finding(s), ${v.score.criticalCount} critical, fidelity ${(v.score.total * 100).toFixed(1)}%`);
  });
}

function blockingReasons(v: VerificationResult): string[] {
  const reasons: string[] = [];
  if (v.score.criticalCount > 0) reasons.push(`${v.score.criticalCount} critical finding(s) open`);
  if (v.coverage.emptyBlocks.length > 0) reasons.push(`${v.coverage.emptyBlocks.length} block(s) without English`);
  if (!v.judge.available) reasons.push("semantic verification did not run");
  return reasons;
}

function persistReport(documentId: string, report: VerificationReport): void {
  const now = new Date().toISOString();
  tx(() => {
    run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", `report:${documentId}`, JSON.stringify(report), now);
    run("UPDATE documents SET status = 'ready', stage = 'ready', updated_at = ? WHERE id = ?", now, documentId);
    log(documentId, "reported", `report generated (${report.fidelityIndicator.grade})`);
  });
}

function setStage(documentId: string, stage: Stage, detail: string): void {
  run("UPDATE documents SET stage = ?, updated_at = ? WHERE id = ?", stage, new Date().toISOString(), documentId);
  if (stage === "ready" || stage === "failed") log(documentId, stage, detail);
}

function setBlocked(documentId: string, reasons: string[]): void {
  const now = new Date().toISOString();
  tx(() => {
    run(
      `UPDATE documents SET status = 'blocked', stage = 'blocked', gate_status = 'blocked_by_preflight', error = ?, updated_at = ? WHERE id = ?`,
      reasons.join(" "),
      now,
      documentId,
    );
    log(documentId, "blocked", reasons.join(" "));
  });
}

export function createDocument(input: {
  fileName: string;
  mime: string;
  sizeBytes: number;
  declaredType?: string | null;
}): string {
  const id = `d-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const stored = `${id}${path.extname(input.fileName) || ".bin"}`;
  run(
    `INSERT INTO documents (id, file_name, stored_name, mime, size_bytes, sha256, declared_type, status, stage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, 'uploaded', 'uploaded', ?, ?)`,
    id,
    input.fileName,
    stored,
    input.mime,
    input.sizeBytes,
    input.declaredType ?? null,
    now,
    now,
  );
  return id;
}

function log(documentId: string, action: string, detail: string): void {
  run(
    "INSERT INTO activity (id, document_id, actor, action, detail, created_at) VALUES (?, ?, 'system', ?, ?, ?)",
    `a-${randomUUID().slice(0, 8)}`,
    documentId,
    action,
    detail,
    new Date().toISOString(),
  );
}

// ── Loaders ──────────────────────────────────────────────────────────────────

/**
 * Strip the documentId prefix from a persisted row id.
 *
 * Blocks and datums are stored namespaced so their primary keys are unique
 * across documents, but the rest of the code addresses blocks by the verifier's
 * own ids. Readers therefore un-prefix on the way out, keeping ids in one shape
 * everywhere outside the database.
 */
export function unprefixId(documentId: string, id: string): string {
  const prefix = `${documentId}-`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export function loadBlocks(documentId: string): Block[] {
  const rows = all<{
    id: string; page_number: number; ordinal: number; kind: string; source_text: string; target_text: string;
    translation_state: string; token_count: number; meta: string; confidence: number | null;
  }>("SELECT * FROM blocks WHERE document_id = ? ORDER BY ordinal", documentId);

  return rows.map((r) => ({
    id: unprefixId(documentId, r.id),
    ordinal: r.ordinal,
    pageNumber: r.page_number,
    kind: r.kind as Block["kind"],
    sourceText: r.source_text,
    targetText: r.target_text,
    translationState: r.translation_state as Block["translationState"],
    tokenCount: r.token_count,
    meta: safeJson(r.meta),
    confidence: r.confidence ?? undefined,
  }));
}

/**
 * Re-read the stored translation for re-verification.
 *
 * Prefers the `segments` table, which preserves sentence-level alignment, so
 * re-verification can re-check the 1:1 invariant instead of re-deriving it from
 * joined block text. Blocks joined per-block, so a document saved before the
 * segments table existed has no sentence boundaries to recover and falls back to
 * one segment per block.
 */
export function loadTranslation(documentId: string): TranslatedSegment[] {
  const rows = all<{
    id: string;
    block_id: string;
    idx: number;
    source_text: string;
    target_text: string;
    state: string;
    confidence: number | null;
    locked: number;
  }>(
    "SELECT id, block_id, idx, source_text, target_text, state, confidence, locked FROM segments WHERE document_id = ? ORDER BY idx",
    documentId,
  );

  if (rows.length > 0) {
    // block_id is stored namespaced; un-prefix it so it joins to loadBlocks.
    return rows.map((r) => ({
      index: r.idx,
      blockId: unprefixId(documentId, r.block_id),
      source: r.source_text,
      target: r.target_text,
      confidence: r.confidence ?? 1,
      locked: r.locked === 1,
    }));
  }

  const blocks = all<{ id: string; source_text: string; target_text: string }>(
    "SELECT id, source_text, target_text FROM blocks WHERE document_id = ? ORDER BY ordinal",
    documentId,
  );
  return blocks.map((r, i) => ({
    index: i,
    blockId: unprefixId(documentId, r.id),
    source: r.source_text,
    target: r.target_text,
    confidence: 1,
  }));
}

export function loadFindings(documentId: string): Finding[] {
  const rows = all<{
    id: string; check: string; category: string; severity: string; block_id: string | null; datum_id: string | null;
    page_number: number | null; title: string; detail: string; suggestion: string;
    source_excerpt: string; target_excerpt: string; status: string;
  }>("SELECT * FROM findings WHERE document_id = ? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END", documentId);

  return rows.map((r) => ({
    id: unprefixId(documentId, r.id),
    check: r.check,
    category: r.category,
    severity: r.severity as Finding["severity"],
    blockId: r.block_id ? unprefixId(documentId, r.block_id) : undefined,
    datumId: r.datum_id ? unprefixId(documentId, r.datum_id) : undefined,
    pageNumber: r.page_number ?? undefined,
    title: r.title,
    detail: r.detail,
    suggestion: r.suggestion,
    sourceExcerpt: r.source_excerpt,
    targetExcerpt: r.target_excerpt,
    status: r.status as Finding["status"],
  }));
}

export function loadDatums(documentId: string): Datum[] {
  const rows = all<{
    id: string; kind: string; block_id: string | null; page_number: number | null; surface: string;
    normalized: string; context: string; target_surface: string | null; status: string; severity: string;
  }>("SELECT * FROM datums WHERE document_id = ? ORDER BY page_number, id", documentId);

  return rows.map((r) => ({
    id: unprefixId(documentId, r.id),
    kind: r.kind as Datum["kind"],
    surface: r.surface,
    normalized: r.normalized,
    context: r.context,
    blockId: r.block_id ? unprefixId(documentId, r.block_id) : undefined,
    pageNumber: r.page_number ?? undefined,
    targetSurface: r.target_surface ?? undefined,
    status: r.status as Datum["status"],
    severity: r.severity as Datum["severity"],
  }));
}

export function loadReport(documentId: string): VerificationReport | null {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `report:${documentId}`);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as VerificationReport;
  } catch {
    return null;
  }
}

export function loadPageCount(documentId: string): number {
  return get<{ n: number }>("SELECT page_count AS n FROM documents WHERE id = ?", documentId)?.n ?? 0;
}

export function loadMeanOcrConfidence(documentId: string): number | null {
  const row = get<{ avg: number | null }>(
    "SELECT AVG(ocr_confidence) AS avg FROM pages WHERE document_id = ? AND ocr_confidence IS NOT NULL",
    documentId,
  );
  return row?.avg ?? null;
}

function loadDetection(documentId: string): ReturnType<typeof prepare>["detection"] {
  const row = get<{ detected_type: string | null; declared_type: string | null; type_confidence: number | null }>(
    "SELECT detected_type, declared_type, type_confidence FROM documents WHERE id = ?",
    documentId,
  );
  const t = row?.declared_type ?? row?.detected_type ?? "other_legal";
  return { type: t as never, confidence: row?.type_confidence ?? 0, scores: [], register: "instrument" };
}

function loadPreflight(documentId: string): ReturnType<typeof prepare>["preflight"] {
  const text = all<{ raw_text: string }>("SELECT raw_text FROM pages WHERE document_id = ? ORDER BY page_number", documentId)
    .map((r) => r.raw_text)
    .join("\n");
  // Recomputed rather than stored: the pages are the source of truth and a
  // cached preflight could disagree with them after a source edit.
  return prepareTextFallback(text);
}

function prepareTextFallback(text: string): ReturnType<typeof prepare>["preflight"] {
  return preflightDocument(text);
}

function emptyVerification(): VerificationResult {
  return {
    findings: [],
    datums: [],
    score: {
      datumIntegrity: 0,
      terminology: 0,
      coverage: 0,
      semantic: 0,
      ocrConfidence: 0,
      total: 0,
      criticalCount: 0,
      grade: "red",
      certifiedReady: false,
    },
    alignment: { pairs: [], method: "positional", unmatchedSource: [], unmatchedTarget: [], exact: true },
    coverage: { totalBlocks: 0, translatedBlocks: 0, emptyBlocks: [], stuntedBlocks: [], ratio: 0 },
    termPlan: [],
    judge: { segments: [], documentNotes: [], documentFaithful: true, available: false },
    warnings: [],
  };
}

function joinTarget(existing: string | undefined, next: string): string {
  if (!existing || existing.length === 0) return next;
  if (!next || next.length === 0) return existing;
  return `${existing} ${next}`;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export { exportDocument };
export type { ExportFormat, PageText, VerificationReport };
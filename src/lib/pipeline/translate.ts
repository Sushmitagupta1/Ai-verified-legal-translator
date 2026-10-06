import { config } from "../config";
import {
  DISCLAIMER,
  estimateTokens,
  normalizeWhitespace,
  splitSentences,
} from "../domain";
import type { Block, BlockKind } from "../domain";
import { buildDocContext } from "../llm/doctype-context";
import { TRANSLATION_SYSTEM, buildUserPrompt } from "../llm/prompts";
import { parseJson } from "../llm/provider";
import type { LlmClient } from "../llm/provider";
import { buildTermPlan, formatTermPlanForPrompt, findTerms, type TermOccurrence } from "../verify/terminology";

export interface Segment {
  /** Index within the whole document; this is the alignment key. */
  index: number;
  blockId: string;
  /** Block ordinal when the segment maps 1:1 to a block, else undefined. */
  blockOrdinal?: number;
  source: string;
  kind: BlockKind;
  pageNumber: number;
  /** True when the source is English and must be carried through untranslated. */
  passthrough?: boolean;
  termHits: TermOccurrence[];
}

export interface TranslatedSegment {
  index: number;
  blockId: string;
  /** Gujarati source for this segment. Persisted so re-verification needs no re-run. */
  source: string;
  target: string;
  confidence: number;
  /** Reviewer-locked: never retranslate, but do re-verify. */
  locked?: boolean;
  notes?: string[];
}

export interface ChunkResult {
  segments: TranslatedSegment[];
  ambiguousTerms: Array<{ source: string; chosen: string; alternatives: string[]; reason: string }>;
}

export interface TranslationResult {
  segments: TranslatedSegment[];
  ambiguousTerms: ChunkResult["ambiguousTerms"];
  chunks: number;
  calls: number;
  warnings: string[];
}

/** Kinds that are structure, not content. They are never sent to the model. */
const NON_TRANSLATABLE: ReadonlySet<BlockKind> = new Set<BlockKind>([
  "footer",
  "header",
  "page_break",
  "seal_note",
]);

/**
 * The clause label is numbering, not words.
 *
 * "12." must not become "Twelve." — renumbering a judgment's clauses changes its
 * meaning and breaks every downstream cross-reference. We detach the label, send
 * only the prose, and re-attach the original characters verbatim.
 */
const CLAUSE_LABEL_RE = /^\s*(\(?\d{1,3}(?:\.\d{1,3}){0,4}[.)]?|[a-z]\)|\([ivx]+\))\s+/i;

export interface SegmentInput {
  blocks: Block[];
  /** Entity names discovered in the document, used for consistency anchoring. */
  nameHints?: string[];
}

/**
 * Split blocks into translation segments.
 *
 * The unit of translation is a sentence, not a paragraph. Paragraph-level
 * translation makes 1:1 alignment impossible, which in turn makes omission
 * detection impossible — the entire verification design depends on losing it.
 */
export function buildSegments({ blocks, nameHints = [] }: SegmentInput): Segment[] {
  const segments: Segment[] = [];
  const englishDoc = blocks.every((b) => !/[઀-૿]/.test(b.sourceText));

  for (const block of blocks) {
    if (NON_TRANSLATABLE.has(block.kind)) continue;

    const text = block.sourceText.trim();
    if (!text) continue;

    const isLatin = !/[઀-૿ऀ-ॿ]/.test(text);
    const passthrough = isLatin && (englishDoc || /[A-Za-z]{4,}/.test(text) && !/[઀-૿]/.test(text));

    const sentences = splitSentences(text);
    if (sentences.length === 0) {
      segments.push(mkSegment(segments.length, block, text, englishDoc, nameHints));
      continue;
    }

    for (const s of sentences) {
      segments.push(mkSegment(segments.length, block, s.trim(), englishDoc, nameHints));
    }
  }

  return segments;
}

function mkSegment(
  index: number,
  block: Block,
  text: string,
  englishDoc: boolean,
  nameHints: string[],
): Segment {
  const isLatin = !/[઀-૿ऀ-ॿ]/.test(text);
  // In a Gujarati document, a Latin run is usually a name, a citation, or an
  // abbreviation (FIR, IPC, Rs.). Those must survive verbatim, so they are
  // passthrough segments rather than transliteration candidates.
  const passthrough = isLatin && !englishDoc;

  return {
    index,
    blockId: block.id,
    blockOrdinal: block.ordinal,
    source: text,
    kind: block.kind,
    pageNumber: block.pageNumber,
    passthrough,
    termHits: findTerms(text),
  };
}

interface Chunk {
  segments: Segment[];
  tokens: number;
}

/**
 * Pack segments into chunks under the token budget.
 *
 * Segments are never split across chunks even when that overshoots the budget:
 * a split segment would break the 1:1 invariant the verifier depends on. A single
 * oversized segment is sent alone and flagged.
 */
export function chunkSegments(segments: Segment[], budget = config.chunkTokenBudget): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Segment[] = [];
  let tokens = 0;

  for (const seg of segments) {
    const t = estimateTokens(seg.source);

    if (current.length > 0 && tokens + t > budget) {
      chunks.push({ segments: current, tokens });
      current = [];
      tokens = 0;
    }

    current.push(seg);
    tokens += t;

    // Close a chunk once it is comfortably full so the next segment starts clean.
    if (tokens >= budget * 0.92) {
      chunks.push({ segments: current, tokens });
      current = [];
      tokens = 0;
    }
  }

  if (current.length > 0) chunks.push({ segments: current, tokens });
  return chunks;
}

export interface TranslateOptions {
  docType: string;
  /** Type-detection confidence; low values make the model hedge in the prompt. */
  docTypeConfidence?: number | null;
  pageCount?: number | null;
  fileName?: string;
  ocrConfidence?: number | null;
  /** index → human-approved English. These are never re-sent to the model. */
  lockedSegments?: Map<number, string>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Overrides config.llm.judgeModel / provider for this call. */
  model?: string;
}

export interface TranslationOutcome extends TranslationResult {
  /** Human-locked segments, carried through untouched. */
  locked: TranslatedSegment[];
}

/**
 * Translate every segment, with the alignment invariant enforced here rather than
 * trusted to the model.
 *
 * The model is asked for `{ index, target, confidence, notes }[]` and we then
 * reconcile against what we sent: any missing index becomes an explicit omission
 * marker rather than a silent gap, and any extra index is discarded. A model that
 * returns three segments for four input segments has made a factual claim about
 * document structure, and we must not accept it silently.
 */
export async function translateSegments(
  llm: LlmClient,
  segments: Segment[],
  opts: TranslateOptions,
): Promise<TranslationOutcome> {
  const warnings: string[] = [];
  const locked = opts.lockedSegments ?? new Map<number, string>();
  const out: TranslatedSegment[] = [];
  const ambiguous: ChunkResult["ambiguousTerms"] = [];

  const isLocked = (i: number) => locked.has(i);

  const toTranslate = segments.filter((s) => !isLocked(s.index) && !s.passthrough);

  // Latin runs inside a Gujarati document are entities and abbreviations, not
  // prose. They are carried through untouched instead of being round-tripped
  // through romanisation, which would corrupt every name and citation.
  const passthroughOut: TranslatedSegment[] = segments
    .filter((s) => !isLocked(s.index) && s.passthrough)
    .map((s) => ({
      index: s.index,
      blockId: s.blockId,
      source: s.source,
      target: s.source,
      confidence: 1,
      notes: ["passthrough"],
    }));

  const lockedOut: TranslatedSegment[] = segments
    .filter((s) => isLocked(s.index))
    .map((s) => ({
      index: s.index,
      blockId: s.blockId,
      source: s.source,
      target: locked.get(s.index) ?? s.source,
      confidence: 1,
      locked: true,
      notes: ["human-locked"],
    }));

  const chunks = chunkSegments(toTranslate);
  if (chunks.length > 1) {
    warnings.push(
      `Document was split into ${chunks.length} translation chunks. Entity consistency is cross-checked afterwards because chunk boundaries can break name spelling.`,
    );
  }

  const docContext = buildDocContext({
    docType: opts.docType,
    confidence: opts.docTypeConfidence,
    pageCount: opts.pageCount,
    fileName: opts.fileName,
    ocrConfidence: opts.ocrConfidence,
    totalChars: segments.reduce((n, s) => n + s.source.length, 0),
  });
  const nameHints = collectNameHints(segments);

  // One term plan for the whole document. Per-chunk plans would let the same
  // Gujarati term be rendered two different ways across a chunk boundary, which is
  // exactly the drift `checkTermConsistency` exists to catch — better not to
  // manufacture it in the first place.
  const termPlan = buildTermPlan(
    segments.map((s) => ({ blockId: s.blockId, text: s.source })),
  );
  const termPlanText = formatTermPlanForPrompt(termPlan);

  let calls = 0;
  let done = 0;

  let priorContext = "";

  for (const chunk of chunks) {
    const result = await translateChunk(llm, chunk, docContext, nameHints, termPlanText, priorContext, opts);
    priorContext = result.contextCarry;
    calls += result.calls;
    ambiguous.push(...result.ambiguousTerms);
    for (const seg of result.segments) out.push(seg);

    done += chunk.segments.length;
    opts.onProgress?.(done, toTranslate.length);
  }

  // Hard invariant: every input index appears exactly once in the output.
  //
  // All three sources are merged here: model output, passthrough, and
  // human-locked. Passthrough was previously built but never merged, so Latin
  // entity runs silently fell through to the omission branch below and were
  // reported as untranslated.
  const byIndex = new Map<number, TranslatedSegment>();
  for (const seg of [...out, ...passthroughOut, ...lockedOut]) {
    if (byIndex.has(seg.index)) {
      warnings.push(`Duplicate translation returned for segment ${seg.index}; kept the first.`);
      continue;
    }
    byIndex.set(seg.index, seg);
  }

  const missing = segments.filter((s) => !byIndex.has(s.index));
  for (const seg of missing) {
    byIndex.set(seg.index, {
      index: seg.index,
      blockId: seg.blockId,
      source: seg.source,
      target: seg.passthrough ? seg.source : "",
      confidence: 0,
      notes: ["OMISSION: the provider returned no translation for this segment."],
    });
    warnings.push(`Segment ${seg.index} was not returned by the provider and is marked as an omission.`);
  }

  return {
    segments: [...byIndex.values()].sort((a, b) => a.index - b.index),
    ambiguousTerms: ambiguous,
    chunks: chunks.length,
    calls,
    warnings,
    locked: lockedOut,
  };
}

async function translateChunk(
  llm: LlmClient,
  chunk: Chunk,
  docContext: string,
  nameHints: string[],
  termPlanText: string,
  priorContext: string,
  opts: TranslateOptions,
): Promise<ChunkResult & { calls: number; contextCarry: string }> {
  const user = buildUserPrompt({
    segments: chunk.segments.map((s) => ({ id: s.index, source: s.source })),
    termPlan: termPlanText,
    docContext: nameHints.length > 0 ? `${docContext}\n\nKnown entities in this document (use these exact spellings): ${nameHints.join(", ")}` : docContext,
    priorContext,
    languagePair: "gu-IN → en-IN (Indian legal register)",
  });
  const raw = await llm.complete(
    [
      { role: "system", content: TRANSLATION_SYSTEM },
      { role: "user", content: user },
    ],
    { json: true, signal: opts.signal, model: opts.model, maxOutputTokens: Math.max(4096, chunk.tokens * 3) },
  );

  const parsed = parseJson<{
    segments?: Array<{ id?: number; index?: number; target?: string; confidence?: number; notes?: string[] }>;
    ambiguousTerms?: ChunkResult["ambiguousTerms"];
  }>(raw);

  const byId = new Map<number, { target?: string; confidence?: number; notes?: string[] }>();
  for (const s of parsed.segments ?? []) {
    const id = s.id ?? s.index;
    if (typeof id === "number") byId.set(id, s);
  }

  const segments: TranslatedSegment[] = [];

  for (const seg of chunk.segments) {
    // Passthrough segments bypass the model entirely: a Latin run inside a
    // Gujarati document is an entity, not prose.
    if (seg.passthrough) {
      segments.push({
        index: seg.index,
        blockId: seg.blockId,
        source: seg.source,
        target: seg.source,
        confidence: 1,
        notes: ["passthrough"],
      });
      continue;
    }

    const returned = byId.get(seg.index);
    if (!returned) {
      segments.push({
        index: seg.index,
        blockId: seg.blockId,
        source: seg.source,
        target: "",
        confidence: 0,
        notes: ["OMISSION: no translation returned for this segment."],
      });
      continue;
    }

    const stripped = restoreClauseLabel(returned.target ?? "", seg.source);
    segments.push({
      index: seg.index,
      blockId: seg.blockId,
      source: seg.source,
      target: normalizeWhitespace(stripped),
      confidence: clamp01(returned.confidence ?? 0.7),
      notes: returned.notes,
    });
  }

  // Carry the tail of this chunk into the next prompt. Without it, chunk 2 has no
  // idea how chunk 1 spelled a recurring name or defined a recurring term, and
  // long documents drift.
  const tail = chunk.segments
    .slice(-3)
    .map((s) => `${s.source} → ${byId.get(s.index)?.target ?? "(untranslated)"}`)
    .join("\n");

  return { segments, ambiguousTerms: parsed.ambiguousTerms ?? [], calls: 1, contextCarry: tail };
}

/**
 * Re-attach the original clause label.
 *
 * If the model numbered the clause differently ("Twelve." / "12." / "12)"), the
 * source form wins without exception. A reviewer can then see a numbering change
 * in the comparison view, which is the correct outcome: it should be visible, not
 * hidden by a post-hoc repair.
 */
export function restoreClauseLabel(target: string, source: string): string {
  const label = source.match(CLAUSE_LABEL_RE)?.[1];
  if (!label) return target;

  const body = target.replace(/^\s*\(?\s*(?:\d{1,3}|[ivxIVX]+|[a-zA-Z])\s*[.)]?\s+/, "");
  return `${label} ${body}`.trim();
}

export function buildChunkPrompt(segments: Segment[], docContext: string, nameHints: string[]): string {
  const lines = segments.map((s) => `[${s.index}] ${s.source}`);
  const hints = nameHints.length > 0
    ? `\n\n## Known entities in this document (use these exact spellings)\n${nameHints.join(", ")}`
    : "";

  return [
    docContext,
    hints,
    "\n## Source segments",
    "Translate each numbered segment. Return one output entry per input index, in order.",
    "",
    ...lines,
  ].join("\n");
}

/** Collect Latin capitalised runs that look like party or person names. */
export function collectNameHints(segments: Segment[]): string[] {
  const found = new Map<string, number>();
  const re = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g;

  for (const seg of segments) {
    for (const m of seg.source.matchAll(re)) {
      const name = (m[1] ?? "").trim();
      if (!name || seg.kind === "seal_note") continue;
      found.set(name, (found.get(name) ?? 0) + 1);
    }
  }

  return [...found.entries()]
    .filter(([name, n]) => n >= 2 || name.length >= 8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([name]) => name);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export { DISCLAIMER };
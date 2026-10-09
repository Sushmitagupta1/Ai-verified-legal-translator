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
export function chunkSegments(
  segments: Segment[],
  budget = config.chunkTokenBudget,
  maxSegments = config.chunkMaxSegments,
): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Segment[] = [];
  let tokens = 0;

  const flush = () => {
    if (current.length > 0) chunks.push({ segments: current, tokens });
    current = [];
    tokens = 0;
  };

  for (const seg of segments) {
    const t = estimateTokens(seg.source);

    // Bound by count as well as tokens. The budget measures the source only,
    // but each returned segment adds ~45 tokens of JSON boilerplate, so a
    // source-satisfying chunk of 130 short segments demands ~8k output tokens.
    // A local 14B model cannot sustain that and Ollama aborts the prediction on
    // its repeat limit, returning a short off-schema response.
    if (current.length > 0 && (tokens + t > budget || current.length >= maxSegments)) flush();

    current.push(seg);
    tokens += t;
  }

  flush();
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

  // Chunks run in a bounded worker pool instead of one at a time; Ollama serves
  // concurrent requests, so a sequential loop leaves most of the machine idle.
  // The only cross-chunk dependency is the tail of the previous chunk carried
  // into the next prompt, so a worker uses the tail of the chunk before it when
  // that chunk has already finished and otherwise the most recent completed
  // tail ("" for the first chunk). Entity spellings and terminology reach every
  // prompt document-wide via `nameHints` and the term plan, so this ordering
  // slack does not reintroduce the drift the carry exists to prevent.
  const tails: string[] = new Array(chunks.length).fill("");
  const results: Array<Awaited<ReturnType<typeof translateChunkWithFallback>>> = [];
  let next = 0;
  let chainTail = "";

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      const chunk = chunks[i];
      const prior = i === 0 ? "" : tails[i - 1] || chainTail;
      const outcome = await translateChunkWithFallback(
        llm,
        chunk,
        docContext,
        nameHints,
        termPlanText,
        prior,
        opts,
        warnings,
      );
      results[i] = outcome;
      tails[i] = outcome.contextCarry;
      if (outcome.contextCarry) chainTail = outcome.contextCarry;

      done += chunk.segments.length;
      opts.onProgress?.(done, toTranslate.length);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.pipeline.concurrency, chunks.length)) }, () => worker()));

  // Aggregate in chunk order so calls and ambiguous terms stay deterministic
  // regardless of which worker finished first.
  for (const outcome of results) {
    calls += outcome.calls;
    ambiguous.push(...outcome.ambiguousTerms);
    for (const seg of outcome.segments) out.push(seg);
  }

  // One bounded retry for segments the model returned empty. A local model
  // occasionally drops a few ids inside a chunk; re-asking only for those is
  // cheap and turns an omission into a translation. Bounded so a systemic
  // failure (every segment empty) is not simply repeated at extra cost.
  const emptyOut = out.filter((s) => !s.target);
  if (emptyOut.length > 0 && emptyOut.length <= 40) {
    const srcByIndex = new Map(segments.map((s) => [s.index, s] as const));
    const toRetry = emptyOut
      .map((s) => srcByIndex.get(s.index))
      .filter((s): s is Segment => s !== undefined);

    for (const chunk of chunkSegments(toRetry)) {
      const retry = await translateChunkWithFallback(llm, chunk, docContext, nameHints, termPlanText, "", opts, warnings);
      if (retry.chunkFailed) continue;
      calls += retry.calls;
      ambiguous.push(...retry.ambiguousTerms);
      for (const seg of retry.segments) {
        if (!seg.target) continue;
        const i = out.findIndex((o) => o.index === seg.index);
        if (i >= 0) out[i] = seg;
      }
    }
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

  // An index can be present yet still carry an empty target: translateChunk
  // pushes "" when the model returns the id list with a gap or different
  // numbering. The missing-index check below only catches whole absences, so a
  // document could come back 100% untranslated with no omission warning at all.
  const presentButEmpty = [...byIndex.values()].filter((s) => !s.target).map((s) => s.index);

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

  if (presentButEmpty.length > 0) {
    const shown = presentButEmpty.slice(0, 8).join(", ");
    const more = presentButEmpty.length > 8 ? `, +${presentButEmpty.length - 8} more` : "";
    warnings.push(
      `${presentButEmpty.length} segment(s) came back with empty English text (index ${shown}${more}). ` +
        "The model returned ids the pipeline could not match, so these are untranslated rather than verified.",
    );
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

/**
 * The prompt lists sources as `[0] text`, and a model that ignores the output
 * schema echoes that label straight back as the id. Accept a bare number, a
 * numeric string, or a bracketed one so the segment still lines up instead of
 * silently producing an empty target.
 */
function parseSegmentId(v: number | string | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = /\d+/.exec(v);
    if (m) return Number(m[0]);
  }
  return null;
}

/**
 * A local model occasionally returns `segments` or `ambiguousTerms` as an
 * object keyed by id rather than as an array. Both shapes are accepted here so
 * a single off-schema chunk degrades to per-segment omissions instead of
 * aborting translation of the whole document.
 */
function asArray<T>(v: T[] | Record<string, T> | null | undefined): T[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v) as T[];
  return [];
}

/**
 * Normalise a possibly object-keyed response into `[key, item]` pairs.
 *
 * When the model answers with `{"segments": {"0": {...}, "1": {...}}}` the
 * values carry no id of their own — the key *is* the id — so the positions
 * keep the key alongside the item for the parser to fall back on.
 */
function entriesOf<T>(v: T[] | Record<string, T> | null | undefined): Array<[string, T]> {
  if (Array.isArray(v)) return v.map((item, i) => [String(i), item] as [string, T]);
  if (v && typeof v === "object") return Object.entries(v as Record<string, T>);
  return [];
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
      { json: true, signal: opts.signal, model: opts.model, maxOutputTokens: Math.min(8_192, Math.max(4_096, chunk.tokens * 6)) },
  );

  const parsed = parseJson<{
    segments?: Array<{
      id?: number | string;
      index?: number | string;
      target?: string;
      text?: string;
      translation?: string;
      confidence?: number;
      notes?: string[];
    }>;
    ambiguousTerms?: ChunkResult["ambiguousTerms"];
  }>(raw);

  const segmentList = entriesOf(parsed?.segments);
  const byId = new Map<number, { target?: string; confidence?: number; notes?: string[] }>();
  for (const [key, s] of segmentList) {
    const keyId = /^\d+$/.test(key) ? Number(key) : undefined;
    const id = parseSegmentId(s.id ?? s.index ?? keyId);
    if (id === null) continue;
    byId.set(id, {
      target: s.target ?? s.text ?? s.translation ?? "",
      confidence: s.confidence,
      notes: s.notes,
    });
  }

  if (process.env.NYD_DEBUG_TRANSLATION === "1") {
    const ids = chunk.segments.map((s) => s.index);
    console.log(
      `[chunk] sent=${ids.length} range=${ids[0]}..${ids[ids.length - 1]} byId=${byId.size} ` +
        `returned=[${[...byId.keys()].slice(0, 8).join(",")}] rawLen=${raw.length}`,
    );
    console.log(`[promptHead] ${JSON.stringify(user.slice(0, 260))}`);
    console.log(`[promptTail] ${JSON.stringify(user.slice(-260))}`);
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

  return {
    segments,
    ambiguousTerms: asArray(parsed?.ambiguousTerms),
    calls: 1,
    contextCarry: tail,
  };
}

/**
 * Run one chunk of translation, turning a hard provider failure into omission
 * markers rather than aborting the whole document.
 *
 * A local 14B model degenerates into repetition loops on long OCR'd chunks;
 * Ollama answers 500 "token repeat limit reached" and after the retry budget a
 * bare translateChunk would throw, taking the entire run - and with it the
 * user's Word/PDF export - down. Better to mark the chunk's segments as
 * omissions and let the report show exactly which pages still need a human.
 */
async function translateChunkWithFallback(
  llm: LlmClient,
  chunk: Chunk,
  docContext: string,
  nameHints: string[],
  termPlanText: string,
  priorContext: string,
  opts: TranslateOptions,
  warnings: string[],
): Promise<ChunkResult & { calls: number; contextCarry: string; chunkFailed: boolean }> {
  try {
    return { ...(await translateChunk(llm, chunk, docContext, nameHints, termPlanText, priorContext, opts)), chunkFailed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "unknown error";
    warnings.push(
      `Translation chunk failed after retries (${message}); its ${chunk.segments.length} segment(s) are marked as omissions.`,
    );
    return {
      segments: chunk.segments.map((seg) => ({
        index: seg.index,
        blockId: seg.blockId,
        source: seg.source,
        target: seg.passthrough ? seg.source : "",
        confidence: 0,
        notes: ["OMISSION: translation chunk failed; not verified."],
      })),
      ambiguousTerms: [],
      calls: 1,
      contextCarry: "",
      chunkFailed: true,
    };
  }
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
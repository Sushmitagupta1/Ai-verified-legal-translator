import {
  cleanInvisible,
  latinKey,
  levenshtein,
  nameKey,
  normalizeWhitespace,
} from "../domain/gujarati";

/**
 * Alignment between source and target.
 *
 * IMPORTANT DESIGN NOTE (this is the part most naive implementations get wrong):
 *
 * Because the target is Gujarati and the source is English, there is no lexical
 * overlap to align on. NMT-style systems therefore either (a) emit the same
 * number of segments as the source and align positionally, or (b) re-segment.
 *
 * We take approach (a) as an invariant of the pipeline: the translation stage is
 * required to return one output sentence per input sentence. That makes
 * alignment exact and lets us assign every verification finding to a specific
 * source sentence without an error-prone post-hoc search.
 *
 * When a chunk fails the invariant we fall back to a similarity-based alignment
 * so we can still report coverage, and we mark the chunk itself as structurally
 * suspect.
 */

export type AlignmentMethod = "positional" | "similarity" | "resegmented";

export interface AlignedPair {
  srcIndex: number;
  tgtIndex: number;
  confidence: number;
}

export interface AlignmentResult {
  pairs: AlignedPair[];
  method: AlignmentMethod;
  /** Number of source sentences with no target counterpart. */
  unmatchedSource: number[];
  /** Number of target sentences with no source counterpart (hallucination). */
  unmatchedTarget: number[];
  /** True when the segment counts agreed and alignment is trustworthy. */
  exact: boolean;
}

/** Bag-of-tokens similarity used only as a fallback signal. */
function similarity(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

function tokenSet(s: string): Set<string> {
  return new Set(
    cleanInvisible(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

/**
 * Align source and target segment lists.
 *
 * Equal lengths -> positional, exact, confidence 1. Otherwise a
 * Needleman-Wunsch alignment over similarity with a gap penalty, which handles
 * both merged (1 src -> N tgt) and split (N src -> 1 tgt) segments.
 */
export function alignSegments(src: string[], tgt: string[]): AlignmentResult {
  if (src.length === 0 || tgt.length === 0) {
    return {
      pairs: [],
      method: src.length === tgt.length ? "positional" : "resegmented",
      unmatchedSource: src.map((_, i) => i),
      unmatchedTarget: tgt.map((_, i) => i),
      exact: src.length === tgt.length,
    };
  }

  if (src.length === tgt.length) {
    return {
      pairs: src.map((_, i) => ({ srcIndex: i, tgtIndex: i, confidence: 1 })),
      method: "positional",
      unmatchedSource: [],
      unmatchedTarget: [],
      exact: true,
    };
  }

  // Needleman-Wunsch with a fixed gap penalty. Similarity is only a tiebreak
  // signal; the real work of validation is done downstream on the aligned data.
  const GAP = -0.35;
  const n = src.length;
  const m = tgt.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const trace: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

  for (let i = 1; i <= n; i++) {
    score[i][0] = GAP * i;
    trace[i][0] = 1; // up = gap in target
  }
  for (let j = 1; j <= m; j++) {
    score[0][j] = GAP * j;
    trace[0][j] = 2; // left = gap in source
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[i - 1][j - 1] + similarity(src[i - 1] ?? "", tgt[j - 1] ?? "");
      const up = score[i - 1][j] + GAP;
      const left = score[i][j - 1] + GAP;
      const best = Math.max(diag, up, left);
      score[i][j] = best;
      trace[i][j] = best === diag ? 0 : best === up ? 1 : 2;
    }
  }

  const pairs: AlignedPair[] = [];
  const unmatchedSource: number[] = [];
  const unmatchedTarget: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const t = trace[i][j];
    if (i > 0 && j > 0 && t === 0) {
      pairs.push({ srcIndex: i - 1, tgtIndex: j - 1, confidence: similarity(src[i - 1] ?? "", tgt[j - 1] ?? "") });
      i--;
      j--;
    } else if (i > 0 && (j === 0 || t === 1)) {
      unmatchedSource.push(i - 1);
      i--;
    } else {
      unmatchedTarget.push(j - 1);
      j--;
    }
  }
  pairs.reverse();

  return { pairs, method: "resegmented", unmatchedSource, unmatchedTarget, exact: false };
}

/**
 * Block-level coverage: how many source blocks got a non-empty translation.
 * Cheap, robust, and the single most informative structural signal we have.
 */
export interface Coverage {
  totalBlocks: number;
  translatedBlocks: number;
  /** Indices of blocks with no English output at all — critical content loss. */
  emptyBlocks: number[];
  /** Source blocks whose translation is suspiciously short. */
  stuntedBlocks: number[];
  ratio: number;
}

export function computeCoverage(
  sourceTexts: string[],
  targetTexts: string[],
  opts: { minRatio?: number; wordsToChars?: number } = {},
): Coverage {
  const minRatio = opts.minRatio ?? 0.45;
  const total = sourceTexts.length;
  let translated = 0;
  const empty: number[] = [];
  const stunted: number[] = [];

  for (let i = 0; i < total; i++) {
    const s = sourceTexts[i] ?? "";
    const t = normalizeWhitespace(targetTexts[i] ?? "");
    if (t.length === 0) {
      empty.push(i);
      continue;
    }
    translated++;
    const expected = Math.max(8, Math.round(s.length * minRatio));
    if (t.length < expected) stunted.push(i);
  }

  return {
    totalBlocks: total,
    translatedBlocks: translated,
    emptyBlocks: empty,
    stuntedBlocks: stunted,
    ratio: total === 0 ? 1 : translated / total,
  };
}

/** True when the two Gujarati name renderings plausibly denote the same person. */
export function namesMatch(a: string, b: string): { match: boolean; confidence: number } {
  const ka = nameKey(a);
  const kb = latinKey(b) || nameKey(b);
  if (!ka || !kb) return { match: false, confidence: 0 };
  if (ka === kb) return { match: true, confidence: 1 };

  const d = levenshtein(ka, kb);
  const sim = 1 - d / Math.max(ka.length, kb.length);
  if (sim >= 0.85) return { match: true, confidence: sim };

  // Surname-initials form: "R. S. Shah" vs "Ramesh Shah".
  const parts = (s: string) => s.split(/\s+/).filter(Boolean);
  const pa = parts(ka);
  const pb = parts(kb);
  if (pa.length === pb.length && pa.length >= 2) {
    let initialsMatch = 0;
    let suffixMatches = 0;
    for (let i = 0; i < pa.length; i++) {
      const x = pa[i] ?? "";
      const y = pb[i] ?? "";
      if (x[0] === y[0]) initialsMatch++;
      const d2 = levenshtein(x, y);
      if (1 - d2 / Math.max(x.length, y.length) >= 0.8) suffixMatches++;
    }
    const combined = (initialsMatch + suffixMatches) / pa.length;
    if (combined >= 0.6) return { match: true, confidence: combined };
  }

  return { match: false, confidence: sim };
}
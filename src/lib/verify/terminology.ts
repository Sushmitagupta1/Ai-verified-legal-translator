import {
  GLOSSARY,
  lookupGlossary,
  type GlossaryEntry,
} from "../domain/glossary";
import { normalizeWhitespace } from "../domain/gujarati";

export interface TermOccurrence {
  entry: GlossaryEntry;
  surface: string;
  start: number;
  end: number;
  /** Key for stable de-duplication across a whole document. */
  key: string;
}

function normKey(s: string): string {
  return s.replace(/[‌‍]/g, "").replace(/[\s.]+/g, "").toLowerCase();
}

const LOOKUP = new Map<string, GlossaryEntry>();
for (const e of GLOSSARY) {
  LOOKUP.set(normKey(e.source), e);
  for (const a of e.aliases ?? []) LOOKUP.set(normKey(a), e);
}

/** Longest-first so "ચીફ જ્યુડિશિયલ મેજિસ્ટ્રેટ" wins over "મેજિસ્ટ્રેટ". */
const PATTERN = [...LOOKUP.keys()]
  .filter((k) => k.length >= 2)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const TERM_RE = new RegExp(`(?<![\\p{L}\\p{M}])(?:${PATTERN})(?![\\p{L}\\p{M}])`, "giu");

/**
 * Longest-match glossary scan.
 *
 * Deliberately does not use naive substring matching: matching "મેજિસ્ટ્રેટ"
 * inside "મેજિસ્ટ્રેટ કોર્ટ" is fine, but matching "નિયમ" inside "નિયમન" or "કલમ" inside
 * "કલમો" produces wrong glossary tags that then "correct" the translation to
 * the wrong term. Word-boundary + longest-first is the minimum bar.
 */
/**
 * Whole-token occurrence test, matching the rule `TERM_RE` already applies.
 *
 * Plain `includes()` is wrong here: "અરજી" is a substring of "અરજીકર્તાએ"
 * (applicant), so a block that merely says "applicant" would be credited with
 * containing the term "અરજી" (Application) and then be failed for not
 * rendering it.
 */
function containsTerm(haystack: string, surface: string): boolean {
  const needle = surface.toLowerCase();
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = haystack[at - 1];
    const after = haystack[at + needle.length];
    const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{M}]/u.test(c);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

export function findTerms(text: string): TermOccurrence[] {
  const out: TermOccurrence[] = [];
  TERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM_RE.exec(text)) !== null) {
    const surface = m[0];
    const key = normKey(surface);
    const entry = LOOKUP.get(key);
    if (!entry) continue;
    out.push({ entry, surface, start: m.index, end: m.index + surface.length, key });
    if (m.index === TERM_RE.lastIndex) TERM_RE.lastIndex++;
  }
  return out;
}

export interface AppliedTerm {
  key: string;
  surface: string;
  target: string;
  preserve: boolean;
  parenthetical: string | null;
  category: string;
  alternatives: string[];
  count: number;
  /** Where the term first appears, for first-use glossing. */
  firstUseBlock: string;
  glossed: boolean;
  /** Gloss already emitted somewhere in the target text. */
  glossCount: number;
}

/**
 * Fold a term list into a decision table the translation stage can execute:
 * for each distinct term, what must appear in the English output.
 */
export function buildTermPlan(
  perBlock: Array<{ blockId: string; text: string }>,
  customTerms: GlossaryEntry[] = [],
): AppliedTerm[] {
  const merged = new Map<string, AppliedTerm>();
  for (const [key, entry] of LOOKUP) merged.set(key, entryToApplied(entry, key, "", entry.preserve, 0));

  for (const e of customTerms) {
    const key = normKey(e.source);
    // A custom entry may override a built-in with the same surface form.
    merged.set(key, entryToApplied(e, key, "", e.preserve, 0));
  }

  const glossSeen = new Map<string, boolean>();

  for (const { blockId, text } of perBlock) {
    for (const occ of findTerms(text)) {
      const existing = merged.get(occ.key);
      if (!existing) continue;
      existing.count++;
      if (!existing.firstUseBlock) existing.firstUseBlock = blockId;
    }
    // Custom terms are not in TERM_RE, so count them by direct scan. Without
    // this a user-defined term never reaches count > 0 and is dropped from the
    // plan entirely — the feature silently does nothing.
    for (const [key, term] of merged) {
      if (term.count > 0) continue;
      if (!LOOKUP.has(key) && countOccurrences(text, term.surface) > 0) {
        term.count += countOccurrences(text, term.surface);
        if (!term.firstUseBlock) term.firstUseBlock = blockId;
      }
    }
  }

  for (const term of merged.values()) {
    if (term.parenthetical && !glossSeen.has(term.key)) {
      term.glossed = true;
      glossSeen.set(term.key, true);
    }
  }

  return [...merged.values()].filter((t) => t.count > 0);
}

/** Word-bounded occurrence count of a literal surface form. */
function countOccurrences(text: string, surface: string): number {
  const esc = surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{M}])${esc}(?![\\p{L}\\p{M}])`, "giu");
  return (text.match(re) ?? []).length;
}

function entryToApplied(
  entry: GlossaryEntry,
  key: string,
  firstUseBlock: string,
  preserve: boolean,
  count: number,
): AppliedTerm {
  return {
    key,
    surface: entry.source,
    target: entry.target,
    preserve,
    // Glosses live inside `target` ("Vakalatnama (power of attorney)"), so derive
    // them from there rather than from a field that is usually unset — otherwise
    // first-use glossing never turns on.
    parenthetical: entry.parenthetical ?? targetParenthetical(entry.target),
    category: entry.category,
    alternatives: entry.alternatives ?? [],
    count,
    firstUseBlock,
    glossed: false,
    glossCount: 0,
  };
}

export interface TermViolation {
  key: string;
  surface: string;
  required: string;
  expected: string;
  actual: string;
  kind: "not_present" | "wrong_target" | "literal_translation" | "inconsistent_target";
  severity: "critical" | "major" | "minor";
  detail: string;
}

/**
 * Check the English output against the term plan.
 *
 * `literal_translation` is the important one: it catches the model rendering
 * "વકાલતનામું" as "power of attorney" with no parenthetical, which is the single
 * most common legal-terminology failure in Gujarati legal translation because the
 * literal rendering looks correct to a non-Indian reader.
 */
export function checkTermCompliance(
  plan: AppliedTerm[],
  targetText: string,
  opts: { glossedKeys?: Set<string>; sourceText?: string } = {},
): TermViolation[] {
  const out: TermViolation[] = [];
  const lowered = targetText.toLowerCase();
  const glossed = opts.glossedKeys ?? new Set<string>();

  // `plan` is document-wide but this function is called once per block. Without
  // this filter every term in the document is demanded in every block's target,
  // which manufactures hundreds of false "not_present" findings. A term can only
  // be required in a block that actually contains it in the source.
  const sourceLower = opts.sourceText?.toLowerCase();

  for (const term of plan) {
    if (term.count === 0) continue;
    if (sourceLower !== undefined && !containsTerm(sourceLower, term.surface.toLowerCase())) continue;

    if (term.preserve) {
      const head = term.target.split(" (")[0] ?? term.target;
      const present = lowered.includes(head.toLowerCase());
      if (!present) {
        // A preserved term may legitimately be replaced by its known alias.
        const viaAlias = term.alternatives.some((a) => lowered.includes(a.toLowerCase()));
        if (viaAlias) continue;

      // Preserved terms must still be checked for a literal rendering. Most
      // party terms are preserve:true, so short-circuiting here would make the
      // single most important terminology check unreachable for them.
      const literal = literalCandidates(term.target);
      const literalHit = literal.find((c) => lowered.includes(c.toLowerCase()));
      if (literalHit) {
        out.push({
          key: term.key,
          surface: term.surface,
          required: term.target,
          expected: term.target,
          actual: literalHit,
          kind: "literal_translation",
          severity: "major",
          detail:
            `"${term.surface}" was rendered literally as "${literalHit}" instead of the required ` +
            `"${term.target}".`,
        });
        continue;
      }

      out.push({
          key: term.key,
          surface: term.surface,
          required: term.target,
          expected: term.target,
          actual: "(absent)",
          kind: "not_present",
          severity: "major",
          detail: `Preserved term "${term.surface}" is missing from the English output. It must appear as "${term.target}".`,
        });
      }
      continue;
    }

    // Compare on the head term, not the full target: only the first use carries
    // the gloss, so requiring "Vakalatnama (power of attorney...)" everywhere
    // would fail correct output that repeats the bare term on later pages.
    const head = (term.target.split(" (")[0] ?? term.target).toLowerCase();
    const present = lowered.includes(head);
    const aliasPresent = term.alternatives.some((a) => lowered.includes(a.toLowerCase()));

    if (present) continue;

    if (aliasPresent) {
      // Multiple defensible renderings: flag for review, never auto-correct.
      out.push({
        key: term.key,
        surface: term.surface,
        required: term.target,
        expected: term.target,
        actual: term.alternatives.find((a) => lowered.includes(a.toLowerCase())) ?? "(variant)",
        kind: "inconsistent_target",
        severity: "minor",
        detail:
          `"${term.surface}" was rendered as a variant rather than the house term "${term.target}". ` +
          "Both may be defensible; confirm the convention you want across the document.",
      });
      continue;
    }

    // Detect a plausible literal rendering.
    const literal = literalCandidates(term.target);
    const literalHit = literal.find((c) => lowered.includes(c.toLowerCase()));
    if (literalHit) {
      out.push({
        key: term.key,
        surface: term.surface,
        required: term.target,
        expected: term.target,
        actual: literalHit,
        kind: "literal_translation",
        severity: "major",
        detail:
          `"${term.surface}" appears to be rendered literally as "${literalHit}". ` +
          `The recognised legal term is "${term.target}".`,
      });
      continue;
    }

    out.push({
      key: term.key,
      surface: term.surface,
      required: term.target,
      expected: term.target,
      actual: "(absent)",
      kind: "not_present",
      severity: "major",
      detail: `Glossary term "${term.surface}" does not appear in the English output. Expected "${term.target}".`,
    });
  }

  return out;
}

/**
 * Candidate literal renderings for a legal term — the plausible-but-wrong English
 * a model reaches for. Used only for detection.
 */
function literalCandidates(target: string): string[] {
  // Search the gloss too. For "Vakalatnama (power of attorney for legal
  // representation)" the plausible-but-wrong rendering lives in the
  // parenthetical — the head term alone is a single word and yields nothing.
  const head = target.split(" (")[0] ?? target;
  const sources = [head];
  const gloss = target.match(/\(([^()]+)\)/);
  if (gloss) sources.push(gloss[1]);

  // Drop function words when deciding whether a phrase is meaningful, but keep
  // them in the phrase itself: filtering first would turn the gloss
  // "power of attorney" into "power attorney" and never match real output.
  const STOP = new Set(["the", "a", "an", "of", "for", "to", "in", "by", "and", "or", "on", "as"]);

  const seen = new Set<string>();
  for (const src of sources) {
    const words = src.split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 2; j <= words.length; j++) {
        const slice = words.slice(i, j);
        if (slice.every((w) => STOP.has(w.toLowerCase()))) continue;
        const phrase = slice.join(" ");
        // Never propose a phrase containing the house term, or correct output
        // would be flagged as its own literal translation.
        if (!head.toLowerCase().includes(phrase.toLowerCase())) seen.add(phrase);
      }
    }
  }
  // Longest first. Callers take the first candidate that matches, so sorting
  // ascending made "power of attorney" report the useless fragment "power of"
  // instead of the phrase that actually betrays a literal translation.
  return [...seen].sort((a, b) => b.length - a.length);
}

/**
 * Consistency check across the whole document: the same source term must not be
 * rendered two different ways. Inconsistency is how a translation loses the
 * reader on page 12 when it agreed with itself on page 1.
 */
export function checkTermConsistency(
  perBlock: Array<{ blockId: string; sourceText: string; targetText: string }>,
  plan: AppliedTerm[],
): TermViolation[] {
  const out: TermViolation[] = [];
  for (const term of plan) {
    const used = new Map<string, string[]>();
    for (const b of perBlock) {
      const low = b.targetText.toLowerCase();
      const srcLow = b.sourceText.toLowerCase();
      // Only blocks that actually contain the term in the source can speak to
      // how it was rendered. Otherwise an incidental target mention ("court" in
      // a block that never used a Gujarati court term) fabricates a conflict.
      if (!containsTerm(srcLow, term.surface.toLowerCase())) continue;
      // Match on the head of each candidate. An alternative such as
      // "complaint (in the general sense)" carries an editorial qualifier that
      // will never appear in real output, so comparing the full string hides a
      // genuine inconsistency between "FIR" and "complaint".
      const candidates = [
        term.target.split(" (")[0] ?? term.target,
        ...term.alternatives.map((a) => a.split(" (")[0] ?? a),
      ];
      for (const c of candidates) {
        if (c && low.includes(c.toLowerCase())) {
          const arr = used.get(c) ?? [];
          arr.push(b.blockId);
          used.set(c, arr);
        }
      }
    }
    if (used.size > 1) {
      out.push({
        key: term.key,
        surface: term.surface,
        required: term.target,
        expected: [...used.keys()].join(" | "),
        actual: [...used.values()].flat().slice(0, 6).join(", "),
        kind: "inconsistent_target",
        severity: "minor",
        detail:
          `Term "${term.surface}" is rendered inconsistently across the document: ` +
          `${[...used.entries()].map(([k, v]) => `${k} (${v.length}×)`).join(", ")}. Pick one and apply it throughout.`,
      });
    }
  }
  return out;
}

/** Extract the "(...)" gloss from a target term string, if any. */
function targetParenthetical(target: string): string | null {
  const m = target.match(/\s*\(([^()]+)\)\s*$/);
  return m ? `(${m[1]})` : null;
}

/** Compact term list for injection into the translation prompt. */
export function formatTermPlanForPrompt(plan: AppliedTerm[], limit = 60): string {
  const relevant = plan.sort((a, b) => b.count - a.count).slice(0, limit);
  if (relevant.length === 0) return "(no glossary terms detected in this segment)";
  return relevant
    .map((t) => {
      const rule = t.preserve ? "KEEP AS-IS" : "USE EXACTLY";
      const alt = t.alternatives.length > 0 ? ` (alternatives: ${t.alternatives.join(" / ")})` : "";
      const gloss = t.parenthetical ? ` — on first use: "${t.target.split(" (")[0]} (${t.parenthetical})"` : "";
      return `- ${t.surface} → ${rule} "${t.target.split(" (")[0]}"${alt}${gloss}`;
    })
    .join("\n");
}

export function glossaryEntryFor(surface: string): GlossaryEntry | undefined {
  return lookupGlossary(surface);
}

export function termCount(text: string): number {
  return findTerms(text).length;
}

export function summarizeTerms(plan: AppliedTerm[]): Record<string, number> {
  const byCat: Record<string, number> = {};
  for (const t of plan) byCat[t.category] = (byCat[t.category] ?? 0) + t.count;
  return byCat;
}

export function cleanForComparison(s: string): string {
  return normalizeWhitespace(s).toLowerCase();
}
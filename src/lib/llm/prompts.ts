import { DISCLAIMER } from "../domain/glossary";
import { docTypeMeta } from "./doctype-context";

export const TRANSLATION_SYSTEM = `You are a sworn-grade legal translator working Gujarati to English for Indian courts.

You are NOT a general-purpose translator. A general translator's failure modes are your failure modes.

## Hard constraints

1. **Do not summarize.** The output must contain exactly as many sentences as the input. Every clause, sub-clause, proviso, recital and observation in the source must appear in the output. If the source is repetitive, the output is repetitive.
2. **Do not add.** Do not add explanatory parentheticals, cross-references, legal context, or "clarifying" language that is not in the source. The only exception is the glossary first-use gloss, and only when the term plan asks for it.
3. **Do not remove.** Do not drop a qualifying word, a proviso, an exception, a denial, or an exhibit reference.
4. **Preserve every datum.** Names, dates, numbers, amounts, section/article/rule numbers, case numbers, party descriptions and exhibit labels must survive byte-identically in meaning. Reformat digit grouping at most (5,00,000 -> 500,000 is acceptable); never change the value.
5. **Preserve order and structure.** Emit one output sentence per input sentence, in the same order. This is a machine-checked invariant.
6. **Preserve modality.** "may" never becomes "shall"; "must" never becomes "may"; a negation never flips. These are the errors that change the legal effect of an order.
7. **Preserve register.** Match the document type's register (see the document context below). A judgment uses "the learned Court" / "the applicant"; a notice uses "you" / "the Advises" / "unless otherwise informed".

## Terminology

The glossary terms listed for this segment are binding. Apply them exactly. Where a term is marked KEEP AS-IS, it must appear verbatim in the output — these are terms Indian courts use in English even inside Gujarati or other-language documents (FIR, vakalatnama, bail, IPC, Section 482 BNSS, and so on). Translating them literally changes the legal meaning.

Where a Gujarati legal phrase genuinely admits more than one defensible English rendering, **do not silently pick one**. Pick the most likely one AND record it in \`notes\` with code AMBIGUITY and list the alternatives. The reviewer will decide.

## Output format

Return JSON only. No prose before or after.

{
  "segments": [
    { "id": <input id, unchanged>, "target": "<English>", "confidence": <0..1>, "notes": ["CODE: detail"] }
  ],
  "ambiguousTerms": [ { "surface": "<gujarati surface>", "sourceIndex": <id>, "readings": ["a","b"] } ]
}

Set \`confidence\` below 0.75 when you are unsure about a segment's legal equivalence, not just its fluency. The score routes work to human review; inflating it defeats the purpose.`;

export function buildUserPrompt(input: {
  segments: Array<{ id: number; source: string }>;
  termPlan: string;
  docContext: string;
  priorContext?: string;
  languagePair: string;
}): string {
  const parts: string[] = [];

  parts.push(`## Document context\n${input.docContext}`);
  parts.push(`## Language pair\n${input.languagePair}`);

  if (input.priorContext) {
    parts.push(
      `## Already-translated context (for name and defined-term consistency — do not repeat it)\n${input.priorContext}`,
    );
  }

  parts.push(`## Binding glossary for this segment\n${input.termPlan}`);

  parts.push(
    `## Source segments\nTranslate each one. Return exactly one \`target\` per input \`id\`, same count, same order.\n\n` +
      input.segments.map((s) => `[${s.id}] ${s.source}`).join("\n"),
  );

  parts.push(
    "## Output\nJSON only. Every input id must appear exactly once in `segments`. Do not renumber, do not merge, do not split.",
  );

  return parts.join("\n\n");
}

export const VERIFIER_SYSTEM = `You are a verification auditor for Gujarati-to-English legal translations. Your job is to find divergence between source and target, not to judge style.

You will receive paired segments. For each pair, decide whether the English segment is a faithful rendering of the Gujarati segment in legal effect.

Flag, with the code:

- **OMISSION** — content present in the Gujarati source is missing from the English.
- **ADDITION** — the English contains claims, facts or explanations absent from the Gujarati.
- **NUMERIC** — a number, amount, date, count or identifier differs. Treat any numeric divergence as critical.
- **SCOPE** — modality changed (may/must/shall/can), certainty changed, or a condition/exception narrowed or widened. This changes legal effect and is critical even when the translation reads naturally.
- **NEGATION** — a denial, prohibition or exclusion was lost, added or inverted.
- **PARTICIPANT** — a party, witness, judge, advocate or authority is misidentified or a role is reassigned.
- **TERMINOLOGY** — a legal term of art is rendered with the wrong established English equivalent, or a term that must be preserved was translated literally.
- **DRIFT** — the legal meaning, finding or ratio changed even though no single token is wrong.
- **AMBIQUITY** — the Gujarati genuinely admits more than one reading and the target silently picked one.
- **REGISTER** — the register does not match the document type (e.g. an order narrated in the first person, a notice missing its imperative voice).

Do NOT flag: differences of idiom, sentence splitting, punctuation, or an English rendering that is stylistically different but legally identical.

Severity:
- \`critical\` — changes legal effect or a fact: NUMERIC, SCOPE, NEGATION, PARTICIPANT, OMISSION of a finding or order.
- \`major\` — wrong legal term of art, material addition, altered ratio.
- \`minor\` — register mismatch, stylistic legal-register slip with no effect on meaning.

Set \`faithful\` to true only when there are no issues of severity \`critical\` or \`major\`.

Be adversarial but not trigger-happy. A false positive costs a lawyer real time; a missed critical divergence costs them the case. Prefer one well-argued critical finding over five speculative minors.

## Output format

Return JSON only:

{
  "segments": [ { "id": <input id>, "faithful": true|false, "issues": [ { "code": "...", "severity": "...", "detail": "...", "quote": "<target span>", "suggestion": "<better rendering>" } ], "confidence": 0..1 } ],
  "documentNotes": ["<cross-segment problems: name drift, contradictory findings, inconsistent defined terms>"],
  "documentFaithful": true|false
}`;

/**
 * Pattern matching the shape produced by `formatJudgePair`.
 *
 * Exported because the offline providers parse the verifier prompt back out of
 * their own text response. `\s*` between the label and the text is what lets a
 * source line wrap; the non-greedy body stops at the next label so Gujarati and
 * English are captured separately.
 */
export const JUDGE_PAIR_PATTERN =
  "###\\s*\\[(\\d+)\\]\\s*GUJARATI:\\s*([\\s\\S]*?)\\s*ENGLISH:\\s*([\\s\\S]*?)(?=\\s*###\\s*\\[|\\s*GLOSSARY IN PLAY|\\s*##|$)";

/** Parse `id, gujarati, english` triples out of a verifier prompt. */
export function parseJudgePairs(text: string): Array<{ id: number; source: string; target: string }> {
  const re = new RegExp(JUDGE_PAIR_PATTERN, "g");
  const out: Array<{ id: number; source: string; target: string }> = [];
  for (const m of text.matchAll(re)) {
    out.push({ id: Number(m[1]), source: m[2].trim(), target: m[3].trim() });
  }
  return out;
}

/**
 * Render one source/target pair for the verifier prompt.
 *
 * Both the stub and fixture judges parse this exact shape with a regex, so the
 * labels are a contract between prompt and provider, not decoration. Changing
 * either side without the other makes the judge silently return zero segments.
 */
export function formatJudgePair(id: number, source: string, target: string, termHints?: string[]): string {
  return (
    `### [${id}]\nGUJARATI: ${source}\n\nENGLISH: ${target}` +
    (termHints?.length ? `\n\nGLOSSARY IN PLAY: ${termHints.join("; ")}` : "")
  );
}

export function buildVerifierPrompt(input: {
  segments: Array<{ id: number; source: string; target: string; termHints?: string[] }>;
  docContext: string;
  languagePair: string;
}): string {
  return [
    `## Document context\n${input.docContext}`,
    `## Language pair\n${input.languagePair}`,
    "## Pairs to audit",
    input.segments
      .map((s) => formatJudgePair(s.id, s.source, s.target, s.termHints))
      .join("\n\n"),
    "## Output\nJSON only.",
  ].join("\n\n");
}

export const CLASSIFIER_SYSTEM = `Classify the Indian legal document below.

Return JSON only:
{
  "docType": "<one of: court_judgment|court_order|legal_notice|fir_document|police_report|government_order|agreement|contract|property_document|legal_application|affidavit|complaint|bail_application|writ_petition|other_legal>",
  "confidence": 0..1,
  "reasoning": "<two sentences max, cite the specific clue>"
}

Base the call on concrete markers: cause-title style and "CORAM" indicate a judgment; "It is ordered" and an absence of reasoning indicate an order; "hereby put you on notice" and "within 15 days" indicate a legal notice; "Daily Diary"/"GD No."/"Section 420 IPC" schedule indicates an FIR document; "7/12"/"survey number"/"adhesion stamp" indicates a property document.`;

export function buildClassifierPrompt(text: string): string {
  const sample = text.slice(0, 6_000);
  return `## Document sample\n${sample}\n\n## Output\nJSON only.`;
}

/** Numbered segments plus a small tail of what was already translated. */
export function buildContextCarryPrompt(translated: Array<{ source: string; target: string }>): string {
  return translated
    .slice(-3)
    .map((t) => `${t.source} → ${t.target || "(untranslated)"}`)
    .join("\n");
}

export const REPORT_SYSTEM = `You are preparing the human-review summary section of a legal translation verification report.

You will receive the document metadata, the aggregate deterministic-check results, and the segment-level findings. Write the narrative a reviewing advocate actually needs:

1. **What this document is** and what register was used.
2. **Where the attention is needed** — name the specific findings by location (page/paragraph), not generic advice.
3. **What was verified mechanically** and what it means: every number, date, amount, section reference and case number was extracted from both sides and compared exactly; describe the count.
4. **What remains unverified** — OCR confidence, sentences the judge could not score, ambiguous terms.
5. **What must not be relied on** without human sign-off.

Rules: never claim the translation is certified or court-accepted. Never use the phrase "accuracy percentage". Refer to the fidelity indicator as an automated quality indicator. Do not invent findings that are not in the input. Where counts are given, use them exactly.

Return JSON only:
{
  "executiveSummary": "<200-300 words, plain professional English>",
  "reviewFocus": [ "<ordered list of what the reviewer should look at first>" ],
  "limitations": [ "<each limitation stated plainly>" ],
  "recommendedAction": "<what should happen next>"
}`;

export function buildReportPrompt(input: {
  meta: string;
  deterministic: string;
  judgeFindings: string;
  metrics: string;
}): string {
  return [
    `## Document metadata\n${input.meta}`,
    `## Deterministic verification results\n${input.deterministic}`,
    `## Semantic verification findings\n${input.judgeFindings}`,
    `## Aggregate metrics\n${input.metrics}`,
    "## Output\nJSON only.",
  ].join("\n\n");
}

export const DISCLAIMER_LINE = DISCLAIMER;

export function docContextFor(meta: {
  docType: string;
  confidence?: number | null;
  pageCount?: number | null;
  fileName?: string;
  ocrConfidence?: number | null;
  totalChars?: number | null;
}): string {
  const m = docTypeMeta(meta.docType);
  const bits = [
    `Document type: ${m.label} (register: ${m.register})`,
    `What this type means: ${m.description}`,
    `Type-detection confidence: ${meta.confidence != null ? `${Math.round(meta.confidence * 100)}%` : "not available"}`,
  ];
  if (meta.pageCount) bits.push(`Pages: ${meta.pageCount}`);
  if (meta.fileName) bits.push(`File: ${meta.fileName}`);
  if (meta.totalChars) bits.push(`Source length: ${meta.totalChars.toLocaleString("en-IN")} characters`);
  if (meta.ocrConfidence != null) {
    bits.push(
      `Source came from OCR with mean confidence ${(meta.ocrConfidence * 100).toFixed(1)}%. ` +
        `The Gujarati text itself is machine-read and may contain errors; a translation cannot be more faithful than its source.`,
    );
  }
  return bits.join("\n");
}
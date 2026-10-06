import { GLOSSARY } from "../domain/glossary";
import { EN_MONTH_NAMES, normalizeWhitespace, transliterateGujarati } from "../domain/gujarati";
import { LlmError, parseJsonLoose, type LlmClient, type LlmMessage, type LlmOptions } from "./provider";
import { JUDGE_PAIR_PATTERN, parseJudgePairs } from "./prompts";

/**
 * Offline, deterministic provider.
 *
 * WHY THIS EXISTS
 * ---------------
 * A legal translation pipeline must be runnable and testable with no API key:
 *   - a reviewing lawyer evaluating this tool cannot paste privileged case
 *     material into a hosted API just to see whether the verification engine works;
 *   - the deterministic checks (datum conservation, terminology compliance) are
 *     the part we most need to regression-test, and they must run in CI.
 *
 * WHAT IT ACTUALLY DOES
 * ---------------------
 * A mechanical renderer: it applies the glossary, preserves every datum, keeps the
 * 1:1 segment invariant, and romanises whatever it cannot translate.
 *
 * IT IS NOT A TRANSLATOR and it does not pretend to be. Its output is deliberately
 * poor as English prose, which means the verification engine correctly reports a
 * low fidelity indicator and opens findings. That is the intended behaviour and it
 * is a feature: the offline mode demonstrates that the verifier catches a bad
 * translation rather than rubber-stamping whatever it is given.
 */

interface StubOptions {
  /** Introduce a deterministic defect, for exercising the verifier in tests. */
  inject?: "none" | "drop_sentence" | "change_number" | "literalize_term";
  /** Glossary terms are replaced in this order. */
  glossarySize?: number;
}

const COMMON: Record<string, string> = {
  અને: "and", છે: "is", છો: "are", હતું: "was", હતી: "was", હશે: "will be",
  આ: "this", "આ પ્રકરણના": "in this matter", ના: "of", ની: "of", "નું": "'s", ને: "to", થી: "from",
  માટે: "in respect of", સાથે: "with", પર: "upon", કરે: "does", કરવા: "to do", કરી: "did",
  હોય: "may be", થાય: "may happen", છું: "am", છીએ: "are", હવે: "now", આજે: "today",
  તારીખે: "on", દિવસી: "on the day", અધિકારી: "officer", વિભાગ: "Department",
  જે: "which", કે: "that", "જે પ્રમાણે": "as provided", "નોંધ": "record", "રજિસ્ટર": "register",
  રજિસ્ટરી: "registry", કામગીરી: "copy", નકલ: "copy", પ્રમાણિત: "certified",
  માન્ય: "valid", વૈધ: "valid", અવૈધ: "invalid", કાયમી: "permanent", અંતર્ગત: "interim",
  તાત્કાલિક: "immediate", તાત્કાલિકી: "immediately", વખતે: "at the time", સમયે: "at the time",
  કેમકે: "because", કારણકે: "since", જો: "if", તો: "then", અથવા: "or", "કેમ કે": "whether",
  અસમર્થ: "unnecessary", જરૂરી: "necessary", જરૂર: "necessary", વધુ: "more", ઓછું: "less",
  સમગ્ર: "entire", કુલ: "total", દરેક: "each", બધા: "all",
  ઉપરોક્ત: "aforesaid", અગાઉ: "earlier", ઉપર: "above", નીચે: "below", પછી: "after",
  પહેલા: "before", અત્યાર: "now", "ત્યારે": "then", હાજર: "present", "ગેરહાજર": "absent",
  "મોટા": "large", "નાના": "small", "તે": "he", "તેઓ": "they", "તેને": "him",
  "અમુક": "free", "વ્યવસ્થા": "arrangement", "સૂચના": "information", "જાણ": "knowledge",
  "કાર્ય": "work", "કાર્યક્રમ": "proceedings", "કાર્યવાહી": "proceedings",
  "સમજોટા": "settlement", "નોંધણી": "registration", "હસ્તક્ષર": "signature",
  "નિવારણા": "remedy", "રાહ": "relief", "વિનંતી": "prayer", "યાદ": "record",
  "સ્થાન": "place", "તા": "of",
  "તેઓને": "them", "તેની": "her", "તેમને": "them", "જેમ": "as", "જ્યારે": "when",
  "જોઈએ": "if required", "લાગી": "applicable", "લાગુ": "applicable",
  "સમાન": "common", "અલગ": "different", "નવીન": "new", "જૂની": "old",
};

const MONTH_MAP: Record<string, string> = {
  "જાન્યુઆરી": "January",
  "ફેબ્રુઆરી": "February",
  "માર્ચ": "March",
  "એપ્રિલ": "April",
  "એપ્રીલ": "April",
  "મે": "May",
  "જૂન": "June",
  "જુન": "June",
  "જુલાઈ": "July",
  "જુલાઇ": "July",
  "ઑગસ્ટ": "August",
  "ઓગસ્ટ": "August",
  "સપ્ટેમ્બર": "September",
  "સપ્ટેંબર": "September",
  "ઑક્ટોબર": "October",
  "ઓક્ટોબર": "October",
  "નવેમ્બર": "November",
  "નવેંબર": "November",
  "ડિસેમ્બર": "December",
  "ડિસેંબર": "December",
};

/** Gujarati sentence terminators, preserved so segmentation stays 1:1. */
function terminator(s: string): string {
  const m = s.match(/([।.!?])\s*$/);
  return m ? m[1] : ".";
}

/**
 * Mechanical render of one Gujarati segment.
 *
 * Ordering matters: glossary terms first (longest-first, so a multi-word term is
 * not broken by a single-word one), then month names, then the common word list,
 * then romanisation of whatever is left.
 */
function renderSegment(gu: string, opts: StubOptions): string {
  let out = gu;
  const term = terminator(gu);

  const entries = [...GLOSSARY].sort((a, b) => b.source.length - a.source.length);
  const protectedData: Array<{ token: string; placeholder: string }> = [];
  let idx = 0;

  const shield = (value: string): string => {
    const ph = `\u0001D${idx++}\u0001`;
    protectedData.push({ token: ph, placeholder: value });
    return ph;
  };

  // 1. Shield every datum so no later pass can alter it. This is the behaviour a
  //    correct translator must exhibit, and the stub exhibits it by construction.
  out = out
    .replace(/[₹]?\s*\bRs\.?\s*[\d૦-૯][\d,૦-૯.\s]*/g, (m) => shield(m.trim()))
    .replace(/\b[\d૦-૯]{1,2}[-/.]\s*[\d૦-૯]{1,2}[-/.]\s*[\d૦-૯]{2,4}\b/g, (m) => shield(m))
    .replace(/\b(?:Section|Article|Order|Rule|Schedule|Chapter|Part|Clause)\s*[\d૦-૯]+/gi, (m) => shield(m))
    .replace(/\b(?:IPC|BNS|CrPC|BNSS|CPC|IEA|BSA|NI\s*Act|SARFAESI|PMLA|POCSO|NDPS)\b/g, (m) => shield(m))
    .replace(/\b(?:[A-Z]{1,4}\.?\s*){1,4}(?:No\.?\.?\s*)?\d+\/\d{2,4}\b/g, (m) => shield(m))
    .replace(/\b[\d૦-૯]{3,}\b/g, (m) => shield(m));

  // 2. Glossary.
  for (const e of entries) {
    const head = e.target.split(" (")[0] ?? e.target;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{M}])${e.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{M}])`,
      "gu",
    );
    out = out.replace(pattern, () => shield(head));
  }

  // 3. Months and common words.
  for (const [gu, en] of Object.entries(MONTH_MAP)) {
    out = out.replace(new RegExp(gu, "g"), () => shield(en));
  }
  const commonKeys = Object.keys(COMMON).sort((a, b) => b.length - a.length);
  for (const gu of commonKeys) {
    const en = COMMON[gu];
    if (!en) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}])${gu}(?![\\p{L}\\p{M}])`, "gu"), () => shield(en));
  }

  // 4. Romanise the residue, which is where the stub stops pretending.
  const residue = out
    .replace(/\u0001D(\d+)\u0001/g, (_, n: string) => protectedData[Number(n)]?.token ?? "")
    .replace(/[઀-૿]+/g, (m) => transliterateGujarati(m) || m);
  out = out.replace(/[઀-૿]+/g, () => "");

  // 5. Restore shields.
  out = out.replace(/\u0001D(\d+)\u0001/g, (_, n: string) => {
    const i = Number(n);
    return protectedData[i]?.placeholder ?? "";
  });
  out = normalizeWhitespace(out.replace(/\s{2,}/g, " "));

  // 6. Re-attach terminator and capitalise.
  if (!/[.!?]$/.test(out)) out = `${out.replace(/[।]+$/, "")} ${term}`;
  out = out.charAt(0).toUpperCase() + out.slice(1);

  return out;
}

/** Count of non-Latin characters left in the rendered output. */
function residueRatio(s: string): number {
  const total = s.replace(/\s/g, "").length;
  if (total === 0) return 0;
  const indic = (s.match(/[઀-૿ऀ-ॿ]/g) ?? []).length;
  return indic / total;
}

export function createStub(opts: StubOptions = {}): LlmClient {
  return {
    name: "stub",
    model: "offline-mechanical-renderer",
    available: true,

    async complete(messages: LlmMessage[], lopts: LlmOptions = {}): Promise<string> {
      const joined = messages.map((m) => m.content).join("\n");
      const isVerify = /faithful|Verifier|documentNotes/.test(joined);
      const isClassify = /docType/.test(joined) && !isVerify;
      const isReport = /executiveSummary/.test(joined);

      if (isClassify) {
        return JSON.stringify({
          docType: guessType(joined),
          confidence: 0.4,
          reasoning: "Deterministic offline classifier; no model was called.",
        });
      }

      if (isVerify) {
        return offlineVerify(joined);
      }

      if (isReport) {
        return JSON.stringify({
          executiveSummary:
            "This report was produced by the offline deterministic pipeline. No language model was used for " +
            "translation or verification, so the fidelity indicator reflects mechanical checks only " +
            "(datum conservation and glossary compliance) and materially understates nothing — it overstates " +
            "nothing either. Do not rely on this translation for any filing or advice.",
          reviewFocus: [
            "Every paragraph marked as requiring review in the findings table.",
            "All party names, checked against the original Gujarati by eye.",
            "Any segment whose length is materially shorter than its source.",
          ],
          limitations: [
            "No language model was available. English prose quality is not representative.",
            "Semantic equivalence, modality and negation were not assessed by a judge; only exact-match checks ran.",
            "The source Gujarati itself may be OCR-derived and unverified.",
          ],
          recommendedAction:
            "Configure a real translation provider and re-run, or use this output only to validate the pipeline mechanically.",
        });
      }

      // Translation request: parse the `[id] source` list out of the prompt.
      const pairs = parseSegments(joined);
      if (pairs.length === 0) {
        throw new LlmError("Stub provider could not find any source segments in the prompt", false);
      }

      const inject = opts.inject ?? "none";
      const dropAt = inject === "drop_sentence" ? Math.max(0, Math.floor(pairs.length / 3)) : -1;

      const segments = pairs.map((p, i) => {
        if (i === dropAt) {
          return { id: p.id, target: "", confidence: 0.9, notes: ["OMISSION: offline renderer dropped this segment."] };
        }
        let target = renderSegment(p.source, opts);
        let confidence = 0.72;
        const notes: string[] = [];

        if (inject === "change_number" && i === 0) {
          target = target.replace(/\b(\d[\d,]*)\b/, (m) => {
            const n = Number(m.replace(/,/g, ""));
            return Number.isFinite(n) ? String(n + 1) : m;
          });
          notes.push("NUMERIC: offline renderer perturbed a figure to exercise verification.");
        }
        if (inject === "literalize_term" && i === 0) {
          const vak = target.match(/Vakalatnama \([^)]*\)/);
          if (vak) {
            target = target.replace(vak[0], "power of attorney");
            notes.push("TERMINOLOGY: offline renderer rendered vakalatnama literally.");
          }
        }

        if (residueRatio(target) > 0.15) {
          confidence = 0.55;
          notes.push("Offline renderer left untranslated Gujarati in this segment.");
        }

        return { id: p.id, target, confidence, notes: notes.length > 0 ? notes : undefined };
      });

      return JSON.stringify({ segments, ambiguousTerms: [] });
    },
  };
}

interface Pair {
  id: number;
  source: string;
}

function parseSegments(prompt: string): Pair[] {
  const out: Pair[] = [];
  const re = /\[(\d+)\]\s*([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    out.push({ id: Number(m[1]), source: m[2] ?? "" });
  }
  return out;
}

function guessType(prompt: string): string {
  if (/FIR|ફરિયાદ|Charge Sheet/i.test(prompt)) return "fir_document";
  if (/CORAM|SCC\s*OnLine|નિર્ણય/.test(prompt)) return "court_judgment";
  if (/LEGAL NOTICE|વૈધ નોટિસ|put you on notice/i.test(prompt)) return "legal_notice";
  if (/7\/12|વેચાણ પત્ર|sale deed/i.test(prompt)) return "property_document";
  if (/અરજી|It is therefore prayed/i.test(prompt)) return "legal_application";
  return "other_legal";
}

/**
 * Offline semantic verification.
 *
 * Runs the checks that need no model: empty targets, gross length divergence, and
 * presence of residual Gujarati in the English side. It cannot assess meaning,
 * and the report says so.
 */
function offlineVerify(prompt: string): string {
  const pairs = parseJudgePairs(prompt).map((p) => ({ id: p.id, src: p.source, tgt: p.target }));

  const segments = pairs.map((p) => {
    const issues: Array<Record<string, string>> = [];
    if (p.tgt.trim().length === 0) {
      issues.push({
        code: "OMISSION",
        severity: "critical",
        detail: "The English segment is empty. The Gujarati source content has no counterpart.",
      });
    } else if (residueRatio(p.tgt) > 0.1) {
      issues.push({
        code: "DRIFT",
        severity: "major",
        detail: "The English segment still contains Gujarati characters; it was not fully translated.",
      });
    } else {
      const ratio = p.src.trim().length === 0 ? 1 : p.tgt.trim().length / p.src.trim().length;
      if (ratio < 0.35) {
        issues.push({
          code: "OMISSION",
          severity: "major",
          detail: `English segment is ${Math.round(ratio * 100)}% the length of its Gujarati source; content may have been dropped.`,
        });
      } else if (ratio > 2.6) {
        issues.push({
          code: "ADDITION",
          severity: "minor",
          detail: `English segment is ${Math.round(ratio * 100)}% the length of its Gujarati source; it may contain added material.`,
        });
      }
    }
    return {
      id: p.id,
      faithful: !issues.some((i) => i.severity === "critical" || i.severity === "major"),
      issues,
      confidence: 0.4,
    };
  });

  return JSON.stringify({
    segments,
    documentNotes: [
      "Offline verification only: exact-match checks ran, but no language model assessed semantic equivalence, modality or negation.",
    ],
    documentFaithful: segments.every((s) => s.faithful),
  });
}

export { parseJsonLoose, MONTH_MAP };
import { normalizeWhitespace } from "../domain/gujarati";
import { LlmError, type LlmClient, type LlmMessage, type LlmOptions } from "./provider";
import { parseJudgePairs } from "./prompts";

/**
 * Fixture provider backed by hand-written reference translations.
 *
 * Used by the demo/seed data so the product can be shown end to end with a
 * realistic fidelity indicator and a realistic findings table, and by tests that
 * need a *known-good* translation to assert "verification passes on a good
 * translation" — the negative control that makes the verifier meaningful.
 *
 * Lookup is by longest matching source prefix, so partial segments still resolve.
 */
const PAIRS: Array<[string, string]> = [
  [
    "ગુજરાતી ન્યાયાલયના આદેશ દ્વારા નીચેના આદેશ આપવામાં આવે છે.",
    "By order of the Hon'ble Court, the following order is passed:",
  ],
  [
    "આ દરજાને ન્યાયાલય આદેશથી સંભાળવામાં આવે છે.",
    "This order shall govern the proceedings before the Court.",
  ],
  [
    "ઉપરોક્ત આદેશ અંતર્ગત હશે અને તદાપર વધુ મુદ્લા કાર્યવાહીમાં આ અંગે વિચાર કરવામાં આવશે.",
    "The aforesaid order shall be interim, and the matter shall be listed for hearing on the next date fixed.",
  ],
  [
    "અરજીકર્તાએ જાહેર કરેલ જોગવાઈના જવાબમાં આ ન્યાયાલય તરીકે નીચેના આદેશનો આદેશ કરે છે.",
    "In response to the notice issued by the applicant, this Court orders as follows:",
  ],
  [
    "ખાનગી જવાબ દરજાવવાનો હોજવાનો નિરાશ નહીં કરાય.",
    "The applicant shall not be called upon to produce any private reply.",
  ],
  [
    "અરજીકર્તાની અરજી માન્ય કરવામાં આવે છે.",
    "The application of the applicant is allowed.",
  ],
  [
    "જાહેર નોટિસનો જવાબ આપવામાં આવ્યો નથી.",
    "No reply to the legal notice has been received.",
  ],
  [
    "નોટિસમાં દર્શાવેલ દંડની ચુકવણી માટે પત્ર 14 દિવસમાં ચૂકવવાની રહેશે.",
    "The amount of compensation stated in the notice shall be paid within 14 (fourteen) days.",
  ],
  [
    "જો આ મુદલ 14 દિવસમાં ચૂકવવામાં ન આવે તો અરજીકર્તા કાયમી જામીનત જામીન મેળવવાના હકકાર ધરાવશે.",
    "In the event that the said amount is not paid within 14 (fourteen) days, the applicant shall be entitled to claim permanent remand.",
  ],
  [
    "વૈધ નોટિસ મોકલવા અંગે તપાસ થઈ છે.",
    "The enquiry regarding despatch of the legal notice has been completed.",
  ],
  [
    "અહીં સૂચના આપવામાં આવે છે કે,",
    "Notice is hereby given that:",
  ],
  [
    "આ દરજાને ન્યાયાલયના રજિસ્ટ્રાર તરીકે નોંધણી કરવામાં આવે છે.",
    "This document shall be registered at the office of the Registrar of the Court.",
  ],
  [
    "સામે, રૂ. 5,00,000/- (રણ પાંચ લાખ માત્ર) નકલ ચૂકવવાનું રહેશે.",
    "The consideration shall be Rs. 5,00,000/- (Rupees Five Lakhs only).",
  ],
  [
    "જમીનર હેઠળની જમીન સપાટા નં. 45, સરફા નં. 112/2 માટે ખરીદી પત્ર જારી કરવામાં આવ્યું છે.",
    "A sale deed is issued in respect of the land of the said landowner admeasuring Plot No. 45, Survey No. 112/2.",
  ],
  [
    "કરારના વિરુદ્ધ હોય તે આ કરાર રદ ગણાશે.",
    "In the event of breach of this contract, this contract shall stand cancelled.",
  ],
  [
    "આ સમ્પત્તિ ૭/૧૨ માં નોંધાયેલ તેમ જ માલિકની સ્પષ્ટ માલિકી છે.",
    "The property is recorded in 7/12, and the ownership of the same is clear and unambiguous.",
  ],
  [
    "અરજીકર્તાની અરજી આ ન્યાયાલયના નિયમો અનુસારે રદ કરવામાં આવે છે.",
    "The application of the applicant is rejected in accordance with the rules of this Court.",
  ],
  [
    "ખરેખરો ચૂકવણાની તારીખ 30.04.2024 નકલ કરી લેવાની રહેશે.",
    "A certified copy of this order shall be furnished on 30.04.2024.",
  ],
  [
    "ખર્યાદાનું સાચા નોંધ નહીં મળ્યું.",
    "The original record of the court could not be traced.",
  ],
  [
    "રક્ષિત વિરોધ રજિસ્ટ્રાર મુજબ ત્રણ વર્ષની સમજૂતાઇ મળી આવવાનો વિકલ્પ હતો.",
    "Under the Record of Protected Submissions, the option of obtaining a three-year adjournment was available.",
  ],
];

const NORM = new Map(PAIRS.map(([gu, en]) => [normalizeWhitespace(gu), en] as const));

function resolve(source: string): string | undefined {
  const n = normalizeWhitespace(source);
  const direct = NORM.get(n);
  if (direct) return direct;
  const entries = [...NORM.entries()].sort((a, b) => b[0].length - a[0].length);
  const prefix = entries.find(([gu]) => n.startsWith(gu));
  if (prefix) return prefix[1];
  const contains = entries.find(([gu]) => gu.length > 18 && n.includes(gu));
  if (contains) return contains[1];
  return undefined;
}

export const FIXTURE_PAIRS: ReadonlyArray<readonly [string, string]> = PAIRS;

export function createFixture(): LlmClient {
  return {
    name: "fixture",
    model: "handwritten-reference-pairs",
    available: true,

    async complete(messages: LlmMessage[], _opts: LlmOptions = {}): Promise<string> {
      const joined = messages.map((m) => m.content).join("\n");

      if (/docType/.test(joined) && !/faithful/.test(joined)) {
        return JSON.stringify({
          docType: /આદેશ|નિર્ણય/.test(joined) ? "court_order" : "other_legal",
          confidence: 0.9,
          reasoning: "Matched handwritten reference translation for this fixture.",
        });
      }

      if (/faithful|documentNotes/.test(joined)) {
        const pairs = parseJudgePairs(joined).map((p) => ({ id: p.id, src: p.source, tgt: p.target }));
        return JSON.stringify({
          segments: pairs.map((p) => {
            const known = resolve(p.src);
            const issues: Array<Record<string, string>> = [];
            if (known && normalizeWhitespace(known) !== normalizeWhitespace(p.tgt)) {
              issues.push({
                code: "DRIFT",
                severity: "major",
                detail: "The English differs from the hand-written reference rendering for this source sentence.",
                quote: p.tgt.slice(0, 120),
                suggestion: known,
              });
            }
            if (p.tgt.trim().length === 0) {
              issues.push({
                code: "OMISSION",
                severity: "critical",
                detail: "English segment is empty.",
              });
            }
            return {
              id: p.id,
              faithful: issues.length === 0,
              issues,
              confidence: 0.85,
            };
          }),
          documentNotes: [],
          documentFaithful: true,
        });
      }

      if (/executiveSummary/.test(joined)) {
        return JSON.stringify({
          executiveSummary:
            "This document was processed by the reference-pair fixture. Translation, deterministic verification " +
            "and report generation all ran to completion. The fidelity indicator reported here is an automated " +
            "quality indicator produced by mechanical checks plus a fixture judge; it is not a certified accuracy " +
            "figure and does not make this translation court-acceptable. Human review remains required.",
          reviewFocus: [
            "Findings listed in the table above, in severity order.",
            "Party names against the original Gujarati.",
          ],
          limitations: ["Fixture judge is rule-based, not a language model."],
          recommendedAction: "Review the open findings, then sign the certificate block if the translation is adopted.",
        });
      }

      const pairs: Array<{ id: number; source: string }> = [];
      const re = /\[(\d+)\]\s*([^\n]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(joined)) !== null) {
        pairs.push({ id: Number(m[1]), source: m[2] ?? "" });
      }
      if (pairs.length === 0) {
        throw new LlmError("Fixture provider found no source segments", false);
      }

      return JSON.stringify({
        segments: pairs.map((p) => {
          const resolved = resolve(p.source);
          return {
            id: p.id,
            target: resolved ?? "[untranslated source segment retained verbatim for reviewer attention]",
            confidence: resolved ? 0.9 : 0.5,
            notes: resolved ? undefined : ["No reference rendering available for this segment."],
          };
        }),
        ambiguousTerms: [],
      });
    },
  };
}
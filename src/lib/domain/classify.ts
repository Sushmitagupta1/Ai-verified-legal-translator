import {
  GU_MONTHS,
  containsIndic,
  detectLegacyEncoding,
  detectScript,
  isGujaratiText,
  scriptProfile,
} from "./gujarati";
import { DOC_TYPE_META, type DocType, type DocTypeMeta } from "./doctypes";

/**
 * Weighted keyword classifier for Indian legal document types.
 *
 * Scores are additive over patterns; a document type only wins if it clears a
 * relative margin over the runner-up, otherwise `other_legal` is returned. The
 * result is *advisory*: the user always sees and can override it, because a
 * wrong register (judgment vs notice) changes translation style throughout.
 */
interface Rule {
  type: DocType;
  weight: number;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    type: "court_judgment",
    weight: 3,
    patterns: [
      /\bSCC\s*OnLine/i,
      /\b(?:CRL\.?\s*A\.?|C\.?\s?R\.?|CRA)\s*\d+\/\d{4}/i,
      /\b(?:MANU|LD)\s*\d+/i,
      /નિર્ણય/,
      /નિર્ણયની/,
      /\bCORAM\b/i,
      /\bJUDGMENT\b/i,
      /\b(?:HON'?ABLE|J)\s*:?\s*(?:JUSTICE|JUDGE)/i,
      /\b(?:PLAINTIFF|APPELLANT)\s+VERSUS\b/i,
      /\b(?:before|Judgment delivered by)\b/i,
      /સામરે/,
      /સામરેથી/,
      /\b(?:Considering|It is ordered|Ordered that)\b/i,
      /\b(?:appeal|Revision) (?:is )?(?:allowed|dismissed|partly allowed)/i,
      /આદેશ થયો/,
      /નિર્ણયાર્થ/,
      /\b(?:accused|Petitioner)\s+(?:is|was)\s+(?:acquitted|convicted|discharged)/i,
    ],
  },
  {
    type: "court_order",
    weight: 2,
    patterns: [
      /\bC\.?O\.?\s*No\.?\s*\d+\/\d{4}/i,
      /\bOrder No\.?\s*\d+/i,
      /\b(?:on|dated)\s+\d{1,2}\/\d{1,2}\/\d{4}/i,
      /આદેશ/,
      /\b(?:interim order|stay order|vacate order)\b/i,
      /\bIt is ordered\b/i,
      /\b(?:learned|learnt) (?:Advocate|APP)\b/i,
      /અરજી(?:નો)? નિરાખ/,
      /\bPetition(?:er)?\s+prays\b/i,
    ],
  },
  {
    type: "legal_notice",
    weight: 3,
    patterns: [
      /વૈધ નોટિસ/i,
      /\b(?:LEGAL|legal)\s+NOTICE\b/i,
      /નોટિસ/,
      /\bunder my instructions and on behalf of\b/i,
      /\bhereby (?:give|call|serve|put) you on notice\b/i,
      /\byou are hereby (?:called|required|put) on notice\b/i,
      /\bwithin (\d+|seven|fifteen|thirty) days\b/i,
      /\b(?:take note|be informed) that\b/i,
      /\b(?:advocate|Advocate) (?:for|on behalf of) the (?:complainant|defendant|petitioner)\b/i,
      /\bAll correspondence to be addressed to\b/i,
      /સલામ/,
      /નમસ્કાર/,
    ],
  },
  {
    type: "fir_document",
    weight: 4,
    patterns: [
      /ફરિયાદ\s*(?:નોંધણી|નોંધણી\s*પત્ર|કોપી)?/,
      /\bFIR\s*(?:No\.?|Number|book|entry)?/i,
      /\bFirst Information Report\b/i,
      /\b(?:Daily Diary|Station Diary|Diary No\.)\b/i,
      /\bGD No\.|\bGeneral Diary\b/i,
      /\b(?:s\/\d{4}|R\/No\.)\b/i,
      /\bPolice Station\b/,
      /\bStation House Officer\b/i,
      /\bInformant\b/i,
      /\b(?:Sections?)\s*\d+[A-Z]?\s*(?:IPC|BNS)\b/i,
      /\bSchedule of Offences\b/i,
    ],
  },
  {
    type: "police_report",
    weight: 3,
    patterns: [
      /\b(?:charge[- ]?sheet|chargesheet)\b/i,
      /\b(?:investigation report|final report|report under Section)\b/i,
      /\b(?:arrest(?:ing)? memo|arrest memo)\b/i,
      /\b(?:remand|remand memo)\b/i,
      /\b(?:custody record|undertrial|convict|prisoner)\b/i,
      /\bFIR (?:copy|extract) (?:is )?(?:received|received at)\b/i,
      /\bSDO\b|\bI\.O\.P\.B\.?\b/,
      /ચાર્જશીટ/,
      /ધરાવ/,
      /જપ્ત/,
      /તપાસ/,
    ],
  },
  {
    type: "government_order",
    weight: 2,
    patterns: [
      /\b(?:Government of (?:Gujarat|India))\b/i,
      /\b(?:GR|G\.R\.) (?:No\.?)?\s*\d+\/\d{2,4}[-/]\s*\d+\b/i,
      /\b(?:Circular|Office Order|Government Order|Resolution)\b/i,
      /\b(?:Government Notification) No\.?\s*\d+/i,
      /\b(?:Collector|District Collector|Secretary)\b/i,
      /\b(?:Finance|Home|Revenue|Transport)\s+Department\b/i,
      /સરકાર/,
      /શાસન/,
      /ગામભાત/,
      /વિભાગ/,
      /\b(?:hereby|is hereby)\s+(?:directed|instructed)\b/i,
    ],
  },
  {
    type: "agreement",
    weight: 2,
    patterns: [
      /\b(?:Settlement Deed|Reconciliation|MOU|Memorandum of Understanding)\b/i,
      /\b(?:this deed|this agreement) is made\b/i,
      /\b(?:Whereas|Whereas and Whereas)\b/i,
      /\bin consideration of\b/i,
      /\b(?:lessor|lessee|tenant)(?: shall)? (?:agrees|agrees to)\b/i,
      /\b1\. THIS DEED\b/i,
      /\b(?:first party|second party)\b/i,
      /સમજોટા/,
      /કરાર/,
      /વાસમાં આપેલ/,
      /અહેવાલી/,
    ],
  },
  {
    type: "contract",
    weight: 2,
    patterns: [
      /\b(?:purchase agreement|supply agreement|service agreement)\b/i,
      /\b(?:terms and conditions|force majeure|indemnity|warranty)\b/i,
      /\b(?:bill of supply|purchase order)\b/i,
      /\bperformance guarantee\b/i,
      /વ્યવસાય/,
      /શરતો/,
      /પ્રમાણ ચૂકવો/,
    ],
  },
  {
    type: "property_document",
    weight: 3,
    patterns: [
      /\b(?:sale deed|conveyance deed|conveyance)\b/i,
      /\b(?:7\/12|8-A|8A)\b/,
      /\b(?:Record of Rights|khata|khatauni|khunwari)\b/i,
      /\b(?:mortgage deed|equitable mortgage|charge)\b/i,
      /\b(?:lease deed|licence|tenancy)\b/i,
      /\b(?:survey number|block number|tp\s*\d+|survey\s*(?:no|number))\b/i,
      /\b(?:plot(?:s)?\s*(?:no|number)|shikren)\b/i,
      /\b(?:adhesion|adhésion) stamp\b/i,
      /વેચાણ પત્ર/,
      /ખરીદી કાગળ/,
      /અસલ કામગીરી/,
      /સત્તાવિહી/,
      /હિસ્સેદાર/,
      /આભાઈ/,
    ],
  },
  {
    type: "affidavit",
    weight: 4,
    patterns: [
      /\b(?:affidavit|deponent|verily|sworn)\b/i,
      /શપથ/,
      /જિહેર/,
      /દરખાસ્ત/,
      /\bI,?\s+\w+,?\s+(?:s\/o|d\/o|w\/o)\b/i,
      /\b(?:solemnly affirm|solemnly swear)\b/i,
    ],
  },
  {
    type: "bail_application",
    weight: 5,
    patterns: [
      /\b(?:regular bail|anticipatory bail)\b/i,
      /\bSection (?:437A|438|437|439|440) (?:CrPC|BNSS)\b/i,
      /\b(?:prayer|bails?)\b.*\baccused\b/i,
      /જામીન/,
      /જામીનત જામીન/,
      /અગાઉ જામીન/,
      /\bthat the accused may be released on\b/i,
      /\b(?:parole|interim custody)\b/i,
    ],
  },
  {
    type: "writ_petition",
    weight: 5,
    patterns: [
      /\bArticle (?:32|226|227)\b/i,
      /\b(?:writ petition|writ of (?:mandamus|habeas corpus|certiorari|prohibition|quo warranto))\b/i,
      /\b(?:Petitioner|Respondent) State(?: of)?\b/i,
      /\bdisposition of (?:the )?writ petition\b/i,
      /રીટ/,
      /રિટ/,
      /\blearned (?:Advocate|APP)\s+(?:for the )?Petitioner\s+prays\b/i,
    ],
  },
  {
    type: "legal_application",
    weight: 1,
    patterns: [
      /અરજી/,
      /અરજીપત્ર/,
      /\b(?:prays|pray for) (?:that|it)\b/i,
      /\bIt is therefore respectfully prayed\b/i,
      /\bMost respectfully prayed\b/i,
      /\bapplication (?:under|dated)\b/i,
    ],
  },
  {
    type: "complaint",
    weight: 1,
    patterns: [
      /\b(?:complaint|complainant) (?:under|u\/s)\b/i,
      /\b(?:S\.?O\.? No\.?)\s*\d+\/\d{4}/i,
      /\brepresented by\b.*\b(?:Advocate|Counsel)\b/i,
      /ફરિયાદ/,
      /\b(?:prays) that (?:the )?(?:complaint|application)/i,
    ],
  },
];

export interface TypeDetection {
  type: DocType;
  confidence: number;
  scores: Array<{ type: DocType; score: number }>;
  register: DocTypeMeta["register"];
  /** Alternative worth showing the user. */
  runnerUp?: { type: DocType; score: number };
}

/**
 * Choose a document type. Tie-breaking is deliberately conservative: when two
 * types score closely the runner-up is reported and `confidence` drops, so the UI
 * prompts the user to confirm rather than silently locking a register in.
 */
export function detectDocType(text: string): TypeDetection {
  const scores = new Map<DocType, number>();
  for (const rule of RULES) {
    let s = 0;
    for (const p of rule.patterns) {
      const m = text.match(new RegExp(p.source, p.flags.includes("g") ? p.flags : p.flags + "g"));
      if (m) {
        // Diminishing returns: repeated boilerplate should not dominate.
        s += rule.weight * (1 + Math.log2(1 + m.length) / 4);
      }
    }
    if (s > 0) scores.set(rule.type, s);
  }

  const ranked = [...scores.entries()]
    .map(([type, score]) => ({ type, score }))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return { type: "other_legal", confidence: 0, scores: [], register: "instrument" };
  }

  const top = ranked[0];
  const second = ranked[1];
  const margin = second ? (top.score - second.score) / top.score : 1;

  // A document with recognizable Gujarati legal prose but no strong type signal
  // should still be handled as a legal instrument, not silently dropped.
  const type = margin < 0.18 && top.score < 6 ? "other_legal" : top.type;
  const confidence = type === "other_legal" ? Math.min(0.5, top.score / 12) : Math.min(0.98, 0.55 + margin * 0.4);

  return {
    type,
    confidence: Number(confidence.toFixed(3)),
    scores: ranked,
    register: DOC_TYPE_META[type]?.register ?? "instrument",
    runnerUp: second && second.score > 0 ? { type: second.type, score: Number(second.score.toFixed(2)) } : undefined,
  };
}

export interface DocumentPreflight {
  ok: boolean;
  isIndic: boolean;
  script: ReturnType<typeof detectScript>;
  profile: ReturnType<typeof scriptProfile>;
  legacy: ReturnType<typeof detectLegacyEncoding>;
  gujaratiChars: number;
  latinChars: number;
  warnings: Array<{ code: string; severity: "info" | "warn" | "block"; message: string }>;
}

/**
 * Gate before any translation is attempted.
 *
 * Translating the wrong script produces fluent nonsense, which is far more
 * dangerous than refusing. A Gujarati-input product must reject non-Gujarati
 * input loudly.
 */
export function preflightDocument(text: string): DocumentPreflight {
  const profile = scriptProfile(text);
  const legacy = detectLegacyEncoding(text);
  const script = profile.script;
  const isIndic = containsIndic(text);
  const warnings: DocumentPreflight["warnings"] = [];

  let gujaratiChars = 0;
  let latinChars = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? -1;
    if (c >= 0x0a80 && c <= 0x0aff) gujaratiChars++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latinChars++;
  }

  if (legacy.suspected) {
    warnings.push({
      code: "legacy_encoding",
      severity: "block",
      message:
        `Possible legacy Indic font encoding detected (${legacy.candidates.join(", ")}). ` +
        "Automatic conversion is not performed because a wrong conversion silently corrupts names and numbers. " +
        "Please upload a Unicode copy, or have the source re-typed/saved as Unicode before translation.",
    });
  }

  if (!isIndic) {
    warnings.push({
      code: "not_indic",
      severity: "warn",
      message:
        "No Gujarati or Devanagari script detected. This pipeline is configured for Gujarati input; English or other input is accepted only for comparison purposes.",
    });
  } else if (!isGujaratiText(text) && script === "devanagari") {
    warnings.push({
      code: "wrong_script",
      severity: "block",
      message:
        "The text is in Devanagari (Hindi/Marathi), not Gujarati. Translating it through a Gujarati pipeline would degrade quality. Choose the Hindi pipeline.",
    });
  } else if (profile.gujaratiRatio < 0.15) {
    warnings.push({
      code: "low_gujarati",
      severity: "warn",
      message: `Only ${(profile.gujaratiRatio * 100).toFixed(1)}% of characters are Gujarati. Check that the right document was uploaded.`,
    });
  }

  if (profile.latinRatio > 0.5 && isIndic) {
    warnings.push({
      code: "mixed_script",
      severity: "info",
      message: "This is a bilingual document. English passages will be preserved rather than translated.",
    });
  }

  const blocking = warnings.some((w) => w.severity === "block");
  return {
    ok: !blocking,
    isIndic,
    script,
    profile,
    legacy,
    gujaratiChars,
    latinChars,
    warnings,
  };
}
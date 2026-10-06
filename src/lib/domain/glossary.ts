/**
 * Curated Gujarati -> English legal terminology layer.
 *
 * Design rules (these are what separate this from a general translator):
 *
 * 1. `preserve: true`  — the term must appear verbatim in the English output.
 *    Used for things with no faithful English equivalent or where Indian courts
 *    use the English word directly in a Gujarati document (FIR, FIR No., IPC,
 *    vakalatnama, bail, etc.). Translating these to a literal English phrase
 *    changes the legal meaning, so they are protected, not translated.
 * 2. `parenthetical` — optional gloss emitted on first use so a non-Indian
 *    reader or an English-speaking advocate understands the construct.
 * 3. `alternatives` — genuinely contested renderings. These are NOT silently
 *    chosen; the verification stage raises them for human review instead.
 * 4. Never invent. Every entry here is a term that actually occurs in Gujarati
 *    court orders, notices, FIRs, applications, sale deeds, affidavits or
 *    government circulars.
 */

export type LegalCategory =
  | "court"
  | "police"
  | "criminal"
  | "civil"
  | "constitutional"
  | "evidence"
  | "contract"
  | "property"
  | "statute"
  | "procedure"
  | "party"
  | "remedy"
  | "notice"
  | "revenue"
  | "general";

export interface GlossaryEntry {
  /** Gujarati (or already-English) source surface form. */
  source: string;
  /** Required English rendering. */
  target: string;
  category: LegalCategory;
  /**
   * true  = term must appear verbatim in the output; never translated.
   * false = term must be rendered as `target` (translated to it).
   */
  preserve: boolean;
  parenthetical?: string;
  /** Other defensible renderings — flagged for review, never auto-swapped. */
  alternatives?: string[];
  note?: string;
  /** Extra surface spellings that should resolve to this same entry. */
  aliases?: string[];
}

/**
 * Statute short-forms that must never be translated.
 * Gujarati documents routinely write "આઈ.પી.સી. ધારાની કલમ ૩૦૨" or
 * "આઈપીસી 302" — the short-form IS the citation.
 */
export const STATUTE_TOKENS = [
  "IPC", "BNS", "CrPC", "BNSS", "CPC", "IEA", "BSA", "NI Act", "NIA",
  "SARFAESI", "PMLA", "POCSO", "NDPS", "ULAP", "GARB", "RTI",
  "Cr. P.C.", "C.P.C.", "I.P.C.", "I.E.A.", "B.N.S.", "B.N.S.S.",
  "આઈ.પી.સી.", "આઈપીસી", "બી.એન.એસ.", "બીએનએસ", "સી.આર.પી.સી.", "સીઆરપીસી",
  "ક્ર.પી.સી.", "સી.પી.સી.", "આઈ.ઇ.એ.", "નિ.", "એ.ની.એ.", "પો.", "સિ.", "ફો.",
  "C.P.C.", "O.XIII", "O. XIII",
];

/** Honourific / party markers used to detect person names. */
export const PERSON_TITLES_GU = ["શ્રી", "શ્રીમતી", "સુશ્રી", "કુ.", "શ્રીમાન", "ડા.", "મુ.", "પ્રો."];
export const PERSON_TITLES_EN = ["Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Shri", "Smt."];

/** Designations that precede a name in the Gujarati signature/certificate block. */
export const SIGNATORY_DESIGNATIONS = [
  "ન્યાયાધીશ", "મેજિસ્ટ્રેટ", "નોટરી પબ્લિક", "રજિસ્ટ્રાર", "કલેક્ટર",
  "તહાસીલદાર", "સિવિલ જજ", "ચીફ જ્યુડિશિયલ મેજિસ્ટ્રેટ", "પ્રાથમિક મેજિસ્ટ્રેટ",
  "પોલીસ અધિકારી", "સરનાયક", "વકીલ", "એડવોકેટ", "અધિકારી",
  "Commissioner of Police", "District Magistrate", "Sub-Registrar",
];

/**
 * The terminology dictionary. Roughly 300 head-terms covering criminal, civil,
 * constitutional, evidence, property/land, revenue, contract and procedure
 * vocabulary, which is the bulk of Gujarati district-court and taluka-court
 * paper.
 */
export const GLOSSARY: GlossaryEntry[] = [
  // ── Courts & judicial apparatus ────────────────────────────────────────────
  { source: "સર્વોચ્ચ ન્યાયાલય", target: "Supreme Court", category: "court", preserve: false, aliases: ["સર્વોચ્ચ ન્યાયાલય સર્વોચ્ચ ન્યાયાલય"] },
  { source: "ઉચ્ચ ન્યાયાલય", target: "High Court", category: "court", preserve: false, aliases: ["હાઇ કોર્ટ"] },
  { source: "જિલ્લા ન્યાયાલય", target: "District Court", category: "court", preserve: false },
  { source: "અદાલત", target: "Court", category: "court", preserve: false, alternatives: ["Tribunal", "Forum"] },
  { source: "ન્યાયાલય", target: "Court", category: "court", preserve: false },
  { source: "ફોરમ", target: "Court", category: "court", preserve: false, note: "Gujarati court usage for the presiding forum; distinguish from English 'form'." },
  { source: "દિવાની ન્યાયાલય", target: "Civil Court", category: "court", preserve: false },
  { source: "ફાર્સિયલ ન્યાયાલય", target: "Criminal Court", category: "court", preserve: false },
  { source: "સેશન ન્યાયાલય", target: "Sessions Court", category: "court", preserve: false, aliases: ["સેશન્સ ન્યાયાલય"] },
  { source: "ક્રિમિનલ ન્યાયાલય", target: "Criminal Court", category: "court", preserve: false },
  { source: "પ્રાથમિક ન્યાયાલય", target: "Magistrate Court", category: "court", preserve: false, alternatives: ["Primary Court", "Judicial Magistrate Court"] },
  { source: "પ્રાથમિક મેજિસ્ટ્રેટ", target: "Judicial Magistrate", category: "court", preserve: false },
  { source: "ચીફ જ્યુડિશિયલ મેજિસ્ટ્રેટ", target: "Chief Judicial Magistrate", category: "court", preserve: false },
  { source: "મેજિસ્ટ્રેટ", target: "Magistrate", category: "court", preserve: false },
  { source: "ન્યાયાધીશ", target: "Judge", category: "court", preserve: false, alternatives: ["Justice (when elevated)"] },
  { source: "સિવિલ જજ", target: "Civil Judge", category: "court", preserve: false },
  { source: "ક્રિમિનલ જજ", target: "Criminal Judge", category: "court", preserve: false },
  { source: "લોક અદાલત", target: "Lok Adalat", category: "court", preserve: true, parenthetical: "people's court for settlement of disputes", aliases: ["લોકઅદાલત"] },
  { source: "લોક સભા", target: "Lok Sabha", category: "court", preserve: false },
  { source: "વિધાનસભા", target: "Legislative Assembly", category: "court", preserve: false },
  { source: "રાજ્યસભા", target: "Rajya Sabha", category: "court", preserve: false },
  { source: "સર્વોચ્ચ કોર્ટ બર", target: "Bar Council of India", category: "court", preserve: false },
  { source: "કોર્ટ કમ્પ્લિઅન્ટ", target: "Court Commissioner", category: "court", preserve: false },
  { source: "સર્નાયક", target: "Public Prosecutor", category: "court", preserve: false, parenthetical: "State's counsel in a criminal case" },
  { source: "એડવોકેટ", target: "Advocate", category: "party", preserve: false },
  { source: "વકીલ", target: "Advocate", category: "party", preserve: false, note: "In a vakalatnama this is the person being appointed, not an advocate appointed by the party.", aliases: ["વકીલ નામું", "વકાલતનામું", "વકલતનામું"] },
  { source: "નોટરી પબ્લિક", target: "Notary Public", category: "party", preserve: false },
  { source: "નોટરી", target: "Notary", category: "party", preserve: false },

  // ── Police & criminal procedure ────────────────────────────────────────────
  { source: "ફરિયાદ", target: "FIR (First Information Report)", category: "police", preserve: false, note: "Often already written 'FIR' in Gujarati documents; when the source writes 'ફરિયાદ' as the statutory report use 'FIR'.", alternatives: ["complaint (in the general sense)"] },
  { source: "ફરિયાદ નોંધણી", target: "Registration of FIR", category: "police", preserve: false },
  { source: "ફરિયાદ નોંધણી પત્ર", target: "FIR Register / FIR Copy", category: "police", preserve: false },
  { source: "પોલીસ", target: "Police", category: "police", preserve: false },
  { source: "પોલીસ અધિકારી", target: "Police Officer", category: "police", preserve: false },
  { source: "પ્રાથમિક પોલીસ", target: "First Information Officer", category: "police", preserve: false },
  { source: "સ્થાનિક પોલીસ", target: "Station House Officer", category: "police", preserve: false, parenthetical: "in-charge of a police station" },
  { source: "ઇન્સ્પેક્ટર", target: "Inspector", category: "police", preserve: false },
  { source: "સુપરિન્ટેન્ડેન્ટ", target: "Superintendent of Police", category: "police", preserve: false },
  { source: "દુર્મિલ", target: "Director General of Police", category: "police", preserve: false },
  { source: "પુલિસ વ્યવસ્થાપક", target: "Commissioner of Police", category: "police", preserve: false },
  { source: "કોર્ટ પોલીસ", target: "Court Police", category: "police", preserve: false },
  { source: "ગેરદાવાર", target: "Constable", category: "police", preserve: false },
  { source: "ચારજદાર", target: "Head Constable", category: "police", preserve: false },
  { source: "સિવિલ પોલીસ", target: "Civil Police", category: "police", preserve: false },
  { source: "જામીન", target: "Bail", category: "criminal", preserve: false, alternatives: ["security (in the surety sense)"] },
  { source: "જામીનત", target: "Remand", category: "criminal", preserve: false, note: "'જામીનત જામીન' = remand; 'જામીન' on its own = bail. Conflating them is a classic fatal error." },
  { source: "વારંટ", target: "Warrant", category: "criminal", preserve: false, aliases: ["વારંટી"] },
  { source: "પરવાન", target: "Warrant", category: "criminal", preserve: false },
  { source: "સમરન", target: "Summons", category: "criminal", preserve: false },
  { source: "નોટીસ", target: "Notice", category: "criminal", preserve: false },
  { source: "પરિષદ", target: "Court", category: "criminal", preserve: false },
  { source: "વિચારણા", target: "Trial", category: "criminal", preserve: false },
  { source: "તપાસ", target: "Investigation", category: "criminal", preserve: false, alternatives: ["Inquiry (where a preliminary inquiry is meant)"] },
  { source: "તપાસ કરવા", target: "To investigate", category: "criminal", preserve: false },
  { source: "અન્વેષણ", target: "Search", category: "criminal", preserve: false },
  { source: "ધરાવ", target: "Seizure", category: "criminal", preserve: false },
  { source: "જપ્ત", target: "Confiscation", category: "criminal", preserve: false, note: "'ધરાવ' = seizure (process); 'જપ્ત' = confiscation (final taking). Distinct statutory acts." },
  { source: "જપ્તી", target: "Confiscated", category: "criminal", preserve: false },
  { source: "આરોપણ", target: "Imputation", category: "criminal", preserve: false },
  { source: "રાજહ", target: "Charge", category: "criminal", preserve: false },
  { source: "આરોપ", target: "Charge framed", category: "criminal", preserve: false },
  { source: "ચાર્જશીટ", target: "Charge Sheet", category: "criminal", preserve: false, aliases: ["ચાર્જ શીટ", "ચાર્જશીટ ફાઇલ"] },
  { source: "મુકતાવણી", target: "Discharge", category: "criminal", preserve: false },
  { source: "દોષમુક્ત", target: "Acquitted", category: "criminal", preserve: false },
  { source: "દોષસાહિત", target: "Convicted", category: "criminal", preserve: false },
  { source: "ખાતરી", target: "Acquittal", category: "criminal", preserve: false },
  { source: "દંડ", target: "Punishment", category: "criminal", preserve: false },
  { source: "શિક્ષા", target: "Penalty", category: "criminal", preserve: false },
  { source: "કેદ", target: "Imprisonment", category: "criminal", preserve: false, alternatives: ["custody (for pre-trial)"] },
  { source: "કારાવાસ", target: "Imprisonment", category: "criminal", preserve: false },
  { source: "ફારગી", target: "Jail", category: "criminal", preserve: false },
  { source: "જેલ", target: "Jail", category: "criminal", preserve: false },
  { source: "કાસ્તી જેલ", target: "Cellular Jail", category: "criminal", preserve: false },
  { source: "સામાન્ય જેલ", target: "District Jail", category: "criminal", preserve: false },
  { source: "ગુનાહો", target: "Offence", category: "criminal", preserve: false },
  { source: "ગુનાહો કર્તા", target: "Offender", category: "criminal", preserve: false },
  { source: "અપરાધ", target: "Crime", category: "criminal", preserve: false },
  { source: "અપરાધી", target: "Offender", category: "criminal", preserve: false },
  { source: "મોકલ", target: "Complainant", category: "criminal", preserve: false },
  { source: "ફરિયાદકર્તા", target: "Complainant", category: "criminal", preserve: false, aliases: ["ફરિયાદ કર્તા"] },
  { source: "પ્રતિવાદી", target: "Accused", category: "party", preserve: false, note: "'પ્રતિવાદી' = accused in criminal proceedings. In civil matters the Gujarati equivalent is 'પ્રતિવાદી' = defendant; context decides.", alternatives: ["defendant (in civil matters)"] },
  { source: "વાદી", target: "Plaintiff", category: "party", preserve: false },
  { source: "વાદીઓ", target: "Plaintiffs", category: "party", preserve: false },
  { source: "પ્રતિવાદીઓ", target: "Defendants", category: "party", preserve: false },
  { source: "હવેલી", target: "Vakalatnama (power of attorney for legal representation)", category: "party", preserve: true, parenthetical: "written authority appointing an advocate" },
  { source: "વકાલતનામું", target: "Vakalatnama (power of attorney for legal representation)", category: "party", preserve: true },
  { source: "હિરવાઈ", target: "Leave application", category: "procedure", preserve: false },
  { source: "અનુજ્ઞાપત્ર", target: "Application", category: "procedure", preserve: false },

  // ── Civil procedure & remedies ─────────────────────────────────────────────
  { source: "અરજી", target: "Application", category: "procedure", preserve: false, alternatives: ["Petition (in appellate procedure)"] },
  { source: "અરજીપત્ર", target: "Application", category: "procedure", preserve: false },
  { source: "દાખલપત્ર", target: "Application", category: "procedure", preserve: false },
  { source: "રીટ", target: "Writ", category: "remedy", preserve: false, aliases: ["રિટ"] },
  { source: "રીટ યાચિકા", target: "Writ jurisdiction", category: "remedy", preserve: false },
  { source: "હંસીકરણ રીટ", target: "Certiorari", category: "remedy", preserve: false },
  { source: "પરિહાર રીટ", target: "Quo Warranto", category: "remedy", preserve: false },
  { source: "રદ કરવાની રીટ", target: "Mandamus", category: "remedy", preserve: false },
  { source: "પ્રતિબંધાત્મક રીટ", target: "Prohibition", category: "remedy", preserve: false },
  { source: "રિટ યાચિકા યાદ્યપત્ર", target: "Writ petition", category: "remedy", preserve: false },
  { source: "અપીલ", target: "Appeal", category: "remedy", preserve: false },
  { source: "અપીલની ચાલી", target: "Appeal proceedings", category: "remedy", preserve: false },
  { source: "રિવ્યોઝન", target: "Revision", category: "remedy", preserve: false },
  { source: "અર્જી", target: "Application", category: "procedure", preserve: false },
  { source: "મુકદમો", target: "Written submission", category: "procedure", preserve: false },
  { source: "મુદ્દા", target: "Facts", category: "procedure", preserve: false },
  { source: "મુદ્દાઓ", target: "Facts", category: "procedure", preserve: false },
  { source: "કારણ", target: "Cause title", category: "procedure", preserve: false, note: "In a cause title 'કારણ' is the separator between parties, not 'reason'." },
  { source: "આદેશ", target: "Order", category: "procedure", preserve: false, aliases: ["આર્ડર"] },
  { source: "નિર્ણય", target: "Judgment", category: "procedure", preserve: false },
  { source: "નિર્ણયની નકલ", target: "Certified copy of the judgment", category: "procedure", preserve: false },
  { source: "હુકમ", target: "Order", category: "procedure", preserve: false },
  { source: "મુકદમા", target: "Decree", category: "procedure", preserve: false },
  { source: "ડિક્રી", target: "Decree", category: "procedure", preserve: false },
  { source: "અંતર્ગત આદેશ", target: "Interim order", category: "procedure", preserve: false },
  { source: "કાયમી આદેશ", target: "Final order", category: "procedure", preserve: false, alternatives: ["permanent order"] },
  { source: "સુધારાણી આદેશ", target: "Interim order", category: "procedure", preserve: false },
  { source: "જોગવાઈ", target: "Notice", category: "notice", preserve: false, note: "'જોગવાઈ' is the statutory show-cause notice; it is not merely information.", alternatives: ["show-cause notice", "opportunity hearing"] },
  { source: "જોગવાઈ અનુસાર", target: "Compliance", category: "notice", preserve: false },
  { source: "વૈધ નોટિસ", target: "Legal notice", category: "notice", preserve: false },
  { source: "નોટિસ", target: "Notice", category: "notice", preserve: false },
  { source: "નોટિસ પર સહી", target: "Signature on the notice", category: "notice", preserve: false },
  { source: "રજિસ્ટરી હોના વિક્રેય", target: "Registered sale deed", category: "property", preserve: false },
  { source: "ફરિયાદ અરજી", target: "Written complaint / plaint", category: "civil", preserve: false },
  { source: "રાજકીય સમજોટા", target: "Settlement deed", category: "civil", preserve: false },
  { source: "સમજોટા", target: "Settlement", category: "civil", preserve: false },
  { source: "સમાધાન", target: "Settlement", category: "civil", preserve: false },
  { source: "માધ્યસ્થન", target: "Arbitration", category: "civil", preserve: false },
  { source: "વિવાદ", target: "Dispute", category: "civil", preserve: false },
  { source: "વિવાદક", target: "Arbitrator", category: "civil", preserve: false },
  { source: "ઇજાબત", target: "Contempt", category: "civil", preserve: false },
  { source: "ઇજાબતનું અરજી", target: "Contempt petition", category: "civil", preserve: false },

  // ── Evidence ───────────────────────────────────────────────────────────────
  { source: "પુરાવા", target: "Evidence", category: "evidence", preserve: false },
  { source: "પુરાવા પેપર", target: "Evidence paper", category: "evidence", preserve: false },
  { source: "દસ્તાવેજ", target: "Document", category: "evidence", preserve: false },
  { source: "સાક્ષ્ય", target: "Witness", category: "evidence", preserve: false },
  { source: "સાક્ષી", target: "Witness", category: "evidence", preserve: false },
  { source: "સાક્ષ્યજીવન", target: "Deposition", category: "evidence", preserve: false },
  { source: "પ્રમાણ", target: "Proof", category: "evidence", preserve: false },
  { source: "સાબિત", target: "Proved", category: "evidence", preserve: false },
  { source: "અસાબિત", target: "Disproved", category: "evidence", preserve: false },
  { source: "શપથ", target: "Oath", category: "evidence", preserve: false },
  { source: "નિયાદ", target: "Deposition", category: "evidence", preserve: false },
  { source: "પરિષદ પુરાવા", target: "Documentary evidence", category: "evidence", preserve: false },
  { source: "ખવાનીનામું", target: "Confession", category: "evidence", preserve: false, alternatives: ["statement"] },
  { source: "વિવાધન", target: "Cross-examination", category: "evidence", preserve: false },
  { source: "પુનઃપરીક્ષણ", target: "Re-examination", category: "evidence", preserve: false },
  { source: "સત્યાધિકાર", target: "Veracity", category: "evidence", preserve: false },

  // ── Contract & property ────────────────────────────────────────────────────
  { source: "કરાર", target: "Contract", category: "contract", preserve: false, alternatives: ["agreement"] },
  { source: "કરારનામો", target: "Agreement", category: "contract", preserve: false },
  { source: "સમ્પત્તિ", target: "Property", category: "property", preserve: false },
  { source: "મિલકત", target: "Property", category: "property", preserve: false },
  { source: "જમીન", target: "Land", category: "property", preserve: false },
  { source: "જમીનર", target: "Landowner", category: "property", preserve: false },
  { source: "પ્લોટ", target: "Plot", category: "property", preserve: false },
  { source: "ખરીદી પત્ર", target: "Sale deed", category: "property", preserve: false, aliases: ["વેચાણ પત્ર", "ખરીદી કાગળ"] },
  { source: "વેચાણ પત્ર", target: "Sale deed", category: "property", preserve: false },
  { source: "અહેવાલી", target: "Will", category: "property", preserve: false },
  { source: "વસીલતનામું", target: "Will", category: "property", preserve: false },
  { source: "ઉપકરણ", target: "Inheritance", category: "property", preserve: false },
  { source: "વારસો", target: "Heir", category: "property", preserve: false },
  { source: "હકકાર", target: "Right", category: "property", preserve: false },
  { source: "હકકુદાર", target: "Legal heir", category: "property", preserve: false },
  { source: "ગીરવ", target: "Mortgage", category: "property", preserve: false },
  { source: "ગીરવ ખાતું", target: "Mortgage deed", category: "property", preserve: false },
  { source: "અધિગ્રહણ", target: "Lease", category: "property", preserve: false },
  { source: "કિરાયો", target: "Lease", category: "property", preserve: false },
  { source: "અંગડાલ", target: "Share", category: "property", preserve: false },
  { source: "હિસ્સેદાર", target: "Co-sharer", category: "property", preserve: false },
  { source: "આભાઈ", target: "Partition", category: "property", preserve: false },
  { source: "જોગબાદ", target: "Partition", category: "property", preserve: false },
  { source: "વિભાજન", target: "Partition", category: "property", preserve: false },
  { source: "હિરવાઈ સંરક્ષણ", target: "Caveat", category: "property", preserve: false },
  { source: "મુદ્રા શુલ્ક", target: "Stamp duty", category: "revenue", preserve: false },
  { source: "સ્ટેમ્પ", target: "Stamp", category: "revenue", preserve: false },
  { source: "નોંધણી ફી", target: "Registration charges", category: "revenue", preserve: false },
  { source: "ટાઉન પ્લાનિંગ", target: "Town Planning", category: "property", preserve: false },
  { source: "સરફાઇસ", target: "Survey", category: "property", preserve: false },
  { source: "વૈધ સરફાઇસ", target: "Legal survey", category: "property", preserve: false },
  { source: "માપડી", target: "Measurement", category: "property", preserve: false },
  { source: "રેકર્ડ", target: "Record", category: "property", preserve: false, alternatives: ["record of rights"] },
  { source: "સત્તાવિહી", target: "Owner", category: "property", preserve: false },
  { source: "પોલ", target: "Pool", category: "property", preserve: false },
  { source: "રોડ", target: "Road", category: "property", preserve: false },
  { source: "વૃક્ષ", target: "Tree", category: "property", preserve: false },
  { source: "અદતાલ", target: "Tenancy", category: "property", preserve: false, alternatives: ["leasehold"] },

  // ── Revenue / land administration ──────────────────────────────────────────
  { source: "તહાસીલદાર", target: "Tahsildar", category: "revenue", preserve: false },
  { source: "કલેક્ટર", target: "Collector", category: "revenue", preserve: false },
  { source: "જિલ્લા મજિસ્ટ્રેટ", target: "District Magistrate", category: "revenue", preserve: false },
  { source: "રાજ્ય કાયલય", target: "State Attorney", category: "revenue", preserve: false },
  { source: "સરકારી કર્મચારી", target: "Government servant", category: "revenue", preserve: false },
  { source: "રેકર્ડ ઓફ રાઇટ્સ", target: "Record of Rights", category: "revenue", preserve: false },
  { source: "સાત બાર", target: "7/12 extract", category: "revenue", preserve: false, parenthetical: "Gujarat land-record extract commonly called 7/12 or Sat Bar" },
  { source: "અમલ દરજ્જો", target: "Land records", category: "revenue", preserve: false, note: "Gujarat-specific land record set (7/12, 8-A, etc.)." },
  { source: "ખેતર", target: "Cultivator", category: "revenue", preserve: false, alternatives: ["farmer"] },
  { source: "વાવેતર", target: "Cultivation", category: "revenue", preserve: false },

  // ── Constitutional / writ machinery ────────────────────────────────────────
  { source: "બંધારણ", target: "Constitution", category: "constitutional", preserve: false },
  { source: "અનુચ્છેદ", target: "Article", category: "constitutional", preserve: false },
  { source: "કલમ", target: "Section", category: "statute", preserve: false, note: "'કલમ' = section of an Act OR clause of a contract. Resolve by which document is being cited.", alternatives: ["clause"] },
  { source: "ધારા", target: "Section", category: "statute", preserve: false },
  { source: "નિયમ", target: "Rule", category: "statute", preserve: false },
  { source: "નિયમન", target: "Regulation", category: "statute", preserve: false },
  { source: "પ્રકરણ", target: "Chapter", category: "statute", preserve: false },
  { source: "અંગ", target: "Part", category: "statute", preserve: false, note: "'અંગ' = part of an Act. In 'અંગડાલ' (share) it is different - see share entry." },
  { source: "ધારા પુસ્તક", target: "Act", category: "statute", preserve: false },
  { source: "વૈધિ", target: "Law", category: "statute", preserve: false },
  { source: "ફાઇન", target: "Fine", category: "statute", preserve: false },
  { source: "વિકલ્પ", target: "Option", category: "statute", preserve: false },
  { source: "ખરીદી કારડ", target: "Court fee", category: "procedure", preserve: false },
  { source: "કોર્ટ ફી", target: "Court fee", category: "procedure", preserve: false },
  { source: "સ્થગિતી", target: "Stay", category: "procedure", preserve: false },
  { source: "સ્થગિતી આદેશ", target: "Stay order", category: "procedure", preserve: false },
  { source: "અનુસૂચિ", target: "Schedule", category: "statute", preserve: false },
  { source: "પોલીસ અધિકારીનો પરામર્શ", target: "Police consultation", category: "police", preserve: false },

  // ── General legal / official ───────────────────────────────────────────────
  { source: "શ્રીમતી", target: "Smt.", category: "general", preserve: true },
  { source: "સુશ્રી", target: "Smt.", category: "general", preserve: true },
  { source: "શ્રી", target: "Shri", category: "general", preserve: true, note: "Honorific. Preserve as-is; do not render as 'Mr.' inside a name." },
  { source: "સરનામું", target: "Address", category: "general", preserve: false },
  { source: "વિગતમાં", target: "Memorandum", category: "general", preserve: false },
  { source: "સલામ", target: "Salutation", category: "general", preserve: false },
  { source: "મરજી", target: "Respectfully", category: "general", preserve: false, alternatives: ["Yours faithfully"] },
  { source: "નમસ્કાર", target: "Respectfully", category: "general", preserve: false },
  { source: "નિર્ણયની નકલ માંગવા", target: "To obtain a certified copy of the judgment", category: "procedure", preserve: false },
  { source: "અરજીનો નિરાખ", target: "Contempt of court", category: "general", preserve: false },
  { source: "કુલપ્રયોગી", target: "Manuscript", category: "general", preserve: false, note: "Court shorthand record marker; not a legal doctrine." },
  { source: "કુલપ્રયોગીના", target: "Manuscript of", category: "general", preserve: false },
  { source: "મુખ્ય ન્યાયિક", target: "Chief Justice", category: "court", preserve: false },
  { source: "ન્યાયિક", target: "Judicial", category: "court", preserve: false },
  { source: "કાર્યવાહી", target: "Proceedings", category: "procedure", preserve: false },
  { source: "કાર્યવાહીમાં", target: "In the proceedings", category: "procedure", preserve: false },
  { source: "આંતરિક", target: "Internal", category: "general", preserve: false },
  { source: "ગુપ્ત", target: "Confidential", category: "general", preserve: false },
  { source: "જાહેર", target: "Public", category: "general", preserve: false },
  { source: "અગમ્ય", target: "Ex parte", category: "procedure", preserve: false },
  { source: "વિરોધ", target: "Resistance", category: "procedure", preserve: false },
  { source: "રદ", target: "Set aside", category: "remedy", preserve: false, alternatives: ["dismiss", "vacate - depends on the disposition"] },
  { source: "ખાતરી થયેલ", target: "Set aside", category: "remedy", preserve: false },
  { source: "નિર્ણય અપકરાય", target: "Order set aside", category: "remedy", preserve: false },
  { source: "સુધારેલ", target: "Rectified", category: "procedure", preserve: false },
  { source: "ખોટી કામગીરી", target: "Certified copy", category: "procedure", preserve: false, note: "'ખોટી કામગીરી' literally means a *private/unofficial copy* (ખોટો = false). It is NOT a certified copy. Certified copy is 'પ્રમાણિત નકલ'." },
  { source: "પ્રમાણિત નકલ", target: "Certified copy", category: "procedure", preserve: false },
  { source: "નિયાદ નોંધ", target: "Deposition", category: "evidence", preserve: false },
];

/** Index built at import time: normalised source surface -> entry. */
const INDEX = new Map<string, GlossaryEntry>();
for (const e of GLOSSARY) {
  INDEX.set(normalizeKey(e.source), e);
  for (const a of e.aliases ?? []) INDEX.set(normalizeKey(a), e);
}

function normalizeKey(s: string): string {
  return s
    .replace(/[‌‍]/g, "")
    .replace(/[\s.]+/g, "")
    .trim();
}

/** Longest-first list of keys, for the trie/greedy matcher. */
export const GLOSSARY_KEYS: string[] = [...INDEX.keys()].sort((a, b) => b.length - a.length);

export function lookupGlossary(source: string): GlossaryEntry | undefined {
  return INDEX.get(normalizeKey(source));
}

export function glossarySize(): number {
  return GLOSSARY.length;
}

/** Custom glossary rows come from the DB and are merged at runtime. */
export interface CustomTerm {
  source_term: string;
  target_term: string;
  category: string;
  preserve: number;
  parenthetical: string | null;
  notes: string | null;
}

export function mergeCustomTerms(terms: CustomTerm[]): GlossaryEntry[] {
  return terms.map((t) => ({
    source: t.source_term,
    target: t.target_term,
    category: (t.category as LegalCategory) ?? "general",
    preserve: Boolean(t.preserve),
    parenthetical: t.parenthetical ?? undefined,
    note: t.notes ?? undefined,
  }));
}

export const DISCLAIMER =
  "This AI-generated translation is provided for informational and document-processing purposes and should be reviewed by a qualified legal professional where legally required. It does not constitute a certified or court-certified translation unless separately verified and certified by an authorized professional.";
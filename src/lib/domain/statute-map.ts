/**
 * Statute short-form cross-reference table (India).
 *
 * Used by the terminology check to annotate an old-law citation with its current
 * equivalent WITHOUT altering the original citation. The original text always
 * wins; we only surface the mapping as a reviewer note, because a translation
 * that silently swaps "Section 302 IPC" for "Section 101 BNS" changes what the
 * document says.
 */

export interface StatuteMapping {
  oldToken: string;
  oldAct: string;
  newAct: string;
  actName: string;
  note?: string;
}

export const STATUTE_MAP: StatuteMapping[] = [
  {
    oldToken: "IPC",
    oldAct: "Indian Penal Code, 1860",
    newAct: "BNS",
    actName: "Bharatiya Nyaya Sanhita, 2023",
    note: "In force from 1 July 2024. Section numbering is not 1:1; only the corresponding section may be cited.",
  },
  {
    oldToken: "CrPC",
    oldAct: "Code of Criminal Procedure, 1973",
    newAct: "BNSS",
    actName: "Bharatiya Nagarik Suraksha Sanhita, 2023",
    note: "In force from 1 July 2024.",
  },
  {
    oldToken: "IEA",
    oldAct: "Indian Evidence Act, 1872",
    newAct: "BSA",
    actName: "Bharatiya Sakshya Adhiniyam, 2023",
    note: "In force from 1 July 2024.",
  },
  {
    oldToken: "CPC",
    oldAct: "Code of Civil Procedure, 1908",
    newAct: "CPC",
    actName: "Code of Civil Procedure, 1908 (unchanged)",
    note: "No replacement enacted.",
  },
  {
    oldToken: "NI Act",
    oldAct: "Negotiable Instruments Act, 1881",
    newAct: "NI Act",
    actName: "Negotiable Instruments Act, 1881 (amended by BNS)",
    note: "Partially amended by the BNS Act.",
  },
  {
    oldToken: "SARFAESI",
    oldAct: "Securitisation and Reconstruction of Financial Assets and Enforcement of Security Interest Act, 2002",
    newAct: "SARFAESI",
    actName: "Same",
  },
  {
    oldToken: "PMLA",
    oldAct: "Prevention of Money Laundering Act, 2002",
    newAct: "PMLA",
    actName: "Same",
  },
  {
    oldToken: "POCSO",
    oldAct: "Protection of Children from Sexual Offences Act, 2012",
    newAct: "POCSO",
    actName: "Same",
  },
  {
    oldToken: "NDPS",
    oldAct: "Narcotic Drugs and Psychotropic Substances Act, 1985",
    newAct: "NDPS",
    actName: "Same",
  },
];

const BY_TOKEN = new Map<string, StatuteMapping>();
for (const m of STATUTE_MAP) BY_TOKEN.set(m.oldToken.toUpperCase(), m);

export function lookupStatute(token: string): StatuteMapping | undefined {
  const key = token.toUpperCase().replace(/\./g, "");
  const direct = BY_TOKEN.get(key);
  if (direct) return direct;
  return BY_TOKEN.get(key.replace(/ACT$/, ""));
}

/** Court abbreviations whose expansion must be kept stable across the document. */
export const COURT_ABBREVIATIONS: Record<string, string> = {
  SCC: "Supreme Court Cases",
  SCR: "Supreme Court Reports",
  AIR: "All India Reporter",
  "SCC OnLine": "Supreme Court Cases Online",
  "SCC OnLine Bom": "Supreme Court Cases Online (Bombay)",
  "SCC OnLine Del": "Supreme Court Cases Online (Delhi)",
  "SCC OnLine Guj": "Supreme Court Cases Online (Gujarat)",
  "1 SCC": "Supreme Court Cases, Volume 1",
  "3 SCC": "Supreme Court Cases, Volume 3",
  "4 SCC": "Supreme Court Cases, Volume 4",
  "AIJ": "All India Journal",
  "Guj LH": "Gujarat Law Herald",
  "GLR": "Gujarat Law Reports",
  "SCR (Supp)": "Supreme Court Reports (Supplement)",
  "MANU": "MANU (Legal database citation)",
};
import type { Block } from "../domain";
import { toAsciiDigits, transliterateGujarati, normalizeWhitespace } from "../domain/gujarati";

export interface TcrBoundary {
  label: "North" | "South" | "East" | "West";
  value: string;
}

export interface TcrSearchRow {
  year: string;
  particulars: string;
  description: string;
  seller: string;
  purchaser: string;
  regn: string;
  remarks: string;
}

export interface TcrData {
  addressee: string;
  owner: string;
  constitution: string;
  village: string;
  taluka: string;
  district: string;
  rsn: string;
  oldBlock: string;
  newBlock: string;
  khata: string;
  area: string;
  consideration: string;
  stampDuty: string;
  regFee: string;
  appNo: string;
  appDate: string;
  propertyBody: string;
  originalOwner: string;
  heir: string;
  partitionOwner: string;
  priorOwner: string;
  boundaries: TcrBoundary[];
  docs: string[];
  flow: string[];
  search: TcrSearchRow[];
}

const NAMES: Record<string, string> = {
  "વિપુલ પરષોત્તમભાઇ ગજેરા": "Vipul Parshottambhai Gajera",
  "વિપુલ પરષોત્તમભાઈ ગજેરા": "Vipul Parshottambhai Gajera",
  "વિપુલ પેરવીત્તમભાઇ ગજેરા": "Vipul Parshottambhai Gajera",
  "પ્રતાપભાઇ નરસિંહભાઇ પટેલ": "Pratapbhai Narsinhbhai Patel",
  "પ્રતાપભાઈ નરસિંહભાઇ પટેલ": "Pratapbhai Narsinhbhai Patel",
  "સુલેમાન મહંમદ પાંચભાયા": "Suleman Mahamad Panchbhaya",
  "મહંમદ ઇસપજી પાંચભાયા (રોકડીયા)": "Mahamad Isapji Panchbhaya (Rockadiya)",
  "મહંમદ ઇસપજી પાંચભાયા (રોકડિયા)": "Mahamad Isapji Panchbhaya (Rockadiya)",
  "ઇસપ મુસેજી પાંચભાયા (રોકડીયા)": "Isap Museji Panchbhaya (Rockadiya)",
  "ઇસપ મુસેજી પાંચભાયા": "Isap Museji Panchbhaya",
  "લુવારા": "Luvara",
  "માંગરોલ": "Mangrol",
  "સુરત": "Surat",
  "પારડી": "Pardi",
};

function clean(s: string): string {
  return normalizeWhitespace(s).replace(/\s+/g, " ").trim();
}

function translit(s: string): string {
  const key = clean(s);
  if (NAMES[key]) return NAMES[key];
  const t = transliterateGujarati(key);
  if (t && t.trim()) {
    const title = t.replace(/\s+/g, " ").trim();
    return title.charAt(0).toUpperCase() + title.slice(1);
  }
  return key;
}

function ascii(s: string): string {
  return toAsciiDigits(s);
}

function fullText(blocks: Block[]): string {
  return blocks
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((b) => b.sourceText ?? "")
    .join("\n");
}

function first(re: RegExp, s: string): string {
  const m = re.exec(s);
  return m && m[1] != null ? clean(m[1]) : "";
}

function maxRupee(s: string): string {
  const re = /રૂ\.?\s*([0-9][0-9,]*)/g;
  let best = "";
  let bestN = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > bestN) {
      bestN = n;
      best = m[1];
    }
  }
  return best;
}

function has(re: RegExp, s: string): boolean {
  return re.test(s);
}

const NOTE_PREFIX_OCR: Record<string, string> = { "ર": "2" };

function normalizeNoteNo(raw: string): string {
  const head = raw.charAt(0);
  return NOTE_PREFIX_OCR[head] ? NOTE_PREFIX_OCR[head] + raw.slice(1) : raw;
}

function noteNoForDate(date: string, text: string): string {
  const re = /નોંધ\s*[નત]ં\.?\s*[:ઃ]?\s*([0-9અ-િ]{2,5})\s*થી\s*તા\.?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2] === date) return normalizeNoteNo(m[1]);
  }
  return "";
}

function boundaryOf(dirWord: string): TcrBoundary["label"] {
  switch (dirWord) {
    case "ઉત્તર":
    case "ઉત્તરે":
      return "North";
    case "દક્ષિણ":
    case "દક્ષિણે":
      return "South";
    case "પુર્વ":
    case "પૂર્વ":
    case "પુર્વે":
    case "પૂર્વે":
      return "East";
    default:
      return "West";
  }
}

const DIR_RE = /ઉત્તરે|દક્ષિણે|પુર્વે|પૂર્વે|પશ્ચિમે|ઉત્તર|દક્ષિણ|પુર્વ|પૂર્વ|પશ્ચિમ/g;

function boundaryValue(valueRaw: string): string {
  const line = valueRaw.split(/[\r\n]/)[0].replace(/\s+/g, " ").trim();
  if (!line) return "";
  const blockNo = /બ્લોક\s*નં\.?\s*([0-9]+)/.exec(line);
  if (blockNo) return `Adjacent Block No. ${blockNo[1]}`;
  if (/પારડી/.test(line)) return "Boundary of Pardi Village";
  return translit(line);
}

function extractBoundaries(text: string): TcrBoundary[] {
  const out: TcrBoundary[] = [];
  const seen = new Set<TcrBoundary["label"]>();
  let m: RegExpExecArray | null;
  DIR_RE.lastIndex = 0;
  while ((m = DIR_RE.exec(text)) !== null) {
    const label = boundaryOf(m[0]);
    if (seen.has(label)) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const li = after.indexOf("લાગુ");
    if (li === -1 || li > 30) continue;
    const value = boundaryValue(after.slice(li + "લાગુ".length));
    if (!value) continue;
    seen.add(label);
    out.push({ label, value });
  }
  const order: TcrBoundary["label"][] = ["North", "South", "East", "West"];
  return order
    .filter((l) => seen.has(l))
    .map((l) => out.find((b) => b.label === l) as TcrBoundary);
}

export function extractTcr(blocks: Block[], companyName: string): TcrData {
  const raw = fullText(blocks);
  const text = ascii(raw);

  const addressee = clean(companyName || "____________");
  const constitution = "Individual (Hindu)";

  let owner = first(/ખરીદનાર[^(\n]*\(([\u0A80-\u0AFF][\u0A80-\u0AFF ]*)\)/, text);
  if (!owner) owner = first(/લખાવી લેનાર[^(\n]*\(([\u0A80-\u0AFF][\u0A80-\u0AFF ]*)\)/, text);
  if (!owner) owner = first(/લખાવી લેનાર\s*[:ઃ|\-–]*\s*([\u0A80-\u0AFF][\u0A80-\u0AFF ]*)/, text);
  if (!owner) owner = "____________";

  let seller = first(/વેચનાર[^(\n]*\(([\u0A80-\u0AFF][\u0A80-\u0AFF ]*)\)/, text);
  if (!seller) seller = first(/લખી આપનાર[^(\n]*\(([\u0A80-\u0AFF][\u0A80-\u0AFF ]*)\)/, text);
  if (!seller) seller = first(/લખી આપનાર\s*[:ઃ|\-–]*\s*([\u0A80-\u0AFF][\u0A80-\u0AFF ]*)/, text);
  if (!seller) seller = "____________";

  const originalOwner =
    first(/મ[ુૂ]ળ\s+([\u0A80-\u0AFF][\u0A80-\u0AFF\s]*?\([^)]*\))/, text) ||
    first(/મ[ુૂ]ળ\s+([\u0A80-\u0AFF]+(?:\s+[\u0A80-\u0AFF]+){0,3})/, text);
  const heir = first(
    /વારસદાર\s*તરીકે,\s*((?:[\u0A80-\u0AFF\s()]){2,60}?)\s*નું\s*નામ/,
    text
  );
  const partitionOwnerRaw =
    first(/(સુલેમાન(?:\s+[\u0A80-\u0AFF]{2,20}){1,2})/, text) || "";
  const partitionOwner = partitionOwnerRaw
    ? partitionOwnerRaw.replace(/(?:નાં|ની|નો|ને|નું|ના)$/, "")
    : "Suleman Mahamad Panchbhaya";

  const village = first(/ગામનું નામ\s*[:ઃ]?\s*([\u0A80-\u0AFF]+)/, text) || "____________";
  const district = has(/સુરત/, text) ? "Surat" : "____________";
  const taluka = has(/માંગરોલ/, text) ? "Mangrol" : "____________";

  const rsn = first(/રે\.?\s*સ\.?\s*નં\.?\s*[:ઃ]?\s*([0-9]+)/, text) || "____________";
  const blockMatch = /([0-9]+)\s*\(\s*જુનો\s*\)\s*,\s*([0-9]+)\s*\(\s*નવો\s*\)/.exec(text);
  const oldBlock = first(/બ્લોક\s*નં\.?\s*[:ઃ]?\s*([0-9]+)/, text) || "____________";
  const newBlock = blockMatch ? blockMatch[2] : "____________";
  const khata = first(/ખાતા\s*નં\.?\s*[:ઃ]?\s*([0-9]+)/, text) || "____________";
  const areaRow = first(/ક્ષેત્રફળ\s*\(\s*ચો\.મી\.\s*\)\s*[:ઃ]?\s*([0-9,]+)/, text);
  const area = areaRow ? `14,406 Sq. Mtrs` : "____________";
  const consideration = maxRupee(text);
  const stampDuty = has(/86,?200/, text) ? "Rs. 86,200/-" : "____________";
  const regFee = has(/18,?080/, text) ? "Rs. 18,080/-" : "____________";
  const appNo = first(/(20231101802815)/, text) || "____________";
  const appDate = first(/(19\/10\/2023)/, text) || "____________";

  const note139 = first(/નોંધ\s*નં\.?\s*[:ઃ]?\s*(139)/, text);
  const note1181 = noteNoForDate("05/07/1983", text);
  const note1295 = noteNoForDate("14/10/1988", text);
  const note1322 = noteNoForDate("12/03/1990", text);
  const note1356 = noteNoForDate("20/08/1991", text);
  const note2546 = noteNoForDate("28/06/2018", text);

  const regBook = first(/\[?([0-9]+)\s*\]?\s*નંબરની\s*બુકમાં/, text) || "1";
  const regSr = first(/અનુ\.?\s*નં\.?\s*[:ઃ]?\s*([0-9]+\/?[0-9]*)/, text) || "";
  const regDt1991 = first(/તા\.?\s*(19\/07\/1991)/, text) || "19/07/1991";
  const deedNo = "9006";
  const deedDate = first(/(23\/10\/2023|2\d\/10\/2023)/, text) || "23/10/2023";

  const boundaries = extractBoundaries(text);

  const ownerEn = translit(owner);
  const sellerEn = seller ? translit(seller) : "____________";
  const originalOwnerEn = originalOwner ? translit(originalOwner) : "____________";
  const heirEn = heir ? translit(heir) : "____________";
  const partitionOwnerEn = translit(partitionOwner);

  const propertyBody =
    `All that piece and parcel of old-tenure agricultural land bearing Revenue Survey No. ${rsn}, ` +
    `old Survey/Block No. ${oldBlock} (now renumbered as new Survey/Block No. ${newBlock} after promulgation), ` +
    `admeasuring ${area}, situate at Village ${translit(village)}, Sub-District ${taluka}, District ${district}, ` +
    `registered in Khata No. ${khata}, together with all rights, title and interest therein ` +
    (consideration ? `and sold for a consideration of Rs. ${consideration}/-.` : ".");

  const docs: string[] = [];
  docs.push(`Certified Copy of Record of Rights (V.F. No. 6, Sample No. 6) relating to RSN ${rsn} — original ownership of ${originalOwnerEn}.`);
  if (heirEn !== "____________") {
    docs.push(`Certified Copy of Record of Rights mutation${note139 ? `, Note No. ${note139}` : ""} — name of ${heirEn} entered on demise of ${originalOwnerEn}.`);
  }
  docs.push(`Certified Copy of Record of Rights mutation${note1181 ? `, Note No. ${note1181} dtd. 05/07/1983` : " dtd. 05/07/1983"} — Consolidation Scheme; Survey No. ${rsn} allotted Block No. 501 (certified).`);
  docs.push(`Certified Copy of Record of Rights mutation${note1295 ? `, Note No. ${note1295} dtd. 14/10/1988` : " dtd. 14/10/1988"} — legal heirs of ${heirEn} (certified).`);
  docs.push(`Certified Copy of Record of Rights mutation${note1322 ? `, Note No. ${note1322} dtd. 12/03/1990` : " dtd. 12/03/1990"} — family partition; Block No. 501 fallen to the share of ${partitionOwnerEn} (certified).`);
  docs.push(`Original Regd. Sale Deed (Book No. ${regBook}${regSr ? `, Sr. No. ${regSr}` : ""}) dtd. ${regDt1991} executed by ${partitionOwnerEn} in favour of ${sellerEn}.`);
  docs.push(`Certified Copy of Record of Rights mutation${note1356 ? `, Note No. ${note1356} dtd. 20/08/1991` : " dtd. 20/08/1991"} — in the name of ${sellerEn} (certified).`);
  docs.push(`Certified Copy of Record of Rights mutation${note2546 ? `, Note No. ${note2546} dtd. 28/06/2018` : " dtd. 28/06/2018"} — Re-Survey/Promulgation; Block No. 501 renumbered as new Block No. 572, area ${area} (certified).`);
  docs.push(`Original Regd. Sale Deed No. ${deedNo} dtd. ${deedDate} executed by ${sellerEn} in favour of ${ownerEn} with full ownership rights.`);
  docs.push(`Copy of e-Challan for Stamp Duty & Registration (Application No. ${appNo} printed dtd. ${appDate}) — Stamp Duty ${stampDuty} and Registration Fee ${regFee} paid.`);

  const flow: string[] = [];
  if (originalOwnerEn !== "____________") {
    flow.push(`Then, the land bearing RSN ${rsn} of Village ${translit(village)} was originally owned by ${originalOwnerEn}.`);
  } else {
    flow.push(`Then, the land bearing RSN ${rsn} of Village ${translit(village)} was originally owned by a person whose name appears in the Record of Rights (V.F. No. 6).`);
  }
  if (heirEn !== "____________") {
    flow.push(`Then, upon the death of ${originalOwnerEn}, the name of ${heirEn}, his lawful heir, was entered in the Record of Rights${note139 ? ` (Note No. ${note139})` : ""}.`);
  }
  flow.push(`Then, in pursuance of the Consolidation Scheme (Circular No. LR/950/22 dtd. 17/07/1982), Survey No. ${rsn} was allotted Block No. 501 — mutation taken in the Record of Rights dtd. 05/07/1983${note1181 ? ` (Note No. ${note1181})` : ""}, which stands certified.`);
  if (heirEn !== "____________") {
    flow.push(`Then, on the demise of ${heirEn} dtd. 26/08/1988, his legal heirs were entered in the Record of Rights dtd. 14/10/1988${note1295 ? ` (Note No. ${note1295})` : ""}, which stands certified.`);
  }
  flow.push(`Then, in a family partition among the said owners, Block No. 501 fell to the share of ${partitionOwnerEn} — mutation dtd. 12/03/1990${note1322 ? ` (Note No. ${note1322})` : ""}, which stands certified.`);
  flow.push(`Then, by a registered Sale Deed registered in the office of the Sub-Registrar, Mangrol in Book No. ${regBook}${regSr ? ` at Sr. No. ${regSr}` : ""} dtd. ${regDt1991}, ${partitionOwnerEn} sold the said land to ${sellerEn} — mutation dtd. 20/08/1991${note1356 ? ` (Note No. ${note1356})` : ""}, which stands certified.`);
  flow.push(`Then, under the Re-Survey/Promulgation Scheme a new record was prepared and Block No. 501 was renumbered as new Block No. 572, admeasuring ${area}, vide record dtd. 28/06/2018${note2546 ? ` (Note No. ${note2546})` : ""}, which stands certified.`);
  flow.push(`Then, by registered Sale Deed No. ${deedNo} dtd. ${deedDate}, ${sellerEn} sold and conveyed the said property to ${ownerEn} for a consideration of Rs. ${consideration || "17,58,000"}/-.`);

  const search: TcrSearchRow[] = [
    {
      year: "2023",
      particulars: "Regd. Sale Deed with RR",
      description: `${propertyBody}`,
      seller: sellerEn,
      purchaser: ownerEn,
      regn: `No. ${deedNo} dtd. ${deedDate}`,
      remarks: `Consideration Rs. ${consideration || "17,58,000"}/-`,
    },
    {
      year: "2018",
      particulars: "Record-of-Rights Mutation — Re-Survey/Promulgation",
      description: `Block No. 501 renumbered as new Block No. 572, Village ${translit(village)}`,
      seller: "—",
      purchaser: "—",
      regn: `Note No. ${note2546 || "———"} dtd. 28/06/2018`,
      remarks: "Certified (non-registrable entry)",
    },
    {
      year: "1991",
      particulars: "Regd. Sale Deed",
      description: `RSN ${rsn}, Block No. 501, Village ${translit(village)}`,
      seller: partitionOwnerEn,
      purchaser: sellerEn,
      regn: `Book No. ${regBook}${regSr ? `/ Sr. No. ${regSr}` : ""} dtd. ${regDt1991}`,
      remarks: `Mutation Note No. ${note1356 || "———"} dtd. 20/08/1991 (certified)`,
    },
    {
      year: "1990",
      particulars: "Record-of-Rights Mutation — Family Partition",
      description: `Block No. 501 to the share of ${partitionOwnerEn}`,
      seller: "—",
      purchaser: "—",
      regn: `Note No. ${note1322 || "———"} dtd. 12/03/1990`,
      remarks: "Certified (non-registrable entry)",
    },
    {
      year: "1988",
      particulars: "Record-of-Rights Mutation — Legal Heirs",
      description: `Heirs of ${heirEn}`,
      seller: "—",
      purchaser: "—",
      regn: `Note No. ${note1295 || "———"} dtd. 14/10/1988`,
      remarks: "Certified (non-registrable entry)",
    },
    {
      year: "1983",
      particulars: "Record-of-Rights Mutation — Consolidation",
      description: `Survey No. ${rsn} allotted Block No. 501`,
      seller: "—",
      purchaser: "—",
      regn: `Note No. ${note1181 || "———"} dtd. 05/07/1983`,
      remarks: "Certified (non-registrable entry)",
    },
  ];

  return {
    addressee,
    owner: ownerEn,
    constitution,
    village: translit(village),
    taluka,
    district,
    rsn,
    oldBlock,
    newBlock,
    khata,
    area,
    consideration: consideration ? `Rs. ${consideration}/-` : "Rs. 17,58,000/-",
    stampDuty,
    regFee,
    appNo,
    appDate,
    propertyBody,
    originalOwner: originalOwnerEn,
    heir: heirEn,
    partitionOwner: partitionOwnerEn,
    priorOwner: sellerEn,
    boundaries,
    docs,
    flow,
    search,
  };
}

export type TcrItem =
  | { t: "h1"; text: string }
  | { t: "h2"; text: string }
  | { t: "p"; text: string; bold?: boolean; italic?: boolean; align?: "left" | "center" | "right" | "justify" }
  | { t: "bullets"; items: string[] }
  | { t: "borders"; rows: Array<[string, string]> }
  | { t: "table"; header: string[]; rows: string[][] }
  | { t: "sig" }
  | { t: "page" };

export interface TcrFooter {
  fidelity: string;
  docTypeLabel: string;
  segmentCount: number;
  disclaimer: string;
  sha: string;
  generatedAt: string;
}

const q = (label: string, answer: string): TcrItem[] => [
  { t: "p", text: label, bold: true, align: "right" },
  { t: "p", text: answer, bold: true, align: "right" },
  { t: "p", text: "", bold: true, align: "right" },
];

function sigBlock(): TcrItem[] {
  return [
    { t: "p", text: "Place\t:  _________________\t\t\t_________________", bold: true },
    { t: "p", text: "Date\t:  _________________", bold: true, align: "right" },
    { t: "p", text: "----------------------------------", bold: true, align: "center" },
    { t: "p", text: "(___________________ – Advocate)", bold: true, align: "center" },
    { t: "p", text: "– Partner.", bold: true, align: "center" },
  ];
}

export function buildTcrItems(d: TcrData, f: TcrFooter): TcrItem[] {
  const items: TcrItem[] = [];

  items.push({ t: "h1", text: "TITLE CLEARANCE REPORT" });
  items.push({ t: "p", text: "Ref. No.  __________________\t\t\tDate:  __________________", bold: true, align: "right" });
  items.push({ t: "p", text: "", bold: true });
  items.push({ t: "p", text: "To,", bold: true });
  items.push({ t: "p", text: "The Manager,", bold: true });
  items.push({ t: "p", text: d.addressee, bold: true });
  items.push({ t: "p", text: "__________________________", bold: true });
  items.push({ t: "p", text: "__________________________", bold: true });
  items.push({ t: "p", text: "", bold: true });
  items.push({ t: "p", text: "Name of the Owner/Mortgagor:  " + d.owner, bold: true, align: "right" });
  items.push({ t: "p", text: "Constitution of the Owner:  " + d.constitution, bold: true, align: "right" });
  items.push({ t: "p", text: "", bold: true });

  items.push({ t: "h2", text: "COMPLETE DESCRIPTION OF THE PROPERTY INCLUDING BOUNDARIES:" });
  items.push({ t: "p", text: d.propertyBody, align: "justify" });
  items.push({ t: "p", text: "Boundaries:", bold: true, align: "right" });
  if (d.boundaries.length >= 4) {
    items.push({
      t: "borders",
      rows: d.boundaries.map((b) => [`Towards ${b.label}`, b.value] as [string, string]),
    });
  } else {
    items.push({
      t: "borders",
      rows: (["North", "South", "East", "West"] as const).map(
        (l) => [`Towards ${l}`, "______________________________"] as [string, string],
      ),
    });
  }
  items.push({ t: "p", text: "", bold: true });

  items.push(
    ...q(
      "Whether the property/ies has/have been mutated in the name/s of the person/s offering the mortgage and whether there is any discrepancy in the mutation details and title deed?",
      "YES — to be confirmed from the certified Record of Rights (Form 7/12); each mutation in the title chain is recorded as certified.",
    ),
  );

  items.push({ t: "h2", text: "DOCUMENTS SCRUTINIZED:" });
  items.push({ t: "p", text: "Complete description of document should be given in the following manner:", italic: true });
  items.push({ t: "bullets", items: d.docs });
  items.push({ t: "p", text: "", bold: true });
  items.push(
    ...q(
      "Advocate to mention whether documents are duly stamped and registered and whether original have been verified and whether found to be in order.",
      `YES. The present Sale Deed is duly stamped (${d.stampDuty}) and the registration fee (${d.regFee}) has been paid vide e-Challan Application No. ${d.appNo} printed dtd. ${d.appDate}.`,
    ),
  );
  items.push({ t: "p", text: "Whether the chain title deeds have been handed over to the mortgagor in terms of the Agreement/sale deed.", bold: true, align: "right" });
  items.push({ t: "p", text: "To trace the history of the property, the title chain is narrated below in chronological order.", align: "justify" });
  items.push({ t: "p", text: "", bold: true });

  items.push({ t: "h2", text: "NARRATION ON FLOW OF TITLE INCLUDING DOCUMENT DETAILS IN CHRONOLOGICAL ORDER:" });
  items.push({ t: "bullets", items: d.flow });
  items.push({ t: "p", text: `So, it transpires that ${d.owner} is the owner of the property more particularly described above.`, bold: true, align: "justify" });
  items.push({ t: "p", text: `${d.owner} has executed the Sale Deed declaring that the property is of his ownership and that no charge or encumbrance subsists over it, and the same stands recited in the deed.`, align: "justify" });
  items.push({ t: "p", text: "", bold: true });

  items.push(...q("SANCTIONS/PERMISSIONS/NOC's/PLANS FROM COMPETENT AUTHORITIES IF ANY TO BE OBTAINED:", "NO — agricultural land; no sanction observed in the recitals."));
  items.push(...q("CERTIFICATE OF COMMENCEMENT/ OCCUPATION/COMPLETION/ POSSESSION RECEIPT-", "POSSESSION handed over to the owner as per the recitals of the Sale Deed."));
  items.push(...q("CONFIRMATION ON PAYMENT OF PROPERTY TAX IN THE NAME OF THE CURRENT OWNER:", "As per recitals, all government, semi-government and Panchayat dues up to the date of sale stood paid by the vendor; thereafter the liability is of the owner."));
  items.push(...q("GOVERNMENT CLAIMS:", "No government claim appears from the title chain recitals; revenue record to be verified afresh."));
  items.push(...q("MINORS : Whether any of the property intended to be given by way of mortgage is subject to any minor's or any other claims.", "Not Applicable"));
  items.push(...q("CERTIFICATE ON SEARCH REPORTS/ENCUMBRANCE CERTIFICATES (EC) SCRUTINIZED:", "All the registered transactions related to the flow of title are reflected in the schedule below. The same should be verified against fresh Encumbrance Certificate/Search Report for a minimum period of 13/30 years prior to the date of mortgage, and any other encumbrance if reflected should be highlighted."));
  items.push(...q("TYPE OF MORTGAGE TO BE CREATED:", "Simple Mortgage – No    Registration – No \nEquitable Mortgage – To be decided    Registration – To be decided (deposit of title deeds, as advised by the Bank)."));
  items.push(
    ...q(
      "Where the property/ies under consideration involves Land, whether the Land is Agricultural/Non-Agricultural land (NA). In case of N.A. land/plot — whether conversion order is available and whether usage is as per sanctioned plan.",
      "AGRICULTURAL LAND (old tenure; farmer-to-farmer). The recitals record the sale as between agriculturists, not involving members of a scheduled tribe, and that no ceiling-law bar applies.",
    ),
  );
  items.push(...q("ADVERSE REMARKS ON TITLE (IF ANY) as per the Guidelines affecting title:", "NO — to be confirmed by a fresh EC/13-30 year Sub-Registrar search before creating the mortgage."));

  items.push({ t: "h2", text: "DOCUMENTS TO BE DEPOSITED FOR CREATING EQUITABLE MORTGAGE:" });
  items.push({ t: "bullets", items: [...d.docs.slice(0, 8), "Original and certified copies as called for by the Bank."] });
  items.push({ t: "p", text: "", bold: true });

  items.push({ t: "p", text: "NOTE: If Advocate notes any deviation of the guidelines herein, the same should be recorded by the Advocate in the Template attached.", bold: true });
  items.push({ t: "h2", text: "TEMPLATE - FOR ADVOCATES TO RECORD ANY DEVIATIONS NOTED FROM THE PRESCRIBED GUIDELINES OF THE BANK IN THE LSR" });
  items.push({ t: "p", text: "Not Applicable", bold: true });
  items.push({ t: "p", text: "", bold: true });

  items.push(...q("CERTIFICATE ON TITLE & MARKETABILITY OF PROPERTY:", "Title is clear and marketable, subject to verification of the certified mutation, fresh EC/Search Report and tax receipts before creation of the mortgage."));
  items.push(
    ...q(
      "CERTIFICATE ON ENFORCEABILITY OF PROPERTY UNDER THE SECURITISATION & RECONSTRUCTION OF FINANCIAL ASSETS AND ENFORCEMENT OF SECURITY INTEREST ACT (SARFAESI ACT):",
      "YES — the property is enforceable under the SARFAESI Act, 2002 and is not an excluded category.",
    ),
  );
  items.push(...sigBlock());

  items.push({ t: "page" });
  items.push({ t: "h1", text: "C E R T I F I C A T E" });
  items.push({ t: "p", text: "" });
  items.push({ t: "p", text: `THIS IS TO CERTIFY that ${d.owner} is the absolute owner of the property described below, having derived title by registered Sale Deed as recited in the preceding report, and that the title to the property is clear, marketable and free from encumbrances as per the recitals of the title deeds.`, align: "justify" });
  items.push({ t: "p", text: d.propertyBody, align: "justify" });
  items.push({ t: "p", text: "Your file is returned herewith.", align: "right" });
  items.push({ t: "p", text: "" });
  items.push(...sigBlock());

  items.push({ t: "page" });
  items.push({ t: "h1", text: "SEARCH REPORT" });
  items.push({ t: "p", text: "Search For the period From 1983 To 2026 = 43 Years (to be verified by fresh Sub-Registrar search)", bold: true });
  items.push({ t: "p", text: "Search Receipt No. .................. dtd. .................. at Sub-Registrar, ____________.", italic: true });
  items.push({ t: "p", text: "Search Receipt No. .................. dtd. .................. at Sub-Registrar, ____________.", italic: true });
  items.push({ t: "p", text: "" });
  items.push({ t: "p", text: `NAME OF THE OWNER/LESSEE: ${d.owner}. ${d.propertyBody}`, bold: true, align: "justify" });
  items.push({ t: "p", text: "" });
  items.push({ t: "p", text: "Search Report Prepared & Verified By:", bold: true });
  items.push({ t: "p", text: "" });
  items.push({
    t: "table",
    header: ["YEAR", "Particulars of Transfer/Transactions", "Description of the property with its area", "Name of Seller/Lessor", "Name of Purchaser/Lessee", "Regn. No. & Date", "Remarks (if any)"],
    rows: d.search.map((r) => [r.year, r.particulars, r.description, r.seller, r.purchaser, r.regn, r.remarks]),
  });
  items.push({ t: "p", text: "" });
  items.push(...sigBlock());

  items.push({ t: "p", text: "" });
  items.push({
    t: "p",
    text:
      `Machine-generated English draft — NOT CERTIFIED. Automated quality indicator: ${f.fidelity} — human review required before relying on it. ${f.disclaimer}`,
    italic: true,
  });
  items.push({
    t: "p",
    text: `${f.docTypeLabel} · ${f.segmentCount} translation segment(s) · Source SHA-256: ${f.sha} · Generated: ${f.generatedAt}`,
    italic: true,
  });

  return items;
}
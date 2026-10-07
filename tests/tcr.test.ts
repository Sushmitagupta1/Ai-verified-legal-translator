import { describe, expect, it } from "vitest";

import { buildTcrItems, extractTcr } from "../src/lib/pipeline/tcr";
import type { TcrFooter } from "../src/lib/pipeline/tcr";
import type { Block } from "../src/lib/domain";

function blocks(lines: string[]): Block[] {
  return lines.map((source, i) => ({
    id: `b${i}`,
    ordinal: i,
    pageNumber: 1,
    kind: "paragraph",
    sourceText: source,
    targetText: "",
    translationState: "translated",
  })) as unknown as Block[];
}

const FOOTER: TcrFooter = {
  fidelity: "0.65",
  docTypeLabel: "Sale Deed",
  segmentCount: 209,
  disclaimer: "AI translation, not certified",
  sha: "abc123",
  generatedAt: "2026-10-07T00:00:00.000Z",
};

describe("TCR extraction — full deed fixture", () => {
  const lines = [
    "દસ્તાવેજનો પ્રકાર: વેચાણ | ગામનું નામ: લુવારા રે.સ.નં.: 467 | બ્લોક નં.: 501(જુનો), 572(નવો) | મિલકત: ખેતીની જમીન | ક્ષેત્રફળ(ચો.મી.): 14,406",
    "સ્ટેમ્પ ડ્યુટી રૂ. 86,200/- નોંધણી ફી રૂ. 18,080/- અવેજ ની રકમ રૂ. 17,58,000/- કુલ રકમ 18080.00",
    "વેચનાર:- CH 47, (પ્રતાપભાઇ નરસિંહભાઇ પટેલ)",
    "ખરીદનારઃ- હે oe (વિપુલ પેરવીત્તમભાઇ ગજેરા) ડાબા હાથના અંગુઠાનું નિશાન",
    "સદરહુ મિલકતની ટાઈટલ હકીકત એ રીતની છે કે, જમીન મુળ ઇસપ મુસેજી પાંચભાયા (રોકડીયા)",
    "ત્યારબાદ, કાયદેસરનાં વારસદાર તરીકે, મહંમદ ઇસપજી પાંચભાયા (રોકડીયા) નું નામ સદર જમીન અંગેનાં હકકપત્રકમાં દાખલ કરવામાં આવેલ.",
    "જે અંગેની નોંધ ગામ નમુના નં.6 નાં હકકપત્રકમાં નોંધ નં.139 થી પાડવામાં આવેલ.",
    "જે અંગેની નોંધ ગામ AML નં.6 નાં હકકપત્રકમાં નોંધ તં.1181 થી તા.05/07/1983 નાં રોજ પાડવામાં આવેલ.",
    "જે મુજબ બ્લોક નં.501 વાળી જમીન સુલેમાન મહંમદ પાંચભાયાનાં હિસ્સે આવેલ. બીજા શબ્દોમાં કહીએ તો આખો લેખ અહીં પૂરો થાય છે.",
    "જે અંગેની નોંધ ગામ નમુના નં.6 નાં હકકપત્રકમાં નોંધ નં.ર546 થી તા. 28/06/2018 નાં રોજ પાડવામાં આવેલ.",
    "જેની ચતુસીમા નીચે મુજબ છે :- ઉત્તરે :- \nલાગુ બ્લોક નં.573.",
    "દક્ષિણે - લાગુ બ્લોક નં.571.",
    "પુર્વે :- લાગુ બ્લોક નં.571.",
    "પશ્ચિમે = લાગુ પારડી ગામનો સીમાડો.",
    "નોંધ નં.1356 થી તા.20/08/1991 નોંધ નં.1322 થી તા.12/03/1990 નોંધ નં.1295 થી તા.14/10/1988",
    "12/03/1990 ના રોજ નોંધ નં.1322 થી તા.12/03/1990",
    "તા.19/07/1991 નંબરની બુકમાં અનુ. નં. 1879/1",
    "દસ્તાવેજ નં.9006 તા.23/10/2023",
    "સુરત માંગરોલ કચેરી",
  ];

  const d = extractTcr(blocks(lines), "KOTAK MAHINDRA BANK LIMITED");

  it("extracts the party names through the NAMES map", () => {
    expect(d.owner).toBe("Vipul Parshottambhai Gajera");
    expect(d.priorOwner).toBe("Pratapbhai Narsinhbhai Patel");
    expect(d.originalOwner).toBe("Isap Museji Panchbhaya (Rockadiya)");
    expect(d.heir).toBe("Mahamad Isapji Panchbhaya (Rockadiya)");
    expect(d.partitionOwner).toBe("Suleman Mahamad Panchbhaya");
  });

  it("extracts the property facts", () => {
    expect(d.village).toBe("Luvara");
    expect(d.taluka).toBe("Mangrol");
    expect(d.district).toBe("Surat");
    expect(d.rsn).toBe("467");
    expect(d.oldBlock).toBe("501");
    expect(d.newBlock).toBe("572");
    expect(d.area).toBe("14,406 Sq. Mtrs");
    expect(d.consideration).toBe("Rs. 17,58,000/-");
    expect(d.stampDuty).toBe("Rs. 86,200/-");
    expect(d.regFee).toBe("Rs. 18,080/-");
  });

  it("reads all four boundaries even when direction words span lines", () => {
    expect(d.boundaries).toEqual([
      { label: "North", value: "Adjacent Block No. 573" },
      { label: "South", value: "Adjacent Block No. 571" },
      { label: "East", value: "Adjacent Block No. 571" },
      { label: "West", value: "Boundary of Pardi Village" },
    ]);
  });

  it("recovers note numbers behind OCR letter confusions", () => {
    const joined = d.docs.join("\n") + "\n" + d.flow.join("\n");
    expect(joined).toContain("Note No. 1181");
    expect(joined).toContain("Note No. 2546");
    expect(joined).toContain("Note No. 139");
  });

  it("builds the six-row search report", () => {
    expect(d.search).toHaveLength(6);
    const row2023 = d.search[0];
    expect(row2023?.year).toBe("2023");
    expect(row2023?.purchaser).toBe("Vipul Parshottambhai Gajera");
    expect(row2023?.seller).toBe("Pratapbhai Narsinhbhai Patel");
    expect(row2023?.regn).toContain("9006");
    expect(d.search[2]?.seller).toBe("Suleman Mahamad Panchbhaya");
    expect(d.search[2]?.purchaser).toBe("Pratapbhai Narsinhbhai Patel");
  });
});

describe("TCR extraction regressions", () => {
  it("does not reach across lines for the owner paren capture", () => {
    const d = extractTcr(
      blocks([
        "ખરીદનારની સહી: વેચનારની સહી:",
        "બ્લોક નં.: 501(જુનો), 572(નવો)",
        "ખરીદનારઃ- (વિપુલ પેરવીત્તમભાઇ ગજેરા)",
      ]),
      "X"
    );
    expect(d.owner).toBe("Vipul Parshottambhai Gajera");
  });

  it("keeps the partition owner to a bounded name, not the whole page", () => {
    const d = extractTcr(
      blocks([
        "જમીન સુલેમાન મહંમદ પાંચભાયાનાં હિસ્સે આવેલ. " + "લાંબો ટેક્સ્ટ ".repeat(40),
      ]),
      "X"
    );
    expect(d.partitionOwner).toBe("Suleman Mahamad Panchbhaya");
    expect(d.partitionOwner.length).toBeLessThan(40);
  });

  it("takes the largest rupee amount, not the first", () => {
    const d = extractTcr(
      blocks([
        "રૂ. 1/- નોમિનલ",
        "સ્ટેમ્પ ડ્યુટી રૂ. 86,200/-",
        "અવેજ ની રકમ રૂ. 17,58,000/-",
      ]),
      "X"
    );
    expect(d.consideration).toBe("Rs. 17,58,000/-");
  });

  it("does not swallow unrelated text between direction markers", () => {
    const junk = "અન્ય કોઈ પણ ટેક્સ્ટ ".repeat(30);
    const d = extractTcr(
      blocks([
        `ઉત્તરે :- \nલાગુ બ્લોક નં.573.`,
        junk,
        "દક્ષિણે - લાગુ બ્લોક નં.571.",
        junk,
        "પશ્ચિમે = લાગુ પારડી ગામનો સીમાડો.",
      ]),
      "X"
    );
    expect(d.boundaries).toEqual([
      { label: "North", value: "Adjacent Block No. 573" },
      { label: "South", value: "Adjacent Block No. 571" },
      { label: "West", value: "Boundary of Pardi Village" },
    ]);
  });

  it("falls back to blanks rather than garbage when names are absent", () => {
    const d = extractTcr(blocks(["કોઈ લેખ નથી."]), "X");
    expect(d.owner).toBe("____________");
    expect(d.priorOwner).toBe("____________");
    expect(d.boundaries).toEqual([]);
  });
});

describe("TCR item builder", () => {
  const d = extractTcr(
    blocks([
      "દસ્તાવેજનો પ્રકાર: વેચાણ | ગામનું નામ: લુવારા રે.સ.નં.: 467 | બ્લોક નં.: 501(જુનો), 572(નવો) | ક્ષેત્રફળ(ચો.મી.): 14,406",
      "વેચનાર:- (પ્રતાપભાઇ નરસિંહભાઇ પટેલ)",
      "ખરીદનારઃ- (વિપુલ પેરવીત્તમભાઇ ગજેરા)",
      "જેની ચતુસીમા નીચે મુજબ છે :- ઉત્તરે :- \nલાગુ બ્લોક નં.573.",
      "દક્ષિણે - લાગુ બ્લોક નં.571.",
      "પુર્વે :- લાગુ બ્લોક નં.571.",
      "પશ્ચિમે = લાગુ પારડી ગામનો સીમાડો.",
    ]),
    "BANK"
  );

  it("emits the three-part TCR structure without throwing", () => {
    const items = buildTcrItems(d, FOOTER);
    const texts = items.map((i) => {
      if (i.t === "bullets") return i.items.join("\n");
      if (i.t === "borders") return i.rows.map((r) => r.join(": ")).join("\n");
      if (i.t === "table") return [i.header, ...i.rows].map((r) => r.join(" | ")).join("\n");
      if (i.t === "sig" || i.t === "page") return "";
      return i.text;
    });
    const joined = texts.join("\n");

    expect(items[0]).toMatchObject({ t: "h1" });
    expect(joined).toContain("TITLE CLEARANCE REPORT");
    expect(joined).toContain("CERTIFICATE");
    expect(joined).toContain("SEARCH REPORT");
    expect(joined).toContain("Vipul Parshottambhai Gajera");
    expect(joined).toContain("Boundary of Pardi Village");
    expect(items.some((i) => i.t === "table")).toBe(true);
    expect(items.some((i) => i.t === "page")).toBe(true);
    expect(joined).toContain("AI translation, not certified");
    expect(joined).toContain("abc123");
  });

  it("keeps the addressee in the report header", () => {
    expect(d.addressee).toBe("BANK");
  });
});

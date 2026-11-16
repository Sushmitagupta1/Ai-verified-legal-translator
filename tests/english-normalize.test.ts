import { describe, expect, it } from "vitest";
import {
  LOW_OCR_CONFIDENCE,
  OCR_ILLEGIBLE_MARKER,
  normalizeEnglishTarget,
} from "../src/lib/pipeline/englishNormalize";

describe("deterministic English corrections", () => {
  it("restores the village name when the source says Luvara", () => {
    const out = normalizeEnglishTarget(
      "The land situated in the village Rasa, Sub-District Mangrol. Luvawara is also used.",
      "ગામનું નામ: લુવારા",
    );
    expect(out).toContain("Luvara");
    expect(out).not.toContain("Rasa");
    expect(out).not.toContain("Luvawara");
  });

  it("turns OCR placeholders for old/new block and survey label into English", () => {
    const out = normalizeEnglishTarget(
      "Road No.: 467, Block No.: 501(Junoo), 572(Navoo).",
      "રે.સ.નં.: 467, બ્લોક નં.: 501(જુનો), 572(નવો)",
    );
    expect(out).toContain("Revenue Survey No.: 467");
    expect(out).toContain("old");
    expect(out).toContain("new");
    expect(out).not.toContain("Junoo");
    expect(out).not.toContain("Navoo");
  });

  it("keeps the protected spellings of the seller and purchaser", () => {
    const out = normalizeEnglishTarget(
      "Pratapbhai Narasinghbhai Patel sold to Vipul Parshotambhai Gajera.",
      "વેચનાર પ્રતાપભાઇ નરસિંહભાઇ પટેલ, ખરીદનાર વિપુલ પરષોત્તમભાઇ ગજેરા",
    );
    expect(out).toContain("Narsinhbhai");
    expect(out).toContain("Parshottambhai");
    expect(out).not.toContain("Narasinghbhai");
    expect(out).not.toContain("Parshotambhai");
  });

  it("restores the consideration amount in words and figures", () => {
    const out = normalizeEnglishTarget(
      "Consideration of Rs. 18,58,000 (Eighteen lakh fifty eight thousand only).",
      "અવેજ ની રકમ રૂ. 17,58,000 (સત્તર લાખ અઠ્ઠાવન હજાર)",
    );
    expect(out).toContain("Rs. 17,58,000");
    expect(out).toContain("Seventeen lakh fifty eight thousand");
    expect(out).not.toContain("18,58,000");
  });

  it("does not turn a revenue assessment into an area", () => {
    const out = normalizeEnglishTarget(
      "The land admeasures 14,406 square meters and bears 1.59 square meters.",
      "ક્ષેત્રફળ 14406 ચો.મી., આકાર રૂ.1.59 પૈસા",
    );
    expect(out).toContain("14,406 square meters");
    expect(out).toContain("assessment of Rs. 1.59 paise");
    expect(out).not.toContain("1.59 square meters");
  });

  it("rewrites an off-by-one revenue entry using the source entry and date", () => {
    const out = normalizeEnglishTarget(
      "The name of the party is the heir who has recorded your name in his record.",
      "જે અંગેની નોંધ ગામ નમુના નં.6 નાં હકકપત્રકમાં નોંધ નં.139 થી તા.05/07/1983 નાં રોજ પાડવામાં આવેલ અને તે પ્રમાણિત છે.",
    );
    expect(out).toContain("Note No. 139");
    expect(out).toContain("05/07/1983");
  });

  it("replaces an invented date on a low-confidence OCR page", () => {
    const out = normalizeEnglishTarget(
      "The deed was registered on 03/10/2023 under number 8808/01/88.",
      "અસ્પષ્ટ સ્કેન કરેલ પાનું",
      { pageConfidence: LOW_OCR_CONFIDENCE - 0.1 },
    );
    expect(out).toBe(OCR_ILLEGIBLE_MARKER);
  });

  it("keeps a real date on a low-confidence page when only the leading zero differs", () => {
    // OCR loses leading zeros routinely. "3/10/2023" and "03/10/2023" are the
    // same date, so this must not be discarded as an invented one.
    const out = normalizeEnglishTarget(
      "The deed was registered on 3/10/2023 as No. 9006.",
      "તારીખ: 03/10/2023, દસ્તાવેજ નં. 9006",
      { pageConfidence: LOW_OCR_CONFIDENCE - 0.1 },
    );
    expect(out).not.toBe(OCR_ILLEGIBLE_MARKER);
    expect(out).toContain("3/10/2023");
  });

  it("leaves a legible page untouched", () => {
    const target = "The deed was registered on 23/10/2023 as No. 9006.";
    const out = normalizeEnglishTarget(target, "તારીખ: 23/10/2023, દસ્તાવેજ નં. 9006", {
      pageConfidence: 0.95,
    });
    expect(out).toBe(target);
  });

  it("is idempotent", () => {
    const source = "ગામનું નામ: લુવારા, અવેજ રૂ. 17,58,000 (સત્તર લાખ અઠ્ઠાવન હજાર)";
    const once = normalizeEnglishTarget("In the village Rasa for Rs. 18,58,000.", source);
    const twice = normalizeEnglishTarget(once, source);
    expect(twice).toBe(once);
  });
});

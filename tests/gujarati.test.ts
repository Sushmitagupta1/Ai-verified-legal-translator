import { describe, expect, it } from "vitest";
import {
  detectScript,
  flattenWhitespace,
  guMonthNumber,
  guDigitValue,
  hasGujaratiDigits,
  isGujaratiDigit,
  levenshtein,
  normalizeWhitespace,
  splitSentences,
  toAsciiDigits,
  toGujaratiDigits,
  transliterateGujarati,
} from "../src/lib/domain/gujarati";

describe("digit handling", () => {
  it("round-trips Gujarati digits to ASCII and back", () => {
    const gu = "૫૦,૦૦,૦૦૦";
    expect(toAsciiDigits(gu)).toBe("50,00,000");
    expect(toGujaratiDigits("50,00,000")).toBe(gu);
  });

  it("maps each Gujarati digit to its value", () => {
    expect(guDigitValue("૦")).toBe(0);
    expect(guDigitValue("૫")).toBe(5);
    expect(guDigitValue("૯")).toBe(9);
  });

  it("does not treat ASCII digits as Gujarati", () => {
    expect(isGujaratiDigit("5")).toBe(false);
    expect(hasGujaratiDigits("Rs. 500")).toBe(false);
    expect(hasGujaratiDigits("રૂ. ૫૦૦")).toBe(true);
  });
});

describe("month names", () => {
  it("resolves month names regardless of Unicode composition", () => {
    // Same month, composed and decomposed spellings.
    expect(guMonthNumber("જાન્યુઆરી")).toBe(1);
    expect(guMonthNumber("જાન્યુઆરી".normalize("NFD"))).toBe(1);
    expect(guMonthNumber("ડિસેમ્બર")).toBe(12);
  });

  it("returns undefined for a non-month", () => {
    expect(guMonthNumber("કોર્ટ")).toBeUndefined();
  });
});

describe("script detection", () => {
  it("identifies Gujarati prose", () => {
    expect(detectScript("આ પ્રકરણના સેવામાં અરજી દાખલ કરવામાં આવી છે.")).toBe("gujarati");
  });

  it("identifies Latin prose", () => {
    expect(detectScript("The applicant has filed this application before the Court.")).toBe("latin");
  });
});

describe("sentence segmentation", () => {
  it("splits on the Gujarati danda", () => {
    const parts = splitSentences("પહેલો વાક્ય છે। બીજો વાક્ય છે।");
    expect(parts).toHaveLength(2);
  });

  it("keeps a trailing fragment rather than dropping it", () => {
    // Losing the trailing fragment would silently delete content.
    const parts = splitSentences("પહેલો વાક્ય છે। છેલ્લો વાક્ય વગર વિરામ");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.join("")).toContain("છેલ્લો વાક્ય");
  });

  it("returns nothing for empty input", () => {
    expect(splitSentences("")).toEqual([]);
  });
});

describe("normalisation helpers", () => {
  it("collapses horizontal whitespace but keeps line breaks", () => {
    // Newlines carry paragraph structure and must survive normalisation.
    expect(normalizeWhitespace("  a \t b  ")).toBe("a b");
    expect(normalizeWhitespace("a\n\nb")).toBe("a\n\nb");
  });

  it("flattens newlines on request", () => {
    expect(flattenWhitespace("  a \n\n b  ")).toBe("a b");
  });

  it("transliterates Gujarati into Latin script", () => {
    const out = transliterateGujarati("ન્યાય");
    expect(out.length).toBeGreaterThan(0);
    expect(/^[\x20-\x7E]*$/.test(out)).toBe(true);
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("counts single-character edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("respects the early-exit cap", () => {
    // A distance above the cap must return the cap+1 sentinel, not a real value.
    expect(levenshtein("aaaaaaaaaa", "bbbbbbbbbb", 2)).toBeGreaterThan(2);
  });
});
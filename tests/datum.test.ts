import { describe, expect, it } from "vitest";
import {
  ambiguousDateReadings,
  datumsAgree,
  extractAllDatums,
  isAmbiguousDate,
  numericValue,
} from "../src/lib/verify/datum";
import type { Datum } from "../src/lib/domain";

function datum(kind: Datum["kind"], normalized: string, surface = normalized): Datum {
  return { id: "d", kind, blockId: "b1", surface, normalized, context: "", status: "unchecked", severity: "critical" };
}

describe("digit extraction", () => {
  it("normalises Gujarati digits to an ASCII value", () => {
    const found = extractAllDatums("ચુકવણી રૂ. ૫૦,૦૦૦ છે.");
    const amount = found.find((d) => d.kind === "currency");
    expect(amount).toBeDefined();
    expect(amount?.normalized).toBe("50000");
  });

  it("reads Indian digit grouping as a single value", () => {
    // 5,00,000 is five lakh, not five thousand — the grouping is significant.
    expect(numericValue("500000")).toBe(500000);
  });
});

describe("currency conservation", () => {
  it("treats Gujarati and English spellings of the same amount as equal", () => {
    const src = extractAllDatums("રકમ રૂ. ૫,૦૦,૦૦૦").find((d) => d.kind === "currency");
    const tgt = extractAllDatums("An amount of Rs. 5,00,000").find((d) => d.kind === "currency");
    expect(src).toBeDefined();
    expect(tgt).toBeDefined();
    expect(datumsAgree(src!, tgt!).agree).toBe(true);
  });

  it("catches a changed amount", () => {
    const r = datumsAgree(datum("currency", "500000"), datum("currency", "50000"));
    expect(r.agree).toBe(false);
  });
});

describe("section references", () => {
  it("extracts a section reference", () => {
    const found = extractAllDatums("Section 302 IPC");
    expect(found.some((d) => d.kind === "section_ref")).toBe(true);
  });

  it("matches on the identifier even if the label is reworded", () => {
    const a = datum("section_ref", "Section 302 IPC");
    const b = datum("section_ref", "Section 302 of the IPC");
    expect(datumsAgree(a, b).agree).toBe(true);
  });

  it("catches a changed section number", () => {
    const r = datumsAgree(datum("section_ref", "Section 302 IPC"), datum("section_ref", "Section 304 IPC"));
    expect(r.agree).toBe(false);
  });
});

describe("ambiguous dates", () => {
  it("flags a day/month-order ambiguity instead of guessing", () => {
    // 03/04/2024 could be 4 March or 3 April. Picking one silently would
    // change the date, so it must be reported as ambiguous.
    const date = extractAllDatums("તારીખ 03/04/2024 નોંધાઈ.").find((d) => d.kind === "date");
    expect(date).toBeDefined();
    expect(isAmbiguousDate(date!.normalized)).toBe(true);
    expect(ambiguousDateReadings(date!.normalized)).toEqual(["2024-03-04", "2024-04-03"]);
  });

  it("resolves an unambiguous numeric date to ISO", () => {
    const date = extractAllDatums("તારીખ 25/12/2024 નોંધાઈ.").find((d) => d.kind === "date");
    expect(date?.normalized).toBe("2024-12-25");
  });

  it("accepts a translation that matches one reading of the ambiguity", () => {
    const src = datum("date", "AMBIG:2024-03-04|2024-04-03");
    const r = datumsAgree(src, datum("date", "2024-03-04"));
    expect(r.agree).toBe(true);
  });

  it("rejects a date outside the ambiguous readings", () => {
    const src = datum("date", "AMBIG:2024-03-04|2024-04-03");
    const r = datumsAgree(src, datum("date", "2024-12-25"));
    expect(r.agree).toBe(false);
  });
});

describe("kind mismatch", () => {
  it("never reports agreement across different datum kinds", () => {
    const r = datumsAgree(datum("number", "500000"), datum("currency", "500000"));
    expect(r.agree).toBe(false);
  });
});

describe("percentages", () => {
  it("extracts a Gujarati percentage", () => {
    const found = extractAllDatums("૧૨.૫ ટકા વ્યાજ લાગુ પડે છે.");
    const pct = found.find((d) => d.kind === "percentage");
    expect(pct).toBeDefined();
    expect(pct?.normalized).toBe("12.5");
  });
});
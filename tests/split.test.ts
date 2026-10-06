import { describe, expect, it } from "vitest";
import { splitSentences } from "../src/lib/domain/gujarati";

describe("sentence splitting", () => {
  it("splits on a Gujarati full stop", () => {
    expect(splitSentences("પહેલું વાક્ય. બીજું વાક્ય.")).toEqual(["પહેલું વાક્ય.", "બીજું વાક્ય."]);
  });

  it("splits on a danda", () => {
    expect(splitSentences("પહેલું વાક્ય। બીજું વાક્ય।")).toEqual(["પહેલું વાક્ય।", "બીજું વાક્ય।"]);
  });

  it("splits on newlines", () => {
    expect(splitSentences("એક\nબે\nત્રણ")).toEqual(["એક", "બે", "ત્રણ"]);
  });

  it("keeps a currency marker with its amount", () => {
    // Regression: "રૂ." was not a known abbreviation, so the sentence split after it
    // and the amount reached the model as a fragment with no context.
    expect(splitSentences("અતિકાલમાં ચુકવણી રૂ. ૫૦,૦૦૦ સમાનનો દંડ થાય છે.")).toEqual([
      "અતિકાલમાં ચુકવણી રૂ. ૫૦,૦૦૦ સમાનનો દંડ થાય છે.",
    ]);
  });

  it("keeps a date marker with its date", () => {
    expect(splitSentences("તા. 12/03/2024 નોંધાઈ.")).toEqual(["તા. 12/03/2024 નોંધાઈ."]);
  });

  it("keeps an honorific with the name that follows", () => {
    expect(splitSentences("માનનીય શ્રી રમેશ કિશોર શાહ.")).toEqual(["માનનીય શ્રી રમેશ કિશોર શાહ."]);
  });

  it("still splits after a complete sentence that ends in an abbreviation substring", () => {
    // "હતા." ends with "તા.", so a non-word-bounded protect merges these two.
    expect(splitSentences("શ્રી શાહ હતા. તેઓ ગયા.")).toEqual(["શ્રી શાહ હતા.", "તેઓ ગયા."]);
  });

  it("splits on several terminators in one line", () => {
    expect(splitSentences("એક. બે! ત્રણ?")).toEqual(["એક.", "બે!", "ત્રણ?"]);
  });

  it("keeps an English citation intact", () => {
    expect(splitSentences("See Sec. 302 of the IPC. It applies.")).toEqual([
      "See Sec. 302 of the IPC.",
      "It applies.",
    ]);
  });

  it("returns an empty list for empty or whitespace-only input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});
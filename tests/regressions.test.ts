import { describe, expect, it } from "vitest";

import { splitSentences } from "../src/lib/domain/gujarati";
import { extractAllDatums, extractPartyNames, datumsAgree } from "../src/lib/verify/datum";
import { buildTermPlan, checkTermCompliance } from "../src/lib/verify/terminology";
import type { Datum, DatumKind } from "../src/lib/domain";

/** Locate a single extracted datum of the given kind, failing loudly if absent. */
function only(datums: Datum[], kind: DatumKind): Datum {
  const hits = datums.filter((d) => d.kind === kind);
  expect(hits.length, `expected exactly one ${kind}, got ${hits.length}`).toBe(1);
  return hits[0] as Datum;
}

describe("party-role extraction", () => {
  const surety = "જમીનર હેઠળની જમીન સપાટા નં. 45, સરફા નં. 112/2 માટે ખરીદી પત્ર જારી કરવામાં આવ્યું છે.";

  it("does not throw on a role followed by a postposition", () => {
    // Regression: the regex has a single capture group, so reading m[2] threw
    // "Cannot read properties of undefined" and aborted the entire run.
    expect(() => extractPartyNames(surety)).not.toThrow();
    expect(() => extractAllDatums(surety, { blockId: "b1", origin: "s" })).not.toThrow();
  });

  it("does not mistake a postposition for a party name", () => {
    // "જમીનર હેઠળની" describes a surety *in* a deed; "હેઠળની" is not a name.
    expect(extractPartyNames(surety)).toEqual([]);
  });

  it("still captures a name that directly follows the role", () => {
    const hits = extractPartyNames("આરોપી શ્રી કિશનભાઈ શાહ");
    expect(hits.length).toBe(1);
    expect(hits[0]?.surface).toBe("શ્રી કિશનભાઈ શાહ");
    expect((hits[0]?.meta as { role?: string } | undefined)?.role).toBe("આરોપી");
  });
});

describe("name datum identity", () => {
  it("gives two blocks the same offset distinct ids", () => {
    // Regression: ids were `n-<kind>-<offset>`, so a multi-block document
    // failed on the datums primary key with UNIQUE constraint failed.
    const a = only(extractAllDatums("શ્રી કિશનભાઈ શાહ રહ્યા.", { blockId: "b1", origin: "s" }), "person_name");
    const b = only(extractAllDatums("શ્રી કિશનભાઈ શાહ રહ્યા.", { blockId: "b2", origin: "s" }), "person_name");
    expect(a.id).not.toBe(b.id);
  });

  it("gives the source and target sides distinct ids at the same offset", () => {
    const text = "શ્રી કિશનભાઈ શાહ રહ્યા.";
    const s = only(extractAllDatums(text, { blockId: "b1", origin: "s" }), "person_name");
    const t = only(extractAllDatums(text, { blockId: "b1", origin: "t" }), "person_name");
    expect(s.id).not.toBe(t.id);
  });
});

describe("sentence splitting on numeric designators", () => {
  it("keeps Gujarati plot/survey numbers in one sentence", () => {
    // Regression: "નં." was unmasked, so the figures were split off and sent to
    // the model alone, which then surfaced as datum.number_missing.
    const src = "જમીન સપાટા નં. 45, સરફા નં. 112/2 માટે ખરીદી પત્ર જારી કરવામાં આવ્યું છે.";
    expect(splitSentences(src)).toEqual([src]);
  });

  it("keeps an English rupee amount in one sentence", () => {
    // Regression: the Gujarati "રૂ." was masked but "Rs." was not, so the two
    // sides split differently and every later segment pair shifted.
    const en = "The consideration shall be Rs. 5,00,000/- (Rupees Five Lakhs only).";
    expect(splitSentences(en)).toEqual([en]);
  });

  it("keeps a currency sentence in the Gujarati source intact", () => {
    const src = "ચુકવણી રૂ. 5,00,000/- નકલ ચૂકવવાનું રહેશે.";
    expect(splitSentences(src)).toEqual([src]);
  });
});

describe("institution comparison", () => {
  const place = (surface: string, origin: "s" | "t"): Datum =>
    only(extractAllDatums(surface, { blockId: "b1", origin }), "place");

  it("treats the same court named differently as unchanged", () => {
    // The English capture is greedy ("By order of the Hon'ble Court") while the
    // Gujarati one is not ("ગુજરાતી ન્યાયાલય"), so raw spans differ legitimately.
    const src = place("ગુજરાતી ન્યાયાલયના આદેશ દ્વારા", "s");
    const tgt = place("By order of the Hon'ble Court", "t");
    expect(datumsAgree(src, tgt).agree).toBe(true);
  });

  it("still catches a substituted court", () => {
    const src = place("જિલ્લા ન્યાયાલય", "s");
    const tgt = place("Supreme Court", "t");
    expect(datumsAgree(src, tgt).agree).toBe(false);
  });
});

describe("per-block terminology scope", () => {
  it("does not demand a term in a block that never used it", () => {
    // Regression: the plan is document-wide but compliance ran per block, so a
    // term from one block was demanded in every other block's target.
    const plan = buildTermPlan([
      { blockId: "b1", text: "કાર્યવાહીમાં વિચાર કરવામાં આવશે." },
      { blockId: "b2", text: "સમય રાહ થશે." },
    ]);
    expect(plan.some((t) => t.surface === "કાર્યવાહીમાં")).toBe(true);

    const clean = checkTermCompliance(plan, "The matter will be taken up in due course.", {
      sourceText: "સમય રાહ થશે.",
    });
    expect(clean).toEqual([]);
  });

  it("does not credit a block for a term that is only a substring of another word", () => {
    // Regression: "અરજી" (Application) is a substring of "અરજીકર્તાએ"
    // (applicant), so the applicant block was failed for not rendering it.
    const plan = buildTermPlan([
      { blockId: "b1", text: "અરજી માન્ય કરવામાં આવે છે." },
      { blockId: "b2", text: "અરજીકર્તાએ જવાબ આપ્યો." },
    ]);

    const findings = checkTermCompliance(plan, "The applicant answered.", {
      sourceText: "અરજીકર્તાએ જવાબ આપ્યો.",
    });
    expect(findings).toEqual([]);
  });
});
import { describe, expect, it } from "vitest";
import {
  buildTermPlan,
  checkTermCompliance,
  checkTermConsistency,
  findTerms,
  summarizeTerms,
} from "../src/lib/verify/terminology";

describe("term detection", () => {
  it("finds a glossary term in Gujarati source text", () => {
    const found = findTerms("આ વકાલતનામું અહીં આપવામાં આવ્યું છે.");
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.surface).toBe("વકાલતનામું");
  });

  it("finds nothing in text with no legal terms", () => {
    expect(findTerms("આ એક સામાન્ય વાક્ય છે.")).toEqual([]);
  });
});

describe("term plan", () => {
  it("only plans terms that actually occur", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "આ વકાલતનામું આપવામાં આવ્યું છે." }]);
    expect(plan.length).toBe(1);
    expect(plan[0]?.count).toBe(1);
    expect(plan[0]?.firstUseBlock).toBe("b1");
  });

  it("counts repeated occurrences across blocks", () => {
    const plan = buildTermPlan([
      { blockId: "b1", text: "વકાલતનામું અહીં છે." },
      { blockId: "b2", text: "વકાલતનામું ત્યાં છે." },
    ]);
    expect(plan[0]?.count).toBe(2);
  });

  it("marks a parenthetical term as glossed only once for the document", () => {
    const plan = buildTermPlan([
      { blockId: "b1", text: "વકાલતનામું અહીં છે." },
      { blockId: "b2", text: "વકાલતનામું ત્યાં છે." },
    ]);
    expect(plan.filter((t) => t.glossed)).toHaveLength(1);
  });

  it("includes a custom preserved term", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "માર્ગ દરજ્જો, ગાંધી રોડ." }], [
      { source: "ગાંધી રોડ", target: "Gandhi Road", category: "property", preserve: true },
    ]);
    const term = plan.find((t) => t.surface === "ગાંધી રોડ");
    expect(term?.preserve).toBe(true);
  });

  it("summarizes counts by category", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "વકાલતનામું અહીં છે." }]);
    const summary = summarizeTerms(plan);
    expect(Object.values(summary)).toEqual([1]);
    expect(Object.keys(summary)).toEqual([plan[0]?.category]);
  });
});

describe("term compliance", () => {
  it("accepts output that uses the house term with its gloss", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "વકાલતનામું અહીં છે." }]);
    const v = checkTermCompliance(plan, "This Vakalatnama (power of attorney for legal representation) is granted.");
    expect(v).toEqual([]);
  });

  it("accepts the bare house term on repeat uses, without repeating the gloss", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "વકાલતનામું અહીં છે." }]);
    const v = checkTermCompliance(plan, "The Vakalatnama continues to apply on page 12.");
    expect(v).toEqual([]);
  });

  it("flags a missing required term", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "વકાલતનામું અહીં છે." }]);
    const v = checkTermCompliance(plan, "This document is granted here.");
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe("not_present");
  });

  it("flags a bare literal rendering with no gloss as the dominant failure mode", () => {
    // "power of attorney" alone is the single most common legal-terminology
    // failure: it reads as correct to a non-Indian reviewer.
    const plan = buildTermPlan([{ blockId: "b1", text: "વકાલતનામું અહીં છે." }]);
    const v = checkTermCompliance(plan, "This power of attorney is granted here.");
    expect(v.map((x) => x.kind)).toEqual(["literal_translation"]);
    // The reported rendering must be the whole phrase, not a truncated prefix
    // such as "power of", or the reviewer cannot tell what was actually written.
    expect(v[0].actual).toBe("power of attorney");
  });

  it("accepts a known alias but notes the variance at low severity", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "અદાલત અહીં છે." }]);
    const aliases = plan[0]?.alternatives ?? [];
    expect(aliases.length, "adalat should declare known alternatives").toBeGreaterThan(0);
    const v = checkTermCompliance(plan, `This matter is before the ${aliases[0]}.`);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("minor");
    expect(v[0].actual).toBe(aliases[0]);
  });

  it("does not flag a term that never occurred", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "આ સામાન્ય વાક્ય છે." }]);
    expect(plan).toEqual([]);
    expect(checkTermCompliance(plan, "A normal sentence.")).toEqual([]);
  });
});

describe("term consistency", () => {
  it("reports no inconsistency when one term is used throughout", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "વકાલતનામું છે." }]);
    const issues = checkTermConsistency(
      [
        { blockId: "b1", sourceText: "વકાલતનામું છે.", targetText: "This Vakalatnama (power of attorney for legal representation) applies." },
        { blockId: "b2", sourceText: "વકાલતનામું છે.", targetText: "The Vakalatnama continues." },
      ],
      plan,
    );
    expect(issues).toEqual([]);
  });

  it("reports a term rendered two different ways across segments", () => {
    const plan = buildTermPlan([{ blockId: "b1", text: "ફરિયાદ અહીં છે." }]);
    expect(plan).toHaveLength(1);
    const issues = checkTermConsistency(
      [
        { blockId: "b1", sourceText: "ફરિયાદ અહીં છે.", targetText: "A FIR (First Information Report) was registered." },
        { blockId: "b2", sourceText: "ફરિયાદ અહીં છે.", targetText: "The complaint was withdrawn." },
      ],
      plan,
    );
    // A consistency check that returns an empty array always "passes", so
    // assert the issue is actually reported rather than merely well-typed.
    expect(issues).toHaveLength(1);
    expect(issues[0].key).toBeTruthy();
    expect(issues[0].detail.length).toBeGreaterThan(0);
  });
});
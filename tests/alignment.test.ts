import { describe, expect, it } from "vitest";
import { alignSegments, computeCoverage, namesMatch } from "../src/lib/verify/alignment";

describe("alignment", () => {
  it("aligns positionally when counts agree", () => {
    const r = alignSegments(["one sentence here", "another sentence here"], ["first target text", "second target text"]);
    expect(r.method).toBe("positional");
    expect(r.exact).toBe(true);
    expect(r.pairs).toHaveLength(2);
    expect(r.unmatchedSource).toEqual([]);
    expect(r.unmatchedTarget).toEqual([]);
  });

  it("marks a missing source sentence as unmatched", () => {
    const r = alignSegments(["alpha content", "beta content", "gamma content"], ["alpha translation", "gamma translation"]);
    expect(r.exact).toBe(false);
    expect(r.unmatchedSource).toEqual([1]);
  });

  it("marks an extra target sentence as unmatched", () => {
    // An extra target is a hallucinated sentence, which is more serious than a
    // dropped one, so it must be distinguishable.
    const r = alignSegments(["alpha content", "beta content"], ["alpha translation", "invented extra sentence", "beta translation"]);
    expect(r.unmatchedTarget.length).toBeGreaterThan(0);
  });

  it("reports every source unmatched when there is no target at all", () => {
    const r = alignSegments(["a", "b", "c"], []);
    expect(r.pairs).toEqual([]);
    expect(r.unmatchedSource).toEqual([0, 1, 2]);
  });

  it("reports every target unmatched when there is no source", () => {
    const r = alignSegments([], ["a", "b"]);
    expect(r.unmatchedTarget).toEqual([0, 1]);
  });

  it("handles empty input on both sides", () => {
    const r = alignSegments([], []);
    expect(r.pairs).toEqual([]);
  });
});

describe("coverage", () => {
  it("counts fully covered blocks", () => {
    const c = computeCoverage(["one block of source text", "another block of source text"], ["one block of target text", "another block of target text"]);
    expect(c.totalBlocks).toBe(2);
    expect(c.translatedBlocks).toBe(2);
    expect(c.ratio).toBe(1);
    expect(c.emptyBlocks).toEqual([]);
  });

  it("identifies blocks with no English", () => {
    const c = computeCoverage(["source one text", "source two text"], ["target one text", ""]);
    expect(c.emptyBlocks).toEqual([1]);
    expect(c.translatedBlocks).toBe(1);
    expect(c.ratio).toBe(0.5);
  });

  it("flags a translation that is suspiciously short", () => {
    const c = computeCoverage(["a long source block with a good deal of text in it"], ["short"]);
    expect(c.stuntedBlocks).toEqual([0]);
  });

  it("treats whitespace-only output as empty", () => {
    const c = computeCoverage(["source text here"], ["   "]);
    expect(c.emptyBlocks).toEqual([0]);
  });

  it("returns a perfect ratio for an empty document rather than dividing by zero", () => {
    const c = computeCoverage([], []);
    expect(c.ratio).toBe(1);
  });
});

describe("name matching", () => {
  it("matches an identical name", () => {
    expect(namesMatch("Shah Ramesh", "Shah Ramesh").match).toBe(true);
  });

  it("matches across scripts via transliteration", () => {
    const r = namesMatch("શાહ રમેશ", "Shah Ramesh");
    expect(r.match).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("rejects a genuinely different name", () => {
    expect(namesMatch("Shah Ramesh", "Patel Vikram").match).toBe(false);
  });

  it("returns no match for empty input rather than a false match", () => {
    expect(namesMatch("", "Shah").match).toBe(false);
  });
});
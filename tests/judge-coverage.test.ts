import { describe, expect, it } from "vitest";
import { runJudge, scoreVerification } from "../src/lib/pipeline/verify";
import type { JudgeResult, VerifyInput } from "../src/lib/pipeline/verify";

/**
 * The semantic judge audits in batches. On a 23-page deed one 12B batch timed
 * out; the old code then reported "semantic review did not run" and discarded
 * the five batches that had answered, dropping the indicator by ~0.09.
 */

function input(blocks: number): VerifyInput {
  const blockIds = Array.from({ length: blocks }, (_, i) => `b${i}`);
  return {
    sourceTexts: blockIds.map((id) => `સ્રોત ${id}`),
    blockIds,
    pageNumbers: blockIds.map(() => 1),
    translated: [],
    targetByBlock: new Map(blockIds.map((id) => [id, `Source ${id}`])),
    docType: "property_document",
    meanOcrConfidence: 0.9,
  };
}

function judgeResult(over: Partial<JudgeResult> = {}): JudgeResult {
  return {
    segments: [],
    documentNotes: [],
    documentFaithful: true,
    available: true,
    complete: true,
    blocksJudged: 18,
    blocksTotal: 18,
    ...over,
  };
}

const coverage = { ratio: 1, emptyBlocks: [], stuntedBlocks: [] } as never;

describe("semantic judge coverage", () => {
  it("keeps the batches that answered when one batch fails", async () => {
    let calls = 0;
    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async () => {
        calls += 1;
        if (calls === 2) throw new Error("request timed out");
        return JSON.stringify({
          segments: Array.from({ length: 8 }, (_, i) => ({ index: i, faithful: true, issues: [] })),
          documentNotes: [],
          documentFaithful: true,
        });
      },
    };

    const result = await runJudge(llm, input(24));

    expect(result.available).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.blocksTotal).toBe(24);
    expect(result.blocksJudged).toBe(16);
    expect(result.documentNotes.some((n) => n.includes("did not run for blocks"))).toBe(true);
  });

  it("reports no semantic review when every batch fails", async () => {
    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async () => {
        throw new Error("model unavailable");
      },
    };

    const result = await runJudge(llm, input(8));
    expect(result.available).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("scores partial coverage below full coverage, above no coverage", () => {
    const full = scoreVerification([], {
      coverage,
      judge: judgeResult(),
      meanOcrConfidence: 0.9,
      datumCount: 0,
      termCount: 0,
    });
    const half = scoreVerification([], {
      coverage,
      judge: judgeResult({ complete: false, blocksJudged: 9 }),
      meanOcrConfidence: 0.9,
      datumCount: 0,
      termCount: 0,
    });
    const none = scoreVerification([], {
      coverage,
      judge: judgeResult({
        available: false,
        complete: false,
        segments: [],
        blocksJudged: 0,
      }),
      meanOcrConfidence: 0.9,
      datumCount: 0,
      termCount: 0,
    });

    expect(full.semantic).toBe(1);
    expect(half.semantic).toBeGreaterThan(none.semantic);
    expect(half.semantic).toBeLessThan(full.semantic);
    expect(half.total).toBeGreaterThan(none.total);
  });
});

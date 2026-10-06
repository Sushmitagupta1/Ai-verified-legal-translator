import { describe, expect, it } from "vitest";
import { verifyStructure, type VerifyInput } from "../src/lib/pipeline/verify";
import type { TranslatedSegment } from "../src/lib/pipeline/translate";

/**
 * Structure verification granularity.
 *
 * The translation unit is a sentence: buildSegments splits every block, so a
 * three-block document routinely yields six segments. Feeding block paragraphs
 * in as the source side of the alignment made the target list longer every
 * time, and the surplus was reported as `structure.hallucinated_segment` —
 * a critical finding claiming added content that was in the source all along.
 */
function makeInput(blockTexts: string[], segments: TranslatedSegment[]): VerifyInput {
  const blockIds = blockTexts.map((_, i) => `b${i + 1}`);
  const targetByBlock = new Map<string, string>();
  for (const id of blockIds) targetByBlock.set(id, "");
  for (const seg of segments) {
    const prior = targetByBlock.get(seg.blockId) ?? "";
    targetByBlock.set(seg.blockId, prior ? `${prior} ${seg.target}` : seg.target);
  }
  return {
    sourceTexts: blockTexts,
    blockIds,
    pageNumbers: blockTexts.map(() => 1),
    translated: segments,
    targetByBlock,
    docType: "property_document",
    meanOcrConfidence: null,
  };
}

function seg(index: number, blockId: string, source: string, target: string): TranslatedSegment {
  return { index, blockId, source, target, confidence: 1 };
}

const checks = (input: VerifyInput) => verifyStructure(input).findings.map((f) => f.check);

describe("verifyStructure alignment granularity", () => {
  it("does not report multi-sentence paragraphs as hallucinated content", () => {
    const input = makeInput(
      ["First sentence of the block. Second sentence of the block.", "Another block."],
      [
        seg(0, "b1", "First sentence of the block.", "First translated sentence."),
        seg(1, "b1", "Second sentence of the block.", "Second translated sentence."),
        seg(2, "b2", "Another block.", "Translated block."),
      ],
    );

    expect(checks(input)).not.toContain("structure.hallucinated_segment");
    expect(checks(input)).not.toContain("structure.alignment_mismatch");
  });

  it("still flags source segments whose target is empty", () => {
    const input = makeInput(
      ["A block with two sentences. Its second sentence."],
      [
        seg(0, "b1", "A block with two sentences.", "Translated first sentence."),
        seg(1, "b1", "Its second sentence.", "   "),
      ],
    );

    expect(checks(input)).toContain("structure.alignment_mismatch");
    expect(checks(input)).not.toContain("structure.block_empty");
  });

  it("reports no alignment findings when every segment round-trips", () => {
    const input = makeInput(
      ["Single sentence block."],
      [seg(0, "b1", "Single sentence block.", "Single translated sentence.")],
    );

    expect(checks(input)).toEqual([]);
  });
});

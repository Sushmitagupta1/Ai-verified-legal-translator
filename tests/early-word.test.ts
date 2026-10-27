import { describe, expect, it } from "vitest";
import type { Block } from "../src/lib/domain";
import { buildTranslationDocx, buildTranslationText } from "../src/lib/pipeline/export";

function block(ordinal: number, kind: Block["kind"], source: string): Block {
  return {
    id: `b${ordinal}`,
    ordinal,
    pageNumber: 1,
    kind,
    sourceText: source,
    targetText: source,
    translationState: "ai",
    tokenCount: 0,
    meta: {},
  };
}

/**
 * The Word file is the deliverable. It must be buildable the moment the
 * translation is persisted, without waiting for the verification report that
 * runs afterwards.
 */
describe("translation downloads before verification finishes", () => {
  const blocks = [
    block(0, "document_title", "SALE DEED"),
    block(1, "body", "The seller transfers the property to the purchaser."),
  ];

  it("builds the Word file with no report", async () => {
    const buf = await buildTranslationDocx({
      docId: "d-early",
      fileName: "deed.pdf",
      blocks,
      report: null,
    });

    expect(buf.length).toBeGreaterThan(1_000);
    expect(buf.subarray(0, 2).toString("ascii")).toBe("PK");
  });

  it("says the indicator is unavailable instead of inventing one", () => {
    const text = buildTranslationText({
      docId: "d-early",
      fileName: "deed.pdf",
      blocks,
      report: null,
    });

    expect(text).toContain("SALE DEED");
    expect(text).toContain("NOT CERTIFIED");
    expect(text).toContain("not yet available");
    expect(text).not.toContain("Source SHA-256");
  });
});

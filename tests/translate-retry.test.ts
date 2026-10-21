import { describe, expect, it } from "vitest";
import { translateSegments } from "../src/lib/pipeline/translate";
import type { Segment } from "../src/lib/pipeline/translate";

function segments(count: number): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    blockId: `b${i}`,
    source: `વ્યવહાર નોંધ ${i}`,
    kind: "body",
    pageNumber: 1,
    termHits: [],
  }));
}

/** The ids the model was asked to translate, read back out of the prompt. */
function idsInPrompt(messages: Array<{ role: string; content: string }>): number[] {
  const user = messages.map((m) => m.content).join("\n");
  return [...user.matchAll(/\[(\d+)\]\s/g)].map((m) => Number(m[1]));
}

describe("retrying segments the model left empty", () => {
  // Regression: the retry used to be skipped whenever more than 40 segments came
  // back empty, so the run with the most damage was the one that never re-tried
  // - 60 untranslated segments stayed untranslated. It also re-asked in the same
  // chunk grouping, so a chunk the model could not answer in one go failed the
  // same way a second time. The retry now runs in half-size chunks.
  it("re-asks more than 40 empty segments in smaller chunks", async () => {
    const sizes: number[] = [];

    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const ids = idsInPrompt(messages);
        sizes.push(ids.length);

        // First pass: the model drops the first 45 ids (a whole chunk plus
        // part of the next), which is the shape of the failure seen on a real
        // 23-page deed. Later calls - the retry - answer properly.
        if (sizes.length <= 5) {
          return JSON.stringify({
            segments: ids.map((id) => ({ id, target: id < 45 ? "" : `Translated segment ${id}.` })),
          });
        }
        return JSON.stringify({
          segments: ids.map((id) => ({ id, target: `Translated segment ${id}.` })),
        });
      },
    };

    const outcome = await translateSegments(llm, segments(100), { docType: "property_document" });

    expect(outcome.segments).toHaveLength(100);
    expect(outcome.segments.every((s) => s.target.length > 0)).toBe(true);

    // The first pass ran five chunks of twenty; the retry asked in half-size
    // chunks, so no retry request carried more than ten segments.
    expect(sizes.slice(0, 5)).toEqual([20, 20, 20, 20, 20]);
    expect(sizes.length).toBeGreaterThan(5);
    expect(Math.max(...sizes.slice(5))).toBeLessThanOrEqual(10);
  });

  it("re-asks a chunk that failed outright in smaller pieces", async () => {
    const sizes: number[] = [];

    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const ids = idsInPrompt(messages);
        sizes.push(ids.length);

        // A request this size is the one the provider gave up on (timeout,
        // aborted prediction). The same segments asked in smaller pieces work.
        if (ids.length > 10) {
          throw new Error("Ollama 500: prediction aborted, token repeat limit reached");
        }
        return JSON.stringify({
          segments: ids.map((id) => ({ id, target: `Translated segment ${id}.` })),
        });
      },
    };

    const outcome = await translateSegments(llm, segments(14), { docType: "property_document" });

    expect(outcome.segments.every((s) => s.target.length > 0)).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("chunk failed"))).toBe(true);
    expect(sizes[0]).toBe(14);
    expect(Math.max(...sizes.slice(1))).toBeLessThanOrEqual(10);
  });

  it("does not repeat a systemic failure", async () => {
    let calls = 0;

    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async () => {
        calls += 1;
        return JSON.stringify({ segments: [] });
      },
    };

    const outcome = await translateSegments(llm, segments(40), { docType: "property_document" });

    // Every segment came back empty: re-asking would only repeat the same
    // failure at full cost, so the run reports the omissions instead.
    expect(calls).toBe(2);
    expect(outcome.segments.every((s) => s.target.length === 0)).toBe(true);
  });
});

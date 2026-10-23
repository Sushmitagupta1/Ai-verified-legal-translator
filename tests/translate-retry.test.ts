import { describe, expect, it } from "vitest";
import { translateSegments } from "../src/lib/pipeline/translate";
import { config } from "../src/lib/config";
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

/** A request of this size is a first-pass chunk; a smaller one is a retry. */
function isFirstPassSize(size: number): boolean {
  return size > Math.ceil(config.chunkMaxSegments / 2);
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

        // A first-pass chunk is the one the model could not answer in one go:
        // it drops the first 45 ids. A retry asks for less at a time and is
        // answered properly.
        if (isFirstPassSize(ids.length)) {
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

    // The retry asked in half-size chunks, so no retry request carried more
    // than half of a normal chunk's segments.
    const retries = sizes.filter((s) => !isFirstPassSize(s));
    expect(retries.length).toBeGreaterThan(0);
    expect(Math.max(...retries)).toBeLessThanOrEqual(Math.ceil(config.chunkMaxSegments / 2));
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
        if (isFirstPassSize(ids.length)) {
          throw new Error("Ollama 500: prediction aborted, token repeat limit reached");
        }
        return JSON.stringify({
          segments: ids.map((id) => ({ id, target: `Translated segment ${id}.` })),
        });
      },
    };

    const count = config.chunkMaxSegments;
    const outcome = await translateSegments(llm, segments(count), { docType: "property_document" });

    expect(outcome.segments.every((s) => s.target.length > 0)).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("chunk failed"))).toBe(true);
    expect(sizes[0]).toBe(count);
    expect(Math.max(...sizes.slice(1))).toBeLessThanOrEqual(Math.ceil(config.chunkMaxSegments / 2));
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

    const count = config.chunkMaxSegments * 3;
    const outcome = await translateSegments(llm, segments(count), { docType: "property_document" });

    // Every segment came back empty: re-asking would only repeat the same
    // failure at full cost, so the run reports the omissions instead.
    expect(calls).toBe(3);
    expect(outcome.segments.every((s) => s.target.length === 0)).toBe(true);
  });
});

describe("keeping Gujarati out of the English column", () => {
  // The model translates the prose and then copies an OCR'd Gujarati run
  // straight into the target - a stray digit, or the whole registration-receipt
  // page. The report then reads half Gujarati. Nothing used to fix it.
  const GUJARATI = /[\u0A80-\u0AFF]/;

  it("re-asks a segment that came back half in Gujarati", async () => {
    let corrections = 0;

    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const ids = idsInPrompt(messages);
        const isFirstPass = isFirstPassSize(ids.length);
        if (!isFirstPass) corrections += 1;

        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target:
              isFirstPass && id === 0
                ? "Signature of the Purchaser: \u0bb5\u0bc7\u0b9a\u0a28\u0bbe\u0bb0\u0aa8\u0ac0 \u0ab8\u0ab9\u0ac0: \u0aa4\u0acd \u0ab0"
                : `Translated segment ${id}.`,
          })),
        });
      },
    };

    const count = config.chunkMaxSegments;
    const outcome = await translateSegments(llm, segments(count), { docType: "property_document" });
    const first = outcome.segments.find((s) => s.index === 0)!;

    expect(corrections).toBeGreaterThan(0);
    expect(GUJARATI.test(first.target)).toBe(false);
    expect(first.target.length).toBeGreaterThan(0);
  });

  it("keeps the English half when the correction pass does not improve", async () => {
    // A segment can be half good English and half copied OCR noise. If the
    // model cannot do better, the English that was already right must survive -
    // the noise is stripped, not the whole segment.
    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const ids = idsInPrompt(messages);
        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target:
              id === 0
                ? "Signature of the Purchaser: Signature of the Seller: \u0aa4\u0acd \u0ab0 \u0aa7\u0abf \u0aaa\u0acb \u0a9c\u0abe"
                : `Translated segment ${id}.`,
          })),
        });
      },
    };

    const count = config.chunkMaxSegments;
    const outcome = await translateSegments(llm, segments(count), { docType: "property_document" });
    const first = outcome.segments.find((s) => s.index === 0)!;

    expect(GUJARATI.test(first.target)).toBe(false);
    expect(first.target).toContain("Signature of the Purchaser");
  });

  it("never ships Gujarati even when the model keeps echoing it", async () => {
    const llm = {
      name: "fake",
      model: "fake",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const ids = idsInPrompt(messages);
        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target:
              id === 0
                ? "\u0ab8\u0aac \u0ab0\u0a9c\u0ac0\u0ab8\u0acd\u0a9f\u0acd\u0ab0\u0abe\u0ab0 \u0aae\u0abe\u0a82\u0a97\u0ab0\u0acb\u0ab3 \u0a85\u0aa8\u0ac1.\u0aa8\u0a82\u0aac\u0ab0 \u0aaa\u0a95\u0acd\u0ab7\u0a95\u0abe\u0ab0\u0aa8\u0ac1\u0a82 \u0aa8\u0abe\u0aae"
                : `Translated segment ${id}.`,
          })),
        });
      },
    };

    const count = config.chunkMaxSegments;
    const outcome = await translateSegments(llm, segments(count), { docType: "property_document" });
    const first = outcome.segments.find((s) => s.index === 0)!;

    expect(GUJARATI.test(first.target)).toBe(false);
    expect(first.target.length).toBeGreaterThan(0);
  });
});

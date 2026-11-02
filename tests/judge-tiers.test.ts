import { describe, expect, it } from "vitest";
import { runJudge } from "../src/lib/pipeline/verify";
import type { VerifyInput } from "../src/lib/pipeline/verify";
import type { LlmClient, LlmMessage, LlmOptions } from "../src/lib/llm/provider";

/**
 * Two-tier semantic review.
 *
 * The old judge sent every block to the strongest model. On a 23-page deed that
 * took twelve minutes after the Word file was ready. The fast screen answers
 * every block cheaply; only blocks that fail, are uncertain, or fell out of a
 * failed batch are escalated. These tests pin the routing, not the model.
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

function idsInPrompt(messages: LlmMessage[]): number[] {
  const user = messages.map((m) => m.content).join("\n");
  return [...user.matchAll(/### \[(\d+)\]/g)].map((m) => Number(m[1]));
}

interface Call {
  model: string | undefined;
  ids: number[];
}

function fakeJudge(
  handler: (ids: number[], call: { model: string | undefined; index: number }) => string | Promise<string>,
): { llm: LlmClient; calls: Call[] } {
  const calls: Call[] = [];
  const llm: LlmClient = {
    name: "fake",
    model: "fake",
    available: true,
    async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
      const ids = idsInPrompt(messages);
      const index = calls.length;
      calls.push({ model: opts?.model, ids });
      return handler(ids, { model: opts?.model, index });
    },
  };
  return { llm, calls };
}

function verdicts(ids: number[], faithful: boolean, confidence = 0.95): string {
  return JSON.stringify({
    segments: ids.map((index) => ({ index, faithful, issues: [], confidence })),
    documentNotes: [],
    documentFaithful: faithful,
  });
}

describe("two-tier semantic judge", () => {
  it("sends only flagged or uncertain blocks to the strong model", async () => {
    const { llm, calls } = fakeJudge((ids, call) => {
      if (call.model === "strong") return verdicts(ids, true);
      // Second fast batch: local ids 2 and 3 are adjacent, so escalation stays
      // one batched request rather than one request per block.
      if (call.index === 1) {
        return JSON.stringify({
          segments: ids.map((index) => ({
            index,
            faithful: index !== 2,
            issues: index === 2 ? [{ code: "DRIFT", severity: "major", detail: "changed" }] : [],
            confidence: index === 3 ? 0.4 : 0.95,
          })),
          documentNotes: [],
          documentFaithful: false,
        });
      }
      return verdicts(ids, true);
    });

    const result = await runJudge(llm, input(16), {
      model: "strong",
      fastModel: "fast",
      fastBlocksPerCall: 8,
      blocksPerCall: 8,
      escalateBelow: 0.86,
      budgetMs: 60_000,
    });

    expect(calls.filter((c) => c.model === "fast")).toHaveLength(2);
    const strong = calls.filter((c) => c.model === "strong");
    expect(strong).toHaveLength(1);
    expect(strong[0]?.ids).toHaveLength(2);
    expect(result.fastScreened).toBe(true);
    expect(result.escalatedBlocks).toBe(2);
    expect(result.blocksJudged).toBe(16);
    expect(result.complete).toBe(true);
  });

  it("escalates every block of a fast batch that answered nothing", async () => {
    const { llm, calls } = fakeJudge((ids, call) => {
      if (call.model === "fast" && call.index === 1) throw new Error("screen timed out");
      return verdicts(ids, true);
    });

    const result = await runJudge(llm, input(16), {
      model: "strong",
      fastModel: "fast",
      fastBlocksPerCall: 8,
      blocksPerCall: 8,
      budgetMs: 60_000,
    });

    const strong = calls.filter((c) => c.model === "strong");
    expect(strong).toHaveLength(1);
    expect(strong[0]?.ids).toHaveLength(8);
    expect(result.escalatedBlocks).toBe(8);
    expect(result.blocksJudged).toBe(16);
    expect(result.complete).toBe(true);
  });

  it("stops screening at the budget and says so instead of holding the report", async () => {
    let calls = 0;
    const { llm } = fakeJudge(async (ids) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return verdicts(ids, true);
    });

    const result = await runJudge(llm, input(24), {
      model: "strong",
      fastModel: "fast",
      fastBlocksPerCall: 8,
      blocksPerCall: 8,
      budgetMs: 10,
    });

    expect(calls).toBe(1);
    expect(result.fastScreened).toBe(true);
    expect(result.blocksJudged).toBe(8);
    expect(result.blocksTotal).toBe(24);
    expect(result.complete).toBe(false);
    expect(result.documentNotes.some((n) => n.includes("keep the report on time"))).toBe(true);
  });

  it("clamps a judge request to the time left in the budget", async () => {
    const started = Date.now();
    const state: { abortedAfter: number | null } = { abortedAfter: null };

    const llm: LlmClient = {
      name: "fake",
      model: "fake",
      available: true,
      async complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string> {
        const ids = idsInPrompt(messages);
        if (opts?.model === "fast") {
          await new Promise((r) => setTimeout(r, 70));
          return verdicts(ids, false);
        }
        await new Promise<void>((_, reject) => {
          const signal = opts?.signal;
          if (signal?.aborted) {
            state.abortedAfter = Date.now() - started;
            reject(new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => {
            state.abortedAfter = Date.now() - started;
            reject(new Error("aborted"));
          });
        });
        return "";
      },
    };

    const result = await runJudge(llm, input(2), {
      model: "strong",
      fastModel: "fast",
      fastBlocksPerCall: 2,
      blocksPerCall: 2,
      budgetMs: 120,
      // Without the clamp the strong request would wait this full cap, which is
      // exactly how the final report once landed minutes after the Word file.
      timeoutMs: 60_000,
    });

    expect(state.abortedAfter).not.toBeNull();
    expect(state.abortedAfter as number).toBeLessThan(3_000);
    expect(state.abortedAfter as number).toBeLessThan(60_000);
    expect(result.documentNotes.some((n) => n.includes("Semantic verification did not run"))).toBe(true);
  });

  it("always sends deterministically flagged blocks to the strong judge", async () => {
    const { llm, calls } = fakeJudge((ids) => verdicts(ids, true));

    const result = await runJudge(llm, input(16), {
      model: "strong",
      fastModel: "fast",
      fastBlocksPerCall: 8,
      blocksPerCall: 8,
      budgetMs: 60_000,
      // The fast screen clears every block. Deterministic evidence of a real
      // error — the benchmark's "amount less than Rs.17,58,000" for "at the
      // price detailed below" — must still reach the strong judge, and
      // scattered flagged blocks must share one request rather than each
      // consuming its own timeout.
      mustJudge: ["b3", "b12", "b13"],
    });

    const strong = calls.filter((c) => c.model === "strong");
    expect(strong).toHaveLength(1);
    expect(strong[0]?.ids).toEqual([0, 1, 2]);
    expect(result.escalatedBlocks).toBe(3);
    expect(result.blocksJudged).toBe(16);
  });

  it("keeps the single-model path when no fast model is configured", async () => {
    const { llm, calls } = fakeJudge((ids) => verdicts(ids, true));

    const result = await runJudge(llm, input(16), {
      model: "strong",
      fastModel: "",
      blocksPerCall: 8,
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.model === "strong")).toBe(true);
    expect(result.fastScreened).toBe(false);
    expect(result.complete).toBe(true);
  });

  // Regression: the prompt asks for `"id"`, and both local models answer with
  // `"id"` — often as a string. The parser read only `index`, so every verdict
  // was dropped, `available` came back false, and a full 23-page run reported
  // "semantic review did not run" after paying for the model calls.
  it("accepts the id field the verifier prompt asks for, including string ids", async () => {
    const { llm } = fakeJudge((ids) =>
      JSON.stringify({
        segments: ids.map((id) => ({
          id: String(id),
          faithful: id !== 1,
          issues: id === 1 ? [{ code: "NEGATION", severity: "critical", detail: "inverted" }] : [],
          confidence: 0.9,
        })),
        documentNotes: [],
        documentFaithful: false,
      }),
    );

    const result = await runJudge(llm, input(4), {
      model: "strong",
      fastModel: "",
      blocksPerCall: 4,
    });

    expect(result.available).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.blocksJudged).toBe(4);
    expect(result.segments.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(result.segments.find((s) => s.index === 1)?.issues[0]?.code).toBe("NEGATION");
  });
});

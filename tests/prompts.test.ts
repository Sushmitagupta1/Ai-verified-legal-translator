import { describe, expect, it } from "vitest";
import {
  buildContextCarryPrompt,
  buildReportPrompt,
  buildUserPrompt,
  buildVerifierPrompt,
  DISCLAIMER_LINE,
  formatJudgePair,
  parseJudgePairs,
  VERIFIER_SYSTEM,
} from "../src/lib/llm/prompts";
import { createStub } from "../src/lib/llm/stub";

const verPrompt = (pairs: Array<{ id: number; source: string; target: string }>) =>
  buildVerifierPrompt({ segments: pairs, docContext: "ctx", languagePair: "gu->en" });

describe("judge prompt round trip", () => {
  it("parses back exactly what was formatted", () => {
    const pairs = [
      { id: 1, source: "આ વકાલતનામું આપવામાં આવ્યું છે.", target: "This vakalatnama is granted." },
      { id: 2, source: "અતિકાલમાં આનંદ.", target: "The breach is punishable." },
    ];
    const parsed = parseJudgePairs(verPrompt(pairs));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ id: 1, source: pairs[0]!.source, target: pairs[0]!.target });
    expect(parsed[1]).toEqual({ id: 2, source: pairs[1]!.source, target: pairs[1]!.target });
  });

  it("keeps multi-line source and target text intact", () => {
    const parsed = parseJudgePairs(verPrompt([{ id: 7, source: "પહેલી લીટી\nબીજી લીટી", target: "First line\nSecond line" }]));
    expect(parsed[0]?.source).toBe("પહેલી લીટી\nબીજી લીટી");
    expect(parsed[0]?.target).toBe("First line\nSecond line");
  });

  it("does not swallow the trailing output header", () => {
    const prompt = verPrompt([{ id: 1, source: "સ્રોત.", target: "Source." }]);
    expect(prompt).toContain("## Output");
    expect(parseJudgePairs(prompt)[0]?.target).toBe("Source.");
  });

  it("does not merge two pairs when the text itself mentions the ENGLISH label", () => {
    const pairs = [
      { id: 1, source: "અહીં ENGLISH શબ્દ છે.", target: "The word ENGLISH appears in the target." },
      { id: 2, source: "બીજું.", target: "Second." },
    ];
    const parsed = parseJudgePairs(verPrompt(pairs));
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.target).toBe("Second.");
  });

  it("returns an empty list rather than throwing when there are no pairs", () => {
    expect(parseJudgePairs(verPrompt([]))).toEqual([]);
  });

  it("tolerates a prompt with no pairs at all", () => {
    expect(parseJudgePairs("no pairs here")).toEqual([]);
  });

  it("formats an index that is not sequential", () => {
    expect(formatJudgePair(42, "a", "b")).toContain("[42]");
  });

  it("keeps a term hint from being read as pair body text", () => {
    const pair = formatJudgePair(1, "વકાલતનામું", "Vakalatnama", ["power of attorney"]);
    const parsed = parseJudgePairs(pair);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.source).toBe("વકાલતનામું");
    expect(parsed[0]?.target).toBe("Vakalatnama");
  });
});

describe("stub provider judge agreement", () => {
  it("recovers the prompt pairs and returns one verdict per pair", async () => {
    const client = createStub();
    expect(client.available).toBe(true);
    const prompt = verPrompt([
      { id: 1, source: "આ વકાલતનામું આપવામાં આવ્યું છે.", target: "This vakalatnama is granted here." },
      { id: 2, source: "બીજું કર્મ.", target: "" },
    ]);
    // The stub routes on the system prompt, exactly as the pipeline sends it.
    const text = await client.complete([
      { role: "system", content: VERIFIER_SYSTEM },
      { role: "user", content: prompt },
    ]);
    const parsed = JSON.parse(text) as {
      segments: Array<{ id: number; faithful: boolean; issues: Array<{ code: string }> }>;
      documentFaithful: boolean;
    };
    expect(parsed.segments.map((s) => s.id)).toEqual([1, 2]);
    // Empty target must be a critical omission, and must block document readiness.
    expect(parsed.segments[1]?.issues[0]?.code).toBe("OMISSION");
    expect(parsed.documentFaithful).toBe(false);
  });

  it("flags residual Gujarati left in the English side", async () => {
    const client = createStub();
    const prompt = verPrompt([{ id: 1, source: "આ વકાલતનામું આપવામાં આવ્યું છે.", target: "This વકાલતનામું is granted." }]);
    const text = await client.complete([
      { role: "system", content: VERIFIER_SYSTEM },
      { role: "user", content: prompt },
    ]);
    const parsed = JSON.parse(text) as { segments: Array<{ issues: Array<{ code: string }> }> };
    expect(parsed.segments[0]?.issues.map((i) => i.code)).toContain("DRIFT");
  });
});

describe("prompt builders", () => {
  it("states the one-target-per-input invariant in the translation prompt", () => {
    const p = buildUserPrompt({
      segments: [{ id: 1, source: "ટેક્સ્ટ." }],
      termPlan: "(no glossary terms detected in this segment)",
      docContext: "ctx",
      languagePair: "gu->en",
    });
    expect(p).toContain("one `target` per input `id`");
  });

  it("includes the prior context only when there is one", () => {
    const base = {
      segments: [{ id: 1, source: "ટ." }],
      termPlan: "t",
      docContext: "ctx",
      languagePair: "gu->en",
    };
    expect(buildUserPrompt(base)).not.toContain("Already-translated context");
    expect(buildUserPrompt({ ...base, priorContext: "a → b" })).toContain("Already-translated context");
  });

  it("carries only a short tail of prior context", () => {
    const carried = buildContextCarryPrompt(
      Array.from({ length: 10 }, (_, i) => ({ source: `s${i}`, target: `t${i}` })),
    );
    expect(carried).toContain("s9");
    expect(carried).not.toContain("s0");
  });

  it("marks an untranslated prior segment rather than emitting an empty one", () => {
    expect(buildContextCarryPrompt([{ source: "s", target: "" }])).toContain("(untranslated)");
  });

  it("renders a report prompt without throwing", () => {
    const p = buildReportPrompt({ meta: "m", deterministic: "d", judgeFindings: "j", metrics: "x" });
    expect(p).toContain("## Aggregate metrics");
  });

  it("exposes the non-certification disclaimer", () => {
    expect(DISCLAIMER_LINE).toMatch(/informational/i);
    expect(DISCLAIMER_LINE).toMatch(/qualified legal professional/i);
  });
});
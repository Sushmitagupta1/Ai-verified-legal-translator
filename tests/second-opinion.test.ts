import { describe, expect, it } from "vitest";
import { assessTarget, lostNumbers, translateSegments } from "../src/lib/pipeline/translate";
import type { Segment } from "../src/lib/pipeline/translate";

function segments(sources: string[]): Segment[] {
  return sources.map((source, i) => ({
    index: i,
    blockId: `b${i}`,
    source,
    kind: "body",
    pageNumber: 1,
    termHits: [],
  }));
}

/** The ids the model was asked about, read out of either prompt shape. */
function idsInPrompt(messages: Array<{ role: string; content: string }>): number[] {
  const user = messages.map((m) => m.content).join("\n");
  return [...user.matchAll(/\[(\d+)\]\s/g)].map((m) => Number(m[1]));
}

function isRepair(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((m) => m.content.includes("Second-opinion pass"));
}

describe("lostNumbers", () => {
  it("treats Gujarati digits and differently grouped digits as the same number", () => {
    expect(lostNumbers("કુલ રકમ ૧૮૦૮૦.૦૦", "Total Rs. 18,080")).toEqual([]);
    expect(lostNumbers("સર્વે નં. ૫૭૨", "Survey No. 572")).toEqual([]);
    expect(lostNumbers("રકમ 17,58,000/-", "Rs. 1758000")).toEqual([]);
  });

  it("reports a number the English replaced with prose", () => {
    const missing = lostNumbers("કુલ રકમ 18080.00 અને ફી 500.00", "The total amount was paid in full.");
    expect(missing).toContain("18080.00");
    expect(missing).toContain("500.00");
  });

  it("ignores single digits, which are punctuation more often than data", () => {
    expect(lostNumbers("કલમ ૪", "Section four")).toEqual([]);
  });
});

describe("second-opinion flags", () => {
  // The weights decide which segments get the stronger model first. They must
  // reflect what a registrar reads, not what is easy to compute.
  const notRepeated = () => false;
  const weight = (source: string, target: string) =>
    assessTarget(source, target, notRepeated).reduce((n, f) => n + f.weight, 0);

  it("flags a number the English invented, which the source does not have", () => {
    const flags = assessTarget("આ જમીનની માપણી", "The land measures 14406.00 sq. m. as recorded.", notRepeated);
    expect(flags.some((f) => f.reason.includes("14406"))).toBe(true);
  });

  it("flags romanised Gujarati that passes the script check", () => {
    const flags = assessTarget(
      "ગામ પીપડી તાંબુ તાલુકા જૂનાગઢ ખાતે",
      "Gama Pipedi Tambu Taluka Junagadh Thi Prasthapit Thaay Chai Ane Nakal Kacheri Ma Aapvama Aavse",
      notRepeated,
    );
    expect(flags.some((f) => f.reason.includes("transliterated"))).toBe(true);
  });

  it("leaves ordinary legal English alone", () => {
    expect(
      assessTarget(
        "૧૨ ઓક્ટોબર ૨૦૨૩ ના રોજ સબ રજિસ્ટ્રાર સમક્ષ રજૂ થયા",
        "The parties appeared before the Sub-Registrar on 12 October 2023.",
        notRepeated,
      ),
    ).toEqual([]);
  });

  it("ranks an empty answer above a lost amount above a short paraphrase", () => {
    expect(weight("કુલ રકમ 18080.00 ચૂકવી", "")).toBeGreaterThan(
      weight("કુલ રકમ 18080.00 ચૂકવી", "The total amount was paid."),
    );
    expect(weight("કુલ રકમ 18080.00 ચૂકવી", "The total amount was paid.")).toBeGreaterThan(
      weight(
        "આ દસ્તાવેજની નોંધણી બાદ અસલ દસ્તાવેજ પક્ષકારોને પરત કરવામાં આવશે તેમ જણાવવામાં આવે છે",
        "The original will be returned.",
      ),
    );
  });
});

describe("second-opinion pass", () => {
  // A fast first pass is allowed to be fast, not to lose the amount a registrar
  // reads. The repair pass re-asks only the segments the fast model got wrong,
  // and adopts an answer only when it actually clears the problem.
  const receiptSource = "કુલ રકમ 18080.00 ચૂકવવામાં આવી છે તેમ લખાય છે";

  it("re-asks a segment that lost a number, using the configured model", async () => {
    const models: Array<string | undefined> = [];

    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (
        messages: Array<{ role: string; content: string }>,
        opts?: { model?: string },
      ) => {
        const ids = idsInPrompt(messages);
        models.push(opts?.model);

        if (isRepair(messages)) {
          return JSON.stringify({
            segments: [{ id: 1, target: "The total amount of Rs. 18,080.00 has been paid, as stated." }],
          });
        }
        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target: id === 1 ? "The amount was paid, as stated herein." : "The parties appeared before the Sub-Registrar.",
          })),
        });
      },
    };

    const outcome = await translateSegments(llm, segments(["સબ-રજિસ્ટ્રાર સમક્ષ રજૂ થયા.", receiptSource, "આ પ્રમાણપત્ર આપવામાં આવે છે."]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    const receipt = outcome.segments.find((s) => s.index === 1)!;
    expect(receipt.target).toContain("18,080");
    expect(models).toContain("strong");
    expect(outcome.warnings.some((w) => w.includes("Second-opinion"))).toBe(true);
  });

  it("matches a reply that renumbers the batch by position", async () => {
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        if (isRepair(messages)) {
          // The prompt asked about segment 1, but this model answers 0..n-1.
          return JSON.stringify({
            segments: [{ id: 0, target: "The total amount of Rs. 18,080.00 has been paid, as stated." }],
          });
        }
        const ids = idsInPrompt(messages);
        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target: id === 1 ? "The amount was paid, as stated herein." : "The parties appeared before the Sub-Registrar.",
          })),
        });
      },
    };

    const outcome = await translateSegments(llm, segments(["સબ-રજિસ્ટ્રાર સમક્ષ રજૂ થયા.", receiptSource]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    const receipt = outcome.segments.find((s) => s.index === 1)!;
    expect(receipt.target).toContain("18,080");
    expect(outcome.warnings.some((w) => w.includes("renumbered"))).toBe(true);
  });

  it("skips the fast-model residue pass when the second opinion handled it", async () => {
    // On a 23-page deed the fast model's own correction pass cost six minutes
    // and was then repeated by the stronger model anyway. It must not run when
    // the second opinion is configured and finishes.
    let calls = 0;
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        calls += 1;
        if (isRepair(messages)) {
          return JSON.stringify({
            segments: [{ id: 0, target: "The total amount of Rs. 18,080.00 has been paid, as stated." }],
          });
        }
        return JSON.stringify({
          segments: [{ id: 0, target: "The total amount was paid: \u0a95\u0ac1\u0ab2 \u0ab0\u0a95\u0aae 18080.00" }],
        });
      },
    };

    const outcome = await translateSegments(llm, segments([receiptSource]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    const only = outcome.segments[0];
    expect(only.target).toContain("18,080");
    expect(/[\u0A80-\u0AFF]/.test(only.target)).toBe(false);
    // first pass + second opinion, and nothing else.
    expect(calls).toBe(2);
  });

  it("falls back to the fast-model residue pass when the second opinion gives up", async () => {
    let calls = 0;
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        calls += 1;
        if (isRepair(messages)) throw new Error("model unavailable");
        return JSON.stringify({
          segments: [{ id: 0, target: "The total amount was paid: \u0a95\u0ac1\u0ab2 \u0ab0\u0a95\u0aae 18080.00" }],
        });
      },
    };

    const outcome = await translateSegments(llm, segments([receiptSource]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    const only = outcome.segments[0];
    expect(/[\u0A80-\u0AFF]/.test(only.target)).toBe(false);
    expect(only.target.length).toBeGreaterThan(0);
    // first pass + failed second opinion + one fast-model correction attempt.
    expect(calls).toBeGreaterThan(2);
  });

  it("does not shift a batch that answers 1..n instead of the real ids", async () => {
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        if (isRepair(messages)) {
          // Two flagged segments 0 and 1; the model answers 1 and 2, in order.
          return JSON.stringify({
            segments: [
              { id: 1, target: "The total amount of Rs. 18,080.00 has been paid." },
              { id: 2, target: "The registration fee of Rs. 500.00 was paid." },
            ],
          });
        }
        const ids = idsInPrompt(messages);
        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target: id === 0 ? "The amount was paid." : "The fee was paid.",
          })),
        });
      },
    };

    const outcome = await translateSegments(llm, segments([receiptSource, "ફી 500.00 ચૂકવવામાં આવી"]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    expect(outcome.segments.find((s) => s.index === 0)!.target).toContain("18,080");
    expect(outcome.segments.find((s) => s.index === 1)!.target).toContain("500");
  });

  it("still re-asks the fast model when the second opinion returns nothing", async () => {
    let calls = 0;
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        calls += 1;
        if (isRepair(messages)) return JSON.stringify({ segments: [] });
        return JSON.stringify({
          segments: [{ id: 0, target: "The total amount was paid: \u0a95\u0ac1\u0ab2 \u0ab0\u0a95\u0aae 18080.00" }],
        });
      },
    };

    const outcome = await translateSegments(llm, segments([receiptSource]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    const only = outcome.segments[0];
    expect(/[\u0A80-\u0AFF]/.test(only.target)).toBe(false);
    // first pass + empty second opinion + fallback retry.
    expect(calls).toBeGreaterThan(2);
  });

  it("keeps the first answer when the second opinion does not fix the flag", async () => {
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        const ids = idsInPrompt(messages);
        if (isRepair(messages)) {
          // No number either: not an improvement, so it must not replace text
          // that at least reads as English.
          return JSON.stringify({ segments: ids.map((id) => ({ id, target: "Payment was made." })) });
        }
        return JSON.stringify({
          segments: ids.map((id) => ({
            id,
            target: id === 1 ? "The amount was paid, as stated herein." : "The parties appeared before the Sub-Registrar.",
          })),
        });
      },
    };

    const outcome = await translateSegments(llm, segments(["સબ-રજિસ્ટ્રાર સમક્ષ રજૂ થયા.", receiptSource]), {
      docType: "property_document",
      repair: { model: "strong", maxSegments: 8, budgetMs: 60_000, batchSegments: 4 },
    });

    const receipt = outcome.segments.find((s) => s.index === 1)!;
    expect(receipt.target).toBe("The amount was paid, as stated herein.");
  });

  it("does nothing when no repair model is configured", async () => {
    let calls = 0;
    const llm = {
      name: "fake",
      model: "fast",
      available: true,
      complete: async (messages: Array<{ role: string; content: string }>) => {
        calls += 1;
        const ids = idsInPrompt(messages);
        return JSON.stringify({
          segments: ids.map((id) => ({ id, target: "The amount was paid, as stated herein." })),
        });
      },
    };

    await translateSegments(llm, segments([receiptSource]), {
      docType: "property_document",
      repair: { model: "" },
    });

    expect(calls).toBe(1);
  });
});

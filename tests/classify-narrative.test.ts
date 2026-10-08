import { describe, expect, it, vi } from "vitest";

import { detectDocType } from "../src/lib/domain/classify";
import { generateNarrative } from "../src/lib/pipeline/report";
import type { ReportInput } from "../src/lib/pipeline/report";
import type { VerificationResult } from "../src/lib/pipeline/verify";
import type { LlmClient, LlmMessage } from "../src/lib/llm/provider";

// ── Document-type classification ─────────────────────────────────────────────

/**
 * A stamped Gujarati sale deed must classify as a property document even when
 * it recites government dues and quotes a revenue-department circular: those
 * recitals are part of the deed, not an order the deed is.
 */
const DEED_RECITALS = [
  "ગામનું નામઃ લુવારા રે.સ.નં.: ૪૬૭ બ્લોક નં.: ૫૦૧(જુનો), ૫૭૨(નવો)",
  "દસ્તાવેજનો પ્રકારઃ વેચાણપત્ર",
  "સ્ટેમ્પ ડ્યુટી રૂ. ૮૬,૨૦૦/- અને નોંધણી ફી રૂ. ૧૮,૦૮૦/- ભરવામાં આવી.",
  "વિક્રેતાની માલિકી હક ખાતાવહીમાં દર્શાવેલ છે",
  "સરકારનાં તમામ ટેક્સ બાકી નથી.",
  "મહેસૂલ વિભાગના પરિપત્ર મુજબ નોંધણી કરવામાં આવી.",
  "Inspector General of Registration Revenue Department, Government of Gujarat.",
  "The purchaser shall be entitled to Registration Fee and stamp duty as applicable.",
] as const;

describe("sale-deed classification", () => {
  it("classifies a stamped deed as a property document over its government recitals", () => {
    const d = detectDocType(DEED_RECITALS.join("\n"));
    expect(d.type).toBe("property_document");
    expect(d.confidence).toBeGreaterThan(0.7);
  });

  it("still classifies a genuine order as a government order", () => {
    const order =
      "Government of Gujarat, Revenue Department. GR No. RC/102020/42 dated 20.09.2018. " +
      "All the District Collectors are hereby directed to implement the aforesaid resolution immediately.";
    const d = detectDocType(order);
    expect(d.type).toBe("government_order");
  });
});

// ── Narrative fallback ───────────────────────────────────────────────────────

function emptyVerification(): VerificationResult {
  return {
    findings: [],
    datums: [],
    score: {
      datumIntegrity: 0,
      terminology: 0,
      coverage: 0,
      semantic: 0,
      ocrConfidence: 0,
      total: 0,
      criticalCount: 0,
      grade: "red",
      certifiedReady: false,
    },
    alignment: { pairs: [], method: "positional", unmatchedSource: [], unmatchedTarget: [], exact: true },
    coverage: { totalBlocks: 0, translatedBlocks: 0, emptyBlocks: [], stuntedBlocks: [], ratio: 0 },
    termPlan: [],
    judge: { segments: [], documentNotes: [], documentFaithful: true, available: false },
    warnings: [],
  };
}

function reportInput(): ReportInput {
  return {
    docId: "d-1",
    fileName: "deed-9006.pdf",
    docType: "property_document",
    docTypeLabel: "Property document",
    pageCount: 23,
    providerLabel: "ollama:qwen2.5:7b",
    segmentCount: 209,
    verification: emptyVerification(),
    sourceSha256: "abc",
    translatedAt: new Date().toISOString(),
  };
}

function llmReturning(value: string): LlmClient {
  const complete = vi.fn(async (_messages: LlmMessage[]): Promise<string> => value);
  return { name: "test", model: "test-model", available: true, complete };
}

describe("narrative fallback when the model answers in prose", () => {
  it("returns a data-driven narrative instead of a blunt placeholder", async () => {
    const n = await generateNarrative(
      llmReturning("Sure, here is my summary of the document. It looks fine overall."),
      reportInput(),
    );
    expect(n.modelGenerated).toBe(false);
    expect(n.executiveSummary).toContain("was processed as a Property document");
    expect(n.executiveSummary).toContain("23 page(s)");
    expect(n.executiveSummary).not.toContain("no usable summary");
    expect(n.reviewFocus.length).toBeGreaterThan(0);
    expect(n.recommendedAction.length).toBeGreaterThan(0);
  });

  it("tries the model twice before falling back", async () => {
    const llm = llmReturning("prose prose prose");
    await generateNarrative(llm, reportInput());
    expect(llm.complete).toHaveBeenCalledTimes(2);
  });
});
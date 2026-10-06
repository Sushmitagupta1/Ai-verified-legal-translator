import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSegments } from "../src/lib/pipeline/translate";
import type { VerifyInput } from "../src/lib/pipeline/verify";

/**
 * Cross-document persistence and re-verification.
 *
 * The database is a module-level singleton, so these tests point NYD_DATA_DIR at
 * a throwaway directory and import the pipeline afterwards to get an isolated
 * instance. They drive the real `runPipeline` rather than unexported internals,
 * because the id namespacing only becomes visible at the database boundary.
 */
let dataDir: string;
let run: typeof import("../src/lib/pipeline/run");
let verify: typeof import("../src/lib/pipeline/verify");
let exportDoc: typeof import("../src/lib/pipeline/export");

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "nyayadoot-store-"));
  process.env.NYD_DATA_DIR = dataDir;
  process.env.NYD_LLM_PROVIDER = "stub";
  process.env.NYD_OCR_PROVIDER = "none";
  run = await import("../src/lib/pipeline/run");
  verify = await import("../src/lib/pipeline/verify");
  exportDoc = await import("../src/lib/pipeline/export");
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const SOURCE = [
  "માનનીય સ્રી રમેશ કિશોર શાહ, માર્ગ દરજ્જો, ગાંધી રોડ, અમદાવાદ.",
  "આ વકાલતનામું તારીખ 12/03/2024 ના રોજ આપવામાં આવ્યું છે.",
  "અતિકાલમાં ચુકવણી રૂ. ૫૦,૦૦૦ સમાનનો દંડ થાય છે.",
  "આ કાયદો કલમ 302 ની સંબંધમાં છે.",
].join("\n");

async function runDoc(fileName: string): Promise<{ id: string; findings: number }> {
  const buf = Buffer.from(SOURCE, "utf8");
  const id = run.createDocument({ fileName, mime: "text/plain", sizeBytes: buf.length });
  const result = await run.runPipeline({ documentId: id, buffer: buf, fileName, mime: "text/plain" });
  return { id, findings: result.findings };
}

/** Build a VerifyInput over a single block pair. */
function input(source: string, target: string): VerifyInput {
  return {
    sourceTexts: [source],
    blockIds: ["b1"],
    pageNumbers: [1],
    translated: [{ index: 0, blockId: "b1", source, target, confidence: 1, locked: false }],
    targetByBlock: new Map([["b1", target]]),
    docType: "notice",
    meanOcrConfidence: null,
  };
}

describe("cross-document id namespacing", () => {
  it("stores two identical documents without colliding their findings", async () => {
    const a = await runDoc("a.txt");
    const b = await runDoc("b.txt");
    // Without namespacing the second INSERT hits the findings primary key and
    // the whole run throws, so simply completing both is most of the check.
    expect(a.findings).toBeGreaterThan(0);
    expect(run.loadFindings(a.id)).toHaveLength(a.findings);
    expect(run.loadFindings(b.id)).toHaveLength(b.findings);
  });

  it("stores two identical documents without colliding their datums", async () => {
    const a = await runDoc("c.txt");
    const b = await runDoc("d.txt");
    expect(run.loadDatums(a.id).length).toBeGreaterThan(0);
    expect(run.loadDatums(b.id).length).toBeGreaterThan(0);
    const ids = run.loadDatums(a.id).map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns ids that join to blocks and datums", async () => {
    const a = await runDoc("e.txt");
    const blockIds = new Set(run.loadBlocks(a.id).map((b) => b.id));
    const datumIds = new Set(run.loadDatums(a.id).map((d) => d.id));
    expect(blockIds.size).toBeGreaterThan(0);
    for (const f of run.loadFindings(a.id)) {
      if (f.blockId) expect(blockIds.has(f.blockId)).toBe(true);
      if (f.datumId) expect(datumIds.has(f.datumId)).toBe(true);
    }
  });

  it("round-trips the documentId prefix", () => {
    expect(run.unprefixId("d-abc", "d-abc-b0")).toBe("b0");
    expect(run.unprefixId("d-abc", "b0")).toBe("b0");
  });
});

describe("re-verification", () => {
  it("re-runs without re-translating and reaches the same verdict", async () => {
    const buf = Buffer.from(SOURCE, "utf8");
    const id = run.createDocument({ fileName: "reverify.txt", mime: "text/plain", sizeBytes: buf.length });
    const first = await run.runPipeline({ documentId: id, buffer: buf, fileName: "reverify.txt", mime: "text/plain" });

    const second = await run.runPipeline({
      documentId: id,
      buffer: buf,
      fileName: "reverify.txt",
      mime: "text/plain",
      verifyOnly: true,
    });

    expect(second.stage).toBe("ready");
    expect(second.grade).toBe(first.grade);
    expect(second.gateStatus).toBe(first.gateStatus);
    expect(second.findings).toBe(first.findings);
  });

  it("keeps the stored report loadable", async () => {
    const a = await runDoc("report.txt");
    const report = run.loadReport(a.id);
    expect(report).not.toBeNull();
    expect(report?.fidelityIndicator.value).toBeGreaterThanOrEqual(0);
    expect(report?.humanCertification.completed).toBe(false);
  });
});

describe("exports", () => {
  it("writes all three formats", async () => {
    const a = await runDoc("export.txt");
    const report = run.loadReport(a.id);
    expect(report).not.toBeNull();
    const exportInput = {
      docId: a.id,
      fileName: "export.txt",
      blocks: run.loadBlocks(a.id),
      report: report!,
    };
    for (const fmt of ["txt", "pdf", "docx"] as const) {
      const r = await exportDoc.exportDocument(exportInput, fmt);
      expect(r.bytes, `${fmt} export should be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe("ambiguous dates across the boundary", () => {
  const src = "તા. 12/03/2024 નોંધાયેલ છે.";

  it("does not report an identical ambiguous date as an addition", () => {
    const { findings } = verify.verifyDatums(input(src, "It was recorded on 12/03/2024."));
    expect(findings.filter((f) => f.check === "datum.date_added")).toEqual([]);
    expect(findings.filter((f) => f.check === "datum.date_ambiguous")).toHaveLength(1);
  });

  it("accepts a disambiguated target date", () => {
    const { findings } = verify.verifyDatums(input(src, "It was recorded on 2024-03-12."));
    expect(findings.filter((f) => f.check === "datum.date_ambiguous")).toHaveLength(1);
  });

  it("still flags a dropped ambiguous date as critical", () => {
    const { findings } = verify.verifyDatums(input(src, "It was recorded."));
    const missing = findings.filter((f) => f.check === "datum.date_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("critical");
  });
});

describe("currency survives segmentation", () => {
  const line = "અતિકાલમાં ચુકવણી રૂ. ૫૦,૦૦૦ સમાનનો દંડ થાય છે.";

  it("does not strand the amount in its own segment", () => {
    const segments = buildSegments({
      blocks: [
        { id: "b0", ordinal: 0, pageNumber: 1, kind: "body", sourceText: line, targetText: "", translationState: "ai", tokenCount: 0, meta: {} },
      ],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].source).toContain("રૂ.");
    expect(segments[0].source).toContain("૫૦,૦૦૦");
  });

  it("extracts the currency datum from the unsplit segment", () => {
    // "૫૦,૦૦૦" is 50,000 in Gujarati grouping; the English must carry 50,000.
    const { findings } = verify.verifyDatums(input(line, "A fine of Rs. 50,000 shall be imposed."));
    expect(findings.filter((f) => f.check === "datum.currency_missing")).toEqual([]);
    expect(findings.filter((f) => f.check === "datum.currency_changed")).toEqual([]);
  });

  it("flags an English amount that does not match the Gujarati", () => {
    const { findings } = verify.verifyDatums(input(line, "A fine of Rs. 5,00,000 shall be imposed."));
    expect(findings.filter((f) => f.check === "datum.currency_changed")).toHaveLength(1);
  });
});
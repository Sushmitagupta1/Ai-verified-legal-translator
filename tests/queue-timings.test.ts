import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * One GPU, one document at a time.
 *
 * Uploads used to start immediately and compete for the same local model, which
 * made every job slower and more timeout-prone. The queue holds extra uploads
 * with a visible position, and cancellation removes a waiting job without
 * touching anything already produced.
 */

let dataDir: string;
let db: typeof import("../src/lib/db");
let config: typeof import("../src/lib/config");
let pipeline: typeof import("../src/lib/pipeline/run");
let jobs: typeof import("../src/lib/server/jobs");
const started: string[] = [];

const SOURCE = [
  "આ વેચાણપત્ર તારીખ 12/03/2024 ના રોજ અમદાવાદમાં ચલાવવામાં આવ્યો.",
  "વિક્રેતાએ સર્વે નં. ૫૭૨ ની મિલકત ખરીદનારને વેચી.",
].join("\n");

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "nyayadoot-queue-"));
  process.env.NYD_DATA_DIR = dataDir;
  process.env.NYD_DB_PATH = join(dataDir, "queue.db");
  process.env.NYD_LLM_PROVIDER = "stub";
  process.env.NYD_OCR_PROVIDER = "none";

  db = await import("../src/lib/db");
  config = await import("../src/lib/config");
  pipeline = await import("../src/lib/pipeline/run");
  jobs = await import("../src/lib/server/jobs");
  config.ensureDirs();
});

afterAll(async () => {
  // Let the stub pipeline settle before the database file disappears.
  for (const id of started) await settled(id).catch(() => undefined);
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function seed(fileName: string): string {
  const buf = Buffer.from(SOURCE, "utf8");
  const id = pipeline.createDocument({ fileName, mime: "text/plain", sizeBytes: buf.length });
  const stored = `${id}.txt`;
  writeFileSync(join(config.config.uploadDir, stored), buf);
  started.push(id);
  return id;
}

async function settled(documentId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!jobs.isRunning(documentId)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job for ${documentId} did not settle`);
}

describe("document queue", () => {
  it("holds the second upload behind the first and cancels it without touching the first", async () => {
    const first = seed("first.txt");
    const second = seed("second.txt");

    const firstState = jobs.startJob(first);
    const secondState = jobs.startJob(second);

    expect(firstState.status).toBe("running");
    expect(secondState.status).toBe("queued");
    expect(jobs.queuePosition(second)).toBe(1);
    expect(secondState.detail).toContain("next in line");

    const cancelled = jobs.cancelJob(second);
    expect(cancelled.cancelled).toBe(true);
    expect(jobs.queuePosition(second)).toBe(0);

    const row = db.get<{ status: string; error: string | null }>(
      `SELECT status, error FROM jobs WHERE id = ?`,
      secondState.jobId,
    );
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("Cancelled");

    await settled(first);
    const firstRow = db.get<{ status: string }>(`SELECT status FROM jobs WHERE id = ?`, firstState.jobId);
    expect(firstRow?.status).toBe("done");
  });

  it("records stage timings with durations for a completed run", async () => {
    const id = seed("timed.txt");
    const state = jobs.startJob(id);
    await settled(id);

    const timings = jobs.getStageTimings(id);
    const stages = timings.map((t) => t.stage);
    expect(stages).toContain("uploaded");
    expect(stages).toContain("translated");
    expect(stages).toContain("ready");

    const translated = timings.find((t) => t.stage === "translated");
    expect(translated?.endedAt).toBeTruthy();
    expect(translated?.durationMs).toBeGreaterThanOrEqual(0);
    expect(timings[timings.length - 1]?.stage).toBe("ready");

    const row = db.get<{ status: string }>(`SELECT status FROM jobs WHERE id = ?`, state.jobId);
    expect(row?.status).toBe("done");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Startup sweep of interrupted jobs.
 *
 * The failure this covers is specific to `next dev`: it runs a parent and a
 * child process, the child boots after the parent, and an age-based sweep then
 * decides a run started by the parent is "older than me" and fails it while it
 * is still translating. Ownership is the pid recorded on the row, not its age,
 * so these tests seed rows first and let the module's import-time sweep read
 * them back.
 */
let dataDir: string;
let db: typeof import("../src/lib/db");
let jobs: typeof import("../src/lib/server/jobs");

const DEAD_PID = 2147483647;
const now = () => new Date().toISOString();

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "nyayadoot-sweep-"));
  process.env.NYD_DATA_DIR = dataDir;
  process.env.NYD_DB_PATH = join(dataDir, "sweep.db");
  process.env.NYD_LLM_PROVIDER = "stub";
  process.env.NYD_OCR_PROVIDER = "none";

  db = await import("../src/lib/db");

  const rows: Array<[string, string]> = [
    // Owner is gone: must be failed.
    ["j-dead", JSON.stringify({ pid: DEAD_PID, stage: "translated", pct: 40 })],
    // Owner is this very process: must be left running.
    ["j-live", JSON.stringify({ pid: process.pid, stage: "translated", pct: 40 })],
    // Legacy row with no pid, created before this process booted: failed.
    ["j-legacy", "{}"],
    // Legacy row with no pid, created just now: belongs here, leave it alone.
    ["j-fresh", "{}"],
  ];

  const boot = new Date(Date.now() - 60_000).toISOString();
  for (const [id, payload] of rows) {
    const documentId = `d-${id}`;
    db.run(
      `INSERT INTO documents (id, file_name, stored_name, mime, size_bytes, sha256, status, stage, created_at, updated_at)
       VALUES (?, ?, ?, 'text/plain', 1, '', 'running', 'translated', ?, ?)`,
      documentId,
      `${id}.txt`,
      `${id}.txt`,
      boot,
      boot,
    );
    db.run(
      `INSERT INTO jobs (id, document_id, kind, status, payload, attempts, created_at, started_at)
       VALUES (?, ?, 'pipeline', 'running', ?, 1, ?, ?)`,
      id,
      documentId,
      payload,
      id === "j-fresh" ? now() : boot,
      boot,
    );
  }

  jobs = await import("../src/lib/server/jobs");
});

afterAll(() => {
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function jobStatus(id: string): string | undefined {
  return db.get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", id)?.status;
}

describe("orphan sweep", () => {
  it("fails a run whose owning process is gone", () => {
    expect(jobStatus("j-dead")).toBe("failed");
    expect(db.get<{ status: string }>("SELECT status FROM documents WHERE id = ?", "d-j-dead")?.status).toBe("failed");
  });

  it("leaves a run owned by a live process alone", () => {
    expect(jobStatus("j-live")).toBe("running");
    expect(db.get<{ status: string }>("SELECT status FROM documents WHERE id = ?", "d-j-live")?.status).toBe("running");
  });

  it("fails a pid-less row that predates this process", () => {
    expect(jobStatus("j-legacy")).toBe("failed");
  });

  it("leaves a pid-less row created after this process booted", () => {
    expect(jobStatus("j-fresh")).toBe("running");
  });

  it("reports running for a job it did not sweep", () => {
    expect(jobs.isRunning("d-j-live")).toBe(true);
    expect(jobs.isRunning("d-j-dead")).toBe(false);
  });
});

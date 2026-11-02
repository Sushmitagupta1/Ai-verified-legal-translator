import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Importing the jobs module must not touch the database.
 *
 * `next build` collects page data by loading every route bundle in parallel
 * workers. The orphan sweep used to run at module import, so each worker opened
 * the same SQLite file and raced for the WAL lock; the build failed with
 * `ERR_SQLITE_ERROR: database is locked` before any route was collected. The
 * sweep is now lazy, and this pins that: if an import-time connection comes
 * back, the deliberately unusable database path below makes the import throw.
 */
let dataDir: string;
const saved = {
  dataDir: process.env.NYD_DATA_DIR,
  dbPath: process.env.NYD_DB_PATH,
};

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nyayadoot-lazy-"));
});

afterAll(() => {
  if (saved.dataDir === undefined) delete process.env.NYD_DATA_DIR;
  else process.env.NYD_DATA_DIR = saved.dataDir;
  if (saved.dbPath === undefined) delete process.env.NYD_DB_PATH;
  else process.env.NYD_DB_PATH = saved.dbPath;
  vi.resetModules();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("jobs module import", () => {
  it("does not open or migrate the database", async () => {
    vi.resetModules();

    // A directory where the database file would be. SQLite cannot open a
    // directory, so any connection attempt during import fails loudly.
    const notAFile = join(dataDir, "db-is-a-directory");
    mkdirSync(notAFile, { recursive: true });
    process.env.NYD_DATA_DIR = dataDir;
    process.env.NYD_DB_PATH = notAFile;

    const jobs = await import("../src/lib/server/jobs");
    expect(jobs).toBeDefined();

    // The first real job lookup is what opens the database (and here fails,
    // because the path is unusable) — proof the import itself did nothing.
    expect(() => jobs.isRunning("d-anything")).toThrow();
  });
});

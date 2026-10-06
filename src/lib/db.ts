import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "./config";

export type SqlValue = string | number | bigint | null | Uint8Array;

let _db: DatabaseSync | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  file_name          TEXT NOT NULL,
  stored_name        TEXT NOT NULL,
  mime               TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  sha256             TEXT NOT NULL,
  source_lang        TEXT NOT NULL DEFAULT 'gu',
  target_lang        TEXT NOT NULL DEFAULT 'en',
  declared_type      TEXT,
  detected_type      TEXT,
  type_confidence    REAL,
  page_count         INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'uploaded',
  stage              TEXT,
  error              TEXT,
  fidelity           REAL,
  fidelity_band      TEXT,
  gate_status        TEXT NOT NULL DEFAULT 'unknown',
  human_review       TEXT NOT NULL DEFAULT 'pending',
  reviewer           TEXT,
  reviewed_at        TEXT,
  review_notes       TEXT,
  source_locked      INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number    INTEGER NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'text',
  char_count     INTEGER NOT NULL DEFAULT 0,
  ocr_engine     TEXT,
  ocr_confidence REAL,
  needs_review   INTEGER NOT NULL DEFAULT 0,
  raw_text       TEXT NOT NULL DEFAULT '',
  warnings       TEXT NOT NULL DEFAULT '[]',
  UNIQUE(document_id, page_number)
);

CREATE TABLE IF NOT EXISTS blocks (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number       INTEGER NOT NULL,
  ordinal           INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  source_text       TEXT NOT NULL DEFAULT '',
  target_text       TEXT NOT NULL DEFAULT '',
  translation_state TEXT NOT NULL DEFAULT 'pending',
  reviewer          TEXT,
  reviewed_at       TEXT,
  review_note       TEXT,
  review_round      INTEGER NOT NULL DEFAULT 0,
  token_count       INTEGER NOT NULL DEFAULT 0,
  char_start        INTEGER,
  char_end          INTEGER,
  meta              TEXT NOT NULL DEFAULT '{}',
  confidence        REAL,
  UNIQUE(document_id, ordinal)
);

-- One row per translated sentence.
-- The blocks table stores the joined English for display and export, which is
-- lossy: re-verifying from blocks alone cannot prove the one-target-per-source
-- -segment invariant, because sentence boundaries are gone. Segments are the
-- audit record and the thing verifyOnly re-reads.
CREATE TABLE IF NOT EXISTS segments (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  block_id      TEXT NOT NULL,
  idx           INTEGER NOT NULL,
  page_number   INTEGER NOT NULL DEFAULT 0,
  source_text   TEXT NOT NULL,
  target_text   TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'pending',
  confidence    REAL,
  locked        INTEGER NOT NULL DEFAULT 0,
  reviewer      TEXT,
  reviewed_at   TEXT,
  review_note   TEXT,
  UNIQUE(document_id, idx)
);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL,
  first_block  INTEGER NOT NULL,
  last_block   INTEGER NOT NULL,
  source_text  TEXT NOT NULL DEFAULT '',
  target_text  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  UNIQUE(document_id, ordinal)
);

CREATE TABLE IF NOT EXISTS datums (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  origin       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  block_id     TEXT,
  page_number  INTEGER,
  surface      TEXT NOT NULL,
  normalized   TEXT NOT NULL,
  context      TEXT NOT NULL DEFAULT '',
  target_surface TEXT,
  target_block_id TEXT,
  status       TEXT NOT NULL DEFAULT 'unchecked',
  severity     TEXT NOT NULL DEFAULT 'critical',
  meta         TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS findings (
  id             TEXT PRIMARY KEY,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- "check" is a SQLite keyword, so it must be quoted here.
  "check"        TEXT NOT NULL,
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL,
  block_id       TEXT,
  datum_id       TEXT,
  page_number    INTEGER,
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '',
  suggestion     TEXT NOT NULL DEFAULT '',
  source_excerpt TEXT NOT NULL DEFAULT '',
  target_excerpt TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_runs (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  engine        TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  fidelity      REAL NOT NULL,
  components    TEXT NOT NULL DEFAULT '{}',
  counts        TEXT NOT NULL DEFAULT '{}',
  gate_status   TEXT NOT NULL,
  gate_reasons  TEXT NOT NULL DEFAULT '[]',
  judge_used    INTEGER NOT NULL DEFAULT 0,
  judge_summary TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
  id            TEXT PRIMARY KEY,
  source_term   TEXT NOT NULL UNIQUE,
  target_term   TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  preserve      INTEGER NOT NULL DEFAULT 1,
  parenthetical TEXT,
  notes         TEXT,
  is_custom     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  payload     TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id          TEXT PRIMARY KEY,
  document_id TEXT,
  actor       TEXT NOT NULL DEFAULT 'system',
  action      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_doc   ON blocks(document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_datums_doc   ON datums(document_id, kind);
CREATE INDEX IF NOT EXISTS idx_findings_doc ON findings(document_id, severity);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_pages_doc    ON pages(document_id, page_number);
`;

export function db(): DatabaseSync {
  if (_db) return _db;
  ensureDirs();
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new DatabaseSync(config.dbPath);
  _db.exec(SCHEMA);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Reset for tests: points the singleton at a fresh temp database. */
export function resetDb(dbPath: string): void {
  closeDb();
  process.env.NYD_DB_PATH = dbPath;
  db();
}

type Row = Record<string, SqlValue>;

function plain<T extends Row>(row: Row | undefined): T | undefined {
  if (!row) return undefined;
  return { ...row } as T;
}

export function all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
  return db()
    .prepare(sql)
    .all(...params)
    .map((r) => ({ ...(r as Row) }) as T);
}

export function get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined {
  return plain<T>(db().prepare(sql).get(...params) as Row | undefined);
}

export function run(sql: string, ...params: SqlValue[]): void {
  db()
    .prepare(sql)
    .run(...params);
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* rollback of an already-aborted tx is not itself an error we can act on */
    }
    throw err;
  }
}
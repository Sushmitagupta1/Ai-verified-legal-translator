import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "@/lib/config";
import { get, run, type SqlValue } from "@/lib/db";
import { createLlmClient } from "@/lib/llm";
import { runPipeline, type Stage } from "@/lib/pipeline/run";

/**
 * Long document jobs cannot finish inside a single HTTP request, so the run
 * route starts the pipeline here and returns immediately.
 *
 * Progress is written to the jobs row as well as kept in memory: Next serves
 * each route from its own module instance, so the handler that started the job
 * is not the handler that reports progress, and a page reload must still show
 * a moving bar rather than a frozen 0%.
 */

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobState {
  documentId: string;
  jobId: string;
  status: JobStatus;
  stage: Stage | null;
  detail: string;
  pct: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/**
 * Throttle bookkeeping for recordProgress. Kept off JobState because that
 * object is serialised straight back to the client.
 */
const lastWritten = new WeakMap<JobState, { stage: Stage | null; pct: number }>();

interface DocumentRow {
  [key: string]: SqlValue;
  id: string;
  file_name: string;
  stored_name: string;
  mime: string;
  declared_type: string | null;
}

const live = new Map<string, JobState>();

export function getJobState(documentId: string): JobState | null {
  const current = live.get(documentId);
  if (current) return current;

  const row = get<{
    id: string;
    status: string;
    payload: string;
    error: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
  }>(
    `SELECT id, status, payload, error, created_at, started_at, finished_at
       FROM jobs
      WHERE document_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    documentId,
  );
  if (!row) return null;

  const known: JobStatus[] = ["queued", "running", "done", "failed"];
  const status: JobStatus = known.includes(row.status as JobStatus)
    ? (row.status as JobStatus)
    : "queued";

  const progress = readProgress(row.payload);

  return {
    documentId,
    jobId: row.id,
    status,
    stage: progress.stage,
    detail:
      status === "done"
        ? "Pipeline finished"
        : status === "failed"
          ? row.error ?? "Failed"
          : progress.detail,
    pct: status === "done" ? 100 : progress.pct,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

interface Progress {
  stage: Stage | null;
  detail: string;
  pct: number;
}

function readProgress(payload: string | null | undefined): Progress {
  if (!payload) return { stage: null, detail: "", pct: 0 };
  try {
    const parsed = JSON.parse(payload) as Partial<Progress>;
    return {
      stage: (parsed.stage as Stage) ?? null,
      detail: typeof parsed.detail === "string" ? parsed.detail : "",
      pct: typeof parsed.pct === "number" ? parsed.pct : 0,
    };
  } catch {
    return { stage: null, detail: "", pct: 0 };
  }
}

export function isRunning(documentId: string): boolean {
  const state = live.get(documentId);
  return state?.status === "queued" || state?.status === "running";
}

export function startJob(documentId: string): JobState {
  if (isRunning(documentId)) return live.get(documentId)!;

  const doc = get<DocumentRow>(
    `SELECT id, file_name, stored_name, mime, declared_type
       FROM documents
      WHERE id = ?`,
    documentId,
  );
  if (!doc) throw new Error(`document not found: ${documentId}`);

  ensureDirs();
  const filePath = path.join(config.uploadDir, doc.stored_name);
  if (!fs.existsSync(filePath)) {
    throw new Error("The uploaded file is no longer on disk — upload the document again.");
  }

  const jobId = `j-${randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO jobs (id, document_id, kind, status, payload, attempts, created_at)
     VALUES (?, ?, 'pipeline', 'queued', '{}', 0, ?)`,
    jobId,
    documentId,
    new Date().toISOString(),
  );

  const state: JobState = {
    documentId,
    jobId,
    status: "queued",
    stage: "uploaded",
    detail: "Queued",
    pct: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  live.set(documentId, state);

  const buffer = fs.readFileSync(filePath);
  void execute(doc, state, buffer);

  return state;
}

/**
 * Mirror the in-memory progress onto the jobs row so a request served by a
 * different route module sees it. Throttled to whole-percent and stage
 * changes because each write is a transaction on a shared connection.
 */
function recordProgress(state: JobState, stage: Stage, detail: string, pct: number): void {
  state.stage = stage;
  state.detail = detail;
  state.pct = pct;

  const rounded = Math.round(pct);
  const previous = lastWritten.get(state);
  if (previous && previous.stage === stage && previous.pct === rounded) return;
  lastWritten.set(state, { stage, pct: rounded });

  try {
    run(`UPDATE jobs SET payload = ? WHERE id = ?`, JSON.stringify({ stage, detail, pct }), state.jobId);
  } catch {
    // Progress reporting must never fail the pipeline.
  }
}

async function execute(doc: DocumentRow, state: JobState, buffer: Buffer): Promise<void> {
  const startedAt = new Date().toISOString();
  state.status = "running";
  state.startedAt = startedAt;
  state.detail = "Starting";
  state.pct = 1;
  run(
    `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?`,
    startedAt,
    state.jobId,
  );
  run(`UPDATE documents SET status = 'running', updated_at = ? WHERE id = ?`, startedAt, doc.id);

  try {
    await runPipeline({
      documentId: doc.id,
      buffer,
      fileName: doc.file_name,
      mime: doc.mime,
      declaredType: doc.declared_type,
      llm: createLlmClient(),
      onProgress: (stage, detail, pct) => {
        recordProgress(state, stage, detail, pct);
      },
    });
    // The pipeline owns documents.status on success: it writes ready or
    // blocked. Overwriting it here would erase that distinction.
    const finishedAt = new Date().toISOString();
    state.status = "done";
    state.finishedAt = finishedAt;
    state.stage = "ready";
    state.detail = "Pipeline finished";
    state.pct = 100;
    run(`UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?`, finishedAt, state.jobId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = new Date().toISOString();
    state.status = "failed";
    state.finishedAt = finishedAt;
    state.error = message;
    state.detail = message;
    run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, message, finishedAt, state.jobId);
    run(
      `UPDATE documents SET status = 'failed', stage = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      message,
      finishedAt,
      doc.id,
    );
  }
}

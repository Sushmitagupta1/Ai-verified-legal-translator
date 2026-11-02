import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDirs } from "@/lib/config";
import { all, get, run, type SqlValue } from "@/lib/db";
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

/**
 * Next serves each route from its own module instance, so a plain module-level
 * map would be per-route. Hoisting it onto `globalThis` keeps one view of what
 * is actually running for the whole process.
 */
interface PendingJob {
  doc: DocumentRow;
  state: JobState;
  buffer: Buffer;
}

type JobsGlobals = {
  __nydLiveJobs?: Map<string, JobState>;
  /** Documents waiting for a queue slot, in arrival order. */
  __nydQueue?: PendingJob[];
  /** How many jobs are currently holding a queue slot. */
  __nydActive?: number;
  /** Cancellation handles for running jobs. */
  __nydAbort?: Map<string, AbortController>;
};
const globals = globalThis as typeof globalThis & JobsGlobals;
const live: Map<string, JobState> = (globals.__nydLiveJobs ??= new Map());
const queue: PendingJob[] = (globals.__nydQueue ??= []);
const aborts: Map<string, AbortController> = (globals.__nydAbort ??= new Map());
const activeCount = () => (globals.__nydActive ?? 0);
const setActiveCount = (n: number) => {
  globals.__nydActive = n;
};

/** Open timing row for the stage a job is currently in. */
const openTimings = new WeakMap<JobState, { id: string; startedAt: number }>();

/**
 * When this process booted, used only for job rows that predate pid tracking.
 *
 * Age alone is not enough: `next dev` runs a parent and a child process, and a
 * child that boots after a run has started will see that run as "older than me"
 * and fail it out from under a live pipeline. Which process owns the run is the
 * question that actually matters, and that is what the pid in the payload asks.
 */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/**
 * Signal numbers that mean "this pid does not exist" rather than "try again".
 * ESRCH says it does not, EPERM says it does but belongs to someone else, and
 * EINVAL/ERANGE say the number was never a pid at all (Windows rejects absurd
 * values outright). Anything else is ambiguous, and ambiguity should keep the
 * job running rather than kill it.
 */
const DEAD_PID_CODES = new Set(["ESRCH", "EINVAL", "ERANGE"]);

/**
 * Run the recovery sweep once, on the first access to the jobs table.
 *
 * It used to run at module import. Next collects page data by loading every
 * route bundle in parallel workers, so importing this module opened the same
 * SQLite file from several processes at once. `PRAGMA journal_mode = WAL` needs
 * an exclusive lock, and the build failed with "database is locked" before it
 * ever reached the routes. A module import must not mutate the database; the
 * first request that actually reads or starts a job still gets the same
 * one-time recovery.
 */
let swept = false;

function ensureSwept(): void {
  if (swept) return;
  try {
    sweepOrphanedJobs();
    swept = true;
  } catch {
    // Recovery is best-effort. A busy or read-only database must not turn a
    // page load into a 500; the next access tries again.
  }
}

/**
 * Is `pid` a process this machine can still signal?
 *
 * `kill(pid, 0)` sends nothing; it only asks the kernel whether the pid exists.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !DEAD_PID_CODES.has((err as NodeJS.ErrnoException).code ?? "");
  }
}

/**
 * A process killed mid-run leaves its job row `running` with nothing to finish
 * it, and the UI would show a progress bar that never moves. Fail those, and
 * leave anything owned by a live process alone — whatever its start time says.
 */
function sweepOrphanedJobs(): void {
  const candidates = all<{ id: string; document_id: string; payload: string | null; created_at: string }>(
    `SELECT id, document_id, payload, created_at FROM jobs
      WHERE status IN ('queued', 'running')`,
  );

  for (const row of candidates) {
    if (live.has(row.document_id)) continue;

    const pid = readPid(row.payload);
    if (pid != null) {
      // A pid alone is not proof of life: the OS reuses numbers, and a
      // restarted server can inherit the one a stale job recorded. A job
      // created before this process started cannot be running inside it, so it
      // is an orphan even if the number now belongs to us.
      const inheritedOwnPid = pid === process.pid && row.created_at < PROCESS_STARTED_AT;
      if (!inheritedOwnPid && processAlive(pid)) continue;
    } else if (row.created_at >= PROCESS_STARTED_AT) {
      // No pid recorded, but the row was created after this process booted —
      // it belongs to this one, so leave it alone.
      continue;
    }

    const now = new Date().toISOString();
    const message = "Interrupted — the server stopped before this run finished. Run it again.";
    run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, message, now, row.id);
    run(
      `UPDATE documents SET status = 'failed', stage = 'failed', error = ?, updated_at = ?
        WHERE id = ? AND status = 'running'`,
      message,
      now,
      row.document_id,
    );
  }
}

function readPid(payload: string | null | undefined): number | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch {
    return null;
  }
}

export function getJobState(documentId: string): JobState | null {
  ensureSwept();
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
  ensureSwept();
  const state = live.get(documentId);
  if (state?.status === "queued" || state?.status === "running") return true;

  // The map is per module instance, so a run started by another route bundle is
  // only visible in the jobs table. Orphans are swept at startup, which is what
  // makes an open row here a live run rather than a leftover.
  const row = get<{ status: string }>(
    `SELECT status FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT 1`,
    documentId,
  );
  return row?.status === "queued" || row?.status === "running";
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
     VALUES (?, ?, 'pipeline', 'queued', ?, 0, ?)`,
    jobId,
    documentId,
    JSON.stringify({ pid: process.pid }),
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
  beginTiming(state, "uploaded", "Queued");

  const buffer = fs.readFileSync(filePath);
  queue.push({ doc, state, buffer });
  updateQueueDetails();
  pump();

  return state;
}

/**
 * Start queued jobs up to the configured concurrency.
 *
 * One local GPU serves one document at a time; running two only divides the
 * same hardware and makes both slower and more timeout-prone. Extra uploads
 * wait here, visibly, instead of competing for the model.
 */
function pump(): void {
  while (activeCount() < Math.max(1, config.pipeline.queueConcurrency) && queue.length > 0) {
    const next = queue.shift()!;
    if (next.state.status !== "queued") continue;
    setActiveCount(activeCount() + 1);
    const controller = new AbortController();
    aborts.set(next.doc.id, controller);
    void execute(next.doc, next.state, next.buffer, controller).finally(() => {
      setActiveCount(Math.max(0, activeCount() - 1));
      aborts.delete(next.doc.id);
      pump();
    });
  }
  updateQueueDetails();
}

function updateQueueDetails(): void {
  queue.forEach((job, i) => {
    if (job.state.status !== "queued") return;
    job.state.detail = i === 0 ? "Queued — next in line" : `Queued — ${i} ahead`;
  });
}

/** Position in the queue, 1-based; 0 when not queued. */
export function queuePosition(documentId: string): number {
  const i = queue.findIndex((j) => j.doc.id === documentId);
  return i < 0 ? 0 : i + 1;
}

// ── Stage timings ────────────────────────────────────────────────────────────

function beginTiming(state: JobState, stage: Stage, detail: string): void {
  if (openTimings.has(state)) endTiming(state);
  const id = `t-${randomUUID().slice(0, 8)}`;
  openTimings.set(state, { id, startedAt: Date.now() });
  try {
    run(
      `INSERT INTO stage_timings (id, document_id, job_id, stage, detail, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      id,
      state.documentId,
      state.jobId,
      stage,
      detail,
      new Date().toISOString(),
    );
  } catch {
    // Timings are diagnostics; they must never fail a run.
  }
}

function endTiming(state: JobState, detail?: string): void {
  const open = openTimings.get(state);
  if (!open) return;
  openTimings.delete(state);
  try {
    run(
      `UPDATE stage_timings SET ended_at = ?, duration_ms = ?, detail = COALESCE(?, detail) WHERE id = ?`,
      new Date().toISOString(),
      Date.now() - open.startedAt,
      detail ?? null,
      open.id,
    );
  } catch {
    // See above.
  }
}

function markTiming(state: JobState, stage: string, detail: string): void {
  const now = new Date().toISOString();
  try {
    run(
      `INSERT INTO stage_timings (id, document_id, job_id, stage, detail, started_at, ended_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      `t-${randomUUID().slice(0, 8)}`,
      state.documentId,
      state.jobId,
      stage,
      detail,
      now,
      now,
    );
  } catch {
    // See above.
  }
}

/** Stage timings for a document, oldest first. */
export function getStageTimings(documentId: string): Array<{
  stage: string;
  detail: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}> {
  return all<{
    stage: string;
    detail: string;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
  }>(
    `SELECT stage, detail, started_at, ended_at, duration_ms
       FROM stage_timings
      WHERE document_id = ?
      ORDER BY started_at, rowid`,
    documentId,
  ).map((r) => ({
    stage: r.stage,
    detail: r.detail,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
  }));
}

/**
 * Stop a queued or running job.
 *
 * Cancelling a run never deletes anything already produced: a finished
 * translation stays downloadable. The caller decides what to do next.
 */
export function cancelJob(documentId: string): { cancelled: boolean; reason: string } {
  ensureSwept();
  const queuedAt = queue.findIndex((j) => j.doc.id === documentId);
  if (queuedAt >= 0) {
    const [job] = queue.splice(queuedAt, 1);
    const now = new Date().toISOString();
    endTiming(job.state, "Cancelled before starting.");
    markTiming(job.state, "failed", "Cancelled");
    job.state.status = "failed";
    job.state.detail = "Cancelled";
    job.state.error = "Cancelled before starting.";
    job.state.finishedAt = now;
    run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, job.state.error, now, job.state.jobId);
    updateQueueDetails();
    return { cancelled: true, reason: "Removed from the queue." };
  }

  const controller = aborts.get(documentId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error("Cancelled by the user."));
    return { cancelled: true, reason: "Stopping the running job." };
  }

  return { cancelled: false, reason: "This job is not queued or running." };
}


/**
 * Mirror the in-memory progress onto the jobs row so a request served by a
 * different route module sees it. Throttled to whole-percent and stage
 * changes because each write is a transaction on a shared connection.
 */
function recordProgress(state: JobState, stage: Stage, detail: string, pct: number): void {
  const changedStage = state.stage !== stage;
  state.stage = stage;
  state.detail = detail;
  state.pct = pct;

  if (changedStage) beginTiming(state, stage, detail);

  const rounded = Math.round(pct);
  const previous = lastWritten.get(state);
  if (previous && previous.stage === stage && previous.pct === rounded) return;
  lastWritten.set(state, { stage, pct: rounded });

  try {
    run(
      `UPDATE jobs SET payload = ? WHERE id = ?`,
      JSON.stringify({ pid: process.pid, stage, detail, pct }),
      state.jobId,
    );
  } catch {
    // Progress reporting must never fail the pipeline.
  }
}

async function execute(
  doc: DocumentRow,
  state: JobState,
  buffer: Buffer,
  controller: AbortController,
): Promise<void> {
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
  run(
    `UPDATE documents SET status = 'running', error = NULL, updated_at = ? WHERE id = ?`,
    startedAt,
    doc.id,
  );

  const timeout = AbortSignal.timeout(Math.max(1, config.pipeline.jobTimeoutMs));
  const signal = AbortSignal.any([controller.signal, timeout]);

  try {
    await runPipeline({
      documentId: doc.id,
      buffer,
      fileName: doc.file_name,
      mime: doc.mime,
      declaredType: doc.declared_type,
      llm: createLlmClient(),
      signal,
      onProgress: (stage, detail, pct) => {
        recordProgress(state, stage, detail, pct);
      },
    });
    // The pipeline owns documents.status on success: it writes ready or
    // blocked. Overwriting it here would erase that distinction.
    const finishedAt = new Date().toISOString();
    endTiming(state, "Complete");
    markTiming(state, "ready", "Pipeline finished");
    state.status = "done";
    state.finishedAt = finishedAt;
    state.stage = "ready";
    state.detail = "Pipeline finished";
    state.pct = 100;
    run(`UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?`, finishedAt, state.jobId);
  } catch (err) {
    const cancelled = controller.signal.aborted;
    const timedOut = timeout.aborted && !cancelled;
    const message = cancelled
      ? "Cancelled by the user."
      : timedOut
        ? `Stopped after the ${Math.round(config.pipeline.jobTimeoutMs / 60000)} minute job limit.`
        : err instanceof Error
          ? err.message
          : String(err);
    const finishedAt = new Date().toISOString();
    endTiming(state, message);
    markTiming(state, "failed", message);
    state.status = "failed";
    state.finishedAt = finishedAt;
    state.error = message;
    state.detail = message;
    run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, message, finishedAt, state.jobId);

    // A run stopped after the translation was committed still has a usable
    // deliverable. Do not relabel that document "failed" and hide the Word file.
    const current = get<{ status: string }>("SELECT status FROM documents WHERE id = ?", doc.id)?.status;
    const delivered = current === "translated" || current === "ready" || current === "blocked";
    if (!delivered) {
      run(
        `UPDATE documents SET status = 'failed', stage = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        message,
        finishedAt,
        doc.id,
      );
    }
  }
}

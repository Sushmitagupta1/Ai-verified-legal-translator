"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * One job for the page: put a Gujarati document in, get an editable English
 * Word file out. Upload starts the pipeline, the page polls until the Word file
 * exists and hands it to the browser. Everything else (report, findings,
 * segment review) lives behind the file name as an optional detail view.
 */

interface DocRow {
  id: string;
  file_name: string;
  size_bytes: number;
  status: string;
  page_count: number;
  fidelity: number | null;
  fidelity_band: string | null;
  error: string | null;
  created_at: string;
}

type Phase = "queued" | "uploading" | "running" | "done" | "failed";

interface Item {
  key: string;
  file: File;
  phase: Phase;
  id?: string;
  pct: number;
  detail: string;
  error?: string;
  downloaded?: boolean;
  /** The Word file has been handed to the browser; checks may still be running. */
  wordReady?: boolean;
  /** A report exists for this document, draft or final. */
  reportReady?: boolean;
  /** The existing report was written from deterministic checks and is still being completed. */
  reportDraft?: boolean;
  /** 1-based position while the server has this job waiting for a GPU slot. */
  queuePosition?: number;
}

const ACCEPT = [".pdf", ".docx", ".txt", ".md", ".html"];

const STATUS_LABEL: Record<string, string> = {
  ready: "Word file ready",
  blocked: "Word file ready — review flagged",
  translated: "Word file ready",
  running: "Translating",
  uploaded: "Not started",
  failed: "Failed",
  queued: "Queued",
};

const STAGE_LABEL: Record<string, string> = {
  uploaded: "Reading the file",
  extracting: "Reading the pages",
  translated: "Translating",
  verifying: "Checking the translation",
  reported: "Preparing the report",
  ready: "Finishing",
};

const BAND_LABEL: Record<string, string> = {
  green: "ok",
  yellow: "warn",
  red: "bad",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function saveAs(url: string, fallbackName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function extensionOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toUpperCase();
  return ext.length > 4 ? "FILE" : ext;
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M12 16V4" strokeLinecap="round" />
      <path d="m7.5 8.5 4.5-4.5 4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" strokeLinecap="round" />
    </svg>
  );
}

export default function HomePage() {
  const [items, setItems] = useState<Item[]>([]);
  const [recent, setRecent] = useState<DocRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [readyTick, setReadyTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const working = useRef(false);

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/documents", { cache: "no-store" });
      const data = await res.json();
      setRecent((data.documents ?? []) as DocRow[]);
    } catch {
      // The list is a convenience; never let it block the upload flow.
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const patch = useCallback((key: string, p: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...p } : i)));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const accepted: Item[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!ACCEPT.includes(ext)) {
        rejected.push(file.name);
        continue;
      }
      accepted.push({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        phase: "queued",
        pct: 0,
        detail: "Waiting",
      });
    }
    if (rejected.length) {
      setError(
        `Only PDF, Word (.docx), text, Markdown or HTML files can be translated. Skipped: ${rejected.join(", ")}`,
      );
    } else {
      setError(null);
    }
    if (accepted.length) setItems((prev) => [...prev, ...accepted]);
  }, []);

  const processItem = useCallback(
    async (item: Item) => {
      patch(item.key, { phase: "uploading", pct: 3, detail: "Uploading" });
      const form = new FormData();
      form.set("file", item.file);
      const up = await fetch("/api/documents", { method: "POST", body: form });
      const created = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error(created.error ?? "The upload failed.");
      const id = created.id as string;

      patch(item.key, { id, phase: "running", pct: 5, detail: "Starting" });
      const start = await fetch(`/api/documents/${id}/run`, { method: "POST" });
      if (!start.ok) {
        const body = await start.json().catch(() => ({}));
        throw new Error(body.error ?? "The translation could not be started.");
      }

      const deadline = Date.now() + 3 * 60 * 60 * 1000;
      let wordDownloaded = false;
      let reportStatus: string | null = null;
      const grabWord = () => {
        if (wordDownloaded) return;
        wordDownloaded = true;
        patch(item.key, { wordReady: true, detail: "Word file ready — finishing quality checks" });
        saveAs(`/api/documents/${id}/word`, `${item.file.name.replace(/\.[^.]+$/, "")}-english.docx`);
        void loadRecent();
      };

      for (;;) {
        await sleep(2000);
        if (Date.now() > deadline) {
          throw new Error(
            "This file is taking unusually long. Open it from the list below to see where it stopped.",
          );
        }
        const res = await fetch(`/api/documents/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Lost contact with the server. Reload the page to check this file.");
        const json = await res.json();
        const status: string = json.document?.status ?? "unknown";
        const job = json.job ?? {};
        const stage: string = job.stage ?? "";
        const queuePosition = Number(json.queuePosition ?? 0);
        const report = json.report ?? null;
        const reportFinal = report?.status === "final";
        const reportDraft = report && !reportFinal;
        reportStatus = report?.status ?? null;
        const pct = Math.max(5, Math.min(99, Number(job.pct ?? 0)));

        let detail = job.detail || STAGE_LABEL[stage] || "Working";
        if (queuePosition > 0) {
          detail =
            queuePosition === 1
              ? "Queued — next in line for the translator"
              : `Queued — ${queuePosition - 1} file(s) ahead of this one`;
        } else if (wordDownloaded && !reportFinal) {
          detail = reportDraft ? "Word file ready — report draft ready, finishing checks" : "Word file ready — finishing quality checks";
        }

        patch(item.key, {
          pct,
          detail,
          queuePosition,
          reportReady: Boolean(report),
          reportDraft: Boolean(reportDraft),
        });

        // 70% is the point where the translation is committed to disk. The file
        // is handed over there instead of at 100%, so the last minutes of
        // verification and report writing do not hold the Word file hostage.
        if (pct >= 70 || status === "translated") grabWord();

        if (status === "ready" || status === "blocked") {
          grabWord();
          patch(item.key, {
            phase: "done",
            pct: 100,
            detail: reportFinal ? "Word file ready · report ready" : "Word file ready",
            downloaded: true,
            reportReady: Boolean(report),
          });
          void loadRecent();
          return;
        }
        if (status === "failed") {
          // The file was already delivered; a failure in the audit that runs
          // after it must not turn a usable translation into "Failed".
          if (wordDownloaded) {
            patch(item.key, {
              phase: "done",
              pct: 100,
              detail: "Word file ready — quality check stopped",
              downloaded: true,
            });
            return;
          }
          throw new Error(job.error ?? json.document?.error ?? "The translation failed.");
        }
        // The Word file survived a server restart but no job is left to finish
        // the audit. Show the deliverable rather than spinning forever.
        if (status === "translated" && !json.job) {
          patch(item.key, {
            phase: "done",
            pct: 100,
            detail: "Word file ready — quality check did not finish",
            downloaded: true,
          });
          return;
        }
        if (reportStatus === "final") {
          patch(item.key, { detail: "Word file ready · report ready" });
        }
      }
    },
    [loadRecent, patch],
  );

  // One file at a time: the machine translates on a single GPU, and a queue is
  // easier to read than five bars moving at once.
  useEffect(() => {
    if (working.current) return;
    const next = items.find((i) => i.phase === "queued");
    if (!next) return;
    working.current = true;
    void (async () => {
      try {
        await processItem(next);
      } catch (e) {
        patch(next.key, {
          phase: "failed",
          detail: "Failed",
          error: e instanceof Error ? e.message : String(e),
        });
        void loadRecent();
      } finally {
        working.current = false;
        setReadyTick((n) => n + 1);
      }
    })();
  }, [items, loadRecent, patch, processItem, readyTick]);

  const busy = items.some((i) => i.phase === "uploading" || i.phase === "running");
  // Never-run uploads are noise in a list whose whole point is "your finished
  // Word files". Old fixtures with no translation are hidden, not deleted.
  const showRecent = recent.filter((d) => d.status !== "uploaded").slice(0, 8);

  return (
    <main className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">Gujarati → English · legal documents</div>
          <h1 className="display">
            The file in. The <em>Word document</em> out.
          </h1>
          <p className="lede">
            Drop a Gujarati deed, agreement, notice or affidavit. Nyayadoot returns an
            editable English Word file, then a review report that shows exactly what was
            checked and what a person still needs to read.
          </p>
          <div className="hero-points">
            <span className="hero-point">
              <b>One step</b> — no settings
            </span>
            <span className="hero-point">
              <b>Editable</b> .docx
            </span>
            <span className="hero-point">
              <b>Data check</b> — names, dates, amounts
            </span>
            <span className="hero-point">
              <b>On-device</b> — nothing leaves the machine
            </span>
          </div>
          <p className="hero-note">
            Everything produced here is a working draft. It is not a certified translation,
            and a qualified professional should read it against the Gujarati original before
            it is relied on.
          </p>
        </div>

        <div className="upload-card">
          <div className="upload-card-head">
            <h2>Translate a document</h2>
            <span>PDF · DOCX · TXT</span>
          </div>
          <div
            className={`dropzone${drag ? " drag" : ""}${busy ? " busy" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              addFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <span className="dz-icon">
              <UploadIcon />
            </span>
            <span className="dz-title">Drop a Gujarati document here</span>
            <span className="dz-hint">
              or click to choose a file. You can drop several; they run one after another.
            </span>
            <span className="dz-formats">.pdf · .docx · .txt · .md · .html</span>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT.join(",")}
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
              hidden
            />
          </div>

          {error ? <div className="error">{error}</div> : null}

          {items.length ? (
            <div className="filelist">
              {items.map((i) => {
                const failed = i.phase === "failed";
                const done = i.phase === "done";
                return (
                  <div className={`file-item${failed ? " failed" : ""}${done ? " done" : ""}`} key={i.key}>
                    <div className="file-row">
                      <span className="file-glyph" aria-hidden="true">
                        {extensionOf(i.file.name)}
                      </span>
                      <span className="file-name" title={i.file.name}>
                        {i.file.name}
                      </span>
                      <span className="file-meta">{formatBytes(i.file.size)}</span>
                      <span className="file-actions">
                        {(done || (i.phase === "running" && i.wordReady)) && i.id ? (
                          <a className="btn small" href={`/api/documents/${i.id}/word`}>
                            Download Word
                          </a>
                        ) : null}
                        {failed ? (
                          <button
                            className="btn ghost small"
                            type="button"
                            onClick={() =>
                              patch(i.key, {
                                phase: "queued",
                                pct: 0,
                                detail: "Waiting",
                                error: undefined,
                              })
                            }
                          >
                            Retry
                          </button>
                        ) : null}
                      </span>
                    </div>

                    {failed ? (
                      <div className="error" style={{ marginTop: 8 }}>
                        {i.error}
                      </div>
                    ) : done ? (
                      <div className="ok-line">
                        {i.detail}
                        {i.id ? (
                          <>
                            {" "}
                            · <a href={`/api/documents/${i.id}/word`}>Download again</a> ·{" "}
                            <Link href={`/documents/${i.id}`}>Open report</Link>
                          </>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        {i.wordReady && i.id ? (
                          <div className="ok-line">
                            Word file ready — the download should have started.{" "}
                            <a href={`/api/documents/${i.id}/word`}>Download again</a>
                            {i.reportReady ? (
                              <>
                                {" "}
                                · <Link href={`/documents/${i.id}`}>Report draft</Link>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="bar">
                          <div
                            className={`bar-fill${failed ? " failed" : ""}`}
                            style={{ width: `${i.pct}%` }}
                          />
                        </div>
                        <div className="progress-line">
                          <span>{i.detail}</span>
                          <span>
                            {i.queuePosition && i.queuePosition > 0 ? (
                              <>position {i.queuePosition} · </>
                            ) : null}
                            <b>{i.pct}%</b>
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      <section id="library" className="panel">
        <div className="panel-head">
          <div>
            <h2>Recent files</h2>
            <div className="panel-sub">
              Finished translations stay here. Open one for the report, findings and segment review.
            </div>
          </div>
          <button className="btn ghost small" type="button" onClick={() => void loadRecent()}>
            Refresh
          </button>
        </div>

        {showRecent.length === 0 ? (
          <div className="empty">Nothing translated yet. Drop a file above to start.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th style={{ width: 130 }}>Pages</th>
                  <th style={{ width: 150 }}>Quality</th>
                  <th style={{ width: 230, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {showRecent.map((d) => {
                  // `translated` means the Word file is on disk while verification
                  // and the report are still running; it is already downloadable.
                  const done =
                    d.status === "ready" || d.status === "blocked" || d.status === "translated";
                  return (
                    <tr key={d.id}>
                      <td>
                        <Link className="doc-link" href={`/documents/${d.id}`}>
                          {d.file_name}
                        </Link>
                        <div className="uploaded-at">{formatDate(d.created_at)}</div>
                      </td>
                      <td className="muted">{d.page_count || "—"}</td>
                      <td>
                        {d.fidelity != null ? (
                          <span className={`badge ${BAND_LABEL[d.fidelity_band ?? ""] ?? "neutral"}`}>
                            {(d.fidelity * 100).toFixed(1)}%
                          </span>
                        ) : (
                          <span className="badge neutral">{STATUS_LABEL[d.status] ?? d.status}</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {done ? (
                          <span className="row" style={{ justifyContent: "flex-end" }}>
                            <a className="btn ghost small" href={`/documents/${d.id}`}>
                              Report
                            </a>
                            <a className="btn small" href={`/api/documents/${d.id}/word`}>
                              Word
                            </a>
                          </span>
                        ) : d.status === "failed" ? (
                          <span className="badge bad">Failed</span>
                        ) : (
                          <span className="badge warn">
                            {STATUS_LABEL[d.status] ?? d.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="disclaimer">
        <strong>Non-certified translation.</strong> The Word file is an AI-generated working
        translation you can edit. Have a qualified professional check it before you rely on it
        legally.
      </div>
    </main>
  );
}

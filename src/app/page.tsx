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
}

const ACCEPT = [".pdf", ".docx", ".txt", ".md", ".html"];

const STATUS_LABEL: Record<string, string> = {
  ready: "Word file ready",
  blocked: "Word file ready — review flagged",
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
      setError(`Only PDF, Word (.docx), text, Markdown or HTML files can be translated. Skipped: ${rejected.join(", ")}`);
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
      const grabWord = () => {
        if (wordDownloaded) return;
        wordDownloaded = true;
        patch(item.key, { wordReady: true, detail: "Word file ready — finishing quality checks" });
        saveAs(`/api/documents/${id}/word`, `${item.file.name.replace(/\.[^.]+$/, "")}-english.docx`);
        void loadRecent();
      };

      for (;;) {
        await sleep(2000);
        if (Date.now() > deadline) throw new Error("This file is taking unusually long. Open it from the list below to see where it stopped.");
        const res = await fetch(`/api/documents/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Lost contact with the server. Reload the page to check this file.");
        const json = await res.json();
        const status: string = json.document?.status ?? "unknown";
        const job = json.job ?? {};
        const stage: string = job.stage ?? "";
        const pct = Math.max(5, Math.min(99, Number(job.pct ?? 0)));
        patch(item.key, {
          pct,
          detail: job.detail || STAGE_LABEL[stage] || "Working",
        });

        // 70% is the point where the translation is committed to disk. The file
        // is handed over there instead of at 100%, so the last ten minutes of
        // verification and report writing do not hold the Word file hostage.
        if (pct >= 70 || status === "translated") grabWord();

        if (status === "ready" || status === "blocked") {
          grabWord();
          patch(item.key, { phase: "done", pct: 100, detail: "Word file ready", downloaded: true });
          void loadRecent();
          return;
        }
        if (status === "failed") {
          // The file was already delivered; a failure in the audit that runs
          // after it must not turn a usable translation into "Failed".
          if (wordDownloaded) {
            patch(item.key, { phase: "done", pct: 100, detail: "Word file ready — quality check stopped", downloaded: true });
            return;
          }
          throw new Error(job.error ?? json.document?.error ?? "The translation failed.");
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
        patch(next.key, { phase: "failed", detail: "Failed", error: e instanceof Error ? e.message : String(e) });
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
    <main>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Translate a Gujarati document</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          Drop the file. You get back an editable English Word file — no settings to choose.
        </p>

        <div
          className={`dropzone big${drag ? " drag" : ""}${busy ? " busy" : ""}`}
          onClick={() => inputRef.current?.click()}
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
          <div className="dropzone-title">Drop a Gujarati PDF or Word file here</div>
          <div className="muted small">or click to choose a file · .pdf, .docx, .txt · you can drop several</div>
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
            {items.map((i) => (
              <div className={`item ${i.phase}`} key={i.key}>
                <div className="item-head">
                  <span className="item-name" title={i.file.name}>
                    {i.file.name}
                  </span>
                  <span className="muted small">{formatBytes(i.file.size)}</span>
                  {i.phase === "done" && i.id ? (
                    <a className="btn small-btn" href={`/api/documents/${i.id}/word`}>
                      Download Word
                    </a>
                  ) : null}
                  {i.phase === "running" && i.wordReady && i.id ? (
                    <a className="btn small-btn" href={`/api/documents/${i.id}/word`}>
                      Download Word
                    </a>
                  ) : null}
                  {i.phase === "failed" ? (
                    <button
                      className="ghost small-btn"
                      type="button"
                      onClick={() => patch(i.key, { phase: "queued", pct: 0, detail: "Waiting", error: undefined })}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
                {i.phase === "done" ? (
                  <div className="ok-line">
                    {i.detail === "Word file ready"
                      ? "Word file ready — the download should have started."
                      : i.detail}
                    {i.id ? (
                      <>
                        {" "}
                        <a href={`/api/documents/${i.id}/word`}>Download again</a>
                      </>
                    ) : null}
                  </div>
                ) : i.phase === "failed" ? (
                  <div className="error" style={{ marginTop: 8 }}>
                    {i.error}
                  </div>
                ) : (
                  <>
                    {i.wordReady && i.id ? (
                      <div className="ok-line">
                        Word file ready — the download should have started.{" "}
                        <a href={`/api/documents/${i.id}/word`}>Download again</a>
                        <span className="muted"> · {i.detail}</span>
                      </div>
                    ) : null}
                    <div className="progress" style={{ marginTop: 8 }}>
                      <div style={{ width: `${i.pct}%` }} />
                    </div>
                    <div className="muted small" style={{ marginTop: 5 }}>
                      {i.detail} · {i.pct}%
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Recent files</h2>
          <button className="ghost small-btn" type="button" onClick={() => void loadRecent()}>
            Refresh
          </button>
        </div>

        {showRecent.length === 0 ? (
          <div className="empty">Nothing translated yet. Drop a file above to start.</div>
        ) : (
          <table>
            <tbody>
              {showRecent.map((d) => {
                // `translated` means the Word file is on disk while verification
                // and the report are still running; it is already downloadable.
                const done = d.status === "ready" || d.status === "blocked" || d.status === "translated";
                return (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/documents/${d.id}`}>{d.file_name}</Link>
                      <div className="muted small">
                        {formatDate(d.created_at)}
                        {d.page_count ? ` · ${d.page_count} pages` : ""}
                      </div>
                    </td>
                    <td style={{ width: 210, textAlign: "right" }}>
                      {done ? (
                        <a className="btn small-btn" href={`/api/documents/${d.id}/word`}>
                          Download Word
                        </a>
                      ) : d.status === "failed" ? (
                        <span className="badge bad">Failed</span>
                      ) : (
                        <span className="badge warn">{STATUS_LABEL[d.status] ?? d.status}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="disclaimer">
        <strong>Non-certified translation.</strong> The Word file is an AI-generated working
        translation you can edit. Have a qualified professional check it before you rely on it
        legally.
      </div>
    </main>
  );
}

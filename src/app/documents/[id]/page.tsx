"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

interface DocumentRow {
  id: string;
  file_name: string;
  size_bytes: number;
  declared_type: string | null;
  detected_type: string | null;
  type_confidence: number | null;
  page_count: number;
  status: string;
  stage: string | null;
  error: string | null;
  fidelity: number | null;
  fidelity_band: string | null;
  gate_status: string;
  human_review: string;
  created_at: string;
  updated_at: string;
}

interface JobState {
  jobId: string;
  status: string;
  stage: string | null;
  detail: string;
  pct: number;
  error: string | null;
}

interface ReportFinding {
  id: string;
  severity: string;
  category: string;
  check: string;
  location: string;
  title: string;
  detail: string;
  suggestion: string;
  sourceExcerpt: string;
  targetExcerpt: string;
}

interface MechanicalCheck {
  check: string;
  description: string;
  count: number;
  passed: boolean;
  pending?: boolean;
}

interface Report {
  generatedAt: string;
  completedAt?: string | null;
  status?: "draft" | "final";
  semanticAudit?: "pending" | "complete" | "partial" | "skipped";
  docTypeLabel: string;
  provider: string;
  sourceSha256: string;
  pageCount: number;
  segmentCount: number;
  fidelityIndicator: {
    value: number;
    grade: "green" | "yellow" | "red";
    components: Record<string, number>;
    interpretation: string;
  };
  mechanicalChecks: MechanicalCheck[];
  findings: ReportFinding[];
  narrative: {
    executiveSummary: string;
    reviewFocus: string[];
    limitations: string[];
    recommendedAction: string;
  };
}

interface Segment {
  index: number;
  blockId: string;
  source: string;
  target: string;
  confidence: number;
}

interface Timing {
  stage: string;
  detail: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

interface Detail {
  document: DocumentRow;
  job: JobState | null;
  queuePosition: number;
  report: Report | null;
  timings: Timing[];
  segmentCount: number;
  blockCount: number;
  segments: Segment[];
  findings: Array<{ severity: string; check: string }>;
  findingsBySeverity: Record<string, number>;
}

const BADGE: Record<string, string> = {
  ready: "ok",
  blocked: "bad",
  failed: "bad",
  running: "warn",
  translated: "neutral",
  uploaded: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  blocked: "Ready — review flagged",
  translated: "Word file ready",
  running: "Translating",
  uploaded: "Not started",
  failed: "Failed",
  queued: "Queued",
};

const SEVERITY_ORDER = ["critical", "major", "minor", "info"];

const COMPONENT_LABEL: Record<string, string> = {
  datumIntegrity: "Data integrity",
  terminology: "Terminology",
  coverage: "Coverage",
  semantic: "Meaning-level review",
  ocrConfidence: "Source legibility",
  criticalPenalty: "Critical findings",
};

type Tab = "overview" | "findings" | "segments" | "report";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "running";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function severityClass(severity: string): string {
  if (severity === "critical") return "bad";
  if (severity === "major") return "warn";
  if (severity === "minor") return "warn";
  return "neutral";
}

function semanticLabel(state: Report["semanticAudit"]): string {
  switch (state) {
    case "pending":
      return "Meaning check running";
    case "complete":
      return "Meaning check complete";
    case "partial":
      return "Meaning check partial";
    case "skipped":
      return "Meaning check not run";
    default:
      // Reports written before the draft/final split carry no semantic state.
      return "Meaning check not recorded";
  }
}

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [showAllSegments, setShowAllSegments] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void params.then((p) => setId(p.id));
  }, [params]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/documents/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load this document.");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const jobStatus = data?.job?.status;
  const running =
    jobStatus === "queued" ||
    jobStatus === "running" ||
    data?.document.status === "running";

  useEffect(() => {
    if (!running) return;
    poll.current = setTimeout(() => void load(), 1500);
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [running, data, load]);

  async function startRun() {
    if (!id) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${id}/run`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not start the pipeline.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  async function cancelRun() {
    if (!id) return;
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${id}/cancel`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? json.reason ?? "Could not cancel this run.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  }

  const reportFindings = useMemo(() => data?.report?.findings ?? [], [data]);
  const filteredFindings = useMemo(
    () =>
      severityFilter === "all"
        ? reportFindings
        : reportFindings.filter((f) => f.severity === severityFilter),
    [reportFindings, severityFilter],
  );

  if (error && !data) {
    return (
      <main className="page">
        <div className="crumbs">
          <Link href="/">← All documents</Link>
        </div>
        <div className="error">{error}</div>
      </main>
    );
  }

  if (!data || !id) {
    return <main className="page loading">Loading the document…</main>;
  }

  const doc = data.document;
  const report = data.report;
  const grade = report?.fidelityIndicator.grade ?? null;
  const severityCounts = SEVERITY_ORDER.map(
    (s) => [s, data.findingsBySeverity[s] ?? 0] as const,
  ).filter(([, n]) => n > 0);

  const finished =
    doc.status === "ready" ||
    doc.status === "blocked" ||
    doc.status === "translated" ||
    doc.status === "failed";
  const neverRun = doc.status === "uploaded" && !data.job;
  const hasDeliverable =
    doc.status === "ready" || doc.status === "blocked" || doc.status === "translated";

  const segments = showAllSegments ? data.segments : data.segments.slice(0, 25);
  const visibleFindings = showAllFindings ? filteredFindings : filteredFindings.slice(0, 25);
  const reportIsDraft = report?.status === "draft";
  const timings = data.timings ?? [];
  const maxTiming = Math.max(1, ...timings.map((t) => t.durationMs ?? 0));

  const statCards = [
    {
      k: "Quality indicator",
      v: report ? pct(report.fidelityIndicator.value) : "—",
      sub: report ? `${grade?.toUpperCase()} band` : running ? "being measured" : "not available",
    },
    {
      k: "Findings",
      v: report ? String(report.findings.length) : String(data.findings.length || "—"),
      sub: severityCounts.length
        ? severityCounts.map(([s, n]) => `${n} ${s}`).join(" · ")
        : "nothing raised",
    },
    {
      k: "Segments",
      v: String(data.segmentCount),
      sub: `${data.blockCount} source block(s)`,
    },
    {
      k: "Pages",
      v: String(doc.page_count || "—"),
      sub: doc.declared_type ?? doc.detected_type ?? "unknown type",
    },
    {
      k: "Report",
      v: report ? (reportIsDraft ? "Draft" : "Final") : running ? "Pending" : "None",
      sm: true,
      sub: report ? semanticLabel(report.semanticAudit) : "not written yet",
    },
  ];

  return (
    <main className="page">
      <div className="crumbs">
        <Link href="/">← All documents</Link>
        <span className="mono">/ {id}</span>
      </div>

      <div className="doc-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="doc-title">{doc.file_name}</h1>
          <div className="doc-meta">
            <span>
              <b>{doc.declared_type ?? doc.detected_type ?? "unknown type"}</b>
              {doc.type_confidence != null ? ` · ${doc.type_confidence.toFixed(2)} confidence` : ""}
            </span>
            <span>{doc.page_count || "?"} pages</span>
            <span>{data.blockCount} blocks</span>
            <span>{data.segmentCount} segments</span>
            <span>Uploaded {formatDate(doc.created_at)}</span>
            {doc.gate_status ? <span>Gate: {doc.gate_status}</span> : null}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className={`badge ${BADGE[doc.status] ?? "neutral"}`}>
              {STATUS_LABEL[doc.status] ?? doc.status}
            </span>
            {report ? (
              <span className={`badge ${reportIsDraft ? "draft" : "ok"}`}>
                {reportIsDraft ? "Report draft" : "Report final"}
              </span>
            ) : null}
            {report?.semanticAudit ? (
              <span
                className={`badge ${
                  report.semanticAudit === "complete"
                    ? "ok"
                    : report.semanticAudit === "pending"
                      ? "draft"
                      : "warn"
                }`}
              >
                {semanticLabel(report.semanticAudit)}
              </span>
            ) : null}
            {report?.provider ? <span className="chip">{report.provider}</span> : null}
          </div>
        </div>

        <div className="doc-actions">
          {hasDeliverable ? (
            <a className="btn big" href={`/api/documents/${id}/word`}>
              Download Word file
            </a>
          ) : null}
          {running ? (
            <button className="btn danger" type="button" onClick={() => void cancelRun()} disabled={cancelling}>
              {cancelling ? "Stopping…" : "Cancel run"}
            </button>
          ) : (
            <button className="btn ghost" type="button" onClick={() => void startRun()} disabled={starting}>
              {starting ? "Starting…" : hasDeliverable ? "Translate again" : "Start translation"}
            </button>
          )}
        </div>
      </div>

      <div className="statgrid">
        {statCards.map((s) => (
          <div className="stat-card" key={s.k}>
            <div className="stat-k">{s.k}</div>
            <div className={`stat-v${s.sm ? " sm" : ""}`}>{s.v}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {error ? <div className="error">{error}</div> : null}

      {neverRun ? (
        <div className="notice">
          This document is uploaded but has not been translated yet. Start the translation to
          produce the Word file and the review report.
        </div>
      ) : null}

      {running ? (
        <div className="run-panel">
          <div className="run-head">
            <strong>
              {data.queuePosition > 0 ? STATUS_LABEL.queued : "Pipeline running"}
            </strong>
            <span>
              {data.job?.stage ?? doc.stage ?? "—"} · {data.job?.pct ?? 0}%
            </span>
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${data.job?.pct ?? 5}%` }} />
          </div>
          <div className="progress-line">
            <span>
              {data.queuePosition > 0
                ? data.queuePosition === 1
                  ? "Next in line for the translator."
                  : `${data.queuePosition - 1} file(s) ahead of this one.`
                : data.job?.detail ?? "Working…"}
            </span>
            <span>Refreshes automatically</span>
          </div>
          {hasDeliverable ? (
            <div className="ok-line">
              The Word file is already available.{" "}
              <a href={`/api/documents/${id}/word`}>Download it</a> while the report finishes.
            </div>
          ) : null}
        </div>
      ) : null}

      {data.job?.status === "failed" ? (
        <div className="error">
          Pipeline stopped: {data.job.error}
          {hasDeliverable ? " The Word file produced before the stop is still downloadable." : ""}
        </div>
      ) : null}

      {reportIsDraft ? (
        <div className="notice">
          This report is a draft written from the deterministic checks the moment the translation
          was saved. The meaning-level review is still running; this page updates itself and the
          report will be replaced with the final version.
        </div>
      ) : null}

      <div className="tabs" role="tablist" aria-label="Document views">
        {(
          [
            ["overview", "Overview", null],
            ["findings", "Findings", reportFindings.length],
            ["segments", "Segments", data.segmentCount],
            ["report", "Report", null],
          ] as Array<[Tab, string, number | null]>
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
            {count != null ? <span className="tab-count">{count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          {finished && hasDeliverable ? (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Deliverables</h2>
                  <div className="panel-sub">
                    {doc.status === "translated"
                      ? "The English translation is editable in Word. Verification and the report are still finishing."
                      : "The English translation, editable in Word, plus the audit trail."}
                  </div>
                </div>
                <a className="btn" href={`/api/documents/${id}/word`}>
                  Download Word
                </a>
              </div>
              <div className="download-grid">
                <a className="btn ghost small" href={`/api/documents/${id}/export/pdf?kind=translation`}>
                  Translation .pdf
                </a>
                <a className="btn ghost small" href={`/api/documents/${id}/export/txt?kind=translation`}>
                  Translation .txt
                </a>
                {report ? (
                  <>
                    <a className="btn" href={`/api/documents/${id}/export/docx`}>
                      Title Clearance Report .docx
                    </a>
                    <a className="btn ghost small" href={`/api/documents/${id}/export/pdf`}>
                      Report .pdf
                    </a>
                    <a className="btn ghost small" href={`/api/documents/${id}/export/txt`}>
                      Report .txt
                    </a>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          {report ? (
            <>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Fidelity indicator</h2>
                    <div className="panel-sub">{report.fidelityIndicator.interpretation}</div>
                  </div>
                  <span className={`badge ${grade === "green" ? "ok" : grade === "red" ? "bad" : "warn"}`}>
                    {pct(report.fidelityIndicator.value)} · {grade?.toUpperCase()}
                  </span>
                </div>
                <div className="fidelity-grid">
                  {Object.entries(report.fidelityIndicator.components).map(([k, v]) => (
                    <div className="fidelity-row" key={k}>
                      <span className="fidelity-label">{COMPONENT_LABEL[k] ?? k}</span>
                      <span className="fidelity-value">{pct(v)}</span>
                      <span className="fidelity-track">
                        <span
                          className={`fidelity-fill${v < 0.6 ? " bad" : v < 0.8 ? " warn" : ""}`}
                          style={{ width: `${Math.max(1, Math.min(100, v * 100))}%` }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
                <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>
                  An automated review-prioritisation score, not a measurement of translation
                  accuracy. The grade bands are a reading aid, not a certification.
                </p>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>What was checked</h2>
                    <div className="panel-sub">
                      Deterministic checks compare every datum and term; the semantic pass reads the
                      meaning where it can.
                    </div>
                  </div>
                </div>
                <div className="check-list">
                  {report.mechanicalChecks.map((c) => (
                    <div className="check-row" key={c.check}>
                      <span
                        className={`check-mark ${
                          c.pending ? "pending" : c.passed ? "pass" : "flag"
                        }`}
                        aria-label={c.pending ? "pending" : c.passed ? "passed" : "flagged"}
                      >
                        {c.pending ? "…" : c.passed ? "✓" : "!"}
                      </span>
                      <div>
                        <div className="check-name">{c.check}</div>
                        <div className="check-desc">{c.description}</div>
                      </div>
                      <span className="check-count">{c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="panel">
              <h2>Report</h2>
              <div className="empty">
                {running
                  ? "The report is being written. The Word file is handed over first; the report follows here."
                  : "No report has been written for this document yet."}
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Where the time went</h2>
                <div className="panel-sub">
                  Each pipeline stage, recorded as it ran. Useful when a large file feels stuck.
                </div>
              </div>
            </div>
            {timings.length === 0 ? (
              <div className="empty">No timings recorded yet.</div>
            ) : (
              <div className="timeline">
                {timings.map((t, i) => (
                  <div className="timeline-row" key={`${t.stage}-${i}`}>
                    <span className="timeline-stage">{t.stage}</span>
                    <span className="timeline-bar">
                      <span
                        style={{
                          width: `${Math.max(3, Math.min(100, ((t.durationMs ?? 0) / maxTiming) * 100))}%`,
                        }}
                      />
                    </span>
                    <span className="timeline-time">{formatDuration(t.durationMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {tab === "findings" ? (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Findings</h2>
              <div className="panel-sub">
                Each finding is a prompt for human review. A clean automated pass is not a
                certification.
              </div>
            </div>
            {filteredFindings.length > 25 ? (
              <button className="btn ghost small" type="button" onClick={() => setShowAllFindings((v) => !v)}>
                {showAllFindings ? "Show fewer" : `Show all ${filteredFindings.length}`}
              </button>
            ) : null}
          </div>

          {reportFindings.length === 0 ? (
            <div className="empty">
              {report
                ? "No findings were raised. Read the translation against the original before signing it."
                : running
                  ? "Findings appear as soon as the checks finish."
                  : "No findings recorded for this document."}
            </div>
          ) : (
            <>
              <div className="severity-filter">
                {["all", ...SEVERITY_ORDER].map((s) => {
                  const n = s === "all" ? reportFindings.length : data.findingsBySeverity[s] ?? 0;
                  if (s !== "all" && n === 0) return null;
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`filter-pill${severityFilter === s ? " active" : ""}`}
                      onClick={() => setSeverityFilter(s)}
                    >
                      {s === "all" ? "All" : s} · {n}
                    </button>
                  );
                })}
              </div>

              {visibleFindings.map((f) => (
                <div className={`finding ${f.severity}`} key={f.id}>
                  <div className="finding-head">
                    <span className={`badge ${severityClass(f.severity)}`}>{f.severity}</span>
                    <span className="finding-title">{f.title}</span>
                    <span className="finding-loc">
                      {f.check} · {f.location}
                    </span>
                  </div>
                  <div className="finding-body">{f.detail}</div>
                  {f.sourceExcerpt ? (
                    <div className="excerpt src">
                      <span className="lbl">Gujarati source</span>
                      <span lang="gu">{f.sourceExcerpt}</span>
                    </div>
                  ) : null}
                  {f.targetExcerpt ? (
                    <div className="excerpt">
                      <span className="lbl">English target</span>
                      {f.targetExcerpt}
                    </div>
                  ) : null}
                  {f.suggestion ? (
                    <div className="excerpt">
                      <span className="lbl">Suggestion</span>
                      {f.suggestion}
                    </div>
                  ) : null}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}

      {tab === "segments" ? (
        <div className="panel">
          <div className="panel-head">
            <div>
              <h2>Segment review</h2>
              <div className="panel-sub">
                Source and English side by side, in document order. Confidence is the
                translator&apos;s own signal, not a correctness score.
              </div>
            </div>
            {data.segments.length > 25 ? (
              <button className="btn ghost small" type="button" onClick={() => setShowAllSegments((v) => !v)}>
                {showAllSegments ? "Show fewer" : `Show all ${data.segments.length}`}
              </button>
            ) : null}
          </div>

          {data.segments.length === 0 ? (
            <div className="empty">
              {running ? "Segments appear as the translation is written." : "No translated segments yet."}
            </div>
          ) : (
            segments.map((s) => (
              <div className="segment" key={s.index}>
                <div className="seg-head">
                  <b>#{s.index}</b>
                  <span>{s.blockId}</span>
                  <span>confidence {s.confidence.toFixed(2)}</span>
                </div>
                <div className="seg-source" lang="gu">
                  <span className="seg-label">Gujarati source</span>
                  {s.source}
                </div>
                <div className="seg-target">
                  <span className="seg-label">English target</span>
                  {s.target || <em className="muted">empty</em>}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === "report" ? (
        <>
          {report ? (
            <>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <h2>Review summary</h2>
                    <div className="panel-sub">
                      {report.docTypeLabel} · {report.pageCount} page(s) · generated{" "}
                      {formatDate(report.generatedAt)}
                    </div>
                  </div>
                  <span className={`badge ${reportIsDraft ? "draft" : "ok"}`}>
                    {reportIsDraft ? "Draft" : "Final"}
                  </span>
                </div>
                <div className="prose">
                  <p>{report.narrative.executiveSummary}</p>
                  {report.narrative.reviewFocus.length ? (
                    <>
                      <span className="lbl">Focus your review on</span>
                      <ul>
                        {report.narrative.reviewFocus.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {report.narrative.limitations.length ? (
                    <>
                      <span className="lbl">Limitations</span>
                      <ul>
                        {report.narrative.limitations.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <span className="lbl">Recommended action</span>
                  <p>{report.narrative.recommendedAction}</p>
                </div>
                <div className="download-grid">
                  <a className="btn ghost small" href={`/api/documents/${id}/export/docx`}>
                    Report .docx
                  </a>
                  <a className="btn ghost small" href={`/api/documents/${id}/export/pdf`}>
                    Report .pdf
                  </a>
                  <a className="btn ghost small" href={`/api/documents/${id}/export/txt`}>
                    Report .txt
                  </a>
                  <a className="btn ghost small" href={`/api/documents/${id}/export/docx?kind=tcr`}>
                    Translation comparison .docx
                  </a>
                </div>
              </div>

              <div className="panel">
                <h2>Certification</h2>
                <div className="prose">
                  <p>
                    This report is not a certificate. It records what automated checks found so a
                    qualified person can review faster. Certification requires a named translator or
                    advocate to compare the English against the Gujarati original and sign the
                    certification block.
                  </p>
                  <p className="muted small" style={{ marginBottom: 0 }}>
                    Report status: {report.status ?? "final"} ·{" "}
                    {report.semanticAudit ? semanticLabel(report.semanticAudit) : "meaning check not recorded"} · Source
                    SHA-256 <span className="mono">{report.sourceSha256.slice(0, 16)}…</span>
                  </p>
                </div>
              </div>
            </>
          ) : (
            <div className="panel">
              <h2>Report</h2>
              <div className="empty">
                {running
                  ? "A draft report appears as soon as the translation is saved; the final report follows the meaning-level review."
                  : "No report has been written for this document yet. Start a translation to produce one."}
              </div>
            </div>
          )}
        </>
      ) : null}

      <div className="disclaimer">
        <strong>Non-certified translation.</strong> This AI-generated translation is provided for
        document-processing and review purposes and should be checked by a qualified legal
        professional where it is relied on. It is not a certified or court-certified translation
        unless separately verified and certified by an authorised professional.
      </div>
    </main>
  );
}

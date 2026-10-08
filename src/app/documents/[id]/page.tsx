"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
}

interface Report {
  generatedAt: string;
  docTypeLabel: string;
  provider: string;
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

interface Detail {
  document: DocumentRow;
  job: JobState | null;
  report: Report | null;
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

const SEVERITY_ORDER = ["critical", "major", "minor", "info"];

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

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showAllSegments, setShowAllSegments] = useState(false);
  const [showAllFindings, setShowAllFindings] = useState(false);
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
  const running = jobStatus === "queued" || jobStatus === "running" || data?.document.status === "running";

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

  if (error && !data) {
    return (
      <main>
        <div className="crumbs">
          <Link href="/">← All documents</Link>
        </div>
        <div className="error">{error}</div>
      </main>
    );
  }

  if (!data || !id) {
    return <main className="empty">Loading…</main>;
  }

  const doc = data.document;
  const report = data.report;
  const grade = report?.fidelityIndicator.grade ?? "yellow";
  const severityCounts = SEVERITY_ORDER.map(
    (s) => [s, data.findingsBySeverity[s] ?? 0] as const,
  ).filter(([, n]) => n > 0);

  const finished = doc.status === "ready" || doc.status === "blocked" || doc.status === "failed";
  const neverRun = doc.status === "uploaded" && !data.job;

  const segments = showAllSegments ? data.segments : data.segments.slice(0, 25);
  const reportFindings = report?.findings ?? [];
  const visibleFindings = showAllFindings ? reportFindings : reportFindings.slice(0, 25);

  return (
    <main>
      <div className="crumbs">
        <Link href="/">← All documents</Link> <span className="mono">/ {id}</span>
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h1 style={{ margin: 0 }}>{doc.file_name}</h1>
            <div className="muted small">
              {doc.declared_type ?? doc.detected_type ?? "unknown type"}
              {doc.type_confidence != null ? ` · confidence ${doc.type_confidence.toFixed(3)}` : ""} ·{" "}
              {doc.page_count || "?"} pages · {data.blockCount} blocks · {data.segmentCount} segments ·
              uploaded {formatDate(doc.created_at)}
            </div>
          </div>
          <div className="row">
            <span className={`badge ${BADGE[doc.status] ?? "neutral"}`}>{doc.status}</span>
            <span className={`badge ${doc.gate_status === "pass" ? "ok" : "warn"}`}>
              gate: {doc.gate_status}
            </span>
          </div>
        </div>

        {error ? <div className="error">{error}</div> : null}

        {neverRun ? (
          <div style={{ marginTop: 16 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              The document is uploaded but has not been translated yet.
            </p>
            <button type="button" onClick={() => void startRun()} disabled={starting}>
              {starting ? "Starting…" : "Start translation"}
            </button>
          </div>
        ) : null}

        {running ? (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <strong>{data.job?.detail ?? "Working…"}</strong>
              <span className="mono small">
                stage: {data.job?.stage ?? doc.stage ?? "—"} · {data.job?.pct ?? 0}%
              </span>
            </div>
            <div className="progress">
              <div style={{ width: `${data.job?.pct ?? 5}%` }} />
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              This page refreshes automatically while the pipeline runs. A full document can take
              several minutes.
            </p>
          </div>
        ) : null}

        {data.job?.status === "failed" ? (
          <div className="error">Pipeline failed: {data.job.error}</div>
        ) : null}

        {finished && !running && doc.status !== "failed" ? (
          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" onClick={() => void startRun()} disabled={starting}>
              {starting ? "Starting…" : "Re-run pipeline"}
            </button>
            <a className="btn ghost" href={`/api/documents/${id}/export/txt`}>
              Report .txt
            </a>
            <a className="btn ghost" href={`/api/documents/${id}/export/pdf`}>
              Report .pdf
            </a>
            <a className="btn ghost" href={`/api/documents/${id}/export/docx`}>
              Report .docx
            </a>
          </div>
        ) : null}

        {finished && !running && doc.status !== "failed" ? (
          <div className="row" style={{ marginTop: 8 }}>
            <a className="btn ghost" href={`/api/documents/${id}/export/txt?kind=translation`}>
              Translation .txt
            </a>
            <a className="btn ghost" href={`/api/documents/${id}/export/pdf?kind=translation`}>
              Translation .pdf
            </a>
            <a className="btn ghost" href={`/api/documents/${id}/export/docx?kind=translation`}>
              Translation .docx
            </a>
          </div>
        ) : null}

        {finished && !running && doc.status !== "failed" ? (
          <div className="row" style={{ marginTop: 8 }}>
            <a className="btn ghost" href={`/api/documents/${id}/export/txt?kind=tcr`}>
              TCR .txt
            </a>
            <a className="btn ghost" href={`/api/documents/${id}/export/pdf?kind=tcr`}>
              TCR .pdf
            </a>
            <a className="btn ghost" href={`/api/documents/${id}/export/docx?kind=tcr`}>
              TCR .docx
            </a>
          </div>
        ) : null}
      </div>

      {report ? (
        <>
          <div className="stats" style={{ marginTop: 16 }}>
            <div className="stat">
              <div className="k">Fidelity indicator</div>
              <div className="v">{pct(report.fidelityIndicator.value)}</div>
            </div>
            <div className="stat">
              <div className="k">Band</div>
              <div className="v">{grade}</div>
            </div>
            <div className="stat">
              <div className="k">Segments</div>
              <div className="v">{report.segmentCount}</div>
            </div>
            <div className="stat">
              <div className="k">Findings</div>
              <div className="v">{reportFindings.length}</div>
            </div>
            <div className="stat">
              <div className="k">Provider</div>
              <div className="v" style={{ fontSize: 16 }}>
                {report.provider}
              </div>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>Fidelity indicator</h2>
            <p>{report.fidelityIndicator.interpretation}</p>
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th style={{ width: 120 }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(report.fidelityIndicator.components).map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="mono">{pct(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              This is an automated quality indicator for review prioritisation. It is not a
              measurement of translation accuracy.
            </p>
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Checks</h2>
            {report.mechanicalChecks.map((c) => (
              <div className="check" key={c.check}>
                <span className={`badge ${c.passed ? "ok" : "bad"}`}>{c.passed ? "PASS" : "FLAG"}</span>
                <div className="name">
                  <div>{c.check}</div>
                  <div className="desc">{c.description}</div>
                </div>
                <span className="mono small">{c.count}</span>
              </div>
            ))}
          </div>

          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Review summary</h2>
            <p>{report.narrative.executiveSummary}</p>
            {report.narrative.reviewFocus.length ? (
              <>
                <div className="lbl">Focus your review on</div>
                <ul>
                  {report.narrative.reviewFocus.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {report.narrative.limitations.length ? (
              <>
                <div className="lbl">Limitations</div>
                <ul>
                  {report.narrative.limitations.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <div className="lbl">Recommended action</div>
            <p>{report.narrative.recommendedAction}</p>
          </div>
        </>
      ) : null}

      {severityCounts.length ? (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Findings by severity</h2>
          <div className="row">
            {severityCounts.map(([s, n]) => (
              <span
                key={s}
                className={`badge ${s === "critical" ? "bad" : s === "major" || s === "minor" ? "warn" : "neutral"}`}
              >
                {s}: {n}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {reportFindings.length ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Findings</h2>
            {reportFindings.length > 25 ? (
              <button className="ghost" type="button" onClick={() => setShowAllFindings((v) => !v)}>
                {showAllFindings ? "Show fewer" : `Show all ${reportFindings.length}`}
              </button>
            ) : null}
          </div>
          <div style={{ marginTop: 12 }}>
            {visibleFindings.map((f) => (
              <div className={`finding ${f.severity}`} key={f.id}>
                <div className="row" style={{ gap: 8 }}>
                  <span className={`badge ${f.severity === "critical" ? "bad" : "warn"}`}>
                    {f.severity}
                  </span>
                  <strong>{f.title}</strong>
                  <span className="muted small mono">
                    {f.check} · {f.location}
                  </span>
                </div>
                <div className="small">{f.detail}</div>
                {f.sourceExcerpt ? (
                  <div className="small muted" style={{ marginTop: 6 }}>
                    <span className="lbl">source</span>
                    <div>{f.sourceExcerpt}</div>
                  </div>
                ) : null}
                {f.targetExcerpt ? (
                  <div className="small muted">
                    <span className="lbl">target</span>
                    <div>{f.targetExcerpt}</div>
                  </div>
                ) : null}
                {f.suggestion ? (
                  <div className="small" style={{ marginTop: 6 }}>
                    <span className="lbl">suggestion</span>
                    <div>{f.suggestion}</div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {data.segments.length ? (
        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Segment review</h2>
            {data.segments.length > 25 ? (
              <button className="ghost" type="button" onClick={() => setShowAllSegments((v) => !v)}>
                {showAllSegments ? "Show fewer" : `Show all ${data.segments.length}`}
              </button>
            ) : null}
          </div>
          <div style={{ marginTop: 12 }}>
            {segments.map((s) => (
              <div className="segment" key={s.index}>
                <div className="idx">
                  #{s.index} · {s.blockId} · confidence {s.confidence.toFixed(2)}
                </div>
                <div className="lbl" style={{ marginTop: 6 }}>
                  Gujarati source
                </div>
                <div className="src" lang="gu">
                  {s.source}
                </div>
                <div className="lbl" style={{ marginTop: 8 }}>
                  English target
                </div>
                <div className="tgt">{s.target || <em className="muted">empty</em>}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="disclaimer">
        <strong>Non-certified translation.</strong> This AI-generated translation is provided for
        informational and document-processing purposes and should be reviewed by a qualified legal
        professional where legally required. It does not constitute a certified or court-certified
        translation unless separately verified and certified by an authorized professional.
      </div>
    </main>
  );
}

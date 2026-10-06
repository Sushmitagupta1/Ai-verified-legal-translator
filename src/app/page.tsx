"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface DocRow {
  id: string;
  file_name: string;
  size_bytes: number;
  status: string;
  stage: string | null;
  detected_type: string | null;
  declared_type: string | null;
  page_count: number;
  fidelity: number | null;
  fidelity_band: string | null;
  gate_status: string;
  error: string | null;
  created_at: string;
}

const BADGE: Record<string, string> = {
  ready: "ok",
  blocked: "bad",
  failed: "bad",
  running: "warn",
  translated: "neutral",
  uploaded: "neutral",
  unknown: "neutral",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HomePage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declaredType, setDeclaredType] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/documents", { cache: "no-store" });
      const data = await res.json();
      setDocuments(data.documents ?? []);
      if (!res.ok) setError(data.error ?? "Could not load documents.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = documents.some((d) => d.status === "running" || d.status === "queued");
  useEffect(() => {
    if (!active) return;
    timer.current = setTimeout(() => void load(), 2000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, documents, load]);

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      if (declaredType) form.set("type", declaredType);
      const res = await fetch("/api/documents", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      router.push(`/documents/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setUploading(false);
    }
  }

  return (
    <main>
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Upload a document</h1>
        <form onSubmit={onUpload}>
          <div className="dropzone">
            <div className="muted small">Gujarati legal documents — .docx, .pdf, .txt, .md, .html</div>
            <input ref={inputRef} type="file" accept=".docx,.pdf,.txt,.md,.html" />
            <div className="row" style={{ justifyContent: "center" }}>
              <label className="field">
                Document type
                <select value={declaredType} onChange={(e) => setDeclaredType(e.target.value)}>
                  <option value="">Auto-detect</option>
                  <option value="affidavit">Affidavit</option>
                  <option value="contract">Contract</option>
                  <option value="property_document">Property document</option>
                  <option value="court_filing">Court filing</option>
                  <option value="notice">Notice</option>
                  <option value="power_of_attorney">Power of attorney</option>
                </select>
              </label>
              <button type="submit" disabled={uploading} style={{ marginTop: 16 }}>
                {uploading ? "Uploading…" : "Upload"}
              </button>
            </div>
          </div>
        </form>
        {error ? <div className="error">{error}</div> : null}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>Documents</h1>
          <button className="ghost" type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="empty">Loading…</div>
        ) : documents.length === 0 ? (
          <div className="empty">No documents yet. Upload one above to get started.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Pages</th>
                  <th>Status</th>
                  <th>Indicator</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={`/documents/${d.id}`}>{d.file_name}</Link>
                      <div className="muted small mono">{d.id}</div>
                    </td>
                    <td>{d.detected_type ?? d.declared_type ?? "—"}</td>
                    <td className="mono">{d.page_count || "—"}</td>
                    <td>
                      <span className={`badge ${BADGE[d.status] ?? "neutral"}`}>{d.status}</span>
                      {d.error ? <div className="muted small">{d.error.slice(0, 90)}</div> : null}
                    </td>
                    <td className="mono">
                      {d.fidelity != null ? (d.fidelity * 100).toFixed(1) : "—"}
                      {d.fidelity_band ? ` (${d.fidelity_band})` : ""}
                    </td>
                    <td className="small muted">{formatDate(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted small" style={{ marginTop: 8 }}>
          {formatBytes(documents.reduce((n, d) => n + d.size_bytes, 0))} across {documents.length}{" "}
          document(s)
        </div>
      </div>
    </main>
  );
}

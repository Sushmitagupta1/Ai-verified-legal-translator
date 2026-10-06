import { all, closeDb, get } from "../src/lib/db";

const id = process.argv[2];
if (!id) {
  console.error("usage: npx tsx scripts/status.ts <documentId>");
  process.exit(2);
}

const doc = get(`SELECT id, status, stage, error, fidelity, gate_status, page_count, detected_type FROM documents WHERE id = ?`, id);
console.log("document:", JSON.stringify(doc));

for (const table of ["blocks", "segments", "chunks", "findings", "datums", "pages"]) {
  const n = get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE document_id = ?`, id);
  console.log(`  ${table.padEnd(10)} = ${n?.n ?? 0}`);
}

console.log("jobs:", JSON.stringify(all(
  `SELECT id, status, substr(payload, 1, 200) AS payload, error, attempts, created_at, started_at, finished_at
     FROM jobs WHERE document_id = ? ORDER BY created_at DESC`,
  id,
), null, 1));
console.log("activity:");
for (const row of all<{ action: string; detail: string; created_at: string }>(
  `SELECT action, detail, created_at FROM activity WHERE document_id = ? ORDER BY created_at DESC LIMIT 25`,
  id,
)) {
  console.log(`  ${row.created_at} ${row.action} ${row.detail.slice(0, 140)}`);
}

closeDb();

import path from "node:path";
import fs from "node:fs";

const ROOT = process.cwd();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root: ROOT,
  dataDir: process.env.NYD_DATA_DIR ?? path.join(ROOT, "data"),
  get dbPath() {
    return process.env.NYD_DB_PATH ?? path.join(this.dataDir, "nyayadoot.db");
  },
  get uploadDir() {
    return path.join(this.dataDir, "uploads");
  },
  get exportDir() {
    return path.join(this.dataDir, "exports");
  },
  maxUploadBytes: envInt("NYD_MAX_UPLOAD_MB", 64) * 1024 * 1024,
  maxPages: envInt("NYD_MAX_PAGES", 400),

  /** Target token budget per translation chunk (Gujarati source side). */
  chunkTokenBudget: envInt("NYD_CHUNK_TOKENS", 2600),
  /** Hard ceiling on chunk size so a pathological paragraph cannot overflow the model. */
  chunkHardLimitTokens: envInt("NYD_CHUNK_HARD_TOKENS", 4200),

  /**
   * Below this OCR word-confidence the pipeline refuses to treat extracted text as
   * trustworthy and blocks translation until a human corrects the source text.
   */
  ocrConfidenceFloor: Number(process.env.NYD_OCR_CONFIDENCE_FLOOR ?? 0.72),
  /** Per-page OCR confidence below this marks the page "needs manual source review". */
  ocrPageReviewThreshold: Number(process.env.NYD_OCR_PAGE_REVIEW ?? 0.8),

  llm: {
    provider: process.env.NYD_LLM_PROVIDER ?? "stub",
    model: process.env.NYD_LLM_MODEL ?? "",
    apiKey: process.env.NYD_LLM_API_KEY ?? "",
    baseUrl: process.env.NYD_LLM_BASE_URL ?? "",
    temperature: Number(process.env.NYD_LLM_TEMPERATURE ?? 0),
    maxRetries: envInt("NYD_LLM_RETRIES", 4),
    timeoutMs: envInt("NYD_LLM_TIMEOUT_MS", 120_000),
    /** Judge pass runs at a different (usually stronger) model when configured. */
    judgeModel: process.env.NYD_JUDGE_MODEL ?? "",
  },

  ocr: {
    /** "auto" picks paddle when a local service is configured, else tesseract. */
    provider: process.env.NYD_OCR_PROVIDER ?? "auto",
    paddleUrl: process.env.NYD_PADDLE_URL ?? "",
    tesseractLangs: process.env.NYD_TESSERACT_LANGS ?? "guj+eng",
    /** Rendering DPI used when rasterising a scanned page for OCR. */
    renderDpi: envInt("NYD_RENDER_DPI", 300),
    maxDpi: envInt("NYD_MAX_DPI", 400),
  },

  pipeline: {
    /** Concurrency for independent LLM calls inside a single document job. */
    concurrency: envInt("NYD_CONCURRENCY", 3),
  },
} as const;

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.uploadDir, config.exportDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
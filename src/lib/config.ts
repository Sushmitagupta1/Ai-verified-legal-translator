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

  /**
   * Target token budget per translation chunk (Gujarati source side).
   *
   * 1400 is what a local model on an 8 GiB GPU actually manages. Measured on a
   * 23-page sale deed, translated by gemma3:12b and judged by qwen2.5:14b:
   * 1400-token chunks produced 155 findings and a 0.935 fidelity score in
   * 32 minutes, while 1800-token chunks produced 240 findings and a 0.774
   * score in 54 minutes. A bigger chunk asks for a longer reply, and the
   * longer the reply the more the model drifts, the more it is re-read, and
   * the more likely a single segment is dropped.
   */
  chunkTokenBudget: envInt("NYD_CHUNK_TOKENS", 1400),
  /**
   * Maximum segments per translation chunk.
   *
   * Token budget alone does not bound the *output*: each returned segment adds
   * ~45 tokens of JSON boilerplate, so a budget-satisfying chunk of 130 short
   * segments asks a local 14B model for ~8k output tokens. It degenerates into
   * a repetition loop and Ollama aborts with "token repeat limit reached",
   * which arrives as a short, off-schema response.
   *
   * The cookie jars to a 4096-token context too: a Q4 14B on an 8 GiB GPU has
   * no room for a bigger num_ctx, so prompt + response must both fit 4096.
   */
  chunkMaxSegments: envInt("NYD_CHUNK_MAX_SEGMENTS", 14),

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
    /**
     * Per-request timeout.
     *
     * A local model translating a 1,400-token chunk emits several hundred JSON
     * tokens at 10-30 tok/s, so a chunk legitimately takes two to five minutes
     * on a single consumer GPU. A 300s cap does not make a slow chunk fast, it
     * aborts a healthy one - the request is cancelled mid-generation, the reply
     * is unparseable, and every segment in that chunk is reported as an
     * omission. The timeout must outlast the slowest realistic chunk, not the
     * fastest one.
     */
    timeoutMs: envInt("NYD_LLM_TIMEOUT_MS", 600_000),
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
    /**
     * Concurrency for independent LLM calls inside a single document job.
     *
     * Defaults to 1. Parallel chunks only pay off when the provider has spare
     * capacity to serve them at the same rate - a hosted API, for instance.
     * A local model on one GPU does not: the requests queue behind the same
     * hardware, so N parallel chunks each run N times slower and every one of
     * them is more likely to cross the per-request timeout, which is how a
     * whole document comes back with untranslated segments. Raise
     * NYD_CONCURRENCY for hosted providers.
     */
    concurrency: envInt("NYD_CONCURRENCY", 1),
  },
} as const;

export function ensureDirs(): void {
  for (const dir of [config.dataDir, config.uploadDir, config.exportDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
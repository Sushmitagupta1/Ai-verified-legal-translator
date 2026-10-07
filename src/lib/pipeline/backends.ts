import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsSync from "node:fs";
import { config } from "../config";

const execFileAsync = promisify(execFile);

/**
 * External-process backends (PDF rasterisation, OCR) behind a narrow interface.
 *
 * Every method is expected to fail *loudly*. A backend that cannot do its job
 * returns an error rather than empty text, because empty text would flow through
 * the pipeline and produce a translation of nothing that still looks successful.
 */

export interface OcrResult {
  text: string;
  /** Mean word confidence in [0,1]. */
  confidence: number;
  engine: string;
  warnings: string[];
}

export interface OcrBackend {
  name: string;
  available: boolean;
  ocrImage(buffer: Buffer, mime: string): Promise<OcrResult>;
}

export interface PdfBackend {
  /** Rasterise one 1-based page to PNG at the configured DPI. */
  renderPageToImage(buffer: Buffer, pageNumber: number, dpi: number): Promise<Buffer>;
}

// ── OCR: PaddleOCR HTTP service ───────────────────────────────────────────────

/**
 * PaddleOCR over HTTP.
 *
 * PaddleOCR is the default when configured because on Gujarati it reported a
 * character error rate around 4.5% versus roughly 18% for Tesseract in the
 * literature we reviewed. That difference is decisive here: OCR errors become
 * translation errors, and in a legal document a misread digit or name is a
 * critical finding the reviewer must chase.
 */
class PaddleOcrBackend implements OcrBackend {
  readonly name = "paddle";

  constructor(private readonly baseUrl: string) {}

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  async ocrImage(buffer: Buffer): Promise<OcrResult> {
    if (!this.available) throw new Error("PaddleOCR backend has no NYD_PADDLE_URL configured");

    const res = await fetch(new URL("ocr", ensureTrailingSlash(this.baseUrl)), {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PaddleOCR ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      text?: string;
      confidence?: number;
      results?: Array<{ text?: string; confidence?: number }>;
    };

    const warnings: string[] = [];
    let text = data.text ?? "";
    let confidence = data.confidence;

    if (!text && Array.isArray(data.results) && data.results.length > 0) {
      text = data.results.map((r) => r.text ?? "").join("\n");
      const scores = data.results.map((r) => r.confidence ?? 0).filter((c) => c > 0);
      confidence = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    }

    if (confidence === undefined) {
      warnings.push("PaddleOCR returned no confidence scores; confidence-based gating is unavailable for this page.");
      confidence = 1;
    }

    if (confidence < config.ocrConfidenceFloor) {
      warnings.push(
        `OCR confidence ${(confidence * 100).toFixed(1)}% is below the ${(config.ocrConfidenceFloor * 100).toFixed(0)}% floor. ` +
          "Correct the source text before relying on the translation.",
      );
    }

    return { text, confidence, engine: this.name, warnings };
  }
}

// ── OCR: Tesseract CLI ────────────────────────────────────────────────────────

/**
 * Tesseract via its CLI.
 *
 * Kept as a fallback because it is the only option that works with no extra
 * service, but its Gujarati accuracy is materially worse. When it is selected the
 * report carries a lower starting confidence so the reviewer knows the source text
 * itself is a risk.
 */
class TesseractCliBackend implements OcrBackend {
  readonly name = "tesseract";

  get available(): boolean {
    return this.which !== null;
  }

  private which: string | null = null;

  constructor() {
    this.which = findExecutable(process.platform === "win32" ? "tesseract.exe" : "tesseract");
  }

  async ocrImage(buffer: Buffer, mime: string): Promise<OcrResult> {
    if (!this.which) {
      throw new Error(
        "No OCR backend is available. Install Tesseract (with the Gujarati language pack) or set NYD_PADDLE_URL to a PaddleOCR service. " +
          "Refusing to translate from an empty page rather than guessing.",
      );
    }

    const langs = config.ocr.tesseractLangs;
    const stdout = await runTesseract(this.which, buffer, langs, mime);

    const text = stdout.text;
    const confidence = stdout.conf >= 0 ? stdout.conf / 100 : 0;
    const warnings = [
      `OCR performed by Tesseract (${langs}). Tesseract accuracy on Gujarati is materially lower than PaddleOCR; ` +
        "check names and numbers against the original.",
    ];
    if (confidence > 0 && confidence < config.ocrConfidenceFloor) {
      warnings.push(`OCR confidence ${(confidence * 100).toFixed(1)}% is below the configured floor.`);
    }

    return { text, confidence, engine: this.name, warnings };
  }
}

/**
 * When nothing is configured we still need a decision, not a silent pass. The
 * `none` backend refuses, and the caller turns that into a user-visible action.
 */
class UnavailableOcrBackend implements OcrBackend {
  readonly name = "none";
  readonly available = false;

  async ocrImage(): Promise<OcrResult> {
    throw new Error(
      "This page is a scanned image and no OCR backend is configured. " +
        "Set NYD_PADDLE_URL to a PaddleOCR service, install Tesseract, or upload a text-layer PDF.",
    );
  }
}

// ── PDF rasterisation ────────────────────────────────────────────────────────

/**
 * Render a PDF page to PNG.
 *
 * pdfjs can render in Node but needs a canvas implementation. `canvas` is an
 * optional dependency: when it is absent we shell out to `pdftoppm` (poppler),
 * which is what most Linux CI images already have.
 */
class PdfRenderBackend implements PdfBackend {
  async renderPageToImage(buffer: Buffer, pageNumber: number, dpi: number): Promise<Buffer> {
    const effectiveDpi = Math.min(dpi, config.ocr.maxDpi);

    const viaCanvas = await tryCanvasRender(buffer, pageNumber, effectiveDpi);
    if (viaCanvas) return viaCanvas;

    const viaPoppler = await tryPopplerRender(buffer, pageNumber, effectiveDpi);
    if (viaPoppler) return viaPoppler;

    throw new Error(
      "Cannot rasterise a scanned page: neither the optional `canvas` module nor `pdftoppm` (poppler-utils) is available. " +
        "Install one of them to process scanned PDFs.",
    );
  }
}

/** Minimal shape of the optional `canvas` module; it ships no usable types here. */
interface CanvasLike {
  createCanvas(w: number, h: number): {
    getContext(t: "2d"): unknown;
    toBuffer(mime: string): Buffer;
  };
}

/** Minimal shape of pdfjs's legacy build, whose `canvas` render param is version-specific. */
interface PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfjsDoc> };
}
interface PdfjsDoc {
  numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}
interface PdfjsPage {
  getViewport(opts: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: Array<Record<string, unknown>> }>;
  render(params: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}

async function loadPdfjs(): Promise<PdfjsLike> {
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike;
}

async function tryCanvasRender(buffer: Buffer, pageNumber: number, dpi: number): Promise<Buffer | null> {
  let canvas: CanvasLike;
  try {
    // `canvas` is optional and untyped here, so it is loaded through a variable
    // specifier to keep the module optional rather than a hard build dependency.
    const spec = "canvas";
    canvas = (await import(/* @vite-ignore */ spec)) as CanvasLike;
  } catch {
    return null;
  }

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const c = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: c.getContext("2d"), viewport, canvas: c }).promise;
    return c.toBuffer("image/png");
  } finally {
    await doc.destroy();
  }
}

async function tryPopplerRender(buffer: Buffer, pageNumber: number, dpi: number): Promise<Buffer | null> {
  const bin = findExecutable(process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm");
  if (!bin) return null;

  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nyd-pdf-"));
  try {
    // pdftoppm takes a file path, not stdin, and "-" output would collide across
    // parallel page renders, so every render gets its own temp directory.
    const src = path.join(dir, "in.pdf");
    const prefix = path.join(dir, "page");
    await fs.writeFile(src, buffer);
    await execFileAsync(
      bin,
      ["-png", "-r", String(dpi), "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", src, prefix],
      { maxBuffer: 512 * 1024 * 1024 },
    );
    return await fs.readFile(`${prefix}.png`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findExecutable(name: string): string | null {
  const pathVar = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of pathVar.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      // The callers already include the extension on Windows ("tesseract.exe");
      // appending PATHEXT again would probe "tesseract.exe.EXE" and never match.
      const candidate =
        name.toLowerCase().endsWith(ext.toLowerCase()) || !ext
          ? pathJoin(dir, name)
          : pathJoin(dir, `${name}${ext}`);
      try {
        if (fsSync.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function pathJoin(dir: string, name: string): string {
  const sep = process.platform === "win32" ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

interface TesseractStdout {
  text: string;
  conf: number;
}

/**
 * Parse tesseract TSV output.
 *
 * Word-level confidence is averaged rather than taken from the summary line: the
 * summary is skewed by large blank regions and short tables, and for legal text a
 * mean over actual words is the number that predicts whether names and digits are
 * trustworthy.
 */
export function parseTesseractTsv(tsv: string): TesseractStdout {
  const lines = tsv.split(/\r?\n/);
  const words: string[] = [];
  const scores: number[] = [];

  for (const line of lines.slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const text = (cols[11] ?? "").trim();
    const conf = Number.parseFloat(cols[10] ?? "");
    if (!text || !Number.isFinite(conf)) continue;
    if (conf < 0) continue;
    words.push(text);
    scores.push(conf);
  }

  return {
    text: words.join(" "),
    conf: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : -1,
  };
}

async function runTesseract(bin: string, buffer: Buffer, langs: string, mime: string): Promise<TesseractStdout> {
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nyd-ocr-"));
  const ext = mime.includes("png") ? "png" : mime.includes("tif") ? "tif" : "png";
  const img = path.join(dir, `page.${ext}`);
  try {
    await fs.writeFile(img, buffer);
    // TSV is enabled through the `-c` parameter rather than the `tsv`
    // configfile, because configfiles are looked up inside the same tessdata
    // tree as the traineddata. When TESSDATA_PREFIX is overridden (which is how
    // packaged deployments carry extra language packs) that tree has no configs,
    // so the configfile would silently fail and Tesseract would fall back to
    // plain-text output that the tab-based parser below cannot read.
    const { stdout } = await execFileAsync(
      bin,
      [img, "stdout", "-l", langs, "--psm", "3", "-c", "tessedit_create_tsv=1"],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    return parseTesseractTsv(stdout);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Selection ────────────────────────────────────────────────────────────────

function selectOcr(): OcrBackend {
  const requested = config.ocr.provider.toLowerCase();

  if (requested === "paddle") {
    if (!config.ocr.paddleUrl) {
      throw new Error("NYD_OCR_PROVIDER=paddle but NYD_PADDLE_URL is not set.");
    }
    return new PaddleOcrBackend(config.ocr.paddleUrl);
  }
  if (requested === "tesseract") return new TesseractCliBackend();

  const paddle = new PaddleOcrBackend(config.ocr.paddleUrl);
  if (paddle.available) return paddle;
  const tess = new TesseractCliBackend();
  if (tess.available) return tess;

  return new UnavailableOcrBackend();
}

export const BACKEND = {
  ocr: selectOcr(),
  pdf: new PdfRenderBackend(),
};

export function describeBackends(): { ocr: string; ocrAvailable: boolean } {
  return { ocr: BACKEND.ocr.name, ocrAvailable: BACKEND.ocr.available };
}
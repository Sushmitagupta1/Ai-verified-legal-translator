# Nyayadoot

AI-assisted **Gujarati → English legal document translation** with mechanical
verification, semantic review, fidelity scoring and certified-format export.

Nyayadoot is built for court orders, judgments, legal notices and applications
where a dropped clause or a mangled figure is not a cosmetic problem. It treats
translation as something to be *checked*, not just generated.

> ⚠️ **This is not a certified translation service.** Output is machine-assisted
> and always requires review by a qualified legal professional.

---

## Status — read this first

This repository currently contains the **translation and verification core** as a
library plus CLI probes. It is **not yet a working web application**.

| Area | State |
|---|---|
| Extraction (PDF / DOCX / text) | ✅ working |
| Segmentation & alignment | ✅ working |
| Translation (5 providers) | ✅ working |
| Deterministic verification | ✅ working |
| Semantic judge pass | ✅ working |
| Report generation | ✅ working |
| TXT / PDF / DOCX export | ✅ working |
| Test suite (110 tests) | ✅ passing |
| **Next.js API routes** | ❌ **not built** — `src/app/` does not exist |
| **Web review UI** | ❌ **not built** |
| `npm run seed` | ❌ **broken** — `scripts/seed.ts` is missing |

`next build` and `npm run seed` will fail as of this commit. The core library
(`src/lib/**`) is the finished part; the UI layer is future work.

---

## How it works

```
upload → extract/OCR → classify → segment → translate
      → deterministic checks → semantic judge → review → report → export
```

### The core invariant

**Exactly one target segment per source segment, in order.** Any omission,
addition, merge, split or renumbering becomes an explicit finding rather than
silently producing a fluent but incomplete document.

### What gets verified

Translation quality is not scored on vibes. Findings are mechanical and
reproducible:

| Check | Catches |
|---|---|
| `datum.currency_changed` / `_missing` | ₹50,000 becoming ₹5,00,000, or vanishing |
| `datum.date_ambiguous` | Gujarati `03/12/2024` read as 3 Dec vs 12 Mar |
| `datum.section_ref_changed` | wrong IPC / CrPC / BNS section numbers |
| `datum.person_name_changed` | party or judge names altered |
| `terminology.literal_translation` | `વકાલતનામું` rendered as "power of attorney" with no gloss |
| `terminology.inconsistent_target` | same term rendered two ways across blocks |
| `structure.hallucinated_segment` | sentences with no source counterpart |
| `structure.missing_segment` | dropped source sentences |
| `coverage.stunted_block` | suspiciously short output for a long input |

Gujarati-specific traps handled: `૫૦,૦૦૦` (50,000) vs `૫,૦૦,૦૦૦` (5,00,000);
ambiguous numeric dates; abbreviations that end in a full stop (`રૂ.`, `તા.`,
`નં.`) which naive sentence-splitting turns into broken fragments; and
homographs like `જામીન` (bail) vs `જમીન` (land).

### Fidelity scoring

Reports carry a **fidelity indicator**, never an accuracy claim. Grades are
`green` / `yellow` / `red`, and the gate is `ready_for_certification` or
`blocked_by_findings`. Anything not green routes to human review.

---

## Install

```bash
npm install
```

Requires **Node.js 20+** (uses the built-in `node:sqlite`).

---

## Configuration

All configuration is environment variables. There is no config file to commit.

### LLM provider (pick one)

```bash
# Fully offline — no API key, no cost. Recommended for local development.
NYD_LLM_PROVIDER=ollama
NYD_LLM_MODEL=qwen2.5:14b

# Hosted
NYD_LLM_PROVIDER=anthropic
NYD_LLM_MODEL=claude-sonnet-5-5
NYD_LLM_API_KEY=sk-ant-...

NYD_LLM_PROVIDER=openai
NYD_LLM_MODEL=gpt-4o-mini
NYD_LLM_API_KEY=sk-...

# Test doubles
NYD_LLM_PROVIDER=fixture   # handwritten known-good reference pairs
NYD_LLM_PROVIDER=stub      # deliberately weak negative control
```

| Provider | Value | Notes |
|---|---|---|
| `ollama` / `local` | free | Runs on your machine. `NYD_LLM_BASE_URL` defaults to `http://127.0.0.1:11434/v1` |
| `anthropic` / `claude` | paid, ~$0.10–0.20 per document | Best Gujarati legal quality |
| `openai` / `gpt` | paid, cheapest | Works via OpenAI-compatible endpoint |
| `fixture` | free | Deterministic regression tests |
| `stub` | free | Intentionally bad; proves verification catches errors |

### Other variables

| Variable | Default | Purpose |
|---|---|---|
| `NYD_DATA_DIR` | `./data` | SQLite DB, uploads, exports |
| `NYD_MAX_UPLOAD_MB` | `64` | Upload size limit |
| `NYD_CHUNK_TOKENS` | `2600` | Target tokens per translation chunk |
| `NYD_LLM_TEMPERATURE` | `0` | Kept at 0 — this is not a creative task |
| `NYD_LLM_RETRIES` | `4` | Retry attempts with backoff |
| `NYD_JUDGE_MODEL` | *(same as model)* | Use a stronger model for the judge pass |
| `NYD_OCR_PROVIDER` | `auto` | `paddle`, `tesseract`, or `none` |
| `NYD_TESSERACT_LANGS` | `guj+eng` | OCR language data |
| `NYD_OCR_CONFIDENCE_FLOOR` | `0.72` | Below this, translation is blocked pending human source review |

> Secrets belong in your shell or a local `.env` that is gitignored. There is no
> dotenv loader wired up — set the variables before running.

---

## Running

```bash
npm run dev          # Next.js dev server on :3100 (once the UI exists)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest run
```

To exercise the pipeline end-to-end without the UI:

```bash
npx tsx scripts/probe-pipeline.ts
npx tsx scripts/probe-schema.ts
```

---

## Project layout

```
src/lib/
  domain/        Gujarati NLP — sentence splitting, numerals, dates, transliteration
  llm/           Provider clients: anthropic, openai, ollama, fixture, stub
  pipeline/      extract → translate → verify → report → export
  verify/        datum, terminology and alignment checks
scripts/         CLI probes for end-to-end runs
tests/           110 tests
```

---

## Testing

```bash
npm test        # 110 tests, 8 files
```

The suite is deliberately regression-heavy — it guards the bugs that matter:
a crash on any document naming a surety, a datum primary-key collision, split
currency amounts, cross-block terminology leakage, and same-court-named-differently
being reported as a changed institution.

---

## Limitations

- **No web UI yet.** This is a library.
- **OCR depends on external tooling.** Scanned PDFs and images need Tesseract
  with Gujarati language data (`guj`) or a PaddleOCR service. Neither is bundled.
- **Legacy `.doc` is not really supported** despite being accepted by the type
  check; Mammoth handles `.docx` properly.
- **Local models are weaker.** A 14B model will produce more findings than a
  hosted API. Useful for development, not for certifiable output.
- **Written-out amounts** (`Rs. five lakh`) are not extracted as currency datums.
- Reports are explicitly **non-certified** and require human sign-off.

---

## License

MIT — see [LICENSE](./LICENSE).
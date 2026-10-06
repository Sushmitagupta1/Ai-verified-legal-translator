# Nyayadoot

**Gujarati → English legal translation, verified.**

A translation pipeline for court orders, judgments, legal notices and
applications — built on the premise that in legal work, *a fluent document is
not the same as a correct one.*

> ⚠️ **Not a certified translation service.** Output is machine-assisted and
> must be reviewed by a qualified legal professional. See
> [Disclaimer](#disclaimer).

---

## Why it exists

Generic translation produces text that *reads* well and quietly loses things:
the decimal in an amount, the section number, the difference between *accused*
and *complainant*, the scope of a negation. Those are not cosmetic defects.

Nyayadoot treats translation as something to be **checked**, not merely
generated. Every document goes through deterministic checks alongside a model
pass, and every anomaly becomes an explicit finding rather than a silent error.

---

## Features

- **Verified alignment** — exactly one target segment per source segment, in
  order. Omissions, additions, merges, splits and renumbering are findings, not
  invisible drift.
- **Datum preservation** — currency, dates, statute references, party names,
  judges, courts and institutions are tracked across the translation.
- **Gujarati-native preprocessing** — lakh/crore digit grouping, ambiguous
  numeric dates, abbreviation-terminated markers, and script-aware homographs.
- **Legal terminology control** — a glossary with required equivalents,
  forbidden terms and per-document consistency checking.
- **Two-layer quality gate** — mechanical checks plus a semantic judge pass for
  negation, modality, scope and legal meaning.
- **Fidelity indicator** — a grade with components, never an uncertified
  accuracy claim.
- **Human review before certification** — nothing is marked ready without the
  gate being passed.
- **Multi-format in and out** — PDF, DOCX and text in; TXT, PDF and DOCX out.
- **Fully local deployment** — run entirely on-premise with Ollama. No case
  material ever leaves the machine.

---

## How it works

```
upload → extract/OCR → classify → segment → translate
       → deterministic checks → semantic judge → review → report → export
```

### The core invariant

> **Exactly one target segment per source segment, in order.**

A translation model is free to merge, split or drop sentences. Nyayadoot never
allows that silently — the 1:1 mapping is re-verified after every stage, and a
broken invariant blocks certification.

### What gets checked

| Check | Example it catches |
|---|---|
| `datum.currency_changed` | `₹50,000` rendered as `₹5,00,000` |
| `datum.date_ambiguous` | `03/12/2024` read as 3 Dec vs 12 Mar |
| `datum.section_ref_changed` | wrong IPC / CrPC / BNS section number |
| `datum.person_name_changed` | party or judge name altered |
| `terminology.literal_translation` | `વકાલતનામું` rendered with no gloss |
| `terminology.inconsistent_target` | one term rendered two ways across blocks |
| `structure.missing_segment` | a source sentence dropped entirely |
| `structure.hallucinated_segment` | a sentence with no source counterpart |
| `coverage.stunted_block` | suspiciously short output for a long input |

### Gujarati-specific handling

- **Digit grouping** — `૫૦,૦૦૦` is 50,000; `૫,૦૦,૦૦૦` is 5,00,000. The
  western three-digit grouping does not apply, and getting this wrong changes
  the amount by an order of magnitude.
- **Ambiguous dates** — `03/12/2024` is genuinely 3 Dec or 12 Mar depending on
  convention, so it is flagged rather than guessed.
- **Abbreviation traps** — `રૂ.`, `તા.` and `નં.` end in a full stop. Naive
  sentence splitting shatters them; Nyayadoot masks them first.
- **Homographs** — `જામીન` (bail) and `જમીન` (land) are near-identical on the
  page and must not be conflated.

### Fidelity, not accuracy

Reports carry a **fidelity indicator** with components and a grade of
`green` / `yellow` / `red`, gating on `ready_for_certification` or
`blocked_by_findings`. Anything not green routes to human review.

The number is a triage signal for reviewers, not a claim that the document is
correct.

---

## Installation

```bash
git clone https://github.com/Sushmitagupta1/Ai-verified-legal-translator.git
cd Ai-verified-legal-translator
npm install
```

Requires **Node.js 20+**.

---

## Configuration

Everything is environment variables — there is no config file to commit.

### Choose a provider

```bash
# Fully offline. No API key, no cost, no data leaves your machine.
NYD_LLM_PROVIDER=ollama
NYD_LLM_MODEL=qwen2.5:14b
```

| Provider | Value | Notes |
|---|---|---|
| **Ollama** | `ollama` | Local, free, air-gapped. Best for privileged documents. |
| **Anthropic** | `anthropic` / `claude` | Highest quality on Gujarati legal text. |
| **OpenAI** | `openai` | Cost-efficient, OpenAI-compatible endpoint. |
| **Fixture** | `fixture` | Deterministic known-good pairs for regression tests. |
| **Stub** | `stub` | Deliberately weak output; proves the checks catch errors. |

### Running locally with Ollama

```bash
# one-time setup
curl -fsSL https://ollama.com/install.sh | sh   # Linux
ollama pull qwen2.5:14b                          # ~9 GB

# run the pipeline
export NYD_LLM_PROVIDER=ollama
export NYD_LLM_MODEL=qwen2.5:14b
npx tsx scripts/probe-pipeline.ts
```

`NYD_LLM_BASE_URL` defaults to `http://127.0.0.1:11434/v1` and does not need to
be set. **No API key is required for Ollama.**

> Local models are honest about their trade-off: they are free and private, but
> they produce more findings than a hosted model. Budget human review
> accordingly.

### All variables

| Variable | Default | Purpose |
|---|---|---|
| **Model** | | |
| `NYD_LLM_PROVIDER` | `stub` | `ollama`, `anthropic`, `openai`, `fixture`, `stub` |
| `NYD_LLM_MODEL` | *(provider default)* | Model name or tag |
| `NYD_LLM_API_KEY` | — | Required for hosted providers only |
| `NYD_LLM_BASE_URL` | *(provider default)* | OpenAI-compatible endpoint |
| `NYD_LLM_TEMPERATURE` | `0` | Kept at 0 — this is not a creative task |
| `NYD_LLM_RETRIES` | `4` | Retry attempts with exponential backoff |
| `NYD_LLM_TIMEOUT_MS` | `120000` | Per-request timeout |
| `NYD_JUDGE_MODEL` | *(same as model)* | Use a stronger model for the semantic pass |
| `NYD_CONCURRENCY` | `3` | Parallel model calls inside one document job |
| **Chunking** | | |
| `NYD_CHUNK_TOKENS` | `2600` | Target tokens per translation chunk |
| `NYD_CHUNK_HARD_TOKENS` | `4200` | Hard ceiling so one paragraph cannot overflow |
| `NYD_MAX_PAGES` | `400` | Page ceiling per document |
| `NYD_MAX_UPLOAD_MB` | `64` | Upload size limit |
| **Storage** | | |
| `NYD_DATA_DIR` | `./data` | Uploads and exports root |
| `NYD_DB_PATH` | `./data/nyayadoot.db` | SQLite database location |
| **OCR** | | |
| `NYD_OCR_PROVIDER` | `auto` | `paddle`, `tesseract`, `none` |
| `NYD_PADDLE_URL` | — | Local PaddleOCR service endpoint |
| `NYD_TESSERACT_LANGS` | `guj+eng` | OCR language data |
| `NYD_OCR_CONFIDENCE_FLOOR` | `0.72` | Below this, translation is blocked pending human source review |
| `NYD_OCR_PAGE_REVIEW` | `0.8` | Per-page threshold marking a page "needs source review" |
| `NYD_RENDER_DPI` | `300` | DPI used when rasterising a scanned page |
| `NYD_MAX_DPI` | `400` | Upper bound on the above |

---

## Project structure

```
src/lib/
  domain/      Gujarati NLP — segmentation, numerals, dates, glossary, statutes
  llm/         Providers: ollama, anthropic, openai, fixture, stub
  pipeline/    extract → classify → translate → verify → report → export
  verify/      Datum, terminology and alignment checks
scripts/       End-to-end CLI probes
tests/         Regression suite
```

---

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
```

The suite is deliberately regression-heavy. It guards the failures that matter:
a crash on any document naming a surety, a datum primary-key collision, split
currency amounts, cross-block terminology leakage, and one court named two ways
being reported as a changed institution.

---

## Roadmap

- **Web application** — upload, side-by-side segment review, approval workflow
  and a review UI, on a Next.js API.
- **Certified export package** — source digest, translator declaration and
  reviewer sign-off in a single bundle.
- **Diff-aware re-verification** — re-run checks without re-translating when the
  glossary changes.

---

## Disclaimer

This AI-generated translation is provided for informational and
document-processing purposes and should be reviewed by a qualified legal
professional where legally required. It does not constitute a certified or
court-certified translation unless separately verified and certified by an
authorized professional.

The fidelity indicator is a review-triage signal, not an accuracy guarantee.
No legal advice is offered or implied.

---

## License

[MIT](./LICENSE)
import { config } from "../config";

/** Common Indian annotation shorthands the verifier accepts in its own output. */
export const VERIFIER_ANNOTATION_VOCAB = {
  OMISSION: "omitted from source",
  ADDITION: "not present in source",
  AMBIGUITY: "multiple defensible readings",
  DRIFT: "meaning altered from source",
  NUMERIC: "number differs from source",
  TERMINOLOGY: "legal term rendered incorrectly",
  REGISTER: "register inconsistent with document type",
  PARTICIPANT: "party/participant misidentified",
  SCOPE: "scope or modality changed (e.g. 'may' -> 'shall')",
  NEGATION: "negation changed",
} as const;

export type VerifierCode = keyof typeof VERIFIER_ANNOTATION_VOCAB;

export interface TranslationSegment {
  id: number;
  source: string;
}

export interface TranslationOutput {
  segments: Array<{
    id: number;
    target: string;
    /** 0..1 self-reported confidence. Low values route the block to review. */
    confidence?: number;
    /** Free-form translator notes that require a human decision. */
    notes?: string[];
  }>;
  /** Terms the translator flagged as genuinely ambiguous. */
  ambiguousTerms?: Array<{ surface: string; sourceIndex: number; readings: string[] }>;
}

export interface VerifySegmentInput {
  id: number;
  source: string;
  target: string;
  /** Prior block targets, for cross-segment consistency (names, defined terms). */
  priorContext?: string;
  /** Glossary terms that appear in this source segment. */
  termHints?: string[];
}

export interface VerifierIssue {
  code: VerifierCode;
  severity: "critical" | "major" | "minor";
  /** Free text description of what is wrong. */
  detail: string;
  /** The target span or phrase at fault. */
  quote?: string;
  /** What the translator believes should be there instead. */
  suggestion?: string;
}

export interface VerifySegmentOutput {
  id: number;
  faithful: boolean;
  issues: VerifierIssue[];
  /** 0..1 */
  confidence: number;
}

export interface JudgeResult {
  segments: VerifySegmentOutput[];
  documentNotes: string[];
  /** Whether the document as a whole can be described as a faithful rendering. */
  documentFaithful: boolean;
}

export interface DocumentClassification {
  docType: string;
  confidence: number;
  reasoning: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  calls: number;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  /** Ask for a JSON object response (provider-dependent enforcement). */
  json?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  /** Retry budget for transient failures. */
  retries?: number;
  signal?: AbortSignal;
  /** Attach a request id for tracing. */
  requestId?: string;
}

export interface LlmClient {
  readonly name: string;
  readonly model: string;
  complete(messages: LlmMessage[], opts?: LlmOptions): Promise<string>;
  /** True when the client can actually reach a model. */
  readonly available: boolean;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * JSON extraction tolerant of prose-wrapped responses.
 *
 * Models frequently wrap JSON in commentary even when asked not to. Rather than
 * fail the whole chunk, we recover the payload.
 */
export function parseJsonLoose<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const firstObj = trimmed.indexOf("{");
  const lastObj = trimmed.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) candidates.push(trimmed.slice(firstObj, lastObj + 1));
  const firstArr = trimmed.indexOf("[");
  const lastArr = trimmed.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) candidates.push(trimmed.slice(firstArr, lastArr + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Same as `parseJsonLoose` but never null.
 *
 * Used by pipeline stages that must degrade rather than abort: a model returning
 * unparseable output should produce "everything is flagged", which a reviewer
 * can act on, not a stack trace they cannot.
 */
export function parseJson<T extends object>(raw: string): T {
  return parseJsonLoose<T>(raw) ?? ({} as T);
}

export function buildUsage(model: string): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, model, calls: 0 };
}

export function mergeUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    model: b.model || a.model,
    calls: a.calls + b.calls,
  };
}

export const LLM_DEFAULT = () => config.llm.model || "stub";
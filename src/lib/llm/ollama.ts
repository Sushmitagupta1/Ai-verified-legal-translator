import { config } from "../config";
import { backoff, sleep } from "./anthropic";
import { LlmError, requestSignal, type LlmClient, type LlmMessage, type LlmOptions } from "./provider";

/**
 * Ollama / local OpenAI-compatible server.
 *
 * Useful for air-gapped deployments handling privileged legal documents, where
 * sending case material to a hosted API is not acceptable. Quality will depend
 * entirely on the local model; expect a lower fidelity indicator and budget more
 * human review.
 */
export function createOllama(): LlmClient {
  const baseUrl = (config.llm.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
  // `qwen2.5:14b` is the canonical Ollama tag; `qwen2.5:14b-instruct` does not
  // exist and returns 404 from the local server.
  const model = config.llm.model || "qwen2.5:14b";

  return {
    name: "ollama",
    model,
    // Local servers need no key, but we still probe before declaring the client usable.
    available: true,

    async complete(messages: LlmMessage[], opts: LlmOptions = {}): Promise<string> {
      const useModel = opts.model ?? model;
      const maxRetries = opts.retries ?? config.llm.maxRetries;
      let lastErr: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (opts.signal?.aborted) throw new LlmError("Aborted", false);
        try {
          const body: Record<string, unknown> = {
            model: useModel,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            temperature: opts.temperature ?? config.llm.temperature,
            max_tokens: opts.maxOutputTokens ?? 8_192,
            stream: false,
          };
          // Without this the local model free-forms the schema: it echoed the
          // prompt's `[67]` label as a string id and used `text` instead of
          // `target`, so every segment came back unmatched and untranslated.
          if (opts.json) body.response_format = { type: "json_object" };

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: requestSignal(opts.signal),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new LlmError(`Ollama ${res.status}: ${text.slice(0, 500)}`, res.status >= 500 || res.status === 429, res.status);
          }

          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string | null } }>;
          };
          const text = data.choices?.[0]?.message?.content ?? "";
          if (!text) throw new LlmError("Ollama returned an empty response", true);
          return text;
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof LlmError ? err.retryable : true;
          if (!retryable || attempt === maxRetries) break;
          await sleep(backoff(attempt), opts.signal);
        }
      }

      throw new LlmError(
        `Ollama request failed after ${maxRetries + 1} attempts: ${
          lastErr instanceof Error ? lastErr.message : "unknown error"
        }. Is a server running at ${baseUrl}?`,
        false,
      );
    },
  };
}
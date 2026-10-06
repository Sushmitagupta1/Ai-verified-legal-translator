import { config } from "../config";
import { LlmError, requestSignal, type LlmClient, type LlmMessage, type LlmOptions } from "./provider";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Anthropic Messages API client.
 *
 * Notes on choices that matter for legal translation:
 * - `temperature: 0` by default. Creative variation in a legal register is a bug.
 * - No prefill / assistant priming: priming with `{` is the classic way to get
 *   malformed JSON back from a model that ignores its own schema instructions.
 * - Retries use exponential backoff on 429/5xx/network only. A 400 is a prompt
 *   bug and retrying it just burns the budget.
 */
export function createAnthropic(): LlmClient {
  const apiKey = config.llm.apiKey;
  const model = config.llm.model || "claude-sonnet-4-5";

  const client: LlmClient = {
    name: "anthropic",
    model,
    available: Boolean(apiKey),

    async complete(messages: LlmMessage[], opts: LlmOptions = {}): Promise<string> {
      if (!apiKey) {
        throw new LlmError(
          "ANTHROPIC_API_KEY / NYD_LLM_API_KEY is not set. Set it, or run with NYD_LLM_PROVIDER=stub for the offline pipeline.",
          false,
        );
      }

      const useModel = opts.model ?? model;
      const maxRetries = opts.retries ?? config.llm.maxRetries;
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const convo = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      let lastErr: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (opts.signal?.aborted) throw new LlmError("Aborted", false);
        try {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: useModel,
              max_tokens: opts.maxOutputTokens ?? 16_384,
              temperature: opts.temperature ?? config.llm.temperature,
              system: system || undefined,
              messages: convo,
            }),
            signal: requestSignal(opts.signal),
          });

          if (!res.ok) {
            const body = await res.text().catch(() => "");
            const retryable = res.status === 429 || res.status >= 500;
            throw new LlmError(
              `Anthropic ${res.status}: ${body.slice(0, 500)}`,
              retryable,
              res.status,
            );
          }

          const data = (await res.json()) as {
            content?: Array<{ type: string; text?: string }>;
            usage?: AnthropicUsage;
          };
          const text = (data.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
          if (!text) throw new LlmError("Anthropic returned an empty response", true);
          return text;
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof LlmError ? err.retryable : true;
          if (!retryable || attempt === maxRetries) break;
          await sleep(backoff(attempt), opts.signal);
        }
      }

      if (lastErr instanceof Error) {
        throw new LlmError(
          `Anthropic request failed after ${maxRetries + 1} attempts: ${lastErr.message}`,
          false,
          lastErr instanceof LlmError ? lastErr.status : undefined,
        );
      }
      throw new LlmError("Anthropic request failed", false);
    },
  };

  return client;
}

export function backoff(attempt: number): number {
  // Jittered exponential: avoids a thundering herd when a document fans out into
  // many parallel chunk calls after a rate-limit.
  const base = Math.min(30_000, 800 * 2 ** attempt);
  return base + Math.random() * base * 0.4;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new LlmError("Aborted", false));
      },
      { once: true },
    );
  });
}
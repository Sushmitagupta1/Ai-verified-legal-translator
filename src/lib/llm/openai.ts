import { config } from "../config";
import { backoff, sleep } from "./anthropic";
import { LlmError, requestSignal, type LlmClient, type LlmMessage, type LlmOptions } from "./provider";

/**
 * OpenAI-compatible chat-completions client.
 *
 * Works against api.openai.com and any compatible endpoint (Together, Groq,
 * vLLM, LM Studio, llama.cpp server) by setting NYD_LLM_BASE_URL.
 *
 * JSON mode is requested but the prompt still states the schema explicitly:
 * `response_format` is a hint, not a guarantee, and several compatible servers
 * ignore it. `parseJsonLoose` handles the rest.
 */
export function createOpenAi(): LlmClient {
  const apiKey = config.llm.apiKey;
  const baseUrl = (config.llm.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = config.llm.model || "gpt-4.1";

  return {
    name: "openai",
    model,
    available: Boolean(apiKey),

    async complete(messages: LlmMessage[], opts: LlmOptions = {}): Promise<string> {
      if (!apiKey) {
        throw new LlmError(
          "NYD_LLM_API_KEY is not set. Set it, or run with NYD_LLM_PROVIDER=stub for the offline pipeline.",
          false,
        );
      }

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
            max_tokens: opts.maxOutputTokens ?? 16_384,
          };
          if (opts.json) body.response_format = { type: "json_object" };

          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: requestSignal(opts.signal),
          });

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new LlmError(
              `OpenAI-compatible ${res.status}: ${text.slice(0, 500)}`,
              res.status === 429 || res.status >= 500,
              res.status,
            );
          }

          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string | null } }>;
          };
          const text = data.choices?.[0]?.message?.content ?? "";
          if (!text) throw new LlmError("OpenAI-compatible endpoint returned an empty response", true);
          return text;
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof LlmError ? err.retryable : true;
          if (!retryable || attempt === maxRetries) break;
          await sleep(backoff(attempt), opts.signal);
        }
      }

      throw new LlmError(
        `OpenAI-compatible request failed after ${maxRetries + 1} attempts: ${
          lastErr instanceof Error ? lastErr.message : "unknown error"
        }`,
        false,
      );
    },
  };
}
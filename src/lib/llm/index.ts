import { createAnthropic } from "./anthropic";
import { createOpenAi } from "./openai";
import { createOllama } from "./ollama";
import { createStub } from "./stub";
import { createFixture } from "./fixture";
import { config } from "../config";
import type { LlmClient } from "./provider";

export * from "./provider";
export * from "./prompts";
export { createAnthropic } from "./anthropic";
export { createOpenAi } from "./openai";
export { createOllama } from "./ollama";
export { createStub } from "./stub";
export { createFixture } from "./fixture";

/**
 * Provider registry.
 *
 * The default is `stub`: a deterministic, offline provider that performs a real
 * (if shallow) glossary-driven rendering. This exists so the entire pipeline —
 * extract → structure → translate → verify → report → export — can be exercised,
 * tested and demonstrated end to end with no API key and no network, and so a
 * misconfiguration degrades to something visibly labelled rather than to a
 * silently wrong production translation.
 */
export function createLlmClient(providerOverride?: string): LlmClient {
  const provider = (providerOverride ?? config.llm.provider).toLowerCase();

  switch (provider) {
    case "anthropic":
    case "claude":
      return createAnthropic();
    case "openai":
    case "gpt":
      return createOpenAi();
    case "ollama":
    case "local":
      return createOllama();
    case "fixture":
      return createFixture();
    case "stub":
    case "none":
    case "":
      return createStub();
    default:
      throw new Error(`Unknown LLM provider "${provider}". Use one of: stub, fixture, anthropic, openai, ollama.`);
  }
}

export function providerDisplayName(c: LlmClient): string {
  return c.available ? `${c.name}:${c.model}` : `${c.name}:offline`;
}
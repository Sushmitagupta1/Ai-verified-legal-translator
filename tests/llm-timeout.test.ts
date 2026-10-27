import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { config } from "../src/lib/config";
import { createOllama } from "../src/lib/llm/ollama";
import { requestSignal } from "../src/lib/llm/provider";

describe("requestSignal", () => {
  it("aborts once the timeout elapses", async () => {
    const signal = requestSignal(undefined, 50);
    expect(signal.aborted).toBe(false);
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    expect(signal.aborted).toBe(true);
  });

  it("forwards a caller abort without waiting for the timeout", () => {
    const caller = new AbortController();
    const signal = requestSignal(caller.signal, 60_000);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("stays live while the timeout is still in the future", () => {
    // The timer is unref'd, so it cannot hold the test process open.
    expect(requestSignal(undefined, 60_000).aborted).toBe(false);
  });
});

describe("ollama request timeout", () => {
  let server: http.Server;
  let servedUrl: string;
  const llm = config.llm as { baseUrl: string; timeoutMs: number };
  const saved = { baseUrl: llm.baseUrl, timeoutMs: llm.timeoutMs };

  beforeAll(async () => {
    // Accepts the request and never answers — the exact condition that used to
    // leave a job stuck on one stage forever.
    server = http.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    servedUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    llm.baseUrl = saved.baseUrl;
    llm.timeoutMs = saved.timeoutMs;
  });

  it("fails the call instead of hanging when the server never answers", async () => {
    let requests = 0;
    const count = () => {
      requests += 1;
    };
    server.on("request", count);

    llm.baseUrl = servedUrl;
    llm.timeoutMs = 250;

    const started = Date.now();
    await expect(
      createOllama().complete([{ role: "user", content: "hi" }], { retries: 0 }),
    ).rejects.toThrow(/aborted|timeout/i);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(requests).toBe(1);

    server.off("request", count);
  });

  it("does not retry a timed-out request", async () => {
    // Regression: a 600 s judge call was retried four times, so one stuck
    // request added 25 minutes to a run and then reported no semantic coverage.
    let requests = 0;
    const count = () => {
      requests += 1;
    };
    server.on("request", count);

    llm.baseUrl = servedUrl;
    llm.timeoutMs = 200;

    await expect(
      createOllama().complete([{ role: "user", content: "hi" }], { retries: 4 }),
    ).rejects.toThrow(/aborted|timeout/i);

    expect(requests).toBe(1);
    server.off("request", count);
  });

  it("treats an empty model option as the client's model", async () => {
    // Regression: the judge passes config.llm.judgeModel through, which is ""
    // when NYD_JUDGE_MODEL is unset. Ollama answered model:"" with 400 "model is
    // required", so the documented default (judge with the translator model)
    // never worked.
    const seen: string[] = [];
    const responder = (req: http.IncomingMessage, res: http.ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push(JSON.parse(body).model);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
      });
    };
    server.on("request", responder);

    llm.baseUrl = servedUrl;
    const text = await createOllama().complete([{ role: "user", content: "hi" }], { model: "" });

    expect(text).toBe("{}");
    expect(seen[0]).toBeTruthy();
    server.off("request", responder);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  callModel,
  checkConnection,
  getProvider,
  healthFromHttpStatus,
  PROVIDERS,
  requiresSecret,
} from "./index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("manifests", () => {
  it("have unique ids", () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
  });

  it("only Ollama works without a secret", () => {
    expect(PROVIDERS.filter((p) => !requiresSecret(p)).map((p) => p.id)).toEqual(["ollama"]);
  });
});

describe("checkConnection", () => {
  it("lists OpenAI models with a bearer token", async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: "gpt-b" }, { id: "gpt-a" }] }));
    const result = await checkConnection({ providerId: "openai", secret: "sk-test", fetch });
    expect(result).toMatchObject({ status: "healthy", models: ["gpt-a", "gpt-b"], httpStatus: 200 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("sends Anthropic's headers", async () => {
    const fetch = vi.fn(async () => json({ data: [{ id: "claude-x" }] }));
    await checkConnection({ providerId: "anthropic", secret: "sk-ant-x", fetch });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ "x-api-key": "sk-ant-x", "anthropic-version": "2023-06-01" });
  });

  it("reads Ollama tags from a custom base URL", async () => {
    const fetch = vi.fn(async () => json({ models: [{ name: "llama3.2:latest" }] }));
    const result = await checkConnection({ providerId: "ollama", baseUrl: "http://gpu:11434/", fetch });
    expect((fetch.mock.calls[0] as unknown[])[0]).toBe("http://gpu:11434/api/tags");
    expect(result.models).toEqual(["llama3.2:latest"]);
  });

  it("maps HTTP errors and network failures to health", async () => {
    expect(
      (await checkConnection({ providerId: "groq", secret: "x", fetch: async () => json({}, 401) })).status,
    ).toBe("invalid");
    const down = await checkConnection({
      providerId: "groq",
      secret: "x",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(down).toMatchObject({ status: "degraded", httpStatus: null, models: [] });
    expect(healthFromHttpStatus(429)).toBe("rate_limited");
    expect(healthFromHttpStatus(503)).toBe("degraded");
  });

  it("rejects unknown providers", async () => {
    expect(getProvider("nope")).toBeUndefined();
    await expect(checkConnection({ providerId: "nope" })).rejects.toThrow();
  });
});

describe("callModel", () => {
  it("calls OpenAI chat completions with messages and returns metrics", async () => {
    const fetch = vi.fn(async () =>
      json({
        choices: [{ message: { content: "Paris is the capital of France." } }],
        usage: { prompt_tokens: 14, completion_tokens: 7 },
      }),
    );
    const result = await callModel({
      providerId: "openai",
      model: "gpt-4o-mini",
      secret: "sk-openai",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "What is the capital of France?" },
      ],
      fetch,
    });

    expect(result.text).toBe("Paris is the capital of France.");
    expect(result.tokensIn).toBe(14);
    expect(result.tokensOut).toBe(7);
    expect(result.costUsd).toBeGreaterThan(0);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-openai");
  });

  it("calls Anthropic messages with system prompt split", async () => {
    const fetch = vi.fn(async () =>
      json({
        content: [{ type: "text", text: "Hello there!" }],
        usage: { input_tokens: 20, output_tokens: 5 },
      }),
    );
    const result = await callModel({
      providerId: "anthropic",
      model: "claude-3-5-haiku",
      secret: "sk-ant-test",
      messages: [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Hi" },
      ],
      fetch,
    });

    expect(result.text).toBe("Hello there!");
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe("You are an assistant.");
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("calls Ollama with local free pricing", async () => {
    const fetch = vi.fn(async () =>
      json({
        message: { content: "Local response" },
        prompt_eval_count: 10,
        eval_count: 5,
      }),
    );
    const result = await callModel({
      providerId: "ollama",
      model: "llama3.2",
      baseUrl: "http://localhost:11434",
      messages: [{ role: "user", content: "Hello Ollama" }],
      fetch,
    });

    expect(result.text).toBe("Local response");
    expect(result.costUsd).toBe(0);
  });
});

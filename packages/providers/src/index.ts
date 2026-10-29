import type { CONNECTION_HEALTH } from "@infuture/events";

/**
 * Provider manifests and connection checks.
 *
 * A check lists the provider's models with the stored credential: it proves the key works, tells
 * us which models the account can use, and costs no tokens.
 */

export type AuthType = "api_key" | "oauth" | "local";
export type ConnectionHealth = (typeof CONNECTION_HEALTH)[number];

export type ProviderManifest = {
  id: string;
  displayName: string;
  authTypes: AuthType[];
  defaultBaseUrl: string;
  docsUrl: string;
  /** Expected prefix of API keys, used only to warn about pasting the wrong key. */
  keyPrefix?: string;
};

export const PROVIDERS = [
  {
    id: "openai",
    displayName: "OpenAI",
    authTypes: ["api_key"],
    defaultBaseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    authTypes: ["api_key"],
    defaultBaseUrl: "https://api.anthropic.com/v1",
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
  },
  {
    id: "groq",
    displayName: "Groq",
    authTypes: ["api_key"],
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    docsUrl: "https://console.groq.com/keys",
    keyPrefix: "gsk_",
  },
  {
    id: "ollama",
    displayName: "Ollama",
    authTypes: ["local"],
    defaultBaseUrl: "http://localhost:11434",
    docsUrl: "https://ollama.com/download",
  },
] as const satisfies readonly ProviderManifest[];

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export function getProvider(id: string): ProviderManifest | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export const requiresSecret = (provider: ProviderManifest): boolean => !provider.authTypes.includes("local");

export type CheckResult = {
  status: ConnectionHealth;
  /** Model ids the credential can use, sorted. Empty unless the check succeeded. */
  models: string[];
  latencyMs: number;
  /** HTTP status from the provider, or null on network errors and timeouts. */
  httpStatus: number | null;
};

export type CheckInput = {
  providerId: string;
  secret?: string | null;
  baseUrl?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Request = { url: string; headers: Record<string, string>; parse: (body: unknown) => string[] };

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** OpenAI, Groq and Anthropic all answer `{ data: [{ id }] }`. */
const parseDataIds = (body: unknown): string[] =>
  ((body as { data?: { id?: unknown }[] })?.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");

function buildRequest(provider: ProviderManifest, baseUrl: string, secret: string | null): Request {
  switch (provider.id) {
    case "anthropic":
      return {
        url: `${baseUrl}/models?limit=1000`,
        headers: { "x-api-key": secret ?? "", "anthropic-version": "2023-06-01" },
        parse: parseDataIds,
      };
    case "ollama":
      return {
        url: `${baseUrl}/api/tags`,
        headers: {},
        parse: (body) =>
          ((body as { models?: { name?: unknown }[] })?.models ?? [])
            .map((m) => m.name)
            .filter((name): name is string => typeof name === "string"),
      };
    default:
      return {
        url: `${baseUrl}/models`,
        headers: { authorization: `Bearer ${secret ?? ""}` },
        parse: parseDataIds,
      };
  }
}

export function healthFromHttpStatus(status: number): ConnectionHealth {
  if (status >= 200 && status < 300) return "healthy";
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "rate_limited";
  return "degraded";
}

/** Checks a connection. Never throws and never includes the secret in its result. */
export async function checkConnection(input: CheckInput): Promise<CheckResult> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);

  const baseUrl = trimSlash(input.baseUrl || provider.defaultBaseUrl);
  const request = buildRequest(provider, baseUrl, input.secret ?? null);
  const doFetch = input.fetch ?? fetch;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  try {
    const res = await doFetch(request.url, {
      headers: { accept: "application/json", ...request.headers },
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    const status = healthFromHttpStatus(res.status);
    const models = status === "healthy" ? [...new Set(request.parse(await res.json()))].sort() : [];
    return { status, models, latencyMs: elapsed(), httpStatus: res.status };
  } catch {
    return { status: "degraded", models: [], latencyMs: elapsed(), httpStatus: null };
  }
}

/* --------------------------------- Model Calls --------------------------------- */

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CallModelInput = {
  providerId: string;
  model: string;
  messages: Message[];
  secret?: string | null;
  baseUrl?: string | null;
  fetch?: typeof fetch;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type CallModelResult = {
  providerId: string;
  model: string;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
};

export const MODEL_PRICES: Record<string, { inPerMtok: number; outPerMtok: number }> = {
  "gpt-4o": { inPerMtok: 2.5, outPerMtok: 10.0 },
  "gpt-4o-mini": { inPerMtok: 0.15, outPerMtok: 0.6 },
  "gpt-4-turbo": { inPerMtok: 10.0, outPerMtok: 30.0 },
  "claude-3-5-sonnet": { inPerMtok: 3.0, outPerMtok: 15.0 },
  "claude-3-5-haiku": { inPerMtok: 0.8, outPerMtok: 4.0 },
  "claude-3-opus": { inPerMtok: 15.0, outPerMtok: 75.0 },
  "llama-3.1-70b": { inPerMtok: 0.59, outPerMtok: 0.79 },
  "llama-3.1-8b": { inPerMtok: 0.05, outPerMtok: 0.08 },
};

export function estimateModelCost(
  providerId: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  if (providerId === "ollama") return 0;
  const matched = Object.entries(MODEL_PRICES).find(([key]) => model.toLowerCase().includes(key));
  const prices = matched ? matched[1] : { inPerMtok: 1.0, outPerMtok: 2.0 };
  const cost = (tokensIn / 1_000_000) * prices.inPerMtok + (tokensOut / 1_000_000) * prices.outPerMtok;
  return Number(cost.toFixed(6));
}

export async function callModel(input: CallModelInput): Promise<CallModelResult> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);

  const baseUrl = trimSlash(input.baseUrl || provider.defaultBaseUrl);
  const doFetch = input.fetch ?? fetch;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  let url = "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  let bodyJson: unknown;

  if (provider.id === "anthropic") {
    url = `${baseUrl}/messages`;
    headers["x-api-key"] = input.secret ?? "";
    headers["anthropic-version"] = "2023-06-01";
    const systemMsg = input.messages.find((m) => m.role === "system")?.content;
    const nonSystem = input.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));
    bodyJson = {
      model: input.model,
      system: systemMsg,
      messages: nonSystem.length > 0 ? nonSystem : [{ role: "user", content: "Hello" }],
      max_tokens: input.maxTokens ?? 4096,
      temperature: input.temperature ?? 0.7,
    };
  } else if (provider.id === "ollama") {
    url = `${baseUrl}/api/chat`;
    bodyJson = {
      model: input.model,
      messages: input.messages,
      stream: false,
      options: {
        temperature: input.temperature ?? 0.7,
      },
    };
  } else {
    // OpenAI and Groq compatible
    url = `${baseUrl}/chat/completions`;
    headers.authorization = `Bearer ${input.secret ?? ""}`;
    bodyJson = {
      model: input.model,
      messages: input.messages,
      temperature: input.temperature ?? 0.7,
      max_tokens: input.maxTokens,
    };
  }

  const res = await doFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyJson),
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`Model call failed with status ${res.status}: ${errorBody}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  let text = "";
  let tokensIn = 0;
  let tokensOut = 0;

  if (provider.id === "anthropic") {
    const content = (data.content as Array<{ type: string; text?: string }>) ?? [];
    text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    tokensIn = Number(usage?.input_tokens ?? 0);
    tokensOut = Number(usage?.output_tokens ?? 0);
  } else if (provider.id === "ollama") {
    const msg = data.message as { content?: string } | undefined;
    text = String(msg?.content ?? "");
    tokensIn = Number(data.prompt_eval_count ?? 0);
    tokensOut = Number(data.eval_count ?? 0);
  } else {
    const choices = (data.choices as Array<{ message?: { content?: string } }>) ?? [];
    text = String(choices[0]?.message?.content ?? "");
    const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    tokensIn = Number(usage?.prompt_tokens ?? 0);
    tokensOut = Number(usage?.completion_tokens ?? 0);
  }

  // Fallback estimation of tokens if the provider did not return counts
  if (tokensIn === 0) {
    const combinedInput = input.messages.map((m) => m.content).join(" ");
    tokensIn = Math.max(1, Math.round(combinedInput.length / 4));
  }
  if (tokensOut === 0) {
    tokensOut = Math.max(1, Math.round(text.length / 4));
  }

  const costUsd = estimateModelCost(provider.id, input.model, tokensIn, tokensOut);

  return {
    providerId: provider.id,
    model: input.model,
    text,
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs: elapsed(),
  };
}

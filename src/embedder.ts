/** Embedding providers ported from the Python obsidian-notes-rag project. */

export type TaskType = "search_document" | "search_query";

export type EmbedderOptions = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
};

export interface Embedder {
  readonly model: string;
  embed(text: string, taskType?: TaskType): Promise<number[]>;
  embedBatch(texts: string[], taskType?: TaskType): Promise<number[][]>;
  close(): void;
}

/** Task prefix expected by Nomic and Qwen embedding models. */
export function embeddingPrefix(model: string, taskType: TaskType): string {
  const name = model.toLowerCase();
  if (name.includes("nomic")) return `${taskType}: `;
  if (name.includes("qwen") && taskType === "search_query") return "Query: ";
  return "";
}

function authHeaders(apiKey?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** Flatten an error and its cause chain (including AggregateError entries) into one message. */
export function describeError(error: unknown): string {
  const messages: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || !value) return;
    if (value instanceof AggregateError) {
      for (const inner of value.errors) visit(inner, depth + 1);
      if (!value.errors.length && value.message) messages.push(value.message);
      return;
    }
    if (value instanceof Error) {
      if (value.message) messages.push(value.message);
      if (value.cause) visit(value.cause, depth + 1);
      return;
    }
    messages.push(String(value));
  };
  visit(error, 0);
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || parts.some((part) => part.includes(message))) continue;
    parts.push(message);
  }
  return parts.length ? parts.join(" | ") : String(error);
}

/** Fetch a URL and report connection failures with the underlying cause. */
async function fetchOrThrow(url: string, init: RequestInit, source: string) {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(`Could not reach ${source} at ${url}: ${describeError(error)}`, { cause: error });
  }
}

/** Apply the model-specific task prefix to one text or a batch. */
function withPrefix(input: string | string[], model: string, taskType: TaskType, enabled: boolean) {
  if (!enabled) return input;
  const prefix = embeddingPrefix(model, taskType);
  return Array.isArray(input) ? input.map((text) => `${prefix}${text}`) : `${prefix}${input}`;
}

function requireVectors(vectors: number[][] | undefined, expected: number, source: string) {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error(`${source} returned ${vectors?.length ?? 0} vectors for ${expected} inputs`);
  }
  for (const vector of vectors) {
    if (!vector?.length) throw new Error(`${source} response did not contain a vector`);
  }
  return vectors;
}

type OpenAICompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Apply model-specific task prefixes before sending text. */
  prefix: boolean;
  timeoutMs: number;
  beforeRequest?: () => Promise<void>;
};

/** Embedder for OpenAI-compatible `/v1/embeddings` servers. */
class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  protected readonly baseUrl: string;
  protected readonly apiKey?: string;
  private readonly prefix: boolean;
  private readonly timeoutMs: number;
  private readonly beforeRequest?: () => Promise<void>;

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.prefix = options.prefix;
    this.timeoutMs = options.timeoutMs;
    this.beforeRequest = options.beforeRequest;
  }

  private async request(input: string | string[], taskType: TaskType) {
    await this.beforeRequest?.();
    const prefixed = withPrefix(input, this.model, taskType, this.prefix);
    const expected = Array.isArray(prefixed) ? prefixed.length : 1;
    const response = await fetchOrThrow(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: authHeaders(this.apiKey),
      body: JSON.stringify({ model: this.model, input: prefixed }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, "Embedding API");
    if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
    const data = await response.json() as { data?: { index?: number; embedding: number[] }[] };
    const items = data.data;
    if (!Array.isArray(items) || items.length !== expected) {
      throw new Error(`Embedding API returned ${items?.length ?? 0} vectors for ${expected} inputs`);
    }
    const vectors = [...items]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => item.embedding);
    return requireVectors(vectors, expected, "Embedding API");
  }

  async embed(text: string, taskType: TaskType = "search_document") {
    const [vector] = await this.request(text, taskType);
    return vector;
  }

  async embedBatch(texts: string[], taskType: TaskType = "search_document"): Promise<number[][]> {
    if (!texts.length) return [];
    return this.request(texts, taskType);
  }

  close() { /* fetch keeps no persistent connection handle */ }
}

/** llama.cpp llama-server embedder, including router-mode model loading. */
class LlamaCppEmbedder extends OpenAICompatibleEmbedder {
  private loadAttempted = false;

  constructor(options: Omit<OpenAICompatibleOptions, "prefix" | "timeoutMs" | "beforeRequest">) {
    super({
      ...options,
      prefix: true,
      // The first request in router mode may block while the model loads.
      timeoutMs: 300_000,
      beforeRequest: () => this.ensureModelLoaded(),
    });
  }

  private async ensureModelLoaded() {
    if (!this.model || this.model === "default" || this.loadAttempted) return;
    this.loadAttempted = true;
    try {
      await fetch(`${this.baseUrl}/models/load`, {
        method: "POST",
        headers: authHeaders(this.apiKey),
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      // Older/single-model servers lack this endpoint; embeddings can auto-load.
    }
  }
}

/** Ollama embedder using the modern `/api/embed` batch endpoint. */
class OllamaEmbedder implements Embedder {
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(options: Omit<EmbedderOptions, "provider">) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
  }

  private async request(input: string | string[], taskType: TaskType) {
    const prefixed = withPrefix(input, this.model, taskType, true);
    const expected = Array.isArray(prefixed) ? prefixed.length : 1;
    const response = await fetchOrThrow(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: authHeaders(this.apiKey),
      body: JSON.stringify({ model: this.model, input: prefixed }),
      signal: AbortSignal.timeout(60_000),
    }, "Ollama embedding API");
    if (!response.ok) throw new Error(`Ollama embedding API ${response.status}: ${await response.text()}`);
    const data = await response.json() as { embeddings?: number[][] };
    return requireVectors(data.embeddings, expected, "Ollama embedding API");
  }

  async embed(text: string, taskType: TaskType = "search_document") {
    const [vector] = await this.request(text, taskType);
    return vector;
  }

  async embedBatch(texts: string[], taskType: TaskType = "search_document"): Promise<number[][]> {
    if (!texts.length) return [];
    return this.request(texts, taskType);
  }

  close() { /* fetch keeps no persistent connection handle */ }
}

/** Create an embedder for the configured provider. */
export function createEmbedder({ provider, model, baseUrl, apiKey }: EmbedderOptions): Embedder {
  switch (provider) {
    case "ollama":
      return new OllamaEmbedder({ model, baseUrl, apiKey });
    case "lmstudio":
      return new OpenAICompatibleEmbedder({
        model,
        baseUrl,
        apiKey,
        prefix: true,
        timeoutMs: 60_000,
      });
    case "llamacpp":
      return new LlamaCppEmbedder({ model, baseUrl, apiKey });
    case "openai":
      return new OpenAICompatibleEmbedder({
        model,
        baseUrl,
        apiKey,
        prefix: false,
        timeoutMs: 60_000,
      });
    default:
      throw new Error(`Unknown provider: ${provider}. Use 'openai', 'ollama', 'lmstudio', or 'llamacpp'.`);
  }
}

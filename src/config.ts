import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonConfig = {
  vault_path?: string;
  data_path?: string;
  provider?: string;
  model?: string;
  base_url?: string;
  api_key?: string;
  openai?: { api_key?: string; model?: string; base_url?: string };
  llamacpp?: { url?: string; model?: string; api_key?: string };
  ollama?: { url?: string; model?: string; api_key?: string };
  chunk_size?: number;
  min_characters_per_chunk?: number;
  similarity_threshold?: number;
  watch?: { debounce_seconds?: number };
};

function configPath() {
  if (process.env.OBSIDIAN_RAG_CONFIG) return path.resolve(process.env.OBSIDIAN_RAG_CONFIG);
  const root = process.platform === "win32"
    ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(root, "obsidian-rag-mcp", "config.json");
}

function readConfig(): JsonConfig {
  try { return JSON.parse(readFileSync(configPath(), "utf8")) as JsonConfig; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read config file ${configPath()}: ${String(error)}`);
  }
}

const file = readConfig();
const env = process.env;
const resolvedConfigPath = configPath();
const configDir = path.dirname(resolvedConfigPath);
const configuredPath = (value: string | undefined, fallback: string) => {
  const selected = value ?? fallback;
  return path.isAbsolute(selected) ? path.normalize(selected) : path.resolve(configDir, selected);
};
const runtimePath = (value: string | undefined, configured: string | undefined, fallback: string) =>
  value ? path.resolve(value) : configuredPath(configured, fallback);
const openaiKey = env.OPENAI_API_KEY ?? env.OBSIDIAN_RAG_API_KEY ?? file.openai?.api_key ?? file.api_key;
const provider = env.OBSIDIAN_RAG_PROVIDER ?? file.provider ?? (openaiKey ? "openai" : "llamacpp");
const providerSection = provider === "llamacpp" ? file.llamacpp : provider === "ollama" ? file.ollama : file.openai;
const model = env.OBSIDIAN_RAG_MODEL ?? env.OBSIDIAN_RAG_LLAMACPP_MODEL ?? file.model ?? providerSection?.model
  ?? (provider === "ollama" ? "nomic-embed-text" : provider === "llamacpp" ? "default" : "text-embedding-3-small");
const configuredChunkSize = Number(env.OBSIDIAN_RAG_CHUNK_SIZE ?? file.chunk_size ?? 1500);
const chunkSizeLimit = model.toLowerCase().includes("nomic-embed-text-v2-moe") ? 512 : Number.POSITIVE_INFINITY;
const configuredBaseUrl = provider === "llamacpp"
  ? env.OBSIDIAN_RAG_LLAMACPP_URL ?? env.OBSIDIAN_RAG_BASE_URL ?? file.llamacpp?.url ?? file.base_url ?? "http://localhost:9931"
  : provider === "ollama"
    ? env.OBSIDIAN_RAG_BASE_URL ?? file.ollama?.url ?? file.base_url ?? "http://localhost:11434"
    : env.OBSIDIAN_RAG_BASE_URL ?? file.openai?.base_url ?? file.base_url ?? "https://api.openai.com";

export const settings = {
  configPath: resolvedConfigPath,
  vaultPath: runtimePath(env.OBSIDIAN_RAG_VAULT, file.vault_path, process.cwd()),
  dataPath: runtimePath(env.OBSIDIAN_RAG_DATA, file.data_path, path.join(process.cwd(), "data")),
  provider,
  model,
  baseUrl: configuredBaseUrl.replace(/\/$/, "").replace(/\/v1$/, ""),
  apiKey: provider === "llamacpp"
    ? env.OBSIDIAN_RAG_LLAMACPP_API_KEY ?? env.OBSIDIAN_RAG_API_KEY ?? file.llamacpp?.api_key ?? file.api_key
    : provider === "ollama"
      ? env.OBSIDIAN_RAG_OLLAMA_API_KEY ?? env.OBSIDIAN_RAG_API_KEY ?? file.ollama?.api_key ?? file.api_key
      : env.OPENAI_API_KEY ?? env.OBSIDIAN_RAG_API_KEY ?? file.openai?.api_key ?? file.api_key,
  maxChunk: Math.min(configuredChunkSize, chunkSizeLimit),
  minChunkCharacters: Number(env.OBSIDIAN_RAG_MIN_CHARACTERS_PER_CHUNK ?? file.min_characters_per_chunk ?? 1),
  similarityThreshold: Number(env.OBSIDIAN_RAG_SIMILARITY_THRESHOLD ?? file.similarity_threshold ?? 0.1),
  watchDebounceSeconds: Number(env.OBSIDIAN_RAG_DEBOUNCE ?? file.watch?.debounce_seconds ?? 2),
};

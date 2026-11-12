import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { embeddingPrefix } from "../dist/embedder.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectDir, "dist", "cli.js");
const execFileAsync = promisify(execFile);

function cleanEnv(configPath, extra = {}) {
  const env = { ...process.env, ...extra, OBSIDIAN_RAG_CONFIG: configPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OBSIDIAN_RAG_") && key !== "OBSIDIAN_RAG_CONFIG" && !(key in extra)) delete env[key];
  }
  delete env.OPENAI_API_KEY;
  return env;
}

async function runCli(env, ...args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: projectDir,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  return JSON.parse(result.stdout.trim());
}

async function startOllamaServer(t, requests) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/api/embed") {
      const payload = JSON.parse(body);
      requests.push({ authorization: request.headers.authorization, payload });
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: payload.model, embeddings: inputs.map(() => [1, 0, 0]) }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("embeddingPrefix matches the Python provider behavior", () => {
  assert.equal(embeddingPrefix("nomic-embed-text", "search_document"), "search_document: ");
  assert.equal(embeddingPrefix("nomic-embed-text", "search_query"), "search_query: ");
  assert.equal(embeddingPrefix("qwen3-embedding", "search_document"), "");
  assert.equal(embeddingPrefix("qwen3-embedding", "search_query"), "Query: ");
  assert.equal(embeddingPrefix("text-embedding-3-small", "search_query"), "");
});

test("Ollama provider uses /api/embed with task prefixes and auth", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-ollama-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "Alpha.md"), "# Alpha\n\nThe alpha note contains blue comet and links to [[Beta]].\n");
  await writeFile(path.join(vault, "notes", "Beta.md"), "# Beta\n\nThe beta note contains related content about a blue comet.\n");

  const requests = [];
  const ollamaUrl = await startOllamaServer(t, requests);

  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "ollama",
    model: "nomic-embed-text-v2-moe",
    ollama: { url: ollamaUrl, api_key: "test-token" },
    min_characters_per_chunk: 1,
    similarity_threshold: 0,
  }));
  const env = cleanEnv(configPath);

  const indexed = await runCli(env, "index", "--clear");
  assert.equal(indexed.files_indexed, 2);
  assert.equal(indexed.chunks_created, 2);
  assert.equal(indexed.errors, null);

  const search = await runCli(env, "search", "blue comet", "-n", "5");
  assert.equal(search.length, 2);

  const stats = await runCli(env, "stats");
  assert.equal(stats.provider, "ollama");
  assert.equal(stats.model, "nomic-embed-text-v2-moe");

  assert.ok(requests.length >= 2);
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer test-token");
    assert.equal(request.payload.model, "nomic-embed-text-v2-moe");
  }
  const inputs = requests.flatMap((request) => request.payload.input);
  assert.ok(inputs.length >= 3);
  assert.ok(inputs.some((text) => text.startsWith("search_document: ")));
  assert.ok(inputs.includes("search_query: blue comet"));
});

test("OBSIDIAN_RAG_OLLAMA_URL overrides the config file", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-ollama-env-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "Note.md"), "# Note\n\nA note for the environment override test.\n");

  const requests = [];
  const ollamaUrl = await startOllamaServer(t, requests);
  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "ollama",
    model: "nomic-embed-text-v2-moe",
    ollama: { url: "http://127.0.0.1:1" },
    min_characters_per_chunk: 1,
  }));
  const env = cleanEnv(configPath, { OBSIDIAN_RAG_OLLAMA_URL: ollamaUrl });

  const indexed = await runCli(env, "index", "--clear");
  assert.equal(indexed.files_indexed, 1);
  assert.equal(indexed.errors, null);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].payload.input.every((text) => text.startsWith("search_document: ")));
});

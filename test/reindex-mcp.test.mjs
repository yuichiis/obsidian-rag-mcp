import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(projectDir, "dist", "index.js");

function cleanEnv(configPath) {
  const env = { ...process.env, OBSIDIAN_RAG_CONFIG: configPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OBSIDIAN_RAG_") && key !== "OBSIDIAN_RAG_CONFIG") delete env[key];
  }
  delete env.OPENAI_API_KEY;
  return env;
}

async function startEmbeddingServer(t) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url === "/v1/embeddings" && request.method === "POST") {
      const payload = JSON.parse(body);
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: inputs.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }));
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

test("MCP reindex tool still indexes directly through the server", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-mcp-reindex-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "Note.md"), "# Note\n\nA note indexed through the MCP reindex tool.\n");

  const lmstudioUrl = await startEmbeddingServer(t);
  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "lmstudio",
    model: "nomic-embed-text-v2-moe",
    lmstudio: { url: lmstudioUrl },
    min_characters_per_chunk: 1,
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: cleanEnv(configPath),
    stderr: "ignore",
  });
  const client = new Client({ name: "obsidian-rag-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "reindex", arguments: { clear: true } });
    assert.ok(!response.isError);
    const content = response.content;
    assert.ok(Array.isArray(content));
    const text = content.find((item) => item.type === "text");
    assert.ok(text && "text" in text);
    const result = JSON.parse(text.text);
    assert.equal(result.files_indexed, 1);
    assert.equal(result.chunks_created, 1);
    assert.equal(result.errors, null);
  } finally {
    await client.close();
  }
});

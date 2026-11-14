import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectDir, "dist", "cli.js");
const execFileAsync = promisify(execFile);

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

test("CLI index reports per-file progress on stderr", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-progress-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "Alpha.md"), "# Alpha\n\nThe alpha note content.\n");
  await writeFile(path.join(vault, "notes", "Beta.md"), "# Beta\n\nThe beta note content.\n");

  const lmstudioUrl = await startEmbeddingServer(t);
  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "lmstudio",
    model: "nomic-embed-text-v2-moe",
    lmstudio: { url: lmstudioUrl },
    min_characters_per_chunk: 1,
  }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, "index", "--clear"], {
    cwd: projectDir,
    env: cleanEnv(configPath),
    encoding: "utf8",
    timeout: 15_000,
  });

  const result = JSON.parse(stdout.trim());
  assert.equal(result.files_indexed, 2);
  assert.equal(result.chunks_created, 2);
  assert.equal(result.errors, null);

  assert.match(stderr, /Indexing 2 file\(s\) after clearing the index\.\.\./);
  assert.match(stderr, /\[1\/2\] Indexing .+\.md \.\.\./);
  assert.match(stderr, /\[1\/2\] OK .+\.md \(1 chunk, \d+\.\d+s\)/);
  assert.match(stderr, /\[2\/2\] Indexing .+\.md \.\.\./);
  assert.match(stderr, /\[2\/2\] OK .+\.md \(1 chunk, \d+\.\d+s\)/);
  assert.match(stderr, /Alpha\.md/);
  assert.match(stderr, /Beta\.md/);
  assert.match(stderr, /Finished: 2\/2 file\(s\) indexed, 2 chunk\(s\) created\./);
});

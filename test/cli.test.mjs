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

test("CLI indexes, searches, explores, reports stats, and removes notes", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(path.join(vault, "notes"), { recursive: true });
  await writeFile(path.join(vault, "notes", "Alpha.md"), "# Alpha\n\nThe alpha note contains the searchable phrase blue comet and links to [[Beta]].\n");
  await writeFile(path.join(vault, "notes", "Beta.md"), "# Beta\n\nThe beta note contains related searchable content about a blue comet.\n");

  const embeddingServer = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume body */ }
    if (request.url === "/models/load") {
      response.writeHead(404).end();
      return;
    }
    if (request.url === "/v1/embeddings") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => embeddingServer.close((error) => error ? reject(error) : resolve())));
  const address = embeddingServer.address();
  assert.ok(address && typeof address !== "string");

  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "llamacpp",
    model: "test-embedding-model",
    llamacpp: { url: `http://127.0.0.1:${address.port}` },
    min_characters_per_chunk: 1,
    similarity_threshold: 0,
  }));

  const env = { ...process.env, OBSIDIAN_RAG_CONFIG: configPath };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OBSIDIAN_RAG_") && key !== "OBSIDIAN_RAG_CONFIG") delete env[key];
  }
  delete env.OPENAI_API_KEY;
  async function runCli(...args) {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: projectDir,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    return JSON.parse(result.stdout.trim());
  }

  const indexed = await runCli("index", "--clear");
  assert.equal(indexed.files_indexed, 2);
  assert.equal(indexed.chunks_created, 2);
  assert.equal(indexed.errors, null);

  const search = await runCli("search", "blue comet", "-n", "5");
  assert.equal(search.length, 2);
  assert.ok(search.some((item) => item.file_path === "notes/Alpha.md"));

  const similar = await runCli("similar", "notes/Alpha.md", "-n", "1");
  assert.equal(similar[0].file_path, "notes/Beta.md");

  const content = await runCli("content", "notes/Alpha.md");
  assert.match(content.content, /blue comet/);
  assert.deepEqual(content.links, ["notes/Beta.md"]);

  const graph = await runCli("graph", "notes/Beta.md");
  assert.deepEqual(graph.backlinks, ["notes/Alpha.md"]);

  const stats = await runCli("stats");
  assert.equal(stats.count, 2);
  assert.equal(stats.notes, 2);
  assert.equal(stats.provider, "llamacpp");

  const removed = await runCli("remove", "notes/Beta.md");
  assert.equal(removed.chunks_removed, 1);
  const afterRemove = await runCli("stats");
  assert.equal(afterRemove.count, 1);
  const graphAfterRemove = await runCli("graph", "notes/Alpha.md");
  assert.deepEqual(graphAfterRemove.links, []);
});

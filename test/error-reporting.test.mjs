import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { describeError } from "../dist/embedder.js";

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

test("describeError includes the cause chain", () => {
  const error = new Error("fetch failed", {
    cause: new AggregateError([
      new Error("connect ECONNREFUSED ::1:9931"),
      new Error("connect ECONNREFUSED 127.0.0.1:9931"),
    ]),
  });
  assert.equal(
    describeError(error),
    "fetch failed | connect ECONNREFUSED ::1:9931 | connect ECONNREFUSED 127.0.0.1:9931",
  );
});

test("index reports connection details and exits non-zero when the provider is unreachable", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-error-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "Note.md"), "# Note\n\nA note for the unreachable provider test.\n");
  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "lmstudio",
    model: "nomic-embed-text-v2-moe",
    lmstudio: { url: "http://127.0.0.1:1" },
    min_characters_per_chunk: 1,
  }));

  const result = await execFileAsync(process.execPath, [cliPath, "index", "--clear"], {
    cwd: projectDir,
    env: cleanEnv(configPath),
    encoding: "utf8",
    timeout: 15_000,
  }).then(
    (value) => ({ ...value, code: 0 }),
    (error) => error,
  );

  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout.trim());
  assert.ok(Array.isArray(output.errors));
  assert.match(output.errors[0].error, /Could not reach Embedding API at http:\/\/127\.0\.0\.1:1\/v1\/embeddings/);
  assert.match(output.errors[0].error, /ECONNREFUSED|fetch failed/);
});

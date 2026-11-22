import assert from "node:assert/strict";
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

test("MCP server does not expose the reindex tool", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obsidian-rag-mcp-mcp-tools-test-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const vault = path.join(tempDir, "vault");
  const data = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "config.json");
  await mkdir(vault, { recursive: true });
  await writeFile(path.join(vault, "Note.md"), "# Note\n\nA note in the vault.\n");
  await writeFile(configPath, JSON.stringify({
    vault_path: vault,
    data_path: data,
    provider: "llamacpp",
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
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(!names.includes("reindex"), "reindex must not be exposed over MCP");
    assert.deepEqual(names.sort(), [
      "get_note_context",
      "get_note_graph",
      "get_similar",
      "get_stats",
      "remove_note",
      "search_notes",
    ]);
  } finally {
    await client.close();
  }
});

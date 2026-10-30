#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { watch as watchFs, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { settings } from "./config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const usage = `obsidian-rag <command>

Commands:
  index [file.md] [--clear]   Index the vault or refresh one vault-relative Markdown file
  search <query> [-n limit]   Search indexed notes by semantic similarity
  similar <file.md> [-n limit] Find notes similar to a vault note
  content <file.md> [-n limit] Get note content, links, backlinks, and similar notes
  graph <file.md> [--hops N]  Show links, backlinks, and graph neighbors
  stats                       Show index and configuration statistics
  remove <file.md>            Remove a note from the index
  watch [--debounce seconds]  Watch the vault and index Markdown file changes

Environment: OBSIDIAN_RAG_VAULT, OBSIDIAN_RAG_PROVIDER, OBSIDIAN_RAG_MODEL,
             OBSIDIAN_RAG_LLAMACPP_URL, OBSIDIAN_RAG_LLAMACPP_API_KEY`;

function parseLimit(args: string[], fallback = 10) {
  const i = args.findIndex((arg) => arg === "-n" || arg === "--limit");
  if (i < 0) return fallback;
  const limit = Number(args[i + 1]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Search limit must be an integer from 1 to 100");
  args.splice(i, 2);
  return limit;
}

function vaultRelative(file: string) {
  const vault = settings.vaultPath;
  const requested = path.resolve(vault, file);
  const relative = path.relative(vault, requested);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("The file must be inside the configured vault");
  }
  if (!requested.toLowerCase().endsWith(".md")) throw new Error("Only Markdown (.md) paths are supported");
  return relative.replaceAll("\\", "/");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") { console.log(usage); return; }
  const supported = ["index", "search", "similar", "content", "graph", "stats", "remove", "watch"];
  if (!supported.includes(command)) throw new Error(`Unknown command: ${command}\n\n${usage}`);

  let toolName: string;
  let toolArgs: Record<string, unknown>;
  if (command === "index") {
    const clear = args.includes("--clear");
    const targets = args.filter((arg) => arg !== "--clear");
    if (targets.length > 1) throw new Error("Specify at most one Markdown file to index");
    let path_filter: string | undefined;
    if (targets[0]) {
      const relative = vaultRelative(targets[0]);
      const requested = path.join(settings.vaultPath, relative);
      if (!(await stat(requested)).isFile()) throw new Error("The specified path is not a file");
      path_filter = relative;
    }
    toolName = "reindex";
    toolArgs = { clear, ...(path_filter ? { path_filter } : {}) };
  } else if (command === "search") {
    const limit = parseLimit(args, 10);
    const query = args.join(" ").trim();
    if (!query) throw new Error("Provide a search query.\n\nUsage: obsidian-rag search <query> [-n limit]");
    toolName = "search_notes";
    toolArgs = { query, limit };
  } else if (command === "similar" || command === "content") {
    const limit = parseLimit(args, 5);
    const note = args.shift();
    if (!note || args.length) throw new Error(`Usage: obsidian-rag ${command} <file.md> [-n limit]`);
    const note_path = vaultRelative(note);
    toolName = command === "similar" ? "get_similar" : "get_note_context";
    toolArgs = { note_path, limit };
  } else if (command === "graph") {
    const limit = parseLimit(args, 20);
    const hopsAt = args.findIndex((arg) => arg === "--hops");
    let hops = 1;
    if (hopsAt >= 0) {
      hops = Number(args[hopsAt + 1]);
      args.splice(hopsAt, 2);
      if (!Number.isInteger(hops) || hops < 1 || hops > 5) throw new Error("Graph hops must be an integer from 1 to 5");
    }
    const note = args.shift();
    if (!note || args.length) throw new Error("Usage: obsidian-rag graph <file.md> [--hops N] [-n limit]");
    toolName = "get_note_graph";
    toolArgs = { note_path: vaultRelative(note), hops, limit };
  } else if (command === "remove") {
    const note = args.shift();
    if (!note || args.length) throw new Error("Usage: obsidian-rag remove <file.md>");
    toolName = "remove_note";
    toolArgs = { note_path: vaultRelative(note) };
  } else if (command === "stats") {
    if (args.length) throw new Error("Usage: obsidian-rag stats");
    toolName = "get_stats";
    toolArgs = {};
  } else {
    toolName = "watch";
    toolArgs = {};
  }

  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
  // The MCP SDK intentionally inherits only a small safe environment allowlist.
  // Forward this server's configuration explicitly to its child process.
  const serverEnv = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && (key.startsWith("OBSIDIAN_RAG_") || key === "OPENAI_API_KEY"),
  )) as Record<string, string>;
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: serverEnv });
  const client = new Client({ name: "obsidian-rag-cli", version: "1.0.0" });
  try {
    await client.connect(transport);
    if (command !== "watch") {
      const result = await client.callTool({ name: toolName, arguments: toolArgs }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      for (const item of result.content ?? []) if (item.type === "text") console.log(item.text);
      if (result.isError) process.exitCode = 1;
    } else {
      const vault = settings.vaultPath;
      const debounceArg = args.indexOf("--debounce");
      const debounceSeconds = debounceArg < 0 ? settings.watchDebounceSeconds : Number(args[debounceArg + 1]);
      if (!Number.isFinite(debounceSeconds) || debounceSeconds < 0.1 || debounceSeconds > 60) throw new Error("Debounce must be between 0.1 and 60 seconds");
      const pending = new Map<string, NodeJS.Timeout>();
      let taskQueue = Promise.resolve();
      const processedHashes = new Map<string, string>();
      const excluded = new Set([".git", ".obsidian", ".trash", "attachments", "node_modules", "dist", "coverage"]);
      const watcher: FSWatcher = watchFs(vault, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().replaceAll("\\", "/");
        if (!rel.toLowerCase().endsWith(".md") || rel.split("/").some((part) => excluded.has(part) || part.startsWith("."))) return;
        const previous = pending.get(rel);
        if (previous) clearTimeout(previous);
        pending.set(rel, setTimeout(async () => {
          pending.delete(rel);
          taskQueue = taskQueue.then(async () => {
            try {
              const fullPath = path.join(vault, rel);
              let exists = true;
              try { exists = (await stat(fullPath)).isFile(); } catch { exists = false; }
              const fingerprint = exists ? createHash("sha256").update(await readFile(fullPath)).digest("hex") : "deleted";
              if (processedHashes.get(rel) === fingerprint) return;
              const result = await client.callTool({ name: exists ? "reindex" : "remove_note", arguments: exists ? { clear: false, path_filter: rel } : { note_path: rel } }) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
              const label = exists ? "Indexed" : "Removed";
              const details = result.content?.find((item) => item.type === "text")?.text ?? "";
              console.log(`${label} ${rel}${details ? `: ${details}` : ""}`);
              if (result.isError) console.error(`Failed to process ${rel}`);
              else processedHashes.set(rel, fingerprint);
            } catch (error) { console.error(`Failed to process ${rel}: ${String(error)}`); }
          });
        }, debounceSeconds * 1000));
      });
      watcher.on("error", (error) => console.error(`Vault watcher error: ${error.message}`));
      console.log(`Watching vault: ${vault} (debounce ${debounceSeconds}s). Press Ctrl+C to stop.`);
      await new Promise<void>((resolve) => {
        const stop = () => { watcher.close(); for (const timer of pending.values()) clearTimeout(timer); pending.clear(); resolve(); };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

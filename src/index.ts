#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { settings } from "./config.js";
import { createEmbedder, describeError } from "./embedder.js";
import { SqliteStore, type StoredChunk } from "./store.js";

const vault = settings.vaultPath;
const dataDir = settings.dataPath;
const { provider, model, baseUrl, apiKey, maxChunk, minChunkCharacters } = settings;
const embedder = createEmbedder({ provider, model, baseUrl, apiKey });
const EMBED_BATCH_SIZE = 16;
await fs.mkdir(dataDir, { recursive: true });
const store = new SqliteStore(dataDir);

async function embedInBatches(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    vectors.push(...await embedder.embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE), "search_document"));
  }
  return vectors;
}

function splitChunks(body: string) {
  const blocks = body.split(/(?=^#{1,6}\s)/m);
  const result: { heading: string | null; level: number; text: string }[] = [];
  for (const block of blocks) {
    const m = block.match(/^(#{1,6})\s+(.+?)\s*$/m);
    const heading = m?.[2] ?? null, level = m?.[1]?.length ?? 0;
    const clean = block.trim();
    if (!clean) continue;
    if (clean.length <= maxChunk) result.push({ heading, level, text: clean });
    else {
      let rest = clean;
      while (rest.length) {
        let cut = Math.min(maxChunk, rest.length);
        if (cut < rest.length) {
          const boundary = rest.lastIndexOf("\n\n", cut);
          if (boundary > maxChunk * .55) cut = boundary;
        }
        const part = rest.slice(0, cut).trim();
        if (part) result.push({ heading, level, text: part });
        rest = rest.slice(cut).trim();
      }
    }
  }
  return result;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const excluded = new Set([".git", ".obsidian", ".trash", "attachments", "node_modules", "dist", "coverage"]);
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (excluded.has(ent.name) || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await markdownFiles(full));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

const wikiRe = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
function makeResolver(files: string[]) {
  const names = new Map<string, string[]>();
  for (const f of files) {
    const rel = path.relative(vault, f).replaceAll("\\", "/");
    const base = path.basename(rel, ".md");
    names.set(base, [...(names.get(base) ?? []), rel]);
  }
  return (target: string) => {
    const normalized = target.trim().replaceAll("\\", "/").replace(/\.md$/i, "");
    const exact = files.map(f => path.relative(vault, f).replaceAll("\\", "/")).find(x => x.replace(/\.md$/i, "") === normalized);
    return exact ?? names.get(path.basename(normalized))?.sort((a, b) => a.length - b.length)[0];
  };
}

async function reindex(clear: boolean, pathFilter?: string) {
  const files = await markdownFiles(vault);
  const selected = files.filter((file) => !pathFilter || path.relative(vault, file).replaceAll("\\", "/").startsWith(pathFilter));
  if (clear) store.clear();
  const resolve = makeResolver(files);
  let indexed = 0, created = 0;
  const errors: { file: string; error: string }[] = [];
  for (const file of selected) {
    const rel = path.relative(vault, file).replaceAll("\\", "/");
    try {
      let raw = await fs.readFile(file, "utf8");
      raw = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
      const tags = [...raw.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((match) => match[1]);
      const parts = splitChunks(raw).filter((part) => part.text.length >= minChunkCharacters);
      const vectors = await embedInBatches(parts.map((part) => part.text));
      store.deleteFile(rel);
      store.ensureNote(rel);
      parts.forEach((part, i) => {
        const chunk: StoredChunk = {
          id: createHash("sha1").update(`${rel}\0${part.heading}\0${part.text}`).digest("hex"),
          file_path: rel,
          heading: part.heading,
          heading_level: part.level,
          type: rel.startsWith("Daily Notes/") ? "daily" : "note",
          tags: [...new Set(tags)].join(","),
          content: part.text,
          embedding: vectors[i],
        };
        store.insert(chunk);
        created++;
      });
      const links = new Set<string>();
      for (const match of raw.matchAll(wikiRe)) {
        const target = resolve(match[1]);
        if (target && target !== rel) links.add(target);
      }
      store.replaceLinks(rel, [...links].sort());
      indexed++;
    } catch (error) { errors.push({ file: rel, error: describeError(error) }); }
  }
  const totals = store.stats();
  return { files_indexed: indexed, chunks_created: created, link_edges: totals.links, total_in_store: totals.chunks, errors: errors.length ? errors : null, path_filter: pathFilter ?? null, cleared: clear };
}

function neighbors(seedPaths: string[], hops: number, limit: number) {
  const seen = new Set(seedPaths);
  const queue = seedPaths.map((notePath) => ({ path: notePath, depth: 0 }));
  const out: { path: string; hop: number; via: string; direction: string }[] = [];
  while (queue.length && out.length < limit) {
    const current = queue.shift()!;
    if (current.depth >= hops) continue;
    for (const [list, direction] of [[store.getLinks(current.path), "link"], [store.getBacklinks(current.path), "backlink"]] as const) {
      for (const target of list) {
        if (seen.has(target)) continue;
        seen.add(target);
        out.push({ path: target, hop: current.depth + 1, via: current.path, direction });
        queue.push({ path: target, depth: current.depth + 1 });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const server = new McpServer({ name: "obsidian-rag-mcp", version: "1.0.0" });

server.registerTool(
  "search_notes",
  {
    description: "Search Obsidian notes by semantic similarity; optionally expand through linked notes.",
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
      note_type: z.string().optional(),
      expand: z.number().int().min(0).max(5).default(0),
    },
  },
  async ({ query, limit = 10, note_type, expand }) => {
    const q = await embedder.embed(query, "search_query");
    const matches = store.search(q, limit, note_type).filter(x => x.similarity >= settings.similarityThreshold);
    const results: Array<{
      file_path: string;
      heading?: string | null;
      content: string;
      similarity?: number;
      type?: string;
      source?: string;
      hop?: number;
      via?: string;
      direction?: string;
    }> = matches.map(({ chunk, similarity }) => ({
      file_path: chunk.file_path,
      heading: chunk.heading,
      content: chunk.content.slice(0, 500),
      similarity: Number(similarity.toFixed(3)),
      type: chunk.type,
    }));
    if (expand && results.length)
      for (const n of neighbors([...new Set(results.map(x => x.file_path))], expand, limit * 2)) {
        const preview = store.getPreview(n.path, 500);
        results.push({ file_path: n.path, content: preview, source: "graph", hop: n.hop, via: n.via, direction: n.direction });
      }
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },
);

server.registerTool(
  "get_similar",
  {
    description: "Find semantically similar notes to a vault-relative note path.",
    inputSchema: {
      note_path: z.string(),
      limit: z.number().int().min(1).max(100).default(5),
    },
  },
  async ({ note_path, limit }) => {
    if (!store.hasNote(note_path)) return { content: [{ type: "text", text: JSON.stringify({ error: `Note not found: ${note_path}` }) }] };
    const q = await embedder.embed(store.getEmbeddingText(note_path, 8000));
    const results = store.search(q, limit + 10, undefined, note_path).slice(0, limit).map(({ chunk, similarity }) => ({
      file_path: chunk.file_path,
      heading: chunk.heading,
      preview: chunk.content.slice(0, 200),
      similarity: Number(similarity.toFixed(3)),
    }));
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },
);

server.registerTool(
  "get_note_context",
  {
    description: "Get full note content, links, backlinks, and related notes.",
    inputSchema: {
      note_path: z.string(),
      limit: z.number().int().min(1).max(100).default(5),
    },
  },
  async ({ note_path, limit }) => {
    if (!store.hasNote(note_path)) return { content: [{ type: "text", text: JSON.stringify({ error: `Note not found: ${note_path}` }) }] };
    const embedding = store.getFirstEmbedding(note_path);
    const related = embedding
      ? store.search(embedding, limit, undefined, note_path).map(({ chunk, similarity }) => ({
          file_path: chunk.file_path,
          heading: chunk.heading,
          similarity: Number(similarity.toFixed(3)),
        }))
      : [];
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          file_path: note_path,
          content: store.getContents(note_path).join("\n\n"),
          links: store.getLinks(note_path),
          backlinks: store.getBacklinks(note_path),
          similar_notes: related,
        }),
      }],
    };
  },
);

server.registerTool(
  "get_note_graph",
  {
    description: "Get outgoing links, backlinks, and graph neighbors of a note.",
    inputSchema: {
      note_path: z.string(),
      hops: z.number().int().min(1).max(5).default(1),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ note_path, hops, limit }) => {
    if (!store.hasNote(note_path)) return { content: [{ type: "text", text: JSON.stringify({ error: `Note not found: ${note_path}` }) }] };
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          file_path: note_path,
          links: store.getLinks(note_path),
          backlinks: store.getBacklinks(note_path),
          beyond_one_hop: hops > 1 ? neighbors([note_path], hops, limit).filter(n => n.hop > 1) : [],
        }),
      }],
    };
  },
);

server.registerTool(
  "get_stats",
  {
    description: "Show indexed chunk, note, and graph statistics.",
    inputSchema: {},
  },
  async () => {
    const totals = store.stats();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          collection: "obsidian_notes",
          count: totals.chunks,
          notes: totals.notes,
          link_edges: totals.links,
          config_path: settings.configPath,
          data_path: path.join(dataDir, "obsidian_notes.db"),
          vault_path: vault,
          provider,
          model,
        }),
      }],
    };
  },
);

server.registerTool(
  "reindex",
  {
    description: "Index or refresh Markdown notes and their Obsidian wikilink graph.",
    inputSchema: { clear: z.boolean().default(false), path_filter: z.string().optional() },
  },
  async ({ clear, path_filter }) => {
    const result = await reindex(clear, path_filter);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      ...(result.errors ? { isError: true } : {}),
    };
  },
);

server.registerTool(
  "remove_note",
  {
    description: "Remove a deleted Markdown note and its related link edges from the local index.",
    inputSchema: { note_path: z.string() },
  },
  async ({ note_path }) => {
    const chunksRemoved = store.removeNote(note_path);
    return { content: [{ type: "text", text: JSON.stringify({ file_path: note_path, chunks_removed: chunksRemoved }) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

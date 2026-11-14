import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describeError, type Embedder } from "./embedder.js";
import type { SqliteStore, StoredChunk } from "./store.js";

export type IndexResult = {
  files_indexed: number;
  chunks_created: number;
  link_edges: number;
  total_in_store: number;
  errors: { file: string; error: string }[] | null;
  path_filter: string | null;
  cleared: boolean;
};

export type IndexProgress =
  | { type: "start"; total: number; clear: boolean; path_filter: string | null }
  | { type: "file-start"; file: string; index: number; total: number }
  | { type: "file-done"; file: string; chunks: number; index: number; total: number }
  | { type: "file-error"; file: string; error: string; index: number; total: number };

export type IndexerOptions = {
  vault: string;
  store: SqliteStore;
  embedder: Embedder;
  maxChunk: number;
  minChunkCharacters: number;
  /** Number of chunks sent per embedding request. */
  batchSize?: number;
};

const wikiRe = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Build a reindex function that can run inside the MCP server or directly from the CLI. */
export function createReindexer(options: IndexerOptions) {
  const { vault, store, embedder, maxChunk, minChunkCharacters } = options;
  const batchSize = options.batchSize ?? 16;
  const excluded = new Set([".git", ".obsidian", ".trash", "attachments", "node_modules", "dist", "coverage"]);

  async function embedInBatches(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      vectors.push(...await embedder.embedBatch(texts.slice(i, i + batchSize), "search_document"));
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
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (excluded.has(ent.name) || ent.name.startsWith(".")) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...await markdownFiles(full));
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) out.push(full);
    }
    return out;
  }

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

  return async function reindex(
    clear: boolean,
    pathFilter?: string,
    onProgress?: (event: IndexProgress) => void,
  ): Promise<IndexResult> {
    const files = await markdownFiles(vault);
    const selected = files.filter((file) => !pathFilter || path.relative(vault, file).replaceAll("\\", "/").startsWith(pathFilter));
    onProgress?.({ type: "start", total: selected.length, clear, path_filter: pathFilter ?? null });
    if (clear) store.clear();
    const resolve = makeResolver(files);
    let indexed = 0, created = 0;
    const errors: { file: string; error: string }[] = [];
    for (const [i, file] of selected.entries()) {
      const rel = path.relative(vault, file).replaceAll("\\", "/");
      const index = i + 1;
      onProgress?.({ type: "file-start", file: rel, index, total: selected.length });
      try {
        let raw = await fs.readFile(file, "utf8");
        raw = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
        const tags = [...raw.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((match) => match[1]);
        const parts = splitChunks(raw).filter((part) => part.text.length >= minChunkCharacters);
        const vectors = await embedInBatches(parts.map((part) => part.text));
        store.deleteFile(rel);
        store.ensureNote(rel);
        parts.forEach((part, j) => {
          const chunk: StoredChunk = {
            id: createHash("sha1").update(`${rel}\0${part.heading}\0${part.text}`).digest("hex"),
            file_path: rel,
            heading: part.heading,
            heading_level: part.level,
            type: rel.startsWith("Daily Notes/") ? "daily" : "note",
            tags: [...new Set(tags)].join(","),
            content: part.text,
            embedding: vectors[j],
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
        onProgress?.({ type: "file-done", file: rel, chunks: parts.length, index, total: selected.length });
      } catch (error) {
        const message = describeError(error);
        errors.push({ file: rel, error: message });
        onProgress?.({ type: "file-error", file: rel, error: message, index, total: selected.length });
      }
    }
    const totals = store.stats();
    return { files_indexed: indexed, chunks_created: created, link_edges: totals.links, total_in_store: totals.chunks, errors: errors.length ? errors : null, path_filter: pathFilter ?? null, cleared: clear };
  };
}

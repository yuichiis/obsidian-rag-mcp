import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import path from "node:path";

export type StoredChunk = {
  id: string;
  file_path: string;
  heading: string | null;
  heading_level: number;
  type: string;
  tags: string;
  content: string;
  embedding: number[];
};

type ChunkRow = Omit<StoredChunk, "embedding"> & { embedding: Uint8Array };
type SearchResult = { chunk: Omit<StoredChunk, "embedding">; similarity: number };

function encodeVector(vector: number[]) {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function decodeVector(blob: Uint8Array): number[] {
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const floats = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return Array.from(floats);
}

function cosine(a: number[], b: number[]) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** SQLite backed note store; vectors are streamed row-by-row during exact search. */
export class SqliteStore {
  readonly db: DatabaseSync;
  private readonly insertChunk: StatementSync;
  private readonly selectChunksForSearch: StatementSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "obsidian_notes.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        heading TEXT,
        heading_level INTEGER NOT NULL,
        type TEXT NOT NULL,
        tags TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(type);
      CREATE TABLE IF NOT EXISTS notes (file_path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS links (
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        PRIMARY KEY (source_path, target_path)
      );
      CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.insertChunk = this.db.prepare(`INSERT OR REPLACE INTO chunks
      (id,file_path,heading,heading_level,type,tags,content,embedding) VALUES (?,?,?,?,?,?,?,?)`);
    this.selectChunksForSearch = this.db.prepare(`SELECT id,file_path,heading,heading_level,type,tags,content,embedding
      FROM chunks WHERE (? IS NULL OR type=?) AND (? IS NULL OR file_path<>?)`);
    this.migrateLegacyJson(path.join(dataDir, "obsidian_notes.json"));
  }

  private migrateLegacyJson(legacyPath: string) {
    if (this.db.prepare("SELECT value FROM metadata WHERE key='legacy_json_imported'").get()) return;
    const transaction = this.db.prepare("INSERT INTO metadata(key,value) VALUES('legacy_json_imported','1')");
    if (existsSync(legacyPath)) {
      const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as { chunks?: StoredChunk[]; links?: Record<string, string[]> };
      this.db.exec("BEGIN");
      try {
        for (const chunk of legacy.chunks ?? []) this.insertChunk.run(
          chunk.id, chunk.file_path, chunk.heading, chunk.heading_level, chunk.type, chunk.tags, chunk.content, encodeVector(chunk.embedding),
        );
        const notePaths = new Set<string>((legacy.chunks ?? []).map((chunk) => chunk.file_path));
        const insertLink = this.db.prepare("INSERT OR IGNORE INTO links(source_path,target_path) VALUES(?,?)");
        for (const [source, targets] of Object.entries(legacy.links ?? {})) {
          notePaths.add(source);
          for (const target of targets) notePaths.add(target);
          for (const target of targets) insertLink.run(source, target);
        }
        const insertNote = this.db.prepare("INSERT OR IGNORE INTO notes(file_path) VALUES(?)");
        for (const notePath of notePaths) insertNote.run(notePath);
        transaction.run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new Error(`Could not migrate legacy JSON index ${legacyPath}: ${String(error)}`, { cause: error });
      }
    } else transaction.run();
  }

  insert(chunk: StoredChunk) {
    this.insertChunk.run(chunk.id, chunk.file_path, chunk.heading, chunk.heading_level, chunk.type, chunk.tags, chunk.content, encodeVector(chunk.embedding));
    this.db.prepare("INSERT OR IGNORE INTO notes(file_path) VALUES(?)").run(chunk.file_path);
  }

  ensureNote(filePath: string) {
    this.db.prepare("INSERT OR IGNORE INTO notes(file_path) VALUES(?)").run(filePath);
  }

  hasNote(filePath: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM notes WHERE file_path=?").get(filePath));
  }

  deleteFile(filePath: string) {
    const result = this.db.prepare("DELETE FROM chunks WHERE file_path=?").run(filePath);
    return Number(result.changes);
  }

  replaceLinks(source: string, targets: string[]) {
    const insert = this.db.prepare("INSERT OR IGNORE INTO links(source_path,target_path) VALUES(?,?)");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT OR IGNORE INTO notes(file_path) VALUES(?)").run(source);
      this.db.prepare("DELETE FROM links WHERE source_path=?").run(source);
      for (const target of targets) insert.run(source, target);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getLinks(filePath: string) {
    return (this.db.prepare("SELECT target_path FROM links WHERE source_path=? ORDER BY target_path").all(filePath) as { target_path: string }[]).map((row) => row.target_path);
  }

  getBacklinks(filePath: string) {
    return (this.db.prepare("SELECT source_path FROM links WHERE target_path=? ORDER BY source_path").all(filePath) as { source_path: string }[]).map((row) => row.source_path);
  }

  getChunks(filePath: string): StoredChunk[] {
    const rows = this.db.prepare(`SELECT id,file_path,heading,heading_level,type,tags,content,embedding FROM chunks WHERE file_path=? ORDER BY rowid`).all(filePath) as unknown as ChunkRow[];
    return rows.map((row) => ({ ...row, embedding: decodeVector(row.embedding) }));
  }

  getContents(filePath: string) {
    return (this.db.prepare("SELECT content FROM chunks WHERE file_path=? ORDER BY rowid").all(filePath) as { content: string }[]).map((row) => row.content);
  }

  getPreview(filePath: string, maxCharacters: number) {
    const row = this.db.prepare("SELECT content FROM chunks WHERE file_path=? ORDER BY rowid LIMIT 1").get(filePath) as { content: string } | undefined;
    return row?.content.slice(0, maxCharacters) ?? "";
  }

  getFirstEmbedding(filePath: string) {
    const row = this.db.prepare("SELECT embedding FROM chunks WHERE file_path=? ORDER BY rowid LIMIT 1").get(filePath) as { embedding: Uint8Array } | undefined;
    return row ? decodeVector(row.embedding) : undefined;
  }

  getEmbeddingText(filePath: string, maxCharacters: number) {
    const rows = this.db.prepare("SELECT content FROM chunks WHERE file_path=? ORDER BY rowid").iterate(filePath) as Iterable<{ content: string }>;
    let text = "";
    for (const row of rows) {
      if (text.length >= maxCharacters) break;
      text += `${text ? "\n\n" : ""}${row.content.slice(0, maxCharacters - text.length)}`;
    }
    return text;
  }

  search(vector: number[], limit: number, type?: string, excludeFile?: string): SearchResult[] {
    const best: SearchResult[] = [];
    const rows = this.selectChunksForSearch.iterate(type ?? null, type ?? null, excludeFile ?? null, excludeFile ?? null) as Iterable<ChunkRow>;
    for (const row of rows) {
      const similarity = cosine(vector, decodeVector(row.embedding));
      if (best.length === limit && similarity <= best[best.length - 1].similarity) continue;
      best.push({ chunk: { id: row.id, file_path: row.file_path, heading: row.heading, heading_level: row.heading_level, type: row.type, tags: row.tags, content: row.content }, similarity });
      best.sort((a, b) => b.similarity - a.similarity);
      if (best.length > limit) best.pop();
    }
    return best;
  }

  clear() {
    this.db.exec("DELETE FROM chunks; DELETE FROM links; DELETE FROM notes;");
  }

  removeNote(filePath: string) {
    const removed = this.deleteFile(filePath);
    this.db.prepare("DELETE FROM links WHERE source_path=? OR target_path=?").run(filePath, filePath);
    this.db.prepare("DELETE FROM notes WHERE file_path=?").run(filePath);
    return removed;
  }

  stats() {
    const chunks = Number((this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number }).count);
    const links = Number((this.db.prepare("SELECT COUNT(*) AS count FROM links").get() as { count: number }).count);
    const notes = Number((this.db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number }).count);
    return { chunks, links, notes };
  }

  close() {
    this.db.close();
  }
}

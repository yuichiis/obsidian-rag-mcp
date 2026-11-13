# obsidian-rag-mcp

TypeScript MCP server for semantic and graph-aware retrieval from Obsidian Markdown vaults. It is based on the sibling `obsidian-notes-rag` Python project and exposes the same core tools: `search_notes`, `get_similar`, `get_note_context`, `get_note_graph`, `get_stats`, and `reindex`.

## Setup

Requires Node.js 24.15 or newer. The server uses Node's built-in SQLite module, so no native SQLite npm add-on is required. [Node.js documents `node:sqlite` as available from v22.5 and a release candidate from v24.15](https://nodejs.org/api/sqlite.html).

```powershell
npm install
npm run build
npm start
```

Configure the vault and embedding provider in the shared configuration file described below before starting the server.

For llama.cpp `llama-server`, configure `provider`, `model`, and `llamacpp.url` in `config.json`. The server URL defaults to `http://localhost:9931` and the model defaults to `default` (suitable for a single-model server). For router mode, set the model to the routable model name. The server uses `/v1/embeddings`, optionally tries `/models/load` once for router mode, and allows up to five minutes for model loading and embedding. If started with `--api-key`, set `llamacpp.api_key`. For Nomic models the server adds `search_document:` and `search_query:` task prefixes; Qwen models receive `Query:` on searches.

No API key is needed for a local llama-server unless you started it with `--api-key`. When neither `OBSIDIAN_RAG_PROVIDER` nor an OpenAI key is configured, the server selects `llamacpp` automatically.

```json
{
  "vault_path": "C:/path/to/your/ObsidianVault",
  "provider": "llamacpp",
  "model": "nomic-embed-text-v2-moe",
  "llamacpp": { "url": "http://localhost:9931" }
}
```

### Ollama

Start Ollama and pull an embedding model, then point the shared config at it:

```powershell
ollama pull nomic-embed-text
```

```json
{
  "vault_path": "C:/path/to/your/ObsidianVault",
  "provider": "ollama",
  "model": "nomic-embed-text",
  "ollama": { "url": "http://localhost:11434" }
}
```

The server uses Ollama's modern `/api/embed` endpoint, including batch requests while indexing. Nomic models receive `search_document:` / `search_query:` task prefixes and Qwen models receive `Query:` on searches, matching the Python implementation. If Ollama sits behind a proxy that requires a Bearer token, add `"api_key": "..."` inside the `ollama` object. The URL defaults to `http://localhost:11434` and can be overridden with `ollama.url` or `OBSIDIAN_RAG_OLLAMA_URL`. The model defaults to `nomic-embed-text`; override it with `model`, `ollama.model`, `OBSIDIAN_RAG_MODEL`, or `OBSIDIAN_RAG_OLLAMA_MODEL`.

### LM Studio

Load an embedding model in LM Studio (for example `text-embedding-nomic-embed-text-v1.5`), start the local server, and point the shared config at it:

```json
{
  "vault_path": "C:/path/to/your/ObsidianVault",
  "provider": "lmstudio",
  "model": "text-embedding-nomic-embed-text-v1.5",
  "lmstudio": { "url": "http://localhost:1234" }
}
```

The server uses LM Studio's OpenAI-compatible `/v1/embeddings` endpoint with batch requests while indexing. Nomic models receive `search_document:` / `search_query:` task prefixes and Qwen models receive `Query:` on searches, matching the Python implementation. If your LM Studio server requires a Bearer token, add `"api_key": "..."` inside the `lmstudio` object. The URL defaults to `http://localhost:1234` and can be overridden with `lmstudio.url` or `OBSIDIAN_RAG_LMSTUDIO_URL`. The model defaults to `text-embedding-nomic-embed-text-v1.5`; override it with `model`, `lmstudio.model`, `OBSIDIAN_RAG_MODEL`, or `OBSIDIAN_RAG_LMSTUDIO_MODEL`.

For other OpenAI-compatible servers, set `provider`, `model`, `base_url`, and, when needed, `openai.api_key` there.

## Shared configuration

The MCP server, CLI, and watcher all read the same `config.json`:

- Windows: `%APPDATA%\obsidian-rag-mcp\config.json` (typically `C:\Users\<you>\AppData\Roaming\obsidian-rag-mcp\config.json`)
- Linux: `$XDG_CONFIG_HOME/obsidian-rag-mcp/config.json`, or `~/.config/obsidian-rag-mcp/config.json` when `XDG_CONFIG_HOME` is unset

Example for llama.cpp:

```json
{
  "vault_path": "C:/sandbox/vault",
  "data_path": "C:/sandbox/develop/obsidian-rag-mcp/obsidian-rag-mcp/data",
  "provider": "llamacpp",
  "model": "nomic-embed-text-v2-moe",
  "llamacpp": {
    "url": "http://localhost:9931"
  },
  "chunk_size": 512,
  "min_characters_per_chunk": 1,
  "similarity_threshold": 0.1,
  "watch": {
    "debounce_seconds": 2
  }
}
```

For a protected llama-server, add `"api_key": "..."` inside the `llamacpp` object. Use `/` in JSON paths on Windows, or escape backslashes as `\\`. Relative `vault_path` and `data_path` values are resolved from the config file's directory.

Environment variables remain supported and override matching values in `config.json`. Set `OBSIDIAN_RAG_CONFIG` to use a config file at a custom location. Common overrides include `OBSIDIAN_RAG_VAULT`, `OBSIDIAN_RAG_PROVIDER`, `OBSIDIAN_RAG_MODEL`, `OBSIDIAN_RAG_OLLAMA_URL`, `OBSIDIAN_RAG_OLLAMA_API_KEY`, `OBSIDIAN_RAG_OLLAMA_MODEL`, `OBSIDIAN_RAG_LMSTUDIO_URL`, `OBSIDIAN_RAG_LMSTUDIO_API_KEY`, `OBSIDIAN_RAG_LMSTUDIO_MODEL`, `OBSIDIAN_RAG_LLAMACPP_URL`, and `OBSIDIAN_RAG_LLAMACPP_API_KEY`.

The first index can be built with the CLI or by calling the MCP `reindex` tool. Chunks, metadata, links, and float32 embeddings are kept in `obsidian_notes.db` under the configured data directory. If `obsidian_notes.json` from an older version is present, it is imported into SQLite on first launch. Embedding requests are batched (up to 16 chunks per request) while indexing, including Ollama's `/api/embed` batch input. Searches stream stored vectors from SQLite and keep only the best matches in memory, so RAM use no longer grows with the entire embedding collection. Search uses exact cosine ranking over disk-backed rows; query time increases with corpus size. Chunk length defaults to 1,500 characters for other models; `nomic-embed-text-v2-moe` is capped at 512. The Python implementation's 1,500-token setting applies to v1 models with a larger context, not v2 moe. Short chunks are indexed by default; set `OBSIDIAN_RAG_MIN_CHARACTERS_PER_CHUNK` to raise the minimum length if desired.

## Command line

Build once, then use `obsidian-rag` from the project directory (or `npm run cli -- ...`). It uses the same MCP tools, vault configuration, embeddings provider, and index as the server:

```powershell
npm run build
node .\dist\cli.js index
node .\dist\cli.js search 'project decisions and architecture' -n 5
```

To add or refresh one file, pass its path relative to the vault. The file must be a Markdown file inside the vault:

```powershell
node .\dist\cli.js index 'Projects/Architecture.md'
node .\dist\cli.js similar 'Projects/Architecture.md' -n 5
node .\dist\cli.js content 'Projects/Architecture.md'
node .\dist\cli.js graph 'Projects/Architecture.md' --hops 2
node .\dist\cli.js stats
node .\dist\cli.js remove 'Projects/OldNote.md'
```

`content` returns the note body, links, backlinks, and similar notes. `remove` removes a note from the RAG index only; it does not delete the Markdown file from the vault. Paths are relative to the configured vault.

## Tests

Run the CLI integration test suite with:

```powershell
npm test
```

The tests create a temporary vault and local fake embeddings endpoint. They exercise indexing, search, similar-note lookup, note content, graph traversal, stats, index removal, and migration from the previous JSON index without requiring a running llama-server or API key.

`index --clear` clears the existing index before rebuilding it. Invoke this option directly through Node (`node .\dist\cli.js index --clear`) so npm does not parse `--clear` as one of its own options. Avoid combining `--clear` with a single-file path unless you intend to clear the rest of the index.

To keep the index updated as notes are added, edited, renamed, or deleted, run the watcher in a terminal:

```powershell
node .\dist\cli.js watch
node .\dist\cli.js watch --debounce 3
```

The watcher waits two seconds after a change by default, then indexes that note. Duplicate filesystem events with unchanged file contents are ignored. It removes deleted notes and their link edges from the index. Stop it with Ctrl+C. It watches for changes after startup and does not perform a full initial reindex.

After installing the package globally or linking it with `npm link`, the same commands are available as `obsidian-rag index` and `obsidian-rag search ...`.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "obsidian-rag-mcp": {
      "command": "node",
      "args": ["C:/path/to/obsidian-rag-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_RAG_CONFIG": "C:/Users/you/AppData/Roaming/obsidian-rag-mcp/config.json"
      }
    }
  }
}
```

The server stores vectors in a local SQLite database and performs bounded-memory exact cosine search. It supports OpenAI-compatible embeddings, llama.cpp `llama-server`, Ollama's `/api/embed` endpoint, and LM Studio's `/v1/embeddings` endpoint (with batch indexing and Nomic/Qwen task prefixes). Configure indexing and search with MCP tools after connecting.

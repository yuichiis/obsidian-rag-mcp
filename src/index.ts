#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { settings } from "./config.js";

type Chunk = { id: string; file_path: string; heading: string | null; heading_level: number; type: string; tags: string; content: string; embedding: number[] };
type State = { chunks: Chunk[]; links: Record<string, string[]> };
const vault = settings.vaultPath;
const dataDir = settings.dataPath;
const dbFile = path.join(dataDir, "obsidian_notes.json");
const { provider, model, baseUrl, apiKey, maxChunk, minChunkCharacters } = settings;
const loadedModels = new Set<string>();
let state: State = { chunks: [], links: {} };
await fs.mkdir(dataDir, { recursive: true });
try { state = JSON.parse(await fs.readFile(dbFile, "utf8")) as State; } catch { /* first run */ }

async function persist() { const tmp = `${dbFile}.tmp`; await fs.writeFile(tmp, JSON.stringify(state)); await fs.rename(tmp, dbFile); }
function embeddingPrefix(taskType: "search_document" | "search_query") {
  const name = model.toLowerCase();
  if (name.includes("nomic")) return `${taskType}: `;
  if (name.includes("qwen") && taskType === "search_query") return "Query: ";
  return "";
}
async function ensureLlamaModelLoaded() {
  if (provider !== "llamacpp" || !model || model === "default" || loadedModels.has(model)) return;
  loadedModels.add(model);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    await fetch(`${baseUrl}/models/load`, { method: "POST", headers, body: JSON.stringify({ model }), signal: AbortSignal.timeout(300_000) });
  } catch { /* Older/single-model servers lack this endpoint; embeddings can auto-load. */ }
}
async function embed(text: string, taskType: "search_document" | "search_query" = "search_document"): Promise<number[]> {
  const llamacpp = provider === "llamacpp";
  const ollama = provider === "ollama";
  const url = ollama ? `${baseUrl}/api/embed` : `${baseUrl}/v1/embeddings`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (llamacpp) await ensureLlamaModelLoaded();
  const input = `${llamacpp ? embeddingPrefix(taskType) : ""}${text}`;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model, input }), ...(llamacpp ? { signal: AbortSignal.timeout(300_000) } : {}) });
  if (!response.ok) throw new Error(`Embedding API ${response.status}: ${await response.text()}`);
  const data = await response.json() as { data?: { embedding: number[] }[]; embeddings?: number[][] };
  const vector = data.data?.[0]?.embedding ?? data.embeddings?.[0];
  if (!vector?.length) throw new Error("Embedding response did not contain a vector");
  return vector;
}
function cosine(a: number[], b: number[]) { let dot=0, aa=0, bb=0; for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];} return aa&&bb?dot/Math.sqrt(aa*bb):0; }
function splitChunks(body: string) {
  const blocks = body.split(/(?=^#{1,6}\s)/m); const result: { heading: string|null; level: number; text: string }[] = [];
  for (const block of blocks) { const m = block.match(/^(#{1,6})\s+(.+?)\s*$/m); const heading=m?.[2]??null, level=m?.[1]?.length??0; const clean=block.trim(); if(!clean) continue;
    if(clean.length <= maxChunk) result.push({heading,level,text:clean});
    else { let rest=clean; while(rest.length){let cut=Math.min(maxChunk,rest.length); if(cut<rest.length){const boundary=rest.lastIndexOf("\n\n",cut); if(boundary>maxChunk*.55)cut=boundary;} const part=rest.slice(0,cut).trim(); if(part)result.push({heading,level,text:part}); rest=rest.slice(cut).trim();} }
  } return result;
}
async function markdownFiles(dir: string): Promise<string[]> { const out:string[]=[]; const excluded=new Set([".git",".obsidian",".trash","attachments","node_modules","dist","coverage"]); for(const ent of await fs.readdir(dir,{withFileTypes:true})){if(excluded.has(ent.name)||ent.name.startsWith("."))continue;const full=path.join(dir,ent.name);if(ent.isDirectory())out.push(...await markdownFiles(full));else if(ent.isFile()&&ent.name.toLowerCase().endsWith(".md"))out.push(full);}return out; }
const wikiRe=/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
function makeResolver(files:string[]){const names=new Map<string,string[]>();for(const f of files){const rel=path.relative(vault,f).replaceAll("\\","/");const base=path.basename(rel,".md");names.set(base,[...(names.get(base)??[]),rel]);}return (target:string)=>{const normalized=target.trim().replaceAll("\\","/").replace(/\.md$/i,"");const exact=files.map(f=>path.relative(vault,f).replaceAll("\\","/")).find(x=>x.replace(/\.md$/i,"")===normalized);return exact??names.get(path.basename(normalized))?.sort((a,b)=>a.length-b.length)[0];};}
async function reindex(clear:boolean,pathFilter?:string){const files=await markdownFiles(vault);const selected=files.filter(f=>!pathFilter||path.relative(vault,f).replaceAll("\\","/").startsWith(pathFilter));if(clear){state.chunks=[];state.links={};}const resolve=makeResolver(files);let indexed=0,created=0;const errors:{file:string;error:string}[]=[];
 for(const file of selected){const rel=path.relative(vault,file).replaceAll("\\","/");try{let raw=await fs.readFile(file,"utf8");raw=raw.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/,"" ).trim();const tags=[...raw.matchAll(/(?:^|\s)#([\w/-]+)/g)].map(m=>m[1]);state.chunks=state.chunks.filter(c=>c.file_path!==rel);for(const part of splitChunks(raw)){if(part.text.length<minChunkCharacters)continue;const vector=await embed(part.text);const id=createHash("sha1").update(`${rel}\0${part.heading}\0${part.text}`).digest("hex");state.chunks.push({id,file_path:rel,heading:part.heading,heading_level:part.level,type:rel.startsWith("Daily Notes/")?"daily":"note",tags:[...new Set(tags)].join(","),content:part.text,embedding:vector});created++;}const links=new Set<string>();for(const match of raw.matchAll(wikiRe)){const target=resolve(match[1]);if(target&&target!==rel)links.add(target);}state.links[rel]=[...links].sort();indexed++;}catch(e){errors.push({file:rel,error:String(e)});} }
 await persist();return{files_indexed:indexed,chunks_created:created,link_edges:Object.values(state.links).reduce((n,x)=>n+x.length,0),total_in_store:state.chunks.length,errors:errors.length?errors:null,path_filter:pathFilter??null,cleared:clear}; }
function neighbors(seeds:string[],hops:number,limit:number){const seen=new Set(seeds),queue=seeds.map(path=>({path,depth:0})),out:{path:string;hop:number;via:string;direction:string}[]=[];while(queue.length&&out.length<limit){const cur=queue.shift()!;if(cur.depth>=hops)continue;const outgoing=state.links[cur.path]??[];const incoming=Object.entries(state.links).filter(([,targets])=>targets.includes(cur.path)).map(([source])=>source);for(const [list,direction] of [[outgoing,"link"],[incoming,"backlink"]] as const)for(const target of list.sort()){if(seen.has(target))continue;seen.add(target);out.push({path:target,hop:cur.depth+1,via:cur.path,direction});queue.push({path:target,depth:cur.depth+1});if(out.length>=limit)return out;}}return out;}
const server=new McpServer({name:"obsidian-rag-mcp",version:"1.0.0"});
server.registerTool("search_notes",{description:"Search Obsidian notes by semantic similarity; optionally expand through linked notes.",inputSchema:{query:z.string(),limit:z.number().int().min(1).max(100).optional(),note_type:z.string().optional(),expand:z.number().int().min(0).max(5).default(0)}},async({query,limit=10,note_type,expand})=>{const q=await embed(query,"search_query");const matches=state.chunks.filter(c=>!note_type||c.type===note_type).map(c=>({c,similarity:cosine(q,c.embedding)})).sort((a,b)=>b.similarity-a.similarity).filter(x=>x.similarity>=(settings.similarityThreshold)).slice(0,limit);const results: Array<{file_path:string;heading?:string|null;content:string;similarity?:number;type?:string;source?:string;hop?:number;via?:string;direction?:string}>=matches.map(({c,similarity})=>({file_path:c.file_path,heading:c.heading,content:c.content.slice(0,500),similarity:Number(similarity.toFixed(3)),type:c.type}));if(expand&&results.length)for(const n of neighbors([...new Set(results.map(x=>x.file_path))],expand,limit*2)){const c=state.chunks.find(x=>x.file_path===n.path);results.push({file_path:n.path,content:c?.content.slice(0,500)??"",source:"graph",hop:n.hop,via:n.via,direction:n.direction});}return{content:[{type:"text",text:JSON.stringify(results)}]};});
server.registerTool("get_similar",{description:"Find semantically similar notes to a vault-relative note path.",inputSchema:{note_path:z.string(),limit:z.number().int().min(1).max(100).default(5)}},async({note_path,limit})=>{const chunks=state.chunks.filter(c=>c.file_path===note_path);if(!chunks.length)return{content:[{type:"text",text:JSON.stringify({error:`Note not found: ${note_path}`})}]};const q=await embed(chunks.map(c=>c.content).join("\n\n").slice(0,8000));const results=state.chunks.filter(c=>c.file_path!==note_path).map(c=>({c,similarity:cosine(q,c.embedding)})).sort((a,b)=>b.similarity-a.similarity).slice(0,limit).map(({c,similarity})=>({file_path:c.file_path,heading:c.heading,preview:c.content.slice(0,200),similarity:Number(similarity.toFixed(3))}));return{content:[{type:"text",text:JSON.stringify(results)}]};});
server.registerTool("get_note_context",{description:"Get full note content, links, backlinks, and related notes.",inputSchema:{note_path:z.string(),limit:z.number().int().min(1).max(100).default(5)}},async({note_path,limit})=>{const chunks=state.chunks.filter(c=>c.file_path===note_path);if(!chunks.length)return{content:[{type:"text",text:JSON.stringify({error:`Note not found: ${note_path}`})}]};const related=state.chunks.filter(c=>c.file_path!==note_path).map(c=>({c,score:cosine(chunks[0].embedding,c.embedding)})).sort((a,b)=>b.score-a.score).slice(0,limit).map(x=>({file_path:x.c.file_path,heading:x.c.heading,similarity:Number(x.score.toFixed(3))}));return{content:[{type:"text",text:JSON.stringify({file_path:note_path,content:chunks.map(c=>c.content).join("\n\n"),links:state.links[note_path]??[],backlinks:Object.entries(state.links).filter(([,v])=>v.includes(note_path)).map(([k])=>k),similar_notes:related})}]};});
server.registerTool("get_note_graph",{description:"Get outgoing links, backlinks, and graph neighbors of a note.",inputSchema:{note_path:z.string(),hops:z.number().int().min(1).max(5).default(1),limit:z.number().int().min(1).max(100).default(20)}},async({note_path,hops,limit})=>{if(!state.chunks.some(c=>c.file_path===note_path)&&!state.links[note_path])return{content:[{type:"text",text:JSON.stringify({error:`Note not found: ${note_path}`})}]};return{content:[{type:"text",text:JSON.stringify({file_path:note_path,links:state.links[note_path]??[],backlinks:Object.entries(state.links).filter(([,v])=>v.includes(note_path)).map(([k])=>k),beyond_one_hop:hops>1?neighbors([note_path],hops,limit).filter(n=>n.hop>1):[]})}]};});
server.registerTool("get_stats",{description:"Show indexed chunk, note, and graph statistics.",inputSchema:{}},async()=>({content:[{type:"text",text:JSON.stringify({collection:"obsidian_notes",count:state.chunks.length,notes:new Set(state.chunks.map(c=>c.file_path)).size,link_edges:Object.values(state.links).reduce((n,x)=>n+x.length,0),config_path:settings.configPath,data_path:dbFile,vault_path:vault,provider,model})}]}));
server.registerTool("reindex",{description:"Index or refresh Markdown notes and their Obsidian wikilink graph.",inputSchema:{clear:z.boolean().default(false),path_filter:z.string().optional()}},async({clear,path_filter})=>({content:[{type:"text",text:JSON.stringify(await reindex(clear,path_filter))}]}));
server.registerTool("remove_note",{description:"Remove a deleted Markdown note and its related link edges from the local index.",inputSchema:{note_path:z.string()}},async({note_path})=>{const before=state.chunks.length;state.chunks=state.chunks.filter(chunk=>chunk.file_path!==note_path);delete state.links[note_path];for(const [source,targets] of Object.entries(state.links))state.links[source]=targets.filter(target=>target!==note_path);await persist();return{content:[{type:"text",text:JSON.stringify({file_path:note_path,chunks_removed:before-state.chunks.length})}]};});
const transport=new StdioServerTransport();await server.connect(transport);

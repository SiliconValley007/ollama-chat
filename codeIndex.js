const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const IGNORE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.lock', '.db', '.zip', '.gz', '.mp4']);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);

function normRoot(root) {
  let r = path.resolve(root);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

function indexPathFor(root) {
  const hash = crypto.createHash('sha1').update(normRoot(root)).digest('hex').slice(0, 12);
  const dir = path.join(__dirname, 'db', 'code-index');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, hash + '.json');
}

function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { listFiles(full, base, out); continue; }
    if (IGNORE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function chunkFile(content) {
  const lines = content.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += (CHUNK_LINES - CHUNK_OVERLAP)) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    const text = lines.slice(i, end).join('\n').trim();
    if (text) chunks.push({ startLine: i + 1, endLine: end, text });
    if (end === lines.length) break;
  }
  return chunks;
}

async function embed(text) {
  const r = await fetch((process.env.OLLAMA_HOST || 'http://localhost:11434') + '/api/embeddings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 8000) })
  });
  if (!r.ok) throw new Error('Embedding request failed: ' + r.status);
  const data = await r.json();
  return data.embedding;
}

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

const buildStatus = new Map(); // root -> { status, total, done }

async function buildIndex(root) {
  const key = normRoot(root);
  buildStatus.set(key, { status: 'running', total: 0, done: 0 });
  try {
    const files = listFiles(root);
    const entries = [];
    let totalChunks = 0;
    const perFileChunks = files.map(f => {
      try {
        const content = fs.readFileSync(path.join(root, f), 'utf8');
        const chunks = chunkFile(content);
        totalChunks += chunks.length;
        return { f, chunks };
      } catch { return { f, chunks: [] }; }
    });
    buildStatus.set(key, { status: 'running', total: totalChunks, done: 0 });

    let done = 0;
    for (const { f, chunks } of perFileChunks) {
      for (const c of chunks) {
        try {
          const vector = await embed(c.text);
          entries.push({ path: f, startLine: c.startLine, endLine: c.endLine, text: c.text, vector });
        } catch (e) { console.warn('[codeIndex] embed failed for', f, e.message); }
        done++;
        buildStatus.set(key, { status: 'running', total: totalChunks, done });
      }
    }
    fs.writeFileSync(indexPathFor(root), JSON.stringify({ builtAt: Date.now(), fileCount: files.length, entries }));
    buildStatus.set(key, { status: 'done', total: totalChunks, done: totalChunks });
  } catch (e) {
    buildStatus.set(key, { status: 'error', error: e.message, total: 0, done: 0 });
  }
}

function getStatus(root) {
  const key = normRoot(root);
  return buildStatus.get(key) || { status: fs.existsSync(indexPathFor(root)) ? 'done' : 'none', total: 0, done: 0 };
}

async function search(root, query, topK = 8) {
  const idxPath = indexPathFor(root);
  if (!fs.existsSync(idxPath)) return { error: 'No index found for this project. Call POST /api/project/index first.' };
  const { entries } = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const qVec = await embed(query);
  const scored = entries.map(e => ({ ...e, score: cosineSim(qVec, e.vector) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(e => ({ path: e.path, startLine: e.startLine, endLine: e.endLine, text: e.text, score: Math.round(e.score * 1000) / 1000 }));
}

module.exports = { buildIndex, getStatus, search };
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const ALLOWED_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift',
  '.html', '.css', '.scss', '.less', '.json', '.yaml', '.yml', '.xml',
  '.md', '.txt', '.sh', '.bat', '.sql', '.gradle', '.properties', '.env'
]);
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'db', 'music', 'output', 'gradle', '.gradle']);
const SENSITIVE_FILE_RX = /(^|[\\\/])([\w.-]*\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)\w*|.*\.pfx|.*\.p12|credentials(\.json)?|.*secrets.*\.(json|ya?ml)|\.npmrc|\.netrc|.*\.keystore|config$|\.git[\\\/]config|\.aws[\\\/].*|\.kube[\\\/].*|\.ssh[\\\/].*|.*token.*\.(json|txt)|.*service[-_]?account.*\.json|\.app_token|.*\.db)$/i;

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

function atomicWriteJSON(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath); // rename is atomic — filePath is never left half-written
}

function listFiles(dir, base = dir, out = [], seen = new Set()) {
  let entries, real, realBase;
  try { real = fs.realpathSync(dir); realBase = fs.realpathSync(base); } catch { return out; }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return out; // symlink escapes project root — never index/embed it
  if (seen.has(real)) return out; // symlink cycle — stop instead of recursing forever
  seen.add(real);
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; } // permission-denied/broken dir — skip, don't fail the whole build
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { listFiles(full, base, out, seen); continue; }
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (SENSITIVE_FILE_RX.test(rel)) continue; // never embed/leak secret-pattern files to a cloud model
    out.push(rel);
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
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch((process.env.OLLAMA_HOST || 'http://localhost:11434') + '/api/embeddings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 8000) }),
      signal: controller.signal
    });
    if (!r.ok) throw new Error('Embedding request failed: ' + r.status);
    const data = await r.json();
    return data.embedding;
  } finally { clearTimeout(t); }
}

function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

const buildStatus = new Map(); // root -> { status, total, done }

async function buildIndex(root) {
  const key = normRoot(root);
  if (buildStatus.get(key)?.status === 'running') return; // prevent overlapping builds racing on the same index file
  buildStatus.set(key, { status: 'running', total: 0, done: 0 });
  try {
    // Reuse vectors for files whose content hash hasn't changed since the last
    // build — avoids re-burning embed quota/time on every edit for a single-file change.
    let prevByPath = new Map();
    try {
      const prev = JSON.parse(fs.readFileSync(indexPathFor(root), 'utf8'));
      for (const e of (prev.entries || [])) {
        if (!prevByPath.has(e.path)) prevByPath.set(e.path, []);
        prevByPath.get(e.path).push(e);
      }
    } catch {}

    const files = listFiles(root);
    const entries = [];
    let totalChunks = 0;
    const perFileChunks = files.map(f => {
      try {
        const full = path.join(root, f);
        if (fs.statSync(full).size > 500 * 1024) return { f, chunks: [], hash: null };
        const content = fs.readFileSync(full, 'utf8');
        const hash = crypto.createHash('sha1').update(content).digest('hex');
        const chunks = chunkFile(content);
        totalChunks += chunks.length;
        return { f, chunks, hash };
      } catch { return { f, chunks: [], hash: null }; }
    });
    buildStatus.set(key, { status: 'running', total: totalChunks, done: 0 });

    let done = 0;
    for (const { f, chunks, hash } of perFileChunks) {
      const cached = hash && prevByPath.get(f);
      if (cached && cached.length && cached[0].fileHash === hash) {
        entries.push(...cached);
        done += chunks.length;
        buildStatus.set(key, { status: 'running', total: totalChunks, done });
        continue;
      }
      for (const c of chunks) {
        try {
          const vector = await embed(c.text);
          entries.push({ path: f, startLine: c.startLine, endLine: c.endLine, text: c.text, vector, fileHash: hash });
        } catch (e) { console.warn('[codeIndex] embed failed for', f, e.message); }
        done++;
        buildStatus.set(key, { status: 'running', total: totalChunks, done });
        // Checkpoint every 200 chunks — bounds data loss on crash/restart to one
        // checkpoint interval instead of the entire (potentially hours-long) build.
        if (done % 200 === 0) {
          try { atomicWriteJSON(indexPathFor(root), { builtAt: Date.now(), fileCount: files.length, entries, partial: true }); } catch {}
        }
      }
    }
    atomicWriteJSON(indexPathFor(root), { builtAt: Date.now(), fileCount: files.length, entries });
    buildStatus.set(key, { status: 'done', total: totalChunks, done: totalChunks });
  } catch (e) {
    buildStatus.set(key, { status: 'error', error: e.message, total: 0, done: 0 });
  }
}

function getStatus(root) {
  const key = normRoot(root);
  if (buildStatus.has(key)) return buildStatus.get(key);
  const idxPath = indexPathFor(root);
  if (!fs.existsSync(idxPath)) return { status: 'none', total: 0, done: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    return data.partial ? { status: 'incomplete', total: 0, done: 0 } : { status: 'done', total: 0, done: 0 };
  } catch { return { status: 'none', total: 0, done: 0 }; }
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
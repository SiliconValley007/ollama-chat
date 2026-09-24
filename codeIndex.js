const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_ROOT } = require('./paths');

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
const SENSITIVE_FILE_RX_BASE = /(^|[\\\/])([\w.-]*\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)\w*|.*\.pfx|.*\.p12|credentials(\.json)?|.*secrets.*\.(json|ya?ml)|\.npmrc|\.netrc|.*\.keystore|config$|\.git[\\\/]config|\.aws[\\\/].*|\.kube[\\\/].*|\.ssh[\\\/].*|.*token.*\.(json|txt)|.*service[-_]?account.*\.json|\.app_token|.*\.db)$/i;

// NTFS: "x::$DATA", "x." and "x " open "x" - test the canonical form too (callers only use .test()).
const SENSITIVE_FILE_RX = { test: (s) => { s = String(s); return SENSITIVE_FILE_RX_BASE.test(s) || SENSITIVE_FILE_RX_BASE.test(s.replace(/:[^\\/]*$/, '').replace(/[. ]+$/, '')); } };

function normRoot(root) {
  let r = path.resolve(root);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

function indexPathFor(root) {
  const hash = crypto.createHash('sha1').update(normRoot(root)).digest('hex').slice(0, 12);
  const dir = path.join(APP_ROOT, 'db', 'code-index');
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
    if (e.isSymbolicLink()) continue; // never follow symlinks — target may be outside the project root
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

function embed(text) {
  return new Promise((resolve, reject) => {
    const u = new URL((process.env.OLLAMA_HOST || 'http://localhost:11434') + '/api/embeddings');
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const payload = JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 8000) });
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('close', () => { if (!res.complete) reject(new Error('Embedding connection closed mid-response')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Embedding request failed: ' + res.statusCode));
        try {
          const v = JSON.parse(data).embedding;
          if (!Array.isArray(v) || !v.length) throw new Error('Embedding response missing vector — is "' + EMBED_MODEL + '" pulled?');
          resolve(v);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Embedding request timed out')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
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
      for (const e of (prev.partial ? [] : (prev.entries || []))) { // partial index: some files have missing chunks, never reuse
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
    let failed = 0, sinceCheckpoint = 0; // counts embeds since the last on-disk checkpoint — avoids the % modulo racing across concurrent workers
    const jobs = []; // flat list of { f, c, hash } for every chunk that needs embedding
    for (const { f, chunks, hash } of perFileChunks) {
      const cached = hash && prevByPath.get(f);
      if (cached && cached.length && cached[0].fileHash === hash) {
        entries.push(...cached);
        done += chunks.length;
        continue;
      }
      for (const c of chunks) jobs.push({ f, c, hash });
    }
    buildStatus.set(key, { status: 'running', total: totalChunks, done });

    // EMBED_CONCURRENCY: how many /api/embeddings requests are in flight at once.
    // Ollama serializes/queues on its own side per model, so this mainly overlaps
    // network + JSON overhead — keep modest to avoid saturating the local box.
    const EMBED_CONCURRENCY = parseInt(process.env.EMBED_CONCURRENCY || '4', 10);
    let cursor = 0;
    let checkpointing = Promise.resolve(); // serializes atomicWriteJSON calls so two workers never interleave a write

    async function worker() {
      while (cursor < jobs.length) {
        const { f, c, hash } = jobs[cursor++];
        try {
          const vector = await embed(c.text);
          entries.push({ path: f, startLine: c.startLine, endLine: c.endLine, text: c.text, vector, fileHash: hash });
        } catch (e) { failed++; console.warn('[codeIndex] embed failed for', f, e.message); }
        done++;
        if (!failed) sinceCheckpoint++; // never checkpoint over a good index while embeds are failing
        buildStatus.set(key, { status: 'running', total: totalChunks, done });
        if (sinceCheckpoint >= 200) {
          sinceCheckpoint -= 200;
          // Chain onto checkpointing so concurrent workers hitting this at once
          // still produce one write at a time (fs.renameSync is atomic per-call,
          // but two overlapping writers could still interleave tmp-file contents).
          checkpointing = checkpointing.then(() =>
            atomicWriteJSON(indexPathFor(root), { builtAt: Date.now(), fileCount: files.length, entries, partial: true })
          ).catch(() => {});
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, jobs.length) }, worker));
    await checkpointing; // make sure the last in-flight checkpoint write finished before the final write below
    if (jobs.length && failed === jobs.length && !entries.length) throw new Error('Embedding failed for every chunk — is "' + EMBED_MODEL + '" pulled and Ollama running?');
    atomicWriteJSON(indexPathFor(root), { builtAt: Date.now(), fileCount: files.length, entries, ...(failed ? { partial: true } : {}) });
    buildStatus.set(key, { status: failed ? 'incomplete' : 'done', total: totalChunks, done: totalChunks - failed });
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

module.exports = { buildIndex, getStatus, search, SENSITIVE_FILE_RX, IGNORE_DIRS };
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { execFile } = require('child_process');
const { diffLines } = require('diff');
const db = require('./db');
const { CLOUD_MODEL_CHAIN, isRetryableError } = require('./modelRouter');
const codeIndex = require('./codeIndex');
const activeTurns = new Map(); // conversationId -> { queue: [] }
const pendingDiffs = new Map(); // pendingId -> { onDecision(approved), conversationId }
const pendingCommands = new Map(); // pendingId -> { onDecision(approved), conversationId }
const rateLimit = require('express-rate-limit');
const log = {
  _fmt: (lvl, args) => '[' + new Date().toISOString() + '] [' + lvl + '] ' + args.join(' '),
  info: (...a) => console.log(log._fmt('INFO', a)),
  warn: (...a) => console.warn(log._fmt('WARN', a)),
  error: (...a) => console.error(log._fmt('ERROR', a)),
};
process.on('unhandledRejection', (e) => { log.error('[unhandledRejection]', e && e.message || String(e)); try { require('./db').flushSync(); } catch {} });
process.on('uncaughtException', (e) => { log.error('[uncaughtException]', e && e.message || String(e)); try { require('./db').flushSync(); } catch {} process.exit(1); });

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:120b-cloud';

// ─── Runtime tuning (env-overridable, single source of truth) ────────────────
function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
let OLLAMA_NUM_CTX = intEnv('OLLAMA_NUM_CTX', 32768);
let OLLAMA_NUM_PREDICT = intEnv('OLLAMA_NUM_PREDICT', 4096);
if (OLLAMA_NUM_PREDICT >= OLLAMA_NUM_CTX) {
  log.error('OLLAMA_NUM_PREDICT (' + OLLAMA_NUM_PREDICT + ') must be less than OLLAMA_NUM_CTX (' + OLLAMA_NUM_CTX + ') — falling back to defaults.');
  OLLAMA_NUM_CTX = 32768; OLLAMA_NUM_PREDICT = 4096;
}
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
// History and tool-loop content share ONE context window — split a single derived
// budget between them instead of letting each claim its own full share, which could
// sum to more than OLLAMA_NUM_CTX. ~3.5 chars/token conservative estimate for code.
const CTX_CHAR_BUDGET = Math.floor((OLLAMA_NUM_CTX - OLLAMA_NUM_PREDICT) * 3.5);
const TOOL_LOOP_CHAR_BUDGET = parseInt(process.env.TOOL_LOOP_CHAR_BUDGET || String(Math.floor(CTX_CHAR_BUDGET * 0.55)), 10);
const MAX_HISTORY_CHARS = parseInt(process.env.MAX_HISTORY_CHARS || String(Math.floor(CTX_CHAR_BUDGET * 0.35)), 10);
const REQUIRE_DIFF_APPROVAL = process.env.REQUIRE_DIFF_APPROVAL !== 'false'; // default ON
const ENABLE_SHELL_TOOL = process.env.ENABLE_SHELL_TOOL !== 'false'; // default ON — gated by per-call approval
const REQUIRE_COMMAND_APPROVAL = process.env.REQUIRE_COMMAND_APPROVAL !== 'false'; // default ON

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 25 * 1024 * 1024, files: 10, fieldSize: 5 * 1024 * 1024 } });

const SHARED_TOKEN = process.env.APP_TOKEN;
if (!SHARED_TOKEN) { log.error('APP_TOKEN env var is required — refusing to start without auth.'); process.exit(1); }
const PUBLIC_ASSETS = new Set(['/', '/index.html', '/sw.js', '/manifest.json', '/favicon.svg', '/icon-192.png', '/icon-192.svg', '/icon-512.png', '/icon-512.svg']);
// NOTE: all /api/* routes remain behind the token check below — only the HTML shell is public now.
app.use((req, res, next) => {
  if (req.path.startsWith('/vendor')) return next(); // ✅ allow static
  if (PUBLIC_ASSETS.has(req.path)) return next();
  const supplied = String(req.headers['x-app-token'] || req.query.token || '');
  const expected = Buffer.from(SHARED_TOKEN);
  const given = Buffer.from(supplied);
  const ok = given.length === expected.length && require('crypto').timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.API_RATE_LIMIT || '300', 10)
}));

// ─── Conversations ────────────────────────────────────────────────────────────

app.get('/api/conversations', (req, res) => {
  try { res.json(db.getAllConversations()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/conversations/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    res.json(db.searchConversations(q));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/conversations', (req, res) => {
  try {
    const id = uuidv4();
    const model = req.body.model || DEFAULT_MODEL;
    res.json(db.createConversation(id, model, req.body.projectRoot || null));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/conversations/:id', (req, res) => {
  try {
    const conversation = db.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Not found' });
    res.json({ ...conversation, messages: db.getMessages(req.params.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/conversations/:id', (req, res) => {
  try {
    db.updateConversationTitle(req.params.id, req.body.title || 'Untitled');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/conversations/:id', (req, res) => {
  try { db.deleteConversation(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Edit message — truncate history at that message and re-send ───────────────

app.delete('/api/conversations/:id/messages-from/:msgId', (req, res) => {
  try {
    db.deleteMessagesFrom(req.params.id, req.params.msgId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Export conversation ──────────────────────────────────────────────────────

app.get('/api/conversations/:id/export', (req, res) => {
  try {
    const conversation = db.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Not found' });
    const messages = db.getMessages(req.params.id);
    const fmt = req.query.format || 'md';

    let content = '';
    if (fmt === 'md') {
      content = '# ' + conversation.title + '\n\n';
      content += '_Exported from Claude Chat — ' + new Date().toLocaleString() + '_\n\n---\n\n';
      for (const m of messages) {
        content += '**' + (m.role === 'user' ? 'You' : 'Assistant') + ':**\n\n' + m.content + '\n\n---\n\n';
      }
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', 'attachment; filename="' + conversation.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40) + '.md"');
    } else {
      content = conversation.title + '\n' + '='.repeat(conversation.title.length) + '\n\n';
      content += 'Exported: ' + new Date().toLocaleString() + '\n\n';
      for (const m of messages) {
        content += (m.role === 'user' ? 'YOU' : 'ASSISTANT') + ':\n' + m.content + '\n\n';
      }
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', 'attachment; filename="' + conversation.title.replace(/[^a-z0-9]/gi, '_').slice(0, 40) + '.txt"');
    }
    res.send(content);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
app.post('/api/chat/steer', (req, res) => {
  const conversationId = req.body.conversationId;
  const turn = activeTurns.get(conversationId);
  if (!turn) return res.status(409).json({ error: 'No active turn for this conversation' });
  if (!turn.emit) return res.status(409).json({ error: 'Steering is only supported for project (agentic) turns.' });
  const note = (req.body.note || '').trim();
  if (!note) return res.json({ ok: true });
  turn.queue.push(note);
  const noteId = uuidv4();
  db.addMessage(noteId, conversationId, 'steer', note);
  if (turn.emit) turn.emit({ type: 'steer_note', id: noteId, note });
  res.json({ ok: true });
});

app.post('/api/chat/diff-approve', (req, res) => {
  const { pendingId, approve } = req.body;
  const pending = pendingDiffs.get(pendingId);
  if (!pending) return res.status(404).json({ error: 'No pending diff with that id (it may have expired after 5 minutes).' });
  pendingDiffs.delete(pendingId);
  try { pending.onDecision(!!approve); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chat/command-approve', (req, res) => {
  const { pendingId, approve } = req.body;
  const pending = pendingCommands.get(pendingId);
  if (!pending) return res.status(404).json({ error: 'No pending command (expired).' });
  pendingCommands.delete(pendingId);
  try { pending.onDecision(!!approve); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chat', upload.array('files', 10), async (req, res) => {
  const conversationId = req.body.conversationId;
  const message = (req.body.message || '').trim();
  const files = req.files || [];

  if (!conversationId || (!message && files.length === 0)) {
    return res.status(400).json({ error: 'conversationId and message or file required' });
  }
  if (activeTurns.has(conversationId)) {
    return res.status(409).json({ error: 'This conversation already has a message in flight from another tab or device. Wait for it to finish, or stop it, before sending another.' });
  }
  // Claim the slot before any `await` gives a concurrent request a window to pass the check too.
  activeTurns.set(conversationId, { queue: [], aborted: false });

  let conversation = db.getConversation(conversationId);
  if (!conversation) {
    conversation = db.createConversation(conversationId, req.body.model || DEFAULT_MODEL);
  }
  const requestedModel = (req.body.model || '').trim();
  if (requestedModel && requestedModel !== conversation.model) {
    db.updateConversationModel(conversationId, requestedModel);
    conversation.model = requestedModel;
  }

  const content_parts = [];
  const storage_lines = [];

  for (const file of files) {
    const mime = file.mimetype;
    const name = file.originalname;
    try {
      if (mime.startsWith('image/')) {
        content_parts.push({ type: 'text', text: '[Image rejected: ' + name + ' — no available model supports image understanding]' });
        storage_lines.push('[Image rejected: ' + name + ']');
        log.info('[file] image rejected (unsupported):', name);
      } else if (mime === 'application/pdf') {
        const buffer = fs.readFileSync(file.path);
        let pdfText = '';
        try {
          const parsed = await pdfParse(buffer);
          pdfText = (parsed.text || '').trim();
          log.info('[file] PDF:', name, pdfText.length, 'chars');
        } catch (e) { log.warn('[file] pdf-parse failed:', name, e.message); }

        if (pdfText.length > 30) {
          const truncated = pdfText.slice(0, 40000);
          const ellipsis = pdfText.length > 40000 ? '\n[...truncated]' : '';
          content_parts.push({ type: 'text', text: '<document filename="' + name + '" type="pdf">\n' + truncated + ellipsis + '\n</document>' });
          storage_lines.push('[PDF attached: ' + name + ' — ' + Math.round(pdfText.length / 1000) + 'k chars extracted]');
        } else {
          content_parts.push({ type: 'text', text: '<document filename="' + name + '">\n[Scanned/image-only PDF — no text extractable. Ask user to paste text or send screenshots.]\n</document>' });
          storage_lines.push('[PDF attached: ' + name + ' — scanned/image-only]');
        }

      } else {
        let textContent = '';
        try { textContent = fs.readFileSync(file.path, 'utf8').slice(0, 40000); }
        catch { try { textContent = fs.readFileSync(file.path, 'latin1').slice(0, 40000); } catch { textContent = '[Could not read]'; } }
        content_parts.push({ type: 'text', text: '<document filename="' + name + '">\n' + textContent + '\n</document>' });
        storage_lines.push('[File attached: ' + name + ']');
        log.info('[file] text:', name);
      }
    } catch (err) {
      content_parts.push({ type: 'text', text: '[Error reading: ' + name + ']' });
      storage_lines.push('[File error: ' + name + ']');
    } finally {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }

  if (message) content_parts.push({ type: 'text', text: message });

  const storageContent = [...storage_lines, message].filter(Boolean).join('\n');
  db.addMessage(uuidv4(), conversationId, 'user', storageContent);

  const rawHistory = db.getMessageHistory(conversationId);

  const requestedProjectRoot = req.body.projectRoot && fs.existsSync(req.body.projectRoot) ? req.body.projectRoot : null;
  const projectRoot = requestedProjectRoot || (conversation.project_root && fs.existsSync(conversation.project_root) ? conversation.project_root : null);
  if (requestedProjectRoot && requestedProjectRoot !== conversation.project_root) {
    db.updateConversationProjectRoot(conversationId, requestedProjectRoot);
    conversation.project_root = requestedProjectRoot;
  }
  let systemContent = 'You are a helpful AI coding assistant.';
  if (projectRoot) {
    const rules = loadProjectRules(projectRoot);
    const tree = walk(projectRoot);
    const fileCount = countTreeFiles(tree);
    const LARGE_REPO_THRESHOLD = parseInt(process.env.LARGE_REPO_THRESHOLD || '400', 10);
    const indexStatus = codeIndex.getStatus(projectRoot);
    const baseInstructions = 'Call read_file to read a file, edit_file to make a targeted change to an existing file ' +
      '(always read_file first, then copy exact text into old_str), write_file to create a new file or fully rewrite one, ' +
      'and execute_command to run tests/linters/builds to verify your changes. Be selective about what you read. ' +
      'After making changes, briefly summarize what you edited.';
    if (fileCount > LARGE_REPO_THRESHOLD) {
      systemContent = 'You have access to the user\'s open project at "' + projectRoot + '" (' + fileCount + ' files — too large for a full tree dump). ' +
        (indexStatus.status === 'done'
          ? 'A semantic index exists — use search_codebase to find relevant code before reading files directly.'
          : 'No semantic index exists yet — the user should run indexing, or you can still use read_file with paths they mention.') +
        ' ' + baseInstructions;
    } else {
      const treeText = formatTree(tree);
      systemContent = 'You have access to the user\'s open project at "' + projectRoot + '" (' + fileCount + ' files). Full file tree below — ' +
        'you do NOT have file contents yet. ' + baseInstructions + '\n\n' + treeText;
    }
    if (rules) systemContent += '\n\n--- Project rules (' + rules.file + ') — follow these strictly ---\n' + rules.content;
  }
  // System prompt was previously uncounted against the context budget — cap it and
  // deduct its size so history + system never exceed the intended total.
  const SYSTEM_PROMPT_CAP = Math.floor(CTX_CHAR_BUDGET * 0.20);
  if (systemContent.length > SYSTEM_PROMPT_CAP) systemContent = systemContent.slice(0, SYSTEM_PROMPT_CAP) + '\n[...tree/rules truncated to fit context budget]';
  const historyBudget = Math.max(1000, MAX_HISTORY_CHARS - systemContent.length);
  let historyForOllama = [{ role: 'system', content: systemContent }];

  for (let i = 0; i < rawHistory.length - 1; i++) {
    historyForOllama.push({ role: rawHistory[i].role, content: rawHistory[i].content });
  }

  // Always send as plain string — gpt-oss:120b-cloud does not accept array content
  let combinedContent = content_parts.map(p => p.text || '').join('\n').trim();
  const CURRENT_TURN_CHAR_CAP = Math.floor(historyBudget * 0.9);
  if (combinedContent.length > CURRENT_TURN_CHAR_CAP) {
    combinedContent = combinedContent.slice(0, CURRENT_TURN_CHAR_CAP) + '\n[...truncated: attachments + message exceeded the context budget]';
  }
  historyForOllama.push({ role: 'user', content: combinedContent });
  historyForOllama = trimHistoryToBudget(historyForOllama, historyBudget);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const assistantMsgId = uuidv4();
  let assistantContent = '';
  let finished = false;
  let userAborted = false;
  let lastEditedFiles = null;
  let ollamaReq;
  res.on('close', () => {
    userAborted = true;
    if (!finished) ollamaReq?.destroy();
    const turn = activeTurns.get(conversationId);
    if (turn) { turn.aborted = true; turn.activeRequest?.destroy(); turn.activeChild?.kill('SIGTERM'); }
    for (const [id, p] of pendingDiffs) if (p.conversationId === conversationId) { pendingDiffs.delete(id); p.onDecision(false); }
    for (const [id, p] of pendingCommands) if (p.conversationId === conversationId) { pendingCommands.delete(id); p.onDecision(false); }
    // Save whatever partial reply had streamed in so far, and still set the
    // conversation title — otherwise a stopped response vanishes on refresh
    // and the chat stays named "New Chat" forever.
    finish();
  });

  function finish() {
    activeTurns.delete(conversationId);
    if (finished) return;
    finished = true;
    if (assistantContent) {
      db.addMessage(assistantMsgId, conversationId, 'assistant', assistantContent, lastEditedFiles);
      if (conversation.title === 'New Chat') {
        db.updateConversationTitle(conversationId, generateTitle(message || storage_lines[0] || 'File upload'));
      }
    }
    if (!res.writableEnded) {
      res.write('data: ' + JSON.stringify({ done: true, messageId: assistantMsgId, conversationId }) + '\n\n');
      res.end();
    }
  }

  function sendError(msg) {
    activeTurns.delete(conversationId);
    if (!res.writableEnded) { res.write('data: ' + JSON.stringify({ error: msg }) + '\n\n'); res.end(); }
  }

    if (projectRoot) {
    try {
      const emit = (evt) => {
        // Accumulate as tokens stream so an abort mid tool-loop still has content
        // to persist in finish(); clear on stream_reset since that content was discarded.
        if (evt.token) assistantContent += evt.token;
        if (evt.type === 'stream_reset') assistantContent = '';
        if (evt.type) db.addEvent(uuidv4(), conversationId, evt.type, evt);
        if (!res.writableEnded) res.write('data: ' + JSON.stringify(evt) + '\n\n');
      };
      const turnRef = activeTurns.get(conversationId);
      if (turnRef) turnRef.emit = emit;
      let result, usedModel = conversation.model || DEFAULT_MODEL;
      const chain = [usedModel, ...CLOUD_MODEL_CHAIN.filter(m => m !== usedModel)];
      let lastErr;
      for (const m of chain) {
        try { result = await resolveToolCalls(historyForOllama.slice(), projectRoot, m, conversationId, emit); usedModel = m; break; }
        catch (err) { lastErr = err; if (!isRetryableError(err)) throw err; log.warn('[fallback] ' + m + ' failed, trying next'); emit({ type: 'model_fallback', from: m }); }
      }
      if (!result) throw lastErr || new Error('All models exhausted');
      if (usedModel !== conversation.model) db.updateConversationModel(conversationId, usedModel);
      emit({ type: 'model_used', model: usedModel });
      assistantContent = result.content;
      lastEditedFiles = result.editedFiles && result.editedFiles.length ? result.editedFiles : null;
      res.write('data: ' + JSON.stringify({ usage: { promptTokens: result.promptTokens, evalTokens: result.evalTokens } }) + '\n\n');
      finish();
    } catch (err) {
      sendError('Project chat error: ' + err.message);
    }
    return;
  }

  const baseModel = conversation.model || DEFAULT_MODEL;
  const modelChain = [baseModel, ...CLOUD_MODEL_CHAIN.filter(m => m !== baseModel)];

  function attemptStream(chainIdx) {
    if (chainIdx >= modelChain.length) {
      if (!finished) sendError('All models in the fallback chain failed to respond.');
      return;
    }
    const model = modelChain[chainIdx];
    let gotFirstByte = false;

    const ollamaUrl = OLLAMA_HOST + '/api/chat';
    const payload = JSON.stringify({ model, messages: historyForOllama, stream: true, keep_alive: OLLAMA_KEEP_ALIVE, options: { num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT } });
    log.info('[chat] attempt', chainIdx + 1 + '/' + modelChain.length, '| model:', model, '| msgs:', historyForOllama.length, '| files:', files.length, '| payload:', Math.round(Buffer.byteLength(payload) / 1024) + 'KB');

    const urlObj = new URL(ollamaUrl);
    const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');

    ollamaReq = httpModule.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 300000
    }, (ollamaRes) => {
      log.info('[chat] Ollama status:', ollamaRes.statusCode, '| model:', model);
      if (ollamaRes.statusCode !== 200) {
        let errBody = '';
        ollamaRes.on('data', c => errBody += c);
        ollamaRes.on('end', () => {
          const err = new Error('Ollama error ' + ollamaRes.statusCode + ': ' + errBody);
          if (isRetryableError(err) && chainIdx < modelChain.length - 1) {
            log.warn('[fallback] ' + model + ' failed pre-stream (' + ollamaRes.statusCode + '), trying next model');
            attemptStream(chainIdx + 1);
          } else {
            sendError(err.message);
          }
        });
        return;
      }

      if (model !== conversation.model) {
        db.updateConversationModel(conversationId, model);
        conversation.model = model;
      }
      if (!res.writableEnded) res.write('data: ' + JSON.stringify({ model_used: model }) + '\n\n');

      let lineBuffer = '';
      ollamaRes.on('data', (chunk) => {
        gotFirstByte = true;
        if (userAborted && res.writableEnded) { ollamaReq.destroy(); return; }
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.message && data.message.content) {
              assistantContent += data.message.content;
              if (!res.writableEnded) res.write('data: ' + JSON.stringify({ token: data.message.content }) + '\n\n');
            }
            if (data.done === true) {
              res.write('data: ' + JSON.stringify({ usage: { promptTokens: data.prompt_eval_count || 0, evalTokens: data.eval_count || 0 } }) + '\n\n');
              finish();
            }
          } catch (_) {}
        }
      });
      ollamaRes.on('end', () => { if (!finished) finish(); });
      ollamaRes.on('error', err => { if (!finished) sendError('Stream error: ' + err.message); });
    });

    ollamaReq.on('timeout', () => {
      ollamaReq.destroy();
      if (!gotFirstByte && chainIdx < modelChain.length - 1) {
        log.warn('[fallback] ' + model + ' timed out pre-stream, trying next model');
        attemptStream(chainIdx + 1);
      } else if (!finished) sendError('Request timed out.');
    });
    ollamaReq.on('error', err => {
      if (!gotFirstByte && isRetryableError(err) && chainIdx < modelChain.length - 1) {
        log.warn('[fallback] ' + model + ' unreachable (' + err.message + '), trying next model');
        attemptStream(chainIdx + 1);
      } else if (!finished) sendError('Cannot connect to Ollama: ' + err.message);
    });
    ollamaReq.write(payload);
    ollamaReq.end();
  }

  try {
    attemptStream(0);
  } catch (err) {
    if (!finished) sendError('Server error: ' + err.message);
  }
});


// ─── PDF Preview (in-memory, 10min TTL) ──────────────────────────────────────

const pdfPreviews = new Map(); // id -> { buffer, name, expires }

// Use memoryStorage so file is in req.file.buffer — no disk path needed
const previewUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 }
});

app.post('/api/preview-upload', previewUpload.single('file'), (req, res) => {
  try {
    if (!req.file || req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'PDF required' });
    }
    const id = uuidv4();
    // req.file.buffer exists because we use memoryStorage
    pdfPreviews.set(id, {
      buffer: req.file.buffer,
      name: req.file.originalname || 'document.pdf',
      expires: Date.now() + 10 * 60 * 1000
    });
    setTimeout(() => pdfPreviews.delete(id), 10 * 60 * 1000);
    res.json({ id });
  } catch (err) {
    log.error('[preview-upload] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/preview/:id', (req, res) => {
  const entry = pdfPreviews.get(req.params.id);
  if (!entry || Date.now() > entry.expires) {
    return res.status(404).send('Preview expired or not found');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + entry.name.replace(/"/g, '') + '"');
  res.send(entry.buffer);
});

// ─── Models ───────────────────────────────────────────────────────────────────

app.get('/api/models', (req, res) => {
  const urlObj = new URL(OLLAMA_HOST + '/api/tags');
  const httpMod = urlObj.protocol === 'https:' ? require('https') : require('http');
  let data = '';
  const r = httpMod.get(OLLAMA_HOST + '/api/tags', ollamaRes => {
    ollamaRes.on('data', c => data += c);
    ollamaRes.on('end', () => {
      try {
        const models = (JSON.parse(data).models || [])
          .filter(m => !m.name.startsWith('nomic-embed-text') && !/embed/i.test(m.name));
        res.json(models.map(m => ({ name: m.name })));
      }
      catch { res.json([]); }
    });
  });
  r.on('error', () => res.json([]));
});

function loadProjectRules(root) {
  const candidates = ['CLAUDE.md', '.cursorrules', '.cursor/rules.md'];
  for (const rel of candidates) {
    const p = path.join(root, rel);
    if (fs.existsSync(p)) {
      try { return { file: rel, content: fs.readFileSync(p, 'utf8').slice(0, 6000) }; } catch {}
    }
  }
  return null;
}

// ─── Project Folder Context ──────────────────────────────────────────────────
function formatTree(nodes, depth = 0) {
  return nodes.map(n => {
    const indent = '  '.repeat(depth);
    return n.type === 'dir'
      ? indent + n.name + '/\n' + formatTree(n.children, depth + 1)
      : indent + n.name;
  }).join('\n');
}

function safeResolve(root, relPath) {
  const resolvedRoot = path.resolve(root);
  const p = path.resolve(resolvedRoot, relPath || '.');
  if (p !== resolvedRoot && !p.startsWith(resolvedRoot + path.sep)) throw new Error('Path outside project root');
  let realRoot;
  try { realRoot = fs.realpathSync(resolvedRoot); } catch { realRoot = resolvedRoot; }
  // Realpath-check the nearest EXISTING ancestor, not just p itself — catches a
  // symlinked intermediate directory even when the final component (a new file
  // write_file is about to create) doesn't exist yet.
  let probe = p;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw new Error('Path outside project root (symlink)');
  return p;
}

const MAX_TOOL_CALLS = parseInt(process.env.MAX_TOOL_CALLS || '1000', 10);

// Keeps the tool-result portion of the conversation under TOOL_LOOP_CHAR_BUDGET by
// collapsing the oldest tool outputs first. Never touches system/user/assistant turns.
function enforceToolBudget(messages, budgetChars) {
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool' && m.role !== 'assistant' && !(m.role === 'user' && i > 0)) continue;
    total += (m.content || '').length;
    if (total > budgetChars) {
      if (m.role === 'tool' && !m.content.startsWith('[older tool output omitted')) {
        m.content = '[older tool output omitted to save context — call the tool again if you need it]';
      } else if (m.role !== 'tool' && !m.content.startsWith('[older message omitted')) {
        m.content = '[older message omitted to save context]';
      }
    }
  }
}

const SENSITIVE_FILE_RX = /(^|[\\\/])([\w.-]*\.env(\..*)?|.*\.pem|.*\.key|id_[re]?[cd]sa.*|.*\.pfx|.*\.p12|credentials(\.json)?|.*secrets.*\.(json|ya?ml)|\.npmrc|\.netrc|.*\.keystore|config$|\.git[\\\/]config|\.aws[\\\/].*|\.kube[\\\/].*|\.ssh[\\\/].*|.*token.*\.(json|txt)|.*service[-_]?account.*\.json)$/i;
function toolReadFile(root, relPath) {
  if (SENSITIVE_FILE_RX.test(relPath)) return 'Error: reading this file is blocked (matches a secrets/key pattern) — this project sends file contents to a cloud-hosted model.';
  const resolved = safeResolve(root, relPath);
  const stat = fs.statSync(resolved);
  if (stat.size > 20 * 1024 * 1024) return 'Error: file is ' + Math.round(stat.size/1024/1024) + 'MB — too large to read directly. Use execute_command (head/sed/grep) to inspect it in pieces.';
  const full = fs.readFileSync(resolved, 'utf8');
  if (full.length <= 10000) return full;
  return full.slice(0, 10000) + '\n[...truncated — file is ' + full.length + ' chars, only first 10000 shown. Use execute_command (e.g. sed/grep) to inspect the rest before editing near the end.]';
}

// ─── Shell execution (opt-in via ENABLE_SHELL_TOOL=true) ─────────────────────
const SHELL_BLOCKLIST = [
  /rm\s+-rf\s+\//i, /sudo\b/i, /mkfs/i, /dd\s+if=/i, /:\(\)\{.*\};:/,
  /shutdown/i, /reboot/i, /curl[^\n]*\|\s*(ba|z)?sh\b/i, /wget[^\n]*\|\s*(ba|z)?sh\b/i,
  />\s*\/dev\/sd/i, /chmod\s+-R\s+777\s+\//i,
  /format\s+[a-z]:/i, /del\s+\/[a-z]*s[a-z]*\s/i, /remove-item[^\n]*-recurse[^\n]*-force/i, /remove-item[^\n]*-force[^\n]*-recurse/i, /rd\s+\/s/i,
  // Any rm/del/rmdir/remove-item/rd targeting a path that walks above cwd via ".."
  /\b(rm|del|rmdir|remove-item|rd)\b[^\n]*\.\.(?:[\\/]|\s|$)/i
];

function runShellCommand(root, command, settle, conversationId) {
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/c' : '-c';
  const child = execFile(shell, [shellFlag, command], { cwd: root, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
    const t = activeTurns.get(conversationId);
    if (t) t.activeChild = null;
    const out = (stdout || '').slice(0, 8000);
    const errOut = (stderr || '').slice(0, 4000);
    if (err && err.killed) return settle('Command timed out or was cancelled.\n' + out + (errOut ? '\n--- stderr ---\n' + errOut : ''));
    if (err) return settle('Exit code ' + err.code + '\n' + out + (errOut ? '\n--- stderr ---\n' + errOut : ''));
    settle('Exit code 0\n' + out + (errOut ? '\n--- stderr ---\n' + errOut : ''));
  });
  const t = activeTurns.get(conversationId);
  if (t) t.activeChild = child;
}

function stageCommandExecution(root, command, emit, conversationId) {
  return new Promise((settle) => {
    if (!ENABLE_SHELL_TOOL) return settle('Error: shell execution is disabled on this server.');
    if (!command || typeof command !== 'string') return settle('Error: command is required');
    if (SENSITIVE_FILE_RX.test(command)) return settle('Error: command references a secrets/key file and is blocked — output would be sent to a cloud-hosted model.');
    if (SHELL_BLOCKLIST.some(rx => rx.test(command))) return settle('Error: command blocked by safety policy.');
    if (!REQUIRE_COMMAND_APPROVAL) return runShellCommand(root, command, settle, conversationId);

    const pendingId = uuidv4();
    emit({ type: 'command_pending', pendingId, command });
    const timeout = setTimeout(() => {
      pendingCommands.delete(pendingId);
      settle('Command was not approved within 5 minutes — NOT run: ' + command);
    }, 5 * 60 * 1000);
    pendingCommands.set(pendingId, {
      conversationId,
      onDecision: (approved) => {
        clearTimeout(timeout);
        if (approved) runShellCommand(root, command, settle, conversationId);
        else settle('The user rejected running this command: "' + command + '". Do not retry it — ask what they want instead.');
      }
    });
  });
}

function computeDiff(oldContent, newContent) {
  return diffLines(oldContent || '', newContent).map(part => ({
    added: !!part.added, removed: !!part.removed, value: part.value
  }));
}

// Replaces direct toolWriteFile/toolEditFile calls. Computes the diff, stages it,
// and — unless REQUIRE_DIFF_APPROVAL=false — blocks until the user approves/rejects
// via POST /api/chat/diff-approve.
function stageFileChange(root, relPath, opts, emit, conversationId) {
  return new Promise((settle) => {
    if (SENSITIVE_FILE_RX.test(relPath)) return settle('Error: writing to this file is blocked (matches a secrets/key pattern).');
    let p;
    try { p = safeResolve(root, relPath); } catch (e) { return settle('Error: ' + e.message); }
    const exists = fs.existsSync(p);
    const currentContent = exists ? fs.readFileSync(p, 'utf8') : '';

    let finalContent;
    if (opts.isEdit) {
      const count = currentContent.split(opts.oldStr).length - 1;
      if (count === 0) return settle('Error: old_str not found in ' + relPath + '. Read the file again and copy the exact text.');
      if (count > 1) return settle('Error: old_str matches ' + count + ' times in ' + relPath + ' — add more surrounding context to make it unique.');
      finalContent = currentContent.replace(opts.oldStr, opts.newStr);
    } else {
      finalContent = opts.content;
    }

    const writeAndSettle = (note) => {
      const latestOnDisk = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      if (latestOnDisk !== currentContent) {
        return settle('Error: ' + relPath + ' changed on disk while waiting for approval — change NOT applied to avoid overwriting the newer version. Re-read the file and retry.');
      }
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, finalContent, 'utf8');
      settle((exists ? 'File edited: ' : 'File created: ') + relPath + note);
    };

    if (!REQUIRE_DIFF_APPROVAL) return writeAndSettle('');

    const pendingId = uuidv4();
    emit({ type: 'diff_pending', pendingId, path: relPath, isNew: !exists, diff: computeDiff(currentContent, finalContent) });

    const timeout = setTimeout(() => {
      pendingDiffs.delete(pendingId);
      settle('Error: no response from user within 5 minutes — change to ' + relPath + ' was NOT applied.');
    }, 5 * 60 * 1000);

    pendingDiffs.set(pendingId, {
      conversationId,
      onDecision: (approved) => {
        clearTimeout(timeout);
        if (approved) writeAndSettle(' (approved by user)');
        else settle('Change to ' + relPath + ' was rejected by the user. Do not reapply the same edit — ask what they want instead.');
      }
    });
  });
}

function countTreeFiles(nodes) {
  return nodes.reduce((n, x) => n + (x.type === 'dir' ? countTreeFiles(x.children) : 1), 0);
}

function summarizeArgs(toolName, args) {
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') return { path: args.path };
  if (toolName === 'execute_command') return { command: args.command };
  if (toolName === 'search_codebase') return { query: args.query };
  return {};
}

async function resolveToolCalls(messages, projectRoot, model, conversationId, emit) {
  const readCache = new Map();
  const editedFiles = new Set();
  let totalPromptTokens = 0, totalEvalTokens = 0;
  for (let i = 0; i < MAX_TOOL_CALLS; i++) {
    const turn = activeTurns.get(conversationId);
    if (turn && turn.aborted) return { content: '', promptTokens: totalPromptTokens, evalTokens: totalEvalTokens, editedFiles: [...editedFiles] };
    if (turn && turn.queue.length) {
      const notes = turn.queue.splice(0).join('\n');
      messages.push({ role: 'user', content: '[Steering note from user — apply this now]: ' + notes });
    }
    enforceToolBudget(messages, TOOL_LOOP_CHAR_BUDGET);
    let data;
    try {
      data = await ollamaChatStream(messages, PROJECT_TOOLS, model, conversationId, chunk => emit({ token: chunk }));
    } catch (e) {
      if (e && e.steered) {
        emit({ type: 'stream_reset' });
        if (e.partial) messages.push({ role: 'assistant', content: e.partial });
        messages.push({ role: 'user', content: '[Steering note from user — apply this now]: ' + e.note });
        continue;
      }
      throw e;
    }
    totalPromptTokens += data.prompt_eval_count || 0;
    totalEvalTokens += data.eval_count || 0;
    const msg = data.message || {};
    if (!msg.tool_calls || !msg.tool_calls.length) {
      return { content: msg.content || '', promptTokens: totalPromptTokens, evalTokens: totalEvalTokens, editedFiles: [...editedFiles] };
    }
    emit({ type: 'stream_reset' });
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
    let touchedFiles = false;
    for (const call of msg.tool_calls) {
      const args = call.function.arguments || {};
      let result;
      const callId = call.id || (conversationId + ':' + i + ':' + Math.random().toString(36).slice(2, 8));
      emit({ type: 'tool_start', callId, tool: call.function.name, args: summarizeArgs(call.function.name, args) });
      const startedAt = Date.now();
      try {
        if (call.function.name === 'read_file') {
          if (readCache.has(args.path)) { result = readCache.get(args.path); }
          else { result = toolReadFile(projectRoot, args.path); readCache.set(args.path, result); }
        } else if (call.function.name === 'write_file') {
          result = await stageFileChange(projectRoot, args.path, { isEdit: false, content: args.content }, emit, conversationId);
          if (!result.startsWith('Error') && !result.startsWith('Change to')) { editedFiles.add(args.path); touchedFiles = true; readCache.delete(args.path); }
        } else if (call.function.name === 'edit_file') {
          result = await stageFileChange(projectRoot, args.path, { isEdit: true, oldStr: args.old_str, newStr: args.new_str }, emit, conversationId);
          if (!result.startsWith('Error') && !result.startsWith('Change to')) { editedFiles.add(args.path); touchedFiles = true; readCache.delete(args.path); }
        } else if (call.function.name === 'execute_command') {
          result = await stageCommandExecution(projectRoot, args.command, emit, conversationId);
        } else if (call.function.name === 'search_codebase') {
          result = await toolSearchCodebase(projectRoot, args.query, args.top_k);
        } else {
          result = 'Error: unknown tool ' + call.function.name;
        }
      } catch (e) { result = 'Error: ' + e.message; }
      emit({ type: 'tool_end', callId, tool: call.function.name, ms: Date.now() - startedAt, ok: !result.startsWith('Error'), preview: (result || '').slice(0, 300) });
      messages.push({ role: 'tool', content: result, tool_call_id: call.id || callId });
    }
    if (touchedFiles) codeIndex.buildIndex(projectRoot).catch(() => {}); // fire-and-forget, now the edits are actually on disk
  }
  return {
    content: '[Read/edited files but hit the ' + MAX_TOOL_CALLS + '-call limit. Ask about a narrower part of the project.]',
    promptTokens: totalPromptTokens, evalTokens: totalEvalTokens, editedFiles: [...editedFiles]
  };
}

const PROJECT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "Read a file's contents from the user's open project, given a path relative to the project root.",
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Make a targeted edit to an existing file by replacing one exact, unique occurrence of old_str with new_str. Preferred over write_file for changes to existing files — always read_file first to copy exact text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_str: { type: 'string', description: 'Exact text to replace, must appear exactly once' },
          new_str: { type: 'string', description: 'Replacement text' }
        },
        required: ['path', 'old_str', 'new_str']
      }
    }
  },
    {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or fully overwrite an existing one with the given content. Use only for new files or full rewrites, not small edits.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Run a shell command inside the opened project root — tests, linters, builds, `npm install`, etc. Use this to self-verify changes before telling the user they are done. Output is truncated to 8000 chars. Destructive or system-level commands are blocked server-side.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'e.g. "npm test", "npm run lint", "python -m pytest"' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description: 'Semantic search over the project for relevant code when the file tree is too large to read manually. Returns the top-matching chunks with file path and line ranges. Requires the project to have been indexed first (see /api/project/index).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, top_k: { type: 'integer', description: 'default 8' } },
        required: ['query']
      }
    }
  }
];

// Streams one Ollama turn live. Resolves { message:{content,tool_calls}, prompt_eval_count, eval_count }.
// Forwards content deltas to onToken() as they arrive (no more fake post-hoc typing).
// If the user steers mid-stream, aborts and rejects with {steered:true, note, partial} so the
// caller can fold the note in and re-issue generation — this is what makes steering real.
function ollamaChatStream(messages, tools, model, conversationId, onToken) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, tools, stream: true, keep_alive: OLLAMA_KEEP_ALIVE, options: { num_ctx: OLLAMA_NUM_CTX, num_predict: OLLAMA_NUM_PREDICT } });
    const u = new URL(OLLAMA_HOST + '/api/chat');
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    let content = '', toolCalls = null, promptTokens = 0, evalTokens = 0, buf = '', steered = false;
    const checkSteer = () => {
      if (steered) return;
      const turn = activeTurns.get(conversationId);
      if (turn && turn.queue.length) {
        steered = true;
        clearInterval(steerPoll);
        const note = turn.queue.splice(0).join('\n');
        r.destroy();
        reject({ steered: true, note, partial: content });
      }
    };
    // Don't rely solely on data-chunk arrival — Ollama can batch many tokens into
    // one chunk, which previously made steering land only if you got lucky with
    // network timing. Poll independently every 150ms so it's consistent regardless.
    const steerPoll = setInterval(checkSteer, 150);
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol==='https:'?443:80),
      path: u.pathname, method: 'POST',
      headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}, timeout: 300000
    }, res => {
      res.on('data', chunk => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let data; try { data = JSON.parse(t); } catch { continue; }
          if (data.message && data.message.tool_calls && data.message.tool_calls.length) toolCalls = data.message.tool_calls;
          if (data.message && data.message.content) { content += data.message.content; onToken(data.message.content); }
          if (data.done) { promptTokens = data.prompt_eval_count || 0; evalTokens = data.eval_count || 0; }
        }
        checkSteer();
      });
      res.on('end', () => { clearInterval(steerPoll); if (!steered) resolve({ message: { content, tool_calls: toolCalls }, prompt_eval_count: promptTokens, eval_count: evalTokens }); });
      res.on('error', err => { clearInterval(steerPoll); if (!steered) reject(err); });
    });
    r.on('error', err => { clearInterval(steerPoll); if (!steered) reject(err); });
    r.on('timeout', () => { r.destroy(); clearInterval(steerPoll); if (!steered) reject(new Error('Ollama timeout')); });
    const turn = activeTurns.get(conversationId);
    if (turn) turn.activeRequest = r;
    r.write(payload); r.end();
  });
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
const WALK_NODE_CAP = parseInt(process.env.WALK_NODE_CAP || '20000', 10);

function walk(dir, base = dir, seen = new Set(), counter = { n: 0 }) {
  if (counter.n > WALK_NODE_CAP) return [{ name: '[truncated — too many files, use search_codebase instead]', path: '', type: 'file' }];
  let entries, real;
  try { real = fs.realpathSync(dir); } catch { return []; }
  if (seen.has(real)) return []; // symlink cycle — stop instead of recursing forever
  seen.add(real);
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; } // unreadable/broken dir — skip instead of crashing the whole tree
  const out = [];
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    if (++counter.n > WALK_NODE_CAP) { out.push({ name: '[truncated — too many files, use search_codebase instead]', path: '', type: 'file' }); break; }
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    out.push(e.isDirectory()
      ? { name: e.name, path: rel, type: 'dir', children: walk(full, base, seen, counter) }
      : { name: e.name, path: rel, type: 'file' });
  }
  return out;
}

app.post('/api/project/open', (req, res) => {
  const folderPath = req.body.path;
  if (!folderPath || !fs.existsSync(folderPath)) return res.status(400).json({ error: 'Invalid path' });
  res.json({ path: folderPath, tree: walk(folderPath) });
});

app.post('/api/project/index', (req, res) => {
  const folderPath = req.body.path;
  if (!folderPath || !fs.existsSync(folderPath)) return res.status(400).json({ error: 'Invalid path' });
  const current = codeIndex.getStatus(folderPath);
  if (current.status === 'running') return res.json({ status: 'running', ...current });
  codeIndex.buildIndex(folderPath).catch(e => log.error('[codeIndex] build failed:', e.message));
  res.json({ status: 'started' });
});

app.get('/api/project/index/status', (req, res) => {
  const folderPath = req.query.path;
  if (!folderPath) return res.status(400).json({ error: 'path required' });
  res.json(codeIndex.getStatus(folderPath));
});

function toolSearchCodebase(root, query, topK) {
  return codeIndex.search(root, query, topK || 8).then(r =>
    r.error ? r.error : r.map(x => '--- ' + x.path + ':' + x.startLine + '-' + x.endLine + ' (score ' + x.score + ') ---\n' + x.text).join('\n\n')
  );
}

app.get('/api/project/file', (req, res) => {
  try {
    if (!req.query.root) {
      return res.status(400).json({ error: 'root is required' });
    }
    if (!req.query.path) {
      return res.status(400).json({ error: 'path is required' });
    }

    const root = path.resolve(req.query.root);
    const relPath = path.isAbsolute(req.query.path) ? path.relative(root, req.query.path) : req.query.path;
    let p;
    try { p = safeResolve(root, relPath); } catch { return res.status(403).json({ error: 'Path outside opened project root' }); }

    if (!(p === root || p.startsWith(root + path.sep))) {
      return res.status(403).json({ error: 'Path outside opened project root' });
    }

    if (!fs.existsSync(p)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const realRoot = fs.realpathSync(root);
    const realP = fs.realpathSync(p);
    if (!(realP === realRoot || realP.startsWith(realRoot + path.sep))) {
      return res.status(403).json({ error: 'Path outside opened project root (symlink)' });
    }

    let content;
    try {
      const stat = fs.statSync(p);
      if (stat.size > 20 * 1024 * 1024) return res.status(413).json({ error: 'File too large to preview (' + Math.round(stat.size/1024/1024) + 'MB)' });
      content = fs.readFileSync(p, 'utf8');
    } catch {
      return res.status(400).json({ error: 'File not readable as text' });
    }

    res.json({ content: content.slice(0, 100000) });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/api/conversations/:id/events', (req, res) => {
  try { res.json(db.getEvents(req.params.id)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', model: DEFAULT_MODEL, ollama: OLLAMA_HOST });
});

// Safety net: guarantees every route returns JSON, never a raw HTML 500 page.
app.use((err, req, res, next) => {
  log.error('[unhandled]', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

setInterval(() => {
  const now = Date.now();

  for (const [id, p] of pdfPreviews) {
    if (p.expires < now) pdfPreviews.delete(id);
  }
}, 60000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateTitle(message) {
  return message.replace(/[^\p{L}\p{N}\s,.?!-]/gu, '').trim().slice(0, 60).replace(/\s+/g, ' ') || 'New Chat';
}

function trimHistoryToBudget(history, maxChars) {
  if (history.length <= 2) return history;
  const system = history[0];
  const latest = history[history.length - 1];
  const middle = history.slice(1, -1);
  let total = system.content.length + latest.content.length;
  const kept = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const len = (middle[i].content || '').length;
    if (total + len > maxChars) break;
    kept.unshift(middle[i]);
    total += len;
  }
  const dropped = middle.length - kept.length;
  const result = [system, ...kept, latest];
  if (dropped > 0) {
    result[0] = { role: 'system', content: system.content + '\n\n[Note: ' + dropped + ' earlier message(s) were omitted to fit the model\'s context window.]' };
  }
  return result;
}

// ─── Start ────────────────────────────────────────────────────────────────────

db.init().then(() => {
  const server = app.listen(PORT, '0.0.0.0', () => {
    log.info('Claude Chat running at http://0.0.0.0:' + PORT);
    log.info('Ollama endpoint: ' + OLLAMA_HOST);
    log.info('Default model: ' + DEFAULT_MODEL);

    let shuttingDown = false;
    function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info('Shutting down: closing active streams and flushing database...');
      for (const [, turn] of activeTurns) { turn.aborted = true; turn.activeRequest?.destroy(); }
      try { db.flushSync(); } catch (e) { log.error('DB flush failed:', e.message); }
      server.close(() => { log.info('Shutdown complete.'); process.exit(0); });
      setTimeout(() => process.exit(0), 2000); // force-exit if something hangs
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}).catch(err => { log.error('Database init failed:', err.message); process.exit(1); });

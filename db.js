const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { APP_ROOT } = require('./paths');

const DB_DIR = path.join(APP_ROOT, 'db');
if (!fs.existsSync(DB_DIR)) {
  // created lazily in getDb() so failures surface through init().catch() with a readable message
}
const DB_PATH = path.join(DB_DIR, 'chats.db');

let _db = null;
let _ready = null;

async function getDb() {
  if (_db) return _db;
  if (_ready) return _ready;
  _ready = (async () => {
    fs.mkdirSync(DB_DIR, { recursive: true });
    const SQL = await initSqlJs({
      locateFile: file => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), file)
    });
    _db = fs.existsSync(DB_PATH)
      ? new SQL.Database(fs.readFileSync(DB_PATH))
      : new SQL.Database();
    _db.run('PRAGMA foreign_keys = ON;');
    _db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Chat',
        model TEXT NOT NULL DEFAULT 'gpt-oss:120b-cloud',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        edited_files TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
    `);
    try { _db.run('ALTER TABLE conversations ADD COLUMN project_root TEXT DEFAULT NULL;'); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    try { _db.run('ALTER TABLE messages ADD COLUMN context TEXT DEFAULT NULL;'); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    _db.run(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, type TEXT NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    ); CREATE INDEX IF NOT EXISTS idx_events_conv ON events(conversation_id, created_at);`);
    save();
    return _db;
  })();
  return _ready;
}

let writeSeq = 0, syncGen = 0; // syncGen: bumped by every flushSync so an older in-flight async snapshot is discarded, never renamed over it
function atomicWriteSync(data) {
  const tmp = DB_PATH + '.' + process.pid + '.' + (++writeSeq) + '.tmp'; // unique per write: sync and async writers never share a tmp file
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) { // Windows: AV/indexer can briefly hold DB_PATH -> EPERM/EBUSY on rename
    try { fs.renameSync(tmp, DB_PATH); return; } // atomic — DB_PATH is never left half-written
    catch (e) { if (i >= 5 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (i + 1)); }
  }
}
// Non-blocking variant for the periodic background save — atomicWriteSync's
// Atomics.wait stalls the whole event loop (all active SSE streams included),
// which is only acceptable at true exit-time (flushSync), not on every debounced write.
function atomicWriteAsync(data, gen, cb) {
  const tmp = DB_PATH + '.' + process.pid + '.' + (++writeSeq) + '.tmp';
  fs.writeFile(tmp, data, (werr) => {
    if (werr) return cb(werr);
    const attempt = (i) => {
      if (gen !== syncGen) return fs.unlink(tmp, () => cb(null)); // a flushSync already persisted newer data
      fs.rename(tmp, DB_PATH, (e) => {
        if (!e) return cb(null);
        if (i >= 5 || !/^(EPERM|EBUSY|EACCES)$/.test(e.code)) return cb(e);
        setTimeout(() => attempt(i + 1), 50 * (i + 1));
      });
    };
    attempt(0);
  });
}
let saveTimer = null;
function save() {
  if (!_db) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const gen = syncGen; atomicWriteAsync(Buffer.from(_db.export()), gen, (e) => { if (e) { console.error('[db] save failed, retrying:', e.message); save(); } }); }, 300);
}
function flushSync() {
  if (!_db) return;
  clearTimeout(saveTimer);
  syncGen++;
  try { atomicWriteSync(Buffer.from(_db.export())); }
  catch (e) { console.error('[db] flush failed (kept in memory, will retry):', e.message); save(); } // must never throw out of finish()/shutdown
}

function run(sql, params = []) { _db.run(sql, params); save(); }

function get(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

module.exports = {
  flushSync,
  init: getDb,

  createConversation(id, model, projectRoot) {
    run('INSERT INTO conversations (id, title, model, project_root) VALUES (?, \'New Chat\', ?, ?)', [id, model || 'gpt-oss:120b-cloud', projectRoot || null]);
    return this.getConversation(id);
  },

  updateConversationProjectRoot(id, projectRoot) {
    run('UPDATE conversations SET project_root = ? WHERE id = ?', [projectRoot, id]);
  },

  getConversation(id) { return get('SELECT * FROM conversations WHERE id = ?', [id]); },

  getAllConversations() {
    return all(`
      SELECT c.*,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
      FROM conversations c ORDER BY c.updated_at DESC
    `);
  },

  searchConversations(query) {
    const q = '%' + String(query).replace(/[\\%_]/g, '\\$&') + '%';
    return all(`
      SELECT DISTINCT c.id, c.title, c.model, c.created_at, c.updated_at,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
      ORDER BY c.updated_at DESC LIMIT 50
    `, [q, q]);
  },

  updateConversationTitle(id, title) {
    run('UPDATE conversations SET title = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?', [String(title).slice(0, 100), id]);
  },

  updateConversationModel(id, model) {
    run('UPDATE conversations SET model = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?', [model, id]);
  },

  touchConversation(id) {
    run('UPDATE conversations SET updated_at = strftime(\'%s\',\'now\') WHERE id = ?', [id]);
  },

  deleteConversation(id) {
    run('DELETE FROM events WHERE conversation_id = ?', [id]);
    run('DELETE FROM messages WHERE conversation_id = ?', [id]);
    run('DELETE FROM conversations WHERE id = ?', [id]);
  },

  setMessageContext(id, context) { run('UPDATE messages SET context = ? WHERE id = ?', [context, id]); },

  addMessage(id, conversationId, role, content, editedFiles = null) {
    if(editedFiles) {
      run('INSERT INTO messages (id, conversation_id, role, content, edited_files) VALUES (?, ?, ?, ?, ?)', [id, conversationId, role, content, JSON.stringify(editedFiles)]);
    } else {
      run('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)', [id, conversationId, role, content]);
    }
    this.touchConversation(conversationId);
  },

  getMessages(conversationId) {
    return all('SELECT id, conversation_id, role, content, created_at, edited_files FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC', [conversationId]);
  },

  addEvent(id, conversationId, type, payload) {
    run('INSERT INTO events (id, conversation_id, type, payload) VALUES (?, ?, ?, ?)', [id, conversationId, type, JSON.stringify(payload)]);
  },
  getEvents(conversationId) {
    return all('SELECT * FROM events WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC', [conversationId]);
  },
  getMessageHistory(conversationId) {
    return all("SELECT role, content, context FROM messages WHERE conversation_id = ? AND role != 'steer' ORDER BY created_at ASC, rowid ASC", [conversationId])
      .map(r => ({ role: r.role, content: r.context ? r.context + '\n' + r.content : r.content }));
  },

  // Delete a specific message and all messages after it (for edit/regenerate)
  deleteMessagesFrom(conversationId, messageId) {
    const msg = get('SELECT rowid, created_at FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conversationId]);
    if (!msg) return false;
    // Use rowid-based cutoff (monotonic, unlike second-granularity created_at) so
    // sibling events inserted in the same second as the truncated message aren't
    // ambiguously kept or dropped. events.rowid is not directly comparable to
    // messages.rowid, so fall back to a safe time window minus 1s of slack.
    run('DELETE FROM messages WHERE conversation_id = ? AND rowid >= ?', [conversationId, msg.rowid]);
    run('DELETE FROM events WHERE conversation_id = ? AND created_at >= ?', [conversationId, Math.max(0, msg.created_at - 1)]);
    save();
    return true;
  }
};

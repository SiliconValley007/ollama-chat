const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}
const DB_PATH = path.join(DB_DIR, 'chats.db');

let _db = null;
let _ready = null;

async function getDb() {
  if (_db) return _db;
  if (_ready) return _ready;
  _ready = (async () => {
    const SQL = await initSqlJs();
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
    save();
    return _db;
  })();
  return _ready;
}

let saveTimer = null;
function save() {
  if (!_db) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DB_PATH, Buffer.from(_db.export())), 300);
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
  init: getDb,

  createConversation(id, model) {
    run('INSERT INTO conversations (id, title, model) VALUES (?, \'New Chat\', ?)', [id, model || 'gpt-oss:120b-cloud']);
    return this.getConversation(id);
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
    const q = '%' + query + '%';
    return all(`
      SELECT DISTINCT c.id, c.title, c.model, c.created_at, c.updated_at,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.title LIKE ? OR m.content LIKE ?
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
    run('DELETE FROM messages WHERE conversation_id = ?', [id]);
    run('DELETE FROM conversations WHERE id = ?', [id]);
  },

  addMessage(id, conversationId, role, content, editedFiles = null) {
    if(editedFiles) {
      run('INSERT INTO messages (id, conversation_id, role, content, edited_files) VALUES (?, ?, ?, ?, ?)', [id, conversationId, role, content, JSON.stringify(editedFiles)]);
    } else {
      run('INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)', [id, conversationId, role, content]);
    }
    this.touchConversation(conversationId);
  },

  getMessages(conversationId) {
    return all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
  },

  getMessageHistory(conversationId) {
    return all('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
  },

  // Delete a specific message and all messages after it (for edit/regenerate)
  deleteMessagesFrom(conversationId, messageId) {
    const msg = get('SELECT created_at FROM messages WHERE id = ? AND conversation_id = ?', [messageId, conversationId]);
    if (!msg) return;
    run('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?', [conversationId, msg.created_at]);
    save();
  }
};

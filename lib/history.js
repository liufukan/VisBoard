const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HIST_DIR = path.join(__dirname, '..', 'history');
const ID_RE = /^[a-zA-Z0-9-]+$/;
const MAX_FULL = 200000;
const MAX_DIALOGS = 50;
const MAX_TOPIC = 200;

function ensureDir() {
  if (!fs.existsSync(HIST_DIR)) fs.mkdirSync(HIST_DIR, { recursive: true });
}

// Upsert one lecture snapshot keyed by session id. Caps full/dialogs so a runaway
// client cannot fill the disk; normal lessons sit far below these limits.
function save({ id, topic, board }) {
  const sid = ID_RE.test(id || '') ? id : crypto.randomUUID();
  const b = board && typeof board === 'object' ? board : {};
  const rec = {
    id: sid,
    topic: String(topic || '').slice(0, MAX_TOPIC),
    savedAt: Date.now(),
    board: {
      full: String(b.full || '').slice(0, MAX_FULL),
      citations: Array.isArray(b.citations) ? b.citations : [],
      webCitations: Array.isArray(b.webCitations) ? b.webCitations : [],
      dialogs: Array.isArray(b.dialogs) ? b.dialogs.slice(0, MAX_DIALOGS) : [],
      images: Array.isArray(b.images) ? b.images : [],
    },
  };
  ensureDir();
  fs.writeFileSync(path.join(HIST_DIR, sid + '.json'), JSON.stringify(rec));
  return { id: sid };
}

function list() {
  if (!fs.existsSync(HIST_DIR)) return [];
  return fs.readdirSync(HIST_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(HIST_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .map(r => ({ id: r.id, topic: r.topic, savedAt: r.savedAt, dialogCount: ((r.board && r.board.dialogs) || []).length }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

function get(id) {
  if (!ID_RE.test(id)) return null;
  const p = path.join(HIST_DIR, id + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function remove(id) {
  if (!ID_RE.test(id)) return false;
  const p = path.join(HIST_DIR, id + '.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
}

module.exports = { save, list, get, remove };
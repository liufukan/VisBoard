const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KB_DIR = path.join(__dirname, '..', 'kb');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const SUBJECTS_FILE = path.join(__dirname, '..', 'subjects.json');
const CHUNK = 800;
const OVERLAP = 100;
const ID_RE = /^[a-zA-Z0-9-]+$/;

function chunkPages(pages) {
  const chunks = [];
  for (const p of pages) {
    const text = p.text || '';
    if (text.length <= CHUNK) {
      if (text.trim()) chunks.push({ page: p.page, text });
      continue;
    }
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + CHUNK, text.length);
      const piece = text.slice(start, end);
      if (piece.trim()) chunks.push({ page: p.page, text: piece });
      if (end >= text.length) break;
      start = end - OVERLAP;
    }
  }
  return chunks.map((c, i) => ({ idx: i, page: c.page, text: c.text }));
}

function addDoc({ id, name, kind, pages, subject }) {
  const chunks = chunkPages(pages);
  const chars = pages.reduce((n, p) => n + (p.text || '').length, 0);
  const doc = { id, name, kind, chars, pages: pages.length, chunks, subject: subject || null, createdAt: Date.now() };
  fs.writeFileSync(path.join(KB_DIR, id + '.json'), JSON.stringify(doc));
  return doc;
}

function listDocs() {
  if (!fs.existsSync(KB_DIR)) return [];
  return fs.readdirSync(KB_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(KB_DIR, f), 'utf8')))
    .map(d => ({ id: d.id, name: d.name, kind: d.kind, chars: d.chars, pages: d.pages, chunks: d.chunks.length, subject: d.subject || null, createdAt: d.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getDoc(id) {
  if (!ID_RE.test(id)) return null;
  const p = path.join(KB_DIR, id + '.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function deleteDoc(id) {
  if (!ID_RE.test(id)) return false;
  const p = path.join(KB_DIR, id + '.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  if (fs.existsSync(UPLOAD_DIR)) {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (f.startsWith(id + '.') || f === id + '.json') fs.unlinkSync(path.join(UPLOAD_DIR, f));
    }
  }
  return true;
}

function allChunks(subject) {
  return listDocs().flatMap(s => {
    if (subject && subject !== 'all') {
      if (subject === 'none') { if (s.subject != null) return []; }
      else if (s.subject !== subject) return [];
    }
    const d = getDoc(s.id);
    return d.chunks.map(c => ({ docId: d.id, docName: d.name, kind: d.kind, idx: c.idx, page: c.page, text: c.text }));
  });
}

function setDocSubject(id, subject) {
  const d = getDoc(id);
  if (!d) return false;
  d.subject = subject || null;
  fs.writeFileSync(path.join(KB_DIR, id + '.json'), JSON.stringify(d));
  return true;
}

function listSubjects() {
  if (!fs.existsSync(SUBJECTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8')); } catch { return []; }
}

function saveSubjects(list) {
  fs.writeFileSync(SUBJECTS_FILE, JSON.stringify(list, null, 2));
}

function addSubject(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const list = listSubjects();
  if (list.some(s => s.name === clean)) return list.find(s => s.name === clean);
  const subject = { id: 's' + crypto.randomUUID(), name: clean, createdAt: Date.now() };
  list.push(subject);
  saveSubjects(list);
  return subject;
}

function deleteSubject(id) {
  if (!ID_RE.test(id)) return false;
  const list = listSubjects();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  saveSubjects(next);
  for (const s of listDocs()) {
    if (s.subject === id) setDocSubject(s.id, null);
  }
  return true;
}

function ingestLegacyUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (!f.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8'));
    if (!getDoc(parsed.id)) addDoc(parsed);
  }
}

module.exports = {
  chunkPages, addDoc, listDocs, getDoc, deleteDoc, allChunks, ingestLegacyUploads,
  setDocSubject, listSubjects, addSubject, deleteSubject,
};
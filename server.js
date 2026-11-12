const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { extract, SUPPORTED } = require('./lib/parse');
const kb = require('./lib/kb');
const { retrieve } = require('./lib/retrieve');
const { prepareLesson, streamLesson, streamAnswer } = require('./lib/teach');
const { streamNotes, generateQuiz, gradeShortAnswers } = require('./lib/review');
const llm = require('./lib/llm');
const search = require('./lib/search');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  const cfg = llm.getConfig();
  res.json({ ok: true, hasKey: Boolean(cfg.apiKey), hasSearchKey: search.hasSearchKey(), model: cfg.model });
});

app.get('/api/config', (req, res) => {
  const cfg = llm.getConfig();
  res.json({ baseUrl: cfg.baseUrl, model: cfg.model, hasKey: Boolean(cfg.apiKey), hasSearchKey: search.hasSearchKey() });
});

app.post('/api/model', (req, res) => {
  const model = ((req.body && req.body.model) || '').trim();
  if (!model || model.length > 80) return res.status(400).json({ error: '模型名无效' });
  const p = path.join(__dirname, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.model = model;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  res.json({ ok: true, model });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
  const results = [];
  const subject = (req.body && req.body.subject) || null;
  for (const f of req.files || []) {
    const ext = path.extname(f.filename).toLowerCase();
    const id = path.basename(f.filename, ext);
    try {
      const parsed = await extract(f.path);
      const doc = kb.addDoc({ id, name: f.originalname, kind: parsed.kind, pages: parsed.pages, subject });
      results.push({
        id, name: f.originalname, kind: parsed.kind, chars: doc.chars, pages: doc.pages, chunks: doc.chunks.length,
        preview: parsed.pages.map(p => p.text).join('\n').slice(0, 200),
      });
    } catch (e) {
      results.push({ name: f.originalname, error: e.message });
    }
  }
  res.json({ results });
});

app.get('/api/kb', (req, res) => res.json({ docs: kb.listDocs() }));

app.delete('/api/kb/:id', (req, res) => {
  res.json({ ok: kb.deleteDoc(req.params.id) });
});

app.post('/api/kb/:id/subject', (req, res) => {
  const subject = (req.body && req.body.subject) || null;
  res.json({ ok: kb.setDocSubject(req.params.id, subject) });
});

app.get('/api/subjects', (req, res) => res.json({ subjects: kb.listSubjects() }));

app.post('/api/subjects', (req, res) => {
  const name = ((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: '请输入科目名' });
  const subject = kb.addSubject(name);
  if (!subject) return res.status(400).json({ error: '科目名无效' });
  res.json({ subject });
});

app.delete('/api/subjects/:id', (req, res) => {
  res.json({ ok: kb.deleteSubject(req.params.id) });
});

app.post('/api/retrieve', async (req, res) => {
  const question = ((req.body && req.body.question) || '').trim();
  const subject = (req.body && req.body.subject) || null;
  if (!question) return res.status(400).json({ error: '请输入问题' });
  try {
    res.json(await retrieve(question, subject));
  } catch (e) {
    res.status(e.code === 'NO_KEY' || e.code === 'EMPTY_KB' ? 400 : 500).json({ error: e.message, code: e.code });
  }
});

app.post('/api/teach', async (req, res) => {
  const topic = ((req.body && req.body.topic) || '').trim();
  const subject = (req.body && req.body.subject) || null;
  const web = Boolean(req.body && req.body.web);
  if (!topic) return res.status(400).json({ error: '请输入课题' });
  try {
    res.json(await prepareLesson(topic, subject, web));
  } catch (e) {
    res.status(e.code === 'NO_KEY' || e.code === 'EMPTY_KB' ? 400 : 500).json({ error: e.message, code: e.code });
  }
});

app.post('/api/teach/revise', async (req, res) => {
  const b = req.body || {};
  const topic = (b.topic || '').trim();
  const subject = b.subject || null;
  const web = Boolean(b.web);
  const feedback = String(b.feedback || '').trim().slice(0, 600);
  const previous = b.previous && Array.isArray(b.previous.sections) ? b.previous : null;
  if (!topic) return res.status(400).json({ error: '请输入课题' });
  if (!feedback) return res.status(400).json({ error: '请先填写修改意见' });
  if (!previous) return res.status(400).json({ error: '请先生成讲解提纲' });
  try {
    res.json(await prepareLesson(topic, subject, web, { feedback, previous }));
  } catch (e) {
    res.status(e.code === 'NO_KEY' || e.code === 'EMPTY_KB' ? 400 : 500).json({ error: e.message, code: e.code });
  }
});

app.post('/api/teach/stream', async (req, res) => {
  const topic = ((req.body && req.body.topic) || '').trim();
  const subject = (req.body && req.body.subject) || null;
  const web = Boolean(req.body && req.body.web);
  const plan = req.body && req.body.plan && Array.isArray(req.body.plan.sections) ? req.body.plan : null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type, data) => res.write('data: ' + JSON.stringify({ type, ...data }) + '\n\n');
  if (!topic) { send('error', { message: '请输入课题' }); return res.end(); }
  try {
    const result = await streamLesson(topic, {
      subject, web, plan,
      onStatus: message => send('status', { message }),
      onThinking: () => send('thinking', {}),
      onToken: text => send('token', { text }),
    });
    if (result.empty) send('empty', { message: result.message });
    else send('done', { citations: result.citations, retrieved: result.retrieved, full: result.full, webCitations: result.webCitations || [] });
  } catch (e) {
    send('error', { message: e.message, code: e.code });
  }
  res.end();
});

app.post('/api/ask/stream', async (req, res) => {
  const b = req.body || {};
  const topic = (b.topic || '').trim();
  const context = (b.context || '').trim();
  const mode = (b.mode || 'ask').trim();
  const question = (b.question || '').trim();
  const subject = (b.subject || '').trim() || null;
  const web = Boolean(b.web);
  const history = Array.isArray(b.history) ? b.history.slice(-12) : [];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type, data) => res.write('data: ' + JSON.stringify({ type, ...data }) + '\n\n');
  if (!context && !question) { send('error', { message: '缺少知识点内容' }); return res.end(); }
  try {
    const result = await streamAnswer({ topic, context, mode, question, history, subject, web }, {
      onStatus: message => send('status', { message }),
      onThinking: () => send('thinking', {}),
      onToken: text => send('token', { text }),
    });
    if (result.empty) send('empty', { message: result.message });
    else send('done', { citations: result.citations, full: result.full, webCitations: result.webCitations || [] });
  } catch (e) {
    send('error', { message: e.message, code: e.code });
  }
  res.end();
});

app.post('/api/notes/stream', async (req, res) => {
  const topic = ((req.body && req.body.topic) || '').trim();
  const subject = (req.body && req.body.subject) || null;
  const web = Boolean(req.body && req.body.web);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (type, data) => res.write('data: ' + JSON.stringify({ type, ...data }) + '\n\n');
  if (!topic) { send('error', { message: '请输入课题' }); return res.end(); }
  try {
    const result = await streamNotes(topic, {
      subject, web,
      onStatus: message => send('status', { message }),
      onThinking: () => send('thinking', {}),
      onToken: text => send('token', { text }),
    });
    if (result.empty) send('empty', { message: result.message });
    else send('done', { citations: result.citations, full: result.full, webCitations: result.webCitations || [] });
  } catch (e) {
    send('error', { message: e.message, code: e.code });
  }
  res.end();
});

app.post('/api/quiz', async (req, res) => {
  const topic = ((req.body && req.body.topic) || '').trim();
  const count = (req.body && req.body.count) || 4;
  const subject = (req.body && req.body.subject) || null;
  if (!topic) return res.status(400).json({ error: '请输入课题' });
  try {
    res.json(await generateQuiz(topic, count, subject));
  } catch (e) {
    res.status(e.code === 'NO_KEY' || e.code === 'EMPTY_KB' ? 400 : 500).json({ error: e.message, code: e.code });
  }
});

app.post('/api/quiz/grade', async (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '没有需要判分的简答题' });
  try {
    res.json({ results: await gradeShortAnswers(items) });
  } catch (e) {
    res.status(e.code === 'NO_KEY' ? 400 : 500).json({ error: e.message, code: e.code });
  }
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else next();
});

kb.ingestLegacyUploads();

const port = config.port || 3000;
app.listen(port, () => {
  console.log(`VisBoard running at http://localhost:${port}`);
});
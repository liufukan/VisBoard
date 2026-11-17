const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extract } = require('./parse');
const kb = require('./kb');
const ocr = require('./ocr');

// 后台任务队列:FIFO + 有限并发 worker 池。图片提取已隔离到"每块退出"的子进程
// (见 parse.js),父进程内存不随解析累积,故可并发;并发上限封顶子进程内存峰值
// (扫描书每块子进程峰值约 0.8GB)与 CPU 争用。同一文档的任务串行,避免写冲突。
// 任务在服务端运行,与 HTTP 请求/前端页面是否存活无关。
const MAX_KEPT = 100;
const MAX_CONCURRENT = 2;
const jobs = [];
let active = 0;

function prune() {
  const finished = jobs.filter(j => j.status === 'done' || j.status === 'error');
  if (finished.length <= MAX_KEPT) return;
  const drop = new Set(finished.slice(0, finished.length - MAX_KEPT).map(j => j.id));
  for (let i = jobs.length - 1; i >= 0; i--) if (drop.has(jobs[i].id)) jobs.splice(i, 1);
}

function enqueue(kind, opts) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    name: opts.name || '',
    docId: opts.docId || null,
    subject: opts.subject || null,
    path: opts.path || null,
    hash: opts.hash || null,
    status: 'queued',
    stage: '',
    result: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.push(job);
  prune();
  pump();
  return job;
}

async function run(job) {
  job.status = 'running';
  const t0 = Date.now();
  console.log('[jobs] start', job.kind, job.name);
  try {
    if (job.kind === 'parse') {
      const parsed = await extract(job.path, s => { job.stage = s; }, { keepScanData: false });
      const doc = kb.addDoc({
        id: job.docId, name: job.name, kind: parsed.kind, pages: parsed.pages,
        subject: job.subject, images: parsed.images, scanned: parsed.scanned, hash: job.hash,
      });
      job.result = { id: doc.id, name: job.name, kind: doc.kind, chars: doc.chars, pages: doc.pages, chunks: doc.chunks.length };
    } else if (job.kind === 'images') {
      const parsed = await extract(job.path, s => { job.stage = s; }, { keepScanData: false });
      kb.setDocImages(job.docId, parsed.images || []);
      const d = kb.getDoc(job.docId);
      job.result = { count: ((d && d.images) || []).length };
    } else if (job.kind === 'ocr') {
      const parsed = await extract(job.path, s => { job.stage = s; });
      if (parsed.kind !== 'pdf' && parsed.kind !== 'image') throw new Error('该文档无需 OCR');
      const r = await ocr.ocrDoc(parsed, (i, n) => { job.stage = 'OCR 第 ' + i + '/' + n + ' 页'; });
      kb.setDocText(job.docId, r.pages, parsed.images);
      job.result = { ocrPages: r.ocrPages, chars: r.chars, truncated: r.truncated };
    } else {
      throw new Error('未知任务类型: ' + job.kind);
    }
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message || String(e);
  }
  job.finishedAt = Date.now();
  job.stage = '';
  console.log('[jobs]', job.status, job.kind, job.name, ((job.finishedAt - t0) / 1000).toFixed(1) + 's', job.error || '');
}

function pump() {
  while (active < MAX_CONCURRENT) {
    // 同文档保护:该 doc 已有任务在跑时,其后续任务(补图/OCR)暂缓,避免并发写同一文档。
    const next = jobs.find(j => j.status === 'queued' &&
      !jobs.some(o => o.status === 'running' && o.docId && o.docId === j.docId));
    if (!next) return;
    active++;
    run(next).finally(() => { active--; pump(); });
  }
}

function list() { return jobs.slice().reverse(); }

// 启动时找回"上传了但没入库"的文件(进程崩溃/重启丢队列的遗留)。
// 原始文件名存在 uploads/<id>.meta.json sidecar 里(multer 会把文件改名为 uuid)。
function recoverOrphans(uploadDir) {
  if (!fs.existsSync(uploadDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(uploadDir)) {
    if (f.startsWith('.') || f.endsWith('.json')) continue;
    const ext = path.extname(f).toLowerCase();
    const id = path.basename(f, ext);
    if (!/^[a-zA-Z0-9-]+$/.test(id) || kb.getDoc(id)) continue;
    let name = f, subject = null, hash = null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(uploadDir, id + '.meta.json'), 'utf8'));
      if (meta && meta.name) name = meta.name;
      if (meta && meta.subject) subject = meta.subject;
      if (meta && meta.hash) hash = meta.hash;
    } catch {}
    out.push(enqueue('parse', { docId: id, name, subject, hash, path: path.join(uploadDir, f) }));
  }
  return out;
}

module.exports = { enqueue, list, recoverOrphans };
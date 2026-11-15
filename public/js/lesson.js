import { esc, parseBlocks, blockHtml, mdToHtml, webCitesHTML, fetchCircuitPNG, imageFigureHTML } from './util.js';

const KEY = 'visboard.lessons';
const MAX = 8;
const MODE_LABEL = { ask: '提问', explain: '解释一下', simpler: '再简单点', example: '举个例子' };

function readAll() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function writeAll(map) {
  const entries = Object.entries(map).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* quota: keep best-effort */ }
}
export function getLesson(topic) {
  const t = String(topic || '').trim(); if (!t) return null;
  return readAll()[t] || null;
}
function merge(topic, patch) {
  const t = String(topic || '').trim(); if (!t) return;
  const map = readAll();
  const rec = map[t] || { topic: t, board: null, notes: null };
  Object.assign(rec, patch, { topic: t, updatedAt: Date.now() });
  map[t] = rec; writeAll(map);
}
export function saveBoard(topic, data) { merge(topic, { board: data }); }
export function saveNotes(topic, data) { merge(topic, { notes: data }); }
export function savePlan(topic, plan) { merge(topic, { plan }); }
export function getPlan(topic) { const rec = getLesson(topic); return rec && rec.plan ? rec.plan : null; }

function cleanFull(s) {
  const lines = String(s).split('\n');
  if (lines.length && /^`{1,3}[a-z]*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n');
}
function boardBlocksHTML(topic, full, circuits, images, srcByUrl) {
  const parsed = parseBlocks(cleanFull(full));
  if (parsed.length && parsed[0].type === 'title') parsed.shift();
  const blocks = topic ? [{ type: 'title', text: topic, isTopic: true }, ...parsed] : parsed;
  let html = blocks.map(b => `<div class="wb-block ${b.type}">${blockHtml(b, circuits)}</div>`).join('');
  for (const img of images || []) {
    const src = srcByUrl && srcByUrl[img.url];
    if (!src) continue;
    html += `<div class="wb-block figure">${imageFigureHTML(img, src)}</div>`;
  }
  return html;
}
function dialogsHTML(dialogs) {
  if (!dialogs || !dialogs.length) return '<p class="export-hint">本课没有追问记录。</p>';
  return dialogs.map(d => {
    const ctxRaw = String(d.context || '').replace(/\s+/g, ' ').trim();
    const ctx = esc(ctxRaw.slice(0, 80)) + (ctxRaw.length > 80 ? '…' : '');
    const label = MODE_LABEL[d.mode] || '追问';
    const thread = (d.history || []).map(h =>
      `<div class="msg ${h.role === 'user' ? 'user' : 'ai'}"><div class="bubble md">${mdToHtml(h.content)}</div></div>`
    ).join('');
    return `<div class="dlg"><div class="dlg-head"><span class="dlg-badge ${esc(d.mode || 'ask')}">${esc(label)}</span>` +
      `<span class="dlg-ctx">关于：${ctx}</span></div><div class="dlg-thread">${thread || '<p class="export-hint">（无内容）</p>'}</div></div>`;
  }).join('');
}
function citesHTML(citations, webCitations) {
  const kb = (citations || []).map(c => `<span class="chip blue">${esc(c)}</span>`).join(' ');
  const web = webCitesHTML(webCitations);
  if (!kb && !web) return '';
  return `<div class="cites"><span class="cites-label">来源</span>${kb} ${web}</div>`;
}

const EXPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#eef1f6;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 60px}
header.top{margin-bottom:24px}
.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6b7280;font-weight:700}
header.top h1{margin:6px 0 8px;font-size:30px;line-height:1.25;color:#111827}
.meta{font-size:13px;color:#6b7280}
.legend{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
.card{background:#fff;border:1px solid #e3e8ef;border-radius:16px;padding:24px 26px;margin-bottom:20px;box-shadow:0 6px 20px rgba(30,50,80,.06)}
h2.sec{margin:0 0 18px;font-size:19px;color:#111827;display:flex;align-items:center;gap:10px}
h2.sec::before{content:"";width:5px;height:20px;border-radius:3px;background:#4d9fff}
.card.notes h2.sec::before{background:#7ee787}
.card.drill h2.sec::before{background:#ffb454}
.export-hint{color:#9aa4b2;font-size:14px;font-style:italic;margin:6px 0}
.wb-block{margin:0 0 18px}
.wb-block.title h2{margin:0 0 6px;font-size:23px;color:#0b3d5c}
.topic-eyebrow{font-size:11px;letter-spacing:.12em;color:#9aa4b2;text-transform:uppercase;font-weight:700}
.rule{height:3px;width:64px;border-radius:2px;background:linear-gradient(90deg,#4d9fff,#56d4dd);margin:8px 0 4px}
.wb-block.text h4{margin:0 0 8px;font-size:16.5px;color:#16324f;display:flex;align-items:center;gap:8px}
.pin{width:8px;height:8px;border-radius:50%;background:#4d9fff;flex:none;box-shadow:0 0 0 3px rgba(77,159,255,.18)}
.wb-block p{margin:7px 0;font-size:14.5px}
.wb-block ul,.wb-block ol{margin:7px 0;padding-left:22px}
.wb-block li{font-size:14.5px;margin:3px 0}
.wb-block strong{color:#0b3d5c}
.wb-block code{background:#eef2f7;padding:1px 6px;border-radius:5px;font-size:13px}
.fig-frame{background:#f7f9fc;border:1px solid #e6ecf3;border-radius:12px;padding:14px;margin:10px 0;overflow-x:auto}
.fig-frame svg{max-width:100%;height:auto;display:block;margin:0 auto}
.fig-frame img{max-width:100%;height:auto;display:block;margin:0 auto}
.fig-loading{color:#64748b;font-size:13px;display:inline-block;padding:18px 0}
.fig-error{color:#b91c1c;font-size:13px;display:block;margin-bottom:6px}
.cap{font-size:13px;color:#6b7280;text-align:center;margin-top:6px}
.md h3,.md h4{margin:14px 0 6px;color:#16324f}
.md p{margin:7px 0;font-size:14.5px}
.md ul,.md ol{margin:7px 0;padding-left:22px}
.md li{margin:3px 0;font-size:14.5px}
.md strong{color:#0b3d5c}
.md code{background:#eef2f7;padding:1px 6px;border-radius:5px;font-size:13px}
.md pre,.wb-block pre{background:#10151d;color:#d7e3f4;border:1px solid rgba(120,135,160,.25);border-radius:10px;padding:12px 14px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.6;margin:10px 0}
.md pre code,.wb-block pre code{background:transparent;padding:0;border-radius:0;color:inherit;font-size:inherit}
.katex-display{margin:10px 0;overflow-x:auto;overflow-y:hidden}
.katex{font-size:1.05em}
.dlg{border:1px solid #e6ecf3;border-top:4px solid #ffb454;border-radius:12px;margin:0 0 16px;overflow:hidden;background:#fffdf7}
.dlg-head{display:flex;align-items:center;gap:9px;padding:10px 14px;border-bottom:1px solid #f0e9da;background:#fffdf7}
.dlg-badge{font-size:12px;font-weight:700;padding:3px 11px;border-radius:999px;flex:none;background:rgba(255,180,84,.22);color:#9a6516}
.dlg-badge.explain{background:rgba(77,159,255,.16);color:#1f5fa8}
.dlg-badge.simpler{background:rgba(126,231,135,.22);color:#1f7a34}
.dlg-badge.ask{background:rgba(255,122,198,.2);color:#a83a78}
.dlg-ctx{flex:1;min-width:0;font-size:12.5px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlg-thread{padding:13px 14px;display:flex;flex-direction:column;gap:10px;background:#fff}
.msg{display:flex}
.msg.user{justify-content:flex-end}
.msg .bubble{max-width:88%;font-size:13.5px;line-height:1.7;padding:9px 13px;border-radius:12px;word-break:break-word}
.msg.user .bubble{background:linear-gradient(180deg,#4d9fff,#2f7fe6);color:#fff;border-bottom-right-radius:4px}
.msg.ai .bubble{background:#f4f7fb;border:1px solid #e6ecf3;color:#22303f;border-bottom-left-radius:4px}
.bubble.md p{margin:6px 0}.bubble.md p:first-child{margin-top:0}.bubble.md p:last-child{margin-bottom:0}
.bubble.md ul,.bubble.md ol{margin:6px 0;padding-left:20px}.bubble.md li{margin:3px 0}
.bubble.md strong{color:#0b3d5c}.bubble.md code{background:#e6ecf3;padding:1px 6px;border-radius:5px;font-size:12.5px}
.cites{margin-top:16px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.cites-label{font-size:12px;color:#9aa4b2;margin-right:2px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 10px;border-radius:999px;background:#f1f5f9;border:1px solid #e2e8f0;color:#475569}
.chip.blue{color:#1f5fa8;border-color:rgba(77,159,255,.35);background:rgba(77,159,255,.12)}
.chip.web{color:#9a6516;border-color:rgba(255,180,84,.45);background:rgba(255,180,84,.16);text-decoration:none;max-width:300px}
.chip.web span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip.web .web-ic{flex:none;opacity:.85}
footer{margin-top:26px;text-align:center;font-size:12.5px;color:#9aa4b2}
@media print{body{background:#fff}.card{box-shadow:none;break-inside:avoid}.wrap{padding:0}}
`;

let katexCssCache = null;
async function katexInlineCSS() {
  if (katexCssCache !== null) return katexCssCache;
  const res = await fetch('/vendor/katex/katex.min.css');
  if (!res.ok) throw new Error('katex css ' + res.status);
  let css = await res.text();
  const fonts = [...new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
  for (const f of fonts) {
    const fr = await fetch('/vendor/katex/' + f);
    if (!fr.ok) throw new Error('katex font ' + f);
    const buf = new Uint8Array(await fr.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    css = css.split('url(' + f + ')').join('url(data:font/woff2;base64,' + btoa(bin) + ')');
  }
  css = css.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("[^"]+"\)/g, '');
  katexCssCache = css;
  return css;
}

export function buildLessonHTML(topic, katexCss = '', circuits = null, imagesSrc = null, recOverride = null) {
  const rec = recOverride || getLesson(topic);
  if (!rec) return null;
  const t = rec.topic;
  const board = rec.board, notes = rec.notes;
  const date = new Date(rec.updatedAt || Date.now()).toLocaleString('zh-CN');
  const boardSection = board && board.full && board.full.trim()
    ? boardBlocksHTML(t, board.full, circuits, board.images, imagesSrc) + citesHTML(board.citations, board.webCitations)
    : '<p class="export-hint">本课尚未在白板上讲解，或讲解内容未保存。</p>';
  const drillSection = dialogsHTML(board && board.dialogs);
  const notesSection = notes && notes.full && notes.full.trim()
    ? `<div class="md">${mdToHtml(notes.full)}</div>` + citesHTML(notes.citations, notes.webCitations)
    : '<p class="export-hint">本课尚未生成复习笔记。可在「笔记 · 小测 · 再讲」页生成后再导出。</p>';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t)} · 本课导出</title>
<style>${EXPORT_CSS}</style>
${katexCss ? `<style>${katexCss}</style>` : ''}
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="eyebrow">VisBoard · 本课导出</div>
    <h1>${esc(t)}</h1>
    <div class="meta">导出时间 ${esc(date)}</div>
    <div class="legend"><span class="chip blue">来自资料</span><span class="chip web">来自网络</span></div>
  </header>
  <section class="card board">
    <h2 class="sec">白板讲解</h2>
    ${boardSection}
  </section>
  <section class="card drill">
    <h2 class="sec">追问对话</h2>
    ${drillSection}
  </section>
  <section class="card notes">
    <h2 class="sec">复习笔记</h2>
    ${notesSection}
  </section>
  <footer>由 VisBoard 生成 · 主体依据本地知识库，网络内容已单独标注来源</footer>
</div>
</body>
</html>`;
}

// Inline circuit PNGs + KB images as data URLs so the exported file is fully
// self-contained. Shared by live-lesson export and history-snapshot export.
async function inlineBoardAssets(board) {
  const circuits = {};
  if (board && board.full) {
    const codes = [...new Set(parseBlocks(cleanFull(board.full)).filter(b => b.type === 'circuit').map(b => b.code))];
    await Promise.all(codes.map(async code => {
      try { circuits[code] = await fetchCircuitPNG(code); } catch { circuits[code] = null; }
    }));
  }
  const imagesSrc = {};
  const imgs = (board && board.images) || [];
  await Promise.all(imgs.map(async img => {
    try {
      const r = await fetch(img.url);
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
      imagesSrc[img.url] = 'data:' + mime + ';base64,' + btoa(bin);
    } catch { /* 省略该图，保持其余自包含 */ }
  }));
  return { circuits, imagesSrc };
}

async function exportRec(t, rec) {
  const { circuits, imagesSrc } = await inlineBoardAssets(rec.board);
  const katexCss = await katexInlineCSS().catch(() => '');
  const html = buildLessonHTML(t, katexCss, circuits, imagesSrc, rec);
  if (!html) return false;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = t.replace(/[\\/:*?"<>|]/g, '_') + '-本课.html';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

export async function exportLessonHTML(topic) {
  const t = String(topic || '').trim();
  if (!t) return false;
  const rec = getLesson(t);
  if (!rec) return false;
  return exportRec(t, rec);
}

// Export a history snapshot (board from the backend archive, not localStorage).
export async function exportSnapshotHTML(topic, board, notes = null, savedAt = null) {
  const t = String(topic || '').trim();
  if (!t || !board) return false;
  return exportRec(t, { topic: t, board, notes, updatedAt: savedAt || Date.now() });
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('请求失败 ' + r.status));
  return d;
}
export async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || ('请求失败 ' + r.status)); e.code = d.code; throw e; }
  return d;
}
export async function delJSON(url) {
  const r = await fetch(url, { method: 'DELETE' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('请求失败 ' + r.status));
  return d;
}

export async function readSSE(r, handle) {
  const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const c = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = c.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      handle(ev);
    }
  }
}

export function toast(msg, type = '') {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icon = type === 'ok' ? '✓' : type === 'err' ? '✕' : type === 'warn' ? '!' : 'ℹ';
  el.innerHTML = '<b>' + icon + '</b><span>' + esc(msg) + '</span>';
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

// Styled, accessible confirmation dialog. Resolves true (confirm) / false (cancel).
// Cancel is the default-focused safe action; Esc and scrim-click cancel; Tab is trapped.
export function confirmModal({ title, body, confirmText = '确认', cancelText = '取消', danger = false, icon = 'warn' } = {}) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const ic = icon === 'exit'
      ? '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>';
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalBody">' +
        '<div class="modal-ic' + (danger ? ' danger' : '') + '"><svg viewBox="0 0 24 24" width="26" height="26">' + ic + '</svg></div>' +
        '<h3 id="modalTitle">' + esc(title) + '</h3>' +
        '<p id="modalBody" class="modal-body">' + esc(body) + '</p>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="cancel">' + esc(cancelText) + '</button>' +
          '<button class="btn' + (danger ? ' danger' : '') + '" data-act="confirm">' + esc(confirmText) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    void overlay.offsetHeight;
    overlay.classList.add('show');
    let closed = false;
    const close = val => {
      if (closed) return; closed = true;
      overlay.classList.remove('show');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => overlay.remove(), 200);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch {} }
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Tab') {
        const f = overlay.querySelectorAll('button[data-act]');
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    overlay.addEventListener('click', e => {
      if (e.target === overlay) { close(false); return; }
      const b = e.target.closest('button[data-act]');
      if (b) close(b.dataset.act === 'confirm');
    });
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('[data-act="cancel"]').focus();
  });
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function guideLink(code) {
  const g = { NO_KEY: ['/settings', '去配置密钥 →'], EMPTY_KB: ['/kb', '去上传资料 →'] }[code];
  return g ? '<a class="btn ghost sm" href="' + g[0] + '" data-route>' + g[1] + '</a>' : '';
}

const WEB_IC = '<svg class="web-ic" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 2.6 15.3 0 18M12 3c-2.6 2.7-2.6 15.3 0 18" stroke-linecap="round"/></svg>';
export function webCitesHTML(webCitations) {
  return (webCitations || []).map(w =>
    '<a class="chip web" href="' + esc(w.url) + '" target="_blank" rel="noopener" title="来自网络：' + esc(w.url) + '">' +
    WEB_IC + '<span>' + esc(w.title || w.url) + '</span></a>'
  ).join(' ');
}

export async function refreshConn() {
  const el = $('#connState');
  if (!el) return;
  try {
    const d = await getJSON('/api/health');
    el.className = 'conn ok';
    $('.conn-text', el).textContent = d.hasKey ? '后端已连接 · key 就绪' : '后端已连接 · 未配置 key';
    const chip = $('#modelChip');
    chip.textContent = d.model; chip.title = d.model;
  } catch {
    el.className = 'conn err';
    $('.conn-text', el).textContent = '后端连接失败';
  }
}

function renderMath(tex, display) {
  const k = typeof window !== 'undefined' && window.katex;
  if (!k) return '<code>' + esc(tex) + '</code>';
  try {
    return k.renderToString(tex, { displayMode: display, throwOnError: false });
  } catch {
    return '<code>' + esc(tex) + '</code>';
  }
}

export function inlineMd(s) {
  const parts = [];
  let out = String(s).replace(/`([^`]+)`|\$([^$\n]+)\$/g, (m, code, math) => {
    parts.push(code !== undefined ? '<code>' + esc(code) + '</code>' : renderMath(math, false));
    return '\u0000' + (parts.length - 1) + '\u0000';
  });
  out = esc(out);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (m, i) => parts[+i]);
  return out;
}

export function mdToHtml(md) {
  const lines = String(md).split('\n');
  let html = '', inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (!line.trim()) { closeLists(); continue; }
    let m;
    if ((m = line.match(/^```(\w*)\s*$/))) {
      closeLists();
      const buf = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      html += '<pre><code' + (m[1] ? ' class="language-' + esc(m[1]) + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>';
      continue;
    }
    if (/^\$\$/.test(line.trim())) {
      closeLists();
      const t = line.trim();
      let tex;
      if (t.length > 4 && t.endsWith('$$')) tex = t.slice(2, -2);
      else {
        const buf = [t.replace(/^\$\$/, '')]; i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) buf.push(lines[i].replace(/\$\$\s*$/, ''));
        tex = buf.join('\n');
      }
      html += renderMath(tex, true);
      continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeLists(); const lvl = Math.min(m[1].length + 2, 6); html += '<h' + lvl + '>' + inlineMd(m[2]) + '</h' + lvl + '>'; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (inOl) { html += '</ol>'; inOl = false; } if (!inUl) { html += '<ul>'; inUl = true; } html += '<li>' + inlineMd(m[1]) + '</li>'; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)/))) { if (inUl) { html += '</ul>'; inUl = false; } if (!inOl) { html += '<ol>'; inOl = true; } html += '<li>' + inlineMd(m[1]) + '</li>'; }
    else { closeLists(); html += '<p>' + inlineMd(line) + '</p>'; }
  }
  closeLists();
  return html;
}

export function sanitizeSvg(svg) {
  try {
    const doc = new DOMParser().parseFromString(svg, 'text/html');
    const el = doc.querySelector('svg');
    if (!el) return '';
    el.querySelectorAll('script').forEach(n => n.remove());
    for (const node of el.querySelectorAll('*')) {
      for (const attr of [...node.attributes]) {
        if (attr.name.toLowerCase().startsWith('on') || /javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
      }
    }
    return el.outerHTML;
  } catch { return ''; }
}

// Render one parsed whiteboard block (title / figure / circuit / func / text) to HTML.
// circuits: optional map code -> png data URL (null = failed); absent code = live placeholder.
export function blockHtml(b, circuits) {
  if (b.type === 'title') return (b.isTopic ? '<div class="topic-eyebrow">课题</div>' : '') + `<h2>${esc(b.text)}</h2><div class="rule"></div>`;
  if (b.type === 'figure') {
    const svg = sanitizeSvg(b.svg);
    return `<div class="fig-frame">${svg || '<span style="color:#94a3b8;font-size:13px">示意图</span>'}</div>` +
      (b.caption ? `<div class="cap">${esc(b.caption)}</div>` : '');
  }
  if (b.type === 'circuit') {
    const has = circuits && Object.prototype.hasOwnProperty.call(circuits, b.code);
    const png = has ? circuits[b.code] : null;
    const inner = png
      ? '<img src="' + png + '" alt="电路图">'
      : has
        ? '<span class="fig-error">电路图生成失败</span><pre><code>' + esc(b.code) + '</code></pre>'
        : '<div class="circuit-frame" data-circuit="' + esc(b.code) + '"><span class="fig-loading">电路图编译中…</span></div>';
    return '<div class="fig-frame">' + inner + '</div>' + (b.caption ? `<div class="cap">${esc(b.caption)}</div>` : '');
  }
  if (b.type === 'func') {
    const svg = b.spec ? funcSvg(b.spec) : '';
    const inner = svg || '<span class="fig-error">函数图像解析失败</span><pre><code>' + esc(b.raw || '') + '</code></pre>';
    return '<div class="fig-frame">' + inner + '</div>' + (b.caption ? `<div class="cap">${esc(b.caption)}</div>` : '');
  }
  return (b.heading ? `<h4><span class="pin"></span>${esc(b.heading)}</h4>` : '') + b.html;
}

export function imageFigureHTML(img, src) {
  const cap = esc(img.docName || '资料') + (img.page != null ? ' · 第' + esc(img.page) + '页' : '');
  return '<div class="fig-frame"><img src="' + esc(src || img.url) + '" alt="资料原图"></div>' +
    '<div class="cap">' + cap + '</div>';
}

function readFence(lines, i) {
  const body = []; i++; let closed = false;
  while (i < lines.length) {
    if (/^```\s*$/.test(lines[i])) { closed = true; i++; break; }
    body.push(lines[i]); i++;
  }
  return { body, i, closed };
}
function readCaption(lines, i) {
  let j = i;
  while (j < lines.length && !lines[j].trim()) j++;
  if (j < lines.length) {
    const t = lines[j].trim();
    if (!/^#{1,4}\s/.test(t) && !/^```/.test(t) && !/^[-*]\s/.test(t) && !/^\d+\.\s/.test(t) && t.length < 80) return { caption: t, i: j + 1 };
  }
  return { caption: '', i };
}

// Split streamed markdown into discrete whiteboard blocks: title / text / figure / circuit / func.
export function parseBlocks(full) {
  const blocks = [];
  const lines = String(full).split('\n');
  let i = 0, cur = null;
  const flush = () => {
    if (cur && (cur.heading || cur.body.join('').trim())) {
      blocks.push({ type: 'text', heading: cur.heading, html: mdToHtml(cur.body.join('\n')) });
    }
    cur = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```svg\s*$/.test(line)) {
      flush();
      const f = readFence(lines, i);
      if (!f.closed) break;
      const c = readCaption(lines, f.i);
      blocks.push({ type: 'figure', svg: f.body.join('\n'), caption: c.caption });
      i = c.i;
      continue;
    }
    if (/^```circuit\s*$/.test(line)) {
      flush();
      const f = readFence(lines, i);
      if (!f.closed) break;
      const c = readCaption(lines, f.i);
      blocks.push({ type: 'circuit', code: f.body.join('\n').trim(), caption: c.caption });
      i = c.i;
      continue;
    }
    if (/^```func\s*$/.test(line)) {
      flush();
      const f = readFence(lines, i);
      if (!f.closed) break;
      const c = readCaption(lines, f.i);
      const raw = f.body.join('\n').trim();
      let spec = null;
      try { spec = JSON.parse(raw); } catch { spec = null; }
      blocks.push({ type: 'func', spec, raw, caption: c.caption });
      i = c.i;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence && !['svg', 'circuit', 'func'].includes(fence[1])) {
      if (!cur) cur = { heading: '', body: [] };
      cur.body.push(line); i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { cur.body.push(lines[i]); i++; }
      if (i < lines.length) { cur.body.push(lines[i]); i++; }
      continue;
    }
    const h1 = line.match(/^#\s+(.*)/);
    const h2 = line.match(/^#{2,4}\s+(.*)/);
    if (h1) { flush(); blocks.push({ type: 'title', text: h1[1] }); i++; continue; }
    if (h2) { flush(); cur = { heading: h2[1], body: [] }; i++; continue; }
    if (!cur) cur = { heading: '', body: [] };
    cur.body.push(line); i++;
  }
  flush();
  return blocks;
}

export async function fetchCircuitPNG(code) {
  const r = await fetch('/api/circuit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.png) throw new Error(d.error || ('请求失败 ' + r.status));
  return d.png;
}

const circuitInflight = new Map();
export async function resolveCircuitFrames(root, cache = {}) {
  const frames = [...root.querySelectorAll('.circuit-frame[data-circuit]')];
  await Promise.all(frames.map(async f => {
    const code = f.getAttribute('data-circuit');
    f.removeAttribute('data-circuit');
    let p = circuitInflight.get(code);
    if (!p) { p = fetchCircuitPNG(code); circuitInflight.set(code, p); }
    try {
      const png = await p;
      cache[code] = png;
      f.innerHTML = '<img src="' + png + '" alt="电路图">';
      const img = f.querySelector('img');
      if (img && img.decode) await img.decode().catch(() => {});
    } catch (e) {
      cache[code] = null;
      f.innerHTML = '<span class="fig-error">电路图生成失败：' + esc(e.message) + '</span><pre><code>' + esc(code) + '</code></pre>';
    } finally {
      circuitInflight.delete(code);
    }
  }));
}

const EXPR_FUN = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, log: Math.log, ln: Math.log,
  sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
};
const EXPR_CONST = { pi: Math.PI, e: Math.E };
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Safe recursive-descent expression compiler (no eval). Returns a function f(x).
export function compileExpr(src) {
  const s = String(src).replace(/\s+/g, '');
  if (!s) throw new Error('表达式为空');
  if (s.length > 200) throw new Error('表达式过长');
  let pos = 0;
  const eat = c => { if (s[pos] === c) { pos++; return true; } return false; };
  const startsFactor = () => { const c = s[pos]; return c !== undefined && (c === '(' || /[0-9.a-zA-Z]/.test(c)); };
  function expr() {
    let left = term();
    for (;;) {
      if (eat('+')) { const l = left, r = term(); left = x => l(x) + r(x); }
      else if (eat('-')) { const l = left, r = term(); left = x => l(x) - r(x); }
      else break;
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      if (eat('*')) { const l = left, r = unary(); left = x => l(x) * r(x); }
      else if (eat('/')) { const l = left, r = unary(); left = x => l(x) / r(x); }
      else if (startsFactor()) { const l = left, r = unary(); left = x => l(x) * r(x); }
      else break;
    }
    return left;
  }
  function unary() {
    if (eat('-')) { const v = unary(); return x => -v(x); }
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const base = primary();
    if (eat('^')) { const e = unary(); return x => Math.pow(base(x), e(x)); }
    return base;
  }
  function primary() {
    if (eat('(')) { const v = expr(); if (!eat(')')) throw new Error('缺少右括号'); return v; }
    const num = s.slice(pos).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (num) { pos += num[0].length; const v = parseFloat(num[0]); return () => v; }
    const id = s.slice(pos).match(/^[a-zA-Z]+/);
    if (id) {
      pos += id[0].length;
      const name = id[0].toLowerCase();
      if (name === 'x') return x => x;
      if (hasOwn(EXPR_CONST, name)) { const v = EXPR_CONST[name]; return () => v; }
      if (hasOwn(EXPR_FUN, name)) {
        if (!eat('(')) throw new Error(name + ' 后需要括号');
        const arg = expr();
        if (!eat(')')) throw new Error('缺少右括号');
        const f = EXPR_FUN[name];
        return x => f(arg(x));
      }
      throw new Error('未知符号: ' + id[0]);
    }
    throw new Error('无法解析表达式');
  }
  const f = expr();
  if (pos !== s.length) throw new Error('表达式有多余内容: ' + s.slice(pos));
  return f;
}

export function funcSvg(spec) {
  try {
    const exprSrc = String((spec && spec.expr) || '').trim();
    if (!exprSrc) return '';
    const f = compileExpr(exprSrc);
    let xMin = Number(spec.xMin), xMax = Number(spec.xMax);
    if (!isFinite(xMin)) xMin = -10;
    if (!isFinite(xMax)) xMax = 10;
    if (xMax - xMin < 1e-9) return '';
    const W = 600, H = 300, L = 46, R = 14, T = 16, B = 34, N = 240;
    const xs = [], ys = [];
    for (let i = 0; i <= N; i++) {
      const x = xMin + (xMax - xMin) * i / N;
      let y; try { y = f(x); } catch { y = NaN; }
      xs.push(x); ys.push(typeof y === 'number' && isFinite(y) ? y : null);
    }
    let yMin = Number(spec.yMin), yMax = Number(spec.yMax);
    if (!isFinite(yMin) || !isFinite(yMax) || yMax - yMin < 1e-9) {
      const vals = ys.filter(v => v !== null).sort((a, b) => a - b);
      if (!vals.length) return '';
      const q = p => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
      let lo = q(0.02), hi = q(0.98);
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12;
      yMin = lo - pad; yMax = hi + pad;
    }
    const sx = x => L + (x - xMin) / (xMax - xMin) * (W - L - R);
    const sy = y => T + (yMax - y) / (yMax - yMin) * (H - T - B);
    const fmt = v => { const a = Math.abs(v); if (a !== 0 && (a >= 10000 || a < 0.01)) return v.toExponential(1); return String(Math.round(v * 100) / 100); };
    const step = raw => { const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p; };
    let g = '';
    const stX = step((xMax - xMin) / 6), stY = step((yMax - yMin) / 5);
    for (let t = Math.ceil(xMin / stX) * stX; t <= xMax + stX * 1e-6; t += stX) {
      const X = sx(t).toFixed(1);
      g += '<line x1="' + X + '" y1="' + T + '" x2="' + X + '" y2="' + (H - B) + '" stroke="#e8edf4"/>';
      g += '<text x="' + X + '" y="' + (H - B + 16) + '" font-size="11" fill="#64748b" text-anchor="middle">' + esc(fmt(t)) + '</text>';
    }
    for (let t = Math.ceil(yMin / stY) * stY; t <= yMax + stY * 1e-6; t += stY) {
      const Y = sy(t).toFixed(1);
      g += '<line x1="' + L + '" y1="' + Y + '" x2="' + (W - R) + '" y2="' + Y + '" stroke="#e8edf4"/>';
      g += '<text x="' + (L - 6) + '" y="' + (+Y + 4) + '" font-size="11" fill="#64748b" text-anchor="end">' + esc(fmt(t)) + '</text>';
    }
    const y0 = (0 >= yMin && 0 <= yMax) ? sy(0).toFixed(1) : String(H - B);
    const x0 = (0 >= xMin && 0 <= xMax) ? sx(0).toFixed(1) : String(L);
    g += '<line x1="' + L + '" y1="' + y0 + '" x2="' + (W - R) + '" y2="' + y0 + '" stroke="#94a3b8" stroke-width="1.5"/>';
    g += '<line x1="' + x0 + '" y1="' + T + '" x2="' + x0 + '" y2="' + (H - B) + '" stroke="#94a3b8" stroke-width="1.5"/>';
    let d = '', pen = false;
    for (let i = 0; i <= N; i++) {
      const y = ys[i];
      if (y === null || y < yMin || y > yMax) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + sx(xs[i]).toFixed(1) + ' ' + sy(y).toFixed(1) + ' ';
      pen = true;
    }
    if (d.trim()) g += '<path d="' + d.trim() + '" fill="none" stroke="#4d9fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    const label = String(spec.label || ('y = ' + exprSrc));
    g += '<text x="' + L + '" y="12" font-size="13" font-weight="600" fill="#334155">' + esc(label) + '</text>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(label) + '">' +
      '<rect width="' + W + '" height="' + H + '" fill="#fbfcfe" rx="8"/>' + g + '</svg>';
  } catch { return ''; }
}
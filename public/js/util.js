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

export function inlineMd(s) {
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

export function mdToHtml(md) {
  const lines = String(md).split('\n');
  let html = '', inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { closeLists(); continue; }
    let m;
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

// Render one parsed whiteboard block (title / figure / text) to HTML.
export function blockHtml(b) {
  if (b.type === 'title') return (b.isTopic ? '<div class="topic-eyebrow">课题</div>' : '') + `<h2>${esc(b.text)}</h2><div class="rule"></div>`;
  if (b.type === 'figure') {
    const svg = sanitizeSvg(b.svg);
    return `<div class="fig-frame">${svg || '<span style="color:#94a3b8;font-size:13px">示意图</span>'}</div>` +
      (b.caption ? `<div class="cap">${esc(b.caption)}</div>` : '');
  }
  return (b.heading ? `<h4><span class="pin"></span>${esc(b.heading)}</h4>` : '') + b.html;
}

// Split streamed markdown into discrete whiteboard blocks: title / text / figure.
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
      const svg = []; i++; let closed = false;
      while (i < lines.length) { if (/^```\s*$/.test(lines[i])) { closed = true; i++; break; } svg.push(lines[i]); i++; }
      if (!closed) break;
      let caption = '', j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length) {
        const t = lines[j].trim();
        if (!/^#{1,4}\s/.test(t) && !/^```/.test(t) && !/^[-*]\s/.test(t) && !/^\d+\.\s/.test(t) && t.length < 80) { caption = t; i = j + 1; }
      }
      blocks.push({ type: 'figure', svg: svg.join('\n'), caption });
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
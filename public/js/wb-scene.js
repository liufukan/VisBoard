// Shared whiteboard scene: geometry, block splitting, element builders, layout,
// connectors and pan/zoom view control. Used by the live board and the read-only
// history viewer so both render identically from one source of truth.
import { esc, mdToHtml, blockHtml, webCitesHTML, parseBlocks } from './util.js';

export const GEO = {
  SIDE_W: 360, RAIL_GAP: 48, LEFT_X: 40, COL_W: 540,
  COL0_X: 448, COL1_X: 1028, RIGHT_X: 1616, CONTENT_W: 2016,
  GUTTER_X: 1008, GAP_Y: 32,
};
export const MODE_LABEL = { ask: '提问', explain: '解释一下', simpler: '再简单点', example: '举个例子' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const FLOW_DEF = '<defs><marker id="ah-flow" markerWidth="9" markerHeight="9" refX="6.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0.5,0.5 L7,3.5 L0.5,6.5" fill="none" stroke="#4d9fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';
const DRILL_DEF = '<defs><marker id="ah-drill" markerWidth="11" markerHeight="11" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0.5,0.5 L8.5,4 L0.5,7.5" fill="none" stroke="#ffb454" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';
const WEB_DEF = '<defs><marker id="ah-web" markerWidth="11" markerHeight="11" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0.5,0.5 L8.5,4 L0.5,7.5" fill="none" stroke="#3fc7d2" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';

export function cleanFull(s) {
  const lines = String(s).split('\n');
  if (lines.length && /^`{1,3}[a-z]*$/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n');
}

// Split lesson markdown into the main knowledge line and the web-extension
// blocks. The backend WEB_RULE forces a "## 拓展阅读（来自网络）" section, so any
// text block whose heading mentions 来自网络 is treated as web supplement.
export function splitBlocks(full) {
  const parsed = parseBlocks(cleanFull(full));
  if (parsed.length && parsed[0].type === 'title') parsed.shift();
  const main = [], web = [];
  for (const b of parsed) {
    if (b.type === 'text' && b.heading && /来自网络/.test(b.heading)) web.push(b);
    else main.push(b);
  }
  return { main, web };
}

export function makeCardEl(b, circuitCache) {
  const card = document.createElement('div');
  card.className = 'wb-el ' + (b.type === 'title'
    ? (b.isTopic ? 'wb-title wb-topic' : 'wb-title')
    : (b.type === 'figure' || b.type === 'circuit' || b.type === 'func') ? 'wb-card wb-figure' : 'wb-card wb-text');
  card.dataset.type = b.type;
  const html = blockHtml(b, circuitCache);
  card.innerHTML = html; card.dataset.sig = html;
  return card;
}

export function webHTML(b, webCitations) {
  const cites = webCitations && webCitations.length ? '<div class="web-cites">' + webCitesHTML(webCitations) + '</div>' : '';
  return '<div class="web-head"><span class="web-badge">联网拓展</span><span class="web-note">来自网络 · 仅供参考</span></div>' +
    '<div class="web-body">' + (b.html || '') + '</div>' + cites;
}

export function makeWebEl(b, webCitations) {
  const el = document.createElement('div');
  el.className = 'wb-el wb-web';
  el.dataset.type = 'web';
  const html = webHTML(b, webCitations);
  el.innerHTML = html; el.dataset.sig = html;
  return el;
}

export function makeDialogEl(d, { readOnly = false } = {}) {
  const el = document.createElement('div');
  el.className = 'wb-dialog' + (readOnly ? ' readonly' : '');
  const ctxFull = String(d.context || '');
  const snippet = ctxFull.slice(0, 40);
  const label = MODE_LABEL[d.mode] || '追问';
  let html = '<div class="dlg-head">' +
    `<span class="dlg-badge ${esc(d.mode || 'ask')}">${esc(label)}</span>` +
    `<span class="dlg-src" title="${esc(ctxFull)}">关于：${esc(snippet)}${ctxFull.length > 40 ? '…' : ''}</span>`;
  if (!readOnly) html += '<button class="dlg-close" title="关闭对话">×</button>';
  html += '</div><div class="dlg-thread"></div>';
  if (!readOnly) {
    html += '<div class="dlg-input"><input type="text" placeholder="继续追问…" autocomplete="off">' +
      '<button class="dlg-send" title="发送"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>';
  }
  el.innerHTML = html;
  if (readOnly) {
    const thread = el.querySelector('.dlg-thread');
    const msgs = (d.history || []).map(h =>
      `<div class="msg ${h.role === 'user' ? 'user' : 'ai'}"><div class="bubble md">${mdToHtml(h.content)}</div></div>`).join('');
    thread.innerHTML = msgs || '<p class="dlg-empty">（无对话内容）</p>';
  }
  return el;
}

export function cardRect(c) {
  const l = parseFloat(c.style.left) || 0, t = parseFloat(c.style.top) || 0;
  return { l, t, w: c.offsetWidth, h: c.offsetHeight, r: l + c.offsetWidth, b: t + c.offsetHeight };
}

// Main-line connector between adjacent knowledge cards. Bows through the empty
// central gutter when a stacked pair would otherwise slice a box.
function flowPath(a, b, obstacles) {
  const A = cardRect(a), B = cardRect(b);
  const acy = A.t + A.h / 2, bcx = B.l + B.w / 2, bcy = B.t + B.h / 2;
  const m = 14, G = GEO.GUTTER_X;
  const blockedBetween = (sx, top, bottom) => obstacles.some(o =>
    o.r > sx - 2 && o.l < sx + 2 && o.b > top + 2 && o.t < bottom - 2);
  const bow = (top, bottom, fromLeft) => {
    const ax = fromLeft ? A.l + m : A.r - m, bx = fromLeft ? B.l + m : B.r - m;
    const dy = Math.max(30, (bottom - top) * 0.25);
    return `M${ax},${top} C${G},${top + dy} ${G},${bottom - dy} ${bx},${bottom}`;
  };
  let sx, sy, ex, ey, c1x, c1y, c2x, c2y;
  if (B.l >= A.r - 1) {
    sx = A.r; sy = clamp(bcy, A.t + m, A.b - m); ex = B.l; ey = clamp(acy, B.t + m, B.b - m);
    const dx = Math.max(22, (ex - sx) * 0.5);
    c1x = sx + dx; c1y = sy; c2x = ex - dx; c2y = ey;
  } else if (B.r <= A.l + 1) {
    sx = A.l; sy = clamp(bcy, A.t + m, A.b - m); ex = B.r; ey = clamp(acy, B.t + m, B.b - m);
    const dx = Math.max(22, (sx - ex) * 0.5);
    c1x = sx - dx; c1y = sy; c2x = ex + dx; c2y = ey;
  } else if (B.t >= A.b - 1) {
    sx = clamp(bcx, A.l + m, A.r - m); sy = A.b; ex = bcx; ey = B.t;
    if (blockedBetween(sx, sy, ey)) return bow(sy, ey, (A.l + A.r) / 2 > G);
    const dy = Math.max(14, (ey - sy) * 0.5);
    c1x = sx; c1y = sy + dy; c2x = ex; c2y = ey - dy;
  } else {
    sx = clamp(bcx, A.l + m, A.r - m); sy = A.t; ex = bcx; ey = B.b;
    if (blockedBetween(sx, ey, sy)) return bow(ey, sy, (A.l + A.r) / 2 > G);
    const dy = Math.max(14, (sy - ey) * 0.5);
    c1x = sx; c1y = sy - dy; c2x = ex; c2y = ey + dy;
  }
  return `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${ex},${ey}`;
}

// Dashed branch from a knowledge card out to a side box on the SAME side as the
// card's column, so the arrow lives in the rail gap and never crosses a card.
function sidePath(a, b, side) {
  const A = cardRect(a), B = cardRect(b);
  const sy = A.t + A.h / 2, ey = B.t + B.h / 2;
  let sx, ex, c1x, c2x;
  if (side === 'left') {
    sx = A.l; ex = B.r;
    const dx = Math.max(20, (sx - ex) * 0.5);
    c1x = sx - dx; c2x = ex + dx;
  } else {
    sx = A.r; ex = B.l;
    const dx = Math.max(20, (ex - sx) * 0.5);
    c1x = sx + dx; c2x = ex - dx;
  }
  return `M${sx},${sy} C${c1x},${sy} ${c2x},${ey} ${ex},${ey}`;
}

// Vertical connector down a rail between two stacked side boxes (dialog thread).
function railPath(a, b) {
  const A = cardRect(a), B = cardRect(b);
  const cx = A.l + A.w / 2, ex = B.l + B.w / 2;
  const sy = A.b, ey = B.t, dy = Math.max(10, (ey - sy) * 0.5);
  return `M${cx},${sy} C${cx},${sy + dy} ${ex},${ey - dy} ${ex},${ey}`;
}

function sideOf(source) {
  if (!source || !source.isConnected) return 'right';
  const R = cardRect(source);
  return (R.l + R.w / 2) < GEO.GUTTER_X ? 'left' : 'right';
}

// Lay out the whole scene: main cards in two columns (title full-width), side
// boxes (dialogs + web) on the rail matching their source column, near the
// source and stacked to avoid overlap. Returns bounds and draws all connectors.
export function layoutScene({ cards, dialogs, web, canvas, links }) {
  const colH = [40, 40];
  let maxY = 0;
  cards.forEach(card => {
    if (card.dataset.type === 'title') {
      card.style.left = GEO.COL0_X + 'px';
      card.style.width = (GEO.COL1_X + GEO.COL_W - GEO.COL0_X) + 'px';
      card.style.top = Math.max(colH[0], colH[1]) + 'px';
      const ny = parseFloat(card.style.top) + card.offsetHeight + 36;
      colH[0] = colH[1] = ny;
      maxY = Math.max(maxY, parseFloat(card.style.top) + card.offsetHeight);
    } else {
      const c = colH[0] <= colH[1] ? 0 : 1;
      card.style.left = (c === 0 ? GEO.COL0_X : GEO.COL1_X) + 'px';
      card.style.width = GEO.COL_W + 'px';
      card.style.top = colH[c] + 'px';
      colH[c] += card.offsetHeight + GEO.GAP_Y;
      maxY = Math.max(maxY, parseFloat(card.style.top) + card.offsetHeight);
    }
  });

  const railY = { left: 40, right: 40 };
  const placeSide = item => {
    const side = sideOf(item.source);
    const x = side === 'left' ? GEO.LEFT_X : GEO.RIGHT_X;
    item.el.style.left = x + 'px';
    item.el.style.width = GEO.SIDE_W + 'px';
    const h = item.el.offsetHeight;
    const srcTop = item.source && item.source.isConnected ? (parseFloat(item.source.style.top) || 0) : 40;
    const y = Math.max(railY[side], srcTop - 8);
    item.el.style.top = y + 'px';
    item.x = x; item.y = y; item.side = side;
    railY[side] = y + h + 18;
    maxY = Math.max(maxY, y + h);
  };
  dialogs.forEach(placeSide);
  web.forEach(placeSide);

  const bounds = { w: GEO.CONTENT_W, h: Math.max(900, maxY + 80) };
  canvas.style.width = bounds.w + 'px';
  canvas.style.height = bounds.h + 'px';

  // connectors
  const cardRects = cards.map(cardRect);
  const sideRects = [...dialogs, ...web].filter(it => it.el.isConnected).map(it => cardRect(it.el));
  const flow = [];
  for (let i = 0; i < cards.length - 1; i++) {
    const obstacles = cardRects.filter((_, j) => j !== i && j !== i + 1).concat(sideRects);
    flow.push(`<path class="lk-flow" d="${flowPath(cards[i], cards[i + 1], obstacles)}" marker-end="url(#ah-flow)"/>`);
  }
  const drill = [];
  const bySource = new Map();
  dialogs.forEach(d => { if (!bySource.has(d.source)) bySource.set(d.source, []); bySource.get(d.source).push(d); });
  bySource.forEach(ds => {
    ds.forEach((d, i) => {
      if (!d.el.isConnected) return;
      const path = i === 0
        ? (d.source && d.source.isConnected ? sidePath(d.source, d.el, d.side) : '')
        : railPath(ds[i - 1].el, d.el);
      if (path) drill.push(`<path class="lk-drill" d="${path}" marker-end="url(#ah-drill)"/>`);
    });
  });
  const webPaths = [];
  web.forEach(w => {
    if (!w.el.isConnected || !w.source || !w.source.isConnected) return;
    webPaths.push(`<path class="lk-web" d="${sidePath(w.source, w.el, w.side)}" marker-end="url(#ah-web)"/>`);
  });
  links.setAttribute('width', bounds.w);
  links.setAttribute('height', bounds.h);
  links.setAttribute('viewBox', `0 0 ${bounds.w} ${bounds.h}`);
  links.innerHTML = FLOW_DEF + DRILL_DEF + WEB_DEF + flow.join('') + drill.join('') + webPaths.join('');
  return bounds;
}

// Pan/zoom view controller shared by live board and history viewer.
export function createView(canvas, viewport, opts = {}) {
  let vw = { x: 40, y: 30, scale: 0.85 };
  let bounds = { w: GEO.CONTENT_W, h: 900 };
  const zval = opts.zval || null;
  function applyView(smooth) {
    canvas.classList.toggle('smooth', !!smooth);
    canvas.style.transform = `translate(${vw.x}px, ${vw.y}px) scale(${vw.scale})`;
    if (zval) zval.textContent = Math.round(vw.scale * 100) + '%';
  }
  function zoomAt(mx, my, factor) {
    const ns = clamp(vw.scale * factor, 0.25, 2.5), k = ns / vw.scale;
    vw.x = mx - (mx - vw.x) * k; vw.y = my - (my - vw.y) * k; vw.scale = ns;
    applyView(false);
  }
  function fitView(smooth = true) {
    const r = viewport.getBoundingClientRect(), pad = 60;
    const s = clamp(Math.min((r.width - pad * 2) / bounds.w, (r.height - pad * 2) / bounds.h), 0.25, 1.2);
    vw.scale = s; vw.x = (r.width - bounds.w * s) / 2; vw.y = Math.max(30, (r.height - bounds.h * s) / 2);
    applyView(smooth);
  }
  function focusEl(el, o = {}) {
    const r = viewport.getBoundingClientRect();
    const s = clamp(Math.max(vw.scale, o.minScale || 0.85), 0.25, 2.5);
    const l = parseFloat(el.style.left) || 0, t = parseFloat(el.style.top) || 0;
    const w = el.offsetWidth || GEO.SIDE_W;
    vw.scale = s;
    vw.x = r.width * (o.cx || 0.5) - (l + w / 2) * s;
    vw.y = r.height * (o.cy || 0.42) - (t + (o.oy || 60)) * s;
    applyView(true);
  }
  function panTo(x, y, smooth) { vw.x = x; vw.y = y; applyView(smooth); }
  function reset(smooth = true) { vw = { x: 40, y: 30, scale: 0.85 }; applyView(smooth); }
  function setBounds(b) { bounds = b; }
  return {
    applyView, zoomAt, fitView, focusEl, panTo, reset, setBounds,
    get vw() { return vw; }, set vw(v) { vw = v; },
    get bounds() { return bounds; },
  };
}
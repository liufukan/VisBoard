import { $, esc, toast, parseBlocks, mdToHtml, blockHtml, webCitesHTML, resolveCircuitFrames, imageFigureHTML } from './util.js';
import { subjectSelectHTML, initSubjectSelect, getSubject } from './subject.js';
import { webToggleHTML, initWebToggle, getWeb } from './web.js';
import { saveBoard, exportLessonHTML, getPlan } from './lesson.js';

const COL_X = [40, 620], COL_W = 540, GAP_Y = 32, CONTENT_W = 1200;
const DIALOG_INDENT = 28, DIALOG_GAP = 18;
const GUTTER_X = (COL_X[0] + COL_W + COL_X[1]) / 2;
const MODE_LABEL = { ask: '提问', explain: '解释一下', simpler: '再简单点', example: '举个例子' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Navigation guard: true while a lesson (or drill answer) is still generating, so
// the router can confirm before aborting the stream and wiping the board.
let leaveGuard = null;
export function isLessonActive() { return leaveGuard ? leaveGuard() : false; }

const FLOW_DEF = '<defs><marker id="ah-flow" markerWidth="9" markerHeight="9" refX="6.5" refY="3.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0.5,0.5 L7,3.5 L0.5,6.5" fill="none" stroke="#4d9fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';
const DRILL_DEF = '<defs><marker id="ah-drill" markerWidth="11" markerHeight="11" refX="7.5" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0.5,0.5 L8.5,4 L0.5,7.5" fill="none" stroke="#ffb454" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>';

function cardRect(c) {
  const l = parseFloat(c.style.left) || 0, t = parseFloat(c.style.top) || 0;
  return { l, t, w: c.offsetWidth, h: c.offsetHeight, r: l + c.offsetWidth, b: t + c.offsetHeight };
}
// Anchor on the edges that face each other and bow the curve through the empty
// gutter between cards, so the connector stays fully visible instead of ducking
// under neighbouring cards. Picks right/left edges for side-by-side cards and
// top/bottom edges for stacked ones. When a stacked pair has a dialogue (or other
// card) sitting between them, the vertical run detours out through the central
// gutter — a column no card or dialogue ever occupies — so it never slices a box.
function flowPath(a, b, obstacles) {
  const A = cardRect(a), B = cardRect(b);
  const acy = A.t + A.h / 2, bcx = B.l + B.w / 2, bcy = B.t + B.h / 2;
  const m = 14;
  const blockedBetween = (sx, top, bottom) => obstacles.some(o =>
    o.r > sx - 2 && o.l < sx + 2 && o.b > top + 2 && o.t < bottom - 2);
  const bow = (top, bottom, fromLeft) => {
    const ax = fromLeft ? A.l + m : A.r - m, bx = fromLeft ? B.l + m : B.r - m;
    const dy = Math.max(30, (bottom - top) * 0.25);
    return `M${ax},${top} C${GUTTER_X},${top + dy} ${GUTTER_X},${bottom - dy} ${bx},${bottom}`;
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
    if (blockedBetween(sx, sy, ey)) return bow(sy, ey, (A.l + A.r) / 2 > GUTTER_X);
    const dy = Math.max(14, (ey - sy) * 0.5);
    c1x = sx; c1y = sy + dy; c2x = ex; c2y = ey - dy;
  } else {
    sx = clamp(bcx, A.l + m, A.r - m); sy = A.t; ex = bcx; ey = B.b;
    if (blockedBetween(sx, ey, sy)) return bow(ey, sy, (A.l + A.r) / 2 > GUTTER_X);
    const dy = Math.max(14, (sy - ey) * 0.5);
    c1x = sx; c1y = sy - dy; c2x = ex; c2y = ey + dy;
  }
  return `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${ex},${ey}`;
}
// Short vertical connector from a card (or the previous dialogue) straight down
// to the dialogue spawned beneath it — stays in the empty gap, never hidden.
function drillPath(prevEl, d) {
  const P = cardRect(prevEl);
  const dcx = d.x + d.el.offsetWidth / 2;
  const sx = clamp(dcx, P.l + 14, P.r - 14), sy = P.b, ex = dcx, ey = d.y;
  const dy = Math.max(12, (ey - sy) * 0.5);
  return `M${sx},${sy} C${sx},${sy + dy} ${ex},${ey - dy} ${ex},${ey}`;
}

async function readSSE(r, handle) {
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

export function mount(view) {
  view.innerHTML = `
    <div class="board-top">
      ${subjectSelectHTML()}
      ${webToggleHTML()}
      <input type="text" id="topicInput" placeholder="输入课题，例如：中断系统">
      <button class="btn" id="startBtn">开始讲解</button>
      <button class="btn ghost" id="clearBtn" title="清空白板">清空</button>
      <button class="btn ghost" id="exportBtn" hidden>导出本课 HTML</button>
      <a class="btn ghost" id="reviewBtn" data-route href="/review" hidden>笔记小测 →</a>
      <span class="board-status" id="boardStatus"></span>
      <span class="board-spacer"></span>
      <span class="meta">点击卡片追问 · 拖动平移 · 滚轮缩放</span>
    </div>
    <div class="board-stage" id="stage">
      <div class="board-viewport" id="viewport">
        <div class="board-canvas" id="canvas"><svg class="wb-links" id="wbLinks" xmlns="http://www.w3.org/2000/svg"></svg></div>
      </div>
      <div class="board-empty" id="boardEmpty">
        <div class="inner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 8h7M7 11h4M12 17l-2 3M12 17l2 3" stroke-linecap="round"/></svg>
          <b>一块等待开课的白板</b>
          <span>输入课题并点击「开始讲解」，AI 会在这里逐个插入文字框和示意图</span>
          <a class="btn ghost sm" id="boardEmptyLink" data-route hidden></a>
        </div>
      </div>
      <div class="board-cites" id="boardCites"></div>
      <div class="wb-menu" id="wbMenu" hidden>
        <span class="wb-menu-tip">不懂这点？</span>
        <button data-mode="ask">提问</button>
        <button data-mode="explain">解释一下</button>
        <button data-mode="simpler">再简单点</button>
        <button data-mode="example">举个例子</button>
      </div>
      <div class="follow-toggle">
        <button id="followBtn" class="on">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>
          <span>自动跟随</span>
        </button>
      </div>
      <div class="zoom-cluster">
        <button id="zoomOut" title="缩小"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" stroke-linecap="round"/></svg></button>
        <span class="zval" id="zval">100%</span>
        <button id="zoomIn" title="放大"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg></button>
        <button id="zoomFit" title="适应窗口"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button id="zoomReset" title="重置视图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114-3M20 14a8 8 0 01-14 3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>`;

  const vp = $('#viewport'), canvas = $('#canvas'), emptyEl = $('#boardEmpty'), stage = $('#stage'), emptyLink = $('#boardEmptyLink');
  const links = $('#wbLinks'), menu = $('#wbMenu');
  const input = $('#topicInput'), startBtn = $('#startBtn'), statusEl = $('#boardStatus'), reviewBtn = $('#reviewBtn'), exportBtn = $('#exportBtn');
  initSubjectSelect($('#subjSelect'));
  initWebToggle($('#webToggle'));
  let vw = { x: 40, y: 30, scale: 0.85 };
  let autoFollow = true, streaming = false, full = '', topic = '', cards = [], dialogs = [];
  let bounds = { w: CONTENT_W, h: 900 }, lessonMaxY = 0;
  let controller = null, renderPending = false, scenePending = false, lastCount = 0, dialogSeq = 0;
  let selectedCard = null;
  let lastCites = [], lastWebCites = [];
  let lessonImages = [];
  leaveGuard = () => streaming || dialogs.some(d => d.streaming);

  function snapshotDialogs() {
    return dialogs.filter(d => d.history && d.history.length).map(d => ({ context: d.context, mode: d.mode, history: d.history }));
  }
  function persistBoard() {
    if (!topic || !full.trim()) return;
    saveBoard(topic, { full, citations: lastCites, webCitations: lastWebCites, dialogs: snapshotDialogs(), images: lessonImages });
  }

  function applyView(smooth) {
    canvas.classList.toggle('smooth', !!smooth);
    canvas.style.transform = `translate(${vw.x}px, ${vw.y}px) scale(${vw.scale})`;
    $('#zval').textContent = Math.round(vw.scale * 100) + '%';
  }
  function zoomAt(mx, my, factor) {
    const ns = clamp(vw.scale * factor, 0.25, 2.5), k = ns / vw.scale;
    vw.x = mx - (mx - vw.x) * k; vw.y = my - (my - vw.y) * k; vw.scale = ns;
    applyView(false);
  }
  function fitView(smooth = true) {
    const r = vp.getBoundingClientRect(), pad = 60;
    const s = clamp(Math.min((r.width - pad * 2) / bounds.w, (r.height - pad * 2) / bounds.h), 0.25, 1.2);
    vw.scale = s; vw.x = (r.width - bounds.w * s) / 2; vw.y = Math.max(30, (r.height - bounds.h * s) / 2);
    applyView(smooth);
  }
  function followLast() {
    const card = cards[cards.length - 1]; if (!card) return;
    const r = vp.getBoundingClientRect();
    const cx = parseFloat(card.style.left) + card.offsetWidth / 2;
    const cy = parseFloat(card.style.top) + card.offsetHeight / 2;
    const sx = cx * vw.scale + vw.x, sy = cy * vw.scale + vw.y;
    if (sx < 100 || sx > r.width - 100 || sy < 100 || sy > r.height - 100) {
      vw.x = r.width * 0.5 - cx * vw.scale; vw.y = r.height * 0.55 - cy * vw.scale;
      applyView(true);
    }
  }
  function focusDialog(d) {
    const r = vp.getBoundingClientRect();
    const s = clamp(Math.max(vw.scale, 0.85), 0.25, 2.5);
    const w = d.el.offsetWidth || COL_W;
    vw.scale = s;
    vw.x = r.width * 0.5 - (d.x + w / 2) * s;
    vw.y = r.height * 0.42 - (d.y + 60) * s;
    applyView(true);
  }

  function drawLinks() {
    const cardRects = cards.map(cardRect);
    const dlgRects = dialogs.filter(d => d.el.isConnected).map(d => cardRect(d.el));
    const flow = [];
    for (let i = 0; i < cards.length - 1; i++) {
      const obstacles = cardRects.filter((_, j) => j !== i && j !== i + 1).concat(dlgRects);
      flow.push(`<path class="lk-flow" d="${flowPath(cards[i], cards[i + 1], obstacles)}" marker-end="url(#ah-flow)"/>`);
    }
    const drill = [];
    const bySource = new Map();
    dialogs.forEach(d => { if (!bySource.has(d.source)) bySource.set(d.source, []); bySource.get(d.source).push(d); });
    bySource.forEach((ds, src) => {
      if (!src || !src.isConnected) return;
      let prev = src;
      ds.forEach(d => { drill.push(`<path class="lk-drill" d="${drillPath(prev, d)}" marker-end="url(#ah-drill)"/>`); prev = d.el; });
    });
    links.setAttribute('width', bounds.w);
    links.setAttribute('height', bounds.h);
    links.setAttribute('viewBox', `0 0 ${bounds.w} ${bounds.h}`);
    links.innerHTML = FLOW_DEF + DRILL_DEF + flow.join('') + drill.join('');
  }

  function updateScene() { layout(); }

  function layout() {
    const colH = [40, 40]; let maxY = 0;
    const bySource = new Map();
    dialogs.forEach(d => { if (!bySource.has(d.source)) bySource.set(d.source, []); bySource.get(d.source).push(d); });
    const placeDialogs = (card, col) => {
      const ds = bySource.get(card); if (!ds) return;
      ds.forEach(d => {
        d.x = COL_X[col] + DIALOG_INDENT; d.y = colH[col];
        d.el.style.left = d.x + 'px'; d.el.style.width = (COL_W - DIALOG_INDENT) + 'px'; d.el.style.top = d.y + 'px';
        colH[col] += d.el.offsetHeight + DIALOG_GAP;
        maxY = Math.max(maxY, d.y + d.el.offsetHeight);
      });
    };
    cards.forEach(card => {
      const type = card.dataset.type;
      if (type === 'title') {
        card.style.left = '40px'; card.style.width = '1120px';
        card.style.top = Math.max(colH[0], colH[1]) + 'px';
        const ny = parseFloat(card.style.top) + card.offsetHeight + 36;
        colH[0] = colH[1] = ny;
        maxY = Math.max(maxY, parseFloat(card.style.top) + card.offsetHeight);
        placeDialogs(card, 0);
      } else {
        const c = colH[0] <= colH[1] ? 0 : 1;
        card.style.left = COL_X[c] + 'px'; card.style.width = COL_W + 'px';
        card.style.top = colH[c] + 'px';
        colH[c] += card.offsetHeight + GAP_Y;
        maxY = Math.max(maxY, parseFloat(card.style.top) + card.offsetHeight);
        placeDialogs(card, c);
      }
    });
    lessonMaxY = maxY;
    bounds = { w: CONTENT_W, h: Math.max(900, maxY + 80) };
    canvas.style.width = bounds.w + 'px';
    canvas.style.height = bounds.h + 'px';
    drawLinks();
  }

  function cleanFull(s) {
    const lines = String(s).split('\n');
    if (lines.length && /^`{1,3}[a-z]*$/.test(lines[lines.length - 1].trim())) lines.pop();
    return lines.join('\n');
  }

  const circuitCache = {};
  function renderBoard(text) {
    const parsed = parseBlocks(cleanFull(text));
    if (parsed.length && parsed[0].type === 'title') parsed.shift();
    const blocks = topic ? [{ type: 'title', text: topic, isTopic: true }, ...parsed] : parsed;
    blocks.forEach((b, i) => {
      let card = cards[i];
      if (!card) {
        card = document.createElement('div');
        card.className = 'wb-el ' + (b.type === 'title' ? (b.isTopic ? 'wb-title wb-topic' : 'wb-title') : (b.type === 'figure' || b.type === 'circuit' || b.type === 'func') ? 'wb-card wb-figure' : 'wb-card wb-text');
        card.dataset.type = b.type;
        canvas.appendChild(card); cards[i] = card;
      }
      const html = blockHtml(b, circuitCache);
      if (card.dataset.sig !== html) { card.innerHTML = html; card.dataset.sig = html; }
    });
    const total = blocks.length + lessonImages.length;
    lessonImages.forEach((img, k) => {
      const i = blocks.length + k;
      let card = cards[i];
      if (!card) {
        card = document.createElement('div');
        canvas.appendChild(card); cards[i] = card;
      }
      card.className = 'wb-el wb-card wb-figure';
      card.dataset.type = 'image';
      const html = imageFigureHTML(img, img.url);
      if (card.dataset.sig !== html) {
        card.innerHTML = html; card.dataset.sig = html;
        const im = card.querySelector('img');
        if (im) {
          im.addEventListener('error', () => {
            const ph = document.createElement('span');
            ph.className = 'fig-error'; ph.textContent = '资料图片加载失败';
            im.replaceWith(ph); layout();
          });
          if (im.decode) im.decode().then(() => layout()).catch(() => {});
        }
      }
    });
    while (cards.length > total) cards.pop().remove();
    resolveCircuitFrames(canvas, circuitCache).then(() => layout());
    if (dialogs.length) {
      const keep = dialogs.filter(d => cards.includes(d.source));
      if (keep.length !== dialogs.length) {
        dialogs.forEach(d => { if (!keep.includes(d)) { if (d.controller) d.controller.abort(); d.el.remove(); } });
        dialogs = keep;
      }
    }
    layout();
    if (streaming && autoFollow && cards.length > lastCount) followLast();
    lastCount = cards.length;
  }
  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => { renderPending = false; renderBoard(full); }, 90);
  }
  function scheduleScene() {
    if (scenePending) return;
    scenePending = true;
    setTimeout(() => { scenePending = false; updateScene(); }, 90);
  }

  function setStatus(text, live) {
    statusEl.className = 'board-status' + (live ? ' live' : '');
    statusEl.innerHTML = (live ? '<span class="spin"></span>' : '') + esc(text);
  }
  function showEmpty(title, msg, code) {
    emptyEl.querySelector('b').textContent = title;
    emptyEl.querySelector('span').textContent = msg;
    const g = { NO_KEY: ['/settings', '去配置密钥 →'], EMPTY_KB: ['/kb', '去上传资料 →'] }[code];
    if (g) { emptyLink.href = g[0]; emptyLink.textContent = g[1]; emptyLink.hidden = false; }
    else emptyLink.hidden = true;
    emptyEl.style.display = '';
  }

  // ---- click-to-drill Q&A ----
  function openMenu(card) {
    selectedCard = card;
    cards.forEach(c => c.classList.toggle('selected', c === card));
    menu.hidden = false;
    const sr = stage.getBoundingClientRect(), cr = card.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = clamp(cr.left - sr.left + cr.width / 2, mw / 2 + 10, sr.width - mw / 2 - 10);
    menu.style.left = left + 'px';
    if (cr.top - sr.top < mh + 26) {
      menu.style.top = (cr.bottom - sr.top + 12) + 'px';
      menu.style.transform = 'translate(-50%, 0)';
    } else {
      menu.style.top = (cr.top - sr.top - 12) + 'px';
      menu.style.transform = 'translate(-50%, -100%)';
    }
  }
  function closeMenu() { menu.hidden = true; if (selectedCard) selectedCard.classList.remove('selected'); selectedCard = null; }

  function createDialog(source, mode, context) {
    const el = document.createElement('div');
    el.className = 'wb-dialog';
    const snippet = context.slice(0, 40);
    el.innerHTML = `
      <div class="dlg-head">
        <span class="dlg-badge ${mode}">${esc(MODE_LABEL[mode])}</span>
        <span class="dlg-src" title="${esc(context)}">关于：${esc(snippet)}${context.length > 40 ? '…' : ''}</span>
        <button class="dlg-close" title="关闭对话">×</button>
      </div>
      <div class="dlg-thread"></div>
      <div class="dlg-input">
        <input type="text" placeholder="继续追问…" autocomplete="off">
        <button class="dlg-send" title="发送"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>`;
    canvas.appendChild(el);
    const d = { id: ++dialogSeq, el, source, context, mode, history: [], controller: null, streaming: false, x: 0, y: 0 };
    el.style.width = (COL_W - DIALOG_INDENT) + 'px';
    dialogs.push(d);
    el.querySelector('.dlg-close').addEventListener('click', () => removeDialog(d));
    const inp = el.querySelector('.dlg-input input');
    el.querySelector('.dlg-send').addEventListener('click', () => sendFollowUp(d));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') sendFollowUp(d); });
    el.addEventListener('pointerdown', e => e.stopPropagation());
    return d;
  }
  function removeDialog(d) {
    if (d.controller) d.controller.abort();
    d.el.remove();
    dialogs = dialogs.filter(x => x !== d);
    updateScene();
    persistBoard();
  }
  function clearDialogs() { dialogs.forEach(d => { if (d.controller) d.controller.abort(); d.el.remove(); }); dialogs = []; }

  function scrollThread(d) { const t = d.el.querySelector('.dlg-thread'); t.scrollTop = t.scrollHeight; }
  function addUserBubble(d, text) {
    const thread = d.el.querySelector('.dlg-thread');
    const m = document.createElement('div'); m.className = 'msg user';
    m.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
    thread.appendChild(m);
    scrollThread(d); updateScene();
  }
  function sendFollowUp(d) {
    const inp = d.el.querySelector('.dlg-input input');
    const q = inp.value.trim();
    if (!q) return;
    if (d.streaming) { toast('AI 正在回答，请稍候', 'warn'); return; }
    inp.value = '';
    addUserBubble(d, q);
    streamAnswerInto(d, { mode: 'ask', question: q });
  }

  async function streamAnswerInto(d, { mode, question }) {
    if (d.streaming) return;
    d.streaming = true;
    const sendBtn = d.el.querySelector('.dlg-send'); sendBtn.disabled = true;
    const thread = d.el.querySelector('.dlg-thread');
    const aiMsg = document.createElement('div'); aiMsg.className = 'msg ai';
    aiMsg.innerHTML = '<div class="bubble md"><span class="typing"><i></i><i></i><i></i></span></div>';
    thread.appendChild(aiMsg);
    const bubble = aiMsg.querySelector('.bubble');
    scrollThread(d); updateScene();
    let acc = '';
    d.controller = new AbortController();
    const handle = ev => {
      if (ev.type === 'status') bubble.innerHTML = '<span class="dlg-status"><span class="spin"></span>' + esc(ev.message) + '</span>';
      else if (ev.type === 'thinking') bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      else if (ev.type === 'token') { acc += ev.text; bubble.innerHTML = mdToHtml(acc); scrollThread(d); scheduleScene(); }
      else if (ev.type === 'empty') bubble.innerHTML = '<span class="dlg-empty">' + esc(ev.message) + '</span>';
      else if (ev.type === 'done') {
        if (ev.full) acc = ev.full;
        bubble.innerHTML = mdToHtml(acc);
        const kb = (ev.citations || []).map(c => '<span class="chip blue">' + esc(c) + '</span>').join('');
        const web = webCitesHTML(ev.webCitations);
        if (kb || web) bubble.insertAdjacentHTML('beforeend', '<div class="dlg-cites">' + kb + web + '</div>');
        scrollThread(d);
      } else if (ev.type === 'error') bubble.innerHTML = '<span class="dlg-empty">出错：' + esc(ev.message) + '</span>';
    };
    try {
      const r = await fetch('/api/ask/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, context: d.context, mode, question, history: d.history, subject: getSubject(), web: getWeb() }), signal: d.controller.signal });
      await readSSE(r, handle);
    } catch (e) { if (e.name !== 'AbortError') bubble.innerHTML = '<span class="dlg-empty">连接失败：' + esc(e.message) + '</span>'; }
    finally {
      d.streaming = false; d.controller = null; sendBtn.disabled = false;
      if (acc.trim()) d.history.push({ role: 'user', content: question || MODE_LABEL[mode] }, { role: 'assistant', content: acc });
      updateScene();
      persistBoard();
    }
  }

  function startDrill(sourceCard, mode) {
    const context = sourceCard.innerText.replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!context) { toast('这个卡片还没有内容', 'warn'); return; }
    autoFollow = false; $('#followBtn').classList.remove('on'); $('#followBtn span').textContent = '自由浏览';
    const d = createDialog(sourceCard, mode, context);
    updateScene();
    focusDialog(d);
    if (mode === 'ask') {
      d.el.querySelector('.dlg-input input').focus();
    } else {
      addUserBubble(d, MODE_LABEL[mode]);
      streamAnswerInto(d, { mode, question: '' });
    }
  }

  menu.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    const card = selectedCard, mode = b.dataset.mode;
    closeMenu();
    if (card) startDrill(card, mode);
  });

  async function start() {
    const t = input.value.trim();
    if (!t) { toast('请先输入课题', 'warn'); input.focus(); return; }
    if (controller) controller.abort();
    clearDialogs(); closeMenu();
    topic = t; full = ''; cards.forEach(c => c.remove()); cards = []; lastCount = 0;
    lastCites = []; lastWebCites = []; lessonImages = [];
    $('#boardCites').innerHTML = ''; emptyEl.style.display = 'none'; reviewBtn.hidden = true; exportBtn.hidden = true;
    streaming = true; startBtn.disabled = true; setStatus('连接中…', true);
    vw = { x: 40, y: 30, scale: 0.85 }; applyView(false);
    renderBoard('');
    controller = new AbortController();
    const handle = ev => {
      if (ev.type === 'status') setStatus(ev.message, true);
      else if (ev.type === 'thinking') setStatus('AI 思考中…', true);
      else if (ev.type === 'token') { full += ev.text; setStatus('讲解中…', true); scheduleRender(); }
      else if (ev.type === 'empty') { streaming = false; setStatus(ev.message, false); showEmpty('知识库没有相关内容', ev.message, 'EMPTY_KB'); }
      else if (ev.type === 'done') {
        if (ev.full) full = ev.full;
        lessonImages = ev.images || [];
        streaming = false; renderBoard(full);
        setStatus('讲解完成 ✓', false);
        lastCites = ev.citations || []; lastWebCites = ev.webCitations || [];
        $('#boardCites').innerHTML = lastCites.map(c => '<span class="chip blue">' + esc(c) + '</span>').join(' ') + ' ' + webCitesHTML(lastWebCites);
        persistBoard();
        exportBtn.hidden = false;
        reviewBtn.href = '/review?topic=' + encodeURIComponent(topic); reviewBtn.hidden = false;
        fitView(true);
      } else if (ev.type === 'error') {
        streaming = false; setStatus('出错：' + ev.message, false); toast(ev.message, 'err');
        if (ev.code === 'NO_KEY') showEmpty('需要先配置 API 密钥', ev.message, 'NO_KEY');
        else if (ev.code === 'EMPTY_KB') showEmpty('知识库为空', ev.message, 'EMPTY_KB');
      }
    };
    try {
      const r = await fetch('/api/teach/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: t, subject: getSubject(), web: getWeb(), plan: getPlan(t) }), signal: controller.signal });
      await readSSE(r, handle);
    } catch (e) { if (e.name !== 'AbortError') setStatus('连接失败：' + e.message, false); }
    finally { streaming = false; startBtn.disabled = false; }
  }

  // navigation: pan + click-to-select
  let dragging = false, didPan = false, sx = 0, sy = 0, ox = 0, oy = 0;
  vp.addEventListener('pointerdown', e => { closeMenu(); dragging = true; didPan = false; vp.classList.add('grabbing'); vp.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = vw.x; oy = vw.y; canvas.classList.remove('smooth'); });
  vp.addEventListener('pointermove', e => { if (!dragging) return; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 4) didPan = true; vw.x = ox + dx; vw.y = oy + dy; applyView(false); });
  const endDrag = () => { dragging = false; vp.classList.remove('grabbing'); };
  vp.addEventListener('pointerup', e => {
    const wasPan = didPan; endDrag();
    if (wasPan) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const card = t && t.closest ? t.closest('.wb-el') : null;
    if (card && canvas.contains(card)) openMenu(card);
    else closeMenu();
  });
  vp.addEventListener('pointercancel', endDrag);
  vp.addEventListener('wheel', e => { e.preventDefault(); closeMenu(); const r = vp.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });

  $('#zoomIn').addEventListener('click', () => { closeMenu(); const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.18); });
  $('#zoomOut').addEventListener('click', () => { closeMenu(); const r = vp.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.85); });
  $('#zoomFit').addEventListener('click', () => { closeMenu(); fitView(true); });
  $('#zoomReset').addEventListener('click', () => { closeMenu(); vw = { x: 40, y: 30, scale: 0.85 }; applyView(true); });
  $('#followBtn').addEventListener('click', () => { autoFollow = !autoFollow; $('#followBtn').classList.toggle('on', autoFollow); $('#followBtn span').textContent = autoFollow ? '自动跟随' : '自由浏览'; });
  $('#clearBtn').addEventListener('click', () => { if (controller) controller.abort(); streaming = false; full = ''; topic = ''; lessonMaxY = 0; lastCites = []; lastWebCites = []; lessonImages = []; cards.forEach(c => c.remove()); cards = []; clearDialogs(); closeMenu(); lastCount = 0; updateScene(); $('#boardCites').innerHTML = ''; reviewBtn.hidden = true; exportBtn.hidden = true; showEmpty('一块等待开课的白板', '输入课题并点击「开始讲解」，AI 会在这里逐个插入文字框和示意图', null); setStatus('', false); startBtn.disabled = false; });
  exportBtn.addEventListener('click', async () => { if (await exportLessonHTML(topic)) toast('已导出本课 HTML（含白板/追问/笔记）', 'ok'); else toast('没有可导出的本课内容', 'warn'); });
  startBtn.addEventListener('click', start);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });

  const onResize = () => applyView(false);
  window.addEventListener('resize', onResize);
  applyView(false);

  const qTopic = new URLSearchParams(location.search).get('topic');
  if (qTopic) { input.value = qTopic; start(); }

  return () => { leaveGuard = null; if (controller) controller.abort(); dialogs.forEach(d => { if (d.controller) d.controller.abort(); }); window.removeEventListener('resize', onResize); };
}
import { $, esc, toast, postJSON, mdToHtml, blockHtml, webCitesHTML, resolveCircuitFrames, imageFigureHTML } from './util.js';
import { GEO, MODE_LABEL, splitBlocks, makeCardEl, makeWebEl, webHTML, makeDialogEl, layoutScene, createView } from './wb-scene.js';
import { subjectSelectHTML, initSubjectSelect, getSubject } from './subject.js';
import { webToggleHTML, initWebToggle, getWeb } from './web.js';
import { saveBoard, exportLessonHTML, getPlan } from './lesson.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Navigation guard: true while a lesson (or drill answer) is still generating, so
// the router can confirm before aborting the stream and wiping the board.
let leaveGuard = null;
export function isLessonActive() { return leaveGuard ? leaveGuard() : false; }

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
  const scene = createView(canvas, vp, { zval: $('#zval') });
  let autoFollow = true, streaming = false, full = '', topic = '', cards = [], dialogs = [], webEls = [];
  let controller = null, renderPending = false, scenePending = false, lastCount = 0, dialogSeq = 0;
  let selectedCard = null;
  let lastCites = [], lastWebCites = [];
  let lessonImages = [];
  let sessionId = null, histTimer = null, histWarned = false;
  leaveGuard = () => streaming || dialogs.some(d => d.streaming);

  function snapshotDialogs() {
    return dialogs.filter(d => d.history && d.history.length).map(d => ({ context: d.context, mode: d.mode, history: d.history }));
  }
  function persistBoard() {
    if (!topic || !full.trim()) return;
    const board = { full, citations: lastCites, webCitations: lastWebCites, dialogs: snapshotDialogs(), images: lessonImages };
    saveBoard(topic, board);
    // Debounced archive to the backend history dir; snapshot captured now so a
    // later clear/new-lesson cannot mutate what this pending save writes.
    const snap = { id: sessionId, topic, board };
    if (histTimer) clearTimeout(histTimer);
    histTimer = setTimeout(() => {
      histTimer = null;
      postJSON('/api/history/save', snap).catch(() => {
        if (!histWarned) { histWarned = true; toast('历史自动保存失败（不影响本课）', 'warn'); }
      });
    }, 600);
  }

  function followLast() {
    const card = cards[cards.length - 1]; if (!card) return;
    const r = vp.getBoundingClientRect(), vw = scene.vw;
    const cx = parseFloat(card.style.left) + card.offsetWidth / 2;
    const cy = parseFloat(card.style.top) + card.offsetHeight / 2;
    const sx = cx * vw.scale + vw.x, sy = cy * vw.scale + vw.y;
    if (sx < 100 || sx > r.width - 100 || sy < 100 || sy > r.height - 100) {
      scene.panTo(r.width * 0.5 - cx * vw.scale, r.height * 0.55 - cy * vw.scale, true);
    }
  }
  function focusDialog(d) { scene.focusEl(d.el, { minScale: 0.85, cy: 0.42, oy: 60 }); }

  function updateScene() { layout(); }

  function layout() {
    const b = layoutScene({ cards, dialogs, web: webEls, canvas, links });
    scene.setBounds(b);
  }

  const circuitCache = {};
  function renderBoard(text) {
    const { main, web } = splitBlocks(text);
    const mainBlocks = topic ? [{ type: 'title', text: topic, isTopic: true }, ...main] : main;
    mainBlocks.forEach((b, i) => {
      let card = cards[i];
      if (card && card.dataset.type !== b.type) { card.remove(); card = null; }
      if (!card) { card = makeCardEl(b, circuitCache); canvas.appendChild(card); cards[i] = card; return; }
      const html = blockHtml(b, circuitCache);
      if (card.dataset.sig !== html) { card.innerHTML = html; card.dataset.sig = html; }
    });
    const total = mainBlocks.length + lessonImages.length;
    lessonImages.forEach((img, k) => {
      const i = mainBlocks.length + k;
      let card = cards[i];
      if (!card) { card = document.createElement('div'); canvas.appendChild(card); cards[i] = card; }
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

    web.forEach((b, k) => {
      const source = cards[cards.length - 1] || cards[0] || null;
      let w = webEls[k];
      if (!w) { const el = makeWebEl(b, lastWebCites); canvas.appendChild(el); w = { el, source }; webEls[k] = w; return; }
      w.source = source;
      const html = webHTML(b, lastWebCites);
      if (w.el.dataset.sig !== html) { w.el.innerHTML = html; w.el.dataset.sig = html; }
    });
    while (webEls.length > web.length) webEls.pop().el.remove();

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
    const d = { id: ++dialogSeq, el: null, source, context, mode, history: [], controller: null, streaming: false, x: 0, y: 0 };
    const el = makeDialogEl(d, { readOnly: false });
    d.el = el;
    el.style.width = GEO.SIDE_W + 'px';
    canvas.appendChild(el);
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
    webEls.forEach(w => w.el.remove()); webEls = [];
    lastCites = []; lastWebCites = []; lessonImages = [];
    sessionId = crypto.randomUUID(); histWarned = false;
    $('#boardCites').innerHTML = ''; emptyEl.style.display = 'none'; reviewBtn.hidden = true; exportBtn.hidden = true;
    streaming = true; startBtn.disabled = true; setStatus('连接中…', true);
    scene.reset(false);
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
        lastCites = ev.citations || []; lastWebCites = ev.webCitations || [];
        streaming = false; renderBoard(full);
        setStatus('讲解完成 ✓', false);
        $('#boardCites').innerHTML = lastCites.map(c => '<span class="chip blue">' + esc(c) + '</span>').join(' ') + ' ' + webCitesHTML(lastWebCites);
        persistBoard();
        exportBtn.hidden = false;
        reviewBtn.href = '/review?topic=' + encodeURIComponent(topic); reviewBtn.hidden = false;
        scene.fitView(true);
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
  vp.addEventListener('pointerdown', e => { closeMenu(); window.getSelection().removeAllRanges(); dragging = true; didPan = false; vp.classList.add('grabbing'); vp.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = scene.vw.x; oy = scene.vw.y; canvas.classList.remove('smooth'); });
  vp.addEventListener('dragstart', e => e.preventDefault());
  vp.addEventListener('pointermove', e => { if (!dragging) return; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 4) didPan = true; scene.panTo(ox + dx, oy + dy, false); });
  const endDrag = () => { dragging = false; vp.classList.remove('grabbing'); };
  vp.addEventListener('pointerup', e => {
    const wasPan = didPan; endDrag();
    if (wasPan) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const card = t && t.closest ? t.closest('.wb-el') : null;
    if (card && canvas.contains(card) && !card.classList.contains('wb-web')) openMenu(card);
    else closeMenu();
  });
  vp.addEventListener('pointercancel', endDrag);
  vp.addEventListener('wheel', e => { e.preventDefault(); closeMenu(); const r = vp.getBoundingClientRect(); scene.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });

  $('#zoomIn').addEventListener('click', () => { closeMenu(); const r = vp.getBoundingClientRect(); scene.zoomAt(r.width / 2, r.height / 2, 1.18); });
  $('#zoomOut').addEventListener('click', () => { closeMenu(); const r = vp.getBoundingClientRect(); scene.zoomAt(r.width / 2, r.height / 2, 0.85); });
  $('#zoomFit').addEventListener('click', () => { closeMenu(); scene.fitView(true); });
  $('#zoomReset').addEventListener('click', () => { closeMenu(); scene.reset(true); });
  $('#followBtn').addEventListener('click', () => { autoFollow = !autoFollow; $('#followBtn').classList.toggle('on', autoFollow); $('#followBtn span').textContent = autoFollow ? '自动跟随' : '自由浏览'; });
  $('#clearBtn').addEventListener('click', () => { if (controller) controller.abort(); streaming = false; full = ''; topic = ''; lastCites = []; lastWebCites = []; lessonImages = []; cards.forEach(c => c.remove()); cards = []; webEls.forEach(w => w.el.remove()); webEls = []; clearDialogs(); closeMenu(); lastCount = 0; updateScene(); $('#boardCites').innerHTML = ''; reviewBtn.hidden = true; exportBtn.hidden = true; showEmpty('一块等待开课的白板', '输入课题并点击「开始讲解」，AI 会在这里逐个插入文字框和示意图', null); setStatus('', false); startBtn.disabled = false; });
  exportBtn.addEventListener('click', async () => { if (await exportLessonHTML(topic)) toast('已导出本课 HTML（含白板/追问/笔记）', 'ok'); else toast('没有可导出的本课内容', 'warn'); });
  startBtn.addEventListener('click', start);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });

  const onResize = () => scene.applyView(false);
  window.addEventListener('resize', onResize);
  scene.applyView(false);

  const qTopic = new URLSearchParams(location.search).get('topic');
  if (qTopic) { input.value = qTopic; start(); }

  return () => { leaveGuard = null; if (controller) controller.abort(); dialogs.forEach(d => { if (d.controller) d.controller.abort(); }); window.removeEventListener('resize', onResize); };
}
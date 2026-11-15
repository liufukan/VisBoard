import { $, esc, toast, getJSON, delJSON, fmtDate, confirmModal, resolveCircuitFrames, imageFigureHTML } from './util.js';
import { splitBlocks, makeCardEl, makeWebEl, makeDialogEl, layoutScene, createView } from './wb-scene.js';
import { exportSnapshotHTML } from './lesson.js';

const CLOCK_IC = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function mount(view) {
  let cleanupViewer = null;

  function teardownViewer() {
    if (cleanupViewer) { try { cleanupViewer(); } catch {} cleanupViewer = null; }
  }

  async function doExport(rec) {
    const ok = await exportSnapshotHTML(rec.topic, rec.board, null, rec.savedAt);
    toast(ok ? '已导出该课 HTML（含白板/追问），可分享' : '该记录没有可导出的内容', ok ? 'ok' : 'warn');
  }

  async function doDelete(rec, after) {
    const yes = await confirmModal({
      title: '删除这条历史？',
      body: `「${rec.topic}」的白板快照与追问记录将被永久删除，无法恢复。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!yes) return;
    try {
      await delJSON('/api/history/' + encodeURIComponent(rec.id));
      toast('已删除历史记录', 'ok');
      after();
    } catch (e) { toast('删除失败：' + e.message, 'err'); }
  }

  function showList() {
    teardownViewer();
    view.classList.remove('view-board');
    view.innerHTML = `
      <div class="page-head">
        <span class="eyebrow">History</span>
        <h1>历史记录</h1>
        <p>每次白板讲课都会自动保存为一条记录（含追问对话）。可随时只读回顾或导出 HTML 分享，不会继续讲课。</p>
      </div>
      <div class="hist-list" id="histList"><div class="empty">加载中…</div></div>`;
    const listEl = $('#histList');
    getJSON('/api/history/list').then(d => {
      const recs = d.records || [];
      if (!recs.length) {
        listEl.innerHTML = '<div class="empty">暂无历史记录。去「白板讲解」上一课，结束后会自动保存到这里。</div>';
        return;
      }
      listEl.innerHTML = recs.map(r => `
        <div class="hist-row" data-id="${esc(r.id)}">
          <div class="hist-ic">${CLOCK_IC}</div>
          <div class="hist-info">
            <div class="nm">${esc(r.topic || '（未命名课题）')}</div>
            <div class="ds"><span>${esc(fmtDate(r.savedAt))}</span><span class="hist-badge">追问 ${r.dialogCount || 0}</span></div>
          </div>
          <div class="hist-actions">
            <button class="btn sm" data-act="view">查看</button>
            <button class="btn ghost sm" data-act="export">导出 HTML</button>
            <button class="btn ghost sm" data-act="del">删除</button>
          </div>
        </div>`).join('');
      listEl.onclick = async e => {
        const btn = e.target.closest('button[data-act]'); if (!btn) return;
        const row = btn.closest('.hist-row'); const id = row.dataset.id;
        const meta = recs.find(x => x.id === id);
        if (btn.dataset.act === 'view') {
          try { showViewer(await getJSON('/api/history/' + encodeURIComponent(id))); }
          catch (err) { toast('打开记录失败：' + err.message, 'err'); }
        } else if (btn.dataset.act === 'export') {
          try { await doExport(await getJSON('/api/history/' + encodeURIComponent(id))); }
          catch (err) { toast('导出失败：' + err.message, 'err'); }
        } else if (btn.dataset.act === 'del') {
          await doDelete(meta, showList);
        }
      };
    }).catch(e => { listEl.innerHTML = '<div class="empty">加载历史失败：' + esc(e.message) + '</div>'; });
  }

  function showViewer(rec) {
    teardownViewer();
    view.classList.add('view-board');
    const board = rec.board || {};
    view.innerHTML = `
      <div class="hist-top">
        <button class="btn ghost sm" id="histBack">← 返回</button>
        <span class="hist-title" title="${esc(rec.topic)}">${esc(rec.topic)}</span>
        <span class="hist-sub">${esc(fmtDate(rec.savedAt))}</span>
        <span class="hist-ro">只读回顾</span>
        <span class="hist-spacer"></span>
        <button class="btn ghost sm" id="histExport">导出 HTML</button>
      </div>
      <div class="board-stage" id="histStage">
        <div class="board-viewport" id="histViewport">
          <div class="board-canvas" id="histCanvas"><svg class="wb-links" id="histLinks" xmlns="http://www.w3.org/2000/svg"></svg></div>
        </div>
        <div class="zoom-cluster">
          <button id="hZoomOut" title="缩小"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14" stroke-linecap="round"/></svg></button>
          <span class="zval" id="hZval">100%</span>
          <button id="hZoomIn" title="放大"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg></button>
          <button id="hZoomFit" title="适应窗口"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button id="hZoomReset" title="重置视图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114-3M20 14a8 8 0 01-14 3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>
      </div>`;
    $('#histBack').addEventListener('click', showList);
    $('#histExport').addEventListener('click', () => doExport(rec));

    const vp = $('#histViewport'), canvas = $('#histCanvas'), links = $('#histLinks');
    const scene = createView(canvas, vp, { zval: $('#hZval') });
    const circuitCache = {};
    const cards = [], dialogs = [], webEls = [];
    function layout() { scene.setBounds(layoutScene({ cards, dialogs, web: webEls, canvas, links })); }

    const { main, web } = splitBlocks(board.full || '');
    [{ type: 'title', text: rec.topic, isTopic: true }, ...main].forEach(b => {
      const el = makeCardEl(b, circuitCache); canvas.appendChild(el); cards.push(el);
    });
    (board.images || []).forEach(img => {
      const el = document.createElement('div');
      el.className = 'wb-el wb-card wb-figure'; el.dataset.type = 'image';
      el.innerHTML = imageFigureHTML(img, img.url);
      canvas.appendChild(el); cards.push(el);
      const im = el.querySelector('img');
      if (im) {
        im.addEventListener('error', () => {
          const ph = document.createElement('span'); ph.className = 'fig-error'; ph.textContent = '资料图片加载失败';
          im.replaceWith(ph); layout();
        });
        if (im.decode) im.decode().then(() => layout()).catch(() => {});
      }
    });
    web.forEach(b => {
      const el = makeWebEl(b, board.webCitations); canvas.appendChild(el);
      webEls.push({ el, source: cards[cards.length - 1] || cards[0] || null });
    });
    // Dialogs store only their source snippet; re-attach to the matching card so
    // the dashed branch lands on the same rail as during the live lesson.
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    (board.dialogs || []).forEach(d => {
      const ctx = norm(d.context);
      const source = cards.find(c => norm(c.innerText).startsWith(ctx)) || cards[cards.length - 1] || null;
      const el = makeDialogEl(d, { readOnly: true }); canvas.appendChild(el);
      dialogs.push({ el, source, context: d.context, mode: d.mode, history: d.history });
    });
    layout();
    resolveCircuitFrames(canvas, circuitCache).then(() => layout());
    scene.fitView(false);

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    const down = e => { window.getSelection().removeAllRanges(); dragging = true; vp.classList.add('grabbing'); vp.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = scene.vw.x; oy = scene.vw.y; canvas.classList.remove('smooth'); };
    const move = e => { if (!dragging) return; scene.panTo(ox + e.clientX - sx, oy + e.clientY - sy, false); };
    const up = () => { dragging = false; vp.classList.remove('grabbing'); };
    const wheel = e => {
      const th = e.target.closest && e.target.closest('.dlg-thread');
      if (th && th.scrollHeight > th.clientHeight) return; // let long threads scroll
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      scene.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 0.89);
    };
    vp.addEventListener('pointerdown', down);
    vp.addEventListener('dragstart', e => e.preventDefault());
    vp.addEventListener('pointermove', move);
    vp.addEventListener('pointerup', up);
    vp.addEventListener('pointercancel', up);
    vp.addEventListener('wheel', wheel, { passive: false });
    $('#hZoomIn').addEventListener('click', () => { const r = vp.getBoundingClientRect(); scene.zoomAt(r.width / 2, r.height / 2, 1.18); });
    $('#hZoomOut').addEventListener('click', () => { const r = vp.getBoundingClientRect(); scene.zoomAt(r.width / 2, r.height / 2, 0.85); });
    $('#hZoomFit').addEventListener('click', () => scene.fitView(true));
    $('#hZoomReset').addEventListener('click', () => scene.reset(true));
    const onResize = () => scene.applyView(false);
    window.addEventListener('resize', onResize);
    cleanupViewer = () => { window.removeEventListener('resize', onResize); };
  }

  showList();
  return teardownViewer;
}
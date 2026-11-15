import { $, esc, getJSON, postJSON, delJSON, toast, fmtDate, refreshConn, confirmModal } from './util.js';

const ACCEPT = '.txt,.md,.pdf,.docx,.pptx,.png,.jpg,.jpeg';

export function mount(view) {
  view.innerHTML = `
    <div class="page-head">
      <span class="eyebrow">Knowledge Base</span>
      <h1>知识库</h1>
      <p>上传课件搭建知识库，按科目分区。AI 以所选科目的资料为主教学，检索更快更准。</p>
    </div>
    <div class="card subj-card">
      <div class="subj-head"><h2>科目分区</h2><span class="hint">每门科目一个分区；删除科目后，其资料归入「未分区」。</span></div>
      <div class="subj-chips" id="subjChips"></div>
      <div class="subj-add">
        <input type="text" id="subjName" placeholder="新科目名，如：计算机原理" maxlength="40">
        <button class="btn sm" id="subjAddBtn">新建科目</button>
      </div>
    </div>
    <div class="kb-layout">
      <div class="card">
        <h2>上传资料</h2>
        <p class="sub">支持 PDF / txt / md / docx / pptx / 图片；扫描版 PDF 与图片上传后点「OCR 识别」回填文字。</p>
        <label class="subj-pick">上传到科目<select id="uploadSubject" class="subj-select"></select></label>
        <div class="dropzone" id="dropzone">
          <div class="dz-ic"><svg viewBox="0 0 24 24"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
          <b>拖拽文件到此处，或点击选择</b>
          <span class="hint">可多选 · 单个 ≤ 200MB</span>
          <input type="file" id="fileInput" multiple accept="${ACCEPT}" hidden>
        </div>
        <div class="upload-results" id="uploadResults"></div>
      </div>

      <div class="card">
        <div class="kb-toolbar">
          <label class="kb-select-all"><input type="checkbox" id="kbSelectAll">全选</label>
          <input type="search" id="kbSearch" placeholder="搜索资料名…">
          <select id="kbFilter" class="subj-select" title="按科目筛选"></select>
          <select id="kbSort">
            <option value="new">最新优先</option>
            <option value="name">按名称</option>
            <option value="chars">按字数</option>
          </select>
          <span class="kb-count" id="kbCount"></span>
        </div>
        <div class="kb-bulk" id="kbBulk" hidden>
          <span class="bulk-count" id="bulkCount">已选 0 份</span>
          <label>移动到<select id="bulkSubject" class="subj-select"></select></label>
          <button class="btn sm" id="bulkMoveBtn">应用</button>
          <button class="btn ghost sm" id="bulkImgBtn">补提取图片</button>
          <span class="bulk-spacer"></span>
          <button class="btn ghost sm" id="bulkClearBtn">取消选择</button>
          <button class="btn danger sm" id="bulkDelBtn">删除</button>
        </div>
        <div class="doc-list" id="docList"><div class="empty">加载中…</div></div>
      </div>
    </div>`;

  let docs = [], subjects = [];
  const selected = new Set();
  const dz = $('#dropzone'), fi = $('#fileInput');
  const uploadSel = $('#uploadSubject'), filterSel = $('#kbFilter');

  function subjectOptions(selected, includeAll) {
    let html = includeAll ? '<option value="all">全部科目</option>' : '<option value="">未分区</option>';
    html += subjects.map(s => `<option value="${esc(s.id)}"${selected === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    if (includeAll) html += `<option value="none"${selected === 'none' ? ' selected' : ''}>未分区</option>`;
    return html;
  }

  function renderSubjects() {
    $('#subjChips').innerHTML = subjects.length
      ? subjects.map(s => {
          const n = docs.filter(d => d.subject === s.id).length;
          return `<span class="subj-chip">${esc(s.name)}<em>${n}</em><button class="subj-del" data-del-subj="${esc(s.id)}" title="删除科目">×</button></span>`;
        }).join('')
      : '<span class="hint">还没有科目，先新建一个，再上传资料到该科目。</span>';
    const upCur = uploadSel.value;
    uploadSel.innerHTML = subjectOptions(upCur, false);
    const fCur = filterSel.value || 'all';
    filterSel.innerHTML = subjectOptions(fCur, true);
    const bulkSel = $('#bulkSubject'), bCur = bulkSel.value;
    bulkSel.innerHTML = subjectOptions(bCur, false);
  }

  async function loadSubjects() {
    try { subjects = (await getJSON('/api/subjects')).subjects || []; }
    catch { subjects = []; }
    renderSubjects();
    renderList();
  }

  async function load() {
    try { docs = (await getJSON('/api/kb')).docs || []; }
    catch (e) { toast(e.message, 'err'); docs = []; }
    const live = new Set(docs.map(d => d.id));
    [...selected].forEach(id => { if (!live.has(id)) selected.delete(id); });
    renderSubjects();
    renderList();
  }

  function renderList() {
    const q = $('#kbSearch').value.trim().toLowerCase();
    const sort = $('#kbSort').value;
    const filter = filterSel.value || 'all';
    let list = docs.filter(d => d.name.toLowerCase().includes(q));
    if (filter !== 'all') list = list.filter(d => filter === 'none' ? d.subject == null : d.subject === filter);
    list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'chars' ? b.chars - a.chars : b.createdAt - a.createdAt);
    $('#kbCount').textContent = list.length + ' / ' + docs.length + ' 份';
    const box = $('#docList');
    if (!list.length) {
      box.innerHTML = '<div class="empty">' + (docs.length ? '没有匹配的资料' : '知识库为空，先上传资料吧') + '</div>';
      updateSelectAll(); syncBulk(); return;
    }
    box.innerHTML = list.map(d => `
      <div class="doc-row${selected.has(d.id) ? ' selected' : ''}">
        <input type="checkbox" class="doc-check" data-id="${esc(d.id)}"${selected.has(d.id) ? ' checked' : ''} title="选择以批量操作">
        <div class="doc-ic ${esc(d.kind)}">${esc(d.kind)}</div>
        <div class="doc-info">
          <div class="nm">${esc(d.name)}</div>
          <div class="ds">${d.chars} 字 · ${d.pages} 页 · ${d.chunks} 块 · ${d.imageCount || 0} 图 · ${fmtDate(d.createdAt)}</div>
        </div>
        <select class="subj-select doc-subj" data-id="${esc(d.id)}" title="改归属科目">${subjectOptions(d.subject, false)}</select>
        <button class="btn ghost sm doc-img" data-id="${esc(d.id)}">补提取图片</button>
        ${d.scanned ? `<button class="btn ghost sm doc-ocr" data-id="${esc(d.id)}" title="本地 OCR 识别扫描文字，较慢">OCR 识别</button>` : ''}
        <button class="btn ghost sm doc-del" data-id="${esc(d.id)}">删除</button>
      </div>`).join('');
    updateSelectAll(); syncBulk();
  }

  function updateSelectAll() {
    const checks = [...$('#docList').querySelectorAll('.doc-check')];
    const sa = $('#kbSelectAll');
    const checked = checks.filter(c => c.checked).length;
    sa.disabled = checks.length === 0;
    sa.checked = checks.length > 0 && checked === checks.length;
    sa.indeterminate = checked > 0 && checked < checks.length;
  }

  function syncBulk() {
    const n = selected.size;
    $('#kbBulk').hidden = n === 0;
    $('#bulkCount').textContent = '已选 ' + n + ' 份';
  }

  function setBulkBusy(on) {
    ['#bulkMoveBtn', '#bulkImgBtn', '#bulkDelBtn', '#bulkClearBtn', '#bulkSubject', '#kbSelectAll']
      .forEach(s => { const el = $(s); if (el) el.disabled = on; });
    $('#docList').querySelectorAll('.doc-check').forEach(c => { c.disabled = on; });
  }

  async function bulkRun(kind) {
    const ids = [...selected];
    if (!ids.length) return;
    const labels = { move: '移动', images: '补提取图片', delete: '删除' };
    if (kind === 'delete') {
      const yes = await confirmModal({
        title: '删除选中的 ' + ids.length + ' 份资料？',
        body: '这些资料及其切块、图片将被永久删除，无法恢复。',
        confirmText: '删除', danger: true
      });
      if (!yes) return;
    }
    const target = kind === 'move' ? ($('#bulkSubject').value || null) : null;
    setBulkBusy(true);
    let ok = 0, fail = 0;
    for (let i = 0; i < ids.length; i++) {
      $('#bulkCount').textContent = labels[kind] + '中 ' + (i + 1) + '/' + ids.length;
      const id = ids[i];
      try {
        if (kind === 'move') await postJSON('/api/kb/' + encodeURIComponent(id) + '/subject', { subject: target });
        else if (kind === 'images') await postJSON('/api/kb/' + encodeURIComponent(id) + '/images', {});
        else await delJSON('/api/kb/' + encodeURIComponent(id));
        ok++;
      } catch { fail++; }
    }
    setBulkBusy(false);
    selected.clear();
    await load();
    refreshConn();
    toast(labels[kind] + '完成：成功 ' + ok + ' 份' + (fail ? '，失败 ' + fail + ' 份' : ''), fail ? 'warn' : 'ok');
  }

  async function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (uploadSel.value) fd.append('subject', uploadSel.value);
    const box = $('#uploadResults');
    box.innerHTML = '<div class="up-item"><span class="st">…</span><div><div class="nm">解析中</div><div class="ds">' + files.length + ' 个文件…</div></div></div>';
    try {
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) throw new Error('服务器返回异常(HTTP ' + r.status + '),请检查文件大小或稍后重试');
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('上传失败(HTTP ' + r.status + ')'));
      box.innerHTML = (d.results || []).map(it => it.error
        ? `<div class="up-item err"><span class="st">✕</span><div><div class="nm">${esc(it.name)}</div><div class="ds">${esc(it.error)}</div></div></div>`
        : `<div class="up-item ok"><span class="st">✓</span><div><div class="nm">${esc(it.name)}</div><div class="ds">${it.kind} · ${it.chars} 字 · ${it.pages} 页 · ${it.chunks} 块</div></div></div>`).join('');
      const ok = (d.results || []).filter(x => !x.error).length;
      toast(ok ? '成功导入 ' + ok + ' 份资料' : '没有导入任何资料', ok ? 'ok' : 'warn');
      load(); refreshConn();
    } catch (e) {
      box.innerHTML = '<div class="up-item err"><span class="st">✕</span><div><div class="nm">上传失败</div><div class="ds">' + esc(e.message) + '</div></div></div>';
      toast('上传失败:' + e.message, 'err');
    }
  }

  async function addSubject() {
    const inp = $('#subjName'), name = inp.value.trim();
    if (!name) { toast('请输入科目名', 'warn'); inp.focus(); return; }
    try {
      await postJSON('/api/subjects', { name });
      inp.value = '';
      toast('已新建科目「' + name + '」', 'ok');
      await loadSubjects();
    } catch (e) { toast(e.message, 'err'); }
  }

  $('#subjAddBtn').addEventListener('click', addSubject);
  $('#subjName').addEventListener('keydown', e => { if (e.key === 'Enter') addSubject(); });
  $('#subjChips').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del-subj]'); if (!btn) return;
    const s = subjects.find(x => x.id === btn.dataset.delSubj);
    if (!confirm('删除科目「' + (s ? s.name : '') + '」？其资料会归入「未分区」，不会被删除。')) return;
    try { await delJSON('/api/subjects/' + encodeURIComponent(btn.dataset.delSubj)); toast('已删除科目', 'ok'); await loadSubjects(); load(); }
    catch (err) { toast(err.message, 'err'); }
  });

  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { upload([...fi.files]); fi.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => upload([...e.dataTransfer.files]));

  $('#kbSearch').addEventListener('input', renderList);
  $('#kbSort').addEventListener('change', renderList);
  filterSel.addEventListener('change', renderList);
  $('#kbSelectAll').addEventListener('change', e => {
    const on = e.target.checked;
    e.target.indeterminate = false;
    $('#docList').querySelectorAll('.doc-check').forEach(c => {
      c.checked = on;
      if (on) selected.add(c.dataset.id); else selected.delete(c.dataset.id);
      c.closest('.doc-row').classList.toggle('selected', on);
    });
    syncBulk();
  });
  $('#bulkMoveBtn').addEventListener('click', () => bulkRun('move'));
  $('#bulkImgBtn').addEventListener('click', () => bulkRun('images'));
  $('#bulkDelBtn').addEventListener('click', () => bulkRun('delete'));
  $('#bulkClearBtn').addEventListener('click', () => { selected.clear(); renderList(); });
  $('#docList').addEventListener('change', async e => {
    const chk = e.target.closest('.doc-check');
    if (chk) {
      const id = chk.dataset.id;
      if (chk.checked) selected.add(id); else selected.delete(id);
      chk.closest('.doc-row').classList.toggle('selected', chk.checked);
      updateSelectAll(); syncBulk();
      return;
    }
    const sel = e.target.closest('.doc-subj'); if (!sel) return;
    const id = sel.dataset.id, subject = sel.value || null;
    try {
      await postJSON('/api/kb/' + encodeURIComponent(id) + '/subject', { subject });
      const doc = docs.find(d => d.id === id); if (doc) doc.subject = subject;
      toast('已更新归属', 'ok'); renderSubjects();
    } catch (err) { toast(err.message, 'err'); load(); }
  });
  $('#docList').addEventListener('click', async e => {
    const imgBtn = e.target.closest('.doc-img');
    if (imgBtn) {
      imgBtn.disabled = true;
      try {
        const r = await postJSON('/api/kb/' + encodeURIComponent(imgBtn.dataset.id) + '/images', {});
        toast('已提取 ' + (r.count || 0) + ' 张图片', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); imgBtn.disabled = false; }
      return;
    }
    const ocrBtn = e.target.closest('.doc-ocr');
    if (ocrBtn) {
      ocrBtn.disabled = true; const old = ocrBtn.textContent; ocrBtn.textContent = '识别中…';
      try {
        const r = await postJSON('/api/kb/' + encodeURIComponent(ocrBtn.dataset.id) + '/ocr', {});
        toast(r.ocrPages ? ('识别 ' + r.ocrPages + ' 页（' + r.chars + ' 字）' + (r.truncated ? '，已识别前 50 页' : '')) : '识别完成但结果为空（可能图质差）', r.ocrPages ? 'ok' : 'warn');
        load();
      } catch (err) { toast(err.message, 'err'); ocrBtn.disabled = false; ocrBtn.textContent = old; }
      return;
    }
    const btn = e.target.closest('.doc-del');
    if (!btn) return;
    const doc = docs.find(d => d.id === btn.dataset.id);
    if (!confirm('确定删除「' + (doc ? doc.name : '') + '」?其切块会一并移除。')) return;
    btn.disabled = true;
    try { await delJSON('/api/kb/' + encodeURIComponent(btn.dataset.id)); toast('已删除', 'ok'); load(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });

  loadSubjects();
  load();
  return null;
}
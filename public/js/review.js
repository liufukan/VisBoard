import { $, esc, postJSON, toast, mdToHtml, readSSE, guideLink, webCitesHTML } from './util.js';
import { subjectSelectHTML, initSubjectSelect, getSubject } from './subject.js';
import { webToggleHTML, initWebToggle, getWeb } from './web.js';
import { saveNotes, exportLessonHTML, getLesson } from './lesson.js';

const OPT_KEY = ['A', 'B', 'C', 'D', 'E', 'F'];
const TYPE_LABEL = { single: '单选', multi: '多选', judge: '判断', blank: '填空', short: '简答' };
const initAnswer = q => (q.type === 'multi' ? [] : q.type === 'blank' || q.type === 'short' ? '' : null);
const isAnswered = (q, a) => (q.type === 'multi' ? a.length > 0 : q.type === 'blank' || q.type === 'short' ? String(a).trim() !== '' : a !== null);
const normBlank = s => String(s).toLowerCase().replace(/\s+/g, '');
function gradeObjective(q, a) {
  if (q.type === 'single' || q.type === 'judge') return a === q.answer;
  if (q.type === 'multi') {
    const set = new Set(q.answer);
    return a.length === set.size && a.every(x => set.has(x));
  }
  if (q.type === 'blank') return q.answer.some(acc => normBlank(acc) === normBlank(a));
  return false;
}
const emptyHtml = (msg, code) => {
  const link = guideLink(code);
  return '<div class="empty">' + esc(msg) + (link ? '<div class="empty-act">' + link + '</div>' : '') + '</div>';
};

export function mount(view) {
  view.innerHTML = `
    <div class="page-head">
      <span class="eyebrow">Review · Quiz · Re-teach</span>
      <h1>笔记 · 小测 · 再讲</h1>
      <p>学完一节课，让 AI 只依据你的知识库整理复习笔记、出一组小测；答错的知识点就地再讲，直到弄懂。</p>
    </div>
    <div class="review-bar">
      ${subjectSelectHTML()}
      ${webToggleHTML()}
      <input type="text" id="rvTopic" placeholder="输入课题，例如：中断系统">
      <button class="btn" id="rvNotesBtn">生成笔记</button>
      <button class="btn ghost" id="rvQuizBtn">开始小测</button>
      <span class="board-status" id="rvStatus"></span>
    </div>
    <div class="rv-tabs">
      <button class="rv-tab active" data-tab="notes">复习笔记</button>
      <button class="rv-tab" data-tab="quiz">课堂小测</button>
    </div>
    <div class="rv-panel" id="rvNotesPanel">
      <div class="card">
        <div class="rv-notes-head">
          <h2>复习笔记</h2>
          <div class="rv-notes-actions">
            <button class="btn ghost sm" id="rvCopy" disabled>复制</button>
            <button class="btn ghost sm" id="rvExport" disabled>导出 .md</button>
            <button class="btn ghost sm" id="rvExportLesson" disabled>导出本课 HTML</button>
          </div>
        </div>
        <div class="rv-notes-body md" id="rvNotesBody"><div class="empty">输入课题并点击「生成笔记」，AI 会依据知识库整理一份精炼的复习笔记。</div></div>
        <div class="rv-cites" id="rvNotesCites"></div>
      </div>
    </div>
    <div class="rv-panel" id="rvQuizPanel" hidden>
      <div class="card">
        <div class="rv-quiz-head">
          <h2>课堂小测</h2>
          <div class="rv-quiz-ctrl">
            <label class="meta" for="rvCount">题数</label>
            <select id="rvCount"><option>3</option><option selected>4</option><option>5</option><option>6</option></select>
            <button class="btn sm" id="rvGenQuiz">出题</button>
          </div>
        </div>
        <div id="rvQuizBody"><div class="empty">点击「出题」，AI 会依据知识库出一组混合题型小测（单选 / 多选 / 判断 / 填空 / 简答）；提交后自动批改，答错的知识点可以「再讲一遍」。</div></div>
      </div>
    </div>`;

  const topicInput = $('#rvTopic'), statusEl = $('#rvStatus');
  const notesBtn = $('#rvNotesBtn'), quizBtn = $('#rvQuizBtn');
  const notesBody = $('#rvNotesBody'), notesCites = $('#rvNotesCites');
  const copyBtn = $('#rvCopy'), exportBtn = $('#rvExport'), exportLessonBtn = $('#rvExportLesson');
  const quizBody = $('#rvQuizBody'), countSel = $('#rvCount'), genQuizBtn = $('#rvGenQuiz');
  initSubjectSelect($('#subjSelect'));
  initWebToggle($('#webToggle'));

  function updateExportLessonBtn() {
    const t = topicInput.value.trim();
    exportLessonBtn.disabled = !(t && getLesson(t));
  }

  let notesFull = '', notesStreaming = false, notesController = null;
  let quizLoading = false, quizController = null;
  let questions = [], answers = [], results = [], graded = false, grading = false;
  const reteachControllers = new Map();

  function setStatus(text, live) {
    statusEl.className = 'board-status' + (live ? ' live' : '');
    statusEl.innerHTML = (live ? '<span class="spin"></span>' : '') + esc(text);
  }
  function getTopic() {
    const t = topicInput.value.trim();
    if (!t) { toast('请先输入课题', 'warn'); topicInput.focus(); }
    return t;
  }
  function switchTab(name) {
    view.querySelectorAll('.rv-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $('#rvNotesPanel').hidden = name !== 'notes';
    $('#rvQuizPanel').hidden = name !== 'quiz';
  }

  // ---- notes ----
  async function genNotes() {
    const topic = getTopic(); if (!topic) return;
    if (notesController) notesController.abort();
    switchTab('notes');
    notesFull = ''; notesStreaming = true; notesController = new AbortController();
    notesBtn.disabled = true; copyBtn.disabled = true; exportBtn.disabled = true;
    notesCites.innerHTML = ''; notesBody.innerHTML = '<div class="rv-loading"><span class="spin"></span>正在依据知识库整理笔记…</div>';
    setStatus('整理笔记中…', true);
    const handle = ev => {
      if (ev.type === 'status') setStatus(ev.message, true);
      else if (ev.type === 'thinking') setStatus('AI 思考中…', true);
      else if (ev.type === 'token') { notesFull += ev.text; notesBody.innerHTML = mdToHtml(notesFull); notesBody.scrollTop = notesBody.scrollHeight; }
      else if (ev.type === 'empty') { notesStreaming = false; notesBody.innerHTML = emptyHtml(ev.message, 'EMPTY_KB'); setStatus(ev.message, false); }
      else if (ev.type === 'done') {
        if (ev.full) notesFull = ev.full;
        notesStreaming = false; notesBody.innerHTML = mdToHtml(notesFull);
        notesCites.innerHTML = (ev.citations || []).map(c => '<span class="chip blue">' + esc(c) + '</span>').join(' ') + ' ' + webCitesHTML(ev.webCitations);
        copyBtn.disabled = !notesFull.trim(); exportBtn.disabled = !notesFull.trim();
        if (notesFull.trim()) saveNotes(topic, { full: notesFull, citations: ev.citations || [], webCitations: ev.webCitations || [] });
        updateExportLessonBtn();
        setStatus('笔记已生成 ✓', false);
      } else if (ev.type === 'error') { notesStreaming = false; notesBody.innerHTML = emptyHtml('出错：' + ev.message, ev.code); setStatus('出错：' + ev.message, false); toast(ev.message, 'err'); }
    };
    try {
      const r = await fetch('/api/notes/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, subject: getSubject(), web: getWeb() }), signal: notesController.signal });
      await readSSE(r, handle);
    } catch (e) { if (e.name !== 'AbortError') { notesBody.innerHTML = '<div class="empty">连接失败：' + esc(e.message) + '</div>'; setStatus('连接失败', false); } }
    finally { notesStreaming = false; notesBtn.disabled = false; notesController = null; }
  }
  function copyNotes() {
    if (!notesFull.trim()) return;
    navigator.clipboard.writeText(notesFull).then(() => toast('笔记已复制到剪贴板', 'ok')).catch(() => toast('复制失败，请手动选择文本', 'err'));
  }
  function exportNotes() {
    if (!notesFull.trim()) return;
    const topic = topicInput.value.trim() || '复习笔记';
    const blob = new Blob(['# ' + topic + ' · 复习笔记\n\n' + notesFull + '\n'], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = topic + '-复习笔记.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出 Markdown 笔记', 'ok');
  }

  // ---- quiz ----
  async function genQuiz() {
    const topic = getTopic(); if (!topic) return;
    if (quizController) quizController.abort();
    abortAllReteach();
    switchTab('quiz');
    quizLoading = true; graded = false; grading = false; questions = []; answers = []; results = [];
    genQuizBtn.disabled = true; quizBtn.disabled = true;
    quizBody.innerHTML = '<div class="rv-loading"><span class="spin"></span>正在依据知识库出题…</div>';
    setStatus('出题中…', true);
    quizController = new AbortController();
    try {
      const r = await fetch('/api/quiz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, count: Number(countSel.value), subject: getSubject() }), signal: quizController.signal });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const m = d.error || ('请求失败 ' + r.status);
        quizBody.innerHTML = emptyHtml('出错：' + m, d.code); setStatus('出错：' + m, false); toast(m, 'err');
      } else if (d.empty) { quizBody.innerHTML = emptyHtml(d.message, 'EMPTY_KB'); setStatus(d.message, false); }
      else {
        questions = d.questions || []; answers = questions.map(initAnswer); results = []; graded = false;
        renderQuiz();
        setStatus('已出 ' + questions.length + ' 道题 ✓', false);
      }
    } catch (e) {
      if (e.name !== 'AbortError') { quizBody.innerHTML = '<div class="empty">出错：' + esc(e.message) + '</div>'; setStatus('出错：' + e.message, false); toast(e.message, 'err'); }
    } finally { quizLoading = false; genQuizBtn.disabled = false; quizBtn.disabled = false; quizController = null; }
  }

  function optsHTML(q, i) {
    const a = answers[i];
    const isMulti = q.type === 'multi';
    const correct = isMulti ? q.answer : [q.answer];
    let h = '<div class="rv-opts">';
    q.options.forEach((opt, j) => {
      const picked = isMulti ? a.includes(j) : a === j;
      let cls = 'rv-opt';
      if (!graded && picked) cls += ' selected';
      if (graded) {
        if (correct.includes(j)) cls += ' correct';
        else if (picked) cls += ' wrong';
      }
      h += '<button class="' + cls + '" data-q="' + i + '" data-opt="' + j + '" ' + (graded ? 'disabled' : '') + '><span class="rv-opt-key">' + OPT_KEY[j] + '</span><span class="rv-opt-text">' + esc(opt) + '</span></button>';
    });
    return h + '</div>';
  }
  function judgeHTML(q, i) {
    const a = answers[i];
    let h = '<div class="rv-judge-row">';
    [true, false].forEach(val => {
      let cls = 'rv-judge';
      if (!graded && a === val) cls += ' selected';
      if (graded) {
        if (q.answer === val) cls += ' correct';
        else if (a === val) cls += ' wrong';
      }
      h += '<button class="' + cls + '" data-q="' + i + '" data-val="' + val + '" ' + (graded ? 'disabled' : '') + '>' + (val ? '✓ 正确' : '✗ 错误') + '</button>';
    });
    return h + '</div>';
  }
  function blankHTML(q, i) {
    let h = '<input type="text" class="rv-blank" data-q="' + i + '" placeholder="填写答案" value="' + esc(answers[i]) + '" ' + (graded ? 'disabled' : '') + '>';
    if (graded) h += '<div class="rv-anskey"><b>参考答案：</b>' + q.answer.map(esc).join(' / ') + '</div>';
    return h;
  }
  function shortHTML(q, i) {
    let h = '<textarea class="rv-short" data-q="' + i + '" rows="3" placeholder="用自己的话作答" ' + (graded ? 'disabled' : '') + '>' + esc(answers[i]) + '</textarea>';
    if (graded) h += '<div class="rv-anskey"><b>参考答案：</b>' + esc(q.reference) + '</div>';
    return h;
  }
  function answerAreaHTML(q, i) {
    if (q.type === 'single' || q.type === 'multi') return optsHTML(q, i);
    if (q.type === 'judge') return judgeHTML(q, i);
    if (q.type === 'blank') return blankHTML(q, i);
    if (q.type === 'short') return shortHTML(q, i);
    return '';
  }
  function renderQuiz() {
    if (!questions.length) { quizBody.innerHTML = '<div class="empty">点击「出题」开始小测。</div>'; return; }
    let html = '';
    if (graded) {
      const right = results.reduce((n, r) => n + (r && r.pass ? 1 : 0), 0);
      const pct = Math.round(right / questions.length * 100);
      const tone = pct >= 80 ? 'good' : pct >= 60 ? 'mid' : 'bad';
      html += `<div class="rv-score ${tone}"><div class="rv-score-n">${right}<small> / ${questions.length}</small></div><div class="rv-score-t">${pct >= 80 ? '掌握得不错！' : pct >= 60 ? '基本理解，错点再巩固一下。' : '没关系，把错点再讲一遍，重新作答。'}</div></div>`;
    }
    questions.forEach((q, i) => {
      const pass = graded && results[i] && results[i].pass;
      html += `<div class="rv-q" data-q="${i}">
        <div class="rv-q-head"><span class="rv-q-num">${i + 1}</span><span class="rv-q-type">${TYPE_LABEL[q.type] || '题目'}</span><span class="rv-q-text">${esc(q.question)}</span>${graded ? (pass ? '<span class="rv-q-badge ok">✓ 答对</span>' : '<span class="rv-q-badge no">✗ 答错</span>') : ''}</div>
        ${answerAreaHTML(q, i)}`;
      if (graded) {
        html += `<div class="rv-feedback"><b>解析：</b>${esc(q.explain || '依据知识库资料作答。')}</div>`;
        if (q.type === 'short' && results[i] && results[i].comment) html += `<div class="rv-comment"><b>点评：</b>${esc(results[i].comment)}</div>`;
        if (!pass) {
          html += `<div class="rv-reteach"><button class="btn ghost sm rv-reteach-btn" data-q="${i}">↻ 再讲一遍这个知识点</button><div class="rv-reteach-body md" data-reteach="${i}"></div></div>`;
        }
      }
      html += '</div>';
    });
    html += `<div class="rv-quiz-actions">${graded ? '<button class="btn sm" id="rvRetry">重新作答</button><button class="btn ghost sm" id="rvRegen">换一批题</button>' : '<button class="btn sm" id="rvSubmit">提交答案</button><span class="meta" id="rvProgress"></span>'}</div>`;
    quizBody.innerHTML = html;
    updateProgress();
  }
  function updateProgress() {
    const el = $('#rvProgress'); if (!el) return;
    const done = questions.filter((q, i) => isAnswered(q, answers[i])).length;
    el.textContent = '已作答 ' + done + ' / ' + questions.length;
  }
  function pickOption(qi, oi) {
    if (graded || grading || quizLoading) return;
    const q = questions[qi]; if (!q) return;
    if (q.type === 'multi') {
      const arr = answers[qi];
      const k = arr.indexOf(oi);
      if (k >= 0) arr.splice(k, 1); else arr.push(oi);
      const btn = quizBody.querySelector('.rv-opt[data-q="' + qi + '"][data-opt="' + oi + '"]');
      if (btn) btn.classList.toggle('selected', arr.includes(oi));
    } else {
      answers[qi] = oi;
      quizBody.querySelectorAll('.rv-opt[data-q="' + qi + '"]').forEach(b => b.classList.toggle('selected', Number(b.dataset.opt) === oi));
    }
    updateProgress();
  }
  function pickJudge(qi, val) {
    if (graded || grading || quizLoading) return;
    answers[qi] = val;
    quizBody.querySelectorAll('.rv-judge[data-q="' + qi + '"]').forEach(b => b.classList.toggle('selected', (b.dataset.val === 'true') === val));
    updateProgress();
  }
  async function submitQuiz() {
    if (grading || graded) return;
    const unanswered = questions.filter((q, i) => !isAnswered(q, answers[i])).length;
    if (unanswered) { toast('还有 ' + unanswered + ' 道题未作答', 'warn'); return; }
    const local = questions.map((q, i) => (q.type === 'short' ? null : { pass: gradeObjective(q, answers[i]) }));
    const shortItems = questions
      .map((q, i) => (q.type === 'short' ? { id: q.id, question: q.question, reference: q.reference, answer: answers[i] } : null))
      .filter(Boolean);
    if (shortItems.length) {
      grading = true;
      const submitBtn = $('#rvSubmit');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '判分中…'; }
      setStatus('正在批改简答题…', true);
      let data;
      try {
        const r = await fetch('/api/quiz/grade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: topicInput.value.trim(), items: shortItems }) });
        data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || ('判分失败 ' + r.status));
      } catch (e) {
        grading = false;
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '提交答案'; }
        setStatus('简答判分失败', false);
        toast('简答判分失败：' + e.message + '，可重试提交', 'err');
        return;
      }
      grading = false;
      const byId = {};
      (data.results || []).forEach(r => { byId[r.id] = r; });
      questions.forEach((q, i) => {
        if (q.type !== 'short') return;
        const r = byId[q.id];
        local[i] = { pass: r ? r.pass === true : false, comment: r ? r.comment : '判分异常，请重试。' };
      });
    }
    results = local;
    graded = true;
    renderQuiz();
    const right = results.filter(r => r && r.pass).length;
    setStatus('批改完成：' + right + ' / ' + questions.length, false);
    quizBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function retryQuiz() {
    abortAllReteach();
    answers = questions.map(initAnswer); results = []; graded = false; renderQuiz();
    setStatus('重新作答', false);
  }

  // ---- re-teach (reuse /api/ask/stream, simpler mode) ----
  function abortAllReteach() { reteachControllers.forEach(c => c.abort()); reteachControllers.clear(); }
  async function reteach(qi) {
    const q = questions[qi]; if (!q) return;
    const area = quizBody.querySelector('[data-reteach="' + qi + '"]');
    const btn = quizBody.querySelector('.rv-reteach-btn[data-q="' + qi + '"]');
    if (!area) return;
    if (reteachControllers.has(qi)) reteachControllers.get(qi).abort();
    const controller = new AbortController(); reteachControllers.set(qi, controller);
    if (btn) { btn.disabled = true; btn.textContent = '正在再讲…'; }
    area.innerHTML = '<span class="dlg-status"><span class="spin"></span>正在用更通俗的方式再讲…</span>';
    let acc = '';
    const handle = ev => {
      if (ev.type === 'status') area.innerHTML = '<span class="dlg-status"><span class="spin"></span>' + esc(ev.message) + '</span>';
      else if (ev.type === 'token') { acc += ev.text; area.innerHTML = mdToHtml(acc); }
      else if (ev.type === 'empty') area.innerHTML = '<span class="dlg-empty">' + esc(ev.message) + '</span>';
      else if (ev.type === 'done') {
        if (ev.full) acc = ev.full;
        const kb = (ev.citations || []).map(c => '<span class="chip blue">' + esc(c) + '</span>').join('');
        const web = webCitesHTML(ev.webCitations);
        area.innerHTML = mdToHtml(acc) + ((kb || web) ? '<div class="dlg-cites">' + kb + web + '</div>' : '');
      } else if (ev.type === 'error') area.innerHTML = '<span class="dlg-empty">出错：' + esc(ev.message) + '</span>';
    };
    try {
      const topic = topicInput.value.trim();
      const context = q.point + '（小测题目：' + q.question + '）';
      const r = await fetch('/api/ask/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, context, mode: 'simpler', question: '', history: [], subject: getSubject(), web: getWeb() }), signal: controller.signal });
      await readSSE(r, handle);
    } catch (e) { if (e.name !== 'AbortError') area.innerHTML = '<span class="dlg-empty">连接失败：' + esc(e.message) + '</span>'; }
    finally {
      reteachControllers.delete(qi);
      if (btn) { btn.disabled = false; btn.textContent = '↻ 再讲一遍这个知识点'; }
    }
  }

  // ---- events ----
  view.querySelectorAll('.rv-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  notesBtn.addEventListener('click', genNotes);
  quizBtn.addEventListener('click', () => { switchTab('quiz'); if (!questions.length && !quizLoading) genQuiz(); });
  genQuizBtn.addEventListener('click', genQuiz);
  copyBtn.addEventListener('click', copyNotes);
  exportBtn.addEventListener('click', exportNotes);
  exportLessonBtn.addEventListener('click', () => { const t = topicInput.value.trim(); if (exportLessonHTML(t)) toast('已导出本课 HTML（含白板/追问/笔记）', 'ok'); else toast('没有可导出的本课内容，先讲解或生成笔记', 'warn'); });
  topicInput.addEventListener('input', updateExportLessonBtn);
  topicInput.addEventListener('keydown', e => { if (e.key === 'Enter') genNotes(); });
  quizBody.addEventListener('click', e => {
    const opt = e.target.closest('.rv-opt'); if (opt && !graded) { pickOption(Number(opt.dataset.q), Number(opt.dataset.opt)); return; }
    const judge = e.target.closest('.rv-judge'); if (judge && !graded) { pickJudge(Number(judge.dataset.q), judge.dataset.val === 'true'); return; }
    const rt = e.target.closest('.rv-reteach-btn'); if (rt) { reteach(Number(rt.dataset.q)); return; }
    if (e.target.closest('#rvSubmit')) { submitQuiz(); return; }
    if (e.target.closest('#rvRetry')) { retryQuiz(); return; }
    if (e.target.closest('#rvRegen')) { genQuiz(); return; }
  });
  quizBody.addEventListener('input', e => {
    const blank = e.target.closest('.rv-blank');
    if (blank) { answers[Number(blank.dataset.q)] = blank.value; updateProgress(); return; }
    const short = e.target.closest('.rv-short');
    if (short) { answers[Number(short.dataset.q)] = short.value; updateProgress(); }
  });

  const qTopic = new URLSearchParams(location.search).get('topic');
  if (qTopic) topicInput.value = qTopic;
  updateExportLessonBtn();

  return () => {
    if (notesController) notesController.abort();
    if (quizController) quizController.abort();
    abortAllReteach();
  };
}
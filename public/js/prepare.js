import { $, esc, postJSON, toast, guideLink, webCitesHTML } from './util.js';
import { subjectSelectHTML, initSubjectSelect, getSubject } from './subject.js';
import { webToggleHTML, initWebToggle, getWeb } from './web.js';
import { savePlan } from './lesson.js';

const SUGGESTIONS = ['更通俗易懂', '多加例子', '精简一些', '更深入', '调整顺序'];

export function mount(view) {
  view.innerHTML = `
    <div class="page-head">
      <span class="eyebrow">Lesson Outline</span>
      <h1>AI 备课 · 讲解提纲</h1>
      <p>输入课题，AI 先依据知识库列一份讲解提纲，让你预览这堂课即将学什么。不满意可填写修改意见让 AI 调整，满意后一键上白板按提纲讲解。</p>
    </div>
    <div class="prepare-bar">
      ${subjectSelectHTML()}
      ${webToggleHTML()}
      <input type="text" id="topicInput" placeholder="例如：中断系统">
      <button class="btn" id="genBtn">生成提纲</button>
    </div>
    <div id="prepareResult"></div>`;

  const input = $('#topicInput'), btn = $('#genBtn'), result = $('#prepareResult');
  initSubjectSelect($('#subjSelect'));
  initWebToggle($('#webToggle'));

  let plan = null, currentTopic = '', revisions = 0, busy = false;

  function outlineHTML(d) {
    return `
      <div class="lesson-body" id="lessonBody">
        ${d.sections.map((s, i) => `
          <div class="lesson-sec">
            <h4><span class="num">${i + 1}</span>${esc(s.heading)}</h4>
            <ul>${(s.points || []).map(p => '<li>' + esc(p) + '</li>').join('')}</ul>
            ${s.source ? '<span class="src">来源：' + esc(s.source) + '</span>' : ''}
          </div>`).join('')}
        <div class="lesson-cites">
          <span class="chip blue">参考 ${d.retrieved} 个片段</span>
          ${(d.citations || []).map(c => '<span class="chip">' + esc(c) + '</span>').join(' ')}
          ${webCitesHTML(d.webCitations)}
        </div>
      </div>`;
  }

  function renderPlan() {
    const d = plan;
    result.innerHTML = `
      <div class="card lesson" id="lessonCard">
        <div class="lesson-head">
          <div class="lesson-head-main">
            <div class="lesson-eyebrow">
              <span>讲解提纲 · 预览</span>
              ${revisions > 0 ? `<span class="chip amber">已按意见调整 ${revisions} 次</span>` : ''}
            </div>
            <h3 class="lesson-title">${esc(d.title)}</h3>
            <p class="lesson-overview">${esc(d.overview)}</p>
          </div>
          <a class="btn" id="toBoardBtn" href="/board?topic=${encodeURIComponent(currentTopic)}" data-route>去白板讲解
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </a>
        </div>
        <p class="lesson-preview-hint">这就是这堂课即将讲解的内容。满意就点「去白板讲解」；想调整就在下方告诉 AI 怎么改。</p>
        ${outlineHTML(d)}
        <div class="revise" id="revisePanel">
          <div class="revise-head">
            <span class="revise-ic">
              <svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
            <div class="revise-head-text">
              <div class="revise-title">对提纲不满意？</div>
              <div class="revise-sub">告诉 AI 怎么改，它会据此调整提纲（仍只依据知识库资料）。</div>
            </div>
          </div>
          <div class="revise-chips">
            ${SUGGESTIONS.map(s => `<button type="button" class="rev-chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}
          </div>
          <textarea id="feedbackInput" class="revise-input" rows="3" maxlength="600" placeholder="例如：第二部分太抽象，多加一个生活化的例子；把「中断向量」放到前面讲……"></textarea>
          <div class="revise-actions">
            <button class="btn" id="reviseBtn">
              <svg viewBox="0 0 24 24" width="17" height="17"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              按意见调整
            </button>
            <span class="revise-hint">AI 会保留合理部分，只改动你提到的地方</span>
          </div>
          <div class="revise-status" id="reviseStatus" hidden>
            <span class="spin"></span>正在按你的意见调整提纲…
          </div>
        </div>
      </div>`;

    const ta = $('#feedbackInput'), rBtn = $('#reviseBtn');
    result.querySelectorAll('.rev-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const s = chip.dataset.suggest;
        ta.value = ta.value.trim() ? ta.value.trim().replace(/[；;]\s*$/, '') + '；' + s : s;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    });
    rBtn.addEventListener('click', revise);
    ta.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') revise(); });
  }

  function skeleton() {
    result.innerHTML = `
      <div class="card">
        <div class="skel" style="height:30px;width:40%;margin-bottom:14px"></div>
        <div class="skel" style="height:16px;width:80%;margin-bottom:22px"></div>
        ${[1, 2, 3].map(() => '<div class="skel" style="height:96px;margin-bottom:14px"></div>').join('')}
        <p class="hint" style="margin-top:16px">正在检索知识库并列出讲解提纲，长内容可能需要几十秒…</p>
      </div>`;
  }

  function showError(message, code) {
    const link = guideLink(code);
    result.innerHTML = '<div class="card"><div class="empty">' + esc(message) + (link ? '<div class="empty-act">' + link + '</div>' : '') + '</div></div>';
  }

  async function generate() {
    const topic = input.value.trim();
    if (!topic) { toast('请先输入课题', 'warn'); input.focus(); return; }
    if (busy) return;
    busy = true; btn.disabled = true;
    skeleton();
    try {
      const d = await postJSON('/api/teach', { topic, subject: getSubject(), web: getWeb() });
      if (d.empty) { showError(d.message, 'EMPTY_KB'); return; }
      plan = d; currentTopic = topic; revisions = 0;
      savePlan(topic, { title: d.title, overview: d.overview, sections: d.sections });
      renderPlan();
      toast('讲解提纲已生成', 'ok');
    } catch (e) {
      showError(e.message, e.code);
      toast(e.message, 'err');
    } finally { busy = false; btn.disabled = false; }
  }

  async function revise() {
    const ta = $('#feedbackInput');
    const feedback = ta ? ta.value.trim() : '';
    if (!feedback) { toast('请先填写修改意见', 'warn'); if (ta) ta.focus(); return; }
    if (busy || !plan) return;
    busy = true;
    const rBtn = $('#reviseBtn'), status = $('#reviseStatus'), body = $('#lessonBody'), card = $('#lessonCard');
    rBtn.disabled = true;
    result.querySelectorAll('.rev-chip').forEach(c => { c.disabled = true; });
    ta.disabled = true;
    if (status) status.hidden = false;
    if (body) body.classList.add('dim');
    if (card) card.classList.add('revising');
    try {
      const d = await postJSON('/api/teach/revise', {
        topic: currentTopic, subject: getSubject(), web: getWeb(), feedback, previous: plan,
      });
      if (d.empty) { showError(d.message, 'EMPTY_KB'); return; }
      plan = d; revisions += 1;
      savePlan(currentTopic, { title: d.title, overview: d.overview, sections: d.sections });
      renderPlan();
      toast('提纲已按意见调整', 'ok');
      const nb = $('#reviseBtn'); if (nb) nb.focus();
    } catch (e) {
      if (status) status.hidden = true;
      if (body) body.classList.remove('dim');
      if (card) card.classList.remove('revising');
      rBtn.disabled = false;
      result.querySelectorAll('.rev-chip').forEach(c => { c.disabled = false; });
      ta.disabled = false;
      toast(e.message, 'err');
    } finally { busy = false; }
  }

  btn.addEventListener('click', generate);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') generate(); });
  return null;
}
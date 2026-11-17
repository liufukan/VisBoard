import { $, $$, getJSON, esc, refreshConn, confirmModal } from './util.js';
import * as kb from './kb.js';
import * as prepare from './prepare.js';
import * as board from './board.js';
import * as review from './review.js';
import * as historyPage from './history.js';
import * as settings from './settings.js';
import * as jobs from './jobs.js';

const routes = {
  '/': { page: 'home', title: '首页', mount: mountHome },
  '/kb': { page: 'kb', title: '知识库', mount: kb.mount },
  '/prepare': { page: 'prepare', title: 'AI 备课', mount: prepare.mount },
  '/board': { page: 'board', title: '白板讲解', mount: board.mount },
  '/review': { page: 'review', title: '笔记小测', mount: review.mount },
  '/history': { page: 'history', title: '历史记录', mount: historyPage.mount },
  '/settings': { page: 'settings', title: '设置', mount: settings.mount },
};

let cleanup = null;
let activePath = '/';

function currentPath() {
  const p = location.pathname.replace(/\/+$/, '') || '/';
  return routes[p] ? p : '/';
}

function render() {
  const path = currentPath();
  const r = routes[path];
  activePath = path;
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  $$('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.page === r.page));
  $('#mobileTitle').textContent = r.title;
  const view = $('#view');
  view.className = 'view' + (r.page === 'board' ? ' view-board' : '');
  view.innerHTML = '';
  cleanup = r.mount(view) || null;
  document.body.classList.remove('sidebar-open');
  view.scrollTop = 0;
}

// Leaving the board mid-lesson aborts the stream and wipes the whiteboard, so
// confirm first. Cancel keeps the lesson generating; confirm proceeds to clear.
function confirmExit() {
  return confirmModal({
    title: '退出课程？',
    body: '白板正在生成讲解，退出会中断生成并清空当前白板。确定要退出吗？',
    confirmText: '退出课程',
    cancelText: '继续上课',
    danger: true,
    icon: 'exit',
  });
}
async function allowLeave() {
  if (activePath !== '/board' || !board.isLessonActive()) return true;
  return confirmExit();
}

async function navigate(path) {
  if (!(await allowLeave())) return;
  if (path === location.pathname) render();
  else { history.pushState({}, '', path); render(); }
}

document.addEventListener('click', e => {
  const a = e.target.closest('a[data-route]');
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', async () => {
  // Back/forward already moved the URL; if the user cancels, restore the board.
  if (activePath === '/board' && board.isLessonActive() && !(await confirmExit())) {
    history.pushState({}, '', activePath);
    return;
  }
  render();
});

$('#collapseBtn').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));
$('#menuBtn').addEventListener('click', () => document.body.classList.add('sidebar-open'));
$('#scrim').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

function mountHome(view) {
  view.innerHTML = `
    <section class="hero">
      <span class="eyebrow">AI Whiteboard Tutor</span>
      <h1>把你的课件，变成<br><span class="grad">一块会讲课的白板</span></h1>
      <p>上传 PDF / Word / PPT / Markdown 搭建专属知识库，AI 只依据你的资料，在白板上边插入文字框和示意图边讲解——不联网、不瞎编，把知识讲透。</p>
      <div class="hero-actions">
        <a class="btn" href="/board" data-route>开始白板讲解
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
        <a class="btn ghost" href="/kb" data-route>搭建知识库</a>
      </div>
    </section>

    <div class="stat-grid">
      <div class="stat b"><div class="ic"><svg viewBox="0 0 24 24"><path d="M4 7c0-1.5 3.6-3 8-3s8 1.5 8 3-3.6 3-8 3-8-1.5-8-3zM4 7v10c0 1.5 3.6 3 8 3s8-1.5 8-3V7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></div><div class="n" id="stDocs">—</div><div class="l">知识库资料</div></div>
      <div class="stat c"><div class="ic"><svg viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h9M5 20h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></div><div class="n" id="stChars">—</div><div class="l">总字数</div></div>
      <div class="stat a"><div class="ic"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></div><div class="n" id="stChunks">—</div><div class="l">知识块</div></div>
      <div class="stat g"><div class="ic"><svg viewBox="0 0 24 24"><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div><div class="n" id="stModel" style="font-size:18px">—</div><div class="l">当前模型</div></div>
    </div>

    <div class="entry-grid">
      <a class="entry e1" href="/kb" data-route>
        <div class="eic"><svg viewBox="0 0 24 24"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <h3>搭建知识库</h3><p>上传课件与教材，自动解析切块。AI 教学的唯一依据，随时增删。</p>
        <span class="go">管理资料 →</span>
      </a>
      <a class="entry e2" href="/prepare" data-route>
        <div class="eic"><svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5zM8 9h6M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <h3>AI 备课</h3><p>输入课题，先列一份讲解提纲预览即将学什么；不满意可填修改意见让 AI 调整，满意后按提纲上白板。</p>
        <span class="go">生成提纲 →</span>
      </a>
      <a class="entry e3" href="/board" data-route>
        <div class="eic"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M7 8h7M7 11h4M12 17l-2 3M12 17l2 3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></div>
        <h3>白板讲解</h3><p>AI 在可缩放平移的白板上，逐个插入文字框与示意图，边画边讲。</p>
        <span class="go">开始上课 →</span>
      </a>
    </div>`;

  getJSON('/api/kb').then(d => {
    const docs = d.docs || [];
    $('#stDocs').textContent = docs.length;
    $('#stChars').textContent = docs.reduce((n, x) => n + (x.chars || 0), 0).toLocaleString();
    $('#stChunks').textContent = docs.reduce((n, x) => n + (x.chunks || 0), 0).toLocaleString();
  }).catch(() => {});
  getJSON('/api/config').then(d => { $('#stModel').textContent = d.model; }).catch(() => {});
  return null;
}

refreshConn();
render();
jobs.wake();
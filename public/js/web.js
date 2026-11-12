import { getJSON } from './util.js';

const KEY = 'visboard.web';
let searchKeyKnown = null;

export function getWeb() { return localStorage.getItem(KEY) === '1'; }
export function setWeb(v) { localStorage.setItem(KEY, v ? '1' : '0'); }

export function webToggleHTML(id = 'webToggle') {
  return `<label class="web-pick">
    <input type="checkbox" id="${id}" class="web-check">
    <span class="web-track"><span class="web-thumb"></span></span>
    <span class="web-label">联网拓展</span>
  </label>`;
}

export async function initWebToggle(box) {
  if (!box) return;
  box.checked = getWeb();
  box.addEventListener('change', () => setWeb(box.checked));
  const wrap = box.closest('.web-pick');
  if (searchKeyKnown === null) {
    try { searchKeyKnown = Boolean((await getJSON('/api/health')).hasSearchKey); }
    catch { searchKeyKnown = false; }
  }
  if (wrap) {
    wrap.classList.toggle('no-key', !searchKeyKnown);
    wrap.title = searchKeyKnown
      ? '知识库为主；资料不足时联网拓展，网络内容单独标注来源'
      : '未配置搜索密钥：开启后仍只依据知识库（在设置中填写搜索密钥后可联网）';
  }
}
import { $, esc, getJSON } from './util.js';

const KEY = 'visboard.subject';

export function getSubject() { return localStorage.getItem(KEY) || 'all'; }
export function setSubject(v) { localStorage.setItem(KEY, v || 'all'); }

export function subjectSelectHTML(id = 'subjSelect') {
  return `<label class="subj-pick">科目<select id="${id}" class="subj-select"></select></label>`;
}

export async function initSubjectSelect(sel, onChange) {
  let subjects = [];
  try { subjects = (await getJSON('/api/subjects')).subjects || []; } catch { subjects = []; }
  const cur = getSubject();
  sel.innerHTML = '<option value="all">全部科目</option>' +
    subjects.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('') +
    '<option value="none">未分区</option>';
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
  setSubject(sel.value);
  sel.addEventListener('change', () => { setSubject(sel.value); if (onChange) onChange(sel.value); });
  return sel.value;
}
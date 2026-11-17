import { getJSON, toast } from './util.js';

// 后台任务轮询器:任务在服务端队列里跑,切页/断请求都不影响。
// 有活跃任务时每 1.5s 拉一次状态;全部结束后自动停轮询。
// 完成/失败的 toast 在全局发,任何页面都能收到通知。
let timer = null;
let busy = false;
let primed = false;
let latest = [];
const subs = new Set();
const toasted = new Set();

const KIND_LABEL = { parse: '解析', images: '补提取图片', ocr: 'OCR 识别' };

export function getJobs() { return latest; }
export function subscribe(fn) { subs.add(fn); fn(latest); return () => subs.delete(fn); }
export function wake() { tick(); }

async function tick() {
  if (busy) return;
  busy = true;
  try {
    let list;
    try { list = (await getJSON('/api/jobs')).jobs || []; }
    catch { return; }
    latest = list;
    for (const j of list) {
      if (j.status !== 'done' && j.status !== 'error') continue;
      if (toasted.has(j.id)) continue;
      toasted.add(j.id);
      if (!primed) continue; // 首帧只记录不弹,避免刷新页面时重弹历史任务
      if (j.status === 'done') {
        if (j.kind === 'parse') toast('已导入「' + j.name + '」', 'ok');
        else if (j.kind === 'images') toast('「' + j.name + '」已提取 ' + ((j.result && j.result.count) || 0) + ' 张图片', 'ok');
        else toast('「' + j.name + '」OCR 完成' + (j.result && j.result.ocrPages ? ':' + j.result.ocrPages + ' 页' : ''), 'ok');
      } else {
        toast('「' + j.name + '」' + (KIND_LABEL[j.kind] || '') + '失败:' + j.error, 'err');
      }
    }
    primed = true;
    for (const id of [...toasted]) if (!list.some(j => j.id === id)) toasted.delete(id);
    subs.forEach(fn => { try { fn(list); } catch {} });
    const active = list.some(j => j.status === 'queued' || j.status === 'running');
    if (active && !timer) timer = setInterval(tick, 1500);
    if (!active && timer) { clearInterval(timer); timer = null; }
  } finally { busy = false; }
}
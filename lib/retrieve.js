const kb = require('./kb');
const llm = require('./llm');

const PREVIEW_LEN = 120;
const MAX_SELECT = 8;
const MAX_IMAGES = 4;

function extractJson(raw) {
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch {}
  }
  return null;
}

async function retrieve(question, subject) {
  const all = kb.allChunks(subject);
  if (!all.length) {
    const e = new Error('知识库为空,请先上传资料');
    e.code = 'EMPTY_KB';
    throw e;
  }
  const items = all.map((c, n) => ({ n, ...c }));
  const preview = items.map(c => {
    const head = c.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
    const loc = c.page != null ? '第' + c.page + '页' : '全文';
    return '[' + c.n + '] 《' + c.docName + '》' + loc + ': ' + head;
  }).join('\n');

  const sys = '你是知识库检索助手。根据用户问题,从资料片段预览中选出最相关的片段编号。' +
    '只输出 JSON:{"selected":[编号,...]},最多 ' + MAX_SELECT + ' 个,按相关性从高到低排序。' +
    '没有相关片段时输出 {"selected":[]}。不要输出 JSON 以外的任何内容。';
  const user = '用户问题:' + question + '\n\n资料片段预览:\n' + preview;
  const raw = await llm.chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0 }
  );

  let selected;
  const obj = extractJson(raw);
  if (obj && Array.isArray(obj.selected)) {
    selected = obj.selected;
  } else {
    const e = new Error('检索结果解析失败: ' + raw.slice(0, 200));
    e.code = 'PARSE';
    throw e;
  }

  const byN = new Map(items.map(c => [c.n, c]));
  const picked = [];
  for (const n of selected) {
    const c = byN.get(Number(n));
    if (c && !picked.includes(c)) picked.push(c);
    if (picked.length >= MAX_SELECT) break;
  }
  const docCache = new Map();
  const images = [];
  const seen = new Set();
  for (const c of picked) {
    if (images.length >= MAX_IMAGES) break;
    if (c.page == null) continue;
    let d = docCache.get(c.docId);
    if (!d) { d = kb.getDoc(c.docId); docCache.set(c.docId, d); }
    if (!d || !Array.isArray(d.images)) continue;
    for (const im of d.images) {
      if (im.page !== c.page) continue;
      const key = c.docId + '/' + im.id;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push({ docId: c.docId, docName: c.docName, page: im.page, id: im.id, url: '/kb-images/' + c.docId + '/' + im.file, w: im.w, h: im.h });
      if (images.length >= MAX_IMAGES) break;
    }
  }
  return {
    question,
    total: items.length,
    chunks: picked.map(c => ({ docId: c.docId, docName: c.docName, kind: c.kind, page: c.page, idx: c.idx, text: c.text })),
    images,
  };
}

module.exports = { retrieve, extractJson };
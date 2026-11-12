const { retrieve } = require('./retrieve');
const { webSearch, hasSearchKey } = require('./search');

function kbMaterialOf(chunks) {
  return chunks.map((c, i) => {
    const loc = c.page != null ? '第' + c.page + '页' : '全文';
    return '【资料' + (i + 1) + '】《' + c.docName + '》' + loc + '\n' + c.text;
  }).join('\n\n');
}

// Knowledge-base-first material gathering. When `web` is enabled AND a search
// key is configured AND the KB returned fewer than 2 relevant chunks (including
// zero), supplement with a web search. Web content is kept separate and labeled
// so prompts can distinguish 资料 (KB) from 网络 (web). Degrades to KB-only when
// no search key is set or search fails.
async function gatherMaterial(topic, subject, web) {
  let ret;
  try {
    ret = await retrieve(topic, subject);
  } catch (e) {
    if (e.code === 'EMPTY_KB' && web && hasSearchKey()) ret = { question: topic, total: 0, chunks: [] };
    else throw e;
  }
  let webResults = [];
  if (web && hasSearchKey() && ret.chunks.length < 2) {
    webResults = await webSearch(topic);
  }
  const kbMaterial = kbMaterialOf(ret.chunks);
  const webMaterial = webResults.map((r, i) =>
    '【网络' + (i + 1) + '】' + r.title + '\n' + r.snippet + '\n来源: ' + r.url
  ).join('\n\n');
  const hasWeb = webResults.length > 0;
  const material = hasWeb
    ? kbMaterial + '\n\n--- 以下为网络拓展资料(非知识库,仅供背景拓展,引用须标注来自网络) ---\n' + webMaterial
    : kbMaterial;
  return {
    ret, material, kbMaterial, webMaterial, hasWeb,
    webCitations: webResults.map(r => ({ title: r.title, url: r.url })),
    citations: [...new Set(ret.chunks.map(c => c.docName))],
    empty: ret.chunks.length === 0 && webResults.length === 0,
  };
}

const WEB_RULE = '主体讲解严格依据【资料】(知识库);只有标注【网络】的资料才可作为拓展,' +
  '且必须单独放在末尾「## 拓展阅读（来自网络）」小节,逐条标明来自网络与来源,不得把网络内容混入主体当作知识库结论。';

module.exports = { gatherMaterial, kbMaterialOf, WEB_RULE };
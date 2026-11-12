const fs = require('fs');
const path = require('path');

function getSearchConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  return { apiKey: cfg.searchApiKey || '', provider: cfg.searchProvider || 'deepseek' };
}

function hasSearchKey() {
  return Boolean(getSearchConfig().apiKey);
}

// Web search via DeepSeek Search API (default) or Bocha. Uses ONLY searchApiKey,
// never the generation key. Returns [] on missing key or any failure so callers
// can fall back to knowledge-base-only teaching without breaking the lesson.
async function webSearch(query, count = 6) {
  const { apiKey, provider } = getSearchConfig();
  const q = String(query || '').trim();
  if (!apiKey || !q) return [];
  const deepseek = provider === 'deepseek';
  const url = deepseek
    ? 'https://api.deepseek.com/v1/tools/search'
    : 'https://api.bochaai.com/v1/web-search';
  const body = deepseek
    ? { query: q, count, need_content: false }
    : { query: q, freshness: 'noLimit', summary: true, count };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) { console.warn('[search] HTTP', r.status); return []; }
    const data = await r.json();
    const value = deepseek
      ? ((data && data.results) || [])
      : ((data && data.data && data.data.webPages && data.data.webPages.value) || []);
    return value.slice(0, count).map(v => ({
      title: String((deepseek ? v.title : (v.name || v.title)) || '').trim(),
      url: String(v.url || '').trim(),
      snippet: String(v.summary || v.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    })).filter(x => x.title && x.url);
  } catch (e) {
    console.warn('[search] failed:', e.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { webSearch, hasSearchKey, getSearchConfig };
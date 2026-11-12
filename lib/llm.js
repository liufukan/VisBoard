const fs = require('fs');
const path = require('path');

function getConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
}

// The school endpoint intermittently resets connections mid-request. Retry only
// transient network failures (no error code); deterministic errors like NO_KEY /
// LLM_HTTP / LLM_EMPTY carry a code and are never retried.
const TRANSIENT = /fetch|network|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|socket|terminated|other side closed/i;
function isTransient(e) {
  return !e.code && (e.name === 'TypeError' || e.name === 'SyntaxError' || TRANSIENT.test(e.message || ''));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i < attempts - 1 && isTransient(e)) { await wait(500 * (i + 1)); continue; }
      throw e;
    }
  }
}

async function request(body) {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    const e = new Error('未配置 API key:请在 D:\\visboard\\config.json 的 apiKey 填入你的 DeepSeek(或学校)key');
    e.code = 'NO_KEY';
    throw e;
  }
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, ...body }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const e = new Error('LLM 接口错误 ' + r.status + ': ' + txt.slice(0, 300));
    e.code = 'LLM_HTTP';
    throw e;
  }
  return r;
}

async function chat(messages, { temperature = 0.3 } = {}) {
  const data = await withRetry(async () => {
    const r = await request({ messages, temperature });
    return r.json();
  });
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  let content = msg.content;
  if (typeof content !== 'string' || !content.trim()) {
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) content = msg.reasoning_content;
  }
  if (typeof content !== 'string' || !content.trim()) {
    const e = new Error('LLM 返回为空');
    e.code = 'LLM_EMPTY';
    throw e;
  }
  return content;
}

async function chatStream(messages, { temperature = 0.5, onToken, onThinking } = {}) {
  const r = await withRetry(() => request({ messages, temperature, stream: true }));
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
      if (!delta) continue;
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content && onThinking) onThinking();
      if (typeof delta.content === 'string' && delta.content) {
        full += delta.content;
        if (onToken) onToken(delta.content);
      }
    }
  }
  return full;
}

module.exports = { chat, chatStream, getConfig };
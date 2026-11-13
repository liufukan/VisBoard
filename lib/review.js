const { retrieve, extractJson } = require('./retrieve');
const { gatherMaterial, WEB_RULE } = require('./material');
const llm = require('./llm');

function materialOf(ret) {
  return ret.chunks.map((c, i) => {
    const loc = c.page != null ? '第' + c.page + '页' : '全文';
    return '【资料' + (i + 1) + '】《' + c.docName + '》' + loc + '\n' + c.text;
  }).join('\n\n');
}

async function streamNotes(topic, { subject, web, onToken, onThinking, onStatus } = {}) {
  if (onStatus) onStatus('正在检索知识库…');
  const g = await gatherMaterial(topic, subject, web);
  if (g.empty) {
    return { empty: true, message: '知识库里没有与「' + topic + '」相关的资料,请先上传相关课件。', citations: [], full: '', webCitations: [] };
  }
  const sys = '你是以知识库资料为主帮学生整理复习笔记的家教。主体严格根据【资料】,不引入资料之外的知识。' +
    (g.hasWeb ? WEB_RULE : '') +
    '用 Markdown 输出一份精炼的复习笔记,便于课后回顾:用 ## 分出「核心概念」「关键要点」「易错提醒」等小节(按资料实际内容取舍),' +
    '要点用短列表,关键术语用 **加粗**。数学公式用 LaTeX:行内 $...$,独立公式 $$...$$;代码用 ``` 围栏代码块。整体控制在 300-500 字,不要画图,不要寒暄,直接输出笔记正文。';
  const user = '课题:' + topic + '\n\n可用资料:\n' + g.material;
  if (onStatus) onStatus('正在整理笔记…');
  const full = await llm.chatStream(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.4, onToken, onThinking }
  );
  return { empty: false, full, citations: g.citations, webCitations: g.webCitations };
}

function parseJudge(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', '1', '对', '正确', '是', 'yes', 't'].includes(s)) return true;
  if (['false', '0', '错', '错误', '否', 'no', 'f'].includes(s)) return false;
  return null;
}

function normalizeQuestion(q, i) {
  const type = String(q.type || 'single').trim().toLowerCase();
  const question = String(q.question || '').trim();
  if (!question) return null;
  const base = {
    id: i + 1,
    type,
    question,
    explain: String(q.explain || '').trim(),
    point: String(q.point || q.question || '').trim(),
  };
  if (type === 'single' || type === 'multi') {
    const options = Array.isArray(q.options) ? q.options.slice(0, 6).map(String) : [];
    if (options.length < 2) return null;
    if (type === 'single') {
      const answer = Number(q.answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
      return { ...base, type: 'single', options, answer };
    }
    const raw = Array.isArray(q.answer) ? q.answer : (q.answer != null ? [q.answer] : []);
    const answer = [...new Set(raw.map(Number).filter(x => Number.isInteger(x) && x >= 0 && x < options.length))].sort((a, b) => a - b);
    if (!answer.length) return null;
    if (answer.length === 1) return { ...base, type: 'single', options, answer: answer[0] };
    return { ...base, type: 'multi', options, answer };
  }
  if (type === 'judge') {
    const answer = parseJudge(q.answer);
    if (answer === null) return null;
    return { ...base, type: 'judge', answer };
  }
  if (type === 'blank') {
    const raw = Array.isArray(q.answer) ? q.answer : (q.answer != null ? [q.answer] : []);
    const answer = raw.map(x => String(x).trim()).filter(Boolean);
    if (!answer.length) return null;
    return { ...base, type: 'blank', answer };
  }
  if (type === 'short') {
    const reference = String(q.reference || q.answer || '').trim();
    if (!reference) return null;
    return { ...base, type: 'short', reference };
  }
  return null;
}

async function generateQuiz(topic, count = 4, subject) {
  const n = Math.max(2, Math.min(6, Number(count) || 4));
  const ret = await retrieve(topic, subject);
  if (!ret.chunks.length) {
    return { topic, empty: true, message: '知识库里没有与「' + topic + '」相关的资料,请先上传相关课件。', questions: [], citations: [] };
  }
  const sys = '你是只依据给定知识库资料命题的家教。严格根据提供的资料出题,不引入资料之外的知识,不联网搜索。' +
    '出 ' + n + ' 道混合题型的小测,覆盖资料中不同的关键知识点,由浅入深。题型从以下五种中选取,尽量让每种题型都出现:' +
    'single(单选,4 个选项,answer 为正确选项下标 0-3)、multi(多选,4-6 个选项,answer 为所有正确选项下标组成的数组,至少 2 个)、' +
    'judge(判断对错,answer 为 true 或 false)、blank(填空,题干用____表示空,answer 为可接受答案字符串数组,把同义或不同写法都列出)、' +
    'short(简答,reference 为参考答案要点,用于判分)。只输出 JSON,格式:' +
    '{"questions":[' +
    '{"type":"single","question":"题干","options":["选项A","选项B","选项C","选项D"],"answer":0,"explain":"依据资料的简短解析","point":"本题考查的知识点(一句完整、可独立理解的话,用于学生答错后重新讲解)"},' +
    '{"type":"multi","question":"题干","options":["选项A","选项B","选项C","选项D"],"answer":[0,2],"explain":"...","point":"..."},' +
    '{"type":"judge","question":"题干","answer":true,"explain":"...","point":"..."},' +
    '{"type":"blank","question":"题干____","answer":["答案1","答案2"],"explain":"...","point":"..."},' +
    '{"type":"short","question":"题干","reference":"参考答案要点","explain":"...","point":"..."}]}。' +
    '每道题都要有 explain 和 point;选择题的选项都要合理、有迷惑性,正确答案必须能在资料中找到依据;point 要具体清楚。题干、选项与解析中的数学公式用行内 $...$ LaTeX。不要输出 JSON 以外的任何内容。';
  const user = '课题:' + topic + '\n\n可用资料:\n' + materialOf(ret);
  const raw = await llm.chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.4 }
  );
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.questions) || !obj.questions.length) {
    const e = new Error('小测生成失败: ' + raw.slice(0, 200));
    e.code = 'PARSE';
    throw e;
  }
  const questions = obj.questions.slice(0, n)
    .map((q, i) => normalizeQuestion(q, i))
    .filter(Boolean)
    .map((q, i) => ({ ...q, id: i + 1 }));
  if (!questions.length) {
    const e = new Error('小测题目无效');
    e.code = 'PARSE';
    throw e;
  }
  return { topic, empty: false, questions, citations: [...new Set(ret.chunks.map(c => c.docName))] };
}

async function gradeShortAnswers(items) {
  const list = Array.isArray(items) ? items.slice(0, 6) : [];
  const results = list.map(it => ({ id: it.id, pass: false, comment: '未作答。' }));
  const toGrade = [];
  list.forEach((it, idx) => {
    const ans = String(it.answer == null ? '' : it.answer).trim();
    if (ans) toGrade.push({ idx, it, ans });
  });
  if (!toGrade.length) return results;
  const sys = '你是阅卷老师,依据参考答案判断学生的简答是否正确。只要学生答案涵盖了参考答案的核心要点、意思正确即可判通过,不要求逐字一致;' +
    '意思错误、遗漏关键点或答非所问判不通过。对每道题输出 pass(true/false)和 comment(20-50 字的中文点评,指出对错原因,语气鼓励)。' +
    '只输出 JSON:{"results":[{"pass":true,"comment":"..."}]},results 顺序与题目顺序一致、数量相同。不要输出 JSON 以外的任何内容。';
  const user = toGrade.map((g, i) =>
    '【第' + (i + 1) + '题】\n题目:' + g.it.question + '\n参考答案:' + g.it.reference + '\n学生答案:' + g.ans
  ).join('\n\n');
  const raw = await llm.chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.2 }
  );
  const obj = extractJson(raw);
  const arr = obj && Array.isArray(obj.results) ? obj.results : [];
  if (!arr.length) {
    const e = new Error('简答判分失败: ' + raw.slice(0, 200));
    e.code = 'PARSE';
    throw e;
  }
  toGrade.forEach((g, i) => {
    const r = arr[i];
    const pass = r ? parseJudge(r.pass) : null;
    results[g.idx] = {
      id: g.it.id,
      pass: pass === true,
      comment: (r && String(r.comment || '').trim()) || (pass === true ? '回答正确。' : pass === false ? '回答有误。' : '判分异常,请重试。'),
    };
  });
  return results;
}

module.exports = { streamNotes, generateQuiz, gradeShortAnswers };
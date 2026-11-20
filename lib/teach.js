const { extractJson } = require('./retrieve');
const { gatherMaterial, WEB_RULE } = require('./material');
const llm = require('./llm');
const latex = require('./latex');

async function prepareLesson(topic, subject, web, opts = {}) {
  const feedback = String(opts.feedback || '').trim();
  const previous = opts.previous || null;
  const g = await gatherMaterial(topic, subject, web);
  if (g.empty) {
    return {
      topic, empty: true,
      message: '知识库里没有与「' + topic + '」相关的资料,请先上传相关课件再备课。',
      title: topic, overview: '', sections: [], citations: [], retrieved: 0, webCitations: [],
    };
  }
  const webRule = g.hasWeb
    ? WEB_RULE + '若用到网络资料,在 sections 末尾追加一节 {"heading":"拓展阅读（来自网络）","points":["要点",...],"source":"网络"}。'
    : '严格根据提供的资料备课,不要引入资料之外的知识。';
  const sys = '你是一位以知识库资料为主授课的家教。' + webRule +
    '输出一个 JSON 讲解提纲,格式:{"title":"课题","overview":"一句话概述",' +
    '"sections":[{"heading":"小节标题","points":["要点",...],"source":"来源资料名","worked":"可选,例题题干与完整解析"}],' +
    '"citations":["用到的资料名"]}。sections 按教学顺序由浅入深组织,每个小节 2-5 个要点,要点要具体、可讲解。' +
    '适合计算或推导的小节(数学/电路/算法等)给出 worked:一道典型例题的题干加逐步完整解析,公式用 LaTeX($...$ 与 $$...$$),只用文字与公式、不要画图;' +
    'worked 必须是自行核对计算与符号后的最终定稿,只写正确推导,不写尝试、纠正或检查过程;不适合算例的小节省略 worked。只输出 JSON,不要其它内容。';
  let user;
  if (feedback && previous && Array.isArray(previous.sections)) {
    const prev = { title: previous.title || topic, overview: previous.overview || '', sections: previous.sections };
    user = '课题:' + topic + '\n\n学生已预览下面这份讲解提纲,并提出了修改意见。请据此调整提纲:保留合理部分,只改动需要改的地方,' +
      '仍按教学顺序由浅入深组织,严格依据资料,不要引入资料之外的知识。worked 例题解析同样保留或按意见调整,仍须是核对后的定稿。\n\n当前提纲(JSON):\n' + JSON.stringify(prev) +
      '\n\n学生的修改意见:\n' + feedback + '\n\n可用资料:\n' + g.material;
  } else {
    user = '课题:' + topic + '\n\n可用资料:\n' + g.material;
  }
  const raw = await llm.chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: feedback ? 0.4 : 0.2 }
  );
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.sections)) {
    const e = new Error('备课结果解析失败: ' + raw.slice(0, 200));
    e.code = 'PARSE';
    throw e;
  }
  const sections = await verifyExamples(obj.sections, g.material);
  return {
    topic, empty: false,
    title: obj.title || topic,
    overview: obj.overview || '',
    sections,
    citations: Array.isArray(obj.citations) && obj.citations.length ? obj.citations : g.citations,
    retrieved: g.ret.chunks.length,
    webCitations: g.webCitations,
  };
}

// 例题解析在备课阶段单独核对一遍:错误在预览前改掉,而不是流式上板时现场翻车。核对失败沿用原版,不阻塞备课。
async function verifyExamples(sections, material) {
  const items = sections.filter(s => s && typeof s.worked === 'string' && s.worked.trim());
  if (!items.length) return sections;
  try {
    const raw = await llm.chat([
      { role: 'system', content: '你是推导核对员。逐行核对各例题解析的每一步计算、符号与最终结论,并与【资料】对照。' +
        '无误则原样保留,有误则直接给出修正后的完整解析。只输出 JSON:{"sections":[{"heading":"小节标题","worked":"定稿解析"}]},' +
        'heading 与输入一致,不要输出核对过程或解释。' },
      { role: 'user', content: '待核对的例题解析(JSON):\n' + JSON.stringify(items.map(s => ({ heading: s.heading, worked: s.worked }))) + '\n\n可用资料:\n' + material },
    ], { temperature: 0.1 });
    const obj = extractJson(raw);
    if (!obj || !Array.isArray(obj.sections)) return sections;
    const fixed = new Map(obj.sections.filter(s => s && typeof s.worked === 'string' && s.worked.trim()).map(s => [s.heading, s.worked]));
    console.log('[teach] worked check:', fixed.size + '/' + items.length);
    return sections.map(s => (s && fixed.has(s.heading)) ? { ...s, worked: fixed.get(s.heading) } : s);
  } catch (e) {
    console.warn('[teach] worked check failed:', e.message);
    return sections;
  }
}

const FINAL_ONLY = '只输出定稿内容:禁止"等等""不对""重新算""我检查一下""资料有误?"等自我纠正、检查、犹豫的过程性话语;' +
  '所有计算与核对在输出前完成,正文只写最终正确的推导与结论;与资料冲突时静默以资料为准,不在正文讨论分歧。';

async function streamLesson(topic, { subject, web, plan, onToken, onThinking, onStatus } = {}) {
  if (onStatus) onStatus('正在检索知识库…');
  const g = await gatherMaterial(topic, subject, web);
  if (g.empty) {
    return { empty: true, message: '知识库里没有与「' + topic + '」相关的资料,请先上传相关课件。', citations: [], retrieved: 0, full: '', webCitations: [], images: [] };
  }
  let planRule = '';
  if (plan && Array.isArray(plan.sections) && plan.sections.length) {
    planRule = '\n\n学生已在备课环节确认了下面这份讲解提纲,请严格按这份提纲的结构与顺序展开讲解' +
      '(每个小节对应一个 ## 小标题,覆盖其要点),不要偏离或自行增减小节:\n' +
      JSON.stringify({ title: plan.title, overview: plan.overview, sections: plan.sections.map(s => ({ heading: s.heading, points: s.points, worked: s.worked })) }) +
      '\n其中 worked 是备课阶段已核对定稿的例题解析:讲到对应小节时直接采用其内容与结论(可调整排版措辞,不得重新推导、不得改动计算),不要自行另算例题。';
  }
  const hasLatex = await latex.detect();
  const figRule = hasLatex
    ? '电路原理图(元件连接关系)必须用 ```circuit 围栏包裹完整的 \\begin{circuitikz}...\\end{circuitikz} 环境(后端会编译成图片),不要用 svg 手绘电路;' +
      'circuit 图内所有文字(元件型号/位号/引脚与网络名/注释/标题)一律用英文或 ASCII,禁止出现中文;' +
      '文字不得与元件或导线重叠:门级元件的型号/位号用独立 \\node 置于门体中心上方或下方至少 0.9 坐标单位处(不要用 label= 贴在门体上);IC 模块框的型号可写在框内居中但不得压引脚线;引脚/网络名只放在短截线自由端(node[left]/node[right]),不压导线中段;图标题用单独 \\node 置于整图上方留白处;' +
      '元件与端点只用 circuitikz 标准名:电阻 R/电容 C/电感 L/发光二极管 led/二极管 diode(一律小写),端点与节点用 node[ocirc](空心)/node[circ](实心)/node[ground](地);禁止大写 LED、禁止 short o- 等自创名;导线用 -- 或 to[元件],箭头仅 ->;' +
      '每个元件只写一个标签键且放左侧 l_=(如 to[R, l_=$510\\,\\Omega$]),不要同时用 l/l^/l_,避免标签互撞;' +
      '文字放置示例(照此习惯布局):\n```circuit\n' + String.raw`\begin{circuitikz}[american]
  \node[font=\small] at (3,2.2) {Half Adder};
  \node[xor port] (X) at (3,0) {};
  \node[font=\small] at (3,1.1) {74HC86};
  \node[and port] (G) at (3,-2.6) {};
  \node[font=\small] at (3,-3.7) {74HC08};
  \draw (X.in 1) -- ++(-1,0) node[left]{A};
  \draw (X.in 2) -- ++(-1,0) node[left]{B};
  \draw (G.in 1) -- ++(-1,0) node[left]{A};
  \draw (G.in 2) -- ++(-1,0) node[left]{B};
  \draw (X.out) -- ++(1,0) node[right]{S};
  \draw (G.out) -- ++(1,0) node[right]{C};
\end{circuitikz}` + '\n```\n' +
      '电源与LED示例:\n```circuit\n' + String.raw`\begin{circuitikz}[american]
  \node[font=\small] at (2.6,2.6) {LED Current Limiting};
  \node[ocirc] (VCC) at (0,2) {};
  \node[left] at (-0.25,2) {VCC 3.3V};
  \draw (VCC) -- (0,1.2) to[R, l_=$510\,\Omega$] (0,-0.2);
  \draw (0,-0.2) -- (0,-0.8) to[led, l_=$LED0$] (0,-2.2);
  \draw (0,-2.2) -- (0,-2.8);
  \node[ocirc] (PA8) at (0,-2.8) {};
  \node[left] at (-0.25,-2.8) {PA8};
  \node[font=\small, right] at (1.2,-1.5) {PA8=0V: LED ON};
\end{circuitikz}` + '\n```\n' +
      '函数图像用 ```func 围栏包裹 JSON,例如 {"expr":"sin(x)","xMin":-6.28,"xMax":6.28,"label":"y=sin(x)"}(乘法用显式 *,支持 sin/cos/tan/exp/log/sqrt/abs/^ 与括号);'
    : '电路图必须用连续导线把所有元件连成闭合回路,元件不得悬空;';
  const sys = '你是一位以知识库资料为主授课的白板家教。主体严格根据【资料】讲解,不引入资料之外的知识。' +
    (g.hasWeb ? WEB_RULE : '') +
    '用 Markdown 写一份由浅入深、口语化、易懂且精炼的讲解,适合白板展示:用 ## 小标题分段,要点用列表,关键概念用 **加粗**。' +
    '数学公式用 LaTeX:行内 $...$,独立公式 $$...$$;多行代码用 ```语言名 围栏代码块。' +
    figRule +
    '示意图(流程图/结构图等)用 ```svg 代码块包裹一个完整、可直接渲染的 <svg>...</svg>:' +
    '必须带 xmlns="http://www.w3.org/2000/svg" 和 viewBox,宽约 600,高度按内容自适应(每个节点/每行至少 70px,最小 260px),浅色背景、深色线条与文字,图中文字用中文。' +
    '布局务必宽松清晰:节点间距至少 56px,箭头长度至少 24px,回线/分支线与主线偏移至少 40px,四周留白至少 24px;图形简单,只用少量矩形、箭头和文字,元素总数不超过 20 个,不要渐变、阴影或复杂装饰。' +
    '全程最多插入 2 个图(svg/circuit/func 合计),每个图后面配一句说明。讲解循序渐进,先讲是什么再讲为什么和怎么用,避免冗长。直接输出讲解正文,不要输出课题 JSON。' +
    FINAL_ONLY +
    planRule;
  const user = '课题:' + topic + '\n\n可用资料:\n' + g.material;
  if (onStatus) onStatus(g.hasWeb ? '正在结合网络拓展生成讲解…' : '正在生成讲解…');
  const full = await llm.chatStream(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { temperature: 0.5, onToken, onThinking }
  );
  return { empty: false, full, citations: g.citations, retrieved: g.ret.chunks.length, webCitations: g.webCitations, images: (g.ret.images || []).slice(0, 2) };
}

const ANSWER_MODES = {
  simpler: '用最通俗易懂的大白话重新讲这个知识点,多打生活化的比方,尽量少用术语,让基础薄弱的同学也能听懂。',
  explain: '把这个知识点讲透彻:说清它是什么、为什么这样、怎么运作,必要时补充关键细节和易错点。',
  example: '围绕这个知识点举一个具体、贴近实际的例子(生活类比、代码片段或计算示例均可),通过例子帮助理解。',
  ask: '直接、准确地回答学生的追问。',
};

async function streamAnswer({ topic, context, mode, question, history, subject, web } = {}, { onToken, onThinking, onStatus } = {}) {
  if (onStatus) onStatus('正在检索知识库…');
  const query = String([topic, question || context].filter(Boolean).join(' ') || topic || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const g = await gatherMaterial(query || topic, subject, web);
  if (g.empty) {
    return { empty: true, message: '知识库里没有与这个问题相关的资料,换个问法或先上传相关课件。', citations: [], full: '', webCitations: [] };
  }
  const instr = ANSWER_MODES[mode] || ANSWER_MODES.ask;
  const sys = '你是以知识库资料为主答疑的白板家教。主体严格根据【资料】回答,不引入资料之外的知识。' +
    (g.hasWeb ? '若确需引用【网络】资料作补充,在相关句子末尾标注「(来自网络)」,不得当作知识库结论。' : '') +
    instr + '回答要简洁聚焦、口语化,控制在 120-260 字,可用 Markdown(关键概念用 **加粗**,必要时用短列表;公式用 $...$ 或 $$...$$,代码用 ``` 围栏)。' +
    '除非确有必要不要画图;直接输出回答正文。' + FINAL_ONLY;
  const lead = '学生正在学习课题:' + (topic || '') + '\n他不理解的知识点是:\n' + (context || '') + '\n' +
    (question ? '他的追问:' + question + '\n' : '') + '\n可用资料:\n' + g.material;
  const messages = [{ role: 'system', content: sys }];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (h && (h.role === 'user' || h.role === 'assistant') && h.content) messages.push({ role: h.role, content: String(h.content) });
    }
  }
  messages.push({ role: 'user', content: lead });
  if (onStatus) onStatus('正在解答…');
  const full = await llm.chatStream(messages, { temperature: 0.5, onToken, onThinking });
  return { empty: false, full, citations: g.citations, webCitations: g.webCitations };
}

module.exports = { prepareLesson, streamLesson, streamAnswer };
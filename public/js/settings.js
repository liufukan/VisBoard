import { $, $$, esc, getJSON, postJSON, toast, refreshConn } from './util.js';

const MODELS = [
  { id: 'qwen3.8-chat', tag: '推荐', note: '非推理模型 · 流式首字快，最适合白板边讲边画。' },
  { id: 'deepseek-flash', tag: '推理', note: '推理模型 · 讲解更深入，但首字延迟较高，等待更久。' },
  { id: 'qwen-chat', tag: '通用', note: '通用对话模型，速度中等。' },
  { id: 'glm-5.3-flash', tag: '备选', note: '备选对话模型，可作为对照。' },
  { id: 'deepseek-flash-2', tag: '推理', note: '推理模型 · 首字较慢，适合不赶时间的深讲。' },
  { id: 'qwen3.8-flash-next', tag: '备选', note: '备选快速模型。' },
];

export function mount(view) {
  view.innerHTML = `
    <div class="page-head">
      <span class="eyebrow">Settings</span>
      <h1>设置</h1>
      <p>查看后端连接与密钥状态，切换讲解模型。密钥只保存在后端 config.json，永不发送到浏览器。</p>
    </div>
    <div class="settings-grid">
      <div class="card">
        <h2>连接与密钥</h2>
        <p class="sub">后端代理负责调用大模型，前端只与本网页通信。</p>
        <div class="kv"><span class="k">接口地址</span><span class="v" id="cfgBase">—</span></div>
        <div class="kv"><span class="k">当前模型</span><span class="v" id="statusModel">—</span></div>
        <div class="kv"><span class="k">密钥状态</span><span class="v" id="cfgKey"><span class="chip">读取中…</span></span></div>
        <div class="kv"><span class="k">联网搜索密钥</span><span class="v" id="cfgSearchKey"><span class="chip">读取中…</span></span></div>
        <p class="hint" style="margin:8px 0 0">搜索密钥可选。在 <code>config.json</code> 的 <code>searchApiKey</code> 填入 DeepSeek 密钥（platform.deepseek.com 获取，与生成密钥相互独立）后，白板 / 备课 / 复习的「联网拓展」开关才生效；留空则始终只用知识库。联网搜索按次计费（约 ¥5/千次），生成内容仍用上面的学校密钥。</p>
        <div class="set-actions">
          <button class="btn ghost sm" id="testBtn">测试连接</button>
          <span class="hint">修改地址 / 密钥请编辑后端 config.json 后重启。</span>
        </div>
        <div class="key-guide" id="keyGuide" hidden>
          <h4>三步填入 API 密钥</h4>
          <ol>
            <li>用编辑器打开后端配置文件 <code>D:\\visboard\\config.json</code>。</li>
            <li>在 <code>apiKey</code> 一栏填入你的密钥（学校免费 key 或 DeepSeek key 均可，均为 OpenAI 兼容）。</li>
            <li>保存后重启后端（<code>npm start</code>），回到本页点「测试连接」确认就绪。</li>
          </ol>
          <p class="hint">密钥只保存在后端，绝不下发到浏览器；第 0–3 步（上传/管理知识库）无需密钥，检索与讲解起需要。</p>
        </div>
        <div class="privacy">
          <h4>数据与隐私</h4>
          <ul>
            <li>知识库全部存储在本地 D:\\visboard\\kb，不上传云端。</li>
            <li>AI 以你上传的资料为主教学；仅当开启「联网拓展」时补充网络内容，并单独标注来源。</li>
            <li>API 密钥仅存于后端 config.json，绝不下发到前端。</li>
          </ul>
        </div>
      </div>

      <div class="card">
        <h2>讲解模型</h2>
        <p class="sub">白板讲解走流式输出，非推理模型首字更快、体验更顺。</p>
        <div class="model-picks" id="modelPicks">
          ${MODELS.map(m => `<button type="button" data-model="${esc(m.id)}" title="${esc(m.note)}">${esc(m.id)}<span class="mtag">${esc(m.tag)}</span></button>`).join('')}
        </div>
        <div class="model-note hint" id="modelNote"></div>
        <label class="field-label" for="modelInput">或手动填写模型名</label>
        <input type="text" id="modelInput" placeholder="例如：qwen3.8-chat" autocomplete="off">
        <div class="set-actions">
          <button class="btn" id="saveModel">保存模型</button>
          <span class="cur-line">当前生效：<b id="curModel">—</b></span>
        </div>
      </div>
    </div>`;

  const input = $('#modelInput'), saveBtn = $('#saveModel'), testBtn = $('#testBtn'), noteEl = $('#modelNote');
  let savedModel = '';

  function showNote(model) {
    const m = MODELS.find(x => x.id === model);
    noteEl.textContent = m ? m.note : (model ? '自定义模型，请确认接口支持该名称。' : '');
  }
  function syncPills() {
    const v = input.value.trim();
    $$('#modelPicks button').forEach(b => b.classList.toggle('active', b.dataset.model === v));
  }

  async function save() {
    const model = input.value.trim();
    if (!model) { toast('请输入模型名', 'warn'); input.focus(); return; }
    if (model.length > 80) { toast('模型名过长（≤80 字符）', 'warn'); return; }
    saveBtn.disabled = true;
    try {
      const d = await postJSON('/api/model', { model });
      savedModel = d.model;
      $('#statusModel').textContent = savedModel;
      $('#curModel').textContent = savedModel;
      syncPills();
      await refreshConn();
      toast('已切换模型：' + savedModel, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { saveBtn.disabled = false; }
  }

  async function testConn() {
    testBtn.disabled = true;
    try {
      const d = await getJSON('/api/health');
      await refreshConn();
      $('#keyGuide').hidden = d.hasKey;
      toast(d.hasKey ? '后端连接正常，密钥就绪' : '后端已连接，但未配置密钥', d.hasKey ? 'ok' : 'warn');
    } catch (e) { toast('连接失败：' + e.message, 'err'); }
    finally { testBtn.disabled = false; }
  }

  $('#modelPicks').addEventListener('click', e => {
    const b = e.target.closest('button[data-model]'); if (!b) return;
    input.value = b.dataset.model; syncPills(); showNote(b.dataset.model);
  });
  $('#modelPicks').addEventListener('mouseover', e => {
    const b = e.target.closest('button[data-model]'); if (b) showNote(b.dataset.model);
  });
  input.addEventListener('input', () => { syncPills(); showNote(input.value.trim()); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  saveBtn.addEventListener('click', save);
  testBtn.addEventListener('click', testConn);

  (async () => {
    try {
      const d = await getJSON('/api/config');
      savedModel = d.model || '';
      $('#cfgBase').textContent = d.baseUrl || '—';
      $('#statusModel').textContent = savedModel || '—';
      $('#curModel').textContent = savedModel || '—';
      $('#cfgKey').innerHTML = d.hasKey
        ? '<span class="chip green">已配置 · 仅存后端</span>'
        : '<span class="chip amber">未配置</span>';
      $('#cfgSearchKey').innerHTML = d.hasSearchKey
        ? '<span class="chip green">已配置 · 仅存后端</span>'
        : '<span class="chip amber">未配置 · 联网拓展不可用</span>';
      $('#keyGuide').hidden = d.hasKey;
      input.value = savedModel;
      syncPills(); showNote(savedModel);
    } catch (e) {
      $('#cfgKey').innerHTML = '<span class="chip amber">读取失败</span>';
      toast(e.message, 'err');
    }
  })();

  return null;
}
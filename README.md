# VisBoard

> 把你自己的课件与教材，变成一位随叫随到的 AI 家教。
> 以**你的知识库为主**来教你：边画边讲、点不懂就深入、课后笔记小测、错点再讲，直到教会。

VisBoard 是一个本地优先 AI 家教。它不依赖任何付费托管服务：你上传资料搭建知识库，准备一个大模型 API Key（任意 OpenAI 兼容接口即可），剩下的备课、讲解、追问、复习、导出全部在本机完成。

---

## 功能特性

**本地知识库（RAG）**
- 上传 `.txt` / `.md` / `.pdf` / `.docx` / `.pptx`，自动解析、切块、存储。
- 按科目分区管理，随时增删资料、调整归属。
- 采用「AI 引导检索」：由大模型直接挑选相关片段，**无需向量数据库或额外嵌入模型**，只用你已有的 Key。

**AI 备课 · 讲解提纲**
- 输入课题，AI 先依据知识库列一份**讲解提纲**，让你预览这堂课即将学什么。
- 不满意？填写修改意见（或点建议标签：更通俗易懂 / 多加例子 / 精简一些 / 更深入 / 调整顺序），AI 据此迭代调整提纲。
- 满意后一键上白板，**白板严格按你确认的提纲展开**——「即将要学的」和实际讲的内容完全一致。

**白板讲解**
- 可缩放、可平移的真白板，AI 逐个插入文字框与示意图，边画边讲。
- 示意图由 AI 生成 SVG 代码，前端渲染并逐笔动画呈现（不花图像生成的钱）。
- 流式输出（SSE），讲解过程实时可见；讲解中切页会弹窗确认，避免误清白板。

**点击深入**
- 点上不懂的知识点，就近弹出追问框：再简单点 / 解释一下 / 举个例子 / 自由提问。
- 支持多轮追问，连线清晰不遮挡。

**笔记 · 小测 · 再讲**
- 一键生成本课复习笔记。
- 多题型小测：单选、多选、判断、填空、简答（简答由 AI 判分）。
- 针对错点与薄弱点再讲一遍，形成「学—测—补」闭环。

**导出本课**
- 一键导出**自包含 HTML**（白板讲解 + 追问对话 + 复习笔记），离线可看、可打印、可分享。

**联网拓展（可选）**
- 若你的 Key 不具备联网搜索功能，则需要额外准备一个可联网搜索的 API Key
- 仅在开启且知识库资料不足时补充网络背景，来源清晰区分「资料」与「网络」。
- 不填搜索 Key 也能正常使用，自动降级为纯知识库模式。

**界面**
- 多页面单页应用（SPA），可折叠侧边栏，深色「蓝图工作室」主题，响应式布局。

---

## 快速开始

### 环境要求
- [Node.js](https://nodejs.org/) **≥ 18**（用到全局 `fetch`，建议在 18/20/24 上运行）。
- 一个 OpenAI 兼容的大模型 API Key（DeepSeek、OpenAI、或学校提供的免费接口等均可）。

### 安装与运行

```bash
# 1. 克隆仓库
git clone https://github.com/liufukan/VisBoard.git
cd VisBoard

# 2. 安装依赖
npm install

# 3. 启动（首次运行会自动生成空密钥的 config.json）
npm start

# 4. 打开 config.json 填入你的 apiKey（见下方「配置说明」），保存后重启 npm start
```

启动后浏览器打开 **http://localhost:3000** 即可使用。

> `config.json` 已 **gitignore**：首次 `npm start` 会自动生成一份空密钥模板，你填入的 Key 只存本机、不会进入 git。`kb/` 与 `uploads/` 目录已用占位文件保留，可直接上传资料。

---

## 配置说明

所有配置都在后端 `config.json`（**Key 只存后端，绝不发给前端**）：

| 字段 | 说明 | 示例 / 默认 |
| --- | --- | --- |
| `port` | 服务端口 | `3000` |
| `baseUrl` | OpenAI 兼容接口地址 | `https://api.deepseek.com/v1` |
| `apiKey` | **生成用密钥（必填）** | 你的 Key |
| `model` | 生成模型名 | `deepseek-chat` |
| `searchApiKey` | 联网搜索密钥（可以与 `apiKey` 一致） | 留空则禁用联网 |
| `searchProvider` | 搜索服务商 | `deepseek`（亦兼容 `bocha`） |

**生成接口可以是任意 OpenAI 兼容服务**，例如：

```jsonc
// DeepSeek
{ "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" }

// 学校免费接口（以中科大为例）
{ "baseUrl": "https://api.llm.ustc.edu.cn/v1", "model": "qwen3.8-chat" }

// OpenAI
{ "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" }
```

**联网搜索**默认走 DeepSeek 官方 Search API（`POST /v1/tools/search`，约 ¥5/千次），`searchApiKey` 需填一个 DeepSeek 密钥（[platform.deepseek.com](https://platform.deepseek.com) 获取）。若你的生成 Key 也是 DeepSeek，可与 `apiKey` 填同一个；若生成用的是学校等其他接口，则需另备一个 DeepSeek 搜索 Key。只有开启「联网拓展」且资料不足时才会动用搜索 Key。

---

## 使用流程

1. **搭建知识库** — 在「知识库」页上传课件/教材，按科目分区。这是 AI 教学的主要依据。
2. **AI 备课** — 在「AI 备课」页输入课题，生成讲解提纲；不满意就填修改意见迭代，直到满意。
3. **白板讲解** — 点「去白板讲解」，AI 按提纲在白板上边画边讲。
4. **点击深入** — 点不懂的知识点，就近追问（更简单 / 解释 / 举例 / 自由提问）。
5. **笔记小测** — 在「笔记小测」页生成笔记与多题型小测，错点再讲。
6. **导出本课** — 一键导出自包含 HTML，离线复习或分享。

---

## 技术栈

- **后端**：Node.js + Express 5；`multer` 处理上传；`pdf-parse` / `mammoth` / `officeparser` 解析文档；SSE 流式推送。
- **前端**：原生 HTML / CSS / JavaScript，浏览器原生 ES Modules，**无框架、无构建步骤**。
- **大模型**：任意 OpenAI 兼容接口（DeepSeek / OpenAI / 学校接口…）。
- **检索**：AI 引导检索（大模型挑选片段），无向量库、无嵌入模型。
- **示意图**：AI 生成 SVG，前端渲染 + 逐笔动画。
- **存储**：知识库与上传文件存本机 JSON / 原始文件；课程记录存浏览器 `localStorage`。

---

## 项目结构

```
VisBoard/
├─ server.js            后端：静态托管 + 上传解析 + 知识库 + 检索 + LLM/SSE 路由
├─ config.json          配置（gitignore；首次启动自动生成，填入你的 Key）
├─ package.json
├─ lib/
│  ├─ parse.js          文档解析（txt/md/pdf/docx/pptx）
│  ├─ kb.js             知识库切块存储与科目管理
│  ├─ retrieve.js       AI 引导检索
│  ├─ material.js       资料聚合 + 可选联网补充
│  ├─ llm.js            OpenAI 兼容客户端（chat / chatStream）
│  ├─ search.js         联网搜索（DeepSeek / Bocha）
│  ├─ teach.js          备课提纲 / 白板讲解 / 追问
│  └─ review.js         笔记 / 小测 / 判分
├─ public/
│  ├─ index.html        单页入口
│  ├─ style.css         深色蓝图主题
│  └─ js/               前端模块（路由/知识库/备课/白板/复习/设置等）
├─ kb/                  知识库存储（本机，已 gitignore）
└─ uploads/             上传的原始文件（本机，已 gitignore）
```

---

## 隐私与安全

- **API Key 只存后端 `config.json`**，永远不会发送到前端。
- `config.json` 已 **gitignore**，首次启动自动生成空模板；你填入的 Key 只存本机，正常提交/推送不会带上它。
- **知识库与上传文件只存本机**（`kb/`、`uploads/`），不上传任何云端。
- 联网拓展为可选；关闭时除调用你自己的大模型接口外，完全本地运行。

---

## FAQ

- **扫描版 PDF（图片型）能识别吗？** 暂时不能。这类 PDF 提不出文字，需后续接入 OCR 才支持；文字版 PDF 正常。
- **不填 `searchApiKey` 能用吗？** 能。联网拓展会自动降级为纯知识库模式，其余功能不受影响。
- **必须用 DeepSeek 吗？** 不。生成接口兼容任意 OpenAI 兼容服务，改 `baseUrl` / `model` 即可；学校免费 Key 也能直接用。
- **改了前端代码没生效？** 前端无构建，但浏览器会缓存 ES Module，请硬刷新（Ctrl+F5）。

---

## 开发

```bash
npm start                 # 启动服务
node --watch server.js    # 后端改动自动重启（Node ≥ 18）
```

前端位于 `public/`，直接编辑后硬刷新浏览器即可，无需打包。

---

## 许可证

本项目暂未指定许可证。
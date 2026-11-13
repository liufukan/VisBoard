# 扫描件 OCR 入库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让扫描 PDF（整本无文字层 + 混合页）与独立图片（.png/.jpg/.jpeg）经本地 OCR 回填文字进入知识库，可被检索与讲解；完全本地、不联网、无需密钥。

**Architecture:** 方案 1（独立 OCR 模块 + 专用路由 + 按钮，仿阶段3回填）。上传流不变：`extract` 把"扫描页整页图"归入新字段 `scans`（OCR 候选，不进图片管线），"文字页插图"仍归 `images`；`addDoc` 只存 `images` 并置 `scanned` 标志。OCR 流（新）：点"OCR 识别"→ `POST /api/kb/:id/ocr` → 找原始上传 → `extract` 取 `scans` → `ocr.ocrDoc`（逐张 `ocrImage`）→ 文字写回 `pages` → `kb.setDocText` 重新切块更新。

**Tech Stack:** Node v24 + Express 5（CommonJS 后端）；原生 ES module 前端（无构建）；tesseract.js（WASM，本地）+ `@tesseract.js-data/chi_sim`/`eng`（本地训练数据）；pdf-parse v2.4.5（getText/getImage 复用）；pdf-lib（test-only devDep，制扫描 PDF 夹具）。测试 = 一次性 `node:assert` 脚本 + 浏览器实测（项目无测试框架）。

**Spec:** `docs/superpowers/specs/2026-11-13-scanned-ocr-design.md`

## Global Constraints

- 新增 npm 依赖：`tesseract.js`、`@tesseract.js-data/chi_sim`、`@tesseract.js-data/eng`；`pdf-lib` 仅 test-only devDep（夹具）。**运行时完全离线、无需 API 密钥**；训练数据本地化到 gitignored `ocr-data/`。
- 阶段2电路管线（pdflatex、circuit 禁中文、标签防重叠、func 图像）保持不变；阶段3图片提取/展示/导出管线保持不变（**文字 PDF 的 `images` 行为不变**）；`lib/teach.js` sys prompt 与 figRule 不改。
- `config.json` 保持 gitignored / staged-deletion；API key 仅后端，绝不打印 key 片段、绝不 `git add config.json` 或 `git add -f`；OCR 不涉及密钥。
- **代理不执行 git commit / push**；所有提交由用户在全部完成后统一 push。每个 Task 以验证结束，**不含 commit 步骤**。
- **不得 kill / restart 现有 dev server（PID 2660, port 3000）**。HTTP/e2e 测试用独立测试实例：`PORT=3001 node server.js`（Task 4 加 1 行 `process.env.PORT` 覆盖，默认行为不变）。
- 路径安全：doc id 沿用 `ID_RE = /^[a-zA-Z0-9-]+$/`；OCR 只读 `uploads/<id>.*`（同回填）。
- 上限/门限：`MAX_OCR_PAGES=50`/次；扫描页判定 `SCAN_TEXT_THRESHOLD=16`（页文字 trim 长度 < 16）且 `SCAN_MIN_DIM=300`（图 min(w,h) ≥ 300）；扫描页取最大图为 scan，该页所有图不进 `images`。
- 范围：仅扫描 PDF（含混合页）+ 独立图片的 OCR；不做 PPTX/DOCX OCR、矢量图捕获、上传时自动 OCR、云端 OCR、手写体专门优化、AI 主动插图。
- OCR 单页失败 → catch 跳过该页继续（部分成功）； traineddata 缺失/worker 失败 → 500 明确报错；OCR 空结果 → 存空文字 + 提示。
- 所有探针/测试脚本与夹具写到系统临时目录 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/`，属一次性产物，不进仓库。`ocr-data/`（训练数据）是运行时资产，留仓库根但 gitignored。
- 改动最小化（"不要对项目作过大改动"）：复用阶段3回填模式，OCR 隔离为小子系统。

## 已核实的接口事实（实施据此编码）

**现有管线**（已读源码确认）：
- [lib/parse.js:44] `extract(filePath)` 现返回 `{ kind, pages:[{page,text}], images:[{page,data:Buffer,w,h,ext}] }`。`SUPPORTED=['.txt','.md','.pdf','.docx','.pptx']`（[lib/parse.js:7]）。
- `sniffImage(buf)`（[lib/parse.js:24]）→ `{ext:'png'|'jpeg', w, h} | null`（魔数 PNG `89 50 4E 47` / JPEG `FF D8`，buf<24 返回 null）。**复用，不改**。
- PDF：`new PDFParse({data:Uint8Array})`；`await parser.getText()`→`{pages:[{num,text}]}`；`await parser.getImage({imageThreshold:80,imageDataUrl:false})`→`{pages:[{pageNumber(1起始),images:[{data:Uint8Array,width,height,…}]}]}`；`finally await parser.destroy()`。扫描 PDF 的 getText 页文字为空、getImage 返回整页扫描图。
- [lib/kb.js] `chunkPages(pages)`（CHUNK=800,OVERLAP=100）；`writeImages(id,images)`（每页4/每doc60，先清旧目录再写，返回 `[{id,page,w,h,file}]`）；`addDoc({id,name,kind,pages,subject,images})`；`setDocImages(id,images)`（[lib/kb.js:116]，重处理+更新范例）；`getDoc`/`listDocs`/`deleteDoc`（deleteDoc 已连带删 uploads/<id>.* 与 kb/images/<id>）。`ID_RE=/^[a-zA-Z0-9-]+$/`。
- [server.js:65] `/api/upload`：multer disk → `extract(f.path)` → `kb.addDoc({id,name,kind,pages,subject,images})`。[server.js:96] `/api/kb/:id/images`（回填）：ID 校验→getDoc→uploads 找 `<id>.*`（`f.startsWith(id+'.') && !f.endsWith('.json')`）→extract→setDocImages→`{ok,count}`；无原文件 400。[server.js:294] `const port = config.port || 3000; app.listen(port,…)`（require 即监听）。
- [public/js/kb.js]：`ACCEPT`（line 3）；doc 行渲染（line 97-107，doc-img 按钮 line 105）；`$('#docList').addEventListener('click',…)`（line 171-189，doc-img 分支 line 172-181 → doc-del 分支 line 182-188）。`postJSON(url,body)`/`toast(msg,type)`/`load()` 来自 util.js / 本模块。

**tesseract.js（Task 1 探针确认，不得猜测）**：设计意图 `createWorker('chi_sim+eng', 1, { langPath:<本地 ocr-data 目录> })` → `worker.recognize(buffer)` → `{data:{text}}`。`langPath` 为单一目录，`chi_sim+eng` 需两个 `.traineddata.gz` 同处该目录。Task 1 探针确认当前稳定版确切 API 与离线接线；若 npm 数据包归并不便，回退一次性从官方 tessdata 源（tessdata.projectnaptha.com，真实源、非代理）下载两个 `.traineddata.gz` 到 `ocr-data/`。

**夹具生成工具链（已确认在 PATH）**：`xelatex`、`pdftoppm`（MiKTeX/poppler）。XeLaTeX+SimHei 渲染中文（用户已验证可行）。

## File Structure

| 文件 | 职责 | 任务 |
|---|---|---|
| `lib/ocr.js`（新） | tesseract 封装：`ocrImage(buffer)→text`（T1）；`ocrDoc(parsed)→{pages,ocrPages,chars,truncated}` 编排（T4） | T1, T4 |
| `lib/parse.js` | extract 扩展：图片分支 + 扫描页检测 + `scans`/`scanned` 契约 | T2 |
| `lib/kb.js` | `setDocText` + `scanned` 标志 + `listDocs.scanned` | T3 |
| `server.js` | `POST /api/kb/:id/ocr` + upload 传 scanned + PORT 覆盖 | T4 |
| `public/js/kb.js` | "OCR 识别"按钮 + ACCEPT/文案 | T5 |
| `package.json` / `.gitignore` | 依赖 + `ocr-data/` 忽略 | T1 |
| `ocr-data/`（新，gitignored） | 本地 chi_sim+eng `.traineddata.gz` | T1 |

---

### Task 1: 依赖 + lib/ocr.js（tesseract 封装）+ PNG 夹具

**Files:**
- Create: `lib/ocr.js`
- Modify: `package.json`（deps）、`.gitignore`（加 `ocr-data/`）
- Create（运行时资产，gitignored）: `ocr-data/chi_sim.traineddata.gz`、`ocr-data/eng.traineddata.gz`
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t1-ocr.js`；夹具 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/fixture.png`

**Interfaces:**
- Consumes: tesseract.js（探针确认 API）；本地 `ocr-data/` 训练数据。
- Produces: `ocr.ocrImage(data: Buffer) → Promise<string>`（识别文字，trim 后；失败抛错）。worker 懒加载单例为模块内部状态。Task 4 复用并增 `ocrDoc`。

- [ ] **Step 1: 装依赖 + gitignore**

```bash
cd /d/GithubRepo/VisBoard
npm i tesseract.js @tesseract.js-data/chi_sim @tesseract.js-data/eng
npm i -D pdf-lib
```
在 `.gitignore` 的 `# ---- Dev scratch / local test fixtures ----` 段后加一行：
```
ocr-data/
```
记录装到的 tesseract.js 版本（`node -e "console.log(require('tesseract.js/package.json').version)"`）。

- [ ] **Step 2: 生成 PNG 夹具（已知文字）**

建临时目录与 tex：
```bash
mkdir -p "C:/Users/陈女士/AppData/Local/Temp/vb-ocr"
```
写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/fixture.tex`：
```latex
\documentclass[12pt]{article}
\usepackage{xeCJK}
\setCJKmainfont{SimHei}
\usepackage[margin=2cm]{geometry}
\pagestyle{empty}
\begin{document}
\Large
半导体存储器是计算机的重要组成部分。

ARM 处理器通过总线访问存储器。

The memory system includes cache and main memory.
\end{document}
```
渲染并转 PNG：
```bash
cd "C:/Users/陈女士/AppData/Local/Temp/vb-ocr"
xelatex -interaction=nonstopmode fixture.tex
pdftoppm -png -r 150 -singlefile fixture.pdf fixture
```
预期产出 `fixture.png`（含已知中英文文字）。ground truth 关键词：`存储器`、`ARM`、`memory`、`cache`。

- [ ] **Step 3: 探针确认 tesseract API + 离线 langPath 接线**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/probe.js`：
```js
const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('D:/GithubRepo/VisBoard/node_modules/tesseract.js');
const ROOT = 'D:/GithubRepo/VisBoard';
const OCR_DATA = path.join(ROOT, 'ocr-data');
fs.mkdirSync(OCR_DATA, { recursive: true });
// 从 npm 数据包归并两个 .traineddata.gz 到单一目录
for (const lang of ['chi_sim', 'eng']) {
  const pkgDir = path.dirname(require.resolve('@tesseract.js-data/' + lang + '/package.json', { paths: [ROOT] }));
  const gz = fs.readdirSync(pkgDir).find(f => f.endsWith('.traineddata.gz'));
  if (!gz) { console.error('NO traineddata in', pkgDir, fs.readdirSync(pkgDir)); process.exit(1); }
  fs.copyFileSync(path.join(pkgDir, gz), path.join(OCR_DATA, lang + '.traineddata.gz'));
  console.log('copied', lang, gz);
}
(async () => {
  const worker = await createWorker('chi_sim+eng', 1, { langPath: OCR_DATA });
  const { data } = await worker.recognize(fs.readFileSync('C:/Users/陈女士/AppData/Local/Temp/vb-ocr/fixture.png'));
  console.log('TEXT_LEN', (data.text || '').length);
  console.log('TEXT_SAMPLE', JSON.stringify((data.text || '').slice(0, 120)));
  await worker.terminate();
})().catch(e => { console.error('PROBE_FAIL', e); process.exit(1); });
```
运行：`node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/probe.js"`。
- 若成功打印 TEXT_LEN>0 且含关键词 → 接线确认：`createWorker('chi_sim+eng',1,{langPath:OCR_DATA})` + `recognize(buffer)`→`{data:{text}}`，`ocr-data/` 含两个 `.gz`。
- 若 `require.resolve('@tesseract.js-data/…/package.json')` 或 gz 定位失败：改用 `path.join(ROOT,'node_modules','@tesseract.js-data',lang)` 直接列目录找 `.traineddata.gz`。
- 若 npm 数据包不可用：回退一次性下载（真实官方源，非代理）：
  `curl -L -o ocr-data/chi_sim.traineddata.gz https://tessdata.projectnaptha.com/4.0.0/chi_sim.traineddata.gz` 与 `…/eng.traineddata.gz`。
- 若 createWorker/recognize API 与上述不符（版本差异）：按实际 API 调整，**记录确切签名到本任务报告**，Step 6 实现据此编码。不得猜测。
- **离线确认**：probe 运行时 langPath 指向本地 `ocr-data/`，不应有 CDN 请求；若 tesseract 仍尝试网络，设 `cachePath` 本地或按探针结果调整至完全离线。

- [ ] **Step 4: 写失败测试**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t1-ocr.js`：
```js
const assert = require('node:assert');
const fs = require('node:fs');
const ocr = require('D:/GithubRepo/VisBoard/lib/ocr');
const FIX = 'C:/Users/陈女士/AppData/Local/Temp/vb-ocr/fixture.png';
(async () => {
  const text = await ocr.ocrImage(fs.readFileSync(FIX));
  assert.ok(typeof text === 'string', '返回字符串');
  assert.ok(text.trim().length > 0, '识别文字非空');
  assert.ok(/memory|ARM|存储器|cache/i.test(text), '含至少一个已知关键词: ' + JSON.stringify(text.slice(0, 80)));
  // 复用单例：第二次调用应同样成功（worker 复用）
  const text2 = await ocr.ocrImage(fs.readFileSync(FIX));
  assert.ok(text2.trim().length > 0, '第二次识别非空（worker 复用）');
  console.log('T1 OK len=' + text.length + ' sample=' + JSON.stringify(text.slice(0, 60)));
  process.exit(0);
})().catch(e => { console.error('T1 FAIL', e); process.exit(1); });
```

- [ ] **Step 5: 运行确认 RED**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t1-ocr.js"`
Expected: FAIL（`Cannot find module 'D:/GithubRepo/VisBoard/lib/ocr'`）。

- [ ] **Step 6: 实现 lib/ocr.js**

写 `lib/ocr.js`（按 Step 3 探针确认的 API；以下为标准 v5 形态，若探针记录不同则据实调整）：
```js
const path = require('path');
const { createWorker } = require('tesseract.js');

const LANG_PATH = path.join(__dirname, '..', 'ocr-data');
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('chi_sim+eng', 1, { langPath: LANG_PATH });
  }
  return workerPromise;
}

async function ocrImage(data) {
  const worker = await getWorker();
  const { data: { text } } = await worker.recognize(data);
  return (text || '').trim();
}

module.exports = { ocrImage };
```

- [ ] **Step 7: 运行确认 GREEN**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t1-ocr.js"`
Expected: PASS（`T1 OK len=…`）。首次加载训练数据数秒，第二次快（单例复用）。

- [ ] **Step 8: 离线 + 语法验证**

Run: `node --check lib/ocr.js`（预期 OK）。确认 `ocr-data/` 含 `chi_sim.traineddata.gz` + `eng.traineddata.gz`，`git status -s` 中 `ocr-data/` 被忽略（不出现）、`package.json`/`package-lock.json`/`.gitignore` 为 M。报告记录 tesseract 版本与确切 API。

---

### Task 2: lib/parse.js — 图片分支 + 扫描页检测 + scans/scanned 契约

**Files:**
- Modify: `lib/parse.js`（`SUPPORTED` 加图片；新图片分支；PDF 分支扫描页检测 + scan/figure 分离；txt/md/docx/pptx 返回加 `scans:[]`/`scanned:false`）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t2-parse.js`；扫描 PDF 夹具 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/scanned.pdf`

**Interfaces:**
- Consumes: `sniffImage`（现有，不改）；pdf-parse getText/getImage（现有）；Task 1 的 `fixture.png`。
- Produces: `extract(filePath)` 返回 `{ kind, pages:[{page,text}], images:[{page,data,w,h,ext}], scans:[{page,data,w,h,ext}], scanned:boolean }`。`images`=文字页插图（阶段3行为不变）；`scans`=扫描页/图片文档整页图（每扫描页取最大一张，OCR 候选）；`scanned = scans.length>0`。`SUPPORTED` 含 `.png/.jpg/.jpeg`。Task 4 路由消费 `scans`/`scanned`/`kind`。

- [ ] **Step 1: 制扫描 PDF 夹具（pdf-lib 嵌入 Task1 PNG，无文字层）**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/make-scanned.js`：
```js
const fs = require('node:fs');
const { PDFDocument } = require('D:/GithubRepo/VisBoard/node_modules/pdf-lib');
(async () => {
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(fs.readFileSync('C:/Users/陈女士/AppData/Local/Temp/vb-ocr/fixture.png'));
  const page = pdf.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  fs.writeFileSync('C:/Users/陈女士/AppData/Local/Temp/vb-ocr/scanned.pdf', await pdf.save());
  console.log('scanned.pdf made', img.width, img.height);
})().catch(e => { console.error(e); process.exit(1); });
```
Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/make-scanned.js"`（预期打印尺寸）。

- [ ] **Step 2: 写失败测试**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t2-parse.js`：
```js
const assert = require('node:assert');
const { extract, SUPPORTED } = require('D:/GithubRepo/VisBoard/lib/parse');
const FIX_PNG = 'C:/Users/陈女士/AppData/Local/Temp/vb-ocr/fixture.png';
const SCANNED = 'C:/Users/陈女士/AppData/Local/Temp/vb-ocr/scanned.pdf';
const TEXT_PDF = 'D:/GithubRepo/VisBoard/uploads/0801da9e-3c28-45a6-a7f4-44beb106007f.pdf'; // 阶段3 T1 文字 PDF（含插图）
(async () => {
  assert.ok(SUPPORTED.includes('.png') && SUPPORTED.includes('.jpg') && SUPPORTED.includes('.jpeg'), 'SUPPORTED 含图片');
  // 图片分支
  const img = await extract(FIX_PNG);
  assert.strictEqual(img.kind, 'image');
  assert.strictEqual(img.pages.length, 1);
  assert.strictEqual(img.pages[0].text, '');
  assert.deepStrictEqual(img.images, []);
  assert.strictEqual(img.scans.length, 1);
  assert.strictEqual(img.scanned, true);
  assert.ok(img.scans[0].data.length > 0 && img.scans[0].w > 0, 'scan 有字节与尺寸');
  // 扫描 PDF
  const sp = await extract(SCANNED);
  assert.strictEqual(sp.kind, 'pdf');
  assert.strictEqual(sp.scanned, true);
  assert.ok(sp.scans.length >= 1, '扫描 PDF 检出扫描页');
  assert.deepStrictEqual(sp.images, [], '扫描页图不进 images');
  assert.ok(sp.pages.every(p => (p.text || '').trim().length < 16), '扫描页文字空');
  // 回归：文字 PDF（阶段3 T1 夹具）images 不变、scans 空
  const tp = await extract(TEXT_PDF);
  assert.strictEqual(tp.kind, 'pdf');
  assert.ok(Array.isArray(tp.images) && tp.images.length > 0, '文字 PDF 插图仍在 images（阶段3不变）');
  assert.deepStrictEqual(tp.scans, [], '文字 PDF 无 scans');
  assert.strictEqual(tp.scanned, false);
  console.log('T2 OK imageKind=' + img.kind + ' scannedPdfScans=' + sp.scans.length + ' textPdfImages=' + tp.images.length);
  process.exit(0);
})().catch(e => { console.error('T2 FAIL', e); process.exit(1); });
```
注：`TEXT_PDF` 用阶段3 T1 同一夹具（`uploads/0801da9e-…pdf`，50页含12图）；若该文件不在，改用 KB 任一文字 PDF（`uploads/` 下含插图者），并在报告注明实际路径。

- [ ] **Step 3: 运行确认 RED**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t2-parse.js"`
Expected: FAIL（`SUPPORTED 含图片` 断言失败，或图片分支抛"不支持的文件类型"）。

- [ ] **Step 4: 实现 parse.js 扩展**

4a. `SUPPORTED`（line 7）改为：
```js
const SUPPORTED = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.png', '.jpg', '.jpeg'];
```
4b. txt/md 分支返回加字段（line 49）：
```js
    return { kind: ext.slice(1), pages: [{ page: null, text: fs.readFileSync(filePath, 'utf8') }], images: [], scans: [], scanned: false };
```
4c. 在 txt/md 分支之后、pdf 分支之前，新增图片分支：
```js
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const data = fs.readFileSync(filePath);
    const meta = sniffImage(data);
    if (!meta) throw new Error('无法识别的图片格式');
    return { kind: 'image', pages: [{ page: 1, text: '' }], images: [], scans: [{ page: 1, data, w: meta.w, h: meta.h, ext: meta.ext }], scanned: true };
  }
```
4d. PDF 分支整体替换为（保留 getText/getImage/destroy，新增扫描页检测与分离）：
```js
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
    try {
      const r = await parser.getText();
      const pages = r.pages.map(p => ({ page: p.num, text: p.text }));
      let rawImages = [];
      try {
        const ir = await parser.getImage({ imageThreshold: 80, imageDataUrl: false });
        for (const pg of ir.pages || []) {
          for (const im of pg.images || []) {
            const data = Buffer.from(im.data);
            const meta = sniffImage(data);
            if (!meta) continue;
            rawImages.push({ page: pg.pageNumber, data, w: im.width || meta.w, h: im.height || meta.h, ext: meta.ext });
          }
        }
      } catch (e) { console.warn('PDF 图片提取失败:', e.message); rawImages = []; }
      const SCAN_TEXT_THRESHOLD = 16, SCAN_MIN_DIM = 300;
      const textLenByPage = new Map(pages.map(p => [p.page, (p.text || '').trim().length]));
      const imgsByPage = new Map();
      for (const im of rawImages) {
        const arr = imgsByPage.get(im.page) || [];
        arr.push(im); imgsByPage.set(im.page, arr);
      }
      const scans = [], images = [];
      for (const [page, ims] of imgsByPage) {
        const big = ims.filter(im => Math.min(im.w, im.h) >= SCAN_MIN_DIM);
        if ((textLenByPage.get(page) || 0) < SCAN_TEXT_THRESHOLD && big.length) {
          const largest = big.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
          scans.push(largest);
        } else {
          images.push(...ims);
        }
      }
      return { kind: 'pdf', pages, images, scans, scanned: scans.length > 0 };
    } finally {
      await parser.destroy();
    }
  }
```
4e. docx 分支返回加字段（line 77）：
```js
    return { kind: 'docx', pages: [{ page: null, text: r.value }], images: [], scans: [], scanned: false };
```
4f. pptx 分支返回加字段（line 102）：
```js
  return { kind: 'pptx', pages, images, scans: [], scanned: false };
```

- [ ] **Step 5: 运行确认 GREEN**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t2-parse.js"`
Expected: PASS（`T2 OK …`）。

- [ ] **Step 6: 阶段3回归**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t1-parse.js"`（阶段3 T1 脚本，若仍在 Temp）；否则重跑阶段3 T1 测试逻辑（文字 PDF images=12 pages=50）。
Expected: 阶段3 T1 GREEN（文字 PDF 的 images 行为不变）。`node --check lib/parse.js` OK。报告记录回归结果。

---

### Task 3: lib/kb.js — setDocText + scanned 标志 + listDocs.scanned

**Files:**
- Modify: `lib/kb.js`（`addDoc` 存 `scanned`；新增 `setDocText`；`listDocs` 增 `scanned`；导出 `setDocText`）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t3-kb.js`

**Interfaces:**
- Consumes: `chunkPages`、`writeImages`、`getDoc`（现有，不改）。
- Produces: `kb.setDocText(id, pages, images) → boolean`（重新切块 + 更新 pages/chars/chunks/images，写回 doc.json，`scanned` 保持，ID_RE 校验）；`addDoc({…, scanned})` 存 `doc.scanned`；`listDocs()` 每项增 `scanned`。Task 4 路由调 `setDocText`；Task 5 前端读 `listDocs.scanned`。

- [ ] **Step 1: 写失败测试**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t3-kb.js`：
```js
const assert = require('node:assert');
const kb = require('D:/GithubRepo/VisBoard/lib/kb');
const ID = 't3ocr-test-doc';
(async () => {
  kb.deleteDoc(ID); // 清旧
  const pages = [{ page: 1, text: '' }];
  const doc = kb.addDoc({ id: ID, name: 'ocr-test.pdf', kind: 'pdf', pages, subject: null, images: [], scanned: true });
  assert.strictEqual(doc.scanned, true, 'addDoc 存 scanned');
  assert.strictEqual(doc.chars, 0);
  const listed = kb.listDocs().find(d => d.id === ID);
  assert.strictEqual(listed.scanned, true, 'listDocs 暴露 scanned');
  // setDocText 回填文字 + 重新切块
  const longText = '半导体存储器。'.repeat(200); // >800 字，触发多块
  const ok = kb.setDocText(ID, [{ page: 1, text: longText }], []);
  assert.strictEqual(ok, true, 'setDocText 返回 true');
  const d2 = kb.getDoc(ID);
  assert.strictEqual(d2.chars, longText.length, 'chars 更新');
  assert.ok(d2.chunks.length > 1, '重新切块（多块）');
  assert.strictEqual(d2.scanned, true, 'scanned 保持');
  assert.deepStrictEqual(d2.images, [], 'images 更新为空');
  // 非法 id
  assert.strictEqual(kb.setDocText('../evil', [], []), false, 'ID_RE 校验');
  // 清理
  kb.deleteDoc(ID);
  assert.strictEqual(kb.getDoc(ID), null, '清理后不存在');
  console.log('T3 OK chunks=' + d2.chunks.length + ' chars=' + d2.chars);
  process.exit(0);
})().catch(e => { console.error('T3 FAIL', e); try { kb.deleteDoc(ID); } catch {} process.exit(1); });
```

- [ ] **Step 2: 运行确认 RED**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t3-kb.js"`
Expected: FAIL（`kb.setDocText is not a function` 或 `addDoc 存 scanned` 断言失败）。

- [ ] **Step 3: 实现 kb.js**

3a. `addDoc`（line 58-65）改为接收并存 `scanned`：
```js
function addDoc({ id, name, kind, pages, subject, images, scanned }) {
  const chunks = chunkPages(pages);
  const chars = pages.reduce((n, p) => n + (p.text || '').length, 0);
  const imageList = writeImages(id, images);
  const doc = { id, name, kind, chars, pages: pages.length, chunks, subject: subject || null, images: imageList, scanned: Boolean(scanned), createdAt: Date.now() };
  fs.writeFileSync(path.join(KB_DIR, id + '.json'), JSON.stringify(doc));
  return doc;
}
```
3b. `listDocs`（line 72）的 map 项增 `scanned`：
```js
    .map(d => ({ id: d.id, name: d.name, kind: d.kind, chars: d.chars, pages: d.pages, chunks: d.chunks.length, subject: d.subject || null, imageCount: (d.images || []).length, scanned: Boolean(d.scanned), createdAt: d.createdAt }))
```
3c. 在 `setDocImages`（line 116-123）之后新增 `setDocText`：
```js
function setDocText(id, pages, images) {
  if (!ID_RE.test(id)) return false;
  const d = getDoc(id);
  if (!d) return false;
  d.chunks = chunkPages(pages);
  d.pages = pages.length;
  d.chars = pages.reduce((n, p) => n + (p.text || '').length, 0);
  d.images = writeImages(id, images);
  fs.writeFileSync(path.join(KB_DIR, id + '.json'), JSON.stringify(d));
  return true;
}
```
3d. 导出（line 166-168）加 `setDocText`：
```js
module.exports = {
  chunkPages, addDoc, listDocs, getDoc, deleteDoc, allChunks, ingestLegacyUploads,
  setDocSubject, setDocImages, setDocText, listSubjects, addSubject, deleteSubject,
};
```

- [ ] **Step 4: 运行确认 GREEN**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t3-kb.js"`
Expected: PASS（`T3 OK chunks=… chars=…`），测试 doc 已清理。

- [ ] **Step 5: 语法 + KB 完整性**

Run: `node --check lib/kb.js`（OK）。确认 KB 仍 17 份原文档（`node -e "console.log(require('./lib/kb').listDocs().length)"` → 17），无 t3ocr-test-doc 残留。

---

### Task 4: server.js — /api/kb/:id/ocr 路由 + upload 传 scanned + ocrDoc 编排

**Files:**
- Modify: `lib/ocr.js`（增 `ocrDoc` + `MAX_OCR_PAGES`）
- Modify: `server.js`（require ocr；upload 传 scanned；新 OCR 路由；PORT 覆盖）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t4-ocrdoc.js`（单元，stub ocrImage）+ HTTP 测试（PORT=3001 测试实例）

**Interfaces:**
- Consumes: `ocr.ocrImage`（T1）；`extract`→`{kind,pages,images,scans}`（T2）；`kb.setDocText`（T3）。
- Produces: `ocr.ocrDoc(parsed) → Promise<{pages, ocrPages, chars, truncated}>`（cap 50、逐页 try/catch、文字写回匹配 page、ocrPages=非空成功页数）；`POST /api/kb/:id/ocr` → `{ok, ocrPages, chars, truncated}`（400 非法id/无原文件/非扫描kind，404 不存在，500 异常）。

- [ ] **Step 1: 写失败单元测试（ocrDoc，stub ocrImage）**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t4-ocrdoc.js`：
```js
const assert = require('node:assert');
const ocr = require('D:/GithubRepo/VisBoard/lib/ocr');
(async () => {
  const orig = ocr.ocrImage;
  // stub：按 scan 字节返回已知文字；page=2 抛错验证跳过
  ocr.ocrImage = async (data) => {
    if (data.toString() === 'BAD') throw new Error('boom');
    return '识别文字 ' + data.toString();
  };
  const parsed = {
    kind: 'pdf',
    pages: [{ page: 1, text: '' }, { page: 2, text: '' }, { page: 3, text: '' }],
    scans: [{ page: 1, data: Buffer.from('A') }, { page: 2, data: Buffer.from('BAD') }, { page: 3, data: Buffer.from('C') }],
  };
  const r = await ocr.ocrDoc(parsed);
  assert.strictEqual(r.ocrPages, 2, 'page2 失败跳过，成功 2 页');
  assert.ok(r.pages.find(p => p.page === 1).text.includes('识别文字'), 'page1 回填');
  assert.strictEqual(r.pages.find(p => p.page === 2).text, '', 'page2 仍空');
  assert.ok(r.chars > 0, 'chars 统计');
  assert.strictEqual(r.truncated, false);
  // cap 测试：60 张 scan → 只处理 50
  const many = { kind: 'pdf', pages: [], scans: [] };
  for (let i = 1; i <= 60; i++) { many.pages.push({ page: i, text: '' }); many.scans.push({ page: i, data: Buffer.from('X' + i) }); }
  const r2 = await ocr.ocrDoc(many);
  assert.strictEqual(r2.truncated, true, '超 50 截断');
  assert.strictEqual(r2.ocrPages, 50, '只识别 50 页');
  ocr.ocrImage = orig;
  console.log('T4 ocrDoc OK');
  process.exit(0);
})().catch(e => { console.error('T4 FAIL', e); process.exit(1); });
```

- [ ] **Step 2: 运行确认 RED**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t4-ocrdoc.js"`
Expected: FAIL（`ocr.ocrDoc is not a function`）。

- [ ] **Step 3: 实现 ocrDoc（lib/ocr.js）**

在 `lib/ocr.js` 的 `ocrImage` 之后、`module.exports` 之前增：
```js
const MAX_OCR_PAGES = 50;

async function ocrDoc(parsed) {
  const allScans = parsed.scans || [];
  const scans = allScans.slice(0, MAX_OCR_PAGES);
  const truncated = allScans.length > MAX_OCR_PAGES;
  let ocrPages = 0;
  for (const scan of scans) {
    try {
      const text = await ocrImage(scan.data);
      const pg = parsed.pages.find(p => p.page === scan.page);
      if (pg) { pg.text = text; if (text) ocrPages++; }
    } catch (e) { console.warn('OCR 单页失败:', e.message); }
  }
  const chars = parsed.pages.reduce((n, p) => n + (p.text || '').length, 0);
  return { pages: parsed.pages, ocrPages, chars, truncated };
}
```
导出改为：
```js
module.exports = { ocrImage, ocrDoc };
```

- [ ] **Step 4: 运行单元 GREEN**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t4-ocrdoc.js"`
Expected: PASS（`T4 ocrDoc OK`）。

- [ ] **Step 5: 实现 server.js**

5a. 顶部 require（line 13 `const latex = …` 之后）加：
```js
const ocr = require('./lib/ocr');
```
5b. upload 路由 `kb.addDoc` 调用（line 73）加 `scanned`：
```js
      const doc = kb.addDoc({ id, name: f.originalname, kind: parsed.kind, pages: parsed.pages, subject, images: parsed.images, scanned: parsed.scanned });
```
5c. 在 `/api/kb/:id/images` 路由（line 96-115）之后新增 OCR 路由：
```js
app.post('/api/kb/:id/ocr', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return res.status(400).json({ error: '无效的文档 ID' });
  if (!kb.getDoc(id)) return res.status(404).json({ error: '文档不存在' });
  const upDir = path.join(__dirname, 'uploads');
  let src = null;
  if (fs.existsSync(upDir)) {
    const match = fs.readdirSync(upDir).find(f => f.startsWith(id + '.') && !f.endsWith('.json'));
    if (match) src = path.join(upDir, match);
  }
  if (!src) return res.status(400).json({ error: '找不到原始上传文件，无法 OCR' });
  try {
    const parsed = await extract(src);
    if (parsed.kind !== 'pdf' && parsed.kind !== 'image') return res.status(400).json({ error: '该文档无需 OCR' });
    const r = await ocr.ocrDoc(parsed);
    const ok = kb.setDocText(id, r.pages, parsed.images);
    res.json({ ok, ocrPages: r.ocrPages, chars: r.chars, truncated: r.truncated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```
5d. PORT 覆盖（line 294）改为（测试实例可用 PORT=3001，默认行为不变）：
```js
const port = process.env.PORT || config.port || 3000;
```

- [ ] **Step 6: 语法检查 + 起测试实例（不动 PID 2660）**

Run: `node --check server.js && node --check lib/ocr.js`（OK）。
起独立测试实例（后台，port 3001）：
```bash
cd /d/GithubRepo/VisBoard && PORT=3001 node server.js
```
（用 run_in_background；记录其 PID。**不得 kill PID 2660**。）确认 `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health` → 200。

- [ ] **Step 7: HTTP 端到端测试（真实 OCR，1 页夹具）**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t4-http.js`（对 3001 测试实例）：
```js
const assert = require('node:assert');
const fs = require('node:fs');
const BASE = 'http://localhost:3001';
const SCANNED = 'C:/Users/陈女士/AppData/Local/Temp/vb-ocr/scanned.pdf';
(async () => {
  // 上传扫描 PDF
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(SCANNED)], { type: 'application/pdf' }), 'scanned-test.pdf');
  const up = await (await fetch(BASE + '/api/upload', { method: 'POST', body: fd })).json();
  const item = up.results[0];
  assert.ok(!item.error, '上传成功: ' + JSON.stringify(item));
  const id = item.id;
  assert.strictEqual(item.chars, 0, '扫描 PDF 上传后文字空');
  // 列表应标 scanned
  const docs = (await (await fetch(BASE + '/api/kb')).json()).docs;
  assert.strictEqual(docs.find(d => d.id === id).scanned, true, 'listDocs scanned=true');
  // OCR
  const r = await (await fetch(BASE + '/api/kb/' + id + '/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.ok(r.ok, 'OCR ok: ' + JSON.stringify(r));
  assert.ok(r.ocrPages >= 1, '识别 >=1 页');
  assert.ok(r.chars > 0, '回填文字 >0');
  // 回填后可检索
  const d2 = (await (await fetch(BASE + '/api/kb')).json()).docs.find(x => x.id === id);
  assert.ok(d2.chars > 0 && d2.chunks > 0, '切块更新');
  // 错误路径：不存在 doc → 404
  const e404 = await fetch(BASE + '/api/kb/nonexistent-id/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(e404.status, 404);
  // 清理
  await fetch(BASE + '/api/kb/' + id, { method: 'DELETE' });
  console.log('T4 HTTP OK ocrPages=' + r.ocrPages + ' chars=' + r.chars);
  process.exit(0);
})().catch(e => { console.error('T4 HTTP FAIL', e); process.exit(1); });
```
Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-ocr/t4-http.js"`
Expected: PASS（`T4 HTTP OK …`）。测试 doc 已删。报告记录 ocrPages/chars 与识别文字样本。

---

### Task 5: public/js/kb.js — "OCR 识别"按钮 + ACCEPT/文案

**Files:**
- Modify: `public/js/kb.js`（ACCEPT 加图片；上传文案；doc 行加 doc-ocr 按钮（仅 scanned）；click handler 加 doc-ocr 分支）
- Test: `node --check` + 浏览器 smoke（PORT=3001 测试实例）

**Interfaces:**
- Consumes: `listDocs.scanned`（T3）；`POST /api/kb/:id/ocr`→`{ok,ocrPages,chars,truncated}`（T4）；`postJSON`/`toast`/`load`（现有）。
- Produces: 扫描文档行显示"OCR 识别"按钮，点击跑 OCR + toast + 刷新；非扫描文档不显示。

- [ ] **Step 1: 实现 kb.js 改动**

1a. ACCEPT（line 3）：
```js
const ACCEPT = '.txt,.md,.pdf,.docx,.pptx,.png,.jpg,.jpeg';
```
1b. 上传文案（line 23）：
```js
        <p class="sub">支持 PDF / txt / md / docx / pptx / 图片；扫描版 PDF 与图片上传后点「OCR 识别」回填文字。</p>
```
1c. doc 行（line 105-106）在 doc-img 与 doc-del 之间插入条件 OCR 按钮：
```js
        <button class="btn ghost sm doc-img" data-id="${esc(d.id)}">补提取图片</button>
        ${d.scanned ? `<button class="btn ghost sm doc-ocr" data-id="${esc(d.id)}" title="本地 OCR 识别扫描文字，较慢">OCR 识别</button>` : ''}
        <button class="btn ghost sm doc-del" data-id="${esc(d.id)}">删除</button>
```
1d. click handler（line 171-189）在 doc-img 分支之后、doc-del 分支之前插入 doc-ocr 分支：
```js
    const ocrBtn = e.target.closest('.doc-ocr');
    if (ocrBtn) {
      ocrBtn.disabled = true; const old = ocrBtn.textContent; ocrBtn.textContent = '识别中…';
      try {
        const r = await postJSON('/api/kb/' + encodeURIComponent(ocrBtn.dataset.id) + '/ocr', {});
        toast(r.ocrPages ? ('识别 ' + r.ocrPages + ' 页（' + r.chars + ' 字）' + (r.truncated ? '，已识别前 50 页' : '')) : '识别完成但结果为空（可能图质差）', r.ocrPages ? 'ok' : 'warn');
        load();
      } catch (err) { toast(err.message, 'err'); ocrBtn.disabled = false; ocrBtn.textContent = old; }
      return;
    }
```
（doc-img 分支与 doc-del 分支保持不变；`.doc-subj` change handler 不动。）

- [ ] **Step 2: 语法检查**

Run: `node --check public/js/kb.js`
Expected: OK。

- [ ] **Step 3: 浏览器 smoke（PORT=3001 测试实例，controller 驱动）**

由控制器用 browser-use：导航 `http://localhost:3001/kb` → 上传 `scanned.pdf` 夹具（或确认已有扫描测试 doc）→ 确认该行出现"OCR 识别"按钮、非扫描文档无此按钮 → 点击 → 按钮变"识别中…"→ toast"识别 N 页（M 字）"→ 列表 chars/chunks 更新 → console 无错误。截图存 workspace。验证后删除测试 doc。
Expected: 按钮显隐正确、OCR 成功、console 干净。

---

### Task 6: 端到端回归 + 真实验证（controller 浏览器 e2e + 机械回归）

**Files:**
- 无源码改动（纯验证）。Test: 临时回归脚本 + browser-use e2e（PORT=3001 测试实例）。

**Interfaces:**
- Consumes: T1–T5 全部成果；阶段3 T1/T3 测试；阶段2电路回归（LLM-free）。
- Produces: 验证证据（截图 + 计数 + 回归 GREEN），供 reviewer gate。

**执行分工（仿阶段3 Ruling H）**：机械 Step 1/2/4（回归脚本 + 离线验证 + 清理）可派 subagent；Step 3 浏览器 e2e（上传→OCR→白板→备课，含真实 LLM 备课）由 **controller** 主会话驱动（长 LLM 等待 + 视觉判断）。

- [ ] **Step 1: 阶段3回归（机械）**

Run 阶段3 T1（文字 PDF images=12 pages=50）与 T3（PPTX pages=2 images=1）测试脚本（若在 Temp 则直接跑，否则按阶段3 plan 重建）。
Expected: 均 GREEN（阶段3图片管线不变）。

- [ ] **Step 2: 阶段2电路回归（LLM-free，机械）**

复用阶段3 T7 的免 LLM 电路回归：LED 范例 `lib/latex.js` COMPILE=OK + 缓存围栏重编译 sha256 与阶段2一致（b0ad9832…）。确认 `lib/latex.js` 未被本阶段改动（mtime/git status）。
Expected: COMPILE=OK + sha256 一致；电路管线字节不变。

- [ ] **Step 3: 真实浏览器 e2e（controller 驱动，PORT=3001）**

3a. 上传扫描 PDF 夹具 + 独立图片夹具（fixture.png）到 3001 测试实例（经 /kb UI）。确认两者上传后 chars=0、行显示"OCR 识别"。
3b. 分别点"OCR 识别"→ 文字回填、chars>0、toast 正确。
3c. 用 OCR 后的文档备一课（真实 LLM，topic 如"半导体存储器"，选该科目）→ 白板出现**文字卡片**（OCR 文字），**无扫描整页图卡片**（验证"仅 OCR 文字"）；console 干净；截图。
3d. 检索验证：OCR 文字进入 chunk，备课检索能命中（done 内容引用 OCR 文字）。
3e. 离线验证：确认 OCR 过程 langPath 本地、无 CDN 网络请求（list_network_requests 无 tessdata CDN）。
3f. 截图存 workspace（`task-6-ocr-board.png` 等）。
Expected: 扫描内容经 OCR 可检索/可讲解，白板纯文字无扫描图，离线成立。**诚实要求**：若 LLM 不可用/超时，如实报告，不得宣称通过。

- [ ] **Step 4: 清理 + 全局约束核对（机械）**

删除所有 OCR 测试 doc（t3ocr-test-doc、scanned-test、上传的夹具 doc 等），确认 KB 回到 17 份原文档、原文档 imageCount/chars 不变。`git status -s` 核对：仅预期文件改动（lib/ocr.js 新、lib/parse.js/lib/kb.js/server.js/public/js/kb.js/package.json/package-lock.json/.gitignore M、ocr-data/ 被忽略、docs/ 含 spec+plan）；config.json 仍 `D ` untouched；无 stray 文件。测试实例（3001）可保留或停止（**不得动 PID 2660:3000**）。
Expected: KB  pristine、git status 符合预期、约束全守。

---

## Self-Review（controller 填写）

**1. Spec coverage：**
- §4.1 lib/ocr.js（ocrImage + worker 单例 + 离线 langPath）→ T1；ocrDoc 编排 → T4。✅
- §4.2 parse.js（SUPPORTED 图片 + 图片分支 + 扫描页检测 16/300 + scans/scanned + 文字页 images 不变）→ T2。✅
- §4.3 kb.js（setDocText + scanned 标志 + listDocs.scanned）→ T3。✅
- §4.4 server.js（/ocr 路由 + upload 传 scanned + 错误码 + cap）→ T4。✅
- §4.5 前端按钮（doc-ocr 仅 scanned + 识别中 + toast + 刷新）→ T5。✅
- §5 错误处理与上限（400/404/500、单页跳过、空结果、cap50、门限）→ T2/T4。✅
- §6 测试（夹具、ocr 关键词、parse 三测、setDocText、路由、浏览器 e2e、回归、离线）→ T1–T6。✅
- §7 约束（依赖、离线、阶段2/3不变、config、no-commit、范围）→ Global Constraints + 各 Task。✅
- 无遗漏。

**2. Placeholder scan：** 无 TBD/TODO；tesseract API 为有意的 Task 1 探针（含回退），非占位。所有代码步骤含 verbatim 代码。✅

**3. Type consistency：** `extract`→`{kind,pages,images,scans,scanned}` 在 T2 定义、T4 消费一致；`ocrImage(Buffer)→string` T1 定义、T4 ocrDoc 调用一致；`ocrDoc(parsed)→{pages,ocrPages,chars,truncated}` T4 定义、路由消费一致；`setDocText(id,pages,images)→bool` T3 定义、T4 调用一致；`listDocs.scanned` T3 定义、T5 消费一致；`MAX_OCR_PAGES=50`/`SCAN_TEXT_THRESHOLD=16`/`SCAN_MIN_DIM=300` 各处一致。✅
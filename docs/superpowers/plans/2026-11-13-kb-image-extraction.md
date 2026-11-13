# 知识库资料图片提取与按页展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上传/回填知识库资料时提取 PDF/PPTX 内嵌图片并落盘，讲解检索命中某页文字时自动把该页原图作为图片卡片附上白板与自包含 HTML 导出。

**Architecture:** 方案 A（上传时提取 + 落盘 + 回填）。数据流：upload/backfill → `parse.extract`（文字+图片）→ `kb.addDoc`/`setDocImages`（写图片文件 + doc.json.images）→ `retrieve`（按页附图）→ `streamLesson` done.images → board.js 图片卡片 → lesson.js 导出内嵌 base64。图片字节由 pdf-parse `getImage` 与 officeparser `extractAttachments` 提供，无需新依赖、无需 zip 库。

**Tech Stack:** Node v24 + Express 5（CommonJS 后端）；原生 ES module 前端（无构建）；pdf-parse v2.4.5；officeparser v8.4.1；SSE 流式；multer。测试 = 一次性 `node:assert` 脚本 + 浏览器实测（项目无测试框架）。

**Spec:** `docs/superpowers/specs/2026-11-13-kb-image-extraction-design.md`

## Global Constraints

- 不新增 npm 依赖（pdf-parse / officeparser 已装；jszip/fflate 仅为探针用过，实施不依赖）。
- 阶段2电路管线（pdflatex、circuit 禁中文、标签防重叠、func 图像）保持不变；`lib/teach.js` 的 sys prompt 与 figRule 不改。
- `config.json` 保持 gitignored / untracked；API key 仅后端，绝不打印 key 片段、绝不 `git add config.json` 或 `git add -f`。
- **代理不执行 git commit / push**；所有提交由用户在全部完成后统一 push。每个 Task 以验证结束，不含 commit 步骤。
- 路径安全：doc id 沿用 `ID_RE = /^[a-zA-Z0-9-]+$/`；图片静态目录用 `express.static`（自带防穿越）；回填只读 `uploads/<id>.*`。
- 上限：每页 4 张、每 doc 60 张（按页序截断）、retrieve 4 张、lesson done 2 张。
- 范围：仅 PDF + PPTX 内嵌 raster 图；不做 DOCX 图片、矢量图捕获、OCR、AI 主动插图、手动图库。
- 图片提取失败（getImage / AST 抛错、魔数不符）→ 该项跳过或 `images=[]`，`console.warn`，不阻断上传/回填。
- 所有探针/测试脚本写到系统临时目录（`C:/Users/陈女士/AppData/Local/Temp/`），属一次性产物，不进仓库。

## 已核实的接口事实（探针确认，实施据此编码，不得猜测）

**PDF**（`pdf-parse`，真实上传 PDF 探针）：
- `new PDFParse({ data: Uint8Array })`；`await parser.getText()` → `{ pages: [{ num, text }] }`。
- `await parser.getImage({ imageThreshold: 80, imageDataUrl: false })` → `{ pages, total }`；`pages[] = { pageNumber(1起始), images[] }`。
- `images[]`（EmbeddedImage）= `{ data: Uint8Array, dataUrl: ''(当 imageDataUrl:false), name: 'img_p1_1', width, height, kind: 数字 }`。`kind` 为数字枚举，**扩展名一律由魔数判定**，不依赖 kind。`width/height` 为内在像素。
- 用完 `await parser.destroy()`（finally）。

**PPTX**（`officeparser`，最小 2 页夹具探针）：
- `await parseOffice(filePath, { ocr: false, extractAttachments: true })` → ast。
- `ast.content` = 幻灯片节点数组；`slide.type === 'slide'`，`slide.metadata.slideNumber`（1起始），`slide.children[]`。
- 子节点：`{ type: 'paragraph', text }`；`{ type: 'image', metadata: { attachmentName: 'image1.png' }, bounds }`（image 节点嵌套于 slide 之下，可能再嵌套于 group，需递归收集）。
- `ast.attachments[]`：真实图 `{ type: 'image', mimeType: 'image/png', name: 'image1.png', extension: 'png', data: <base64 字符串>, altText }`；另有占位项 `{ name: 'image', data: '' }` 须过滤。
- 图片字节 = `Buffer.from(att.data, 'base64')`；按 `att.name === image.metadata.attachmentName` 且 data 非空匹配。attachment 无内在宽高 → 由魔数 sniff。
- `await ast.to('text')` 返回 `{ value }`（现有 parse.js 已用 `(await ast.to('text')).value`）。

**共享魔数 sniff**（PNG/JPEG）：PNG 头 `89 50 4E 47`，宽 `readUInt32BE(16)` 高 `readUInt32BE(20)`；JPEG 头 `FF D8`，扫 SOF 段取宽高。魔数不符返回 null → 跳过。

---

### Task 1: parse.js — 魔数 sniff helper + PDF 图片提取

**Files:**
- Modify: `lib/parse.js`（新增 `sniffImage`/`jpegSize` 局部函数；PDF 分支增 getImage；txt/md/docx 返回 `images: []`）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-t1-parse.js`

**Interfaces:**
- Consumes: pdf-parse `PDFParse.getImage`（见上）。
- Produces: `extract(filePath)` 返回 `{ kind, pages: [{page, text}], images: [{page, data: Buffer, w, h, ext}] }`。`sniffImage(buf)` → `{ext, w, h} | null`（Task 3 复用）。

- [ ] **Step 1: 写失败测试**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-t1-parse.js`：

```js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extract } = require('D:/GithubRepo/VisBoard/lib/parse');

const PDF = 'D:/GithubRepo/VisBoard/uploads/0801da9e-3c28-45a6-a7f4-44beb106007f.pdf';

(async () => {
  const r = await extract(PDF);
  assert.strictEqual(r.kind, 'pdf');
  assert.ok(Array.isArray(r.pages) && r.pages.length > 0, 'pages 非空');
  assert.ok(Array.isArray(r.images), 'images 是数组');
  assert.ok(r.images.length > 0, '该 PDF 应含内嵌图（探针=12）');
  for (const im of r.images) {
    assert.ok(Buffer.isBuffer(im.data), 'data 是 Buffer');
    assert.ok(typeof im.page === 'number' && im.page >= 1, 'page 1起始');
    assert.ok(['png', 'jpeg'].includes(im.ext), 'ext 由魔数判定: ' + im.ext);
    assert.ok(im.w > 0 && im.h > 0, '宽高为正');
    const head = im.data.subarray(0, 4).toString('hex');
    if (im.ext === 'png') assert.strictEqual(head, '89504e47');
    if (im.ext === 'jpeg') assert.strictEqual(im.data.subarray(0, 2).toString('hex'), 'ffd8');
  }
  // 文字内容不变（回归）：首页文字仍非空
  assert.ok(r.pages[0].text.length > 0, '首页文字保留');
  console.log('T1 OK: images=' + r.images.length + ' pages=' + r.pages.length);
})().catch(e => { console.error('T1 FAIL', e); process.exit(1); });
```

- [ ] **Step 2: 运行确认失败**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t1-parse.js"`
Expected: FAIL — `r.images` 为 undefined（当前 extract 不返回 images）。

- [ ] **Step 3: 实现 sniff helper + PDF 分支**

在 `lib/parse.js` 顶部 `const SUPPORTED = ...` 之后新增：

```js
function jpegSize(buf) {
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xFF) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { pos += 2; continue; }
    const len = buf.readUInt16BE(pos + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: buf.readUInt16BE(pos + 5), w: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

function sniffImage(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    const s = jpegSize(buf);
    return { ext: 'jpeg', w: s ? s.w : 0, h: s ? s.h : 0 };
  }
  return null;
}
```

把 txt/md 分支改为带 `images: []`：

```js
  if (ext === '.txt' || ext === '.md') {
    return { kind: ext.slice(1), pages: [{ page: null, text: fs.readFileSync(filePath, 'utf8') }], images: [] };
  }
```

把 PDF 分支替换为：

```js
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
    try {
      const r = await parser.getText();
      const pages = r.pages.map(p => ({ page: p.num, text: p.text }));
      let images = [];
      try {
        const ir = await parser.getImage({ imageThreshold: 80, imageDataUrl: false });
        for (const pg of ir.pages || []) {
          for (const im of pg.images || []) {
            const data = Buffer.from(im.data);
            const meta = sniffImage(data);
            if (!meta) continue;
            images.push({ page: pg.pageNumber, data, w: im.width || meta.w, h: im.height || meta.h, ext: meta.ext });
          }
        }
      } catch (e) { console.warn('PDF 图片提取失败:', e.message); images = []; }
      return { kind: 'pdf', pages, images };
    } finally {
      await parser.destroy();
    }
  }
```

把 docx 分支改为带 `images: []`：

```js
  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ path: filePath });
    return { kind: 'docx', pages: [{ page: null, text: r.value }], images: [] };
  }
```

（PPTX 分支暂保持原样，Task 3 再改；此时它仍返回 `{kind, pages}` 无 images，Task 3 补齐。）

- [ ] **Step 4: 运行确认通过**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t1-parse.js"`
Expected: PASS — `T1 OK: images=12 pages=50`（数字以实际为准，>0 即可）。

---

### Task 2: kb.js — 图片落盘 + doc.images + 上限 + 清理

**Files:**
- Modify: `lib/kb.js`（新增 `IMG_DIR/PER_PAGE/PER_DOC` 常量与 `writeImages`；`addDoc` 接收 images；新增 `setDocImages`；`listDocs` 增 imageCount；`deleteDoc` 删图片目录；导出增 setDocImages）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-t2-kb.js`

**Interfaces:**
- Consumes: Task 1 的 images 形状 `[{page, data: Buffer, w, h, ext}]`。
- Produces:
  - `addDoc({id, name, kind, pages, subject, images})` → doc，`doc.images = [{id:'<page>-<i>', page, w, h, file:'<page>-<i>.<ext>'}]`。
  - `setDocImages(id, images)` → boolean（回填用，先清旧目录再写，幂等）。
  - `listDocs()` 每项增 `imageCount`。
  - `getDoc(id)` 返回含 `images`。
  - `deleteDoc(id)` 连带删 `kb/images/<id>/`。
  - 图片文件路径：`kb/images/<docId>/<page>-<i>.<ext>`。

- [ ] **Step 1: 写失败测试**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-t2-kb.js`（用真实 extract 产图，避免手造字节）：

```js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const kb = require('D:/GithubRepo/VisBoard/lib/kb');
const { extract } = require('D:/GithubRepo/VisBoard/lib/parse');

const PDF = 'D:/GithubRepo/VisBoard/uploads/0801da9e-3c28-45a6-a7f4-44beb106007f.pdf';
const KB = 'D:/GithubRepo/VisBoard/kb';
const ID = 't2test-img-doc';

(async () => {
  // 清理可能的残留
  kb.deleteDoc(ID);
  const parsed = await extract(PDF);
  assert.ok(parsed.images.length > 0);

  const doc = kb.addDoc({ id: ID, name: 'T2测试.pdf', kind: 'pdf', pages: parsed.pages, subject: null, images: parsed.images });
  assert.ok(Array.isArray(doc.images) && doc.images.length > 0, 'doc.images 非空');
  assert.ok(doc.images.length <= 60, '每 doc ≤ 60');
  // 每页 ≤ 4
  const perPage = {};
  for (const im of doc.images) {
    perPage[im.page] = (perPage[im.page] || 0) + 1;
    assert.ok(perPage[im.page] <= 4, '每页 ≤ 4');
    assert.ok(/^[a-zA-Z0-9-]+$/.test(im.id), 'image id 安全');
    const f = path.join(KB, 'images', ID, im.file);
    assert.ok(fs.existsSync(f), '图片落盘: ' + im.file);
    assert.strictEqual(im.file, im.id + '.' + path.extname(im.file).slice(1));
  }
  // listDocs imageCount
  const sum = kb.listDocs().find(d => d.id === ID);
  assert.strictEqual(sum.imageCount, doc.images.length, 'imageCount 一致');
  // getDoc 含 images
  assert.strictEqual(kb.getDoc(ID).images.length, doc.images.length);

  // 幂等：setDocImages 重复调用，文件数不变、无重复
  const dir = path.join(KB, 'images', ID);
  const before = fs.readdirSync(dir).length;
  const ok = kb.setDocImages(ID, parsed.images);
  assert.strictEqual(ok, true);
  const after = fs.readdirSync(dir).length;
  assert.strictEqual(after, before, '幂等：文件数不变');
  assert.strictEqual(kb.getDoc(ID).images.length, doc.images.length);

  // 删除连带清图片目录
  kb.deleteDoc(ID);
  assert.ok(!fs.existsSync(dir), 'deleteDoc 清除图片目录');
  assert.ok(!fs.existsSync(path.join(KB, ID + '.json')), 'deleteDoc 清除 json');
  console.log('T2 OK: images=' + doc.images.length);
})().catch(e => { console.error('T2 FAIL', e); try { kb.deleteDoc(ID); } catch {} process.exit(1); });
```

- [ ] **Step 2: 运行确认失败**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t2-kb.js"`
Expected: FAIL — `doc.images` undefined（addDoc 尚不处理 images）。

- [ ] **Step 3: 实现 kb.js 改动**

在常量区（`const ID_RE = ...` 之后）新增：

```js
const IMG_DIR = path.join(KB_DIR, 'images');
const PER_PAGE = 4;
const PER_DOC = 60;
```

在 `chunkPages` 之后、`addDoc` 之前新增 `writeImages`：

```js
function writeImages(id, images) {
  if (!ID_RE.test(id)) return [];
  const dir = path.join(IMG_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const sorted = [...list].sort((a, b) => (a.page || 0) - (b.page || 0));
  const perPage = new Map();
  const out = [];
  for (const im of sorted) {
    if (out.length >= PER_DOC) break;
    const page = im.page == null ? 0 : im.page;
    const used = perPage.get(page) || 0;
    if (used >= PER_PAGE) continue;
    perPage.set(page, used + 1);
    const file = page + '-' + used + '.' + im.ext;
    fs.writeFileSync(path.join(dir, file), im.data);
    out.push({ id: page + '-' + used, page: im.page, w: im.w || 0, h: im.h || 0, file });
  }
  return out;
}
```

替换 `addDoc`：

```js
function addDoc({ id, name, kind, pages, subject, images }) {
  const chunks = chunkPages(pages);
  const chars = pages.reduce((n, p) => n + (p.text || '').length, 0);
  const imageList = writeImages(id, images);
  const doc = { id, name, kind, chars, pages: pages.length, chunks, subject: subject || null, images: imageList, createdAt: Date.now() };
  fs.writeFileSync(path.join(KB_DIR, id + '.json'), JSON.stringify(doc));
  return doc;
}
```

在 `listDocs` 的 `.map(d => ({ ... }))` 中增 `imageCount`（替换该 map 回调）：

```js
    .map(d => ({ id: d.id, name: d.name, kind: d.kind, chars: d.chars, pages: d.pages, chunks: d.chunks.length, subject: d.subject || null, imageCount: (d.images || []).length, createdAt: d.createdAt }))
```

在 `deleteDoc` 内（`if (fs.existsSync(p)) fs.unlinkSync(p);` 之后）新增：

```js
  const imgDir = path.join(IMG_DIR, id);
  if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true });
```

在 `setDocSubject` 之后新增 `setDocImages`：

```js
function setDocImages(id, images) {
  if (!ID_RE.test(id)) return false;
  const d = getDoc(id);
  if (!d) return false;
  d.images = writeImages(id, images);
  fs.writeFileSync(path.join(KB_DIR, id + '.json'), JSON.stringify(d));
  return true;
}
```

在 `module.exports` 增 `setDocImages`（替换导出对象）：

```js
module.exports = {
  chunkPages, addDoc, listDocs, getDoc, deleteDoc, allChunks, ingestLegacyUploads,
  setDocSubject, setDocImages, listSubjects, addSubject, deleteSubject,
};
```

- [ ] **Step 4: 运行确认通过**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t2-kb.js"`
Expected: PASS — `T2 OK: images=N`（N≤60），幂等与删除断言全过。

---

### Task 3: parse.js — PPTX 按幻灯片文字 + 图片提取

**Files:**
- Modify: `lib/parse.js`（PPTX 分支：`extractAttachments: true`，递归收集 slide→paragraph/image，attachment base64→Buffer，sniff 宽高）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-t3-pptx.js`（复用探针夹具 `visboard-probe.pptx`）

**Interfaces:**
- Consumes: Task 1 `sniffImage`；officeparser AST（见上）。
- Produces: PPTX `extract` 返回 `{ kind: 'pptx', pages: [{page: slideNumber, text}], images: [{page: slideNumber, data, w, h, ext}] }`。

- [ ] **Step 1: 准备夹具 + 写失败测试**

夹具已由探针生成于 `C:/Users/陈女士/AppData/Local/Temp/visboard-probe.pptx`（slide1 含文字+图 image1.png，slide2 仅文字）。若不存在，先运行 `node "C:/Users/陈女士/AppData/Local/Temp/visboard-pptx-probe.js"` 重建。

写 `C:/Users/陈女士/AppData/Local/Temp/vb-t3-pptx.js`：

```js
const assert = require('node:assert');
const { extract } = require('D:/GithubRepo/VisBoard/lib/parse');
const PPTX = 'C:/Users/陈女士/AppData/Local/Temp/visboard-probe.pptx';

(async () => {
  const r = await extract(PPTX);
  assert.strictEqual(r.kind, 'pptx');
  assert.strictEqual(r.pages.length, 2, '两页幻灯片');
  assert.strictEqual(r.pages[0].page, 1);
  assert.strictEqual(r.pages[1].page, 2);
  assert.ok(r.pages[0].text.includes('Probe Slide One'), 'slide1 文字');
  assert.ok(r.pages[1].text.includes('Probe Slide Two'), 'slide2 文字');
  assert.ok(!r.pages[0].text.includes('[Image'), '文字不含图片占位标记');
  assert.strictEqual(r.images.length, 1, '仅 slide1 有图');
  const im = r.images[0];
  assert.strictEqual(im.page, 1, '图归属 slide1');
  assert.ok(Buffer.isBuffer(im.data) && im.data.length > 0);
  assert.strictEqual(im.ext, 'png');
  assert.ok(im.w > 0 && im.h > 0, 'sniff 宽高');
  assert.strictEqual(im.data.subarray(0, 4).toString('hex'), '89504e47');
  console.log('T3 OK: pages=' + r.pages.length + ' images=' + r.images.length);
})().catch(e => { console.error('T3 FAIL', e); process.exit(1); });
```

- [ ] **Step 2: 运行确认失败**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t3-pptx.js"`
Expected: FAIL — 当前 PPTX 分支返回单页 `{page: null}` 且无 images。

- [ ] **Step 3: 实现 PPTX 分支**

在 `sniffImage` 之后新增递归收集器：

```js
function collectSlide(node, texts, imgNames) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectSlide(n, texts, imgNames); return; }
  if (node.type === 'paragraph' && node.text) texts.push(node.text);
  if (node.type === 'image' && node.metadata && node.metadata.attachmentName) imgNames.push(node.metadata.attachmentName);
  if (node.children) collectSlide(node.children, texts, imgNames);
}
```

把 `lib/parse.js` 末尾的 PPTX 分支（`const ast = await parseOffice(...)` 到 `return ...`）替换为：

```js
  const ast = await parseOffice(filePath, { ocr: false, extractAttachments: true });
  const slides = Array.isArray(ast.content) ? ast.content : [];
  const attByName = new Map();
  for (const a of ast.attachments || []) {
    if (a && a.type === 'image' && a.name && typeof a.data === 'string' && a.data) attByName.set(a.name, a);
  }
  const pages = [], images = [];
  for (const slide of slides) {
    if (!slide || slide.type !== 'slide') continue;
    const num = slide.metadata && slide.metadata.slideNumber != null ? slide.metadata.slideNumber : null;
    const texts = [], imgNames = [];
    collectSlide(slide.children || [], texts, imgNames);
    pages.push({ page: num, text: texts.join('\n') });
    for (const name of imgNames) {
      const att = attByName.get(name);
      if (!att) continue;
      const data = Buffer.from(att.data, 'base64');
      const meta = sniffImage(data);
      if (!meta) continue;
      images.push({ page: num, data, w: meta.w, h: meta.h, ext: meta.ext });
    }
  }
  return { kind: 'pptx', pages, images };
```

- [ ] **Step 4: 运行确认通过**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t3-pptx.js"`
Expected: PASS — `T3 OK: pages=2 images=1`。

- [ ] **Step 5: 回归 Task 1（PDF 不受影响）**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t1-parse.js"`
Expected: PASS（仍 `T1 OK`）。

---

### Task 4: retrieve 附图 + teach done.images + server 静态/回填/透传

**Files:**
- Modify: `lib/retrieve.js`（retrieve 返回增 images，按页取 doc.images、去重、上限 4、docCache）
- Modify: `lib/teach.js`（streamLesson 两处返回增 images）
- Modify: `server.js`（`/kb-images` 静态；upload 传 images；新增 `POST /api/kb/:id/images`；teach/stream done 透传 images）
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-t4-retrieve.js`（stub llm.chat，免真实 LLM）

**Interfaces:**
- Consumes: Task 2 `kb.getDoc(id).images = [{id, page, w, h, file}]`；Task 1/3 `extract`。
- Produces:
  - `retrieve(question, subject)` 返回增 `images: [{docId, docName, page, id, url, w, h}]`，`url = '/kb-images/' + docId + '/' + file`，上限 4，按 (docId,id) 去重。
  - `streamLesson` done 载荷 `images`（retrieve images 前 2 张）；empty 返回 `images: []`。
  - HTTP `GET /kb-images/<docId>/<file>` 静态图；`POST /api/kb/:id/images` → `{ok, count}`（找不到原文件 400，doc 不存在 404）。

- [ ] **Step 1: 写失败测试（stub LLM）**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-t4-retrieve.js`：

```js
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const kb = require('D:/GithubRepo/VisBoard/lib/kb');
const llm = require('D:/GithubRepo/VisBoard/lib/llm');
const { extract } = require('D:/GithubRepo/VisBoard/lib/parse');
const { retrieve } = require('D:/GithubRepo/VisBoard/lib/retrieve');

const PDF = 'D:/GithubRepo/VisBoard/uploads/0801da9e-3c28-45a6-a7f4-44beb106007f.pdf';
const ID = 't4test-img-doc';

(async () => {
  kb.deleteDoc(ID);
  const parsed = await extract(PDF);
  const doc = kb.addDoc({ id: ID, name: 'T4测试.pdf', kind: 'pdf', pages: parsed.pages, subject: null, images: parsed.images });
  assert.ok(doc.images.length > 0);
  const imgPage = doc.images[0].page;
  // 找一个该页的 chunk 编号
  const all = kb.allChunks(null);
  const targetIdx = all.findIndex(c => c.docId === ID && c.page === imgPage);
  assert.ok(targetIdx >= 0, '存在带图页的 chunk');

  // stub llm.chat：选中该 chunk（及另一个同页 chunk 若有，验证去重）
  const samePage = all.map((c, n) => ({ c, n })).filter(x => x.c.docId === ID && x.c.page === imgPage).map(x => x.n);
  llm.chat = async () => JSON.stringify({ selected: samePage });

  const r = await retrieve('测试', null);
  assert.ok(Array.isArray(r.images), 'retrieve 返回 images');
  assert.ok(r.images.length > 0, '命中页附图');
  assert.ok(r.images.length <= 4, '上限 4');
  const keys = r.images.map(im => im.docId + '/' + im.id);
  assert.strictEqual(new Set(keys).size, keys.length, '按 (docId,id) 去重');
  for (const im of r.images) {
    assert.strictEqual(im.docId, ID);
    assert.strictEqual(im.page, imgPage);
    assert.strictEqual(im.url, '/kb-images/' + ID + '/' + im.id + '.' + im.url.split('.').pop());
    assert.ok(im.docName && typeof im.w === 'number' && typeof im.h === 'number');
    assert.ok(fs.existsSync(path.join('D:/GithubRepo/VisBoard/kb/images', ID, im.url.split('/').pop())), 'url 对应文件存在');
  }
  kb.deleteDoc(ID);
  console.log('T4 OK: retrieve images=' + r.images.length);
})().catch(e => { console.error('T4 FAIL', e); try { kb.deleteDoc(ID); } catch {} process.exit(1); });
```

- [ ] **Step 2: 运行确认失败**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t4-retrieve.js"`
Expected: FAIL — `r.images` undefined。

- [ ] **Step 3: 实现 retrieve.js**

在 `const MAX_SELECT = 8;` 后新增 `const MAX_IMAGES = 4;`。把 retrieve 末尾 `return { ... }` 替换为（在 return 前聚合 images）：

```js
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
```

- [ ] **Step 4: 运行确认通过**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t4-retrieve.js"`
Expected: PASS — `T4 OK: retrieve images=N`（N≤4，去重）。

- [ ] **Step 5: 实现 teach.js done.images**

`lib/teach.js` streamLesson 的 empty 返回（`if (g.empty) { return { empty: true, ... } }`）增 `images: []`：

```js
    return { empty: true, message: '知识库里没有与「' + topic + '」相关的资料,请先上传相关课件。', citations: [], retrieved: 0, full: '', webCitations: [], images: [] };
```

streamLesson 末尾正常返回增 images（取前 2）：

```js
  return { empty: false, full, citations: g.citations, retrieved: g.ret.chunks.length, webCitations: g.webCitations, images: (g.ret.images || []).slice(0, 2) };
```

（`prepareLesson` / `streamAnswer` / `streamNotes` 不改；sys prompt 与 figRule 不动。）

- [ ] **Step 6: 实现 server.js**

在静态挂载区（`app.use('/vendor/katex', ...)` 之后）新增：

```js
app.use('/kb-images', express.static(path.join(__dirname, 'kb', 'images')));
```

upload 路由把 `kb.addDoc({...})` 调用增 images（替换该行）：

```js
      const doc = kb.addDoc({ id, name: f.originalname, kind: parsed.kind, pages: parsed.pages, subject, images: parsed.images });
```

在 `app.post('/api/kb/:id/subject', ...)` 之后新增回填路由：

```js
app.post('/api/kb/:id/images', async (req, res) => {
  const id = req.params.id;
  if (!/^[a-zA-Z0-9-]+$/.test(id)) return res.status(400).json({ error: '无效的文档 ID' });
  if (!kb.getDoc(id)) return res.status(404).json({ error: '文档不存在' });
  const upDir = path.join(__dirname, 'uploads');
  let src = null;
  if (fs.existsSync(upDir)) {
    const match = fs.readdirSync(upDir).find(f => f.startsWith(id + '.') && !f.endsWith('.json'));
    if (match) src = path.join(upDir, match);
  }
  if (!src) return res.status(400).json({ error: '找不到原始上传文件，无法补提取图片' });
  try {
    const parsed = await extract(src);
    const ok = kb.setDocImages(id, parsed.images || []);
    const d = kb.getDoc(id);
    res.json({ ok, count: (d.images || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

teach/stream 的 done 发送（`else send('done', { ... })`）增 images（替换该行）：

```js
    else send('done', { citations: result.citations, retrieved: result.retrieved, full: result.full, webCitations: result.webCitations || [], images: result.images || [] });
```

- [ ] **Step 7: 重启服务并验证 HTTP 回填 + 静态图**

先停旧服务（后台任务 b8esis4cd 或当前占用 3000 的 node 进程），再启动：

Run（后台）: `cd "D:/GithubRepo/VisBoard" && node server.js`

写 `C:/Users/陈女士/AppData/Local/Temp/vb-t4-http.js`（对真实 KB 中一个 PDF 回填并取图）：

```js
const assert = require('node:assert');
const BASE = 'http://localhost:3000';
(async () => {
  const docs = (await (await fetch(BASE + '/api/kb')).json()).docs;
  const pdf = docs.find(d => d.kind === 'pdf');
  assert.ok(pdf, 'KB 有 PDF');
  const r = await (await fetch(BASE + '/api/kb/' + pdf.id + '/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.strictEqual(r.ok, true);
  assert.ok(typeof r.count === 'number');
  // 幂等
  const r2 = await (await fetch(BASE + '/api/kb/' + pdf.id + '/images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.strictEqual(r2.count, r.count, '回填幂等');
  // 静态图可取（若 count>0）
  if (r.count > 0) {
    const docs2 = (await (await fetch(BASE + '/api/kb')).json()).docs;
    assert.strictEqual(docs2.find(d => d.id === pdf.id).imageCount, r.count, 'imageCount 更新');
    const full = await (await fetch(BASE + '/api/kb')).json();
    // 取该 doc 第一张图 url
    const kbDoc = require('D:/GithubRepo/VisBoard/lib/kb').getDoc(pdf.id);
    const im = kbDoc.images[0];
    const imgRes = await fetch(BASE + '/kb-images/' + pdf.id + '/' + im.file);
    assert.strictEqual(imgRes.status, 200, '静态图 200');
    assert.ok((imgRes.headers.get('content-type') || '').startsWith('image/'));
  }
  console.log('T4-HTTP OK: count=' + r.count);
})().catch(e => { console.error('T4-HTTP FAIL', e); process.exit(1); });
```

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t4-http.js"`
Expected: PASS — `T4-HTTP OK: count=N`，静态图 200。

---

### Task 5: util.js helper + board.js 图片卡片

**Files:**
- Modify: `public/js/util.js`（新增 `export function imageFigureHTML(img, src)`）
- Modify: `public/js/board.js`（import helper；`lessonImages` 状态；done 存图；renderBoard 追加图片卡片 + decode→layout + onerror 占位；persistBoard 存 images；start/clear 重置）
- Test: 浏览器实测（Task 7 统一）；本 Task 以语法/加载检查 + 手动白板验证。

**Interfaces:**
- Consumes: Task 4 done.images 形状 `{docId, docName, page, id, url, w, h}`。
- Produces:
  - `imageFigureHTML(img, src)` → `<div class="fig-frame"><img ...></div><div class="cap">docName · 第page页</div>`（board 与 export 复用）。
  - board 图片卡片 class `wb-card wb-figure`，`dataset.type='image'`，纳入 layout()。
  - `saveBoard` 载荷增 `images: lessonImages`。

- [ ] **Step 1: 实现 util.js helper**

在 `public/js/util.js` 的 `blockHtml` 函数之后新增：

```js
export function imageFigureHTML(img, src) {
  const cap = esc(img.docName || '资料') + (img.page != null ? ' · 第' + esc(img.page) + '页' : '');
  return '<div class="fig-frame"><img src="' + esc(src || img.url) + '" alt="资料原图"></div>' +
    '<div class="cap">' + cap + '</div>';
}
```

- [ ] **Step 2: 实现 board.js 改动**

import 行（第 1 行）增 `imageFigureHTML`：

```js
import { esc, parseBlocks, blockHtml, mdToHtml, webCitesHTML, fetchCircuitPNG, resolveCircuitFrames, imageFigureHTML } from './util.js';
```

> 注意：核对 board.js 第 1 行实际 import 名单后再增项，保持其余不变。

在状态声明区（`let selectedCard = null;` 附近）新增：

```js
  let lessonImages = [];
```

`persistBoard()` 的 saveBoard 调用增 images（替换该行）：

```js
    saveBoard(topic, { full, citations: lastCites, webCitations: lastWebCites, dialogs: snapshotDialogs(), images: lessonImages });
```

`renderBoard(text)` 中，把 `while (cards.length > blocks.length) cards.pop().remove();` 这一行替换为「追加图片卡片 + 按总数清理」：

```js
    const total = blocks.length + lessonImages.length;
    lessonImages.forEach((img, k) => {
      const i = blocks.length + k;
      let card = cards[i];
      if (!card) {
        card = document.createElement('div');
        card.className = 'wb-card wb-figure';
        card.dataset.type = 'image';
        canvas.appendChild(card); cards[i] = card;
      }
      const html = imageFigureHTML(img, img.url);
      if (card.dataset.sig !== html) {
        card.innerHTML = html; card.dataset.sig = html;
        const im = card.querySelector('img');
        if (im) {
          im.addEventListener('error', () => {
            const ph = document.createElement('span');
            ph.className = 'fig-error'; ph.textContent = '资料图片加载失败';
            im.replaceWith(ph); layout();
          });
          if (im.decode) im.decode().then(() => layout()).catch(() => {});
        }
      }
    });
    while (cards.length > total) cards.pop().remove();
```

done 事件（`else if (ev.type === 'done') {` 内，`if (ev.full) full = ev.full;` 之后）增：

```js
        lessonImages = ev.images || [];
```

`start()` 重置区（`lastCites = []; lastWebCites = [];` 那行）增 `lessonImages = [];`（替换该行）：

```js
    lastCites = []; lastWebCites = []; lessonImages = [];
```

`clearBtn` 点击处理中（`lastCites = []; lastWebCites = [];` 处）同样增 `lessonImages = [];`（在该重置序列里插入）。

- [ ] **Step 3: 语法/加载检查**

Run: `cd "D:/GithubRepo/VisBoard" && node --check public/js/board.js && node --check public/js/util.js`
Expected: 无输出（语法通过）。

- [ ] **Step 4: 浏览器手动验证（服务已起）**

用 browser-use 打开 `http://localhost:3000/`，进入白板，输入一个 KB 中带图页对应的课题（如讲义章节关键词），开始讲解，等待 done。
Expected: 白板文字卡片之后出现图片卡片（`wb-card wb-figure`，含 `<img>` 与 `docName · 第N页` 说明）；console 无报错；图片不遮挡相邻卡片（decode 后 layout）。若 LLM 过慢，此步可并入 Task 7 一次性验证。

---

### Task 6: lesson.js 导出内嵌 base64 + KB 管理页补提取按钮

**Files:**
- Modify: `public/js/lesson.js`（import imageFigureHTML；boardBlocksHTML 增 images/srcByUrl；buildLessonHTML 增 imagesSrc；exportLessonHTML fetch 图片→base64）
- Modify: `public/js/kb.js`（doc-row 增 imageCount 与「补提取图片」按钮；click 处理增 doc-img 分支）
- Test: 浏览器导出实测（Task 7）；本 Task 语法检查 + 手动导出验证。

**Interfaces:**
- Consumes: Task 5 `imageFigureHTML`、`rec.board.images`；Task 4 `POST /api/kb/:id/images`；Task 2 `listDocs().imageCount`。
- Produces: 导出 HTML 图片为 base64 dataUrl（无 `/kb-images` 外部路径残留）；KB 页每 doc 显示 `N 图` 与补提取按钮。

- [ ] **Step 1: 实现 lesson.js**

import 行（第 1 行）增 `imageFigureHTML`：

```js
import { esc, parseBlocks, blockHtml, mdToHtml, webCitesHTML, fetchCircuitPNG, imageFigureHTML } from './util.js';
```

替换 `boardBlocksHTML`：

```js
function boardBlocksHTML(topic, full, circuits, images, srcByUrl) {
  const parsed = parseBlocks(cleanFull(full));
  if (parsed.length && parsed[0].type === 'title') parsed.shift();
  const blocks = topic ? [{ type: 'title', text: topic, isTopic: true }, ...parsed] : parsed;
  let html = blocks.map(b => `<div class="wb-block ${b.type}">${blockHtml(b, circuits)}</div>`).join('');
  for (const img of images || []) {
    const src = srcByUrl && srcByUrl[img.url];
    if (!src) continue;
    html += `<div class="wb-block figure">${imageFigureHTML(img, src)}</div>`;
  }
  return html;
}
```

`buildLessonHTML` 签名增 imagesSrc（替换签名行）：

```js
export function buildLessonHTML(topic, katexCss = '', circuits = null, imagesSrc = null) {
```

`buildLessonHTML` 内 boardSection 的 boardBlocksHTML 调用增参（替换该三元表达式的真分支）：

```js
  const boardSection = board && board.full && board.full.trim()
    ? boardBlocksHTML(t, board.full, circuits, board.images, imagesSrc) + citesHTML(board.citations, board.webCitations)
    : '<p class="export-hint">本课尚未在白板上讲解，或讲解内容未保存。</p>';
```

`exportLessonHTML` 中，在 `const katexCss = await katexInlineCSS().catch(() => '');` 之前新增图片 base64 收集，并把 buildLessonHTML 调用增 imagesSrc：

```js
  const imagesSrc = {};
  const imgs = (rec && rec.board && rec.board.images) || [];
  await Promise.all(imgs.map(async img => {
    try {
      const r = await fetch(img.url);
      if (!r.ok) throw new Error('http ' + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const mime = buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
      imagesSrc[img.url] = 'data:' + mime + ';base64,' + btoa(bin);
    } catch { /* 省略该图，保持其余自包含 */ }
  }));
  const katexCss = await katexInlineCSS().catch(() => '');
  const html = buildLessonHTML(t, katexCss, circuits, imagesSrc);
```

- [ ] **Step 2: 实现 kb.js 前端**

`renderList` 的 doc-row 模板：ds 行增 imageCount，并在 `.doc-subj` select 之后、`.doc-del` 按钮之前增补提取按钮。替换 doc-row 模板为：

```js
    box.innerHTML = list.map(d => `
      <div class="doc-row">
        <div class="doc-ic ${esc(d.kind)}">${esc(d.kind)}</div>
        <div class="doc-info">
          <div class="nm">${esc(d.name)}</div>
          <div class="ds">${d.chars} 字 · ${d.pages} 页 · ${d.chunks} 块 · ${d.imageCount || 0} 图 · ${fmtDate(d.createdAt)}</div>
        </div>
        <select class="subj-select doc-subj" data-id="${esc(d.id)}" title="改归属科目">${subjectOptions(d.subject, false)}</select>
        <button class="btn ghost sm doc-img" data-id="${esc(d.id)}">补提取图片</button>
        <button class="btn ghost sm doc-del" data-id="${esc(d.id)}">删除</button>
      </div>`).join('');
```

替换 `$('#docList').addEventListener('click', ...)` 整个处理器为（先处理 doc-img，再 doc-del）：

```js
  $('#docList').addEventListener('click', async e => {
    const imgBtn = e.target.closest('.doc-img');
    if (imgBtn) {
      imgBtn.disabled = true;
      try {
        const r = await postJSON('/api/kb/' + encodeURIComponent(imgBtn.dataset.id) + '/images', {});
        toast('已提取 ' + (r.count || 0) + ' 张图片', 'ok');
        load();
      } catch (err) { toast(err.message, 'err'); imgBtn.disabled = false; }
      return;
    }
    const btn = e.target.closest('.doc-del');
    if (!btn) return;
    const doc = docs.find(d => d.id === btn.dataset.id);
    if (!confirm('确定删除「' + (doc ? doc.name : '') + '」?其切块会一并移除。')) return;
    btn.disabled = true;
    try { await delJSON('/api/kb/' + encodeURIComponent(btn.dataset.id)); toast('已删除', 'ok'); load(); }
    catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  });
```

- [ ] **Step 3: 语法检查**

Run: `cd "D:/GithubRepo/VisBoard" && node --check public/js/lesson.js && node --check public/js/kb.js`
Expected: 无输出。

- [ ] **Step 4: 浏览器手动验证**

KB 页：每 doc 显示 `N 图`；点「补提取图片」→ toast「已提取 N 张图片」→ 列表 imageCount 刷新。
白板导出：点「导出本课 HTML」，打开导出文件，确认图片以 `data:image/...;base64` 内嵌、无 `/kb-images` 残留、断网仍可显示。

---

### Task 7: 端到端回归 + 回填现有 17 个 PDF

**Files:**
- Test: 临时脚本 `C:/Users/陈女士/AppData/Local/Temp/vb-t7-backfill.js`；浏览器 e2e（browser-use）。
- 数据：对现有 KB 全部 PDF 回填图片（写 `kb/images/` 与各 doc.json.images）。

**Interfaces:**
- Consumes: 全部前序 Task。
- Produces: 现有 KB 带图；真实课程白板出现图片卡片；导出自包含；阶段2电路/func 回归不变。

- [ ] **Step 1: 回填全部现有 PDF（脚本，免 LLM）**

写 `C:/Users/陈女士/AppData/Local/Temp/vb-t7-backfill.js`：

```js
const path = require('node:path');
const fs = require('node:fs');
const kb = require('D:/GithubRepo/VisBoard/lib/kb');
const { extract } = require('D:/GithubRepo/VisBoard/lib/parse');
const UP = 'D:/GithubRepo/VisBoard/uploads';

(async () => {
  const docs = kb.listDocs();
  let total = 0, withImg = 0;
  for (const d of docs) {
    const match = fs.existsSync(UP) && fs.readdirSync(UP).find(f => f.startsWith(d.id + '.') && !f.endsWith('.json'));
    if (!match) { console.log('skip(no src)', d.name); continue; }
    try {
      const parsed = await extract(path.join(UP, match));
      kb.setDocImages(d.id, parsed.images || []);
      const n = (kb.getDoc(d.id).images || []).length;
      total += n; if (n > 0) withImg++;
      console.log('backfill', d.name, '=>', n, 'images');
    } catch (e) { console.warn('fail', d.name, e.message); }
  }
  console.log('T7 backfill done: docs=' + docs.length + ' withImg=' + withImg + ' totalImages=' + total);
})().catch(e => { console.error('T7 FAIL', e); process.exit(1); });
```

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t7-backfill.js"`
Expected: 每个有内嵌图的 PDF 输出 >0；`withImg` ≥ 1；无 fail（或仅个别扫描版无图，属正常）。

- [ ] **Step 2: 幂等复跑**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/vb-t7-backfill.js"`
Expected: 各 doc 图片数与第一次一致（writeImages 先清后写）。

- [ ] **Step 3: 阶段2回归（电路/func 不变）**

Run: `node "C:/Users/陈女士/AppData/Local/Temp/visboard-regression.js"`（若存在；否则用现有电路探针 `visboard-led-exemplar.js`）
Expected: 电路 COMPILE=OK、PNG 无中文、标签不重叠（与阶段2一致）。确认本阶段未触碰 figRule / latex 管线。

- [ ] **Step 4: 浏览器端到端（真实课程，LLM 可能较慢）**

用 browser-use：
1. 打开 `http://localhost:3000/`，KB 页确认 imageCount 已显示。
2. 白板输入一个命中带图页的课题（用 Step 1 中 withImg 的讲义关键词），开始讲解，等待 done（USTC qwen3.8-chat 可能 ~25 分钟，耐心等待，不轮询）。
3. 验证：白板文字卡片后出现图片卡片，caption=`docName · 第N页`；console 无错误；缩放/平移后图片不遮挡。
4. 点「导出本课 HTML」，打开导出文件：图片为 base64 内嵌、无 `/kb-images` 残留；电路/func/公式渲染与阶段2一致。
5. 追问一张卡片确认 drill 仍正常（图片卡片不影响追问）。

Expected: 上述全部满足。若 LLM 不可用或超时，记录为「未能在本会话完成真实课程 e2e」，不得宣称通过；后端单元/集成测试（T1–T4、T7 Step1–2）已覆盖数据链路。

- [ ] **Step 5: 清理临时测试 doc（保留真实 KB 回填）**

确认 `t2test-img-doc` / `t4test-img-doc` 已被测试脚本 deleteDoc 清除（脚本含清理）。真实 KB 的回填图片保留。临时探针/测试脚本留在系统 Temp，不进仓库。

---

## Self-Review（写完计划后自查，已执行）

**1. Spec 覆盖：**
- §4.1 parse（PDF getImage + 魔数 + PPTX 按幻灯片）→ T1 + T3。
- §4.2 kb（落盘 / 上限 4·60 / setDocImages / imageCount / deleteDoc 清理 / ID_RE）→ T2。
- §4.3 retrieve（按页附图 / 去重 / 上限 4 / url / docCache）→ T4 Step3。
- §4.4 teach（done.images ≤2 / empty images:[] / sys 不变）→ T4 Step5。
- §4.5 server（/kb-images 静态 / upload images / POST 回填 / done 透传）→ T4 Step6。
- §4.6 前端（board 图片卡片 + decode→layout + onerror / util helper / export base64 / KB 补提取按钮 + imageCount）→ T5 + T6。
- §5 错误与上限 → 各 Task 代码（try/catch→images=[]、魔数跳过、上限常量、onerror 占位、导出单图失败省略）。
- §6 验收 1–8 → T2(1,6)、T4(2,3)、T5/T7(4)、T6/T7(5)、T7(7)、T3/T7(8)。
- §7 约束 → Global Constraints（无新依赖、电路管线不变、config gitignored、代理不 commit/push、范围外不做）。
- PPTX 探针门禁：已在本会话用夹具确认 `pptx > slide > image` 嵌套 + attachment base64，T3 据此编码（递归收集兼容 group 嵌套）。

**2. 占位符扫描：** 无 TBD/TODO；每个代码步骤含完整可运行代码；测试脚本为完整 node:assert 代码。

**3. 类型一致性：**
- images 提取形状 `{page, data:Buffer, w, h, ext}`（T1/T3）→ writeImages 消费一致（T2）。
- doc.images `{id, page, w, h, file}`（T2）→ retrieve 读 `im.id/im.page/im.file/im.w/im.h`（T4）一致。
- retrieve images `{docId, docName, page, id, url, w, h}`（T4）→ teach slice(0,2) → board lessonImages → imageFigureHTML(img, img.url) 读 `img.docName/img.page/img.url`（T5）→ export board.images 同形状（T6）一致。
- `imageFigureHTML(img, src)` 签名 T5 定义、T6 复用一致。
- `setDocImages(id, images)` T2 定义、T4 server 与 T7 脚本调用一致。
- `sniffImage` T1 定义、T3 复用一致。
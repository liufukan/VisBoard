# 阶段3：知识库资料图片提取与按页展示 设计文档

日期：2026-11-13
状态：已获用户口头批准（方案 A），待用户书面复核
范围：PDF + PPTX；按页/幻灯片自动附带；不含 DOCX、不含矢量图捕获、不含 OCR（OCR 属阶段4）

## 1. 目标

上传/回填知识库资料时提取其中的内嵌图片，落盘保存；讲解检索命中某页文字时，自动把该页原图作为图片卡片附上白板与自包含导出，实现"边讲边看资料原图"。不依赖模型遵守插图规则。

## 2. 已核实的可行性事实

- pdf-parse v2（已装，无需新依赖）`PDFParse.getImage(opts)` 返回 `ImageResult.pages: PageImages[]`，`PageImages.pageNumber` 为 1 起始页码，`images: EmbeddedImage[]`；`EmbeddedImage = { data: Uint8Array, dataUrl, name, width, height, kind }`。
- `getImage` 选项：`imageThreshold`（默认 80，宽或高 ≤ 阈值的图被忽略）、`imageDataUrl`（默认 true，本设计设 false 省内存）、`imageBuffer`（默认 true）。
- 探针：讲义_第3章_unlocked.pdf 50 页含 12 张内嵌 raster 图（如 619x705、703x770），证明内嵌提取对该 KB 有效。
- officeparser v8（已装）AST 含 `attachments`（OfficeAttachment）与按幻灯片结构节点；PPTX 图片经 AST 幻灯片节点→image 节点→attachment 映射。映射可行性在实施 Task 1 用探针确认。
- 现状 [lib/parse.js] 只抽文字；[lib/kb.js] chunk 已带 `page`；当前 KB 为 17 个 PDF（无 PPTX），需回填。
- 用户已确认：展示方式=按页自动附带；格式范围=PDF + PPT。

## 3. 架构（方案 A：上传时提取 + 落盘 + 回填）

数据流：
upload/backfill → parse.extract（文字+图片）→ kb.addDoc/setDocImages（写图片文件+doc.json.images）→ retrieve（按页附图）→ streamLesson done.images → board.js 图片卡片 → export 内嵌 base64。

不选 B（检索懒提取：慢、重复 CPU）与 C（整页渲染：带文字、图大）的理由见会话记录；C 的矢量图捕获留待未来可选增强。

## 4. 组件与接口

### 4.1 lib/parse.js
`extract(filePath)` 返回 `{ kind, pages: [{page, text}], images: [{page, data: Buffer, w, h, ext}] }`。
- txt/md/docx：`images: []`（docx 不在本期范围）。
- pdf：现有 getText 之后调用 `getImage({ imageThreshold: 80, imageDataUrl: false })`；按 `pageNumber` 归页；`data` Uint8Array→Buffer；扩展名由魔数判定（PNG `89 50 4E 47`→png，JPEG `FF D8`→jpeg），魔数不符者跳过。
- pptx：改为按幻灯片产出 `pages: [{page: 幻灯片号, text}]`；遍历 AST 幻灯片节点收集其下 image 节点引用的 attachment id，从 `ast.attachments` 取字节，`page`=幻灯片号；w/h 若 attachment 不提供则记 0（前端按自然尺寸显示）。Task 1 探针确认 AST 嵌套关系；若 image 节点不嵌套于幻灯片节点之下，停止并重新设计 PPTX 部分（不得猜测映射）。

### 4.2 lib/kb.js
- 图片目录：`kb/images/<docId>/<page>-<i>.<ext>`（i 为该页内序号，从 0 起）。
- `addDoc({id,name,kind,pages,subject,images})`：写图片文件；`doc.images = [{id:'<page>-<i>', page, w, h, file:'<page>-<i>.<ext>'}]`；上限：每页 4 张、每 doc 60 张（按页序超出截断）。
- 新增 `setDocImages(id, images)`：回填用，写文件+更新 doc.json.images（先清旧目录再写，保证幂等）。
- `getDoc` 返回含 images；`listDocs` 增 `imageCount`。
- `deleteDoc` 连带递归删除 `kb/images/<id>/`。
- ID_RE 校验沿用，防路径穿越。

### 4.3 lib/retrieve.js
retrieve 结果增 `images: [{docId, docName, page, id, url, w, h}]`：对命中 chunk 的 (docId,page) 取 doc.images 同页项，按 (docId,id) 去重，上限 4。`url = '/kb-images/' + docId + '/' + file`。

### 4.4 lib/teach.js
streamLesson 的 done 载荷增 `images`（取 retrieve images 前 2 张）。ask/notes 不带图（本期仅讲解白板+导出）。sys prompt 不变（电路规则保持阶段2现状）。

### 4.5 server.js
- 静态：`app.use('/kb-images', express.static(path.join(__dirname,'kb','images')))`（express.static 自身防穿越）。
- upload：把 `parsed.images` 传入 `kb.addDoc`。
- 新增 `POST /api/kb/:id/images`（回填）：在 uploads 找 `<id>.*` 原文件 → parse.extract → kb.setDocImages → `{ok, count}`；找不到原文件返回 400。
- teach/stream done 透传 images。

### 4.6 前端
- board.js：done 事件存 `lessonImages`；renderBoard 在文字卡片后追加图片卡片（class `wb-card wb-figure`，`<img src=url>` + caption=`docName · 第page页`），纳入 layout()；img onerror 显示占位文字；img.decode() 完成后再 layout()（同电路图片做法），避免尺寸未定导致遮挡。
- util.js：增 image 卡片 HTML helper（供 board 与 export 复用）。
- lesson.js 导出：rec 存 images；buildLessonHTML 将每张 url fetch 为 base64 dataUrl 内嵌（失败则省略该图并保持其余自包含）。
- KB 管理页：每 doc 增"补提取图片"按钮 → POST /api/kb/:id/images → 刷新列表显示 imageCount。

## 5. 错误处理与上限

- getImage/AST 抛错 → images=[]，不阻断上传/回填（console.warn）。
- 每页 4 张、每 doc 60 张、retrieve 4 张、lesson 2 张上限，控存储与白板密度。
- 魔数不符跳过；缺图文件前端 onerror 占位；导出单图失败省略该图。
- 路径安全：ID_RE + express.static；回填只读 uploads 内 `<id>.*`。

## 6. 测试与验收

1. 上传含图 PDF → doc.images 非空、kb/images 落盘、imageCount 正确。
2. 回填现有 PDF（POST /api/kb/:id/images）→ 同上；重复调用幂等。
3. LED 课题 retrieve → images 含对应页图；streamLesson done.images ≤2。
4. 浏览器：白板出现图片卡片、无 console 错误、layout 不遮挡。
5. 导出 HTML 含 base64 img、无外部 /kb-images 路径残留。
6. deleteDoc → kb/images/<id> 清除。
7. 回归：文字 chunk 内容与阶段2电路/func 渲染不变。
8. PPTX：Task 1 探针确认 AST 映射后，上传含图 PPTX 验证按幻灯片附图。

## 7. 约束

- 不新增 npm 依赖（pdf-parse/officeparser 已装）。
- 阶段2电路管线（pdflatex、ASCII、防重叠）保持不变。
- config.json 保持 gitignored；API key 仅后端。
- 代理不执行 git commit/push；由用户最后统一 push。
- 不做 DOCX 图片、矢量图捕获、OCR、AI 主动插图、手动图库（均超出本期）。
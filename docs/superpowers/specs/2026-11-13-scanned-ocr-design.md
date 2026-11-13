# 阶段4：扫描件 OCR 入库 设计文档

日期：2026-11-13
状态：已获用户口头批准（方案 1，四节设计逐节确认），待用户书面复核
范围：扫描 PDF（整本无文字层 + 混合 PDF 的扫描页）+ 独立图片（.png/.jpg/.jpeg）；本地 tesseract.js（chi_sim+eng）；手动"OCR 识别"按钮触发；仅 OCR 文字（原始扫描图不作图片卡片）

## 1. 目标

让扫描类资料（无文字层的扫描 PDF、拍照的图片）也能进入知识库被检索与讲解。当前这类资料上传后文字为空（扫描 PDF 的 `getText()` 无文字层），无法被 RAG 命中。本阶段在现有"上传→extract→addDoc"管线旁，增加一个**按需 OCR 回填**子系统：用户在知识库点"OCR 识别"按钮，对原始上传文件跑本地 OCR，把识别文字回填进文档并重新切块，使其可检索/可讲解。完全本地、不联网、无需 API 密钥。

## 2. 已核实的可行性事实

- 现有管线单一集成点 [lib/parse.js:44] `extract(filePath)` 返回 `{ kind, pages:[{page,text}], images:[{page,data,w,h,ext}] }`；[server.js:65] `/api/upload` 直接喂给 `kb.addDoc`。
- 扫描 PDF 现状：`PDFParse.getText()` 对无文字层页返回空/空白文字；`getImage()`（阶段3已验证可用）返回整页扫描图。故"空文字页 + 有大图"即可判为扫描页，且其整页图可取来 OCR——复用阶段3同一 API，无需新 PDF 依赖。
- 独立图片：阶段3已有 `sniffImage(buf)`（魔数判 PNG/JPEG + 取 w/h），可直接复用来读图。`SUPPORTED` 当前为 `['.txt','.md','.pdf','.docx','.pptx']`，不含图片。
- 回填模式可复用：阶段3 `POST /api/kb/:id/images`（[server.js:96]）已实现"从 uploads 找 `<id>.*` 原文件 → extract → setDocImages → 返回计数"，前端 `public/js/kb.js` 有对应"补提取图片"按钮（doc-img）。OCR 按钮/路由完全仿此模式。
- `kb.addDoc` 用 `chunkPages`（CHUNK=800, OVERLAP=100）切块；`setDocImages`（[lib/kb.js:116]）是"重处理+更新 doc.json"的现成范例，`setDocText` 仿之。
- officeparser 已有 `ocr:false` 选项（[lib/parse.js:80]），说明代码库已知 OCR 概念；本阶段不启用它（PPTX 不在本期 OCR 范围）。
- 用户已确认：引擎=本地 tesseract.js；范围=扫描 PDF（含混合页）+ 独立图片；触发=手动按钮；呈现=仅 OCR 文字（原图不作图片卡片）；语言=简体中文+英文。
- **待实施探针确认（不得猜测）**：tesseract.js 当前稳定版（v5+）的 `createWorker(langs, oem, {langPath})` / `worker.recognize(buffer)→{data:{text}}` 确切 API；以及**多语言离线 langPath 接线**——tesseract 的 `langPath` 是单一目录，`chi_sim+eng` 需两个 `.traineddata.gz` 同处一目录。设计意图：用官方 npm 数据包 `@tesseract.js-data/chi_sim` + `@tesseract.js-data/eng`（随 npm install 落本地），一次性把两个 `.traineddata.gz` 归并到一个本地 gitignored 目录 `ocr-data/`，`langPath` 指向它 → 运行时完全离线。Task 1 探针确认此接线；若 npm 数据包归并不便，回退为一次性从官方 tessdata 源（tessdata.projectnaptha.com，真实源、非代理）下载两个 `.traineddata.gz` 到 `ocr-data/`。无论哪条，运行时不联网。

## 3. 架构（方案 1：独立 OCR 模块 + 专用路由 + 按钮，仿阶段3回填）

数据流：
- 上传（不变+扩展）：`/api/upload → extract（文字 + images插图 + scans扫描图）→ addDoc（只存 images插图，忽略 scans；置 scanned 标志）`。扫描文档此时为"空文字待识别"。
- OCR（新）：`点按钮 → POST /api/kb/:id/ocr → 找 uploads/<id>.* 原文件 → extract 取 scans → ocr.ocrImage(每张scan) → 文字写回 pages[].text → kb.setDocText（重新切块+更新）→ 返回 {ok,ocrPages,chars}`。

不选方案 2（OCR 内嵌 extract：extract 变重、慢路径混入正常提取、难隔离、阶段3回归风险）与方案 3（系统 Tesseract 二进制：外部系统依赖、不可静默安装、跨平台差，违背约束）。

职责分离：`lib/ocr.js` 只管"图→文字"；`lib/parse.js` 只管"提取+扫描页检测+scan/figure 分离"；`lib/kb.js` 只管"切块+持久化"；路由编排；前端按钮。OCR 可独立测试。

## 4. 组件与接口

### 4.1 lib/ocr.js（新）
- `async ocrImage(data: Buffer) → string`：对单张图片 Buffer 跑 OCR，返回识别文字（trim 后）。内部用 tesseract.js worker。
- worker：**懒加载单例**，`createWorker('chi_sim+eng', …, { langPath: <本地 ocr-data 目录> })`，复用避免每次重载训练数据；`recognize` 顺序 await（手动按钮低并发）。首次调用加载训练数据数秒，后续快。
- 训练数据离线：`langPath` 指向本地 `ocr-data/`（含 chi_sim+eng `.traineddata.gz`，见 §2 探针）。运行时不联网。
- 单张识别失败抛错，由路由按页 catch（§5）。
- 导出 `{ ocrImage }`（worker 单例为模块内部状态）。

### 4.2 lib/parse.js（改）
`extract(filePath)` 返回扩展为 `{ kind, pages:[{page,text}], images:[{page,data,w,h,ext}], scans:[{page,data,w,h,ext}], scanned:boolean }`。
- `images` = **文字页**的插图（白板图片卡片，阶段3行为完全不变）。
- `scans` = **扫描页/图片文档**的整页图（OCR 候选，**不**进图片管线）。每个扫描页取其**最大**一张图作为该页 scan。
- `scanned` = `scans.length > 0`（即 kind=image，或 PDF 含扫描页）。
- `SUPPORTED` 增 `.png/.jpg/.jpeg`。新分支：读文件 → `sniffImage` 取 w/h/ext（魔数不符抛"无法识别的图片格式"）→ 返回 `{ kind:'image', pages:[{page:1,text:''}], images:[], scans:[{page:1,data,w,h,ext}], scanned:true }`。
- PDF 分支：现有 `getText` + `getImage` 之后，按页分类——
  - **扫描页判定（启发式）**：该页 `text.trim().length < 16`（`SCAN_TEXT_THRESHOLD=16`，可调）**且** 该页有图满足 `min(w,h) >= 300`（`SCAN_MIN_DIM=300`，排除小图标/噪点）。
  - 扫描页：取该页最大图为 scan 入 `scans`；该页**所有**图都不入 `images`。
  - 文字页：图照常入 `images`（阶段3逻辑不变）。
  - `pages` 仍含所有页（扫描页 text 暂空，待 OCR 回填）。
- txt/md/docx/pptx：`images` 照旧、`scans:[]`、`scanned:false`（不在本期 OCR 范围）。
- **已知局限**：整页栅格大图+极少文字的"图解页"可能被误判为扫描页（图被 OCR 成乱码且不显示为图片）。启发式固有边界，门限可调；17 份文字 PDF 不受影响（页页有文字）。

### 4.3 lib/kb.js（改）
- doc 模型增 `scanned:boolean`。`addDoc({…, scanned})` 存入（来自 extract.scanned）；含义"这是一份扫描类文档"，持久、不因 OCR 清除（按钮常驻可重跑）。
- 新增 `setDocText(id, pages, images)`：仿 `setDocImages`——`chunkPages(pages)` 重新切块，更新 `doc.pages/pages.length/chars/chunks`，并 `writeImages(id, images)` 更新插图（扫描文档 images 通常为空），写回 doc.json。`scanned` 标志保持。ID_RE 校验。返回 bool。
- `listDocs()` 增 `scanned`（供前端决定按钮显隐）。
- `getDoc` 返回含 scanned；`deleteDoc` 不变（已连带删 uploads/<id>.* 与 kb/images/<id>）。

### 4.4 server.js（改）
- 新增 `POST /api/kb/:id/ocr`：
  1. `ID_RE` 校验 id → 400；`kb.getDoc(id)` 不存在 → 404。
  2. 从 uploads 找 `<id>.*` 原文件（同回填）；找不到 → 400"找不到原始上传文件，无法 OCR"。
  3. `extract(src)`；kind 非 pdf/image → 400"该文档无需 OCR"。
  4. 取 `parsed.scans`，按页序最多 `MAX_OCR_PAGES=50` 张；逐张 `await ocr.ocrImage(scan.data)`，文字写回对应 `pages[].text`；单张抛错 catch 跳过该页继续（部分成功）。
  5. `kb.setDocText(id, parsed.pages, parsed.images)`。
  6. 返回 `{ ok, ocrPages: 成功识别页数, chars: 新文字总数, truncated: scans是否超50 }`。
  7. 整体异常 → 500 `{error}`。
- upload 路由：把 `parsed.scanned` 传入 `kb.addDoc`（其余不变）。
- 静态/回填/teach 等路由不变。

### 4.5 前端 public/js/kb.js（改）
- doc 行在"补提取图片"（doc-img）旁增"OCR 识别"按钮（class/doc-ocr），**仅当 `d.scanned` 显示**。
- 点击 handler 仿 doc-img：禁用按钮 + 文案"识别中…"（附"较慢，请稍候"）→ `postJSON('/api/kb/'+id+'/ocr')` → 成功 toast"识别 N 页（M 字）"（truncated 时附"已识别前 50 页"）+ 刷新列表（chars/chunks 更新）→ 恢复按钮；失败 toast 错误 + 恢复。
- `.doc-subj` change handler 与现有 doc-img/doc-del handler 不动；按钮顺序与事件委派仿现有模式。

## 5. 错误处理与上限

- 找不到原始上传 → 400（同回填）；kind 不支持 → 400；ID 非法 → 400；doc 不存在 → 404。
- traineddata 缺失 / worker 初始化失败 → 500 明确报错；前端 toast。
- 单页 OCR 抛错 → catch 跳过该页、继续其余，返回部分成功计数（不因一页坏图整篇失败）。
- OCR 结果为空 → 存空文字，返回计数；前端提示"识别完成但结果为空（可能图质差）"。
- 上限：`MAX_OCR_PAGES=50`/次（界定延迟，超出识别前 50 并提示）；扫描页门限 `SCAN_TEXT_THRESHOLD=16`、`SCAN_MIN_DIM=300`（可调）。
- 上传不跑 OCR → 上传延迟不变。
- 路径安全：ID_RE + 只读 uploads 内 `<id>.*`（同回填）；ocr-data 本地资产。
- 幂等：OCR 可重跑，setDocText 覆盖文字与切块。

## 6. 测试与验收

无框架，沿用一次性 node 脚本（系统 Temp）+ browser-use 实测。
1. **合成夹具**：browser-use 把已知中英文文字渲染 HTML 截图 → PNG（ground truth）；扫描 PDF 夹具用 pdf-lib（test-only devDep）把该图嵌入 PDF，或单元测试以 mock 的 getText/getImage 结果替代。
2. `lib/ocr.js`：OCR 夹具 PNG → 文字非空且含关键词（如"存储器""ARM"，**模糊匹配**，tesseract 非 100% 准）。
3. `lib/parse.js`：① 图片分支 → kind=image、text 空、images=[]、scans.length=1、scanned=true；② 扫描 PDF → 检出扫描页、scans 含整页图、images 空；③ **回归**：阶段3文字 PDF 夹具 → images（插图）不变、scans 空、scanned=false。
4. `kb.setDocText`：重新切块、更新 chars/pages/chunks/images；scanned 保持。
5. 路由：stub `ocr.ocrImage` 返回已知文字 → 对扫描文档 POST /ocr → 文字回填、chunks 更新、ocrPages 计数正确；非扫描 kind → 400；无原文件 → 400。
6. **浏览器 e2e**：上传合成扫描 PDF + 图片 → 出现"OCR 识别"按钮 → 点击 → 文字出现、chars>0、白板显示文字卡片（**无扫描图卡片**）→ 备课能用上 OCR 文字。
7. **回归**：阶段2电路管线（pdflatex/ASCII/防重叠）+ 阶段3 T1/T3 测试保持 GREEN；17 份文字 PDF 的 imageCount/文字不变。
8. 离线验证：OCR 运行时断网（或确认 langPath 本地、无 CDN 请求）仍成功。

## 7. 约束

- 新增 npm 依赖：`tesseract.js` + `@tesseract.js-data/chi_sim` + `@tesseract.js-data/eng`（训练数据本地化）；pdf-lib 仅 test-only devDep（夹具）。运行时完全离线、无需 API 密钥。
- 阶段2电路管线、阶段3图片提取/展示/导出管线保持不变（文字 PDF 的 images 行为不变）。
- config.json 保持 gitignored/staged-deletion；API key 仅后端；OCR 不涉及密钥。
- 代理不执行 git commit/push；由用户最后统一 push（含本 spec）。
- 不做：PPTX/DOCX 的 OCR、矢量图捕获、上传时自动 OCR、云端 OCR、手写体专门优化、AI 主动插图（均超出本期）。
- 改动最小化（"不要对项目作过大改动"）：复用阶段3回填模式，OCR 隔离为小子系统。
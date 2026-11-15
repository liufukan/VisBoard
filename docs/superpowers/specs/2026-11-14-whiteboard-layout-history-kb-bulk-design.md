# VisBoard 白板侧栏布局 · 历史记录 · 知识库批量 设计

日期：2026-11-14
状态：已获用户批准（三项推荐默认全选）。批准后自主逐步实现，中间不再请求确认；commit/push 留给用户。

## 目标

1. 白板主知识点保持中间两列实线串联；追问对话与联网拓展内容移到左/右空白侧栏，用虚线箭头从对应知识点指出去，不再插入主列。
2. 新增「历史记录」页：每次讲课自动保存为可回顾的记录（含追问对话），只读、不能继续讲课。
3. 历史记录包含追问对话。
4. 知识库多选方块，批量「移动到科目 / 删除 / 补提取图片」。

## 全局约束

- 不新增任何 npm 依赖；前端原生 ES Module、无构建。
- API Key 只存后端；历史快照属本地私人数据，存 `history/`（gitignore），不上传云端。
- 不做 git 写操作（不 commit/push）；实现完留给用户提交。
- 复用现有渲染/端点，避免两套几何逻辑；白板渲染抽共享模块。
- 电路/函数/数学渲染管线保持不变。

## 已确认决策

- 历史存储：后端 `history/` 目录（JSON 快照，按会话 id upsert）。
- 历史查看：只读 spatial 白板（复用共享渲染器，两列+侧栏+虚线，可缩放平移，无输入/菜单/开始）。
- 知识库批量：仅 移动/删除/补图，不含 OCR。

---

## 功能 1：白板侧栏布局

### 几何（wb-scene.js 常量）

- `SIDE_W = 360`（侧框宽），`RAIL_GAP = 48`（侧栏与主列间距）。
- `LEFT_X = 40`（左栏=联网拓展）。
- `COL_W = 540`，主列 gutter = 40。
- `COL0_X = LEFT_X + SIDE_W + RAIL_GAP = 448`。
- `COL1_X = COL0_X + COL_W + 40 = 1028`。
- `RIGHT_X = COL1_X + COL_W + RAIL_GAP = 1616`（右栏=追问）。
- `CONTENT_W = RIGHT_X + SIDE_W + 40 = 2016`。
- `GUTTER_X = (COL0_X + COL_W + COL1_X) / 2`（主列间空沟，flow 弯曲用）。

### 块拆分

`splitBlocks(full)`：调用 `parseBlocks(cleanFull(full))`，去掉首个 title；把 `type==='text'` 且 `heading` 匹配 `/来自网络/` 的块归入 `web`，其余归入 `main`。返回 `{main, web}`。
（依据：后端 `WEB_RULE` 强制 `## 拓展阅读（来自网络）` 小节。）

### 元素构建（共享）

- `makeCardEl(b, circuitCache)`：按现有 board.js 逻辑创建 `.wb-el` 卡片（title/text/figure/circuit/func），innerHTML=blockHtml。
- `makeWebEl(b, webCitations)`：`.wb-el wb-web` 侧框，头部「联网拓展 · 来自网络」+ blockHtml(b) + webCitesHTML。
- `makeDialogEl(d, {readOnly})`：现有 `.wb-dialog` 结构；readOnly 时去掉 `.dlg-input` 与 `.dlg-close`，thread 用 mdToHtml 渲染 d.history。

### 布局 `layoutScene(scene)`

scene = `{cards, dialogs:[{el,source}], web:[{el,source}], canvas, links}`。
- 两列 colH=[40,40]；title 全宽（left=COL0_X, width=COL1_X+COL_W-COL0_X）；其余卡片放较短列。
- 右栏游标 rY=40；按创建序遍历 dialogs：`y=max(rY, sourceTop-8)`，x=RIGHT_X，width=SIDE_W；rY=y+h+18。
- 左栏游标 lY=40；web 同理 x=LEFT_X。
- bounds.w=CONTENT_W；bounds.h=max(900, 所有 maxY+80)；设置 canvas 尺寸。
- drawLinks：主卡片相邻 flowPath（实线蓝，现有）；dialog 用 `sidePath(source, el, 'right')` 橙色虚线（lk-drill）；web 用 `sidePath(source, el, 'left')` 青色虚线（新增 lk-web + marker ah-web）。
- `sidePath(a,b,side)`：从 a 的右/左缘中点水平弯到 b 的左/右缘中点，三次贝塞尔，控制点水平外扩。

### board.js 重构

- 移除内部 layout/drawLinks/几何常量/flowPath/drillPath，改 import wb-scene。
- renderBoard：用 splitBlocks 得 main/web；main→cards（含 lessonImages 追加为 figure 卡片），web→webEls（source=最后一个 main 卡片或 topic）。维护 cards/webEls 与块索引对齐，多余移除。
- dialogs 保持 {el,source,...}；createDialog 宽度改 SIDE_W。
- layout() 调 layoutScene({cards, dialogs, web:webEls, canvas, links})。
- focusDialog/followLast 用新几何（无需大改，读 style.left/top）。

### CSS

- `.wb-web`：白底、顶边青色（--cyan）、圆角14、阴影同 wb-card；头部小标签。
- `.lk-web`：青色虚线（stroke-dasharray 7 7）。
- 侧框内 thread 滚动条沿用 dlg-thread 样式。

## 功能 2+3：历史记录

### 后端 lib/history.js

- 目录 `history/`（不存在则 mkdir）。文件名 `<id>.json`，id 校验 `/^[a-zA-Z0-9-]+$/`。
- `save({id, topic, board})`：id 缺省生成 crypto.randomUUID；写 `{id, topic, savedAt:Date.now(), board}`；返回 {id}。限制 board.full 长度（如 ≤200k）与 dialogs 数量（≤50）防滥用。
- `list()`：读目录，返回 `[{id, topic, savedAt, cards, dialogs}]` 按 savedAt 降序；cards/dialogs 由 board 估算（parseBlocks 计数可在前端做，后端只存原始；list 返回 dialogs=board.dialogs.length, cards 估算=board.full  split 行数? 简化：后端不解析，list 只返回 {id,topic,savedAt,dialogCount}，cards 由前端查看时算）。
- `get(id)`、`remove(id)`。

### server.js 路由

- `POST /api/history/save`、`GET /api/history/list`、`GET /api/history/:id`、`DELETE /api/history/:id`。
- `.gitignore` 增加 `history/`。

### 自动保存（board.js）

- start() 时 `sessionId = crypto.randomUUID()`（浏览器有 crypto.randomUUID）。
- persistBoard() 内追加防抖（600ms）`postJSON('/api/history/save', {id:sessionId, topic, board:{full,citations,webCitations,dialogs:snapshotDialogs(),images:lessonImages}})`，失败静默（toast 一次）。
- clear() 不删历史（历史是档案）。

### 前端 history.js + 路由 + 导航

- routes 增加 `/history`；index.html 侧边栏加「历史记录」入口（nav-item data-page=history）。
- 列表：GET list → 卡片行（课题、fmtDate(savedAt)、追问数）；操作=查看/导出HTML/删除（删除 confirmModal）。
- 查看：GET :id → 只读 viewer。viewer 复用 wb-scene：build cards/web/dialogs(readOnly) → layoutScene；自带 zoom/pan（复用 board 的 vw/applyView/zoomAt/fitView 逻辑，抽到 wb-scene 或 history 内联简化版）。无 start/menu/input。顶部显示课题+时间+「只读」徽章+返回。
- 导出HTML：复用 lesson.js buildLessonHTML/exportLessonHTML 逻辑，但数据源为历史快照而非 localStorage。新增 `exportSnapshotHTML(topic, board, notes=null)`：把 exportLessonHTML 的电路/图片/katex 内联逻辑参数化（接受 board 对象）。历史导出 notes 为空提示。

## 功能 4：知识库批量

- kb.js renderList 每行加 `<input type=checkbox class=doc-check data-id>`；工具条加「全选」checkbox + 「已选 N」+ 批量条（移动到科目 select+应用、补提取图片、删除）。
- 维护 `selected:Set`；renderList 保留选中状态；全选作用于当前过滤列表。
- 批量执行：顺序遍历 selected，调用现有端点（subject/images/DELETE），进度 toast「i/N」；删除前 confirmModal 一次；完成后 load()+refreshConn()，清空 selected。
- 批量条仅在有选中时显示。

## 测试 / 验证

- node --check 所有改动后端文件。
- 浏览器（browser-use）实测：live 开课→主两列、追问右栏虚线、联网左栏虚线；历史自动保存→/history 列表→只读查看（含追问、无输入）→导出；KB 多选→批量移动/补图/删除。
- 回归：数学/代码/函数/电路渲染不变；导出 HTML 仍自包含。

## 交付

- 不 commit/push；完成后汇报，用户自行提交。
- 顺带更新 README（新功能：侧栏布局/历史记录/批量管理）。
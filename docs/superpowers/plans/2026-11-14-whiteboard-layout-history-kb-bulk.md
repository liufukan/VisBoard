# 白板侧栏布局 · 历史记录 · 知识库批量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; user is away, no mid-checkins). Steps use checkbox (`- [ ]`). **No git writes** — do NOT commit/push; leave working tree for the user.

**Goal:** 主知识线两列+侧栏虚线布局；历史自动保存(含追问)只读回顾+HTML分享导出；知识库多选批量移动/删除/补图。

**Architecture:** 抽共享白板渲染模块 `public/js/wb-scene.js`（几何/布局/连线/元素构建/缩放平移），live board 与只读 history 共用。后端 `lib/history.js` 存 `history/` JSON 快照。KB 批量复用现有单条端点。

**Tech Stack:** Node/Express5 CommonJS 后端；原生 ES Module 前端无构建；browser-use 实测。

**Spec:** docs/superpowers/specs/2026-11-14-whiteboard-layout-history-kb-bulk-design.md

## Global Constraints

- 不新增 npm 依赖；前端无构建。
- API Key 只存后端；history/ 本地私人数据，gitignore。
- 不 commit/push（用户最后提交）。
- 电路/函数/数学渲染管线不变。
- 批量仅 移动/删除/补图，不含 OCR。
- 历史查看=只读 spatial 白板；历史列表与查看页都要有「导出 HTML」分享按钮。

## 文件结构

- Create `public/js/wb-scene.js`：共享几何+布局+连线+元素构建+视图控制。
- Create `lib/history.js`：历史快照存储。
- Create `public/js/history.js`：历史页+只读查看器。
- Modify `public/js/board.js`：用 wb-scene；侧栏布局；自动保存。
- Modify `public/js/lesson.js`：exportSnapshotHTML 参数化。
- Modify `public/js/kb.js`：多选+批量条。
- Modify `public/js/app.js`、`public/index.html`：/history 路由+导航。
- Modify `server.js`：history 路由。
- Modify `.gitignore`：history/。
- Modify `public/style.css`：wb-web/lk-web/历史页/批量条样式。
- Modify `README.md`：新功能。

## 共享接口（wb-scene.js）

```
export const GEO = { SIDE_W:360, RAIL_GAP:48, LEFT_X:40, COL_W:540, COL0_X:448, COL1_X:1028, RIGHT_X:1616, CONTENT_W:2016, GUTTER_X:1008, GAP_Y:32 };
export function cleanFull(s)
export function splitBlocks(full) -> {main:[block], web:[block]}
export function makeCardEl(b, circuitCache) -> HTMLElement
export function makeWebEl(b, webCitations) -> HTMLElement
export function makeDialogEl(d, {readOnly}) -> HTMLElement
export function cardRect(el) -> {l,t,w,h,r,b}
export function layoutScene({cards, dialogs, web, canvas, links}) -> bounds{w,h}
export function createView(canvas, viewport) -> {applyView, zoomAt, fitView, focusEl, get vw, set vw, panBy...}
```

dialogs/web 元素项形如 `{el, source}`（source 为主卡片元素）。

---

### Task 1: wb-scene.js 共享模块 + CSS

**Files:** Create `public/js/wb-scene.js`; Modify `public/style.css`.
**Interfaces:** Produces 上述共享接口（Task 2/5 消费）。

- [ ] 1 实现 wb-scene.js：GEO 常量；cleanFull（同 board 现有）；splitBlocks（parseBlocks+去首 title+按 heading /来自网络/ 分 web）；makeCardEl/makeWebEl/makeDialogEl（复用 util.blockHtml/mdToHtml/webCitesHTML/esc）；cardRect；flowPath（搬自 board，GUTTER 用 GEO）；sidePath(a,b,side)；layoutScene；createView（搬 board 的 vw/applyView/zoomAt/fitView/focus 逻辑，参数化 bounds）。
- [ ] 2 layoutScene：两列放主卡片(title 全宽)；右栏 dialogs、左栏 web 就近 source 堆叠；bounds.w=CONTENT_W；drawLinks 用 FLOW_DEF/DRILL_DEF/WEB_DEF + flowPath + sidePath。
- [ ] 3 CSS：`.wb-web`（白底顶边 cyan）、`.lk-web`（cyan 虚线）、`.wb-web .web-head`、历史页 `.hist-*`、批量条 `.kb-bulk`、`.doc-check`。
- [ ] 4 `node --check` 不适用(ESM)；用浏览器 import 冒烟（Task 2 一并）。

### Task 2: board.js 重构为侧栏布局

**Files:** Modify `public/js/board.js`.
**Consumes:** wb-scene 接口。
- [ ] 1 删除 board 内部几何常量/flowPath/drillPath/layout/drawLinks/视图函数，改 import wb-scene。
- [ ] 2 renderBoard：splitBlocks；main→cards（+lessonImages figure），web→webEls(source=最后 main 卡片)；对齐索引、多余移除；resolveCircuitFrames 后 layoutScene。
- [ ] 3 createDialog 宽 SIDE_W；dialogs 项 {el,source}；layout()=layoutScene({cards,dialogs,web:webEls,canvas,links})。
- [ ] 4 视图用 createView；followLast/focusDialog 适配。
- [ ] 5 浏览器实测：开课→主两列实线；点卡片追问→右栏虚线；联网开→左栏虚线；缩放平移正常。

### Task 3: 后端 history + 路由 + gitignore

**Files:** Create `lib/history.js`; Modify `server.js`, `.gitignore`.
- [ ] 1 lib/history.js：save/list/get/remove（id 校验、mkdir、上限 full≤200000/dialogs≤50）。
- [ ] 2 server.js 四路由。
- [ ] 3 .gitignore 加 `history/`。
- [ ] 4 `node --check lib/history.js server.js`；curl 冒烟 save/list/get/delete。

### Task 4: board.js 自动保存

**Files:** Modify `public/js/board.js`.
- [ ] 1 start() 生成 sessionId=crypto.randomUUID()。
- [ ] 2 persistBoard() 防抖600ms postJSON /api/history/save {id,topic,board}；失败静默。
- [ ] 3 浏览器：开课后 history/ 出现快照；追问后快照 dialogs 更新。

### Task 5: lesson.js 导出参数化 + history.js 页 + 路由/导航

**Files:** Modify `public/js/lesson.js`, `public/js/app.js`, `public/index.html`; Create `public/js/history.js`.
- [ ] 1 lesson.js：抽 `exportSnapshotHTML(topic, board, notes)`（电路/图片/katex 内联逻辑参数化）；exportLessonHTML 调它；buildLessonHTML 增加可选 board 覆盖参数。
- [ ] 2 history.js：列表(GET list)+查看(GET :id 只读 viewer 用 wb-scene)+导出HTML(exportSnapshotHTML)+删除(confirmModal)。查看页与列表行都有导出按钮。
- [ ] 3 app.js routes + index.html 导航「历史记录」。
- [ ] 4 浏览器：/history 列表→查看只读(含追问、无输入)→导出HTML下载→删除。

### Task 6: kb.js 多选批量

**Files:** Modify `public/js/kb.js`, `public/style.css`.
- [ ] 1 行加 checkbox；工具条全选+已选N+批量条(移动select+应用/补图/删除)。
- [ ] 2 selected Set；批量顺序执行现有端点+进度toast；删除 confirmModal 一次；完成 load+refreshConn+清空。
- [ ] 3 浏览器：多选→批量移动/补图/删除 生效。

### Task 7: 端到端回归 + README

**Files:** Modify `README.md`.
- [ ] 1 回归：数学/代码/函数/电路渲染不变；导出自包含；live 追问/联网侧栏。
- [ ] 2 README：侧栏布局/历史记录(含HTML分享)/批量管理/项目结构+history。
- [ ] 3 汇报；不 commit。

## Self-Review

- 覆盖：功能1→T1/T2；功能2/3→T3/T4/T5；HTML分享→T5；功能4→T6；回归/README→T7。无遗漏。
- 接口一致：wb-scene 签名在 T1 定义、T2/T5 消费一致；history 路由 T3 定义、T4/T5 消费一致。
- 无占位符；不 commit 步骤已注明。
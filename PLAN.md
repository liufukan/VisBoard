# VisBoard — 个人知识库 AI 家教(ahaboard 风格)

上传课件/资料搭建知识库,AI **以你的知识库为主**来教你:
边画边讲、点不懂就深入、课后笔记+小测、错点再讲,直到教会。
必要时可开启「联网拓展」补充背景(双密钥:生成用学校 key,搜索用独立 searchApiKey),来源清晰区分「资料」与「网络」。

## 架构

- 后端:Node.js + Express,监听端口(默认 3000),同源托管前端 + 提供 API。
- 前端:原生 HTML/CSS/JS(无框架、无构建),浏览器打开 `http://localhost:3000`。
- LLM:OpenAI 兼容接口,默认 DeepSeek,可改学校 key(改 `config.json`)。**key 只存后端**。
- 知识库:存本机 `kb/`,不上传云端。检索用"AI 引导检索"(只用已有 key,无需额外模型)。
- 图:AI 生成 SVG 代码,前端渲染 + 逐笔动画(不花图像生成的钱)。
- 流式:SSE(`text/event-stream`),前端用 fetch + ReadableStream 消费。

## 文件结构

```
D:\visboard\
  server.js        后端:静态托管 + 上传解析 + 知识库 + 检索 + LLM/SSE
  config.json      port / baseUrl / apiKey / model(你填 key)
  package.json
  PLAN.md          本清单
  public\
    index.html     教学页面
    style.css
    app.js         SSE 客户端 + 白板渲染 + 点击深入 + 测验
  kb\              知识库存储(解析后的切块 + 元数据)
  uploads\         上传的原始文件
```

## 核心数据流

1. 上传文件 → 解析成文本 → 切块 + 存 `kb/`(带 文件/页码 元数据)。
2. 输入主题 → AI 引导检索相关段落 → 据此备课 → SSE 逐步推送 → 白板边画边讲(标注来源)。
3. 点不懂的词/步骤 → 再检索 → 深入讲解,就地展开。
4. 学完 → 笔记 + 小测 → 错点再讲,闭环。

## 步骤清单(每步可运行/可验证)

### 阶段一:知识库
- [x] 第0步:骨架(目录、package.json、config、PLAN.md、装依赖)。验证:目录就位、依赖装好。
- [x] 第1步:后端起端口 + 托管占位前端。验证:浏览器能打开。
- [x] 第2步:上传 + 解析(PDF/txt/md/docx/pptx)→ 文本。验证:传样例能看到文本。
- [x] 第3步:切块 + 存储 + 知识库管理界面(列表/删除)。验证:能看到已传资料。
- [x] 第4步:AI 引导检索接口。验证:问主题返回相关段落+来源。(需 key)

### 阶段二:ahaboard 式教学
- [x] 第5步:基于知识库备课,生成结构化课程(先非流式)。验证:能出一节课。
- [x] 第6步:SSE 流式 + 白板渲染(SVG 逐笔动画+讲解)。验证:边画边讲。
- [x] 第7步:点击深入(仍依据知识库,就地展开)。验证:交互闭环。
- [x] 第8步:笔记 + 小测 + 错点再讲。验证:完整闭环。
- [x] 第9步:错误处理 + 填 key 引导 + 来源标注 + 端到端实测。验证:全流程可用。

### 阶段三:四项改进(增量式,不动现有骨架,向后兼容)

- [x] 第10步:科目分区。
  - 新增 `subjects.json`(根目录)登记表 `[{id,name,createdAt}]`;`lib/kb.js` 加 `listSubjects/addSubject/deleteSubject`,资料加 `subject` 字段(旧资料归「未分区」)。
  - `kb.allChunks(subject)` / `retrieve(question,subject)` 按科目过滤;`addDoc` 接收 subject。
  - 后端:`/api/subjects`(GET/POST/DELETE)、`/api/kb` 支持改归属、upload/teach/ask/notes/quiz/retrieve 透传 subject。
  - 前端:知识库页科目管理(建/删)+上传选科目+列表筛选+每行改归属;白板/备课/复习顶部科目选择器,选中存 localStorage 跨页一致,「全部」兼容旧行为。
  - 验证:建两个科目各传一份资料,选科目 A 检索只命中 A;旧资料仍可在「全部/未分区」检索到。
- [x] 第11步:联网拓展(双密钥)。
  - `config.json` 加 `searchApiKey`、`searchProvider`(默认 bocha);新增 `lib/search.js` 的 `webSearch(query)`→`[{title,url,snippet}]`(博查 API,仅用 searchApiKey)。
  - teach/review 提示词去掉「不要联网搜索」硬约束,改为「主体依据资料;拓展部分标注来自网络」。
  - 白板/备课/复习加「联网拓展」开关(默认关);开启且 KB 相关片段<2 或 KB 为空时补一次搜索,联网内容单独成段 `## 拓展阅读（来自网络）`。
  - done 事件带独立 `webCitations:[{title,url}]`;前端渲染「网络」chip(带链接),与蓝色「资料」chip 分开。
  - 验证:关开关→纯 KB;开开关+填 searchApiKey→出现「网络拓展」段与网络来源 chip;未填 searchApiKey 时优雅降级(仅 KB,不报错)。
  - 实测:开关默认关、存 localStorage 跨页一致;board/prepare/review 请求体均带 web 标志;webCitesHTML 渲染琥珀色「网络」chip(带链接、rel=noopener、标题转义);开开关+无 searchApiKey 真实备课→纯 KB 教案(5 节、interrupts.md)、0 网络 chip、无报错;设置页显示搜索密钥状态;控制台零报错。(填 key 后的真实联网待用户配置博查密钥后验证)
- [x] 第12步:导出本课自包含 HTML(白板+追问+笔记)。
  - 新增 `public/js/lesson.js`:按课题缓存本课记录(localStorage),白板完成写入讲解 Markdown+追问历史,复习页生成笔记写入笔记。
  - 导出构建器复用 `parseBlocks/blockHtml/mdToHtml/sanitizeSvg`,拼成单个 .html(内联浅色 CSS、嵌入 SVG),Blob 下载。
  - 白板顶栏 + 复习页各加「导出本课 HTML」按钮;笔记未生成时该节显示提示。
  - 验证:上一节课+点几个追问+生成笔记→导出 HTML,双击离线打开,文字/图/追问/笔记齐全且排版正常。
  - 实测:builder 22 项断言全过(内联 CSS、无 script/外链、SVG 嵌入、转义、chip、对话气泡、缺笔记/缺追问提示);真实白板课(中断系统,9 卡 2 图)→done 自动存档+导出按钮显现;explain 追问→对话持久化;iframe 渲染导出件:2 个 SVG 777×337、3 节、无横向溢出、0 script;复习页生成笔记(827 字)→合并进同课题记录,导出件笔记节由提示变正文,白板/追问保留;board+review 两处导出按钮均触发成功;控制台零报错。
- [x] 第13步:多题型小测。
  - `generateQuiz` 混合出题,按 `type` 区分:single/multi(answer 下标数组)/judge(对错)/blank(可接受答案数组)/short(带参考答案)。
  - 新端点 `/api/quiz/grade`:用学校 key 让 LLM 判简答(返回是否通过+点评);客观题前端自动判(填空忽略大小写/空格)。
  - 前端 `renderQuiz` 按题型渲染控件(单选/复选/对错/文本框/文本域),提交合并判分,显示得分+逐题解析,答错可「再讲一遍」。
  - 验证:出一组混合题,各题型作答→提交,客观题自动判、简答 LLM 判,得分与解析正确,错点可再讲。
  - 实测:后端判分单测(释义正确→pass、错误→fail、空答→自动 fail「未作答」)全过;`/api/quiz` 路由 200,6 题覆盖 single/judge/blank/multi/short 五题型;浏览器真实作答(单选/判断/多选/填空答对、单选故意答错、简答写完整答案)→提交,客观题本地自动判、简答走 `/api/quiz/grade` LLM 判,得分 5/6、逐题解析+填空参考答案(压入/push)+简答点评+参考答案齐全;答错题显现「再讲一遍」→流式通俗讲解(中断嵌套类比,282 字,引用 interrupts.md);「重新作答」清空答案/得分/控件回到 0/6;除一次因 --watch 重启导致的瞬时 ERR_CONNECTION_RESET(重试即恢复)外控制台零报错。
- [x] 第14步:端到端实测 + 回归。
  - 全流程:选科目→联网开关→白板讲解→追问→导出 HTML→笔记→多题型小测→判分→再讲。
  - 回归:首页/知识库/备课/设置、错误与填 key 引导、清空重置;浏览器控制台零报错。
  - 实测:全新会话全流程跑通——科目(计算机原理)与联网开关(默认关)跨页 localStorage 一致;白板讲解中断系统(9 卡 3 图)→点卡「解释一下」追问(362 字,就近对话框)→「导出本课 HTML」成功;复习页生成笔记(493 字,引用 interrupts.md)→「导出本课 HTML」成功;多题型小测 6 题(单选/判断/多选/填空/简答)作答→提交 5/6(客观题自动判+简答 LLM 判)→答错题「再讲一遍」流式通俗讲解;localStorage 同课题记录合并白板(4059 字)+追问(1 段)+笔记(714 字)。回归:首页/知识库/备课/设置均正常渲染,设置密钥状态「已配置·仅存后端」、搜索密钥「未配置·联网拓展不可用」;空课题→「请先输入课题」引导;首页/知识库/备课/设置/白板/复习六页控制台零报错。
- [x] 第15步:联网搜索改用 DeepSeek Search API(生成仍用学校免费 key)。
  - `lib/search.js` 加 provider 分支:`deepseek`(默认)走 `POST https://api.deepseek.com/v1/tools/search`,body `{query,count,need_content:false}`,解析 `data.results[]`(title/url/summary);保留 `bocha` 分支兼容。仅用 `searchApiKey`,绝不回退生成 key;无 key/空查询/HTTP 失败/异常均优雅返回 `[]`。
  - `config.json` 的 `searchProvider` 改为 `deepseek`(`searchApiKey` 留空待用户填);`settings.js` 提示由博查改为 DeepSeek(platform.deepseek.com、与生成密钥独立、约 ¥5/千次)。
  - 实测:stub-fetch 单测 21 项断言全过(deepseek URL/body/鉴权用 searchApiKey、results 解析+过滤无效项、snippet 压缩、空 key/空查询不发请求、HTTP 401 与抛错均降级 []、bocha 分支保留、缺省 provider=deepseek、鉴权绝不用生成 key);`/api/config` 与 `/api/health` 均 `hasSearchKey:false`、生成 `baseUrl/model` 不变;设置页搜索 chip「未配置·联网拓展不可用」、提示含 DeepSeek 无博查;备课页「联网拓展」开关 no-key 态+降级 title;设置/备课两页控制台零报错。(填 DeepSeek key 后的真实联网待用户配置后验证)
- [x] 第16步:修复「讲解中切页白板被清空」——退出课程确认弹窗。
  - 根因:`app.js render()` 切页时先调白板 `cleanup()`(`controller.abort()` 中断讲解流)再 `view.innerHTML=''` 销毁卡片;返回时 `board.mount` 全部状态重新初始化为空,且生成中 `persistBoard` 尚未执行(仅 done 时存),无守卫无恢复→白板丢失。先浏览器复现:讲解中(2 卡)切到知识库再回白板→0 卡、空状态、课题清空。
  - 方案(用户认可的「弹窗确认后再清空」):`util.confirmModal`(Promise<bool>,深色模态、退出图标、危险色「退出课程」+安全默认聚焦「继续上课」、Esc/遮罩取消、Tab 焦点 trap、强制 reflow 入场避免后台标签 rAF 节流);`board.js` 暴露 `isLessonActive()`(讲解流或追问流进行中为真,mount 注册/cleanup 置空);`app.js` 导航守卫 `allowLeave()` 拦截 nav 点击与同页重点击,`popstate` 守卫前进/后退(取消则 `pushState` 还原白板 URL)。仅生成中拦截,完成后/空闲不打扰。
  - 实测:① 讲解中点知识库→弹窗(标题/正文/双按钮/安全聚焦正确,计算样式 opacity1·居中·z200·危险红),取消→留在白板、卡片保留、流继续「讲解中…」;② 再切→确认「退出课程」→跳转知识库、白板销毁、流中断;③ 浏览器后退→弹窗,取消→URL 还原 /board、白板与流保留;④ 讲解完成(8 卡、导出/笔记按钮显现)→点「笔记小测→」无弹窗自由跳转;⑤ 空闲白板切页无弹窗;全程控制台零报错、无残留模态 DOM。
- [x] 第17步:AI 备课改为「讲解提纲预览 + 修改意见迭代」,确认后的提纲驱动白板讲解。
  - 定位:备课不再只是「满意后上白板」,而是讲解前先列一份**提纲**让学生预览这堂课即将学什么;不满意可填修改意见让 AI 据此调整,满意后一键上白板**按提纲**讲解(「即将要学的」与白板实际内容一致)。
  - 后端:`lib/teach.js prepareLesson(topic,subject,web,{feedback,previous})` 支持迭代——有意见时把「当前提纲 JSON + 学生修改意见」一并喂给模型,要求保留合理部分、只改需要改的地方,仍严格依据资料;`streamLesson` 新增 `plan` 参数,确认提纲存在时追加 planRule 要求严格按提纲结构与顺序展开(每小节对应一个 ## 小标题)。`server.js` 新增 `POST /api/teach/revise`(校验 topic/feedback/previous.sections,feedback 截断 600 字),`/api/teach/stream` 透传 `plan`。
  - 前端:`prepare.js` 重写为提纲预览卡(eyebrow「讲解提纲 · 预览」+ 预览提示 + 编号小节 + 来源)+ 琥珀色「修改意见」面板(5 个建议 chip 一键填入、主题滚动条 textarea、Ctrl/⌘+Enter 提交、「按意见调整」按钮、调整次数徽标);调整时旧提纲 dim+spinner、控件禁用,成功后重渲染并 `savePlan`。`lesson.js` 加 `savePlan/getPlan`(localStorage,与 board/notes 同记录);`board.js start()` 读取 `getPlan(topic)` 随 `/api/teach/stream` 发送。`style.css` 加预览/修改面板样式与 ≤640px 响应式。
  - 实测:node 端到端——生成 5 节提纲→意见「多加例子,更通俗易懂」→提纲改写为生活类比版(接电话/按门铃/VIP 通道等)→以**修订后提纲**驱动 stream,白板 5 个 ## 小标题与提纲逐字一致;`/api/teach/revise` 四类缺参均 400(请输入课题/请先填写修改意见/请先生成讲解提纲×2)。浏览器——备课页生成提纲渲染正确(预览徽标/编号小节/去白板链接 topic 正确)、chip 填入 textarea「多加例子;更通俗易懂」、textarea 主题滚动条(thin·--overlay)、点「按意见调整」即时 dim+spinner+控件禁用、完成后提纲更新+「已按意见调整 1 次」徽标+toast、空意见拦截(按钮不禁用/无 spinner)、提纲存入 localStorage;fetch 拦截证实白板请求体携带修订后 plan(5 标题一致)+正确 subject;备课/白板两页控制台零报错;≤640px 响应式规则与 flex-wrap 校验通过。

## 配置 / key

- `config.json` 的 `apiKey` 填你的 DeepSeek key(或学校 key,均为 OpenAI 兼容)。
- `searchApiKey` 填 DeepSeek 密钥(platform.deepseek.com 获取,与生成密钥独立),`searchProvider` 默认 `deepseek`,走官方 Search API(`POST /v1/tools/search`,约 ¥5/千次);仅「联网拓展」开启且知识库资料不足时使用,不填则优雅降级为纯知识库。仍兼容 `searchProvider: "bocha"`。
- 第 0–3 步不需要 key;第 4 步(检索)起需要。
- 扫描版 PDF(图片型)提不出文字,属"图片",后期配 OCR 再支持。

## 运行

```
cd /d D:\visboard
npm install        # 首次
npm start          # 启动后浏览器打开 http://localhost:3000
```
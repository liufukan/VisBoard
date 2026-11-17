const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');

// 本地训练数据目录(gitignored):chi_sim/eng 的 .traineddata.gz,
// 以及 tesseract 解压后写回的 .traineddata 缓存(cachePath 指向此处,避免污染仓库根)。
const LANG_PATH = path.join(__dirname, '..', 'ocr-data');
const INIT_TIMEOUT_MS = 30000; // 初始化上限:数据损坏时 createWorker 可能永不 settle
let workerPromise = null;
let queue = Promise.resolve(); // recognize 串行队列:共享单例 worker 不支持并发

function getWorker() {
  if (!workerPromise) {
    // 训练数据缺失 → 明确报错(spec §5),而不是挂起等待
    for (const lang of ['chi_sim', 'eng']) {
      const gz = path.join(LANG_PATH, `${lang}.traineddata.gz`);
      if (!fs.existsSync(gz)) throw new Error(`OCR 训练数据缺失: ${gz}`);
    }
    // v7 探针确认:createWorker(langs, oem, options) 创建即预加载语言;
    // langPath 为本地目录时走 fs 读取,不请求 CDN,完全离线。
    let timer;
    workerPromise = Promise.race([
      createWorker('chi_sim+eng', 1, {
        langPath: LANG_PATH,
        cachePath: LANG_PATH,
        // 失败只经 promise reject 交给调用方;不设 errorHandler 时上游会在
        // worker.on('message') 里 throw Error,直接崩掉宿主进程。
        errorHandler: () => {},
      }),
      // 上游把 loadLanguage/initialize 的 reject 吞进 .catch(()=>{}),外层 promise
      // 永不 settle;加超时兜底,避免永久挂起 + poisoned 单例。
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`OCR worker 初始化超时(${INIT_TIMEOUT_MS}ms)`)),
          INIT_TIMEOUT_MS,
        );
      }),
    ]).then((worker) => {
      clearTimeout(timer);
      return worker;
    }).catch((err) => {
      clearTimeout(timer);
      workerPromise = null; // 初始化失败后允许下次重试,不留 poisoned 单例
      throw err instanceof Error ? err : new Error(String(err));
    });
  }
  return workerPromise;
}

async function ocrImage(data) {
  const worker = await getWorker();
  // 排队顺序 await(spec §4.1):并发 recognize 打到同一个 TessBaseAPI 会串图/abort
  const job = queue.then(() => worker.recognize(data));
  queue = job.then(() => {}, () => {}); // 失败也要让链继续,不卡住后续调用
  try {
    const { data: { text } } = await job;
    return (text || '').trim();
  } catch (err) {
    // 上游以字符串 reject(err.toString()),统一成 Error 便于调用方取 message
    throw err instanceof Error ? err : new Error(String(err));
  }
}

const MAX_OCR_PAGES = 50;

async function ocrDoc(parsed, onProgress) {
  const allScans = parsed.scans || [];
  const scans = allScans.slice(0, MAX_OCR_PAGES);
  const truncated = allScans.length > MAX_OCR_PAGES;
  if (scans.length) await getWorker();
  let ocrPages = 0;
  for (let i = 0; i < scans.length; i++) {
    const scan = scans[i];
    if (onProgress) onProgress(i + 1, scans.length);
    try {
      const text = await module.exports.ocrImage(scan.data);
      const pg = parsed.pages.find(p => p.page === scan.page);
      if (pg) { pg.text = text; if (text) ocrPages++; }
    } catch (e) { console.warn('OCR 单页失败:', e.message); }
  }
  const chars = parsed.pages.reduce((n, p) => n + (p.text || '').length, 0);
  return { pages: parsed.pages, ocrPages, chars, truncated };
}

module.exports = { ocrImage, ocrDoc };

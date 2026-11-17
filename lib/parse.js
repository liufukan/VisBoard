const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { parseOffice } = require('officeparser');

const SUPPORTED = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.png', '.jpg', '.jpeg'];
// Decorative icons/logos are not teachable figures; only images whose shorter side reaches this size qualify.
const MIN_FIG_DIM = 200;

// PDF 图片提取放进独立子进程(lib/pdf-images-child.js):pdfjs 的 PNG 编码后端
// @napi-rs/canvas 有 native 内存泄漏(每张整页扫描图约 +50MB,GC 不回收),大扫描书
// 在宿主进程内提取会累积到数 GB 撑死进程;子进程每块退出,泄漏由操作系统回收。
// 子进程块内逐页提取:病态大图会让 getImage 异步挂起并毒化整个范围,逐页隔离 +
// 单页短超时只跳过挂起页;外层再设块超时兜底(子进程整体卡死时 kill 跳过该块,文本仍保留)。
const { fork } = require('child_process');
const IMAGE_CHILD = path.join(__dirname, 'pdf-images-child.js');
const CHUNK_PAGES = 10;
const CHILD_TIMEOUT_MS = 45000; // 外层兜底:块内逐页各 3s,10 页最坏 30s + 加载余量
const SCAN_DATA_LIMIT = 50; // 与 ocr.js MAX_OCR_PAGES 一致:仅前 N 张扫描页保留 data

function runImageChild(file, first, last, threshold) {
  return new Promise((resolve, reject) => {
    const child = fork(IMAGE_CHILD, [file, String(first), String(last), String(threshold)], {
      serialization: 'advanced', // 二进制克隆 Buffer,避免大 PNG 走 JSON 数字数组
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); try { child.kill(); } catch {} fn(arg); } };
    const timer = setTimeout(() => done(reject, new Error('timeout')), CHILD_TIMEOUT_MS);
    child.on('message', (m) => {
      if (m && m.error) done(reject, new Error(m.error));
      else done(resolve, m);
    });
    child.on('error', (e) => done(reject, e));
    child.on('exit', (code) => { if (!settled) done(reject, new Error('图片提取子进程退出 code=' + code)); });
  });
}

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

function collectSlide(node, texts, imgNames) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectSlide(n, texts, imgNames); return; }
  if (node.type === 'paragraph' && node.text) texts.push(node.text);
  if (node.type === 'image' && node.metadata && node.metadata.attachmentName) imgNames.push(node.metadata.attachmentName);
  if (node.children) collectSlide(node.children, texts, imgNames);
}

async function extract(filePath, onStage, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error('不支持的文件类型: ' + ext);
  // parse/images 任务只需 scanned 标志与插图,不需要扫描页像素;OCR 任务才保留扫描 data。
  const scanLimit = opts.keepScanData === false ? 0 : SCAN_DATA_LIMIT;

  if (ext === '.txt' || ext === '.md') {
    return { kind: ext.slice(1), pages: [{ page: null, text: fs.readFileSync(filePath, 'utf8') }], images: [], scans: [], scanned: false };
  }

  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const data = fs.readFileSync(filePath);
    const meta = sniffImage(data);
    if (!meta) throw new Error('无法识别的图片格式');
    return { kind: 'image', pages: [{ page: 1, text: '' }], images: [], scans: [{ page: 1, data, w: meta.w, h: meta.h, ext: meta.ext }], scanned: true };
  }

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
    try {
      if (onStage) onStage('解析文本…');
      const r = await parser.getText();
      const pages = r.pages.map(p => ({ page: p.num, text: p.text }));
      const SCAN_TEXT_THRESHOLD = 16, SCAN_MIN_DIM = 300;
      const textLenByPage = new Map(pages.map(p => [p.page, (p.text || '').trim().length]));
      const scans = [], images = [];
      try {
        if (onStage) onStage('提取图片…');
        // 分块交给子进程提取(见 IMAGE_CHILD 注释):每块退出即回收 canvas 泄漏内存。
        // 阈值 199:宽或高 <=199 的图在编码前就跳过,与 min>=200 的保留条件等价。
        let scanCount = 0;
        for (let first = 1; first <= pages.length; first += CHUNK_PAGES) {
          const last = Math.min(first + CHUNK_PAGES - 1, pages.length);
          if (onStage) onStage(`提取图片… ${first}/${pages.length}`);
          let res;
          try {
            res = await runImageChild(filePath, first, last, MIN_FIG_DIM - 1);
          } catch (e) {
            console.warn(`PDF 第 ${first}-${last} 页图片提取跳过(${e.message})`);
            continue;
          }
          const imgsByPage = new Map();
          for (const im of res.images || []) {
            const arr = imgsByPage.get(im.page) || [];
            arr.push(im);
            imgsByPage.set(im.page, arr);
          }
          for (const [page, ims] of imgsByPage) {
            const big = ims.filter(im => Math.min(im.w, im.h) >= SCAN_MIN_DIM);
            if ((textLenByPage.get(page) || 0) < SCAN_TEXT_THRESHOLD && big.length) {
              const chosen = big.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
              if (scanCount >= scanLimit) delete chosen.data; // 超出 OCR 上限的扫描页只留元数据
              scanCount++;
              scans.push(chosen);
            } else {
              images.push(...ims.filter(im => Math.min(im.w, im.h) >= MIN_FIG_DIM));
            }
          }
        }
      } catch (e) { console.warn('PDF 图片提取失败:', e.message); }
      return { kind: 'pdf', pages, images, scans, scanned: scans.length > 0 };
    } finally {
      await parser.destroy();
    }
  }

  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ path: filePath });
    return { kind: 'docx', pages: [{ page: null, text: r.value }], images: [], scans: [], scanned: false };
  }

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
      if (Math.min(meta.w, meta.h) < MIN_FIG_DIM) continue;
      images.push({ page: num, data, w: meta.w, h: meta.h, ext: meta.ext });
    }
  }
  return { kind: 'pptx', pages, images, scans: [], scanned: false };
}

module.exports = { extract, SUPPORTED, MIN_FIG_DIM };
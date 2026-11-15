const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { parseOffice } = require('officeparser');

const SUPPORTED = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.png', '.jpg', '.jpeg'];
// Decorative icons/logos are not teachable figures; only images whose shorter side reaches this size qualify.
const MIN_FIG_DIM = 200;

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

async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error('不支持的文件类型: ' + ext);

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
          images.push(...ims.filter(im => Math.min(im.w, im.h) >= MIN_FIG_DIM));
        }
      }
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
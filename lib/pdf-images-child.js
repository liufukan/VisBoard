// 子进程图片提取器:由 lib/parse.js 通过 child_process.fork 调用。
// @napi-rs/canvas(pdfjs 的 PNG 编码后端)存在 native 内存泄漏,每张整页扫描图
// 约 +50MB 且 GC 不回收;在宿主进程内提取会让大扫描书累积到数 GB 撑死进程。
// 放进独立子进程、每块退出,泄漏内存随进程终止由操作系统回收,父进程只收 PNG。
// 块内逐页 getImage:病态大图会让 getImage 异步永不 settle,且会毒化整个范围;
// 逐页隔离 + 单页短超时,只跳过挂起页(文本仍由父进程保留),不牵连邻页。
// 用法: node pdf-images-child.js <file> <first> <last> <threshold>
// 结果经 IPC(advanced 序列化)发回 { images:[{page,data,w,h,ext}] };分类由父进程做。
const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const [file, firstArg, lastArg, thresholdArg] = process.argv.slice(2);
const first = Number(firstArg), last = Number(lastArg), threshold = Number(thresholdArg);
const PER_PAGE_MS = 3000; // 正常页(含整页扫描)<=2.4s;病态页超时即跳过

// pending Promise 不维持事件循环:空 getImage 会让子进程在结果发出前排空秒退。
// 用 ref'd interval 撑住循环,直到父进程收到 message 后 kill(或兜底自退)。
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 300000).unref();

function race(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

function sniff(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { ext: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let pos = 2;
    while (pos + 9 < buf.length) {
      if (buf[pos] !== 0xFF) { pos++; continue; }
      const marker = buf[pos + 1];
      if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { pos += 2; continue; }
      const len = buf.readUInt16BE(pos + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { ext: 'jpeg', h: buf.readUInt16BE(pos + 5), w: buf.readUInt16BE(pos + 7) };
      }
      pos += 2 + len;
    }
    return { ext: 'jpeg', w: 0, h: 0 };
  }
  return null;
}

(async () => {
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(file)) });
  const images = [];
  try {
    for (let page = first; page <= last; page++) {
      let ir;
      try {
        ir = await race(parser.getImage({ imageThreshold: threshold, imageDataUrl: false, first: page, last: page }), PER_PAGE_MS);
      } catch { continue; } // 挂起页跳过,文本仍由父进程保留
      for (const pg of ir.pages || []) {
        for (const im of pg.images || []) {
          const data = Buffer.from(im.data);
          const meta = sniff(data);
          if (!meta) continue;
          images.push({ page: pg.pageNumber, data, w: im.width || meta.w, h: im.height || meta.h, ext: meta.ext });
        }
      }
    }
  } finally {
    await parser.destroy().catch(() => {});
  }
  // 发送后不自行 exit:父进程收到 message 后再 kill,避免 exit 先于 message 到达丢结果。
  process.send({ images });
})().catch((e) => {
  process.send({ error: String((e && e.message) || e) });
});
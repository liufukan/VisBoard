const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const { parseOffice } = require('officeparser');

const SUPPORTED = ['.txt', '.md', '.pdf', '.docx', '.pptx'];

async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error('不支持的文件类型: ' + ext);

  if (ext === '.txt' || ext === '.md') {
    return { kind: ext.slice(1), pages: [{ page: null, text: fs.readFileSync(filePath, 'utf8') }] };
  }

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
    try {
      const r = await parser.getText();
      return { kind: 'pdf', pages: r.pages.map(p => ({ page: p.num, text: p.text })) };
    } finally {
      await parser.destroy();
    }
  }

  if (ext === '.docx') {
    const r = await mammoth.extractRawText({ path: filePath });
    return { kind: 'docx', pages: [{ page: null, text: r.value }] };
  }

  const ast = await parseOffice(filePath, { ocr: false });
  const text = (await ast.to('text')).value;
  return { kind: ext.slice(1), pages: [{ page: null, text }] };
}

module.exports = { extract, SUPPORTED };
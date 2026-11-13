const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let detectPromise = null;
async function binOk(cmd, args) {
  try {
    await execFileAsync(cmd, args, { timeout: 15000, windowsHide: true });
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    return /version|pdftoppm|poppler|pdfTeX|MiKTeX/i.test(String(e.stdout || '') + String(e.stderr || ''));
  }
}
function detect() {
  if (!detectPromise) {
    detectPromise = (async () => {
      const [a, b] = await Promise.all([binOk('pdflatex', ['--version']), binOk('pdftoppm', ['-v'])]);
      return a && b ? true : null;
    })();
  }
  return detectPromise;
}

const MAX_CODE = 20000;
// Block file I/O, shell escape, macro definition and catcode tricks; the fixed
// preamble plus -no-shell-escape already remove the main attack surface.
const FORBIDDEN = /\\(?:input|include|write|openout|closeout|read|openin|closein|newread|newwrite|immediate|directlua|luaexec|csname|catcode|usepackage|documentclass|def|gdef|edef|xdef|newcommand|renewcommand|providecommand|let|futurelet|escapechar|special|output|errmessage|typeout|show|dump|endinput|includegraphics|href|hyperref|url|import|pdfliteral|pdfextension|shellesc|sys|exec|ifeof|loop|repeat|while|ifcase|expandafter|noexpand|unexpanded|scantokens|everyjob|everypar|meaning|jobname|batchmode|scrollmode|errorstopmode|nonstopmode|verb|tikzexternalize)(?![a-zA-Z])/;
const LIB_OK = new Set(['calc', 'arrows', 'arrows.meta', 'positioning', 'decorations.pathmorphing', 'decorations.markings', 'shapes', 'shapes.geometric', 'shapes.misc', 'fit', 'backgrounds', 'patterns', 'angles', 'quotes']);

function sanitizeCircuit(raw) {
  const code = String(raw || '').trim();
  if (!code) throw new Error('电路图代码为空');
  if (code.length > MAX_CODE) throw new Error('电路图代码过长(上限 20000 字符)');
  const m = code.match(/^\\begin\{circuitikz\}(\s*\[[^\]]*\])?([\s\S]*)\\end\{circuitikz\}\s*$/);
  if (!m) throw new Error('电路图必须是完整的 \\begin{circuitikz}...\\end{circuitikz} 环境');
  const body = m[2];
  if (/\\(?:begin|end)\{circuitikz\}/.test(body)) throw new Error('不允许嵌套 circuitikz 环境');
  for (const env of body.matchAll(/\\(?:begin|end)\{([^}]*)\}/g)) {
    if (env[1].trim() !== 'scope') throw new Error('电路图中只允许 scope 环境,发现 ' + env[1].trim());
  }
  if (FORBIDDEN.test(code)) throw new Error('电路图包含不允许的 LaTeX 命令');
  for (const lm of code.matchAll(/\\usetikzlibrary\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
    const names = lm[1].split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length || names.some(n => !LIB_OK.has(n))) throw new Error('不允许的 TikZ 库');
  }
  if (/\\usetikzlibrary/.test(code.replace(/\\usetikzlibrary\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/g, ''))) {
    throw new Error('\\usetikzlibrary 写法不合法');
  }
  return code;
}

const PREAMBLE = '\\documentclass[border=8pt]{standalone}\n\\usepackage{circuitikz}\n\\usepackage{amsmath}\n\\begin{document}\n';
const POSTAMBLE = '\n\\end{document}\n';

async function compileNow(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visboard-circ-'));
  try {
    const texPath = path.join(dir, 'circ.tex');
    fs.writeFileSync(texPath, PREAMBLE + code + POSTAMBLE, 'utf8');
    try {
      await execFileAsync('pdflatex', [
        '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', '--disable-installer',
        '-output-directory', dir, texPath,
      ], { timeout: 30000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      let detail = '';
      try {
        const log = fs.readFileSync(path.join(dir, 'circ.log'), 'utf8');
        detail = log.split('\n').filter(l => l.startsWith('!')).slice(0, 3).join(' ').trim();
      } catch { /* log may be missing */ }
      const err = new Error('LaTeX 编译失败' + (detail ? ': ' + detail.slice(0, 300) : ''));
      err.code = 'COMPILE';
      throw err;
    }
    const pdf = path.join(dir, 'circ.pdf');
    if (!fs.existsSync(pdf)) {
      const err = new Error('LaTeX 未生成 PDF'); err.code = 'COMPILE'; throw err;
    }
    await execFileAsync('pdftoppm', ['-png', '-r', '200', '-singlefile', pdf, path.join(dir, 'circ')],
      { timeout: 30000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    const buf = fs.readFileSync(path.join(dir, 'circ.png'));
    return 'data:image/png;base64,' + buf.toString('base64');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cache = new Map();
const pending = new Map();
let queue = Promise.resolve();

function compileCircuit(raw) {
  return detect().then(has => {
    if (!has) return { ok: false, code: 'NO_LATEX', error: '未检测到本地 LaTeX(pdflatex/pdftoppm),无法编译电路图' };
    let code;
    try { code = sanitizeCircuit(raw); } catch (e) { return { ok: false, code: 'BAD_CODE', error: e.message }; }
    const key = crypto.createHash('sha1').update(code).digest('hex');
    if (cache.has(key)) return { ok: true, png: cache.get(key) };
    if (pending.has(key)) return pending.get(key);
    const job = queue.then(async () => {
      if (cache.has(key)) return { ok: true, png: cache.get(key) };
      try {
        const png = await compileNow(code);
        if (cache.size >= 60) cache.clear();
        cache.set(key, png);
        return { ok: true, png };
      } catch (e) {
        return { ok: false, code: 'COMPILE', error: '电路图编译失败：' + (e.message || String(e)) };
      }
    });
    queue = job.then(() => {}, () => {});
    pending.set(key, job);
    job.then(() => pending.delete(key));
    return job;
  });
}

module.exports = { detect, compileCircuit };
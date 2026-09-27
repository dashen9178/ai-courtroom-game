// test-static.mjs — 源码级静态检查（不调 AI、不起服务）
//
// 这个文件专门盯"**静默坏掉**"这一类 bug：代码/样式表看起来是好的、
// 语法检查也过，但运行起来行为不对，而且测试还是绿的。
// 这里的每一条都是真踩过的坑，不是假想出来的规则。
//
// 每条检查都自带一个"应该被抓到"的坏样本 —— 不然检查本身也会静默空转
// （这个仓库里已经栽过两次：安全检查查的是 computed style、审计脚本
//   因为语法错误从来没跑过，两次都是"全绿但什么都没检查"）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '\n        ' + extra : '')); }
}
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

/* ────────────────────────────────────────────────────────────────
 * ① server.mjs：会话闸门的 release 不能在声明它的块之外被引用
 *
 * 真事故：`const release = acquireSession(s)` 写在 if 块里，
 * 块外的非流式分支写成 `finally { release(); }` →
 * ReferenceError: release is not defined → /api/say 直接 500。
 * 语法检查查不出来，因为它只在**运行时**才炸。
 * ──────────────────────────────────────────────────────────────── */

/** 把注释和字符串抠掉，只留下真正的代码字符（模板字面量的 ${} 里仍然算代码） */
function codeOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === "'" || c === '"') { const q = c; out += ' '; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') { out += '  '; i += 2; continue; } out += src[i] === '\n' ? '\n' : ' '; i++; } out += ' '; i++; continue; }
    if (c === '`') {
      out += ' '; i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { depth++; out += '  '; i += 2; continue; }
        if (depth > 0 && src[i] === '}') { depth--; out += ' '; i++; continue; }
        if (depth === 0 && src[i] === '`') break;
        if (depth > 0) out += src[i];
        else out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' '; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** 找出"句柄被用到声明它的块之外"的地方 */
function scopeEscapes(src) {
  const code = codeOnly(src);

  // 光比大括号**深度**不够：两个并列的兄弟块深度相同，但作用域不同。
  // 所以给每个 { 编号，记下"当前位置的块路径"，再用路径前缀判断包含关系。
  const pathAt = new Array(code.length);
  const stack = [];
  let nextId = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '}') { stack.pop(); }
    pathAt[i] = stack.join(',');
    if (code[i] === '{') { stack.push(nextId++); }
  }

  // 只看形如 `const X = acquireSession(...)` 的句柄
  const declRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*acquireSession\s*\(/g;
  const handles = [];
  let m;
  while ((m = declRe.exec(code))) handles.push({ name: m[1], at: m.index, path: pathAt[m.index] });

  const bad = [];
  for (const h of handles) {
    const useRe = new RegExp(`(?<![\\w$.])${h.name.replace(/\$/g, '\\$')}(?![\\w$])(?!\\s*=\\s*acquireSession)`, 'g');
    let u;
    while ((u = useRe.exec(code))) {
      if (u.index === h.at) continue;
      // 同名句柄可能在多处声明（withSession 里一个、流式分支里一个）。
      // 一次引用该归给**它前面最近的那条**声明，否则会把别的作用域算到这条头上。
      const owner = handles.filter(x => x.name === h.name && x.at < u.index).pop();
      if (!owner || owner.at !== h.at) continue;
      const p = pathAt[u.index];
      // 在作用域内 ⇔ 引用点的块路径以声明点的块路径为前缀（含相等）
      const inScope = h.path === '' ? true : (p === h.path || p.startsWith(h.path + ','));
      if (!inScope) {
        bad.push(`${h.name} 在第 ${code.slice(0, u.index).split('\n').length} 行被引用，但它在更内层的作用域里声明`);
      }
    }
  }
  return bad;
}

console.log('\n── server.mjs：acquireSession 句柄的作用域 ──');

// 坏样本：就是 /api/say 那个真 bug 的形状
const SCOPE_BAD_FIXTURE = `
function handler(s) {
  if (stream) {
    const release = acquireSession(s);
    try { go(); } finally { release(); }
    return;
  }
  let r;
  try { r = say(); }
  finally { release(); }          // ← 块外引用，运行时 ReferenceError
  return r;
}`;
ok('坏样本必须被抓到（否则这条检查是空转）', scopeEscapes(SCOPE_BAD_FIXTURE).length === 1,
  `抓到 ${scopeEscapes(SCOPE_BAD_FIXTURE).length} 处`);

// 好样本：同名句柄在两个不同作用域各声明一次，互不干扰
const SCOPE_GOOD_FIXTURE = `
async function withSession(s, fn) {
  const release = acquireSession(s);
  try { return await fn(); } finally { release(); }
}
function handler(s) {
  if (stream) {
    const release = acquireSession(s);
    try { go(); } finally { release(); }
    return;
  }
  const r = withSession(s, () => say());
  return r;
}`;
ok('好样本不能误报（同名句柄分处两个作用域）', scopeEscapes(SCOPE_GOOD_FIXTURE).length === 0,
  scopeEscapes(SCOPE_GOOD_FIXTURE).join(' / '));

const realEscapes = scopeEscapes(read('server.mjs'));
ok('server.mjs 里没有句柄被用到声明块之外（防 /api/say 那种 500）', realEscapes.length === 0, realEscapes.join('\n        '));

/* ────────────────────────────────────────────────────────────────
 * ② style.css：不能出现 // 行注释
 *
 * 真事故：CSS 不认 `//`，解析器把它当选择器，
 * 后面紧跟的整条 @media 被当作无效规则**静默丢弃** ——
 * 表现是"CSS 改了、浏览器也收到了，但就是不生效"。
 * ──────────────────────────────────────────────────────────────── */

/** 剥掉块注释后，找出以 // 开头的行 */
function cssLineComments(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '));
  const bad = [];
  stripped.split('\n').forEach((line, i) => {
    if (/^\s*\/\//.test(line)) bad.push(`第 ${i + 1} 行：${line.trim().slice(0, 50)}`);
  });
  return bad;
}

console.log('\n── style.css：不能有 // 行注释 ──');

const CSS_BAD_FIXTURE = `.a { color: red; }
// 这行会让下面整条规则被吞掉
@media (max-width: 520px) { .b { color: blue; } }`;
ok('坏样本必须被抓到（否则这条检查是空转）', cssLineComments(CSS_BAD_FIXTURE).length === 1);
ok('块注释里的 // 不算问题（比如 url(//cdn...) 那种说明文字）',
  cssLineComments('/* 这里提到 // 但没事 */\n.a { color: red; }').length === 0);

const css = read('style.css');
const cssNoBlockComments = css.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '));
const slashSlash = cssLineComments(css);
ok('style.css 里没有 // 行注释', slashSlash.length === 0, slashSlash.join('\n        '));

// 再验一次"媒体查询真的能被解析出来"。注意要在**剥掉注释之后**数，
// 否则注释里提到的 @media 也会被算进去。
const mediaConds = [...cssNoBlockComments.matchAll(/@media\s*([^{]+)\{/g)].map(x => x[1].trim());
ok('@media 数量与预期一致（矮屏居中 / 手机端密度 / 宽屏留白 / 减少动效）',
  mediaConds.length === 4, `实际 ${mediaConds.length} 条：${mediaConds.join(' | ')}`);
ok('手机端密度那条 @media 确实存在（不然整个紧凑化都是死的）',
  mediaConds.some(c => c.includes('max-width') && c.includes('520px')), mediaConds.join(' | '));

/* ────────────────────────────────────────────────────────────────
 * ③ 审计脚本注入浏览器的那段 JS：模板字符串里不能写 \( 这类转义
 *
 * 真事故：audit-mobile.mjs 里写了 /env\(safe-area/，
 * 模板字符串把 \( 吃成 (，到浏览器变成未闭合括号 → SyntaxError，
 * 整个审计脚本一直是坏的，却只打印一行被截断的报错。
 * ──────────────────────────────────────────────────────────────── */

/** 在模板字符串正文里找"会被吃掉的转义"（跳过 // 注释行） */
function badTemplateEscapes(src) {
  const bad = [];
  for (const t of src.matchAll(/`([^`]*)`/g)) {
    const body = t[1].split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    const mm = body.match(/\/[^/\n]*\\[()\[\]{}][^/\n]*\//g);
    if (mm) bad.push(mm[0].slice(0, 50));
  }
  return bad;
}

console.log('\n── 审计脚本：注入 JS 里不能有被吃掉的转义 ──');

ok('坏样本必须被抓到（否则这条检查是空转）',
  badTemplateEscapes('const X = `(() => { const ok = /env\\(safe-area/.test(pb); })()`;').length === 1);
ok('注释里的转义不算问题',
  badTemplateEscapes('const X = `(() => { // 以前写成 /env\\(safe-area/ 会炸\n return 1; })()`;').length === 0);

const auditFiles = fs.readdirSync(DIR).filter(f => /^(audit-|verify-|measure-|shot-|probe-).*\.mjs$/.test(f));
const badEscapes = [];
for (const f of auditFiles) {
  for (const x of badTemplateEscapes(read(f))) badEscapes.push(`${f}: ${x}`);
}
ok(`注入脚本的模板字符串里没有会被吃掉的转义（扫了 ${auditFiles.length} 个脚本）`,
  badEscapes.length === 0, badEscapes.join('\n        '));

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);

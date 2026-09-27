// test-dom.mjs — 静态检查：app.js 引用的每个元素 id 都必须真实存在于 index.html
// 纯文本检查，不调 AI、不起浏览器。改 HTML 时最容易漏配元素，这个脚本专门抓它。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
};

/* ── 1. app.js 里 $('xxx') 引用的 id 必须存在 ── */
const refs = [...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
const uniqRefs = [...new Set(refs)];
const missing = uniqRefs.filter(id => !new RegExp(`id=["']${id}["']`).test(html));

console.log('\n── DOM 元素引用 ──');
ok(`app.js 引用了 ${uniqRefs.length} 个元素 id，全部存在于 index.html`,
  missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : '');

/* ── 2. index.html 里的 id 不应重复 ── */
const allIds = [...html.matchAll(/id=["']([A-Za-z0-9_-]+)["']/g)].map(m => m[1]);
const dupIds = allIds.filter((id, i) => allIds.indexOf(id) !== i);

console.log('\n── HTML 结构 ──');
ok(`index.html 共 ${allIds.length} 个 id，无重复`,
  dupIds.length === 0, dupIds.length ? '重复: ' + [...new Set(dupIds)].join(', ') : '');

/* ── 3. app.js 里用到的 class 选择器应在 CSS 或 JS 里有着落 ── */
const classRefs = [...js.matchAll(/className = '([^']+)'/g)]
  .flatMap(m => m[1].split(/\s+/)).filter(Boolean);
const uniqClassRefs = [...new Set(classRefs)];
const classMissing = uniqClassRefs.filter(c => !css.includes('.' + c));

console.log('\n── 样式覆盖 ──');
ok(`app.js 动态生成的 ${uniqClassRefs.length} 个 class 都在 style.css 里有规则`,
  classMissing.length === 0, classMissing.length ? '未定义: ' + classMissing.join(', ') : '');

/* ── 4. 关键容器必须存在（防止重构时误删）── */
console.log('\n── 关键容器 ──');
const required = [
  'screen-home', 'screen-trial', 'screen-verdict',
  'transcript', 'grudge-panel', 'grudge-col-da', 'grudge-col-judge',
  'grudge-list', 'ledger-list', 'btn-say', 'btn-verdict',
  'v-grudge-block', 'v-ledger-block', 'v-concur-block',
  // 两个旋钮：对抗强度 + 深度思考（都是按局生效）
  'sev-pick', 'sev-opts', 'sev-note',
  'think-pick', 'think-opts', 'think-note',
  // 案件主题输入
  'seed-input',
  // 状态汇总（解决遮挡）
  'status-summary', 'status-panel', 'ss-items', 'ss-caret', 'ss-hint',
  // 新玩法
  'mood-bar', 'mood-text', 'mood-fill', 'mood-pct',
  'evidence-bar', 'ev-list', 'clerk-row', 'clerk-body',
  'strat-cards', 'btn-exhibit', 'btn-closing', 'btn-appeal',
  'v-outcome', 'v-cred', 'v-clerk', 'v-strat', 'v-exhibit', 'v-closing',
  'v-score', 'v-appeal-block', 'v-appeal-result', 'v-appeal-text',
  // 通用弹窗
  'modal-scrim', 'modal', 'modal-title', 'modal-sub', 'modal-input',
  'modal-tips', 'modal-ok', 'modal-cancel',
  'dossier', 'dossier-body', 'menu',
];

/* 加载页已被删除：整屏 loading 是"点进去干等"的元凶，改用流式就地填充 */
const forbidden = ['screen-loading', 'load-text', 'load-sub'];
const missingReq = required.filter(id => !allIds.includes(id));
ok(`状态汇总 / 两本账 / 判决书 / 弹窗 等 ${required.length} 个关键容器齐备`,
  missingReq.length === 0, missingReq.length ? '缺失: ' + missingReq.join(', ') : '');

const leftovers = forbidden.filter(id => allIds.includes(id) || js.includes("'" + id + "'"));
ok(`整屏加载页已删除（${forbidden.join(' / ')} 不再存在）`,
  leftovers.length === 0, leftovers.length ? '仍然存在: ' + leftovers.join(', ') : '');

/* 去掉注释再检查，免得把说明文字误判成代码 */
const jsCode = js
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, '');      // 行注释

/* 不该再自动 focus 输入框：手机上一 focus 就弹键盘 */
const focusCalls = (jsCode.match(/el\.say\.focus\(\)/g) || []).length;
ok('没有自动聚焦输入框的代码（避免手机弹键盘）',
  focusCalls === 0, focusCalls ? `仍有 ${focusCalls} 处` : '');

/* 不该再用原生 prompt（手机体验差、部分浏览器拦截） */
const nativePrompt = (jsCode.match(/[^.\w]prompt\(/g) || []).length;
ok('没有使用原生 prompt（已换成自建弹窗）',
  nativePrompt === 0, nativePrompt ? `仍有 ${nativePrompt} 处` : '');

/* ── 5. 不能有未闭合的 script/style 标签这类低级错误 ── */
console.log('\n── 标签闭合 ──');
ok('script 标签成对', (html.match(/<script/g) || []).length === (html.match(/<\/script>/g) || []).length);
ok('style 标签成对（若有）', (html.match(/<style/g) || []).length === (html.match(/<\/style>/g) || []).length);
ok('section 标签成对', (html.match(/<section/g) || []).length === (html.match(/<\/section>/g) || []).length);
ok('aside 标签成对', (html.match(/<aside/g) || []).length === (html.match(/<\/aside>/g) || []).length);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);

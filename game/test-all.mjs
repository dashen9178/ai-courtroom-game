// test-all.mjs — 一键全量测试
//   1) 接口级：普通程序真链路（立案→3 轮辩护→宣判）、速审模式 5 轮触发宣判
//   2) 浏览器级：三种视口布局无溢出、判决书长图导出、真 UI 交互
// 前置：server.mjs 已在 8790 运行
// 用法： node test-all.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const results = [];

function runNode(script, args = []) {
  return new Promise(resolve => {
    const p = spawn(NODE, [path.join(__dirname, script), ...args], {
      cwd: __dirname, stdio: 'inherit', env: { ...process.env, BASE },
    });
    p.on('close', code => resolve(code));
  });
}

/** 需要 CDP 的脚本：把 test-all 自己起的那个 Edge 端口传进去 */
const CDP_PORT = '9222';

/** 默认**不跑**会花钱的测试。加 --paid 才跑。 */
const PAID = process.argv.includes('--paid');

async function serverUp() {
  try {
    const r = await fetch(BASE + '/api/health');
    const d = await r.json();
    return d.ok === true;
  } catch { return false; }
}

async function step(name, fn) {
  console.log('\n' + '═'.repeat(66));
  console.log('▶ ' + name);
  console.log('═'.repeat(66));
  const t0 = Date.now();
  let ok = false;
  try { ok = (await fn()) === 0; } catch (e) { console.log('  异常：' + e.message); ok = false; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${ok ? '✅' : '❌'} ${name}  (${secs}s)`);
  results.push({ name, ok, secs });
}

/* ── 0. 服务可用性 ─────────────────────────────────────── */

if (!(await serverUp())) {
  console.error('\n❌ 连不上 ' + BASE + '，请先启动服务：');
  console.error('   node server.mjs\n');
  process.exit(1);
}
console.log('服务在线：' + BASE);

/* ── 1. 纯离线：零 AI 调用，任何情况下都跑 ─────────────── */

await step('离线 · 校验层单测（引用/称呼/两本账/态势/证据/策略/书记员/toIndex/空串防线/JSON 修复/立案兜底/两个旋钮/提示词拼装，136 项）', () => runNode('test-guards.mjs'));
await step('离线 · 流式 JSON 提取器（29 项，转义与嵌套）', () => runNode('test-stream.mjs'));
await step('离线 · DOM 完整性（元素引用 / 样式覆盖 / 关键容器）', () => runNode('test-dom.mjs'));
await step('离线 · 源码静态检查（作用域越界 / CSS 注释 / 注入脚本转义，11 项自检）', () => runNode('test-static.mjs'));
await step('接口 · 路由健壮性（畸形请求 / 安全 / 不崩，0 AI 调用）', () => runNode('test-routes.mjs'));

/* ── 2. 浏览器级（免费用例） + 花钱用例，共用同一个无头 Edge ── */

if (!fs.existsSync(EDGE)) {
  console.log('\n⚠ 没找到 Edge，跳过全部浏览器级测试。');
  console.log('  路径：' + EDGE);
} else {
  const tmp = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'gangjing_testprofile_' + Date.now());
  console.log('\n启动无头 Edge（CDP 9222）…');
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-sync', '--no-default-browser-check',
    '--remote-debugging-port=9222', '--remote-allow-origins=*',
    '--user-data-dir=' + tmp, '--window-size=440,900', 'about:blank',
  ], { stdio: 'ignore', detached: false });

  let cdpUp = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await (await fetch('http://127.0.0.1:9222/json/version')).json(); cdpUp = true; break; } catch { /* 继续等 */ }
  }

  if (!cdpUp) {
    console.log('⚠ CDP 没起来，跳过浏览器级测试。');
  } else {
    /* ── 免费：只渲染，不调模型 ── */
    await step('浏览器级 · 移动端 27 个机型×屏幕组合实测', () => runNode('audit-mobile.mjs', [CDP_PORT]));
    await step('浏览器级 · 三视口布局无横向溢出（7 项）', () => runNode('verify-layout.mjs', [CDP_PORT]));
    await step('浏览器级 · 文字不被容器裁切（5 项）', () => runNode('verify-clip.mjs', [CDP_PORT]));
    await step('浏览器级 · 判决书长图导出产出有效 PNG', () => runNode('verify-export.mjs', [CDP_PORT]));

    /* ── 花钱：会真的调用大模型 ── */
    if (PAID) {
      await step('接口级 · 真链路冒烟（流式立案/发言/宣判，约 ¥0.02）', () => runNode('smoke.mjs'));
      await step('接口级 · 全部九项玩法一次跑通（约 ¥0.13）', () => runNode('test-all-features.mjs'));
      await step('接口级 · 两本账 + 缓存 + 花费审计（约 ¥0.04）', () => runNode('verify-cache.mjs'));
      await step('浏览器级 · 真 UI 交互（填字 → 发言 → 回击 → 解锁宣判）', () => runNode('verify-ui.mjs', [CDP_PORT]));
      await step('浏览器级 · 重新生成 shots/ 截图', () => runNode('shot-cdp.mjs', [CDP_PORT]));
    }
  }

  try { edge.kill(); } catch { /* 忽略 */ }
  await new Promise(r => setTimeout(r, 600));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

if (!PAID) {
  console.log('\n' + '─'.repeat(66));
  console.log('⏭  已跳过会消耗 API 额度的测试（接口级 / 真 UI 交互 / 出图）。');
  console.log('   那一组每跑一次约花 ¥0.02–0.05。确实要跑时才加参数：');
  console.log('     node test-all.mjs --paid');
  console.log('─'.repeat(66));
}

/* ── 汇总 ─────────────────────────────────────────────── */

console.log('\n' + '═'.repeat(66));
console.log('测试汇总');
console.log('═'.repeat(66));
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(56)} ${String(r.secs).padStart(6)}s`);
}
const failed = results.filter(r => !r.ok);
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  · ' + f.name);
}
process.exit(failed.length ? 1 : 0);

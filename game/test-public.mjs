// test-public.mjs — 通过公网 URL 跑一局完整庭审，验证：
//   ① 隧道不会掐断长请求（Cloudflare 隧道有 100 秒空闲超时，思考模式一局约 60 秒）
//   ② 限流/配额不会误伤正常玩家
// 用法： node test-public.mjs https://xxx.trycloudflare.com
const BASE = process.argv[2];
if (!BASE) { console.error('用法: node test-public.mjs <公网URL>'); process.exit(1); }

async function post(path, body) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
  });
  const ms = Date.now() - t0;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} HTTP ${r.status} (${ms}ms): ${JSON.stringify(d).slice(0, 200)}`);
  return { d, ms };
}

async function get(path) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) });
  return { d: await r.json().catch(() => ({})), ms: Date.now() - t0, status: r.status };
}

console.log('公网 URL：' + BASE);
console.log('（Cloudflare 隧道空闲超时约 100 秒，逐项记录耗时看是否触边）\n');

const timings = [];

// ① 立案
console.log('① 立案…');
const c = await post('/api/case', { intensity: 'free' });
timings.push(['立案', c.ms]);
console.log(`   ${(c.ms / 1000).toFixed(1)}s  「${c.d.case.case_title}」`);

// ② 三轮辩护（每轮都是一次约 60 秒的调用）
const DEFENSE = [
  '法官大人，这件事我可以解释，但你们得先承认程序有问题。',
  '而且我那天确实很累，累到不记得自己做过什么，这不能算故意。',
  '好吧我承认我做了，但累是真的——你们不能因为我记不清就认定我是故意的。',
];
for (let i = 0; i < DEFENSE.length; i++) {
  console.log(`\n② 第 ${i + 1} 轮辩护…`);
  const r = await post('/api/say', { sid: c.d.sid, text: DEFENSE[i] });
  timings.push([`第${i + 1}轮`, r.ms]);
  const recalled = r.d.recalled ? `翻旧账 #${r.d.recalled.n}（第${r.d.recalled.times}次）` : '未翻账';
  console.log(`   ${(r.ms / 1000).toFixed(1)}s  小本本 ${r.d.grudges.length} 条  ${recalled}`);
  const pr = r.d.lines.find(l => l.role === 'prosecutor');
  if (pr) console.log(`   检察官：${pr.content.slice(0, 60)}…`);
}

// ③ 宣判
console.log('\n③ 宣判…');
const v = await post('/api/verdict', { sid: c.d.sid });
timings.push(['宣判', v.ms]);
console.log(`   ${(v.ms / 1000).toFixed(1)}s`);
console.log(`   判词：${v.d.result.verdict_title}`);
console.log(`   旧账清算：${v.d.result.grudge_verdict || '（无）'}`);

// ④ 健康 / 配额
const h = await get('/api/health');
console.log(`\n④ 限流：单 IP 每分钟 ${h.d.perMinutePerIp} 次（场次不限制）`);

/* ── 汇总 ── */
console.log('\n' + '═'.repeat(64));
console.log('各项耗时（判断是否逼近 100 秒隧道超时）：');
let worst = 0;
for (const [name, ms] of timings) {
  const sec = ms / 1000;
  if (sec > worst) worst = sec;
  const bar = sec > 90 ? '❌ 危险' : sec > 70 ? '⚠ 偏慢' : '✅ 安全';
  console.log(`  ${name.padEnd(8)} ${sec.toFixed(1).padStart(6)}s  ${bar}`);
}
console.log(`\n最长一次 ${worst.toFixed(1)}s（上限 100s）`);
const ok = worst < 90 && timings.length === 5;
console.log(ok ? '✅ 公网长请求不会被隧道掐断' : '❌ 存在被掐断风险');
process.exit(ok ? 0 : 1);

// cost-audit.mjs — 成本审计：跑完整一局，逐次打印 token / 缓存命中 / 花费
// 用法：先 node server.mjs（本机模式即可），再 node cost-audit.mjs
//
// 关键指标：
//   prompt_cache_hit_tokens  命中缓存的输入（$0.003/M，谷时）
//   prompt_cache_miss_tokens 未命中的输入（$0.15/M，谷时）→ 贵 50 倍
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

// 官方谷时价（USD / 1M tokens）；峰时翻倍
const P = { hit: 0.003, miss: 0.15, out: 0.60 };
const CNY = 7.1;

const rows = [];

async function post(p, b) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(180000),
  });
  const d = await r.json().catch(() => ({}));
  const ms = Date.now() - t0;
  if (!r.ok) throw new Error(`${p} HTTP ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return { d, ms };
}

function record(stage, usage, ms) {
  const u = usage || {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens ?? 0);
  const out = u.completion_tokens ?? 0;
  const usd = hit / 1e6 * P.hit + miss / 1e6 * P.miss + out / 1e6 * P.out;
  const cny = usd * CNY;
  rows.push({ stage, hit, miss, out, cny, ms });
  const hitRate = (hit + miss) > 0 ? (hit / (hit + miss) * 100) : 0;
  console.log(`  ${stage.padEnd(14)} ${String(ms).padStart(6)}ms  in=${String(hit + miss).padStart(5)} (命中 ${String(hit).padStart(5)} / ${hitRate.toFixed(0)}%)  out=${String(out).padStart(4)}  ¥${cny.toFixed(6)}`);
  return u;
}

console.log('成本审计 · 完整一局（普通程序，3 轮交锋）');
console.log('价格：命中 $0.003/M · 未命中 $0.15/M · 输出 $0.60/M（官方谷时）');
console.log('═'.repeat(78));

console.log('\n① 立案');
const c = await post('/api/case', { intensity: 'free' });
record('立案', c.d.meta?.usage, c.ms);
console.log(`   案名：${c.d.case.case_title}`);

const DEFENSE = [
  '法官大人，这事我可以解释，但你们得先承认程序有问题。',
  '我没做过，那天我在加班，根本没在场。',
  '好吧我确实做了，但加班是真的，你们不能认定我是故意的——而且我前面就说了我不在场。',
];
for (let i = 0; i < DEFENSE.length; i++) {
  console.log(`\n② 第 ${i + 1} 轮`);
  const r = await post('/api/say', { sid: c.d.sid, text: DEFENSE[i] });
  record(`回击${i + 1}`, r.d.meta?.usage, r.ms);
  console.log(`   小本本 ${r.d.grudges.length} 条${r.d.recalled ? ` · 翻旧账 #${r.d.recalled.n}` : ''}`);
}

console.log('\n③ 宣判');
const v = await post('/api/verdict', { sid: c.d.sid });
record('宣判', v.d.result?.meta?.usage, v.ms);
console.log(`   判词：${v.d.result.verdict_title}`);

/* ── 汇总 ── */
console.log('\n' + '═'.repeat(78));
const sum = rows.reduce((a, r) => ({
  hit: a.hit + r.hit, miss: a.miss + r.miss, out: a.out + r.out, cny: a.cny + r.cny, ms: a.ms + r.ms,
}), { hit: 0, miss: 0, out: 0, cny: 0, ms: 0 });

console.log('逐项花费：');
for (const r of rows) console.log(`  ${r.stage.padEnd(14)} ¥${r.cny.toFixed(6)}   占总成本 ${(r.cny / sum.cny * 100).toFixed(1)}%`);

const hitRate = sum.hit / (sum.hit + sum.miss) * 100;
const waste = sum.miss / 1e6 * (P.miss - P.hit) * CNY;   // 全命中能省下的钱
console.log('');
console.log(`总计：输入 ${sum.hit + sum.miss} tok（命中率 ${hitRate.toFixed(1)}%）· 输出 ${sum.out} tok`);
console.log(`一局花费：¥${sum.cny.toFixed(6)}   总耗时 ${(sum.ms / 1000).toFixed(1)}s`);
console.log(`若输入全部命中缓存：¥${(sum.cny - waste).toFixed(6)}（可省 ¥${waste.toFixed(6)}，即 ${(waste / sum.cny * 100).toFixed(0)}%）`);
console.log('');
console.log(`按 ¥1.03 余额估算可玩：约 ${Math.floor(1.03 / sum.cny)} 局`);

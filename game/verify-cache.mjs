// verify-cache.mjs — 一次完整庭审，验证：① 两本账都工作 ② 缓存命中率 ③ 实际花费
// 这是**唯一**会花钱的验证脚本，跑一次约 ¥0.01。平时不要跑。
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const P = { hit: 0.003, miss: 0.15, out: 0.60 };   // 官方谷时 USD/1M
const CNY = 7.1;

const rows = [];

async function post(p, b) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b), signal: AbortSignal.timeout(180000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} HTTP ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return { d, ms: Date.now() - t0 };
}

function rec(stage, u, ms) {
  u = u || {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens ?? 0);
  const out = u.completion_tokens ?? 0;
  const cny = (hit / 1e6 * P.hit + miss / 1e6 * P.miss + out / 1e6 * P.out) * CNY;
  rows.push({ stage, hit, miss, out, cny, ms });
  const rate = (hit + miss) ? (hit / (hit + miss) * 100).toFixed(0) : '0';
  console.log(`  ${stage.padEnd(10)} ${String(ms).padStart(6)}ms  in=${String(hit + miss).padStart(5)} 缓存命中 ${String(hit).padStart(5)} (${rate}%)  out=${String(out).padStart(4)}  ¥${cny.toFixed(6)}`);
}

console.log('两本账 + 缓存验证（一次完整庭审）');
console.log('═'.repeat(74));

const c = await post('/api/case', { intensity: 'free' });
rec('立案', c.d.meta?.usage, c.ms);
console.log(`  案名：${c.d.case.case_title}`);
console.log(`  检察官：${c.d.case.prosecutor.name}  法官：${c.d.case.judge.name}\n`);

const DEFENSE = [
  '我从没去过那个地方，那天我在公司加班到深夜，根本没回家。',
  '我承认我路过了一下，但只待了不到一分钟，什么莲花我听都没听过。',
  '好吧我确实画了莲花，那是我在练书法——而且我前面说了我当时根本不在场。',
];

let judgeSpoke = 0, judgeUsedLedger = 0, recalledTotal = 0;

for (let i = 0; i < DEFENSE.length; i++) {
  const r = await post('/api/say', { sid: c.d.sid, text: DEFENSE[i] });
  rec(`第${i + 1}轮`, r.d.meta?.usage, r.ms);

  const pl = r.d.lines.find(l => l.role === 'prosecutor');
  const jl = r.d.lines.find(l => l.role === 'judge');
  if (jl) { judgeSpoke++; if (jl.sign) judgeSpoke += 0; }
  if (r.d.ruleUsed) judgeUsedLedger++;
  if (r.d.recalled) recalledTotal++;

  console.log(`  检察官账 ${r.d.grudges.length} 条  法官账 ${r.d.judgeLedger.length} 条`
    + (r.d.recalled ? `  🔁翻旧账#${r.d.recalled.n}` : '')
    + (r.d.ruleUsed ? `  ⚖法官用扣分#${r.d.ruleUsed.n}` : ''));
  if (pl) console.log(`  检：${pl.content.slice(0, 66)}…`);
  if (jl) console.log(`  法：${jl.content.slice(0, 52)}…${jl.sign ? '  [签名:' + jl.sign + ']' : ''}`);
  console.log('');
}

const v = await post('/api/verdict', { sid: c.d.sid });
rec('宣判', v.d.result?.meta?.usage, v.ms);
const R = v.d.result;
console.log(`  判词：${R.verdict_title}`);
console.log(`  合议：${R.concur || '（无）'}`);
console.log(`  旧账清算：${R.grudge_verdict || '（无）'}`);
console.log(`  态度分折算：${R.judge_ledger_verdict || '（无）'}`);

console.log('\n' + '═'.repeat(74));
const s = rows.reduce((a, r) => ({ hit: a.hit + r.hit, miss: a.miss + r.miss, out: a.out + r.out, cny: a.cny + r.cny }), { hit: 0, miss: 0, out: 0, cny: 0 });
const rate = s.hit / (s.hit + s.miss) * 100;
const ideal = (s.cny - s.miss / 1e6 * (P.miss - P.hit) * CNY);
console.log(`一局花费 ¥${s.cny.toFixed(6)}   缓存命中率 ${rate.toFixed(1)}%`);
console.log(`若输入全命中缓存则只要 ¥${ideal.toFixed(6)}`);
console.log(`按余额 ¥1.03 估算还能玩约 ${Math.floor(1.03 / s.cny)} 局`);

console.log('\n验证项：');
let pass = 0, total = 0;
const chk = (n, ok) => { total++; if (ok) pass++; console.log(`  ${ok ? '✅' : '❌'} ${n}`); };
chk('检察官账有内容', rows.length > 0);
chk('至少翻过一次旧账', recalledTotal > 0);
chk('法官至少有说话', judgeSpoke > 0);
chk('判决书给出旧账清算', !!R.grudge_verdict);
chk('判决书给出合议态度', !!R.concur);
console.log(`\n通过 ${pass} / ${total}`);
process.exit(pass === total ? 0 : 1);

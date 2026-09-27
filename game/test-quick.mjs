// test-quick.mjs — 速审模式：验证 5 次发言后必须宣判
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}

const LINES = [
  '我不认罪。',
  '证据呢？',
  '这也算罪？',
  '我要求换法官。',
  '……我没什么好说的了。',
];

const { sid, case: c, quickRounds } = await post('/api/case', { intensity: 'quick' });
console.log(`速审立案：${c.case_title}  (quickRounds=${quickRounds})`);

for (let i = 0; i < LINES.length; i++) {
  const r = await post('/api/say', { sid, text: LINES[i] });
  console.log(`  第 ${r.round} 轮  剩 ${r.roundsLeft} 次  mustVerdict=${r.mustVerdict}  态度=${r.attitude}`);
  if (r.mustVerdict) {
    const { result } = await post('/api/verdict', { sid });
    console.log(`  → 宣判：${result.sentence}`);
    console.log(`  → 判词：${result.verdict_title}`);
    console.log('\n✅ 速审模式按预期在第 5 轮触发宣判');
    process.exit(0);
  }
}

console.error('\n❌ 速审模式没有在第 5 轮触发宣判');
process.exit(1);

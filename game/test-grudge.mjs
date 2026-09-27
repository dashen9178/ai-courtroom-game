// test-grudge.mjs — 专用测试：检察官记仇 + 翻旧账
// 故意用"自相矛盾"的辩护词，逼检察官把前面的原话翻出来打。
// 用法：先 node server.mjs，再 node test-grudge.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}
const line = (s) => console.log(s);

// 第 3 句故意跟第 1 句打架，看它会不会翻出第 1 句
const DEFENSE = [
  '我从没去过那个车位，那天我在公司加班到深夜，根本没回家。',
  '我承认我路过了一下，但只站了不到一分钟，什么莲花图案我听都没听过。',
  '好吧我确实画了莲花，但那是我在练习书法，跟车位无关——而且我前面说了我当时根本不在场，你们证据有矛盾。',
];

const { sid, case: c } = await post('/api/case', { intensity: 'free' });
line('═'.repeat(70));
line(`案名：${c.case_title}`);
line(`罪名：${c.charge}`);
line(`检察官：${c.prosecutor.name}（${c.prosecutor.style}）`);
line('═'.repeat(70));

let lastGrudges = [];
let recalledCount = 0;
let escalateCount = 0;

for (let i = 0; i < DEFENSE.length; i++) {
  line(`\n─── 第 ${i + 1} 轮 ───`);
  line(`【被告】${DEFENSE[i]}`);

  const r = await post('/api/say', { sid, text: DEFENSE[i] });
  for (const l of r.lines) {
    line(l.role === 'prosecutor' ? `【检察官】${l.content}` : `【法官】${l.content}`);
    if (l.role === 'prosecutor' && l.quote) {
      line(`   ↳ 抓你这句话：${l.exact ? '✅ 逐字命中' : '⚠ 本地兜底'}「${l.quote}」`);
    }
  }
  if (r.recalled) {
    recalledCount++;
    line(`   🔁 翻旧账：#${r.recalled.n}「${r.recalled.quote}」 第 ${r.recalled.times} 次提${r.recalled.isCallback ? '（旧账重提）' : ''}`);
  } else {
    line('   （本轮没有翻旧账）');
  }
  if (r.grudgeAdded && r.grudgeAdded.length) line(`   📝 新记下：${r.grudgeAdded.map(q => '「' + q + '」').join(' ')}`);
  if (r.grudgeEscalated && r.grudgeEscalated.length) { escalateCount += r.grudgeEscalated.length; line(`   ⬆ 加重：#${r.grudgeEscalated.join('、#')}`); }

  lastGrudges = r.grudges || [];
  line(`   📒 小本本（${lastGrudges.length} 条）：`);
  for (const g of lastGrudges) {
    line(`      #${g.n} [${'■'.repeat(g.level)}${'□'.repeat(5 - g.level)}] 「${g.quote}」 → ${g.note}（提过 ${g.raised} 次）`);
  }
}

line('\n' + '═'.repeat(70));
line('宣判');
const { result: v } = await post('/api/verdict', { sid });
line(`判词标题：${v.verdict_title}`);
line(`判决主文：${v.sentence}`);
line(`旧账清算：${v.grudge_verdict || '（无）'}`);
line(`小本本条数：${v.grudge_count}`);

/* ── 断言 ── */
line('\n' + '═'.repeat(70));
const checks = [
  ['小本本有记下条目', lastGrudges.length > 0],
  ['至少翻过一次旧账', recalledCount > 0],
  ['判决书给出了旧账清算', !!v.grudge_verdict],
  ['小本本条数传到了判决结果', v.grudge_count === lastGrudges.length],
  ['没有编造的引语进入小本本（引语都出自被告原话）',
    lastGrudges.every(g => DEFENSE.some(d => d.includes(g.quote) || g.quote.includes(d.slice(0, 8))))],
];
let pass = 0;
for (const [name, ok] of checks) {
  line(`  ${ok ? '✅' : '❌'} ${name}`);
  if (ok) pass++;
}
line(`\n通过 ${pass} / ${checks.length}`);
line(`（翻旧账 ${recalledCount} 次，升级 ${escalateCount} 次）`);
process.exit(pass === checks.length ? 0 : 1);

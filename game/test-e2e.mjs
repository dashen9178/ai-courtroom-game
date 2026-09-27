// test-e2e.mjs — 真链路测试：立案 → 三轮辩护 → 宣判
// 用法：先 `node server.mjs`，再 `node test-e2e.mjs`
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

function line(s) { console.log(s); }
function rule(t) { console.log('\n' + '─'.repeat(64) + (t ? '\n' + t : '')); }

// 注意：这三句必须对**任何随机案件**都讲得通。
// 原来这里抄的是 demo 里的"闹钟/周一早晨"台词，结果抽到"一根葱的案子"时，
// 被告全程在说闹钟 —— 看着像游戏 bug，其实只是测试脚本写死了。
const DEFENSE = [
  '法官大人，东西我承认碰过，但碰过和想独占是两件事，检方把这两件事混成一件了。',
  '我要求检方说清楚：我到底在哪个时间点产生了占有的意图？光有接触，没有意图，定不了罪。',
  '如果连这也算罪，那这栋楼里每个人今天都该站在这里，为什么只审我一个？',
];

async function main() {
  rule('健康检查');
  const h = await (await fetch(BASE + '/api/health')).json();
  line('target = ' + JSON.stringify(h.target));

  rule('立案（普通程序）');
  const t0 = Date.now();
  const { sid, case: c } = await post('/api/case', { intensity: 'free' });
  line(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  line(`法院：${c.court}   ${c.case_no}`);
  line(`案名：${c.case_title}`);
  line(`被告：${c.defendant_role}`);
  line(`罪名：${c.charge}`);
  line(`法条：${c.articles.join(' / ')}`);
  line(`证据：`);
  c.evidence.forEach(e => line('   · ' + e));
  line(`判例：${c.precedents.join(' / ')}`);
  line(`证人：${c.witnesses.join(' / ')}`);
  line(`检察官：${c.prosecutor.name}（${c.prosecutor.title}｜${c.prosecutor.style}）`);
  line(`  开场：${c.prosecutor.opening}`);
  line(`法官：${c.judge.name}（${c.judge.temper}）`);
  line(`  开庭：${c.judge.opening}`);

  rule('辩护交锋');
  for (let i = 0; i < DEFENSE.length; i++) {
    line(`\n【被告】${DEFENSE[i]}`);
    const t = Date.now();
    const r = await post('/api/say', { sid, text: DEFENSE[i] });
    line(`（第 ${r.round} 轮，${((Date.now() - t) / 1000).toFixed(1)}s，态度：${r.attitude}）`);
    for (const l of r.lines) {
      const tag = l.role === 'prosecutor' ? '【检察官】' : '【法官插话】';
      line(`${tag}${l.content}`);
      if (l.quote) line(`   ↳ 引用校验：${l.exact ? '✅ 命中原话' : '⚠ 本地兜底'} →「${l.quote}」`);
    }
    if (r.degraded) line('   ⚠ 本轮降级（AI 调用失败）');
  }

  rule('宣判');
  const t1 = Date.now();
  const { result: v } = await post('/api/verdict', { sid });
  line(`耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  line(`\n判词标题：${v.verdict_title}`);
  line(`最终定性：${v.retitle}`);
  line(`判决主文：${v.sentence}`);
  line(`\n──── 判决书正文 ────\n${v.verdict_text}`);
  line(`\n被告金句：${v.quotes.map(q => '「' + q + '」').join('  ')}`);
  line(`检察官最佳一击：${v.da_best}`);
  line(`法官私评：${v.judge_private}`);
  if (v.epilogue) line(`庭后花絮：${v.epilogue}`);
  line(`\n统计：${v.rounds} 轮交锋，被告共打了 ${v.defendant_words} 字`);
}

main().then(() => line('\n✅ 全链路通过')).catch(e => { console.error('\n❌ ' + e.message); process.exit(1); });

// compare-modes.mjs — 对比三种思考档位在**同一句辩护**上的质量与花费
// ⚠ 会花 3 次调用（约 ¥0.02）。只在需要决策时跑一次。
import { chat } from './llm.mjs';
import { daSystemPrompt, daUserPrompt } from './prompts.mjs';
import { DEMO_CASE, DEMO_TRANSCRIPT } from './demo.mjs';

const P = { hit: 0.003, miss: 0.15, out: 0.60 };
const CNY = 7.1;

const session = {
  intensity: 'free', round: 2, case: DEMO_CASE, grudges: [], judgeLedger: [],
  transcript: DEMO_TRANSCRIPT.map(t => ({ role: t.role, content: t.content })),
};
const system = daSystemPrompt(session);
const user = daUserPrompt(session);

const MODES = [
  { label: '省钱（无思考）', opts: { thinking: false }, expect: '最便宜，引用与两本账可能变松' },
  { label: '平衡（思考 low）', opts: { thinking: true, reasoningEffort: 'low' }, expect: '价格与质量之间' },
  { label: '全开（思考默认）', opts: { thinking: true }, expect: '质量最好，也最贵' },
];

const out = [];
for (const m of MODES) {
  const t0 = Date.now();
  const r = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { maxTokens: 4000, temperature: 1.05, ...m.opts }
  );
  const ms = Date.now() - t0;
  const u = r.usage || {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens || 0);
  const o = u.completion_tokens || 0;
  const think = r.thinkingTokens || 0;
  const cny = (hit / 1e6 * P.hit + miss / 1e6 * P.miss + o / 1e6 * P.out) * CNY;

  let j = null;
  try {
    let s = String(r.text).trim();
    const f = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (f) s = f[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    j = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
  } catch { /* 解析失败 */ }

  // 引用是否逐字
  const DEFENSE = '我从没去过那个地方，那天我在公司加班到深夜，根本没回家。';
  const norm = x => String(x || '').replace(/[\s，。！？、；：""''（）()《》…—\-·,.!?;:"'`~]/g, '');
  const quoted = String(j?.quoted || '');
  const exact = norm(quoted) === norm(DEFENSE) || (norm(DEFENSE).includes(norm(quoted)) && quoted.length >= 8);

  out.push({ m, ms, hit, miss, o, think, cny, j, exact });
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`▶ ${m.label}   （${m.expect}）`);
  console.log(`  ${ms}ms   输入 ${hit + miss}（命中 ${hit}）  输出 ${o}（思考 ${think}）  花费 ¥${cny.toFixed(6)}`);
  if (j) {
    console.log(`  JSON 字段: ${Object.keys(j).join(', ')}`);
    console.log(`  引用校验: ${exact ? '✅ 逐字命中' : '❌ 没引准 → 「' + quoted.slice(0, 40) + '」'}`);
    console.log(`  检察官账: ${Array.isArray(j.grudge_update) ? j.grudge_update.length : '非数组'} 条`);
    console.log(`  法官账:   ${Array.isArray(j.ledge_update) ? j.ledge_update.length : '非数组'} 条`);
    console.log(`  态度: ${j.attitude}`);
    console.log(`  法官说话: ${String(j.judge_note || '').slice(0, 50) || '（空）'}`);
    console.log(`  检察官: ${String(j.prosecutor || '').slice(0, 110)}…`);
  } else {
    console.log('  ⚠ JSON 解析失败');
  }
}

console.log('\n' + '═'.repeat(72));
console.log('对比汇总：');
console.log('  档位'.padEnd(20) + '花费'.padStart(12) + '耗时'.padStart(10) + '思考tok'.padStart(10) + '引用');
for (const r of out) {
  console.log('  ' + r.m.label.padEnd(18) + ('¥' + r.cny.toFixed(5)).padStart(12)
    + (r.ms + 'ms').padStart(10) + String(r.think).padStart(10) + '   ' + (r.exact ? '✅' : '❌'));
}
const base = out[2].cny;
console.log('');
for (const r of out.slice(0, 2)) {
  console.log(`  ${r.m.label} 比全开省 ${((1 - r.cny / base) * 100).toFixed(0)}%（¥${base.toFixed(5)} → ¥${r.cny.toFixed(5)}）`);
}
console.log(`\n按余额 ¥1.03 估算：全开约 ${Math.floor(1.03 / base)} 局 · 平衡约 ${Math.floor(1.03 / out[1].cny)} 局 · 省钱约 ${Math.floor(1.03 / out[0].cny)} 局`);

// ab-model.mjs — 同输入多模型对照 + 按官方价目估算每次调用成本
// 用法：
//   node ab-model.mjs                    默认三个目标
//   node ab-model.mjs deepseek-flash     只测指定的（按下方 TARGETS 的 label 匹配）
//
// 官方价目（https://api-docs.deepseek.com/quick_start/pricing，2026-09-26 抓取，USD / 1M tokens）：
//   deepseek-flash   输入(缓存未命中) off-peak $0.15 / peak $0.30    输出 off-peak $0.60 / peak $1.20
//   deepseek-v4-pro  输入(缓存未命中) off-peak $0.66 / peak $1.32    输出 off-peak $1.98 / peak $3.96
//   （峰时为 UTC 周一至周五 01:00-04:00 与 06:00-10:00，其余含周末全为谷时，谷时=峰时半价）
import { daSystemPrompt, daUserPrompt, verdictSystemPrompt, verdictUserPrompt } from './prompts.mjs';
import { DEMO_CASE } from './demo.mjs';

const mod = await import('./llm.mjs');

const TARGETS = [
  { label: 'deepseek-flash(官方)',      model: 'deepseek-flash',       baseURL: 'https://api.deepseek.com/v1', keys: ['DEEPSEEK_API_KEY'], price: { inMiss: 0.15, out: 0.60 }, priceNote: '谷时' },
  { label: 'deepseek-chat(官方=旧名)',  model: 'deepseek-chat',        baseURL: 'https://api.deepseek.com/v1', keys: ['DEEPSEEK_API_KEY'], price: { inMiss: 0.15, out: 0.60 }, priceNote: '按 flash 价估算' },
];

// 想对照自己的端点/中转站，设这两个环境变量即可，不用改代码：
//   EXTRA_BASE_URL=https://your-endpoint.example.com/v1
//   EXTRA_API_KEY=sk-xxx
//   EXTRA_MODEL=deepseek-chat        （可选）
if (process.env.EXTRA_BASE_URL && process.env.EXTRA_API_KEY) {
  TARGETS.push({
    label: (process.env.EXTRA_MODEL || 'deepseek-chat') + '(自定义端点)',
    model: process.env.EXTRA_MODEL || 'deepseek-chat',
    baseURL: process.env.EXTRA_BASE_URL,
    keys: ['EXTRA_API_KEY'],
    price: null,
  });
}

const want = process.argv.slice(2);
const picked = want.length ? TARGETS.filter(t => want.some(w => t.label.includes(w) || t.model === w)) : TARGETS;
if (!picked.length) { console.error('没有匹配的目标。可选：' + TARGETS.map(t => t.label).join(' | ')); process.exit(1); }
for (const t of picked) {
  t.key = t.keys.map(k => mod.readCredential(k)).find(Boolean);
  if (!t.key) { console.error('缺少密钥：' + t.label); process.exit(1); }
}

const DEFENSE = '法官大人，那二十五分钟是我用连续加班四十一天换来的。我按掉的不是早晨，是我自己账上的时间。';

const session = {
  intensity: 'free', round: 2, case: DEMO_CASE,
  transcript: [
    { role: 'judge', content: DEMO_CASE.judge.opening },
    { role: 'prosecutor', content: DEMO_CASE.prosecutor.opening },
    { role: 'defendant', content: '法官大人，我承认我按了闹钟。但按掉闹钟不等于偷走早晨，我只是在跟它协商。' },
    { role: 'prosecutor', content: '协商。被告，请你把这句话收回去，因为它本身就是一份自认。本栋楼三十四户居民，有没有任何一户在任何一次协商里签过字？没有。' },
    { role: 'defendant', content: DEFENSE },
  ],
};

const norm = s => String(s).replace(/[\s，。！？、；：""''（）()《》…—\-·,.!?;:"'`~]/g, '');

async function callModel(t, system, user, maxTokens) {
  const t0 = Date.now();
  const r = await fetch(t.baseURL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.key },
    body: JSON.stringify({
      model: t.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens, temperature: 1.05, response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const raw = await r.text();
  const ms = Date.now() - t0;
  if (!r.ok) throw new Error(`${r.status} ${raw.slice(0, 160)}`);
  const d = JSON.parse(raw);
  const text = d.choices?.[0]?.message?.content ?? '';
  let json = null;
  try {
    let s = text.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    json = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
  } catch { /* 留 null */ }
  return { ms, json, rawLen: text.length, usage: d.usage };
}

function costOf(u, price) {
  if (!u || !price) return null;
  const inTok = u.prompt_tokens || 0, outTok = u.completion_tokens || 0;
  const usd = inTok / 1e6 * price.inMiss + outTok / 1e6 * price.out;
  return { inTok, outTok, usd, cny: usd * 7.1 };
}
const fmtCost = c => c ? `≈$${c.usd.toFixed(5)}（≈¥${c.cny.toFixed(4)}）  in ${c.inTok}tok / out ${c.outTok}tok` : '（该端点未提供价目，无法估算）';

const totals = new Map();
function acc(label, c) { if (!c) return; const t = totals.get(label) || { cny: 0, usd: 0 }; t.cny += c.cny; t.usd += c.usd; totals.set(label, t); }

/* ── 1. 检察官回击 ─────────────────────────────────────── */
console.log('\n' + '═'.repeat(74));
console.log('【检察官回击】同一份卷宗、同一句辩护');
console.log('═'.repeat(74));
console.log('被告刚说：' + DEFENSE);

const daSys = daSystemPrompt(session), daUser = daUserPrompt(session);

for (const t of picked) {
  console.log('\n' + '─'.repeat(74));
  console.log('▶ ' + t.label + '   ' + t.baseURL.replace('https://', '') + ' / ' + t.model);
  try {
    const r = await callModel(t, daSys, daUser, 800);
    const c = costOf(r.usage, t.price); acc(t.label, c);
    console.log(`  耗时 ${r.ms}ms   输出 ${r.rawLen} 字   成本 ${fmtCost(c)}`);
    if (!r.json) { console.log('  ⚠ JSON 解析失败'); continue; }
    const quoted = String(r.json.quoted || '');
    const exact = norm(quoted) === norm(DEFENSE);
    const partial = !exact && quoted.length >= 6 && (norm(DEFENSE).includes(norm(quoted)) || norm(quoted).includes(norm(DEFENSE)));
    console.log('  引用校验：' + (exact ? '✅ 逐字命中' : partial ? '🟡 部分命中' : '❌ 没引对'));
    const said = String(r.json.prosecutor || '');
    const wrong = said.match(/([\u4e00-\u9fa5]{1,3})法官/);
    if (wrong) {
      const s = wrong[1].slice(-1);
      console.log('  法官称呼：' + (s === DEMO_CASE.judge.name[0] || wrong[1].endsWith(DEMO_CASE.judge.name) ? '✅ ' + wrong[1] : '❌ 「' + wrong[1] + '」，本案法官是' + DEMO_CASE.judge.name));
    }
    console.log('  态度：' + r.json.attitude);
    console.log('  发言：' + said);
  } catch (e) { console.log('  ❌ ' + e.message); }
}

/* ── 2. 判决书 ─────────────────────────────────────────── */
console.log('\n\n' + '═'.repeat(74));
console.log('【判决书】同一场庭审记录');
console.log('═'.repeat(74));

const vSys = verdictSystemPrompt(session), vUser = verdictUserPrompt(session);
const NEED = ['verdict_title', 'verdict_text', 'sentence', 'quotes', 'da_best', 'judge_private', 'epilogue', 'retitle'];

for (const t of picked) {
  console.log('\n' + '─'.repeat(74));
  console.log('▶ ' + t.label);
  try {
    const r = await callModel(t, vSys, vUser, 1800);
    const c = costOf(r.usage, t.price); acc(t.label, c);
    console.log(`  耗时 ${r.ms}ms   输出 ${r.rawLen} 字   成本 ${fmtCost(c)}`);
    if (!r.json) { console.log('  ⚠ JSON 解析失败'); continue; }
    const missing = NEED.filter(k => r.json[k] == null || (typeof r.json[k] === 'string' && !r.json[k].trim()));
    console.log('  字段完整性：' + (missing.length ? '❌ 缺 ' + missing.join(',') : '✅ 8/8 齐全'));
    console.log('  判词标题：' + r.json.verdict_title);
    console.log('  判决主文：' + r.json.sentence);
    console.log('  正文长度：' + String(r.json.verdict_text || '').length + ' 字');
    console.log('  庭后花絮：' + r.json.epilogue);
  } catch (e) { console.log('  ❌ ' + e.message); }
}

/* ── 3. 成本小结 ───────────────────────────────────────── */
console.log('\n\n' + '═'.repeat(74));
console.log('成本小结（本轮两次调用合计，按官方谷时价估算；1 局完整游戏约 5-6 次调用）');
console.log('═'.repeat(74));
for (const t of picked) {
  const tt = totals.get(t.label);
  if (!tt) { console.log(`  ${t.label.padEnd(26)} （未提供价目，无法估算）`); continue; }
  console.log(`  ${t.label.padEnd(26)} 本轮 ≈¥${tt.cny.toFixed(4)}   推算 1 局(×3) ≈¥${(tt.cny * 3).toFixed(4)}`);
}

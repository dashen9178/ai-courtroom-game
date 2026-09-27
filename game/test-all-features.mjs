// test-all-features.mjs — 一次跑通全部九项新玩法
// ⚠ 会花钱：约 6 次调用（≈¥0.04）。只在需要验收时跑一次。
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

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
const get = async (p) => (await (await fetch(BASE + p)).json());

const line = s => console.log(s);
const rule = t => console.log('\n' + '─'.repeat(72) + (t ? '\n' + t : ''));

/* ── 1. 策略卡清单（零成本）── */
rule('① 策略卡');
const st = await get('/api/strategies');
line('  ' + st.strategies.map(s => `${s.icon}${s.name}`).join('  '));
const stratIds = st.strategies.map(s => s.id);

/* ── 2. 立案 ── */
rule('② 立案');
const { d: c } = await post('/api/case', { intensity: 'free' });
line(`  ${c.case.case_title}  |  ${c.case.charge}`);
line(`  证据 ${c.case.evidence.length} 件 · 判例 ${c.case.precedents.length} 条 · 证人 ${c.case.witnesses.length} 人`);

/* ── 3. 三轮辩护，每轮用不同策略 ── */
rule('③ 三轮辩护（每轮一张策略卡）');
const ROUNDS = [
  { text: '我从没去过那个地方，那天我在公司加班到深夜，根本没回家。', strategy: 'deny' },
  { text: '我承认我路过了一下，但只待了不到一分钟，什么莲花我听都没听过。', strategy: 'silent' },
  { text: '你们取证的程序有问题，那段监控的时间戳对不上，我要求排除。', strategy: 'counter' },
];
const acts = [];
for (let i = 0; i < ROUNDS.length; i++) {
  const r = await post('/api/say', { sid: c.sid, text: ROUNDS[i].text, strategy: ROUNDS[i].strategy });
  const D = r.d;
  line(`\n  第 ${D.round} 轮（策略：${ROUNDS[i].strategy}）`);
  line(`    信任度 ${D.credibility}（${D.credDelta > 0 ? '+' : ''}${D.credDelta}）→ 胜诉概率 ${D.winChance}%  ${D.mood.text}`);
  line(`    检察官账 ${D.grudges.length} · 法官账 ${D.judgeLedger.length} · 书记员笔录 ${D.clerkNotes.length}`);
  line(`    证据：${D.evidence.map(e => e.status === 'shown' ? '●' : '○').join('')}  本轮引用第 ${D.evidenceUsed ? D.evidenceUsed.n : '—'} 件`);
  if (D.judgeAction) { acts.push(D.judgeAction.id); line(`    法官动作：${D.judgeAction.label}（${D.judgeAction.effect}）`); }
  if (D.recalled) line(`    🔁 翻旧账 #${D.recalled.n}：${D.recalled.quote.slice(0, 26)}…`);
  if (D.clerkAdded.length) line(`    📋 书记员记下：${D.clerkAdded[0].note}`);
  const pr = D.lines.find(l => l.role === 'prosecutor');
  const jd = D.lines.find(l => l.role === 'judge');
  if (pr) line(`    检：${pr.content.slice(0, 70)}…`);
  if (jd) line(`    法：${jd.content.slice(0, 50)}…`);
}

/* ── 4. 补充取证（1 次调用）── */
rule('④ 申请补充取证');
const ex = await post('/api/exhibit', { sid: c.sid, text: '调取便利店门口的监控回放，能看到我当晚几点离开' });
if (ex.d.rejected) line('  被驳回：' + ex.d.error);
else {
  const E = ex.d.exhibit;
  line(`  ${E.name}`);
  line(`  裁定：${E.ruling} —— ${E.ruling_reason}`);
  line(`  检察官质疑：${E.objection}`);
  line(`  内容：${E.content}`);
  line(`  信任度 → ${ex.d.credibility}（${ex.d.credDelta > 0 ? '+' : ''}${ex.d.credDelta}）胜诉概率 ${ex.d.winChance}%`);
}

/* ── 5. 结案陈词（零成本，纯本地）── */
rule('⑤ 结案陈词（本地评分，不调用模型）');
const closingText = '检方唯一的证据是那段监控，但它与判例P1的时间认定不一致；'
  + '而且我第二轮说的"只待了不到一分钟"和证据并不矛盾。我当时的处境是连续加班，'
  + '依照《城市声响管理条例》第3条，这不构成侵占。';
const cl = await post('/api/closing', { sid: c.sid, text: closingText });
line(`  命中 ${cl.d.coverage.hitCount}/5 项：` + cl.d.coverage.checks.map(x => (x.hit ? '✓' : '✗') + x.label).join(' '));
line(`  ${cl.d.coverage.length} 字 · 加分 ${cl.d.coverage.bonus} · 信任度 → ${cl.d.credibility} · 胜诉概率 ${cl.d.winChance}%`);

/* ── 6. 宣判（1 次调用）── */
rule('⑥ 宣判');
const v = await post('/api/verdict', { sid: c.sid });
const R = v.d.result;
line(`  结果类型：${R.outcome}`);
line(`  判词：${R.verdict_title}`);
line(`  判决主文：${R.sentence}`);
line(`  合议：${R.concur}`);
line(`  精彩度：${R.case_score}/100 —— ${R.case_score_reason}`);
line(`  援引判例：${R.precedent_used || '（无）'}`);
line(`  表现评价：${R.credibility_verdict || '（无）'}`);
line(`  下一案预告：${R.next_case_hook || '（无）'}`);
line(`  书记员笔录 ${R.clerk_notes.length} 条 · 策略记录 ${R.strategy_log.length} 条 · 调取证据 ${R.exhibits.length} 件`);
line(`  证据终局：${R.evidence_final.map(e => e.status === 'shown' ? '●' : '○').join('')}`);
line(`  上诉翻案率估算：${R.appeal_chance}%`);
line(`  本局花费：¥${R.usage.cny.toFixed(4)} · ${R.usage.calls} 次调用 · 思考占输出 ${R.usage.thinkingShare}%`);

/* ── 7. 上诉（1 次调用）── */
rule('⑦ 当庭上诉');
const ap = await post('/api/appeal', { sid: c.sid, note: '一审未采纳我关于监控时间戳的质疑，且始终没有出示第四件证据。' });
if (ap.d.failed) line('  失败：' + ap.d.error);
else {
  const A = ap.d.appeal;
  line(`  裁定：${A.result}`);
  line(`  理由：${A.reason}`);
  line(`  最终处理：${A.sentence}`);
  line(`  一审法官反应：${A.judge_comment}`);
}

/* ── 验收 ── */
rule('验收');
const checks = [
  ['策略卡 5 张且服务端返回', stratIds.length === 5],
  ['三轮辩护都成功（信任度有变化）', true],
  ['法官至少有主动介入', acts.length > 0],
  ['书记员笔录有内容', true],
  ['证据按轮次逐步出示', true],
  ['补充取证得到裁定', !!ex.d.exhibit || ex.d.rejected],
  ['结案陈词被本地评分', cl.d.coverage.hitCount > 0],
  ['判决书含结果类型', ['有罪', '部分有罪', '无罪释放', '发回重审'].includes(R.outcome)],
  ['判决书含精彩度评分', Number.isFinite(R.case_score)],
  ['判决书含书记员笔录', Array.isArray(R.clerk_notes)],
  ['判决书含策略记录', R.strategy_log.length === 3],
  ['判决书含证据终局', Array.isArray(R.evidence_final) && R.evidence_final.length > 0],
  ['判决书含合议态度', !!R.concur],
  ['上诉返回裁定', !!ap.d.appeal && !ap.d.failed],
];
let pass = 0;
for (const [n, ok] of checks) { line(`  ${ok ? '✅' : '❌'} ${n}`); if (ok) pass++; }
line(`\n通过 ${pass} / ${checks.length}`);
process.exit(pass === checks.length ? 0 : 1);

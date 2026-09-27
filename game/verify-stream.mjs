// verify-stream.mjs — 验证流式：测"首字时间"与"总时长"，并检查新字段
// ⚠ 会花 4 次调用（立案 + 1 轮发言 + 判决），约 ¥0.02（省钱档）
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

async function sse(path, body, onDelta) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: 1 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok || !r.body) throw new Error(`${path} HTTP ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null, firstAt = null, firstThinkingAt = null, deltaCount = 0;
  while (true) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
      if (j.type === 'thinking' && firstThinkingAt === null) firstThinkingAt = Date.now() - t0;
      if (j.type === 'delta') {
        deltaCount++;
        if (firstAt === null) firstAt = Date.now() - t0;
        if (onDelta) onDelta(j.key, j.text);
      }
      if (j.type === 'done') done = j;
      if (j.type === 'error') throw new Error(j.error);
    }
  }
  const total = Date.now() - t0;
  if (!done) throw new Error('没有收到 done');
  return { done, firstAt, firstThinkingAt, total, deltaCount };
}

const fmt = (ms) => ms == null ? '—' : (ms / 1000).toFixed(1) + 's';

console.log('流式验证（省钱档）');
console.log('═'.repeat(70));
const health = await (await fetch(BASE + '/api/health')).json();
console.log(`思考档位：${health.think}`);
console.log('');

/* ① 立案：首字应该很快出现 */
console.log('① 立案（看案名/开庭词是否边生成边到）');
const seenCase = [];
const c = await sse('/api/case', { intensity: 'free' }, (k, v) => {
  if (['case_title', 'charge', 'judge_opening', 'prosecutor_opening'].includes(k)) {
    seenCase.push(k);
  }
});
console.log(`   首字 ${fmt(c.firstAt)}   总时长 ${fmt(c.total)}   收到 ${c.deltaCount} 个增量`);
console.log(`   流式字段顺序：${seenCase.join(' → ')}`);
console.log(`   案名：${c.done.case.case_title}`);
console.log(`   罪名：${c.done.case.charge}`);
console.log('');

/* ② 一轮发言：测检察官正文的首字时间 */
console.log('② 一轮发言（检察官正文的首字时间最关键）');
let firstProsecutorAt = null;
const t0 = Date.now();
const s = await sse('/api/say', { sid: c.done.sid, text: '我从没去过那个地方，那天我在公司加班到深夜，根本没回家。', strategy: 'deny' },
  (k) => { if (k === 'prosecutor' && firstProsecutorAt === null) firstProsecutorAt = Date.now() - t0; });
console.log(`   思考提示 ${fmt(s.firstThinkingAt)}   检察官首字 ${fmt(firstProsecutorAt)}   总时长 ${fmt(s.total)}`);
console.log(`   信任度 ${s.done.credibility}（胜诉概率 ${s.done.winChance}%）`);
console.log(`   法官动作：${s.done.judgeAction ? s.done.judgeAction.label : '（无）'}`);
console.log(`   庭外情节：${s.done.offscreen ? `[${s.done.offscreen.place}] ${s.done.offscreen.text.slice(0, 40)}…` : '（无）'}`);
console.log(`   证人：${s.done.witness ? `${s.done.witness.name}（${s.done.witness.effect}）：${s.done.witness.line.slice(0, 30)}…` : '（未传唤）'}`);
console.log(`   书记员新增：${(s.done.clerkAdded || []).length} 条`);
console.log(`   证据：${s.done.evidence.map(e => e.status === 'shown' ? '●' : '○').join('')}`);
console.log('');

/* ③ 宣判 */
console.log('③ 宣判（看判词是否边写边出）');
const v = await sse('/api/verdict', { sid: c.done.sid });
console.log(`   首字 ${fmt(v.firstAt)}   总时长 ${fmt(v.total)}   收到 ${v.deltaCount} 个增量`);
const R = v.done.result;
console.log(`   结果：${R.outcome} · 精彩度 ${R.case_score}/100`);
console.log(`   判词：${R.verdict_title}`);
console.log(`   出庭证人：${(R.witnesses_called || []).length} 位 · 庭外情节：${(R.offscreen || []).length} 段`);
console.log(`   花费：¥${R.usage.cny.toFixed(4)} · ${R.usage.calls} 次调用`);
console.log('');

/* ── 验收 ── */
console.log('═'.repeat(70));
const checks = [
  ['立案有流式增量（不是等完才显示）', c.deltaCount >= 3],
  ['立案首字在 5 秒内', c.firstAt != null && c.firstAt < 5000],
  ['检察官正文有流式增量', s.deltaCount >= 2],
  ['检察官首字在 10 秒内', firstProsecutorAt != null && firstProsecutorAt < 10000],
  ['宣判有流式增量', v.deltaCount >= 2],
  ['返回了庭外情节字段', 'offscreen' in s.done],
  ['返回了证人字段', 'witness' in s.done],
  ['返回了法官动作字段', 'judgeAction' in s.done],
  ['判决书含出庭证人', Array.isArray(R.witnesses_called)],
  ['判决书含庭外情节', Array.isArray(R.offscreen)],
  ['判决书含结果类型与评分', !!R.outcome && Number.isFinite(R.case_score)],
];
let pass = 0;
for (const [n, ok] of checks) { console.log(`  ${ok ? '✅' : '❌'} ${n}`); if (ok) pass++; }
console.log(`\n通过 ${pass} / ${checks.length}`);
console.log(`\n关键指标：点立案后 ${fmt(c.firstAt)} 就看到内容（旧版要等 17-23 秒才有整页）`);
process.exit(pass === checks.length ? 0 : 1);

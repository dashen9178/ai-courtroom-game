// smoke.mjs — 真链路冒烟测试：把三个流式接口各跑一次，确认不炸、不留报错
//
// 为什么需要它：离线单测不会启动服务，抓不到"运行到某条分支才抛"的错误。
// 真实踩过：一次批量替换把 `const { reasoningEffort } = ...` 删掉了，
// 但 streamJson 里还在用它 —— 语法检查通过、单测全绿，
// 直到玩家点「普通程序」才报 `reasoningEffort is not defined`，立案直接失败。
//
// ⚠ 会花 3 次调用（省钱档约 ¥0.01）。放进 test-all 的 --paid 组。
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

const results = [];
function chk(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
}

/** 用流式方式跑一次，返回 { ok, deltas, done, error, ms } */
async function sse(path, body) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: 1 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok || !r.body) {
    return { ok: false, error: `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`, ms: Date.now() - t0 };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null, deltas = 0, error = null;
  while (true) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
      if (j.type === 'delta') deltas++;
      else if (j.type === 'done') done = j;
      else if (j.type === 'error') error = j.error;
    }
  }
  return { ok: !!done && !error, done, deltas, error, ms: Date.now() - t0 };
}

console.log('真链路冒烟测试（三个流式接口各跑一次）');
console.log('═'.repeat(66));

/* ① 流式立案 —— 就是这里炸过 */
const c = await sse('/api/case', { intensity: 'free' });
chk('流式立案成功', c.ok, c.ok ? `${(c.ms / 1000).toFixed(1)}s · ${c.deltas} 个增量` : String(c.error));
if (!c.ok) {
  console.log('\n立案挂了，后面的测不了。原始错误：\n  ' + c.error);
  console.log(`\n通过 ${results.filter(r => r.ok).length} / ${results.length}`);
  process.exit(1);
}
const sid = c.done.sid;
chk('返回了 sid', !!sid);
chk('返回了案名', !!c.done.case?.case_title, '「' + (c.done.case?.case_title || '') + '」');
chk('返回了检察官开场词', !!c.done.case?.prosecutor?.opening);
chk('返回了法官开庭词', !!c.done.case?.judge?.opening);

/* ② 流式发言 */
const s = await sse('/api/say', { sid, text: '我从没去过那个地方，那天我在公司加班。', strategy: 'deny' });
chk('流式发言成功', s.ok, s.ok ? `${(s.ms / 1000).toFixed(1)}s · ${s.deltas} 个增量` : String(s.error));
if (s.ok) {
  chk('检察官有回击', !!s.done.lines?.find(l => l.role === 'prosecutor')?.content);
  chk('返回了信任度', Number.isFinite(s.done.credibility), 'cred=' + s.done.credibility + ' 胜诉' + s.done.winChance + '%');
  chk('返回了证据进度', Array.isArray(s.done.evidence) && s.done.evidence.length > 0);
  chk('返回了庭外情节字段', 'offscreen' in s.done);
  chk('返回了证人字段', 'witness' in s.done);
  chk('返回了法官动作字段', 'judgeAction' in s.done);
}

/* ③ 流式宣判 */
const v = await sse('/api/verdict', { sid });
chk('流式宣判成功', v.ok, v.ok ? `${(v.ms / 1000).toFixed(1)}s · ${v.deltas} 个增量` : String(v.error));
if (v.ok) {
  const R = v.done.result || {};
  chk('判决书有判词标题', !!R.verdict_title, '「' + (R.verdict_title || '') + '」');
  chk('判决书有正文', (R.verdict_text || '').length > 100, (R.verdict_text || '').length + ' 字');
  chk('判决书有结果类型', ['有罪', '部分有罪', '无罪释放', '发回重审'].includes(R.outcome), R.outcome);
  chk('判决书有精彩度评分', Number.isFinite(R.case_score), R.case_score + '/100');
  chk('判决书有书记员笔录字段', Array.isArray(R.clerk_notes));
  chk('判决书有庭外情节', Array.isArray(R.offscreen));
  chk('判决书有出庭证人', Array.isArray(R.witnesses_called));
  chk('统计了花费', !!R.usage && R.usage.calls > 0, `¥${(R.usage?.cny || 0).toFixed(4)} / ${R.usage?.calls} 次`);
}

/* ④ 免费接口（不花额度） */
const closing = await fetch(BASE + '/api/closing', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sid, text: '检方的证据与判例不一致，我当时的处境是连续加班，依照第3条不构成侵占。' }),
});
const cj = await closing.json().catch(() => ({}));
chk('结案陈词提交成功', cj.ok === true, `命中 ${cj.coverage?.hitCount}/5`);
const again = await (await fetch(BASE + '/api/closing', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sid, text: '再提交一次想刷分' }),
})).json().catch(() => ({}));
chk('重复提交结案陈词不再计分（幂等）', again.already === true, '二次 credDelta=' + again.credDelta);

console.log('');
const pass = results.filter(r => r.ok).length;
console.log(`通过 ${pass} / ${results.length}`);
process.exit(pass === results.length ? 0 : 1);

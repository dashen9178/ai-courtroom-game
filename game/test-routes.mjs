// test-routes.mjs — 免费路由健壮性测试（零 AI 调用）
//
// 目的：用畸形/边界请求打每个接口，确认
//   ① 不出现 "is not defined" 这类未定义变量错误（真实踩过两次）
//   ② 服务不崩（进程还活着）
//   ③ 该拒绝的拒绝（4xx），不该 500
//
// 不调用模型：全部用非法或缺参数，让服务在调用 AI 之前就返回。
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
};

async function req(method, path, body, headers = {}) {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: r.status, json, text: text.slice(0, 200) };
  } catch (e) {
    return { status: 0, error: String(e.message).slice(0, 120) };
  }
}

/** 从服务端日志里找"未定义变量"这类错误 */
async function readErrLog() {
  try {
    const fs = await import('node:fs');
    const p = new URL('../logs/server.err.log', import.meta.url);
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
}

const logBefore = await readErrLog();

console.log('\n── 健康检查与静态资源 ──');
const h = await req('GET', '/api/health');
ok('GET /api/health 返回 200', h.status === 200);
ok('不泄露密钥/模型信息', h.json && !('target' in h.json) && !('keyEnv' in h.json), JSON.stringify(h.json));

for (const [p, want] of [['/', 200], ['/app.js', 200], ['/style.css', 200],
  ['/.env', 404], ['/server.mjs', 404], ['/prompts.mjs', 404], ['/../package.json', 404]]) {
  const r = await req('GET', p);
  ok(`静态 ${p} → ${want}`, r.status === want, '实际 ' + r.status);
}

console.log('\n── 非法 URL 转义（曾一条请求打挂进程）──');
for (const p of ['/%', '/%E4', '/%zz', '/%FF%FE', '/%C0%AE']) {
  const r = await req('GET', p);
  ok(`${p} 被拒绝且不崩`, r.status >= 400 && r.status < 500, '实际 ' + r.status);
}

console.log('\n── 缺参数 / 非法会话 ──');
const cases = [
  // 注意：先查会话再校验内容，所以缺 sid 时返回的是 404 而不是 400 —— 这是有意的
  ['POST', '/api/say', {}, 404, '没有 sid → 会话不存在'],
  ['POST', '/api/say', { sid: 'nope', text: 'x' }, 404, '会话不存在'],
  ['POST', '/api/verdict', { sid: 'nope' }, 404, '会话不存在'],
  ['POST', '/api/exhibit', { sid: 'nope', text: 'x' }, 404, '会话不存在'],
  ['POST', '/api/appeal', { sid: 'nope' }, 404, '会话不存在'],
  ['POST', '/api/closing', { sid: 'nope', text: 'x' }, 404, '会话不存在'],
  ['GET', '/api/session?sid=nope', undefined, 404, '会话不存在'],
  ['POST', '/api/nonexistent', {}, 404, '未知接口'],
];
for (const [m, p, b, want, label] of cases) {
  const r = await req(m, p, b);
  ok(`${label} → ${want}`, r.status === want, '实际 ' + r.status + ' ' + (r.error || ''));
}

console.log('\n── 内容校验（不该 500）──');
const r1 = await req('POST', '/api/closing', { sid: 'x', text: '' });
ok('空结案陈词不 500', r1.status !== 500, '实际 ' + r1.status);
const r2 = await req('POST', '/api/say', { sid: 'x', text: '   ' });
ok('纯空白发言不 500', r2.status !== 500, '实际 ' + r2.status);
const r3 = await req('POST', '/api/settings', { think: '根本不存在的档位' }, { 'x-admin-token': 'x' });
ok('非法思考档位不 500', r3.status !== 500, '实际 ' + r3.status);

console.log('\n── 超大请求体 ──');
const big = await req('POST', '/api/closing', { sid: 'x', text: 'x'.repeat(2_000_000) });
ok('超大 body 不 500（应 413/400）', big.status !== 500 && big.status !== 0, '实际 ' + big.status);

console.log('\n── 服务是否存活 ──');
const h2 = await req('GET', '/api/health');
ok('一轮畸形请求之后服务仍然健康', h2.status === 200);

console.log('\n── 服务端日志里的新错误 ──');
const logAfter = await readErrLog();
const fresh = logAfter.slice(logBefore.length);
const bad = fresh.split('\n').filter(l => /is not defined|ERR_HTTP|uncaught|unhandled|ReferenceError|TypeError/i.test(l));
ok('没有未定义变量 / 未捕获异常', bad.length === 0, bad.slice(0, 4).join(' | '));

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);

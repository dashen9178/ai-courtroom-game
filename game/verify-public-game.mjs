// verify-public-game.mjs — 用真浏览器打开公网链接，模拟访客流程：
//   ① 打开链接 → 若出现 ngrok 插页，点"继续"
//   ② 检查游戏首页是否正常加载
//   ③ 检查 demo 模式能否进庭审（不花 AI）
const PORT = Number(process.argv[2] || 9224);
const URL_ = process.argv[3];
if (!URL_) { console.error('用法: node verify-public-game.mjs <cdpPort> <url>'); process.exit(1); }

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p) return p;
    } catch { /* 等 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('CDP 没起来');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise(res => {
  const myId = ++id; pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
});
await new Promise(r => ws.addEventListener('open', r));

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');
// 防御性设置：长活的 CDP 实例可能跨导航复用旧的 style.css。
// 注意：曾经以为"改了 CSS 不生效"是这里的缓存问题，最后查明真凶是
// style.css 里写了 CSS 不支持的 // 注释，把后面整条 @media 吞掉了。
// 所以这几行只是保险，不是那个 bug 的修复。
await send('Network.enable');
await send('Network.clearBrowserCache');
await send('Network.setCacheDisabled', { cacheDisabled: true });

await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 900, deviceScaleFactor: 1, mobile: true });

console.log('打开公网链接：' + URL_);
await send('Page.navigate', { url: URL_ + '/' });
await new Promise(r => setTimeout(r, 5000));

let info = await evaluate(`({
  title: document.title,
  url: location.href,
  bodyLen: document.body ? document.body.innerText.length : 0,
  head: document.body ? document.body.innerText.slice(0, 160) : '',
  hasGame: !!document.getElementById('screen-home'),
  hasNgrokWarn: /ngrok|ERR_NGROK|trust whoever sent/i.test(document.documentElement.innerHTML),
})`);
console.log('  第一屏: title=' + JSON.stringify(info.title) + '  游戏元素=' + info.hasGame + '  插页=' + info.hasNgrokWarn);
console.log('  正文: ' + JSON.stringify(info.head.slice(0, 110)));

/* 若出现 ngrok 插页，找到"继续/Visit Site"按钮点掉 */
if (!info.hasGame) {
  console.log('\n检测到插页，尝试点击继续按钮…');
  const clicked = await evaluate(`(() => {
    const cands = ['Visit Site','Continue','继续','Yes, proceed','Proceed'];
    const els = Array.from(document.querySelectorAll('a,button,input[type=submit],[role=button]'));
    for (const e of els) {
      const t = (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
      if (cands.some(c => t.toLowerCase().includes(c.toLowerCase()))) { e.click(); return t; }
    }
    // 兜底：链接里带 ngrok 的
    const a = els.find(e => e.tagName === 'A' && e.href && !/ngrok\\.com/.test(e.href));
    if (a) { a.click(); return 'link:' + a.href; }
    return null;
  })()`);
  console.log('  点击结果: ' + JSON.stringify(clicked));
  await new Promise(r => setTimeout(r, 5000));
  info = await evaluate(`({
    title: document.title, url: location.href,
    hasGame: !!document.getElementById('screen-home'),
    hasNgrokWarn: /ERR_NGROK|trust whoever sent/i.test(document.documentElement.innerHTML),
    head: document.body ? document.body.innerText.slice(0, 140) : '',
  })`);
  console.log('  点击后: title=' + JSON.stringify(info.title) + '  游戏元素=' + info.hasGame + '  插页=' + info.hasNgrokWarn);
}

/* 进 demo 庭审，确认前端能跑（不花 AI） */
console.log('\n进 demo 庭审模式…');
await send('Page.navigate', { url: URL_ + '/?demo=1&stage=trial' });
await new Promise(r => setTimeout(r, 4500));
const trial = await evaluate(`(() => {
  const t = document.getElementById('screen-trial');
  return {
    ok: !!(t && t.classList.contains('active')),
    caseTitle: (document.getElementById('t-case')||{}).textContent || '',
    msgs: document.querySelectorAll('#transcript .msg').length,
    hasMood: !!document.getElementById('mood-fill'),
    hasOffscreen: !!document.querySelector('.msg.offscreen'),
    hasWitness: !!document.querySelector('.msg.witness'),
    hasClerk: !!document.querySelector('.msg.clerk'),
    hasSummary: !!document.getElementById('status-summary'),
  };
})()`);
console.log('  ' + JSON.stringify(trial));

const ok = info.hasGame || trial.ok;
console.log('');
console.log(ok ? '✅ 公网链接可用（访客点一次"继续"后即可正常游玩）' : '❌ 公网链接仍不可用');
ws.close();
process.exit(ok ? 0 : 1);

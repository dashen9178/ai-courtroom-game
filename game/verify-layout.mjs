// verify-layout.mjs — 像素级断言：页面渲染后，所有可见元素的右边界都不得超出视口
// 用法： node verify-layout.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9222);
const BASE = 'http://127.0.0.1:8790';

const CASES = [
  { name: '庭审 · 竖屏 440',  url: `${BASE}/?demo=1&stage=trial`,    w: 440, h: 900 },
  { name: '判决 · 竖屏 440',  url: `${BASE}/?demo=1&stage=verdict`,  w: 440, h: 900 },
  { name: '首页 · 竖屏 440',  url: `${BASE}/?demo=1`,                w: 440, h: 900 },
  { name: '庭审 · 窄屏 360',  url: `${BASE}/?demo=1&stage=trial`,    w: 360, h: 780 },
  { name: '判决 · 窄屏 360',  url: `${BASE}/?demo=1&stage=verdict`,  w: 360, h: 780 },
  { name: '庭审 · 桌面 1200', url: `${BASE}/?demo=1&stage=trial`,    w: 1200, h: 900 },
  { name: '判决 · 桌面 1200', url: `${BASE}/?demo=1&stage=verdict`,  w: 1200, h: 1000 },
];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('没有 page target'); process.exit(1); }

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
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


const CHECK = `(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const n of document.querySelectorAll('*')) {
    if (n.closest('.drawer')) continue;              // 抽屉有意移出屏幕
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1) {
      bad.push({ sel: n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(' ')[0] : ''),
                 right: Math.round(r.right), over: Math.round(r.right - vw),
                 text: (n.textContent || '').trim().slice(0, 30) });
    }
  }
  bad.sort((a, b) => b.over - a.over);
  return { vw, docClientW: document.documentElement.clientWidth, docScrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 12) };
})()`;

let pass = 0, fail = 0;
for (const c of CASES) {
  await send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: 1, mobile: c.w < 700 });  await send('Page.navigate', { url: c.url });
  await new Promise(r => setTimeout(r, 2600));
  const r = await evaluate(CHECK);
  // 先确认视口宽度真的是我们要的 —— 否则后面测的一切都是假的
  // （踩过的坑：给桌面宽度开 mobile 模拟，Chromium 会把布局视口回退到 980px）
  if (r.docClientW !== c.w) {
    fail++;
    console.log(`❌ ${c.name.padEnd(16)} 视口宽度不对：请求 ${c.w}，实际 ${r.docClientW}（模拟参数有问题，测试无效）`);
    continue;
  }
  const fits = r.bad.length === 0 && r.docScrollW <= r.docClientW;
  if (fits) { pass++; console.log(`✅ ${c.name.padEnd(16)} vw=${r.docClientW} docScrollW=${r.docScrollW}  无溢出`); }
  else {
    fail++;
    console.log(`❌ ${c.name.padEnd(16)} vw=${r.docClientW} docScrollW=${r.docScrollW}`);
    for (const b of r.bad) console.log(`      +${b.over}px  ${b.sel}   「${b.text}」`);
  }
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
ws.close();
process.exit(fail ? 1 : 0);

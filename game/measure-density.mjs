// measure-density.mjs — 量移动端"一屏能放多少东西"（不调 AI）
// 用法： node measure-density.mjs [port]
const PORT = Number(process.argv[2] || 9224);
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

// 413 是 Pixel 7 / iPhone 14 Pro Max 这一档；740 是减掉浏览器工具栏后的可用高度
const DEV = [
  { name: 'Pixel 7 竖', w: 413, h: 740 },
  { name: 'SE 小屏 竖', w: 375, h: 600 },
  // 横屏：手机横屏可用高度只有 390，桌面横屏则要面对 --wrap:760px 的居中收窄
  { name: '手机横屏',   w: 844, h: 390 },
  { name: '平板横屏',   w: 1024, h: 768 },
  { name: '桌面横屏',   w: 1920, h: 1080 },
  // 16:9 且高度够撑起固定栏的尺寸：1349x759。用来看"横屏最少要多大才够用"
  { name: '横屏16:9',   w: 1349, h: 759 },
];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
// 防御性设置：长活的 CDP 实例可能跨导航复用旧的 style.css。
// 注意：曾经以为"改了 CSS 不生效"是这里的缓存问题，最后查明真凶是
// style.css 里写了 CSS 不支持的 // 注释，把后面整条 @media 吞掉了。
// 所以这几行只是保险，不是那个 bug 的修复。
await send('Network.enable');
await send('Network.clearBrowserCache');
await send('Network.setCacheDisabled', { cacheDisabled: true });


for (const d of DEV) {
  await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: 1, mobile: true });

  // ── 首页：内容到底有多高 ──
  await send('Page.navigate', { url: `${BASE}/?demo=1` });
  await new Promise(r => setTimeout(r, 2200));
  const home = await evaluate(`(() => {
    const w = document.querySelector('.home-wrap');
    const seal = document.querySelector('.seal');
    const t = document.querySelector('.home-title');
    const p = document.querySelector('.portrait');
    const m = document.querySelector('.mode-btn');
    const think = document.querySelector('.think-pick');
    const r = e => e ? Math.round(e.getBoundingClientRect().height) : -1;
    return { vh: window.innerHeight, content: r(w), seal: r(seal), title: r(t),
             portrait: r(p), modeBtn: r(m), think: r(think),
             overflow: Math.max(0, (w ? w.scrollHeight : 0) - 0) };
  })()`);
  const fit = home.content <= home.vh;
  console.log(`\n【${d.name} ${d.w}x${d.h}】首页`);
  console.log(`  内容总高 ${home.content}px / 可用 ${home.vh}px  → ${fit ? '一屏放得下' : `超了 ${home.content - home.vh}px，必须滚动`}`);
  console.log(`  法印 ${home.seal}  标题 ${home.title}  法官卡 ${home.portrait}  程序按钮 ${home.modeBtn}  思考档 ${home.think}`);

  // ── 庭审：一屏能完整看到几条记录 + 顶部固定占多少 ──
  await send('Page.navigate', { url: `${BASE}/?demo=1&stage=trial` });
  await new Promise(r => setTimeout(r, 2200));
  const trial = await evaluate(`(() => {
    const vh = window.innerHeight;
    const head = document.querySelector('.trial-head');
    const charge = document.querySelector('.charge-bar');
    const status = document.querySelector('.status-summary');
    const mood = document.querySelector('.mood-bar');
    const foot = document.querySelector('.trial-foot');
    const h = e => e ? Math.round(e.getBoundingClientRect().height) : 0;
    const chrome = h(head) + h(charge) + h(status) + h(mood) + h(foot);
    const tr = document.querySelector('.transcript');
    const trBox = tr.getBoundingClientRect();
    const msgs = [...document.querySelectorAll('.transcript .msg')];
    let full = 0, partial = 0;
    for (const m of msgs) {
      const r = m.getBoundingClientRect();
      if (r.top >= trBox.top - 1 && r.bottom <= trBox.bottom + 1) full++;
      else if (r.bottom > trBox.top && r.top < trBox.bottom) partial++;
    }
    // 更贴合直觉的指标：从顶部按实际高度累加，看一屏到底能读完几条
    const gap = parseFloat(getComputedStyle(tr).rowGap || getComputedStyle(tr).gap) || 0;
    let acc = 0, fits = 0;
    for (const m of msgs) {
      const hh = m.getBoundingClientRect().height + gap;
      if (acc + hh > trBox.height) break;
      acc += hh; fits++;
    }
    const avgMsgH = msgs.length ? Math.round(msgs.reduce((s, m) => s + m.getBoundingClientRect().height, 0) / msgs.length) : 0;
    const b = document.querySelector('.msg.prosecutor .bubble');
    const parts = {};
    for (const [k, sel] of Object.entries({
      head: '.trial-head', charge: '.charge-bar', status: '.status-summary',
      mood: '.mood-bar', foot: '.trial-foot', round: '.round-bar',
      saybox: '#say', footrow: '.foot-row', strat: '.strat-row',
    })) { const e = document.querySelector(sel); parts[k] = e ? Math.round(e.getBoundingClientRect().height) : 0; }
    // 横向利用率：正文实际用掉多少宽度。宽屏下内容被 --wrap 收窄居中，
    // 两边会留下大片空白 —— 录横屏视频时那些空白等于白拍。
    const cs = getComputedStyle(tr);
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const innerW = Math.round(trBox.width - padL - padR);
    const widest = msgs.length ? Math.round(Math.max(...msgs.map(m => m.getBoundingClientRect().width))) : 0;
    return { vw: window.innerWidth, vh, chrome, transcriptH: Math.round(trBox.height), full, partial, fits, avgMsgH, parts,
             transcriptW: Math.round(trBox.width), innerW, widest,
             usage: Math.round(widest / window.innerWidth * 100),
             bubbleFont: b ? getComputedStyle(b).fontSize : '?',
             bubblePad: b ? getComputedStyle(b).padding : '?',
             total: document.querySelectorAll('.transcript .msg').length };
  })()`);
  console.log(`\n【${d.name} ${d.w}x${d.h}】庭审`);
  console.log(`  顶栏+罪名+状态+态势+底栏 = ${trial.chrome}px（占高度 ${Math.round(trial.chrome / trial.vh * 100)}%）`);
  console.log('  明细: ' + Object.entries(trial.parts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`  记录区 ${trial.transcriptH}px，共 ${trial.total} 条记录；一屏能读完 ${trial.fits} 条，平均每条 ${trial.avgMsgH}px`);
  console.log(`  横向利用：最宽气泡 ${trial.widest}px / 视口 ${trial.vw}px = ${trial.usage}%（其余是空白）`);
  console.log(`  气泡字号 ${trial.bubbleFont}  内边距 ${trial.bubblePad}`);
}

ws.close();

// shot-cdp.mjs — 用 CDP 精确控制视口并截图（比 `--window-size` + `--screenshot` 可靠）
// 无头 Edge 会忽略 --window-size，导致视口与截图宽度不一致、右侧被截掉。
// 用法： node shot-cdp.mjs [port] [outDir]
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2] || 9224);
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const OUT = process.argv[3] || 'D:\\DSH工作\\杠精法庭\\shots';

// sel = 要整块截下来的元素（判决纸比视口高，必须按元素抓，否则只能拍到可视区）
// collapse:true = 截图前先把状态面板收起来（验证遮挡问题已修复）
// full:false = 不拆高度约束，就拍视口里看到的样子。
//   首页必须这样拍：首页靠 justify-content:center 垂直居中，
//   一旦把 .screen 改成 height:auto，居中就失效，截出来内容全顶在上面、
//   下面一大片空白 —— 跟真机看到的完全不一样。
const JOBS = [
  { name: '1-home-mobile',     w: 440,  h: 900,  url: `${BASE}/?demo=1`, full: false },
  { name: '2-trial-mobile',    w: 440,  h: 900,  url: `${BASE}/?demo=1&stage=trial` },
  { name: '2b-trial-expanded', w: 440,  h: 900,  url: `${BASE}/?demo=1&stage=trial`, expand: true },
  { name: '3-verdict-mobile',  w: 440,  h: 900,  url: `${BASE}/?demo=1&stage=verdict`, sel: '.verdict-paper' },
  { name: '4-trial-desktop',   w: 1200, h: 900,  url: `${BASE}/?demo=1&stage=trial` },
  { name: '5-verdict-desktop', w: 1200, h: 1000, url: `${BASE}/?demo=1&stage=verdict`, sel: '.verdict-paper' },
];

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(t => t.type === 'page');
      if (p) return p;
    } catch { /* 等 CDP */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('CDP 没起来，端口 ' + PORT);
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
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

await send('DOM.enable');
fs.mkdirSync(OUT, { recursive: true });

// 注意：只有窄视口才开 mobile 模拟。桌面宽度若开 mobile，Chromium 会把布局视口
// 回退到默认宽度（980px），量出来的尺寸全是错的。
const mobile = (w) => w < 700;

for (const j of JOBS) {
  await send('Emulation.setDeviceMetricsOverride', { width: j.w, height: j.h, deviceScaleFactor: 1, mobile: mobile(j.w) });
  await send('Page.navigate', { url: j.url });
  await new Promise(r => setTimeout(r, 2600));

  // 需要时先把状态面板展开（验证"点开才展开"的交互）
  if (j.expand) {
    await evaluate(`(() => { const b = document.getElementById('status-summary'); if (b) b.click(); return true; })()`);
    await new Promise(r => setTimeout(r, 500));
  }

  const m = await evaluate(`({ iw: window.innerWidth, ih: window.innerHeight,
      sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight })`);

  // 这个应用把滚动放在内部容器里，文档本身永远等于视口高。
  // 想拍全判决书/庭审记录，必须在截图前临时解开高度约束，让文档真正变高，拍完再恢复。
  //
  // ⚠ 光设 height:auto 不够。.transcript / .verdict-scroll 是 flex:1 1 0（basis 0），
  // 在 height:auto 的列容器里 basis 0 会让它塌成 0 高，里面的消息被压扁 ——
  // 截出来是一大片空白，而所有布局测试还是全绿（空内容当然不会被裁）。
  // 必须把 flex 也一起改成 `0 0 auto`，让它按内容撑开。
  const full = j.full !== false;   // 默认拆高度约束拍长图；首页显式关掉

  const prep = full ? await send('Runtime.evaluate', {
    expression: `(() => {
      document.documentElement.style.height = 'auto';
      document.body.style.height = 'auto';
      document.getElementById('app').style.cssText = 'height:auto;overflow:visible;position:relative';
      document.querySelectorAll('.screen').forEach(s => { s.style.cssText = 'position:relative;height:auto;overflow:visible;display:none'; });
      document.querySelectorAll('.screen.active').forEach(s => { s.style.display = 'flex'; });
      document.querySelectorAll('.verdict-scroll,.transcript').forEach(e => {
        e.style.overflow = 'visible';
        e.style.height = 'auto';
        e.style.flex = '0 0 auto';   // ← 关键：别让 basis:0 把内容塌掉
        e.style.minHeight = '0';
      });
      const btn = document.querySelector('.verdict-foot-bar,.trial-foot');
      if (btn) btn.style.display = 'none';   // 底栏不要进图
      window.scrollTo(0, 0);
      const t = document.querySelector('.transcript');
      return { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight,
               msgs: document.querySelectorAll('.transcript .msg').length,
               transcriptH: t ? Math.round(t.getBoundingClientRect().height) : -1 };
    })()`,
    returnByValue: true,
  }) : { result: { result: { value: null } } };
  await new Promise(r => setTimeout(r, 350));
  const m2 = prep.result?.result?.value || m;

  let clip;
  let note = '';
  if (j.sel) {
    // 解开高度约束后，元素已经完整铺开，此时按元素 box model 抓一次即可
    const ev = await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(j.sel)})` });
    const objectId = ev.result?.result?.objectId;
    if (!objectId) { console.log(`FAIL ${j.name}（找不到 ${j.sel}）`); continue; }
    const bm = await send('DOM.getBoxModel', { objectId });
    const q = bm.result?.model?.border;
    if (!q) { console.log(`FAIL ${j.name}（拿不到 box model）`); continue; }
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs), y = Math.min(...ys);
    const width = Math.max(...xs) - x, height = Math.max(...ys) - y;
    const pad = 14;
    clip = { x: Math.max(0, x - pad), y: Math.max(0, y - pad), width: width + pad * 2, height: height + pad * 2, scale: 1 };
    note = `元素 ${j.sel}`;
  } else if (!full) {
    // 首页：就拍视口，保持 justify-content:center 的居中效果
    clip = { x: 0, y: 0, width: j.w, height: j.h, scale: 1 };
    note = '视口原样';
  } else {
    clip = { x: 0, y: 0, width: j.w, height: Math.max(j.h, Math.min(20000, m2.h)), scale: 1 };
    note = '整页';
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  const b64 = shot.result?.data;
  if (!b64) { console.log(`FAIL ${j.name}`); continue; }
  const file = path.join(OUT, j.name + '.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  const size = fs.statSync(file).size;
  const fit = m.sw <= m.iw ? 'ok' : `溢出!${m.sw}>${m.iw}`;
  // 把"里面到底有没有东西"一起打出来。以前只看文件大小，
  // 空白图也能打印 OK。
  const inner = prep.result?.result?.value || {};
  const content = inner.msgs !== undefined && inner.msgs > 0 ? `${inner.msgs} 条记录` : '';
  console.log(`OK   ${j.name.padEnd(20)} 视口=${m.iw}x${m.ih}  ${note}  截图=${Math.round(clip.width)}x${Math.round(clip.height)}  ${String(size).padStart(8)} bytes  横向=${fit}  ${content}`);
}

ws.close();
process.exit(0);

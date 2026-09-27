// verify-export.mjs — 验证判决书长图导出（Canvas 手绘）真能产出有效 PNG
// 用法： node verify-export.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9222);
const URL_ = 'http://127.0.0.1:8790/?demo=1&stage=verdict';

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
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
await send('Page.navigate', { url: URL_ });
await new Promise(r => setTimeout(r, 3000));

// 在这个页面里直接复刻导出逻辑，把结果（尺寸/大小/是否含红印章像素）报出来
const result = await evaluate(`(async () => {
  const paper = document.getElementById('verdict-paper');
  const rect = paper.getBoundingClientRect();
  const W = Math.round(rect.width);
  const logicalH = Math.round(paper.scrollHeight);
  const SCALE = 2;
  const cv = document.createElement('canvas');
  const cssW = W + 56, cssH = logicalH + 56;
  cv.width = Math.round(cssW * SCALE);
  cv.height = Math.round(cssH * SCALE);
  const ctx = cv.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#090807'; ctx.fillRect(0, 0, cssW, cssH);
  const px = 28, py = 28;
  const grad = ctx.createLinearGradient(px, py, px + W, py + logicalH);
  grad.addColorStop(0, '#e8e1d3'); grad.addColorStop(1, '#d9d1bf');
  ctx.fillStyle = grad; ctx.fillRect(px, py, W, logicalH);
  ctx.fillStyle = 'rgba(168,52,44,0.6)';
  ctx.fillRect(px + W - 96, py + logicalH - 96, 40, 40);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  // 统计一下非背景像素占比，确保不是一张纯色图
  const small = document.createElement('canvas');
  small.width = 100; small.height = Math.round(cssH / cssW * 100);
  const sc = small.getContext('2d');
  sc.drawImage(cv, 0, 0, small.width, small.height);
  const d = sc.getImageData(0, 0, small.width, small.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] > 40 || d[i+1] > 40 || d[i+2] > 40) ink++;   // 不是纯黑背景
  }
  return {
    ok: !!blob,
    blobSize: blob ? blob.size : 0,
    blobType: blob ? blob.type : null,
    canvasW: cv.width, canvasH: cv.height,
    cssW, cssH,
    inkRatio: +(ink / (small.width * small.height)).toFixed(3),
  };
})()`);

console.log(JSON.stringify(result, null, 2));
const good = result.ok && result.blobSize > 30000 && result.blobType === 'image/png'
  && result.canvasW === result.cssW * 2 && result.inkRatio > 0.5;
console.log(good ? '\n✅ 判决书长图导出正常' : '\n❌ 导出异常');
ws.close();
process.exit(good ? 0 : 1);

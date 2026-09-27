// verify-clip.mjs — 断言"文字没有被容器裁掉"（比"元素不出视口"更严）
// 逐行取每个文字的 client rect，检查是否超出其所属滚动容器的可见区域。
// 用法： node verify-clip.mjs [port]
const PORT = Number(process.argv[2] || 9224);
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

const CASES = [
  { name: '庭审 · 竖屏 440',   url: `${BASE}/?demo=1&stage=trial`,   w: 440, h: 900,  need: 'trial' },
  { name: '判决 · 竖屏 440',   url: `${BASE}/?demo=1&stage=verdict`, w: 440, h: 900,  need: 'verdict' },
  { name: '庭审 · 窄屏 360',   url: `${BASE}/?demo=1&stage=trial`,   w: 360, h: 780,  need: 'trial' },
  { name: '判决 · 窄屏 320',   url: `${BASE}/?demo=1&stage=verdict`, w: 320, h: 700,  need: 'verdict' },
  { name: '庭审 · 桌面 1200',  url: `${BASE}/?demo=1&stage=trial`,   w: 1200, h: 900, need: 'trial' },
];

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


// 找出被容器裁掉的文字片段
const CHECK = `(() => {
  const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent;
    if (!t || !t.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    if (el.closest('.drawer')) continue;                 // 抽屉有意移出屏幕
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    // 找到最近的、会裁剪的祖先
    let clipper = null;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const acs = getComputedStyle(a);
      if (acs.overflowX !== 'visible' || acs.overflowY !== 'visible') { clipper = a; break; }
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width < 1) continue;
      const box = clipper ? clipper.getBoundingClientRect() : { left: 0, right: document.documentElement.clientWidth };
      const pad = clipper ? 1 : 0;
      if (r.right > box.right + pad) {
        bad.push({ text: t.trim().slice(0, 30),
                   clip: clipper ? (clipper.tagName.toLowerCase() + (clipper.id ? '#' + clipper.id : '') + (clipper.className ? '.' + String(clipper.className).split(' ')[0] : '')) : 'viewport',
                   overflow: +(r.right - box.right).toFixed(1) });
        break;
      }
    }
  }
  // 同一条文字被多处裁切时只报一次
  const seen = new Set(); const out = [];
  for (const b of bad) { const k = b.text + b.clip; if (!seen.has(k)) { seen.add(k); out.push(b); } }
  out.sort((a, b) => b.overflow - a.overflow);
  return { bad: out.slice(0, 12), total: out.length };
})()`;

let pass = 0, fail = 0;
for (const c of CASES) {
  await send('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: 1, mobile: c.w < 700 });
  await send('Page.navigate', { url: c.url });
  await new Promise(r => setTimeout(r, 2600));

  // 先证明"有内容可裁"。没有这一步，页面渲染成空白也会 100% 通过 ——
  // 这个坑真踩过：截图工具把 .transcript 压扁成 0 高时，
  // "无文字被裁切" 一直是绿的，其实屏幕上什么都没有。
  //
  // 注意两个页面的结构不一样：庭审是一堆 .msg，判决书的大段文字是直接
  // 挂在容器里的（.verdict-body 没有子元素），所以判决书按"段落块数 + 总字数"双重判定。
  const n = await evaluate(`(() => {
    if (${JSON.stringify(c.need)} === 'trial') {
      const t = document.getElementById('transcript');
      return { blocks: document.querySelectorAll('.transcript .msg').length,
               chars: t ? t.textContent.trim().length : 0 };
    }
    const p = document.querySelector('.verdict-paper');
    return { blocks: p ? p.querySelectorAll(':scope > *').length : 0,
             chars: p ? p.textContent.trim().length : 0 };
  })()`);
  const minBlocks = c.need === 'trial' ? 10 : 8;
  const minChars = c.need === 'trial' ? 300 : 600;
  if (!n || n.blocks < minBlocks || n.chars < minChars) {
    fail++;
    console.log(`❌ ${c.name.padEnd(16)} 内容没渲染出来（${n?.blocks} 个块 / ${n?.chars} 字，至少要 ${minBlocks} 个 / ${minChars} 字）—— 布局检查在空页面上没有意义`);
    continue;
  }

  const r = await evaluate(CHECK);
  if (r.total === 0) { pass++; console.log(`✅ ${c.name.padEnd(16)} 无文字被裁切（${n.blocks} 个块 / ${n.chars} 字）`); }
  else {
    fail++;
    console.log(`❌ ${c.name.padEnd(16)} ${r.total} 处文字被裁切`);
    for (const b of r.bad) console.log(`      +${b.overflow}px  裁切容器 ${b.clip}  「${b.text}」`);
  }
}
console.log(`\n通过 ${pass} / ${pass + fail}`);
ws.close();
process.exit(fail ? 1 : 0);

// audit-textscale.mjs — 字体缩放专项：模拟用户把系统/浏览器字号调大，看布局会不会坏
//
// 背景：页面的 101 处 font-size 全用 px，所以**不受**浏览器"默认字号"设置影响
// （那只会影响 rem/em）。真正会改变字号的是两件事：
//   ① 移动端"文字自动放大"(text autosizing / font boosting) —— 可修
//   ② 用户的**无障碍字体缩放**（安卓系统字号、浏览器文字缩放）—— 不该修，要适配
// 这个脚本测的是 ②：把所有文字按比例放大，看排版是否还能撑住。
const PORT = Number(process.argv[2] || 9224);
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

const SCALES = [1.0, 1.3, 1.5, 2.0];
const DEVICES = [
  { name: 'iPhone SE 1', w: 320, h: 568 },
  { name: 'Android 小屏', w: 360, h: 640 },
  { name: 'iPhone 14/15', w: 390, h: 844 },
  { name: 'iPhone Pro Max', w: 430, h: 932 },
];
const SCREENS = [
  { name: '首页', url: `${BASE}/?demo=1` },
  { name: '庭审', url: `${BASE}/?demo=1&stage=trial` },
  { name: '判决书', url: `${BASE}/?demo=1&stage=verdict` },
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
  if (r.result?.exceptionDetails) return { __err: String(r.result.exceptionDetails.text).slice(0, 200) };
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


/* 把页面里所有 font-size 按比例放大 —— 这就是用户调大系统字号的效果 */
const SCALE_FN = `(scale) => {
  const style = document.getElementById('__textscale') || (() => {
    const s = document.createElement('style');
    s.id = '__textscale';
    document.head.appendChild(s);
    return s;
  })();
  if (scale === 1) { style.textContent = ''; return; }
  // 收集每个元素当前的 computed font-size，写死成放大后的 px
  let css = '';
  const seen = new Set();
  for (const n of document.querySelectorAll('*')) {
    if (n.closest('.drawer')) continue;
    const cs = getComputedStyle(n);
    if (cs.display === 'none') continue;
    const fs = parseFloat(cs.fontSize);
    if (!fs) continue;
    const key = fs.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    // 用属性选择器太慢；改用自定义属性 + 通配规则不现实。
    // 这里直接给每个元素打 inline style（元素数量可控，demo 页面几百个）
  }
  const nodes = Array.from(document.querySelectorAll('*')).filter(n => !n.closest('.drawer'));
  for (const n of nodes) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none') continue;
    const fs = parseFloat(cs.fontSize);
    if (!fs) continue;
    n.style.fontSize = (fs * scale).toFixed(1) + 'px';
  }
}`;

const CHECK = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = { vw, vh, clipped: [], overflowX: document.documentElement.scrollWidth > vw + 1, over: [] };

  for (const n of document.querySelectorAll('*')) {
    if (n.closest('.drawer')) continue;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const desc = n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(' ')[0] : '');
    if (r.right > vw + 1 && cs.position !== 'fixed') {
      out.clipped.push({ el: desc, over: +(r.right - vw).toFixed(1), text: (n.textContent||'').trim().slice(0, 22) });
    }
    // 文字被容器裁掉。
    // 注意：只查**纵向**溢出。横向 scrollWidth 会被屏幕外的抽屉
    // （translateX(-102%)）污染，#app/.screen 的 overflow:hidden 正是为了裁掉它们，
    // 那是设计如此，跟字号无关。
    const isClipRoot = n.id === 'app' || n.classList.contains('screen');
    if (!isClipRoot && cs.overflow === 'hidden' && n.scrollHeight > n.clientHeight + 2) {
      out.over.push({ el: desc, sh: n.scrollHeight, ch: n.clientHeight, text: (n.textContent||'').trim().slice(0, 22) });
    }
  }
  const uniq = (a,k) => { const s=new Set(); return a.filter(x=>{const key=x[k||'el']; if(s.has(key))return false; s.add(key); return true;}); };
  out.clipped = uniq(out.clipped).slice(0, 6);
  out.over = uniq(out.over).slice(0, 6);
  // 底部输入栏是否**能按到**。
  // 字号放大后底部栏可能被顶出视口，这不算坏 —— 只要整屏能滚下去把它露出来就行。
  // 所以先把滚动容器拉到底再看。
  const scroller = document.querySelector('.screen.active');
  const scrollable = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const foot = document.querySelector('.trial-foot, .verdict-foot-bar');
  out.scrollable = scrollable;
  out.footVisible = foot ? (() => { const r = foot.getBoundingClientRect(); return r.bottom <= vh + 1 && r.top >= 0; })() : null;
  if (scroller) scroller.scrollTop = 0;
  return out;
})()`;

let problems = 0;
let neededScroll = 0;
let total = 0;
console.log('字体缩放适应性测试（模拟用户把系统字号调大）');
console.log('页面的字号全用 px，所以浏览器"默认字号"改不动它；\n这一项测的是用户的无障碍字体缩放会不会撑坏排版。\n');

for (const sc of SCREENS) {
  for (const d of DEVICES) {
    for (const scale of SCALES) {
      await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: 1, mobile: true });
      await send('Page.navigate', { url: sc.url });
      await new Promise(r => setTimeout(r, 1800));
      await evaluate(`(${SCALE_FN})(${scale})`);
      await new Promise(r => setTimeout(r, 250));
      const a = await evaluate(CHECK);
      if (!a || a.__err) { console.log(`  ⚠ ${sc.name} ${scale}x: ${a?.__err}`); continue; }
      total++;
      if (a.scrollable > 0) neededScroll++;

      const bad = [];
      if (a.overflowX) bad.push('横向溢出');
      if (a.clipped.length) bad.push(`${a.clipped.length} 处被切`);
      if (a.over.length) bad.push(`${a.over.length} 处内容溢出`);
      if (a.footVisible === false) bad.push('底部栏被挤出视口');

      if (bad.length) {
        problems++;
        console.log(`  ❌ ${sc.name.padEnd(4)} @ ${d.name.padEnd(15)} ${String(d.w).padStart(3)}px  ${scale}x  ${bad.join(' | ')}`);
        for (const c of a.clipped) console.log(`        ✂ +${c.over}px  ${c.el}  「${c.text}」`);
        for (const o of a.over) console.log(`        ⤵ 内容溢出  ${o.el}  (${o.sh}>${o.ch})  「${o.text}」`);
      }
      // 恢复 inline 样式：重新导航即可，不用手动清
    }
  }
}

console.log('\n' + '═'.repeat(66));
console.log(`有问题的组合：${problems} / ${total}`);
console.log(`其中 ${neededScroll} 个组合靠"整屏可滚"兜底（字号大到装不下，滚一下就能按到按钮）`);
ws.close();
process.exit(problems ? 1 : 0);

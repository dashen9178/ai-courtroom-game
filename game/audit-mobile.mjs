// audit-mobile.mjs — 移动端实测审计（不调 AI，全部用 ?demo=1）
// 检查：视口溢出 / 触控目标尺寸 / 字号 / 控制台报错 / 关键元素可见性 / 横屏 / 小屏
const PORT = Number(process.argv[2] || 9224);
const BASE = process.env.BASE || 'http://127.0.0.1:8790';

/* 真实机型宽度（CSS px） */
const DEVICES = [
  { name: 'iPhone SE 1', w: 320, h: 568 },
  { name: 'iPhone SE 2/3', w: 375, h: 667 },
  { name: 'iPhone 12/13 mini', w: 375, h: 812 },
  { name: 'Android 小屏', w: 360, h: 640 },
  { name: 'iPhone 14/15', w: 390, h: 844 },
  { name: 'iPhone Plus', w: 414, h: 896 },
  { name: 'iPhone Pro Max', w: 430, h: 932 },
  { name: '横屏', w: 844, h: 390 },
  { name: 'iPad', w: 768, h: 1024 },
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
const consoleErrors = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    const txt = (m.params.args || []).map(a => a.value || a.description || '').join(' ');
    consoleErrors.push(m.params.type + ': ' + txt.slice(0, 160));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  }
});
const send = (method, params) => new Promise(res => {
  const myId = ++id; pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
});
await new Promise(r => ws.addEventListener('open', r));

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    const ed = r.result.exceptionDetails;
    const lines = String(expr).split('\n');
    const ln = ed.lineNumber ?? 0;
    const src = ln >= 0 && ln < lines.length ? lines[ln].trim().slice(0, 120) : '';
    return { __err: `${ed.exception?.description || ed.text}  @L${ln}:${ed.columnNumber}  ${src}` };
  }
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

await send('Log.enable');

/* 页面内执行的全面检查 */
const AUDIT = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = {
    vw, vh,
    docScrollW: document.documentElement.scrollWidth,
    docScrollH: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth > vw + 1,
    overflowY: document.documentElement.scrollHeight > vh + 1,

    // 右侧被切掉的元素（排除有意移出屏幕的抽屉）
    clippedRight: [],
    // 触控目标过小
    smallTaps: [],
    // 字号过小
    tinyText: [],
    // 固定元素是否用了安全区
    fixedNoSafeArea: [],
    // 被遮挡的可点元素（中心点实际命中别人）
    covered: [],
    // 文本被 ellipsis 截断
    ellipsised: [],
  };

  const vis = (n) => {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  for (const n of document.querySelectorAll('*')) {
    if (n.closest('.drawer')) continue;              // 抽屉有意移出屏幕
    if (!vis(n)) continue;
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    const desc = n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(' ')[0] : '');

    // 横向溢出
    if (r.right > vw + 1 && cs.position !== 'fixed') {
      out.clippedRight.push({ el: desc, right: Math.round(r.right), over: +(r.right - vw).toFixed(1), text: (n.textContent||'').trim().slice(0, 26) });
    }

    // 触控目标：可点元素
    const clickable = n.matches('button, a, textarea, input, select, [role=button], .strat-card, .status-summary, .mode-btn, .think-opt, .ghost-btn, .primary-btn, .verdict-btn, .icon-btn, .wide-btn');
    if (clickable) {
      if (r.height < 44 || r.width < 44) {
        out.smallTaps.push({ el: desc, w: Math.round(r.width), h: Math.round(r.height), text: (n.textContent||'').trim().slice(0, 20) });
      }
      // 中心点遮挡检测
      const cx = Math.min(Math.max(r.left + r.width/2, 1), vw-1);
      const cy = Math.min(Math.max(r.top + r.height/2, 1), vh-1);
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== n && !n.contains(hit) && !hit.contains(n)) {
        out.covered.push({ el: desc, by: hit.tagName.toLowerCase() + (hit.id ? '#'+hit.id : '') + (hit.className ? '.'+String(hit.className).split(' ')[0] : '') });
      }
    }

    // 字号过小
    const fs = parseFloat(cs.fontSize);
    const hasText = n.children.length === 0 && (n.textContent||'').trim().length > 0;
    if (hasText && fs < 11) {
      out.tinyText.push({ el: desc, fs, text: (n.textContent||'').trim().slice(0, 20) });
    }
    // 输入框字号 < 16 会触发 iOS 自动放大
    if (n.matches('textarea, input[type=text]') && fs < 16) {
      out.tinyText.push({ el: desc, fs, iosZoom: true, text: '输入框会触发 iOS 自动放大' });
    }

    // ellipsis 截断
    if (cs.textOverflow === 'ellipsis' && n.scrollWidth > n.clientWidth + 1) {
      out.ellipsised.push({ el: desc, scrollW: n.scrollWidth, clientW: n.clientWidth, text: (n.textContent||'').trim().slice(0, 30) });
    }

    // 贴底元素的安全区检查在循环外统一做（不能查 computed style）
  }

  // 安全区：**不能**查 computed style。两个原因：
  //   ① 桌面端/无刘海设备 env(safe-area-inset-*) 一律解析成 0；
  //   ② 媒体查询会再覆盖一次 padding（比如窄屏下 .trial-foot 缩到 12px）。
  // 所以只能直接读样式表里的声明，看源码到底写没写。
  // （这段以前写成 /env\(safe-area/，在模板字符串里 \( 被当成转义序列吃掉，
  //   变成 /env(safe-area/ → SyntaxError，整个审计脚本一直是坏的。）
  const needSafe = ['.modal-scrim', '.trial-foot', '.verdict-foot-bar', '.drawer', '.toast'];
  const declared = new Set();
  const walkRules = (rs) => {
    for (const r of rs) {
      if (r.cssRules && r.cssRules.length) { walkRules(r.cssRules); continue; }  // @media 里面也要翻
      if (!r.selectorText) continue;
      if (!String(r.style && r.style.cssText || '').includes('safe-area')) continue;
      for (const s of r.selectorText.split(',')) declared.add(s.trim());
    }
  };
  for (const sheet of document.styleSheets) {
    try { walkRules(sheet.cssRules); } catch { /* 跨域样式表读不到，跳过 */ }
  }
  out.fixedNoSafeArea = needSafe.filter(sel => !declared.has(sel)).map(sel => ({ el: sel, paddingBottom: '(源码里没写 safe-area)' }));

  // 去重
  const uniq = (arr, k) => { const s = new Set(); return arr.filter(x => { const key = x[k||'el']; if (s.has(key)) return false; s.add(key); return true; }); };
  out.clippedRight = uniq(out.clippedRight).slice(0, 10);
  out.smallTaps = uniq(out.smallTaps).slice(0, 14);
  out.tinyText = uniq(out.tinyText).slice(0, 12);
  out.fixedNoSafeArea = uniq(out.fixedNoSafeArea).slice(0, 8);
  out.covered = uniq(out.covered, 'el').slice(0, 8);
  out.ellipsised = uniq(out.ellipsised).slice(0, 8);

  return out;
})()`;

let problems = 0;
const report = [];

for (const sc of SCREENS) {
  for (const d of DEVICES) {
    await send('Emulation.setDeviceMetricsOverride', { width: d.w, height: d.h, deviceScaleFactor: 1, mobile: d.w < 700 });
    await send('Page.navigate', { url: sc.url });
    await new Promise(r => setTimeout(r, 2200));

    const a = await evaluate(AUDIT);
    if (a && a.__err) { console.log(`  ⚠ ${sc.name} @ ${d.name}: 审计脚本报错 ${String(a.__err).slice(0, 260)}`); continue; }

    const issues = [];
    if (a.overflowX) issues.push(`横向溢出 doc=${a.docScrollW}>${a.vw}`);
    if (a.clippedRight.length) issues.push(`${a.clippedRight.length} 个元素右侧被切`);
    if (a.smallTaps.length) issues.push(`${a.smallTaps.length} 个触控目标 <44px`);
    if (a.tinyText.length) issues.push(`${a.tinyText.length} 处字号过小`);
    if (a.covered.length) issues.push(`${a.covered.length} 个可点元素被遮挡`);
    if (a.ellipsised.length) issues.push(`${a.ellipsised.length} 处文本被省略号截断`);
    if (d.w < 700 && a.fixedNoSafeArea.length) issues.push(`${a.fixedNoSafeArea.length} 个贴底元素无安全区`);

    const tag = issues.length ? '❌' : '✅';
    if (issues.length) problems++;
    console.log(`${tag} ${sc.name.padEnd(4)} @ ${d.name.padEnd(18)} ${d.w}x${d.h}  ${issues.length ? issues.join(' | ') : '正常'}`);

    if (issues.length) {
      report.push({ screen: sc.name, device: d.name, size: `${d.w}x${d.h}`, detail: a });
      for (const c of a.clippedRight) console.log(`      ✂ 右侧被切 +${c.over}px  ${c.el}  「${c.text}」`);
      for (const t of a.smallTaps) console.log(`      👆 ${t.w}×${t.h}  ${t.el}  「${t.text}」`);
      for (const t of a.tinyText) console.log(`      🔤 ${t.fs}px  ${t.el}  ${t.iosZoom ? '（iOS 会自动放大）' : '「'+t.text+'」'}`);
      for (const t of a.covered) console.log(`      🚫 被遮挡  ${t.el}  ←  ${t.by}`);
      for (const t of a.ellipsised) console.log(`      … 省略号截断  ${t.el}  (${t.scrollW}>${t.clientW})  「${t.text}」`);
      for (const t of a.fixedNoSafeArea) console.log(`      📱 贴底无安全区  ${t.el}  bottom=${t.bottom} padding-bottom=${t.paddingBottom}`);
    }
  }
}

console.log('\n' + '═'.repeat(70));
console.log(`有问题的「屏幕 × 机型」组合：${problems} / ${SCREENS.length * DEVICES.length}`);
if (consoleErrors.length) {
  console.log('\n控制台报错/警告：');
  for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.log('  ' + e);
} else {
  console.log('\n控制台：无报错');
}
ws.close();
process.exit(problems ? 1 : 0);

// verify-ui.mjs — 真 UI 交互测试：在无头浏览器里填输入框、点「发言」，等检察官回话
// 会真的调用一次 AI（约 2-5 秒）。
// 用法： node verify-ui.mjs [cdpPort]
const PORT = Number(process.argv[2] || 9222);
const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const DEFENSE = '法官大人，我认罪。但我要求把我的加班记录也列为证据——那二十五分钟是我拿命换的。';

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

console.log('① 打开首页并真实立案（调 AI）…');
await send('Page.navigate', { url: BASE + '/' });
await sleep(2500);

// 点「普通程序」
const clicked = await evaluate(`(() => {
  const b = document.querySelector('.mode-btn[data-mode="free"]');
  if (!b) return 'NO_BUTTON';
  b.click();
  return 'CLICKED';
})()`);
console.log('   点击普通程序：' + clicked);
if (clicked !== 'CLICKED') { console.error('❌ 找不到模式按钮'); process.exit(1); }

// 等庭审屏出现
let ready = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const st = await evaluate(`(() => {
    const t = document.getElementById('screen-trial');
    return { active: t.classList.contains('active'),
             msgs: document.querySelectorAll('#transcript .msg').length,
             case: document.getElementById('t-case').textContent,
             charge: document.getElementById('t-charge').textContent,
             verdictDisabled: document.getElementById('btn-verdict').disabled };
  })()`);
  if (i % 5 === 0) console.log(`   等待… ${JSON.stringify(st)}`);
  if (st.active && st.msgs >= 2) { ready = true; console.log('   立案完成：' + st.case + ' / ' + st.charge); break; }
}
if (!ready) { console.error('❌ 立案超时'); process.exit(1); }

// 等打字机把开庭词打完（否则 focus 会被打字器抢走）
for (let i = 0; i < 40; i++) {
  const typing = await evaluate(`document.querySelectorAll('#transcript .typing').length`);
  if (typing === 0) break;
  await sleep(400);
}
const idle = await evaluate(`document.querySelectorAll('#transcript .typing').length`);
console.log('   打字机已停：' + (idle === 0 ? '是' : '否'));

console.log('\n② 在输入框里输入辩护词并按 Enter');
// 先只填字，检查按钮状态
const filled = await evaluate(`(() => {
  const ta = document.getElementById('say');
  ta.value = ${JSON.stringify(DEFENSE)};
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { len: ta.value.length, sayDisabled: document.getElementById('btn-say').disabled,
           hint: document.getElementById('foot-hint').textContent };
})()`);
console.log('   填字后 ' + JSON.stringify(filled));
if (filled.len === 0) { console.error('❌ 输入框没拿到文字'); process.exit(1); }
if (filled.sayDisabled) { console.error('❌ 有文字时发言按钮仍是禁用状态'); process.exit(1); }
if (filled.hint === '写一句辩护词') { console.error('❌ 提示文案没跟着更新'); process.exit(1); }

// 清空时应重新禁用
const cleared = await evaluate(`(() => {
  const ta = document.getElementById('say');
  ta.value = '';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { sayDisabled: document.getElementById('btn-say').disabled };
})()`);
console.log('   清空后 ' + JSON.stringify(cleared));
if (!cleared.sayDisabled) { console.error('❌ 空输入时发言按钮应禁用'); process.exit(1); }

// 重新填上并按 Enter 提交
const typed = await evaluate(`(() => {
  const ta = document.getElementById('say');
  ta.value = ${JSON.stringify(DEFENSE)};
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  return { value: ta.value.length, sayDisabled: document.getElementById('btn-say').disabled };
})()`);
console.log('   提交时 ' + JSON.stringify(typed));

const before = await evaluate(`document.querySelectorAll('#transcript .msg').length`);
console.log('   发言前消息数 = ' + before);

console.log('\n③ 等待检察官回击…');
let after = before;
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  after = await evaluate(`(() => ({
    n: document.querySelectorAll('#transcript .msg').length,
    typing: document.querySelectorAll('#transcript .typing').length,
    lastText: (document.querySelector('#transcript .msg:last-child .bubble')||{}).textContent || '',
  }))()`);
  if (after.n > before && after.typing === 0 && String(after.lastText).trim()) break;
  if (i % 6 === 0) console.log(`   … 消息数 ${after.n} 打字中 ${after.typing}`);
}
after = await evaluate(`(() => ({
  n: document.querySelectorAll('#transcript .msg').length,
  quotes: document.querySelectorAll('#transcript .quote-echo').length,
  attitudes: document.querySelectorAll('#transcript .attitude').length,
  verdictDisabled: document.getElementById('btn-verdict').disabled,
  hint: document.getElementById('foot-hint').textContent,
}))()`);

console.log('\n④ 结果');
console.log('   ' + JSON.stringify(after, null, 2).replace(/\n/g, '\n   '));

const ok = after.n > before && after.quotes >= 1 && after.verdictDisabled === false;
console.log(ok ? '\n✅ UI 交互链路正常（发言 → 检察官回击 → 引用回显 → 宣判按钮解锁）'
               : '\n❌ UI 交互异常');

// 顺手把最终 DOM 文本抓出来，供人工核对
const dump = await evaluate(`Array.from(document.querySelectorAll('#transcript .msg')).map(m => {
  const role = m.className.replace('msg ','');
  const q = m.querySelector('.quote-echo');
  return role + ' | ' + (m.querySelector('.bubble')||{}).textContent + (q ? '\\n      ↳ ' + q.textContent : '');
}).join('\\n')`);
console.log('\n── 庭审记录 ──\n' + dump);

ws.close();
process.exit(ok ? 0 : 1);

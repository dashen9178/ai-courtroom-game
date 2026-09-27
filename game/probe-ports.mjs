// probe-ports.mjs — 探测出站端口连通性，为公网方案选型
// 443 已确认可用（我们调 api.deepseek.com 就是走 443）
import net from 'node:net';

const TARGETS = [
  { name: 'Cloudflare 边缘 (cloudflared 用)', host: '198.41.200.233', port: 7844 },
  { name: 'localhost.run SSH', host: 'localhost.run', port: 22 },
  { name: 'localhost.run SSH/443', host: 'localhost.run', port: 443 },
  { name: 'serveo.net SSH', host: 'serveo.net', port: 22 },
  { name: 'ngrok 控制面', host: 'connect.ngrok-agent.com', port: 443 },
  { name: 'ngrok 隧道端口', host: 'connect.ngrok-agent.com', port: 443 },
  { name: 'bore.pub', host: 'bore.pub', port: 7835 },
  { name: 'Cloudflare API (对照，应通)', host: 'api.cloudflare.com', port: 443 },
  { name: 'DeepSeek API (对照，应通)', host: 'api.deepseek.com', port: 443 },
];

function probe(host, port, timeout = 8000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = new net.Socket();
    let settled = false;
    const done = (ok, note) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* 忽略 */ }
      resolve({ ok, ms: Date.now() - t0, note: note || '' });
    };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false, '超时'));
    s.once('error', (e) => done(false, e.code || e.message));
    try { s.connect(port, host); } catch (e) { done(false, String(e.message)); }
  });
}

console.log('出站端口探测（判断公网方案能不能用）');
console.log('═'.repeat(64));
const results = [];
for (const t of TARGETS) {
  const r = await probe(t.host, t.port);
  results.push({ ...t, ...r });
  const flag = r.ok ? '✅ 通' : '❌ 不通';
  console.log(`  ${flag}  ${String(t.port).padStart(5)}  ${t.name.padEnd(30)} ${r.ok ? r.ms + 'ms' : r.note}`);
}

console.log('\n' + '═'.repeat(64));
const ok = results.filter(r => r.ok).map(r => r.name);
console.log('可用：' + (ok.length ? ok.join(' / ') : '（无）'));

const sshOk = results.find(r => r.name.includes('localhost.run SSH') && r.ok);
const serveoOk = results.find(r => r.name.includes('serveo') && r.ok);
const ngrokOk = results.find(r => r.name.includes('ngrok') && r.ok);
console.log('\n结论：');
if (sshOk || serveoOk) console.log('  · SSH 隧道（localhost.run / serveo）可用 —— 无需注册，走 22/443');
else console.log('  · SSH 隧道不可用');
if (ngrokOk) console.log('  · ngrok 控制面可用 —— 需要注册拿 authtoken');
console.log(`  · cloudflared 的 7844：${results[0].ok ? '这次通了（但不稳定）' : '仍然不通'}`);

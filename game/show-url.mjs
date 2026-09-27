// show-url.mjs — 打印所有可用访问方式，并实测哪个真能用（纯读取 + 本地探测，零成本）
//
// 为什么同时给局域网地址：这台机器所在的网络干扰 Cloudflare 边缘的 7844 端口，
// 快速隧道会反复掉线（访客看到 Error 1033 / 530）。同一个 WiFi 下走局域网最稳。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of (list || [])) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      // 100.64.0.0/10 是 CGNAT，Tailscale 用的就是这段。
      // 它对本机有效，但手机连不上，列出来只会让人困惑。
      const [a, b] = ni.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) continue;
      if (ni.address.startsWith('169.254.')) continue;   // 链路本地
      out.push(ni.address);
    }
  }
  return out;
}

/** 从文件内容里认出任意一种隧道域名 */
function pickUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9.-]+\.(?:trycloudflare\.com|ngrok-free\.dev|ngrok-free\.app|ngrok\.io|ts\.net)/i);
  return m ? m[0] : null;
}

const PORT = process.env.PORT || 8790;

async function probe(url) {
  try {
    const r = await fetch(url + '/api/health', { signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    if (/<!doctype|<html/i.test(body)) {
      const code = (body.match(/Error\s*(\d{3,4})/i) || [])[1];
      return { ok: false, why: `隧道断了，Cloudflare 返回错误页${code ? '（Error ' + code + '）' : ''}` };
    }
    const d = JSON.parse(body);
    return { ok: !!d.ok, data: d };
  } catch (e) {
    return { ok: false, why: String(e.message).slice(0, 80) };
  }
}

console.log('');
console.log('  ══════════════════════════════════════════════════════════');
console.log('   可用访问方式');
console.log('  ══════════════════════════════════════════════════════════');

/* ① 局域网：同一个 WiFi 下最稳，零延迟 */
const ips = lanIps();
console.log('');
console.log('   ① 局域网（手机连同一个 WiFi 时用这个，最稳最快）');
if (!ips.length) {
  console.log('      ⚠ 没找到局域网地址（可能没连网线/WiFi）');
} else {
  for (const ip of ips) {
    const url = `http://${ip}:${PORT}`;
    const r = await probe(url);
    console.log(`      ${r.ok ? '✅' : '❌'} ${url}`);
    if (!r.ok) console.log(`         ${r.why}`);
  }
  console.log('      · 首次访问时若弹出防火墙询问，点「允许」');
  console.log('      · 不花额度的界面预览：在上面链接后加 /?demo=1');
}

/* ② 公网隧道（可能被网络干扰） */
const file = path.join(root, 'public-url.txt');
console.log('');
console.log('   ② 公网隧道（不在同一个 WiFi 时用；这个网络可能不稳）');
if (!fs.existsSync(file)) {
  console.log('      （还没有公网链接，先跑 register-service.ps1）');
} else {
  const txt = fs.readFileSync(file, 'utf8');
  const url = pickUrl(txt);
  const when = (txt.match(/generated:\s*(.+)/) || [])[1] || '未知';
  if (!url) {
    console.log('      （文件里没找到链接）');
  } else {
    const r = await probe(url);
    const kind = /ts\.net$/i.test(url) ? 'Tailscale Funnel（永久域名，无提示页）'
      : /ngrok/i.test(url) ? 'ngrok（首次访问需点一次「Visit Site」）'
      : 'Cloudflare 快速隧道（域名会变）';
    console.log(`      ${r.ok ? '✅' : '❌'} ${url}`);
    console.log(`         方式：${kind}`);
    console.log(`         生成于 ${when}`);
    if (!r.ok) {
      console.log(`         ${r.why}`);
      console.log('         排查： Get-ScheduledTask -TaskName GangjingCourt');
      console.log('               看日志 ' + path.join(root, 'logs', 'supervisor.log'));
    }
  }
}

console.log('');
console.log('  ══════════════════════════════════════════════════════════');
console.log('   管理： Get-ScheduledTask -TaskName GangjingCourt');
console.log('   日志： logs\\supervisor.log  logs\\tunnel.err.log');
console.log('  ══════════════════════════════════════════════════════════');
console.log('');

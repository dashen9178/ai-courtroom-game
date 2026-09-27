// tunnel.mjs — 一键把「杠精法庭」发到公网（临时隧道）
//
// 同时做三件事：
//   ① 起本地服务（带限流 + 每日配额）
//   ② 起 cloudflared 快速隧道，从日志里抓出公网域名
//   ③ 把链接打印出来并复制到剪贴板，方便直接发给别人
//
// 用法： node tunnel.mjs
// 停止： Ctrl+C（会自动收掉服务与隧道两个子进程）
//
// 注意：这是临时隧道。域名每次启动都会变，且**要求这台电脑一直开着**。
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);

/* ── 找 cloudflared ─────────────────────────────────────── */

function findCloudflared() {
  const cands = [
    process.env.CLOUDFLARED,
    path.join(__dirname, '..', '..', 'tools', 'cloudflared.exe'),   // <项目的上一级目录>\tools\
    path.join(__dirname, '..', 'tools', 'cloudflared.exe'),
    path.join(__dirname, 'cloudflared.exe'),
    'cloudflared',
  ].filter(Boolean);
  for (const c of cands) {
    if (c === 'cloudflared') return c;                 // 交给 PATH 去找
    try { if (fs.existsSync(c)) return c; } catch { /* 继续 */ }
  }
  return null;
}

const cf = findCloudflared();
if (!cf) {
  console.error('\n  ❌ 找不到 cloudflared。请用 CLOUDFLARED 环境变量指定它的完整路径，');
  console.error('     或从 https://github.com/cloudflare/cloudflared/releases 下载一个放到项目目录。\n');
  process.exit(1);
}

/* ── 启动本地服务 ───────────────────────────────────────── */

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  PUBLIC_MODE: process.env.PUBLIC_MODE || '1',        // 对外默认开限流，别把额度裸奔
  RATE_MAX_REQ: process.env.RATE_MAX_REQ || '20',
  QUOTA_MAX_CALLS: process.env.QUOTA_MAX_CALLS || '300',
};

console.log('');
console.log('  杠精法庭 · 公网发布');
console.log('  ─────────────────────────────────────────────');
console.log(`  本地端口      ${PORT}`);
console.log(`  单 IP 限流    ${serverEnv.RATE_MAX_REQ} 次/分钟`);
console.log(`  每日总配额    ${serverEnv.QUOTA_MAX_CALLS} 次 AI 调用`);
console.log('  ─────────────────────────────────────────────');
console.log('');

const server = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
  cwd: __dirname, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.stdout.write(prefix('服务', d)));
server.stderr.on('data', d => process.stdout.write(prefix('服务', d)));
server.on('exit', (code) => {
  if (!stopping) { console.error(`\n  ⚠ 本地服务退出了（code ${code}），隧道已无意义，一起停。\n`); shutdown(); }
});

function prefix(tag, buf) {
  const color = tag === '服务' ? '\x1b[36m' : '\x1b[35m';
  return String(buf).split('\n').filter(l => l.trim())
    .map(l => `${color}[${tag}]\x1b[0m ${l}`).join('\n') + '\n';
}

/* ── 启动隧道并抓域名 ───────────────────────────────────── */

let url = null;
let stopping = false;

const tunnel = spawn(cf, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
  cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
});

const onTunnelData = (buf) => {
  const s = String(buf);
  // 只把关键行转出去，cloudflared 的日志很吵
  if (!url) {
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { url = m[0]; onUrl(url); }
  }
  if (/ERR|error=/i.test(s) && !/no-autoupdate/i.test(s)) process.stdout.write(prefix('隧道', s));
};
tunnel.stdout.on('data', onTunnelData);
tunnel.stderr.on('data', onTunnelData);
tunnel.on('exit', (code) => {
  if (!stopping) { console.error(`\n  ⚠ 隧道断开（code ${code}）。重启本脚本会得到新域名。\n`); shutdown(); }
});

function onUrl(u) {
  console.log('');
  console.log('  \x1b[32m════════════════════════════════════════════════════════\x1b[0m');
  console.log('  \x1b[32m  公网链接已就绪，可以直接发给别人：\x1b[0m');
  console.log('');
  console.log(`  \x1b[1m\x1b[32m  ${u}\x1b[0m`);
  console.log('');
  console.log('  \x1b[32m════════════════════════════════════════════════════════\x1b[0m');
  console.log('');
  console.log('  · 手机浏览器直接打开即可玩，界面是竖屏优先的');
  console.log('  · 想只看界面不花额度：链接后面加 /?demo=1');
  console.log('  · 这个域名每次重启都会变，且需要这台电脑保持开机');
  console.log('  · 按 Ctrl+C 停止服务并收回公网访问');
  console.log('');

  // 复制到剪贴板（失败不影响运行）
  try {
    const p = spawn('clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(u);
    console.log('  （链接已复制到剪贴板）\n');
  } catch { /* 忽略 */ }

  // 顺手写一份到文件，方便回头找
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'last-public-url.txt'),
      `${u}\n生成时间：${new Date().toLocaleString('zh-CN')}\n（域名每次重启都会变）\n`, 'utf8');
  } catch { /* 忽略 */ }
}

/* ── 退出处理 ───────────────────────────────────────────── */

function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n  正在停止服务与隧道…');
  for (const p of [tunnel, server]) {
    try { p.kill(); } catch { /* 忽略 */ }
  }
  setTimeout(() => {
    console.log('  已停止。公网链接已失效。\n');
    process.exit(0);
  }, 700);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

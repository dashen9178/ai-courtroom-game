// server.mjs — 杠精法庭 · 本地服务
// 运行：node server.mjs    然后打开 http://127.0.0.1:8790
// 零第三方依赖（Node 22+ 内置 fetch）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, chatStream, peekJsonStringField, resolveTarget, targetInfo } from './llm.mjs';
import {
  caseSystemPrompt, caseUserPrompt,
  daSystemPrompt, daUserPrompt,
  verdictSystemPrompt, verdictUserPrompt,
  judgePortraitUserPrompt,
  appealUserPrompt, exhibitUserPrompt,
  APPEAL_STATIC, EXHIBIT_STATIC,
} from './prompts.mjs';
import { DEMO_CASE, DEMO_TRANSCRIPT, DEMO_RESULT, DEMO_PORTRAIT } from './demo.mjs';
import {
  ensureQuote, fixJudgeName, mergeBothLedgers, markRecalled, splitJudgeSign,
  mergeClerkNotes, normalizeJudgeAction, clampMood, winChance, moodLabel, toIndex,
  evidenceState, closingCoverage, appealChance, getStrategy, STRATEGIES,
  escapeRawControlChars, extractJson, pickList, CASE_FALLBACKS,
} from './guards.mjs';
import { thinkFor, recordUsage, usageSummary, THINK_LEVELS, SEVERITY_LEVELS, severityFor } from './config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8790);
/**
 * 监听地址。
 * 默认 0.0.0.0：这样同一个 WiFi 下的手机可以直接用 http://<内网IP>:8790 打开，
 * 完全不需要隧道 —— 在 cloudflared 被网络干扰的机器上这是唯一稳的对外方式。
 * 想只允许本机访问就设 BIND=127.0.0.1。
 */
const BIND = process.env.BIND || '0.0.0.0';

/** 列出局域网 IPv4，启动时打印出来方便手机输入 */
function lanAddresses() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of (list || [])) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        // 跳过 Tailscale/CGNAT 的 100.64.0.0/10 与链路本地地址：
        // 手机连不上这些，列出来只会让人困惑
        const [a, b] = ni.address.split('.').map(Number);
        if (a === 100 && b >= 64 && b <= 127) continue;
        if (ni.address.startsWith('169.254.')) continue;
        out.push(ni.address);
      }
    }
  } catch { /* 忽略 */ }
  return out;
}
const QUICK_ROUNDS = 5;          // 速审模式：5 次发言后自动进入宣判

/* ── 公网模式：只留一道"防刷爆" ──────────────────────────────
 * 以前还有一道「全站每天 300 场」的配额，已按需求去掉 —— 不限制场次。
 * 保留下来的单 IP 限流**不是配额**，是防刷爆：
 * 正常玩家一局最多打十几次调用，30 次/分钟根本碰不到；
 * 而一个写死的循环脚本会在第一分钟就被挡住，不会把 API 余额刷光、
 * 也不会同时压几百个模型请求把服务打挂。
 * 想彻底关掉就把 RATE_MAX_REQ 设成一个很大的数。
 */
const PUBLIC_MODE = process.env.PUBLIC_MODE === '1';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQ = Number(process.env.RATE_MAX_REQ || 30);

const rateBuckets = new Map();   // ip -> number[]（时间戳）

/**
 * 取客户端 IP。
 *
 * 默认**只信 socket 地址**：因为服务直接对外监听（BIND=0.0.0.0），
 * 前面并没有可信代理，任何人都能伪造 X-Forwarded-For 让每个请求
 * 看起来来自不同 IP，单 IP 限流(RATE_MAX_REQ)就形同虚设。
 * 只有在确实挂了隧道时才用 TRUST_PROXY=1 打开 XFF，且取**最后一跳**
 * （最靠近本机的那一跳才是可信的，第一跳是客户端可伪造的）。
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/** 只做限流，不做配额。返回 null 表示放行，否则返回 { code, error } */
function checkRateLimit(req) {
  if (!PUBLIC_MODE) return null;

  const ip = clientIp(req);
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_REQ) {
    const wait = Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000);
    return { code: 429, error: `操作太快了，请等 ${wait} 秒再试。` };
  }
  hits.push(now);
  rateBuckets.set(ip, hits);

  // 顺手清理过期桶，避免内存无限增长
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (!v.some(t => now - t < RATE_WINDOW_MS)) rateBuckets.delete(k);
  }
  return null;
}

/* ── 会话存储（内存，重启即清空）───────────────────────── */

const sessions = new Map();

function newSession({ intensity = 'free', difficulty, severity } = {}) {
  const sid = crypto.randomUUID();
  const s = {
    sid,
    intensity: intensity === 'quick' ? 'quick' : 'free',
    // 两个独立的旋钮，都是**按局**生效，立案时定下来、整局沿用：
    //   think    深度思考（改请求参数：AI 要不要先想，影响速度）
    //   severity 对抗强度（改提示词：AI 打得多凶）
    think: THINK_LEVELS[difficulty] ? difficulty : thinkFor().level,
    severity: severityFor(severity),
    case: null,
    transcript: [],     // { role, content, at }
    grudges: [],        // 检察官的小本本：罪证账
    judgeLedger: [],    // 法官的扣分表：态度账
    clerkNotes: [],     // 书记员：客观矛盾记录（不站队）
    strategyLog: [],    // 被告用过的策略卡
    strategy: null,     // 本轮选中的策略（用完即清）
    credibility: 0,     // 本庭对被告的信任度 -6..+6
    judgeActions: [],   // 法官用过的主动动作
    exhibits: [],       // 被告申请调取过的证据
    closing: null,      // 结案陈词
    appealNote: null,   // 上诉理由
    round: 0,           // 已完成交锋轮数
    createdAt: Date.now(),
  };
  sessions.set(sid, s);
  return s;
}

function getSession(sid) {
  const s = sessions.get(sid);
  if (!s) { const e = new Error('会话不存在或服务已重启，请重新立案'); e.code = 404; throw e; }
  s.lastActiveAt = Date.now();
  return s;
}

/**
 * 会话级串行闸门。
 *
 * 为什么必须有：每个 AI 流程都是「先改 session → await 模型 → 再接着改」。
 * 两个请求共用同一个 sid 并发跑时（两个标签页、脚本重放、用户狂点），
 * 两边会读到同一个 round、互相污染 transcript，结果检察官可能引用到
 * 另一路请求的发言 —— 而这个游戏最核心的契约恰恰是
 * "检察官引用的是你上一轮真的说过的话"。宁可返回 409，也不能串。
 *
 * @returns release 函数，调用方必须在 finally 里调用
 */
function acquireSession(s) {
  if (s.busy) {
    const e = new Error('本庭正在处理上一步，请稍候');
    e.code = 409;
    throw e;
  }
  s.busy = true;
  return () => { s.busy = false; };
}

/**
 * 会话闸门的安全封装：自己 acquire、自己 finally release，
 * 调用方**拿不到** release 函数，也就没有写错作用域的机会。
 *
 * 为什么要这个：`const release = acquireSession(s)` 如果写在 if 块里，
 * 块外再引用就是 ReferenceError。这个坑在这个文件里犯过两次 ——
 * 一次是误用 streamJson 的内部变量 streamErr，一次是 /api/say 的
 * 非流式分支直接 500（`release is not defined`，真链路测试才抓到）。
 * 与其反复提醒自己"别忘了作用域"，不如把这个模式封起来。
 */
async function withSession(s, fn) {
  const release = acquireSession(s);
  try { return await fn(); } finally { release(); }
}

/** 定时清理：会话只增不删会漏内存，同时给一个硬上限 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;   // 2 小时无活动
const SESSION_MAX = 500;
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - (s.lastActiveAt || s.createdAt || 0) > SESSION_TTL_MS) sessions.delete(sid);
  }
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => (a[1].lastActiveAt || 0) - (b[1].lastActiveAt || 0));
    for (let i = 0; i < sorted.length - SESSION_MAX; i++) sessions.delete(sorted[i][0]);
  }
}, 10 * 60 * 1000).unref();     // unref：别让定时器拖住进程退出

/* ── HTTP 工具 ──────────────────────────────────────────── */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    const MAX = 1e6;
    req.on('data', c => {
      if (overflowed) return;
      size += c.length;
      if (size > MAX) {
        // 超限时**不要** req.destroy()：那会把连接直接重置，
        // 客户端只看到 ECONNRESET（status 0），拿不到我们想回的 413。
        // 正确做法是 reject 让上层回 413，同时 resume() 把剩下的数据读掉，
        // 否则响应发不出去（Node 会等请求体读完）。
        overflowed = true;
        const e = new Error('请求体过大'); e.code = 413;
        reject(e);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    // 必须等所有分块到齐再整体转 UTF-8：
    // 逐块 toString() 会把被 TCP 分包劈开的多字节汉字变成 U+FFFD，JSON 解析就炸了。
    req.on('end', () => {
      if (overflowed) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* 允许对外提供的文件白名单。
 * 为什么必须白名单：服务默认绑 0.0.0.0 且常挂在公网隧道后面，
 * 而 README 教用户把 API key 放进 game\.env —— 如果按路径直出整个目录，
 * 任何人访问 http://<地址>/.env 就能拿到明文密钥。
 * 同理 .mjs / .log / .bak 也不该被下载。 */
const STATIC_ALLOW = new Set([
  '/index.html', '/app.js', '/style.css',
  '/favicon.ico', '/robots.txt',
]);

function serveStatic(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let rel;
  try {
    const url = new URL(req.url, 'http://localhost');
    rel = decodeURIComponent(url.pathname);
  } catch {
    // 非法百分号转义（如 /%）会抛 URIError。
    // 这里必须自己兜住：serveStatic 是在 async 监听器里同步调用的，
    // 抛出去就变成 unhandled rejection —— 一条 GET /% 就能打挂整个进程。
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }

  if (rel === '/' || rel === '') rel = '/index.html';

  if (!STATIC_ALLOW.has(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }

  const root = path.resolve(__dirname);
  const file = path.resolve(root, '.' + rel);
  // 双保险：即使白名单被改坏，也不许跳出根目录
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

/* ── JSON 容错 ──────────────────────────────────────────── */
// extractJson 已挪到 guards.mjs —— 它是纯逻辑，放那边才能被离线单测覆盖
// （真实事故：模型在字符串里吐裸换行，导致"立案失败"，见 guards.mjs 注释）。

/** 带一次修复重试的 JSON 调用
 *  maxTokens 给得比需要的宽：开着思考模式的模型（如 deepseek-flash）
 *  会先花掉一部分预算"想"，留太紧会导致正文为空。
 *  @param stage 'case' | 'say' | 'verdict' —— 用于按阶段选择思考档位
 */
async function chatJson(system, user, { maxTokens = 900, temperature = 1.0, stage = 'say', think } = {}) {
  const { thinking, level } = thinkFor(stage, think);   // 传入本局难度；不传则用默认档
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = attempt === 0
      ? [{ role: 'system', content: system }, { role: 'user', content: user }]
      : [
          { role: 'system', content: system },
          { role: 'user', content: user },
          { role: 'assistant', content: '（上一次输出不是合法 JSON）' },
          { role: 'user', content: '你上一次的输出不是合法 JSON。请只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释。' },
        ];
    try {
      const r = await chat(messages, { maxTokens, temperature, thinking });
      const cny = recordUsage(r.usage, r.thinkingTokens);
      // 归一化：JSON.parse('null') 也能成功，但拿到 null 之后
      // 下面所有 data.xxx 都会 TypeError，只能回一个看不懂的 500。
      const j = extractJson(r.text);
      if (!j || typeof j !== 'object' || Array.isArray(j)) {
        throw new Error('模型返回的不是 JSON 对象：' + String(r.text).slice(0, 120));
      }
      return {
        data: j,
        meta: {
          model: r.model, provider: r.provider, usage: r.usage,
          thinkingTokens: r.thinkingTokens, thinkLevel: level, costCNY: +cny.toFixed(6),
        },
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const str = (v, d = '') => (typeof v === 'string' ? v.trim() : v == null ? d : String(v).trim());
const arr = (v, n = 6) => (Array.isArray(v) ? v.map(x => str(x)).filter(Boolean).slice(0, n) : []);

/* ── 引用校验与称呼校验都在 guards.mjs（纯逻辑，可离线单测）───────── */

/* ── 思考档位：进程级设置，可由 /api/settings 改 ─────────── */

let thinkLevel = THINK_LEVELS[process.env.THINK_LEVEL] ? process.env.THINK_LEVEL : 'off';

/** 写进环境变量，config.thinkFor 直接读它 —— 不必给每条调用链都加参数 */
function applyThinkLevel(level) {
  if (!THINK_LEVELS[level]) return false;
  thinkLevel = level;
  process.env.THINK_LEVEL = level;
  return true;
}

/* ── 流式骨架：边生成边推给前端，避免"点一下干等十几秒" ──── */

/**
 * 以 SSE 形式跑一次 JSON 调用。
 *   · 生成过程中：按 keys 里的字段增量推 {type:'delta', key, text}
 *   · 结束后：推 {type:'done', ...}，由调用方决定内容
 *
 * @param keys [{ key, field, after }]  —— key 是给前端的名字，field 是 JSON 字段名，
 *             after 用于区分嵌套里同名字段（如 prosecutor.opening / judge.opening）
 */
async function streamJson(req, res, { system, user, stage, maxTokens, temperature = 1.0, keys = [], onDone, think }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',      // 让 Cloudflare 隧道不要缓冲
  });
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端断了 */ } };
  // 心跳：隧道有约 100 秒空闲超时，思考期间没有正文输出，靠它保活
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }, 8000);

  /* 玩家关页面/刷新时要中止上游请求。
     否则模型会跑满（思考全开时最长 180s），token 照烧，还往死 socket 写数据。 */
  let aborted = false;
  req.on('close', () => { aborted = true; });

  const { thinking, level } = thinkFor(stage, think);   // 传入本局难度；不传则用默认档
  const seen = {};
  let streamErr = null;

  try {
    send({ type: 'start', thinkLevel: level });

    const r = await chatStream(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { maxTokens, temperature, thinking },     // reasoningEffort 目前无档位使用，别传未定义的变量
      (delta, full) => {
        if (aborted) return;                 // 客户端已断开，别再推了
        for (const k of keys) {
          const v = peekJsonStringField(full, k.field, k.after ? { after: k.after } : {});
          if (v && v !== seen[k.key]) {
            seen[k.key] = v;
            send({ type: 'delta', key: k.key, text: v });
          }
        }
      },
      (reasoning) => {
        // 思考过程也推给前端，让用户看到"它在想"，而不是干等
        send({ type: 'thinking', chars: reasoning.length });
      }
    );

    const cny = recordUsage(r.usage, r.thinkingTokens);
    const data = extractJson(r.text);
    const meta = {
      model: r.model, provider: r.provider, usage: r.usage,
      thinkingTokens: r.thinkingTokens, thinkLevel: level, costCNY: +cny.toFixed(6),
      streamed: true,
    };
    const payload = await onDone(data, meta);
    send({ type: 'done', ok: true, ...payload });
  } catch (e) {
    streamErr = e;
    console.error('[stream] ' + String(e.message || e).slice(0, 200));
    send({ type: 'error', error: String(e.message || e).slice(0, 300) });
  } finally {
    clearInterval(hb);
    try { res.end(); } catch { /* 忽略 */ }
  }
  return streamErr;
}

/** 请求方是否要流式 */
function wantsStream(req, body) {
  if (String(req.headers.accept || '').includes('text/event-stream')) return true;
  return !!(body && body.stream);
}

/* ── 业务：立案 ─────────────────────────────────────────── */

/** 把模型返回的原始 JSON 规整成 session 需要的案件结构（流式/非流式共用） */
function buildCaseFrom(data) {
  const p = data.prosecutor || {};
  const j = data.judge || {};
  return {
    court: str(data.court, '市井第三巡回法庭'),
    case_title: str(data.case_title, '未命名案'),
    case_no: str(data.case_no, '（2026）巷民初字第 0001 号'),
    defendant_role: str(data.defendant_role, '一名普通市民'),
    charge: str(data.charge, '涉嫌在公共场所制造难以名状的气氛'),
    articles: pickList(data.articles, 4, CASE_FALLBACKS.articles),
    evidence: pickList(data.evidence, 5, CASE_FALLBACKS.evidence),
    precedents: pickList(data.precedents, 4, CASE_FALLBACKS.precedents),
    witnesses: pickList(data.witnesses, 5, CASE_FALLBACKS.witnesses),
    prosecutor: {
      name: str(p.name, '严不怠'),
      title: str(p.title, '公诉人'),
      style: str(p.style, '程序至上，语速极快'),
      opening: str(p.opening, '被告，本席对你的行为已无话可说，但法律有。'),
    },
    judge: {
      name: str(j.name, '陈不急'),
      temper: str(j.temper, '懒得讲道理'),
      opening: str(j.opening, '坐下吧。今天别让我说第二遍。'),
    },
  };
}

function applyCase(session, c, meta, seed) {
  session.case = c;
  session.seed = seed || null;      // daUserPrompt 里要用它写「旁白：…」
  session.transcript = [
    { role: 'judge', content: c.judge.opening, at: Date.now() },
    { role: 'prosecutor', content: c.prosecutor.opening, at: Date.now() },
  ];
  session.grudges = [];
  session.judgeLedger = [];
  session.clerkNotes = [];
  session.strategyLog = [];
  session.strategy = null;
  session.credibility = 0;
  session.judgeActions = [];
  session.exhibits = [];
  session.closing = null;
  session.appealNote = null;
  session.appealResult = null;
  session.offscreen = [];
  session.witnesses = [];
  session.round = 0;
  session.meta = meta;
}

async function buildCase(session, seed) {
  const { data, meta } = await chatJson(
    caseSystemPrompt(),
    caseUserPrompt({ intensity: session.intensity, seed }),
    { maxTokens: 8000, temperature: 1.05, stage: 'case', think: session.think }
  );
  const c = buildCaseFrom(data);
  applyCase(session, c, meta, seed);
  return c;
}

/* ── 业务：被告发言 → 检察官回击 ────────────────────────── */

async function say(session, text, strategyId = null) {
  setupSay(session, text, strategyId);
  let data = null, meta = null, degraded = false;
  try {
    const r = await chatJson(
      daSystemPrompt(session),
      daUserPrompt(session),
      { maxTokens: 4000, temperature: 1.05, stage: 'say', think: session.think }
    );
    data = r.data; meta = r.meta;
  } catch (e) {
    degraded = true;
    data = degradedSay();
    meta = { error: String(e.message || e).slice(0, 300) };
  }
  return applySayResult(session, data, meta, degraded);
}

/** 被告发言前的准备工作：记录策略与发言（流式路径也要先做这一步） */
function setupSay(session, text, strategyId = null) {
  const content = str(text).slice(0, 1200);
  const strat = strategyId ? getStrategy(str(strategyId)) : null;
  if (strat) {
    session.strategy = strat;
    session.strategyLog.push({ id: strat.id, name: strat.name, round: session.round || 0 });
  } else {
    session.strategy = null;
  }
  session.transcript.push({ role: 'defendant', content, at: Date.now() });
  return content;
}

/**
 * 记录发言前的现场，失败时用来回滚。
 * 不这样做的话：模型调用失败后被告那句会永久留在 transcript（进庭审记录、
 * 进提示词、进判决书），但 round 没 +1、没有检察官回应、两本账没合并 ——
 * 会话处于半更新状态，玩家重说一遍就会出现两条几乎相同的发言。
 */
function snapshotSay(session) {
  return {
    transcriptLen: session.transcript.length,
    strategyLen: session.strategyLog.length,
    strategy: session.strategy,
  };
}

function rollbackSay(session, snap) {
  if (!snap) return;
  session.transcript.length = Math.min(session.transcript.length, snap.transcriptLen);
  session.strategyLog.length = Math.min(session.strategyLog.length, snap.strategyLen);
  session.strategy = snap.strategy;
}

/** 非流式降级用的占位数据 */
function degradedSay() {
  return {
    prosecutor: '（检察官翻了一页卷宗，没有说话。书记员记录：被告的发言已入卷。）',
    judge_note: '', attitude: '暂时沉默', quoted: '',
  };
}

/** 把模型返回的 JSON 落到庭辩状态上（流式与非流式共用这一份逻辑） */
function applySayResult(session, data, meta, degraded = false) {
  const defendantLines = session.transcript
    .filter(t => t.role === 'defendant')
    .map(t => t.content);

  const q = ensureQuote(data.quoted, defendantLines);

  const judgeName = session.case.judge.name;
  const gName = (s) => { const r = fixJudgeName(s, judgeName); if (r.fixed) console.warn('[guard] 纠正了法官称呼 → ' + judgeName); return r.text; };

  const prosecutorLine = gName(str(data.prosecutor)) || '（检察官拒绝回应。）';

  // 法官的签名从正文里剥离出来，前端渲染成单独一张批注卡片
  const signSplit = splitJudgeSign(gName(str(data.judge_note)), judgeName);
  const judgeNote = signSplit.text;

  // ── 两本账一起合并（检察官的罪证账 + 法官的态度账）──
  // 注意：这两本账来自**同一次** API 调用的不同字段，所以法官有记忆不增加任何成本。
  const merged = mergeBothLedgers(
    { prosecutor: session.grudges, judge: session.judgeLedger },
    data, defendantLines, session.round || 0, judgeName
  );
  const pRecalled = markRecalled(merged.prosecutor, data.recalled, session.round || 0, 'recalled');
  const jUsed = markRecalled(merged.judge, data.rule_used, session.round || 0, 'rule_used');
  session.grudges = pRecalled.list;
  session.judgeLedger = jUsed.list;

  // ── 书记员：客观矛盾记录（同一次调用的第三个字段）──
  const clerkRes = mergeClerkNotes(session.clerkNotes, data.clerk_notes, defendantLines, session.round || 0);
  session.clerkNotes = clerkRes.notes;

  // ── 法官的主动介入 ──
  const judgeAction = normalizeJudgeAction(data.judge_action);
  if (judgeAction) session.judgeActions.push({ ...judgeAction, round: session.round || 0 });

  // ── 庭外情节（同一次调用的字段，零额外成本）──
  const offscreenText = gName(str(data.offscreen));
  let offscreen = null;
  if (offscreenText) {
    offscreen = {
      text: offscreenText,
      place: str(data.offscreen_place) || '法庭之外',
      round: session.round || 0,
    };
    session.offscreen = Array.isArray(session.offscreen) ? session.offscreen : [];
    session.offscreen.push(offscreen);
    while (session.offscreen.length > 20) session.offscreen.shift();
  }

  // ── 证人传唤（同样是同一次调用的字段）──
  let witness = null;
  const w = data.witness || {};
  const wName = gName(str(w.name));
  const wLine = gName(str(w.line));
  if (wName && wLine) {
    const EFFECTS = ['不利', '中性', '有利'];
    const rawE = str(w.effect);
    witness = {
      name: wName, line: wLine,
      effect: EFFECTS.find(e => rawE.includes(e)) || '中性',
      round: session.round || 0,
    };
    session.witnesses = Array.isArray(session.witnesses) ? session.witnesses : [];
    // 同一个证人只出庭一次
    if (!session.witnesses.some(x => x.name === witness.name)) {
      session.witnesses.push(witness);
    } else {
      witness = null;      // 已经来过了，不重复渲染
    }
  }

  // ── 可信度变化 → 胜诉概率（本地算，零成本）──
  const credBefore = session.credibility || 0;
  session.credibility = clampMood(data.cred_delta, credBefore);
  const credDelta = session.credibility - credBefore;

  const out = [];
  out.push({ role: 'prosecutor', content: prosecutorLine, quote: q.quoted || null, exact: q.exact });
  if (judgeNote) out.push({ role: 'judge', content: judgeNote, sign: signSplit.sign, action: judgeAction });
  if (clerkRes.added.length) {
    for (const n of clerkRes.added) out.push({ role: 'clerk', content: n.note, quote: n.quote });
  }

  session.transcript.push({ role: 'prosecutor', content: prosecutorLine, at: Date.now() });
  if (judgeNote) session.transcript.push({ role: 'judge', content: judgeNote, at: Date.now() });

  // 证据逐轮推进：先记录本轮出了哪些
  const evRef = toIndex(data.evidence_ref);
  const evShownNow = evidenceState(session.case.evidence, session.round || 0, credBefore);
  const usedEvidence = Number.isFinite(evRef) && evRef >= 1 && evRef <= (session.case.evidence || []).length
    ? { n: evRef, text: session.case.evidence[evRef - 1] } : null;

  session.round = (session.round || 0) + 1;
  session.strategy = null;   // 策略只管一轮

  return {
    lines: out,
    attitude: str(data.attitude, '不动声色'),
    round: session.round,
    quick: session.intensity === 'quick',
    roundsLeft: session.intensity === 'quick' ? Math.max(0, QUICK_ROUNDS - session.round) : null,
    mustVerdict: session.intensity === 'quick' && session.round >= QUICK_ROUNDS,
    grudges: session.grudges,
    judgeLedger: session.judgeLedger,
    clerkNotes: session.clerkNotes,
    grudgeAdded: merged.added.prosecutor,
    grudgeEscalated: merged.escalated.prosecutor,
    ledgerAdded: merged.added.judge,
    ledgerEscalated: merged.escalated.judge,
    recalled: pRecalled.event,
    ruleUsed: jUsed.event,
    clerkAdded: clerkRes.added,
    judgeAction,
    offscreen,
    witness,
    offscreenAll: session.offscreen || [],
    witnesses: session.witnesses || [],
    credibility: session.credibility,
    credDelta,
    winChance: winChance(session.credibility),
    mood: moodLabel(session.credibility),
    evidence: evidenceState(session.case.evidence, session.round, session.credibility),
    evidenceUsed: usedEvidence,
    meta: { ...(meta || {}), usage: meta && meta.usage ? meta.usage : undefined },
    degraded,
  };
}

/* ── 业务：宣判 ─────────────────────────────────────────── */

async function verdict(session) {
  if (!session.case) { const e = new Error('还没立案'); e.code = 400; throw e; }
  if (!session.transcript.some(t => t.role === 'defendant')) {
    const e = new Error('被告一句话都没说，法官拒绝宣判。'); e.code = 400; throw e;
  }

  let data = null, meta = null, degraded = false;
  try {
    const r = await chatJson(
      verdictSystemPrompt(session),
      verdictUserPrompt(session),
      { maxTokens: 8000, temperature: 1.0, stage: 'verdict', think: session.think }
    );
    data = r.data; meta = r.meta;
  } catch (e) {
    degraded = true;
    data = degradedVerdict(session);
    meta = { error: String(e.message || e).slice(0, 300) };
  }
  return applyVerdictResult(session, data, meta, degraded);
}

/** 非流式降级用的占位判决书 */
function degradedVerdict(session) {
  return {
    verdict_title: '本院对本案不作评价',
    verdict_text: `${session.case.case_no}\n\n被告的发言已全部入卷。\n\n判决如下：驳回起诉，当庭释放，各自回家。\n\n退庭。`,
    sentence: '驳回起诉，当庭释放',
    quotes: [], da_best: '',
    judge_private: '（法官合上卷宗，走了。）',
    epilogue: '', retitle: '查无此事',
  };
}

/** 把模型返回的判决 JSON 落成最终结果（流式与非流式共用） */
function applyVerdictResult(session, data, meta, degraded = false) {
  const defendantLines = session.transcript.filter(t => t.role === 'defendant').map(t => t.content);
  const daLines = session.transcript.filter(t => t.role === 'prosecutor').map(t => t.content);

  // 判决书里引用的被告原话也做一次校验兜底
  let quotes = arr(data.quotes, 3);
  if (!quotes.length && defendantLines.length) {
    quotes = [ensureQuote('', defendantLines).quoted].filter(Boolean);
  }
  const daBest = str(data.da_best) || daLines[daLines.length - 1] || '';

  const judgeName = session.case.judge.name;
  const gName = (s) => { const r = fixJudgeName(s, judgeName); if (r.fixed) console.warn('[guard] 纠正了法官称呼 → ' + judgeName); return r.text; };

  const OUTCOMES = ['有罪', '部分有罪', '无罪释放', '发回重审'];
  const rawOutcome = str(data.outcome);
  const outcome = OUTCOMES.find(o => rawOutcome.includes(o)) || (session.credibility >= 4 ? '无罪释放' : session.credibility <= -3 ? '有罪' : '部分有罪');

  const sc = toIndex(data.case_score);
  const score = Math.max(0, Math.min(100, Number.isFinite(sc) ? Math.round(sc) : 60));

  const result = {
    verdict_title: gName(str(data.verdict_title, '本院认为')),
    verdict_text: gName(str(data.verdict_text, '（判决书散佚。）')),
    sentence: str(data.sentence, '候补判决'),
    quotes,
    da_best: gName(daBest),
    judge_private: str(data.judge_private),
    epilogue: gName(str(data.epilogue)),
    retitle: str(data.retitle),
    grudge_verdict: gName(str(data.grudge_verdict)),
    grudge_count: Array.isArray(session.grudges) ? session.grudges.length : 0,
    judge_ledger_verdict: gName(str(data.judge_ledger_verdict)),
    judge_ledger_count: Array.isArray(session.judgeLedger) ? session.judgeLedger.length : 0,
    concur: str(data.concur),
    judge_ledger: session.judgeLedger || [],

    /* ── 新玩法带出的判决书内容 ── */
    outcome,
    credibility: session.credibility || 0,
    credibility_verdict: gName(str(data.credibility_verdict)),
    case_score: score,
    case_score_reason: str(data.case_score_reason),
    precedent_used: str(data.precedent_used),
    next_case_hook: str(data.next_case_hook),

    /* ── 全场档案（判决书里完整呈现，零额外成本）── */
    clerk_notes: session.clerkNotes || [],
    strategy_log: session.strategyLog || [],
    exhibits: session.exhibits || [],
    judge_actions: session.judgeActions || [],
    offscreen: session.offscreen || [],
    witnesses_called: session.witnesses || [],
    closing: session.closing || null,
    evidence_final: evidenceState(session.case.evidence, session.round, session.credibility),
    appeal_chance: appealChance(session.credibility, (session.clerkNotes || []).length,
      (session.judgeActions || []).filter(a => a.id === 'warn_da').length, session.round),

    usage: usageSummary(),
    case: session.case,
    rounds: session.round,
    defendant_words: defendantLines.reduce((n, s) => n + s.length, 0),
    meta,
    degraded,
  };

  session.result = result;
  return result;
}

/* ── 业务：结案陈词（本地评估，不调用模型）───────────────── */

function setClosing(session, text) {
  if (!session.case) { const e = new Error('还没立案'); e.code = 400; throw e; }
  const t = str(text).slice(0, 1500);
  if (!t) { const e = new Error('结案陈词不能为空'); e.code = 400; throw e; }

  // 幂等：结案陈词是免费接口（不占 AI 配额），如果不设保护，
  // 连点两次「提交」或脚本重放就能把 bonus 反复累加，
  // 直到 clampMood 顶到 +6 → 胜诉概率直接 95%。
  if (session.closing) {
    const cov0 = closingCoverage(session.closing, session);
    return {
      already: true,
      closing: session.closing,
      coverage: cov0,
      credibility: session.credibility || 0,
      credDelta: 0,
      winChance: winChance(session.credibility || 0),
      mood: moodLabel(session.credibility || 0),
      note: '结案陈词已经提交过，本次不再计分。',
    };
  }

  session.closing = t;

  const cov = closingCoverage(t, session);
  // 结案陈词写得好，直接给可信度加分；写得敷衍则扣分
  const before = session.credibility || 0;
  session.credibility = clampMood(cov.tooShort ? -1 : cov.bonus, before);

  return {
    already: false,
    closing: t,
    coverage: cov,
    credibility: session.credibility,
    credDelta: session.credibility - before,
    winChance: winChance(session.credibility),
    mood: moodLabel(session.credibility),
  };
}

/* ── 业务：补充取证（新增 1 次调用）────────────────────── */

async function applyExhibit(session, request) {
  if (!session.case) { const e = new Error('还没立案'); e.code = 400; throw e; }
  const req = str(request).slice(0, 300);
  if (!req) { const e = new Error('说清你想调取什么证据'); e.code = 400; throw e; }
  if ((session.exhibits || []).length >= 3) {
    return { rejected: true, error: '本庭最多受理三次补充取证申请。', exhibits: session.exhibits };
  }

  let data = null, meta = null;
  try {
    const r = await chatJson(
      EXHIBIT_STATIC,
      exhibitUserPrompt(session, req),
      { maxTokens: 6000, temperature: 1.05, stage: 'exhibit', think: session.think }
    );
    data = r.data; meta = r.meta;
  } catch (e) {
    return { rejected: true, error: '取证申请处理失败：' + String(e.message || e).slice(0, 120) };
  }

  const judgeName = session.case.judge.name;
  const gName = (s) => fixJudgeName(s, judgeName).text;

  const RULINGS = ['准予调取', '部分准予', '不予调取'];
  const rawR = str(data.exhibit_ruling);
  const ruling = RULINGS.find(x => rawR.includes(x)) || '不予调取';

  const before = session.credibility || 0;
  // 只有被准予的证据才真正影响可信度
  const rawDelta = toIndex(data.cred_delta);
  const delta = ruling === '不予调取' ? 0 : (Number.isFinite(rawDelta) ? Math.max(-2, Math.min(3, Math.round(rawDelta))) : 0);
  session.credibility = clampMood(delta, before);

  const ex = {
    n: (session.exhibits || []).length + 1,
    request: req,
    name: gName(str(data.exhibit_name)) || '未命名证据',
    content: gName(str(data.exhibit_content)),
    ruling,
    ruling_reason: gName(str(data.exhibit_ruling_reason)),
    objection: gName(str(data.prosecutor_objection)),
    credDelta: session.credibility - before,
  };
  session.exhibits.push(ex);

  session.transcript.push({ role: 'judge', content: `【${ex.name}】${ex.ruling}。${ex.ruling_reason}`, at: Date.now() });

  return {
    rejected: false,
    exhibit: ex,
    exhibits: session.exhibits,
    credibility: session.credibility,
    credDelta: ex.credDelta,
    winChance: winChance(session.credibility),
    mood: moodLabel(session.credibility),
    meta,
  };
}

/* ── 业务：上诉（新增 1 次调用）───────────────────────── */

async function applyAppeal(session, note) {
  if (!session.case) { const e = new Error('还没立案'); e.code = 400; throw e; }
  if (!session.result) { const e = new Error('还没有判决，无法上诉'); e.code = 400; throw e; }
  if (session.appealResult) {
    return { already: true, appeal: session.appealResult };
  }
  session.appealNote = str(note).slice(0, 400);

  let data = null, meta = null;
  try {
    const r = await chatJson(
      APPEAL_STATIC,
      appealUserPrompt(session),
      { maxTokens: 8000, temperature: 1.0, stage: 'verdict', think: session.think }
    );
    data = r.data; meta = r.meta;
  } catch (e) {
    return { failed: true, error: '上诉审处理失败：' + String(e.message || e).slice(0, 120) };
  }

  const RESULTS = ['维持原判', '改判', '发回重审'];
  const rawR = str(data.appeal_result);
  const result = RESULTS.find(x => rawR.includes(x)) || '维持原判';

  const judgeName = session.case.judge.name;
  const gName = (s) => fixJudgeName(s, judgeName).text;

  const appeal = {
    result,
    reason: gName(str(data.appeal_reason)),
    text: gName(str(data.appeal_text)),
    sentence: gName(str(data.appeal_sentence)),
    title: gName(str(data.appeal_title)),
    judge_comment: gName(str(data.judge_comment_on_appeal)),
    note: session.appealNote,
    chanceAtAppeal: appealChance(session.credibility, (session.clerkNotes || []).length,
      (session.judgeActions || []).filter(a => a.id === 'warn_da').length, session.round),
  };
  session.appealResult = appeal;

  return { appeal, meta };
}

/* ── 路由 ───────────────────────────────────────────────── */

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/health') {
    // 公网部署后这个接口任何人都能访问。
    // 绝不能回传 keyEnv / baseURL / 模型名 —— 那等于告诉外面我们在烧谁的额度。
    // 不再暴露任何"还剩多少场"——场次已经不限制了
    return send(res, 200, { ok: true, model_ready: !!targetInfo(), public: PUBLIC_MODE, perMinutePerIp: RATE_MAX_REQ });
  }

  // 游戏内可调：思考档位（省钱 / 全开）
  if (route === '/api/settings') {
    // 两个旋钮，都是**按局**生效的，前端把它们记在本地、立案时带上来。
    // 所以这里不需要"能不能改"这套锁 —— 每个人改的都是自己那一局。
    // 也**不返回任何金额**：花多少钱是运维的事，不该出现在玩家界面上。

    if (req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        // 前端没存过本地偏好时用这两个默认值
        think: thinkFor().level,
        severity: 'normal',
        thinkLevels: Object.entries(THINK_LEVELS).map(([k, v]) => ({ key: k, label: v.label, note: v.note })),
        severityLevels: Object.entries(SEVERITY_LEVELS).map(([k, v]) => ({ key: k, label: v.label, note: v.note })),
      });
    }
    if (req.method === 'POST') {
      // 改的是**服务端默认深度思考档**（影响新访客的初始值），属于运维操作，
      // 公网模式下要管理员口令。
      const adminToken = process.env.ADMIN_TOKEN || '';
      if (PUBLIC_MODE && (!adminToken || str(req.headers['x-admin-token']) !== adminToken)) {
        return send(res, 403, { ok: false, error: '改默认档位需要管理员口令' });
      }
      const body = await readBody(req);
      const wanted = str(body.think);
      if (!applyThinkLevel(wanted)) return send(res, 400, { ok: false, error: '未知档位：' + wanted });
      console.log(`[settings] 默认深度思考 → ${wanted}（${THINK_LEVELS[wanted].label}）`);
      return send(res, 200, { ok: true, think: thinkLevel });
    }
  }

  // 本局开销（给玩家看"这一局花了多少钱"）
  if (req.method === 'GET' && route === '/api/usage') {
    return send(res, 200, { ok: true, usage: usageSummary(), think: thinkLevel });
  }

  // 离线演示：不调 AI，返回完整样片（首页 ?demo=1 或服务不可用时使用）
  if (req.method === 'GET' && route === '/api/demo') {
    return send(res, 200, {
      ok: true,
      demo: true,
      intensity: 'free',
      quickRounds: QUICK_ROUNDS,
      case: DEMO_CASE,
      transcript: DEMO_TRANSCRIPT,
      result: DEMO_RESULT,
      portrait: DEMO_PORTRAIT,
    });
  }

  /* 下面每一个接口都会真的调用大模型 —— 公网模式下统一过一遍限流与配额 */
  const AI_ROUTES = ['/api/portrait', '/api/case', '/api/say', '/api/verdict', '/api/exhibit', '/api/appeal'];
  if (AI_ROUTES.includes(route)) {
    const blocked = checkRateLimit(req);
    if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error, rate_limited: true });
  }

  // 策略卡清单（纯静态，零成本）
  if (req.method === 'GET' && route === '/api/strategies') {
    return send(res, 200, { ok: true, strategies: STRATEGIES.map(s => ({ id: s.id, name: s.name, icon: s.icon, hint: s.hint })) });
  }

  // 结案陈词（本地评估，不调用模型）
  if (req.method === 'POST' && route === '/api/closing') {
    const body = await readBody(req);
    const s = getSession(str(body.sid));
    return send(res, 200, { ok: true, ...(await withSession(s, () => setClosing(s, body.text))) });
  }

  // 补充取证（新增 1 次调用）
  if (req.method === 'POST' && route === '/api/exhibit') {
    const body = await readBody(req);
    const s = getSession(str(body.sid));
    return send(res, 200, { ok: true, ...(await withSession(s, () => applyExhibit(s, body.text))) });
  }

  // 上诉（新增 1 次调用）
  if (req.method === 'POST' && route === '/api/appeal') {
    const body = await readBody(req);
    const s = getSession(str(body.sid));
    return send(res, 200, { ok: true, ...(await withSession(s, () => applyAppeal(s, body.note))) });
  }

  if (req.method === 'GET' && route === '/api/portrait') {
    try {
      const { data } = await chatJson('你是一个荒诞法庭的人物设定师。', judgePortraitUserPrompt(), { maxTokens: 800, temperature: 1.1, stage: 'case' });
      return send(res, 200, { ok: true, portrait: { name: str(data.name, '陈不急'), temper: str(data.temper, '懒得讲道理'), line: str(data.line, '坐下吧，今天别让我说第二遍。') } });
    } catch (e) {
      return send(res, 200, { ok: false, portrait: null, error: String(e.message || e).slice(0, 200) });
    }
  }

  if (req.method === 'POST' && route === '/api/case') {
    const body = await readBody(req);
    const s = newSession({ intensity: body.intensity, difficulty: body.difficulty, severity: body.severity });

    /* ── 流式：边立案边把案名/罪名/开庭词推给前端，不让用户干等 ── */
    if (wantsStream(req, body)) {
      const err = await streamJson(req, res, {
        system: caseSystemPrompt(),
        user: caseUserPrompt({ intensity: s.intensity, seed: str(body.seed) }),
        stage: 'case', maxTokens: 8000, temperature: 1.05, think: s.think,
        keys: [
          { key: 'case_title', field: 'case_title' },
          { key: 'charge', field: 'charge' },
          { key: 'defendant_role', field: 'defendant_role' },
          { key: 'court', field: 'court' },
          { key: 'case_no', field: 'case_no' },
          { key: 'prosecutor_name', field: 'name', after: '"prosecutor"' },
          { key: 'prosecutor_style', field: 'style', after: '"prosecutor"' },
          { key: 'judge_name', field: 'name', after: '"judge"' },
          { key: 'judge_temper', field: 'temper', after: '"judge"' },
          { key: 'judge_opening', field: 'opening', after: '"judge"' },
          { key: 'prosecutor_opening', field: 'opening', after: '"prosecutor"' },
        ],
        onDone: (data, meta) => {
          const c = buildCaseFrom(data);
          applyCase(s, c, meta, str(body.seed));
          return { sid: s.sid, case: c, intensity: s.intensity, quickRounds: QUICK_ROUNDS, think: s.think, severity: s.severity };
        },
      });
      // 流式立案失败也要清掉这个 session，否则它会永远留在 Map 里
      if (err) sessions.delete(s.sid);
      return;
    }

    try {
      const c = await buildCase(s, str(body.seed));
      return send(res, 200, { ok: true, sid: s.sid, case: c, transcript: s.transcript, intensity: s.intensity, quickRounds: QUICK_ROUNDS });
    } catch (e) {
      sessions.delete(s.sid);
      return send(res, 502, { ok: false, error: '立案失败：' + String(e.message || e).slice(0, 400) });
    }
  }

  if (req.method === 'POST' && route === '/api/say') {
    const body = await readBody(req);
    const s = getSession(str(body.sid));

    if (wantsStream(req, body)) {
      const content = str(body.text).slice(0, 1200);
      if (!content) return send(res, 400, { ok: false, error: '说点什么再提交' });
      const release = acquireSession(s);
      // 用 try/finally 包住：streamJson 万一抛了（比如连接已断），
      // release 也一定会执行。不然这个 session 会永久卡在 busy，
      // 之后所有请求都返回 409，玩家以为游戏坏了。
      try {
        const rollback = snapshotSay(s);
        setupSay(s, body.text, body.strategy);
        // 必须接住返回值：streamJson 内部出错时返回错误对象而不是抛，
        // 之前这里误用了 streamJson 的内部变量名 streamErr（不在此作用域）→ ReferenceError
        const err = await streamJson(req, res, {
          system: daSystemPrompt(s),
          user: daUserPrompt(s),
          stage: 'say', maxTokens: 4000, temperature: 1.05, think: s.think,
          keys: [
            { key: 'judge_note', field: 'judge_note' },
            { key: 'prosecutor', field: 'prosecutor' },
          ],
          onDone: (data, meta) => applySayResult(s, data, meta, false),
        });
        // 失败时回滚：否则被告那句会永久留在 transcript 里、
        // round 却没 +1，玩家重说一遍就出现两条几乎一样的发言
        if (err) rollbackSay(s, rollback);
      } finally { release(); }
      return;
    }

    const r = await withSession(s, () => say(s, body.text, body.strategy));
    return send(res, 200, { ok: true, ...r });
  }

  if (req.method === 'POST' && route === '/api/verdict') {
    const body = await readBody(req);
    const s = getSession(str(body.sid));

    if (wantsStream(req, body)) {
      if (!s.transcript.some(t => t.role === 'defendant')) {
        return send(res, 400, { ok: false, error: '被告一句话都没说，法官拒绝宣判。' });
      }
      const releaseV = acquireSession(s);
      try {
        await streamJson(req, res, {
          system: verdictSystemPrompt(s),
          user: verdictUserPrompt(s),
          stage: 'verdict', maxTokens: 8000, temperature: 1.0, think: s.think,
          keys: [
            { key: 'verdict_title', field: 'verdict_title' },
            { key: 'sentence', field: 'sentence' },
            { key: 'verdict_text', field: 'verdict_text' },
          ],
          onDone: (data, meta) => ({ result: applyVerdictResult(s, data, meta, false) }),
        });
      } finally { releaseV(); }
      return;
    }

    const r = await withSession(s, () => verdict(s));
    return send(res, 200, { ok: true, result: r });
  }

  if (req.method === 'GET' && route === '/api/session') {
    const s = getSession(url.searchParams.get('sid') || '');
    return send(res, 200, { ok: true, state: {
      sid: s.sid, intensity: s.intensity, case: s.case, transcript: s.transcript,
      round: s.round, result: s.result || null, grudges: s.grudges || [],
      judgeLedger: s.judgeLedger || [], clerkNotes: s.clerkNotes || [],
      credibility: s.credibility || 0, winChance: winChance(s.credibility || 0),
      mood: moodLabel(s.credibility || 0),
      strategyLog: s.strategyLog || [], exhibits: s.exhibits || [],
      judgeActions: s.judgeActions || [], closing: s.closing || null,
      appealResult: s.appealResult || null,
      evidence: evidenceState(s.case && s.case.evidence, s.round, s.credibility || 0),
      quickRounds: QUICK_ROUNDS,
    } });
  }

  return send(res, 404, { ok: false, error: '未知接口：' + route });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (e) {
      const code = e.code || 500;
      const msg = String(e.message || e);

      /* 兜底必须判断响应头是否已经发出。
       * SSE（流式）在生成过程中就已经 writeHead 了；如果之后还有异常冒到这里，
       * 再调 send() 会抛 ERR_HTTP_HEADERS_SENT —— 那是个**未捕获异常，会打死进程**。
       * 真实踩过：宣判时崩服务，玩家那边看到连接被重置。 */
      if (res.headersSent) {
        console.error('[api] 响应头已发出，无法再写 JSON：' + msg);
        try { res.end(); } catch { /* 忽略 */ }
      } else {
        send(res, code, { ok: false, error: msg });
      }
    }
    return;
  }

  try {
    serveStatic(req, res);
  } catch (e) {
    console.error('[static] ' + String(e.message || e));
    if (!res.headersSent) { try { res.writeHead(500).end('error'); } catch { /* 忽略 */ } }
  }
});

/* 最后一道防线：任何漏网的异常都不许打死服务。
 * 这是个要长期挂着的本地服务，崩一次就得手动重启。 */
process.on('uncaughtException', (e) => {
  console.error('[uncaught] ' + (e?.stack || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled] ' + (e?.stack || e));
});

server.listen(PORT, BIND, async () => {
  console.log('');
  console.log('  杠精法庭  ·  已启动');
  console.log(`  本机    http://127.0.0.1:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  局域网  http://${ip}:${PORT}   ← 手机连着同一个 WiFi 就能开`);
  if (BIND === '127.0.0.1') console.log('  （只绑了本机；设 BIND=0.0.0.0 可让局域网访问）');
  console.log('  关闭这个窗口即停止服务。');
  console.log('');
  try {
    const t = await resolveTarget();
    console.log(`  模型就绪：${t.keyEnv} / ${t.model} @ ${t.baseURL}`);
  } catch (e) {
    console.log('  ⚠ 模型探测失败，游戏能开但法庭不会说话：');
    console.log('    ' + String(e.message || e).split('\n').join('\n    '));
  }
  console.log('');
});

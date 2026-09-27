// llm.mjs — provider 自动探测 + 密钥解析 + 统一 chat()
// 无第三方依赖，纯 Node 22+（内置 fetch）
import fs from 'node:fs';
import path from 'node:path';

/* ── 1. 从哪取 key（不落盘、不打印）───────────────────────────
 *
 * 优先级：环境变量 > game/.env > DSH 凭据文件
 *
 * 第三种是给「DeepSeek Harness」这个宿主环境用的可选项，
 * **只有显式设了 DSH_HOME 才会去读** —— 不设就完全跳过。
 * （以前这里硬编码了一个本机路径当默认值，对别人毫无意义，
 *   而且会让人以为项目依赖某个特定的目录结构。）
 */
export function readCredential(name) {
  if (process.env[name]) return process.env[name];

  // 允许游戏目录下放一个 .env 覆盖（最简单的用户自定义方式）
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  }

  const dshHome = process.env.DSH_HOME;
  if (!dshHome) return null;
  const file = path.join(dshHome, '.credentials.yaml');
  if (!fs.existsSync(file)) return null;
  let inRefs = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs) {
      if (/^\S/.test(line)) break;                     // 离开 refs 块
      const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(\S+)\s*$/);
      if (m && m[1] === name) return m[2];
    }
  }
  return null;
}

/* ── 2. 候选 provider：按顺序探测，第一个能用的胜出 ─────────── */
//
// 默认只认 DeepSeek 官方。要把别的中转站/自建端点接进来，不用改代码，
// 设两个环境变量即可：
//     EXTRA_API_KEY=sk-xxx
//     EXTRA_BASE_URL=https://your-endpoint.example.com/v1
//     EXTRA_MODEL=deepseek-chat          （可选，默认 deepseek-chat）
//
// 关于模型的实测记录（2026-09）：
//   · 官方价目页只列 deepseek-flash(V4.1-Flash) 和 deepseek-v4-pro；
//     deepseek-chat 是旧名、仍可用，单价约为 flash 的 2 倍。
//   · deepseek-flash 默认开启思考模式 —— 长提示词 + 小 max_tokens 时，
//     思考会把预算烧光导致正文为空。chat() 已默认关闭思考并对此显式报错。

const CANDIDATES = [
  { keyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-flash'] },
];

// 可选的自定义端点（不设就不加进来）
if (process.env.EXTRA_BASE_URL && readCredential('EXTRA_API_KEY')) {
  CANDIDATES.push({
    keyEnv: 'EXTRA_API_KEY',
    baseURL: process.env.EXTRA_BASE_URL,
    models: [process.env.EXTRA_MODEL || 'deepseek-chat'],
  });
}

/** 想固定用某个模型：在 game\.env 里写 MODEL_KEY_ENV / MODEL_NAME（可只写一个） */
const PREFERRED_KEY_ENV = process.env.MODEL_KEY_ENV || null;
const PREFERRED_MODEL = process.env.MODEL_NAME || null;

let TARGET = null;                                      // { key, baseURL, model, keyEnv }

async function probe(baseURL, key, model) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: ctl.signal,
    });
    if (r.ok) return true;
    const body = await r.text().catch(() => '');
    return { err: `${r.status} ${body.slice(0, 200)}` };
  } catch (e) {
    return { err: String(e.message || e) };
  } finally { clearTimeout(t); }
}

export async function resolveTarget({ force = false, log = console.error } = {}) {
  if (TARGET && !force) return TARGET;
  const problems = [];

  // 有偏好就把该候选提到最前；但不会因此跳过探测，指定错了仍自动回落
  const ordered = PREFERRED_KEY_ENV
    ? [...CANDIDATES].sort((a, b) => (b.keyEnv === PREFERRED_KEY_ENV) - (a.keyEnv === PREFERRED_KEY_ENV))
    : CANDIDATES;

  for (const c of ordered) {
    const key = readCredential(c.keyEnv);
    if (!key) { problems.push(`${c.keyEnv}: 未找到密钥`); continue; }
    const models = (PREFERRED_MODEL && (!PREFERRED_KEY_ENV || c.keyEnv === PREFERRED_KEY_ENV))
      ? [PREFERRED_MODEL, ...c.models.filter(m => m !== PREFERRED_MODEL)]
      : c.models;
    for (const model of models) {
      const res = await probe(c.baseURL, key, model);
      if (res === true) {
        TARGET = { key, baseURL: c.baseURL, model, keyEnv: c.keyEnv };
        log(`[llm] 使用 ${c.keyEnv} @ ${c.baseURL} / ${model}`);
        return TARGET;
      }
      problems.push(`${c.keyEnv} / ${model}: ${res.err}`);
    }
  }
  TARGET = null;
  const err = new Error('没有可用的模型端点：\n  ' + problems.join('\n  '));
  err.problems = problems;
  throw err;
}

/* ── 3. 统一调用 ──────────────────────────────────────────── */

/** 思考模式的开关参数（官方非标准字段，中转站不认识就会忽略） */
const THINK_ON = { thinking: { type: 'enabled' } };
const THINK_OFF = { thinking: { type: 'disabled' }, reasoning_effort: 'none', enable_thinking: false };

/**
 * @param thinking 默认 true —— 保留模型思考能力。
 *   注意官方文档明确写着：**思考模式下 temperature 会被忽略**，
 *   所以调用方不要指望用 temperature 控制多样性；多样性靠提示词本身。
 *   若某条链路不支持思考，模型会忽略该字段，不影响调用。
 * @param reasoningEffort 可选，'low' 可以压低思考强度以省钱
 */
export async function chat(messages, {
  maxTokens = 600, temperature = 1.0, json = true, timeoutMs = 90000,
  thinking = true, reasoningEffort = null,
} = {}) {
  const t = await resolveTarget();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const body = {
      model: t.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(thinking ? THINK_ON : THINK_OFF),
    };
    if (thinking && reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (json) body.response_format = { type: 'json_object' };

    const r = await fetch(`${t.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`上游 ${r.status}: ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw);
    const choice = data?.choices?.[0] || {};
    const text = choice.message?.content ?? '';
    const usage = data?.usage || null;
    const reasoning = choice.message?.reasoning_content || '';
    const finish = choice.finish_reason || '';

    // 空正文有两种可能：① 真的空 ② 思考模式把 max_tokens 预算烧光了（finish_reason=length）
    // 后者如果被当成正常回复，会静默产出空判决书 —— 必须显式报错。
    if (!String(text).trim()) {
      const reasonTok = usage?.completion_tokens_details?.reasoning_tokens;
      if (finish === 'length' && (reasoning || reasonTok)) {
        const err = new Error(`思考模式占满 max_tokens（${maxTokens}），正文为空。请调大 maxTokens 或关掉思考模式。`);
        err.code = 'THINKING_ATE_BUDGET';
        throw err;
      }
      if (reasoning) {
        const err = new Error('模型只输出了思考内容，正文为空。');
        err.code = 'EMPTY_CONTENT';
        throw err;
      }
    }

    return {
      text, usage, model: t.model, provider: t.keyEnv, finish, reasoning: reasoning || null,
      // 思考 token 单独抽出来：它按输出价计费，是最主要的成本来源
      thinkingTokens: usage?.completion_tokens_details?.reasoning_tokens
        ?? (usage?.completion_thinking_tokens || 0),
    };
  } finally { clearTimeout(timer); }
}

export function targetInfo() {
  if (!TARGET) return null;
  const { key, ...rest } = TARGET;                       // 绝不外泄 key
  return rest;
}

/* ── 4. 流式调用（解决"点一下要等十几秒"的体感问题）───────── */

/**
 * 流式调用。逐块回调 onText(累积文本)，返回和 chat() 一样的结构。
 * 用途：把模型吐字的过程实时转给前端，用户不用干等。
 *
 * @param onDelta (deltaText, fullText) => void   每收到一小段就回调
 */
export async function chatStream(messages, {
  maxTokens = 600, temperature = 1.0, json = true, timeoutMs = 180000,
  thinking = true, reasoningEffort = null,
} = {}, onDelta = null, onReasoning = null) {
  const t = await resolveTarget();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const body = {
      model: t.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      ...(thinking ? THINK_ON : THINK_OFF),
    };
    if (thinking && reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (json) body.response_format = { type: 'json_object' };

    const r = await fetch(`${t.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) {
      const raw = await r.text().catch(() => '');
      throw new Error(`上游 ${r.status}: ${raw.slice(0, 300)}`);
    }

    let full = '', reasoning = '', usage = null, finish = '';
    const reader = r.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';

    /* 把一行 SSE 解析掉；抽成函数是为了循环结束后还能复用一次 */
    const handleLine = (raw) => {
      const line = raw.trim();
      if (!line || !line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let j = null;
      try { j = JSON.parse(payload); } catch { return; }
      const d = j.choices?.[0]?.delta || {};
      if (j.usage) usage = j.usage;
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        if (onReasoning) { try { onReasoning(reasoning); } catch { /* 忽略 */ } }
      }
      if (d.content) {
        full += d.content;
        if (onDelta) { try { onDelta(d.content, full); } catch { /* 忽略 */ } }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split('\n');
      buf = chunks.pop() || '';
      for (const raw of chunks) handleLine(raw);
    }

    // 循环退出后 buf 里可能还剩最后一行没有换行结尾。
    // 官方文档明确：携带 usage 的块正是 [DONE] 之前最后一块 ——
    // 不补这一次解析就会把用量统计丢掉（花费显示为 0）。
    if (buf.trim()) handleLine(buf);

    return {
      text: full, usage, model: t.model, provider: t.keyEnv, finish, reasoning: reasoning || null,
      thinkingTokens: usage?.completion_tokens_details?.reasoning_tokens
        ?? (usage?.completion_thinking_tokens || 0),
    };
  } finally { clearTimeout(timer); }
}

/**
 * 从**尚未闭合**的 JSON 文本里，增量抠出某个字段的值。
 * 流式时模型还在吐，我们只想要能先显示的字段先出来。
 *
 * 关键：必须正确跳过转义（\" \\ \n），否则字符串边界会判断错。
 * @param partial 累积到的原始文本
 * @param field   字段名
 * @param opts.after 只在这个子串之后查找（用于区分嵌套里同名字段，
 *                   例如立案 JSON 里 prosecutor.opening 和 judge.opening 同叫 opening）
 * @returns 已能读到的字段值（可能不完整）
 */
export function peekJsonStringField(partial, field, opts = {}) {
  const s = String(partial || '');
  const from = typeof opts.after === 'string' ? s.indexOf(opts.after) : 0;
  if (from < 0) return '';
  const keyIdx = s.indexOf('"' + field + '"', Math.max(0, from));
  if (keyIdx < 0) return '';
  let i = s.indexOf(':', keyIdx + field.length + 2);
  if (i < 0) return '';
  i++;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== '"') return '';
  i++;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) break;                 // 转义还没吐完
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else if (n === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4) break;                // \uXXXX 还没吐完
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6; continue;
      } else out += n;
      i += 2; continue;
    }
    if (c === '"') break;                          // 字段结束
    out += c;
    i++;
  }
  return out;
}

// config.mjs — 运行时配置 + 开销统计（零 AI 调用）
//
// 为什么有这个文件：难度档位对开销影响很大，但它确实提升质量。
// 这个选择不该写死在代码里，交给玩家自己选。

/* ── 对抗强度（按局生效）──────────────────────────────────
 *
 * 「对抗强度」和「深度思考」是**两个独立的东西**，别再混在一起：
 *   · 对抗强度 severity → 改**提示词** → AI 下手的轻重
 *   · 深度思考 think    → 改**请求参数** → AI 要不要先想（影响速度）
 *
 * 一开始这两件事是同一个开关（叫"思考模式"），但那样"难度"名不副实：
 * 调难度却只改了速度，AI 该多凶还是多凶。现在拆开了。
 */
export const SEVERITY_LEVELS = {
  easy:   { label: '简单', note: '检察官按程序出牌，一次只谈一件证据，不主动翻旧账，量刑从宽' },
  normal: { label: '普通', note: '检察官会盯你的漏洞，该翻旧账就翻，按他自己的节奏来' },
  hard:   { label: '困难', note: '检察官穷追猛打：优先翻旧账、主动传唤证人、要求从重，量刑更狠' },
};

/** 对抗强度：不合法/没传就退回「普通」 */
export function severityFor(pick) {
  return SEVERITY_LEVELS[pick] ? pick : 'normal';
}

/* ── 深度思考（按局生效）────────────────────────────────── */

/** 深度思考开关。底层就是「AI 要不要先想再开口」。
 *  只保留两档：实测 `reasoning_effort: 'low'` 不起作用（比默认还贵），
 *  没有真正的"中间档" —— 与其给个假的，不如只给两个真选项。
 *
 *  注意：这是**按局**生效的（存在 session 上），不是全局设置。
 *  全局开关本身就不成立（谁定的算数？），而且会被一个访客改掉所有人的体验。 */
export const THINK_LEVELS = {
  off:  { label: '关闭', thinking: false, note: '张口就来：反应快，但引用会宽一些、旧账记得浅' },
  full: { label: '开启', thinking: true,  note: '先想再开口：引用更刁、翻旧账更狠、判词更长。每次要多等几秒' },
};

/**
 * 决定这次调用用哪一档。
 * 优先级：本局难度 > 环境变量 > 默认值
 */
export function thinkFor(stage, override) {
  const env = (process.env.THINK_LEVEL || '').trim();
  // 默认 off：开启思考时单次要 11–17 秒，用户明确反馈"点一下等太久"。
  // 想默认就难一点，把 THINK_LEVEL 设成 full。
  const level = (override && THINK_LEVELS[override]) ? override
    : (THINK_LEVELS[env] ? env : 'off');
  const cfg = THINK_LEVELS[level];
  return { level, thinking: cfg.thinking };
}

/* ── 开销统计 ────────────────────────────────────────────── */

const PRICE = { hit: 0.003, miss: 0.15, out: 0.60 };   // USD / 1M，官方谷时
const CNY = 7.1;

const stats = {
  calls: 0,
  hitTokens: 0,
  missTokens: 0,
  outTokens: 0,
  thinkTokens: 0,
  usd: 0,
  startedAt: Date.now(),
};

/** 每次模型调用后记一笔 */
export function recordUsage(usage, thinkingTokens = 0) {
  const u = usage || {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  // 注意：官方定义 prompt_tokens = hit + miss。
  // 有些中转站只回 hit 和 prompt_tokens、不回 miss，
  // 这时若直接拿 prompt_tokens 当 miss，命中部分会被按未命中**再算一遍**
  // （0.003 与 0.15 USD/1M 差 50 倍），花费会严重虚高。
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - hit);
  const out = u.completion_tokens ?? 0;
  const usd = hit / 1e6 * PRICE.hit + miss / 1e6 * PRICE.miss + out / 1e6 * PRICE.out;
  stats.calls++;
  stats.hitTokens += hit;
  stats.missTokens += miss;
  stats.outTokens += out;
  stats.thinkTokens += thinkingTokens || 0;
  stats.usd += usd;
  return usd * CNY;
}

export function usageSummary() {
  const inTok = stats.hitTokens + stats.missTokens;
  return {
    calls: stats.calls,
    inputTokens: inTok,
    cacheHitTokens: stats.hitTokens,
    cacheHitRate: inTok ? +(stats.hitTokens / inTok * 100).toFixed(1) : 0,
    outputTokens: stats.outTokens,
    thinkingTokens: stats.thinkTokens,
    thinkingShare: stats.outTokens ? +(stats.thinkTokens / stats.outTokens * 100).toFixed(1) : 0,
    cny: +((stats.usd * CNY).toFixed(6)),
    minutes: +((Date.now() - stats.startedAt) / 60000).toFixed(1),
  };
}

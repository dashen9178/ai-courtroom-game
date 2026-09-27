// verify-appeal.mjs — 只验证上诉这一条路径（1 次调用，≈¥0.01）
import { chat } from './llm.mjs';
import { appealUserPrompt, APPEAL_STATIC } from './prompts.mjs';
import { DEMO_CASE, DEMO_RESULT } from './demo.mjs';

const session = {
  case: DEMO_CASE,
  result: DEMO_RESULT,
  credibility: -2,
  round: 3,
  clerkNotes: [
    { n: 1, quote: '法官大人，我承认我按了闹钟。', note: '自认按了闹钟', round: 0 },
    { n: 2, quote: '那二十五分钟是我用加班换来的。', note: '与"我没碰过闹钟"矛盾', round: 1 },
  ],
  grudges: DEMO_RESULT.case ? [
    { n: 1, quote: '法官大人，我承认我按了闹钟。但按掉闹钟不等于偷走早晨，我只是在跟它协商。', note: '已自认按了闹钟', level: 4, raised: 2 },
  ] : [],
  appealNote: '一审未说明为何不采纳我的加班记录，且判决主文超出起诉范围。',
};

console.log('上诉路径单独验证（1 次调用）');
console.log('─'.repeat(66));
console.log('system 长度 ' + APPEAL_STATIC.length + ' 字 / user 长度 ' + appealUserPrompt(session).length + ' 字');

const t0 = Date.now();
const r = await chat(
  [{ role: 'system', content: APPEAL_STATIC }, { role: 'user', content: appealUserPrompt(session) }],
  { maxTokens: 8000, temperature: 1.0, thinking: true }
);
const ms = Date.now() - t0;

const u = r.usage || {};
const think = r.thinkingTokens || 0;
const out = u.completion_tokens || 0;
const cost = ((u.prompt_cache_hit_tokens || 0) / 1e6 * 0.003
  + (u.prompt_cache_miss_tokens || u.prompt_tokens || 0) / 1e6 * 0.15
  + out / 1e6 * 0.60) * 7.1;

console.log(`${ms}ms  finish=${r.finish}  输出 ${out} tok（思考 ${think}）  花费 ¥${cost.toFixed(5)}`);
console.log('');

let j = null;
try {
  let s = String(r.text).trim();
  const f = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (f) s = f[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  j = JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
} catch (e) { console.log('❌ JSON 解析失败'); }

if (!j) { console.log('原文开头：' + String(r.text).slice(0, 300)); process.exit(1); }

console.log('字段检查：');
const NEED = ['appeal_result', 'appeal_reason', 'appeal_text', 'appeal_sentence', 'appeal_title', 'judge_comment_on_appeal'];
let pass = 0;
for (const k of NEED) {
  const ok = j[k] && String(j[k]).trim();
  console.log(`  ${ok ? '✅' : '❌'} ${k}`);
  if (ok) pass++;
}
console.log('');
console.log('裁定结果：' + j.appeal_result);
console.log('理由：' + j.appeal_reason);
console.log('处理：' + j.appeal_sentence);
console.log('一审法官反应：' + j.judge_comment_on_appeal);
console.log('');
console.log('裁定书正文：\n' + String(j.appeal_text || '').slice(0, 400));
console.log(`\n通过 ${pass} / ${NEED.length}`);
process.exit(pass === NEED.length ? 0 : 1);

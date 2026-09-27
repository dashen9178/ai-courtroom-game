// measure-one.mjs — 只测**一次**调用，精确分离思考 token 占比（省钱用）
// 用法： node measure-one.mjs [dad|verdict] [on|off]
//   dad     检察官+法官同一次回击（默认）
//   verdict 判决书
//   on/off  是否开启思考（默认 on）
import { chat } from './llm.mjs';
import { daSystemPrompt, daUserPrompt, verdictSystemPrompt, verdictUserPrompt } from './prompts.mjs';
import { DEMO_CASE, DEMO_TRANSCRIPT, DEMO_TRANSCRIPT as _t } from './demo.mjs';

const which = process.argv[2] || 'dad';
const thinking = (process.argv[3] || 'on') === 'on';

const P = { hit: 0.003, miss: 0.15, out: 0.60 };   // USD / 1M（谷时）
const CNY = 7.1;

const session = {
  intensity: 'free', round: 2, case: DEMO_CASE,
  grudges: [], judgeLedger: [],
  transcript: DEMO_TRANSCRIPT.map(t => ({ role: t.role, content: t.content })),
};
// 从 demo 记录里造出被告原话，让引用校验有东西可比
const lines = DEMO_TRANSCRIPT.filter(t => t.role === 'defendant').map(t => t.content);

const isDa = which === 'dad';
const system = isDa ? daSystemPrompt(session) : verdictSystemPrompt(session);
const user = isDa ? daUserPrompt(session) : verdictUserPrompt(session);

console.log(`单次调用测量：${isDa ? '检察官+法官回击' : '判决书'}   思考=${thinking ? '开启' : '关闭'}`);
console.log(`system ${system.length} 字 / user ${user.length} 字`);
console.log('─'.repeat(70));

const t0 = Date.now();
const r = await chat(
  [{ role: 'system', content: system }, { role: 'user', content: user }],
  { maxTokens: isDa ? 4000 : 8000, temperature: 1.05, thinking }
);
const ms = Date.now() - t0;

const u = r.usage || {};
const hit = u.prompt_cache_hit_tokens ?? 0;
const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens || 0);
const out = u.completion_tokens || 0;
const think = r.thinkingTokens || 0;
const answer = Math.max(0, out - think);

const costIn = (hit / 1e6 * P.hit + miss / 1e6 * P.miss) * CNY;
const costThink = think / 1e6 * P.out * CNY;
const costAnswer = answer / 1e6 * P.out * CNY;
const total = costIn + costThink + costAnswer;

console.log(`${ms}ms   finish=${r.finish}`);
console.log('');
console.log(`输入     ${String(miss).padStart(5)} tok (缓存命中 ${hit})   ¥${costIn.toFixed(6)}   ${(costIn / total * 100).toFixed(1)}%`);
console.log(`思考     ${String(think).padStart(5)} tok              ¥${costThink.toFixed(6)}   ${(costThink / total * 100).toFixed(1)}%`);
console.log(`正文     ${String(answer).padStart(5)} tok              ¥${costAnswer.toFixed(6)}   ${(costAnswer / total * 100).toFixed(1)}%`);
console.log('─'.repeat(70));
console.log(`本次合计 ¥${total.toFixed(6)}     思考占 ${((think / Math.max(1, out)) * 100).toFixed(0)}% 的输出 token`);
console.log('');
console.log('输出内容开头：' + JSON.stringify(String(r.text).slice(0, 150)));

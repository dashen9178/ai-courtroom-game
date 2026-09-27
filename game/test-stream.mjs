// test-stream.mjs — 流式 JSON 字段提取器的离线单测（零 AI 调用）
// 这个函数在流式输出里负责"边吐边显示"，转义处理写错就会显示乱码或截断。
import { peekJsonStringField } from './llm.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
};

const t = (input, field, want) => {
  const got = peekJsonStringField(input, field);
  ok(`${field} ← ${JSON.stringify(input.slice(0, 46))}`, got === want, `得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
};

console.log('\n── 基本提取 ──');
t('{"prosecutor": "被告你听着', 'prosecutor', '被告你听着');
t('{"prosecutor": "完整了", "judge_note": "法官说', 'prosecutor', '完整了');
t('{"prosecutor": "完整了", "judge_note": "法官说', 'judge_note', '法官说');
t('{"prosecutor": ""', 'prosecutor', '');

console.log('\n── 转义处理（最容易写错的地方）──');
t('{"prosecutor": "他说\\"协商\\"两', 'prosecutor', '他说"协商"两');
t('{"prosecutor": "第一行\\n第二', 'prosecutor', '第一行\n第二');
t('{"prosecutor": "制表\\t符', 'prosecutor', '制表\t符');
t('{"prosecutor": "反斜杠\\\\已经', 'prosecutor', '反斜杠\\已经');
t('{"prosecutor": "unicode \\u4f60\\u597d', 'prosecutor', 'unicode 你好');

console.log('\n── 不完整输入（流还没吐完）──');
t('{"prosecutor": "转义刚开\\', 'prosecutor', '转义刚开');
t('{"prosecutor": "unicode \\u4f', 'prosecutor', 'unicode ');
t('{"prosecutor": "', 'prosecutor', '');
t('{"prosecutor"', 'prosecutor', '');
t('{"prosecu', 'prosecutor', '');

console.log('\n── 边界与健壮性 ──');
t('{"judge_note": "只有法官', 'prosecutor', '');
t('', 'prosecutor', '');
ok('null 输入不崩', peekJsonStringField(null, 'prosecutor') === '');
ok('字段名不存在返回空', peekJsonStringField('{"other": "x"}', 'prosecutor') === '');
ok('值不是字符串（数字）返回空', peekJsonStringField('{"prosecutor": 123}', 'prosecutor') === '');
ok('长文本不丢字符', (() => {
  const body = '被告'.repeat(300);
  return peekJsonStringField('{"prosecutor": "' + body, 'prosecutor') === body;
})());

console.log('\n── 嵌套：区分 prosecutor.opening 与 judge.opening ──');
const nested = '{"case_title":"偷早晨案","charge":"侵占公共晨光","prosecutor":{"name":"严","opening":"被告，本席只谈时间。"},"judge":{"name":"陈","opening":"坐下吧。"}}';
ok('prosecutor.opening 取到检察官的', peekJsonStringField(nested, 'opening', { after: '"prosecutor"' }) === '被告，本席只谈时间。');
ok('judge.opening 取到法官的', peekJsonStringField(nested, 'opening', { after: '"judge"' }) === '坐下吧。');
ok('不指定 after 时取第一个 opening', peekJsonStringField(nested, 'opening') === '被告，本席只谈时间。');
ok('after 指定的键还没出现 → 返回空（不是拿错别人的）', peekJsonStringField('{"prosecutor":', 'opening', { after: '"judge"' }) === '');
ok('case_title / charge 正常', peekJsonStringField(nested, 'case_title') === '偷早晨案'
  && peekJsonStringField(nested, 'charge') === '侵占公共晨光');

console.log('\n── 模拟真实流式分片（逐字喂入，结果必须单调增长且最终一致）──');
const fullJson = '{"attitude":"冷","prosecutor":"被告，你说\\"我按了闹钟\\"，这是自认。","judge_note":"本庭记下了。陈不急"}';
const want = '被告，你说"我按了闹钟"，这是自认。';
let prev = '', mono = true, everWrong = false;
for (let i = 1; i <= fullJson.length; i++) {
  const got = peekJsonStringField(fullJson.slice(0, i), 'prosecutor');
  if (!want.startsWith(got)) { everWrong = true; break; }   // 中途不允许出现"错误的已定型文本"
  if (got.length < prev.length) { mono = false; break; }    // 不允许回退
  prev = got;
}
ok('逐字喂入：中途内容始终是最终内容的前缀（不会显示错字再改）', !everWrong);
ok('逐字喂入：长度单调不回退', mono);
ok('逐字喂入：喂完整后结果正确', peekJsonStringField(fullJson, 'prosecutor') === want);

// 同样验证 judge_note
let prev2 = '', wrong2 = false;
const want2 = '本庭记下了。陈不急';
for (let i = 1; i <= fullJson.length; i++) {
  const got = peekJsonStringField(fullJson.slice(0, i), 'judge_note');
  if (!want2.startsWith(got)) { wrong2 = true; break; }
  prev2 = got;
}
ok('judge_note 同样满足前缀单调性', !wrong2 && prev2 === want2);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);

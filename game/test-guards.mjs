// test-guards.mjs — 离线单测：引用校验 + 法官称呼 + 两本账 + 判词签名（不调 AI、不起服务）
import {
  ensureQuote, fixJudgeName, mergeGrudges, mergeBothLedgers, markRecalled, splitJudgeSign,
  clampMood, winChance, moodLabel, evidenceState, pendingEvidenceCount,
  STRATEGIES, getStrategy, mergeClerkNotes, normalizeJudgeAction, closingCoverage, appealChance,
  toIndex, CRED_MIN, CRED_MAX, escapeRawControlChars, extractJson, pickList, CASE_FALLBACKS,
} from './guards.mjs';
// 两个旋钮：深度思考（思考开关）和对抗强度（提示词凶不凶），必须一起测
import { THINK_LEVELS, thinkFor, SEVERITY_LEVELS, severityFor } from './config.mjs';
// 对抗强度改的是提示词，所以要直接检查拼出来的提示词
import { daSystemPrompt, verdictSystemPrompt, DA_STATIC } from './prompts.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')); }
}

console.log('\n── ensureQuote：引用校验 ──');

const LINES = [
  '法官大人，我承认我按了闹钟。但按掉闹钟不等于偷走早晨，我只是在跟它协商。',
  '那二十五分钟是我用加班换来的。',
  '你们谁愿意要，现在就可以拿去。',
];

ok('逐字引用 → 命中，且输出原句',
  (() => { const r = ensureQuote(LINES[0], LINES); return r.exact && r.quoted === LINES[0]; })());

ok('引用时标点不同（模型换了引号/句号）→ 仍命中',
  (() => {
    const r = ensureQuote('法官大人 我承认我按了闹钟 但按掉闹钟不等于偷走早晨 我只是在跟它协商', LINES);
    return r.exact && r.quoted === LINES[0];
  })());

ok('只引后半段（>=6字）→ 判命中，但输出补全为原句',
  (() => {
    const r = ensureQuote('但按掉闹钟不等于偷走早晨，我只是在跟它协商。', LINES);
    return r.exact && r.quoted === LINES[0];
  })());

ok('完全没引用（空）→ 兜底挑最近几句里最长的一句（第 1 句 36 字最长）',
  (() => { const r = ensureQuote('', LINES); return !r.exact && r.quoted === LINES[0]; })());

ok('胡编一句不在记录里的话 → 兜底，不采信',
  (() => { const r = ensureQuote('我从没说过这句话我要去告你', LINES); return !r.exact && LINES.includes(r.quoted); })());

ok('被告一句话没说 → 返回空、不崩',
  (() => { const r = ensureQuote('随便', []); return r.quoted === '' && r.exact === false; })());

ok('传 undefined → 不崩', (() => { const r = ensureQuote(undefined, undefined); return r.quoted === ''; })());

ok('兜底挑的是"最长"，不是"最近"',
  (() => {
    const lines = ['短句。', '这是一句中等长度的辩护词。', '这是最近的一句但比较短。'];
    const r = ensureQuote('', lines);
    return r.quoted === lines[1];
  })());

ok('全名紧挨着「法官」时不能被改坏（贪婪匹配的坑）',
  (() => {
    const r = fixJudgeName('请陈不急法官裁决。', '陈不急');
    return !r.fixed && r.text === '请陈不急法官裁决。';
  })());

console.log('\n── fixJudgeName：法官称呼校验 ──');

ok('叫错姓 → 纠正（实测案例：朱法官 → 陈法官）',
  (() => { const r = fixJudgeName('朱法官，请记录。', '陈不急'); return r.fixed && r.text === '陈法官，请记录。'; })());

ok('本来就对 → 不动',
  (() => { const r = fixJudgeName('陈法官，请记录。', '陈不急'); return !r.fixed && r.text === '陈法官，请记录。'; })());

ok('用全名 → 不动',
  (() => { const r = fixJudgeName('请陈不急法官裁决。', '陈不急'); return !r.fixed && r.text === '请陈不急法官裁决。'; })());

ok('一句话里出现两次错姓 → 两处都改',
  (() => { const r = fixJudgeName('朱法官，朱法官，请记录。', '陈不急'); return r.fixed && r.text === '陈法官，陈法官，请记录。'; })());

ok('⚠ 取舍：正文里连着词的「X法官」不改（宁可漏改不可误改）',
  (() => {
    // 「被告称王法官会帮他」里 pre 是"称王"（长度 2），不是独立称呼。
    // 这是刻意的：同样的形状里藏着「谢谢法官」「审判长和法官」，
    // 而"谢""和"也都是姓氏，靠姓氏表分不开。宁可放过，不能把正文改烂。
    const r = fixJudgeName('被告称王法官会帮他，但本案只有陈法官。', '陈不急');
    return r.text === '被告称王法官会帮他，但本案只有陈法官。' && r.fixed === false;
  })());

ok('不会把「谢谢法官」改成「谢陈法官」', (() => {
  const r = fixJudgeName('谢谢法官。', '陈不急');
  return r.text === '谢谢法官。' && r.fixed === false;
})());

ok('不会把「审判长和法官」改成「审判长陈法官」', (() => {
  const r = fixJudgeName('审判长和法官都听见了。', '陈不急');
  return r.text === '审判长和法官都听见了。' && r.fixed === false;
})());

ok('不会把「各位法官」改成「各陈法官」', (() => {
  const r = fixJudgeName('各位法官，请听我说。', '陈不急');
  return r.text === '各位法官，请听我说。' && r.fixed === false;
})());

ok('独立称呼「朱法官」正常纠正为「陈法官」', (() => {
  const r = fixJudgeName('朱法官，请记录。', '陈不急');
  return r.text === '陈法官，请记录。' && r.fixed === true;
})());

ok('标点后的独立称呼也能纠正', (() => {
  const r = fixJudgeName('本庭认为，朱法官的意见不予采纳。', '陈不急');
  return r.text === '本庭认为，陈法官的意见不予采纳。';
})());

ok('没有「法官」二字 → 完全不动',
  (() => { const r = fixJudgeName('被告，本庭问你话。', '陈不急'); return !r.fixed && r.text === '被告，本庭问你话。'; })());

ok('空输入 / 无名字 → 不崩、原样返回',
  (() => fixJudgeName('', '陈不急').text === '' && fixJudgeName(null, '陈不急').text === '' && fixJudgeName('朱法官', '').text === '朱法官')());

ok('复姓或两字姓的法官名 → 取首字当姓',
  (() => { const r = fixJudgeName('朱法官你好', '欧阳不判'); return r.text === '欧法官你好'; })());

console.log('\n── mergeGrudges：小本本合并与防线 ──');

const SAID = [
  '法官大人，我承认我按了闹钟。但按掉闹钟不等于偷走早晨，我只是在跟它协商。',
  '那二十五分钟是我用加班换来的。',
];

ok('add：引语命中被告原话 → 入账，编号从 1 开始',
  (() => {
    const r = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: '他已自认按了闹钟', level: 3 }], SAID, 0);
    return r.grudges.length === 1 && r.grudges[0].n === 1 && r.grudges[0].quote === SAID[0]
      && r.grudges[0].level === 3 && r.grudges[0].raised === 0 && r.added.length === 1;
  })());

ok('add：引语是编造的（原话里没有）→ 丢弃，不入账',
  (() => {
    const r = mergeGrudges([], [{ action: 'add', quote: '我从没说过这句话', note: 'x', level: 3 }], SAID, 0);
    return r.grudges.length === 0 && r.added.length === 0;
  })());

ok('add：引语只是原话里的一段（>=6字）→ 采信，但存的是完整原句',
  (() => {
    const r = mergeGrudges([], [{ action: 'add', quote: '我只是在跟它协商', note: 'x', level: 2 }], SAID, 0);
    return r.grudges.length === 1 && r.grudges[0].quote === SAID[0];
  })());

ok('add：同一条（归一化后相同）不重复入账',
  (() => {
    const first = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: 'a', level: 2 }], SAID, 0);
    const second = mergeGrudges(first.grudges, [{ action: 'add', quote: SAID[0], note: 'b', level: 2 }], SAID, 1);
    return second.grudges.length === 1;
  })());

ok('add：缺 note 或空 quote → 丢弃',
  (() => {
    const a = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: '', level: 2 }], SAID, 0);
    const b = mergeGrudges([], [{ action: 'add', quote: '', note: 'x', level: 2 }], SAID, 0);
    return a.grudges.length === 0 && b.grudges.length === 0;
  })());

ok('escalate：编号存在 → 升级，且只升不降',
  (() => {
    let r = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: 'a', level: 2 }], SAID, 0);
    r = mergeGrudges(r.grudges, [{ action: 'escalate', n: 1, level: 4, note: '加重了' }], SAID, 1);
    const up = r.grudges[0].level === 4 && r.grudges[0].note === '加重了';
    r = mergeGrudges(r.grudges, [{ action: 'escalate', n: 1, level: 1 }], SAID, 2);
    return up && r.grudges[0].level === 4;                 // 降到 1 应被忽略
  })());

ok('escalate：编号不存在 → 丢弃（不新建、不崩）',
  (() => {
    const r = mergeGrudges([], [{ action: 'escalate', n: 99, level: 5, note: 'x' }], SAID, 0);
    return r.grudges.length === 0 && r.escalated.length === 0;
  })());

ok('level 会被夹到 1..5',
  (() => {
    const hi = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: 'a', level: 99 }], SAID, 0);
    const lo = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: 'a', level: -3 }], SAID, 0);
    return hi.grudges[0].level === 5 && lo.grudges[0].level === 1;
  })());

ok('grudge_update 非数组 / 全是垃圾 → 安全返回原状',
  (() => {
    const a = mergeGrudges([], 'nonsense', SAID, 0);
    const b = mergeGrudges([], [null, 42, { action: 'what' }], SAID, 0);
    return a.grudges.length === 0 && b.grudges.length === 0;
  })());

ok('超过上限 8 条 → 逐条淘汰最轻的，且报告 dropped',
  (() => {
    // 用 lines[0..8] 建 9 条；第 0 条 level=1（唯一一条最轻），其余 level=5
    const lines = Array.from({ length: 10 }, (_, i) => `这是第${i}句被告原话，长度足够用来测试上限。`);
    let g = [];
    for (let i = 0; i <= 8; i++) {
      g = mergeGrudges(g, [{ action: 'add', quote: lines[i], note: 'n' + i, level: i === 0 ? 1 : 5 }], lines, i).grudges;
    }
    if (g.length !== 8 || g.some(x => x.quote === lines[0])) return false;   // 建到 9 条时最轻的应已被丢
    // 再新增第 10 条（全新，不重复）→ 又要丢一条，这次只能丢剩下的 level=5 里最旧的那条
    const r = mergeGrudges(g, [{ action: 'add', quote: lines[9], note: 'n9', level: 5 }], lines, 9);
    return r.dropped === 1 && r.grudges.length === 8 && r.grudges.some(x => x.quote === lines[9]);
  })());

ok('淘汰顺序：同重量时优先淘汰最久没提的',
  (() => {
    const lines = Array.from({ length: 10 }, (_, i) => `第${i}句话在这里，够长。`);
    let g = [];
    for (let i = 0; i <= 7; i++) {
      g = mergeGrudges(g, [{ action: 'add', quote: lines[i], note: 'n' + i, level: 5 }], lines, i).grudges;
    }
    // 全员标成"提过"，唯独第 3 条最久没提（lastRaisedRound=0）
    g = g.map(x => ({ ...x, raised: 1, lastRaisedRound: 10 }));
    const victim = g.find(x => x.quote === lines[3]);
    victim.lastRaisedRound = 0;
    // 新增一条全新的（lines[9]，且 lines[8] 未用过，避免"同一条"干扰）
    const r = mergeGrudges(g, [{ action: 'add', quote: lines[9], note: 'n9', level: 5 }], lines, 11);
    return r.dropped === 1 && !r.grudges.some(x => x.n === victim.n) && r.grudges.some(x => x.quote === lines[9]);
  })());

ok('淘汰顺序：重量与"提过时间"都同分时，丢记下时间最早的',
  (() => {
    const lines = Array.from({ length: 10 }, (_, i) => `第${i}句话在这里，够长。`);
    let g = [];
    for (let i = 0; i <= 7; i++) {
      g = mergeGrudges(g, [{ action: 'add', quote: lines[i], note: 'n' + i, level: 5 }], lines, i).grudges;
    }
    // 全体同分（都没提过、重量一样）→ 应丢 firstRound 最小的那条
    const expectGone = g.reduce((a, b) => (a.firstRound <= b.firstRound ? a : b));
    const r = mergeGrudges(g, [{ action: 'add', quote: lines[9], note: 'n9', level: 5 }], lines, 11);
    return r.dropped === 1 && !r.grudges.some(x => x.n === expectGone.n) && r.grudges.some(x => x.quote === lines[9]);
  })());

ok('回归：小本本已满时，刚记下的新账绝不能被当场淘汰',
  (() => {
    // 曾经的真 bug：从没提过的条目被当成 lastRaisedRound=-1，
    // 于是"最新记下的"反而成了"最久没提的"，一进小本本就被扔掉。
    const lines = Array.from({ length: 12 }, (_, i) => `第${i}句话在这里，够长。`);
    let g = [];
    for (let i = 0; i <= 7; i++) {
      g = mergeGrudges(g, [{ action: 'add', quote: lines[i], note: 'n' + i, level: 5 }], lines, i).grudges;
    }
    if (g.length !== 8) return false;
    // 满员状态下再记一条全新的账
    const r = mergeGrudges(g, [{ action: 'add', quote: lines[8], note: 'n8', level: 5 }], lines, 8);
    return r.added.length === 1
      && r.grudges.some(x => x.quote === lines[8])          // 新账必须在
      && r.dropped === 1                                     // 确实淘汰了一条
      && !r.grudges.some(x => x.quote === lines[0]);         // 被淘汰的是最旧的
  })());

console.log('\n── splitJudgeSign：法官判词签名 ──');

ok('末尾带全名签名 → 剥离出来，签名单独返回',
  (() => {
    const r = splitJudgeSign('本庭记下了。加班不是免责事由。陈不急', '陈不急');
    return r.text === '本庭记下了。加班不是免责事由。' && r.sign === '陈不急';
  })());

ok('带破折号/冒号等分隔符也能剥离',
  (() => {
    const a = splitJudgeSign('这条本庭记着。——陈不急', '陈不急');
    const b = splitJudgeSign('准了。陈不急 批注', '陈不急');
    return a.text === '这条本庭记着。' && a.sign === '陈不急'
      && b.text === '准了。' && b.sign === '陈不急';
  })());

ok('没签名 → 原文不动，sign 为 null',
  (() => {
    const r = splitJudgeSign('本庭记下了。加班不是免责事由。', '陈不急');
    return r.text === '本庭记下了。加班不是免责事由。' && r.sign === null;
  })());

ok('签名夹在中间（不在末尾）→ 不剥离，避免误切正文',
  (() => {
    const src = '陈不急说过这话，但本庭不认。';
    const r = splitJudgeSign(src, '陈不急');
    return r.text === src && r.sign === null;
  })());

ok('空输入 / 无名字 → 不崩',
  (() => splitJudgeSign('', '陈不急').sign === null && splitJudgeSign(null, '陈不急').text === ''
    && splitJudgeSign('随便', '').sign === null)());

console.log('\n── mergeBothLedgers：两本账一次合并（法官记忆零额外成本）──');

const SAID2 = [
  '法官大人，这事我可以解释，但你们得先承认程序有问题。',
  '我没做过，那天我在加班，根本没在场。',
];

ok('一次调用同时喂两本账 → 各归各的，互不串味',
  (() => {
    const r = mergeBothLedgers({ prosecutor: [], judge: [] }, {
      grudge_update: [{ action: 'add', quote: SAID2[0], note: '他在给程序挑刺', level: 3 }],
      ledge_update: [{ action: 'add', quote: SAID2[1], note: '拿加班当挡箭牌', level: 2 }],
    }, SAID2, 0, '陈不急');
    return r.prosecutor.length === 1 && r.judge.length === 1
      && r.prosecutor[0].note === '他在给程序挑刺'
      && r.judge[0].note === '拿加班当挡箭牌'
      && r.added.prosecutor.length === 1 && r.added.judge.length === 1;
  })());

ok('法官账里的编造引语同样被拦截（两本账共用同一道防线）',
  (() => {
    const r = mergeBothLedgers({ prosecutor: [], judge: [] }, {
      grudge_update: [],
      ledge_update: [{ action: 'add', quote: '我从没说过这句话', note: 'x', level: 3 }],
    }, SAID2, 0, '陈不急');
    return r.judge.length === 0;
  })());

ok('检察官账有、法官账空 → 也正常（不是每轮法官都记）',
  (() => {
    const r = mergeBothLedgers({ prosecutor: [], judge: [] }, {
      grudge_update: [{ action: 'add', quote: SAID2[0], note: '记下', level: 2 }],
      ledge_update: [],
    }, SAID2, 0, '陈不急');
    return r.prosecutor.length === 1 && r.judge.length === 0;
  })());

ok('两本账的编号各自独立从 1 开始',
  (() => {
    const r = mergeBothLedgers({ prosecutor: [], judge: [] }, {
      grudge_update: [{ action: 'add', quote: SAID2[0], note: 'a', level: 2 }],
      ledge_update: [{ action: 'add', quote: SAID2[1], note: 'b', level: 2 }],
    }, SAID2, 0, '陈不急');
    return r.prosecutor[0].n === 1 && r.judge[0].n === 1;
  })());

ok('store 里缺字段 / data 是垃圾 → 不崩，返回空两本',
  (() => {
    const a = mergeBothLedgers({}, {}, SAID2, 0, '陈不急');
    const b = mergeBothLedgers(undefined, undefined, SAID2, 0, '陈不急');
    return a.prosecutor.length === 0 && a.judge.length === 0
      && b.prosecutor.length === 0 && b.judge.length === 0;
  })());

console.log('\n── markRecalled：两个角色各自的打点 ──');

ok('检察官翻账 → 事件挂在 recalled 上',
  (() => {
    const g = mergeGrudges([], [{ action: 'add', quote: SAID2[0], note: 'a', level: 2 }], SAID2, 0).grudges;
    const r = markRecalled(g, 1, 1, 'recalled');
    return r.key === 'recalled' && r.event && r.event.n === 1 && r.event.times === 1;
  })());

ok('法官用扣分项 → 事件挂在 rule_used 上，两本账各记各的',
  (() => {
    const j = mergeGrudges([], [{ action: 'add', quote: SAID2[1], note: 'b', level: 2 }], SAID2, 0).grudges;
    const r = markRecalled(j, 1, 2, 'rule_used');
    return r.key === 'rule_used' && r.event && r.event.n === 1 && r.event.isCallback === false;
  })());

ok('法官重复用同一条 → isCallback=true',
  (() => {
    let j = mergeGrudges([], [{ action: 'add', quote: SAID2[1], note: 'b', level: 2 }], SAID2, 0).grudges;
    j = markRecalled(j, 1, 1, 'rule_used').list;
    const r = markRecalled(j, 1, 3, 'rule_used');
    return r.event.times === 2 && r.event.isCallback === true;
  })());

console.log('\n── 庭辩态势：可信度与胜诉概率 ──');

ok('可信度被夹在 -6..+6 之间', (() => {
  return clampMood(99, 0) === CRED_MAX && clampMood(-99, 0) === CRED_MIN;
})());

ok('可信度累加并在边界截断', (() => {
  return clampMood(3, 4) === CRED_MAX && clampMood(-3, -4) === CRED_MIN && clampMood(2, 0) === 2;
})());

ok('非法输入不会污染可信度（NaN/undefined → 原值）', (() => {
  return clampMood('abc', 2) === 2 && clampMood(undefined, -1) === -1 && clampMood(null, 0) === 0;
})());

ok('胜诉概率在 0–100，且随可信度单调递增', (() => {
  const ps = [-6, -4, -2, 0, 2, 4, 6].map(c => winChance(c));
  const inRange = ps.every(p => p >= 0 && p <= 100);
  const mono = ps.every((p, i) => i === 0 || p >= ps[i - 1]);
  return inRange && mono && winChance(0) === 50;
})());

ok('胜诉概率两端不会贴死 0/100（保留戏剧空间）', (() => {
  return winChance(CRED_MIN) > 0 && winChance(CRED_MAX) < 100;
})());

ok('档位文案随概率变化', (() => {
  return moodLabel(-6).key === 'losing' && moodLabel(0).key === 'even' && moodLabel(6).key === 'winning';
})());

console.log('\n── 证据逐轮推进 ──');

const EV4 = ['证据一', '证据二', '证据三', '证据四'];

ok('第 1 轮只出示第 1 件', (() => {
  const s = evidenceState(EV4, 0, 0);
  return s[0].status === 'shown' && s.slice(1).every(e => e.status === 'pending');
})());

ok('每轮多出示一件', (() => {
  return evidenceState(EV4, 1, 0).filter(e => e.status === 'shown').length === 2
    && evidenceState(EV4, 2, 0).filter(e => e.status === 'shown').length === 3
    && evidenceState(EV4, 3, 0).filter(e => e.status === 'shown').length === 4;
})());

ok('轮次超过证据数时不会出错，也不会重复', (() => {
  const s = evidenceState(EV4, 99, 0);
  return s.length === 4 && s.every(e => e.status === 'shown');
})());

ok('被告处于下风时检察官加速出示证据', (() => {
  const slow = evidenceState(EV4, 1, 0).filter(e => e.status === 'shown').length;
  const fast = evidenceState(EV4, 1, -3).filter(e => e.status === 'shown').length;
  return fast > slow;
})());

ok('空证据 / 非数组 → 不崩', (() => {
  return evidenceState([], 2, 0).length === 0 && evidenceState(null, 2, 0).length === 0;
})());

ok('pendingEvidenceCount 正确反映"还压着几张牌"', (() => {
  return pendingEvidenceCount(EV4, 0, 0) === 3 && pendingEvidenceCount(EV4, 3, 0) === 0;
})());

console.log('\n── 策略卡 ──');

ok('五张策略卡齐备且 id 唯一', (() => {
  return STRATEGIES.length === 5 && new Set(STRATEGIES.map(s => s.id)).size === 5;
})());

ok('每张卡都有名字、图标、提示、指令', (() => {
  return STRATEGIES.every(s => s.id && s.name && s.icon && s.hint && s.instruction && s.instruction.length > 20);
})());

ok('按 id 取卡正确，取不到返回 null', (() => {
  return getStrategy('counter').id === 'counter' && getStrategy('不存在') === null;
})());

console.log('\n── 书记员：客观矛盾记录 ──');

const SAID3 = [
  '我从没去过那个地方，那天我在公司加班到深夜。',
  '我承认我路过了一下，只待了不到一分钟。',
];

ok('记住事实性矛盾，引语逐字校验', (() => {
  const r = mergeClerkNotes([], [{ quote: SAID3[1], note: '与第一轮"从没去过"矛盾' }], SAID3, 1);
  return r.notes.length === 1 && r.notes[0].quote === SAID3[1] && r.notes[0].round === 1 && r.added.length === 1;
})());

ok('编造的引语被丢弃（与两本账同一道防线）', (() => {
  const r = mergeClerkNotes([], [{ quote: '我没说过这句', note: 'x' }], SAID3, 0);
  return r.notes.length === 0;
})());

ok('缺 quote 或 note → 丢弃', (() => {
  return mergeClerkNotes([], [{ quote: SAID3[0], note: '' }], SAID3, 0).notes.length === 0
    && mergeClerkNotes([], [{ quote: '', note: 'x' }], SAID3, 0).notes.length === 0;
})());

ok('不重复记录同一条', (() => {
  const a = mergeClerkNotes([], [{ quote: SAID3[0], note: 'n' }], SAID3, 0);
  const b = mergeClerkNotes(a.notes, [{ quote: SAID3[0], note: 'n2' }], SAID3, 1);
  return b.notes.length === 1;
})());

ok('非数组输入 → 安全返回', (() => {
  return mergeClerkNotes(null, null, SAID3, 0).notes.length === 0
    && mergeClerkNotes([], 'garbage', SAID3, 0).notes.length === 0;
})());

console.log('\n── 法官主动介入 ──');

ok('识别六种法官动作', (() => {
  const ids = ['gavel', 'warn', 'warn_da', 'rule', 'rush', 'side'];
  return ids.every(id => { const a = normalizeJudgeAction(id); return a && a.id === id && a.label; });
})());

ok('容忍模型的大小写与多余文字（"WARN_DA 训斥"也能识别）', (() => {
  return normalizeJudgeAction('WARN_DA 训斥')?.id === 'warn_da'
    && normalizeJudgeAction('敲槌 gavel 维持秩序')?.id === 'gavel';
})());

ok('空值 / 无法识别 → null（不崩、不误判）', (() => {
  return normalizeJudgeAction('') === null && normalizeJudgeAction(null) === null && normalizeJudgeAction('随便什么') === null;
})());

console.log('\n── 结案陈词评估 ──');

const CLOSE_SESSION = { case: { evidence: ['2026年3月14日06:47闹钟记录'] } };

ok('敷衍的短陈词：命中 0 项且判定为太短', (() => {
  const c = closingCoverage('我没什么好说的', CLOSE_SESSION);
  return c.hitCount === 0 && c.tooShort === true && c.bonus === 0;
})());

ok('完整的陈词：多项命中、有加分', (() => {
  const t = '检方的证据只是2026年3月14日的闹钟记录，这与判例第12号不一致，且我前后说法并无矛盾。'
    + '我当时的处境是连续加班，依照第12条，这不构成侵占。';
  const c = closingCoverage(t, CLOSE_SESSION);
  return c.hitCount >= 4 && c.bonus >= 3 && c.tooShort === false;
})());

ok('加分有上限（不会因为写得长就无限加分）', (() => {
  const t = '证据 判例 矛盾 法条 我的处境 ' + '很长的内容'.repeat(60);
  return closingCoverage(t, CLOSE_SESSION).bonus <= 5;
})());

ok('空陈词 → 不崩', (() => {
  const c = closingCoverage('', CLOSE_SESSION);
  return c.hitCount === 0 && c.tooShort === true;
})());

console.log('\n── 上诉翻案率 ──');

ok('可信度越高越容易翻案', (() => {
  return appealChance(4, 0, 0, 3) > appealChance(-4, 0, 0, 3);
})());

ok('矛盾记录越多越难翻案', (() => {
  return appealChance(2, 0, 0, 3) > appealChance(2, 3, 0, 3);
})());

ok('法官训斥过检察官 → 对被告有利', (() => {
  return appealChance(0, 1, 2, 3) > appealChance(0, 1, 0, 3);
})());

ok('翻案率夹在 3–92 之间（不会必然翻案，也不会完全没戏）', (() => {
  const lo = appealChance(-6, 12, 0, 0);
  const hi = appealChance(6, 0, 5, 20);
  return lo >= 3 && hi <= 92 && hi > lo;
})());

console.log('\n── toIndex：模型给的编号解析 ──');

ok('纯数字正常', toIndex(3) === 3 && toIndex('3') === 3);

ok('带 # 号也能解析（提示词自己教模型写 "#编号"）',
  toIndex('#3') === 3 && toIndex('# 2') === 2);

ok('「第 2 条」这种中文写法也能解析', toIndex('第 2 条') === 2 && toIndex('第2条') === 2);

ok('全角数字也能解析', toIndex('＃３') === 3 && toIndex('２') === 2);

ok('解析不出来返回 NaN（调用方据此判断，不会当成 0）',
  Number.isNaN(toIndex('abc')) && Number.isNaN(toIndex('')) && Number.isNaN(toIndex(null)));

ok('回归：mergeGrudges 能处理 "#3" 这样的编号（旧版 Number("#3")=NaN 会静默失效）',
  (() => {
    let r = mergeGrudges([], [
      { action: 'add', quote: SAID[0], note: 'a', level: 2 },
      { action: 'add', quote: SAID[1], note: 'b', level: 2 },
    ], SAID, 0);
    // 用 "#2" 升级第 2 条
    r = mergeGrudges(r.grudges, [{ action: 'escalate', n: '#2', level: 5 }], SAID, 1);
    return r.grudges.find(g => g.n === 2).level === 5;
  })());

ok('回归：markRecalled 能处理 "#1"（旧版会被当成"没翻旧账"）',
  (() => {
    const g = mergeGrudges([], [{ action: 'add', quote: SAID[0], note: 'a', level: 2 }], SAID, 0).grudges;
    const r = markRecalled(g, '#1', 1);
    return r.event && r.event.n === 1 && r.event.times === 1;
  })());

console.log('\n── 空串绕过防线（回归）──');

ok('玩家只发纯标点时，编造的引语不会被当成原话',
  (() => {
    // 归一化后是空串的发言
    const lines = ['……', '？？？'];
    const r = mergeGrudges([], [{ action: 'add', quote: '他承认了全部罪行', note: 'x', level: 3 }], lines, 0);
    // 旧版 '任意串'.includes('') 恒真 → 编造引语会被入账
    return r.grudges.length === 0;
  })());

ok('书记员笔录同样不被空串绕过',
  (() => {
    const lines = ['。。。'];
    const r = mergeClerkNotes([], [{ quote: '我早就承认过了', note: 'x' }], lines, 0);
    return r.notes.length === 0;
  })());

ok('正常发言仍然能被正确引用（没把防线收得过紧）',
  (() => {
    const lines = ['我从没去过那个地方，那天我在公司加班到深夜。'];
    const r = mergeGrudges([], [{ action: 'add', quote: '我从没去过那个地方', note: 'x', level: 2 }], lines, 0);
    return r.grudges.length === 1 && r.grudges[0].quote === lines[0];
  })());

ok('added 推的是真正入账的原句（前端靠它做高亮）',
  (() => {
    const lines = ['我没偷东西。'];
    const r = mergeGrudges([], [{ action: 'add', quote: '我没偷东西', note: 'x', level: 2 }], lines, 0);
    return r.added.length === 1 && r.added[0] === lines[0];
  })());

console.log('\n── escapeRawControlChars：模型吐裸控制字符时的 JSON 修复 ──');

// 真实事故复现：模型在 JSON 字符串里直接敲了回车，而不是输出 \n
const REAL_BAD = '{\n  "charge": "涉嫌偷走周一的早晨",\n  "opening": "坐下吧。\n今天这个案子，\n本庭要往细里审。"\n}';

ok('裸换行的字符串修完之后能 JSON.parse 成功',
  (() => { try { JSON.parse(escapeRawControlChars(REAL_BAD)); return true; } catch { return false; } })());

ok('原来的裸换行确实会让 JSON.parse 抛 Bad control character',
  (() => { try { JSON.parse(REAL_BAD); return false; } catch (e) { return /control character/i.test(e.message); } })());

ok('修完之后内容没丢：换行变回真的换行',
  (() => {
    const j = JSON.parse(escapeRawControlChars(REAL_BAD));
    return j.opening === '坐下吧。\n今天这个案子，\n本庭要往细里审。';
  })());

ok('字符串外面的换行是合法空白，必须保留（否则 pretty-print 全被弄坏）',
  (() => {
    const good = '{\n  "a": 1,\n  "b": "x"\n}';
    const fixed = escapeRawControlChars(good);
    return fixed === good && JSON.parse(fixed).a === 1;
  })());

ok('制表符在字符串外保留、在字符串内转义成 \\t',
  (() => {
    const s = '{\n\t"a": "x\ty"\n}';
    const fixed = escapeRawControlChars(s);
    return fixed.includes('\n\t"a"') && JSON.parse(fixed).a === 'x\ty';
  })());

ok('已经正确转义的 \\n 不会被二次转义',
  (() => {
    const good = '{"a": "x\\ny"}';
    const fixed = escapeRawControlChars(good);
    return fixed === good && JSON.parse(fixed).a === 'x\ny';
  })());

ok('转义引号后面的内容不受影响（状态机没被引号骗到）',
  (() => {
    const good = '{"a": "他说\\"你好\\"", "b": "c"}';
    const fixed = escapeRawControlChars(good);
    const j = JSON.parse(fixed);
    return fixed === good && j.a === '他说"你好"' && j.b === 'c';
  })());

ok('字符串外的非法控制字符（NUL / VT / FF）被丢掉',
  (() => {
    const s = '{"a"\u0000:\u000b 1,\u000c"b": 2}';
    const fixed = escapeRawControlChars(s);
    const j = JSON.parse(fixed);
    return j.a === 1 && j.b === 2;
  })());

ok('NUL 出现在字符串内部 → 转成 \\u0000 而不是被吞掉',
  (() => {
    const j = JSON.parse(escapeRawControlChars('{"a": "x\u0000y"}'));
    return j.a === 'x\u0000y';
  })());

ok('反斜杠后面跟裸换行（非法转义）也能修成合法 JSON',
  (() => { try { JSON.parse(escapeRawControlChars('{"a": "x\\\ny"}') ); return true; } catch { return false; } })());

ok('空输入 / null 不炸',
  (() => escapeRawControlChars('') === '' && escapeRawControlChars(null) === '')());

// extractJson 是生产里真正被调用的那个函数（server.mjs 的 chatJson 和
// 流式路径都走它），所以这些断言直接盯住出事现场。
ok('extractJson：裸换行的立案响应能解析出全部字段',
  (() => {
    const j = extractJson(REAL_BAD);
    return j.charge === '涉嫌偷走周一的早晨' && j.opening.includes('\n');
  })());

ok('extractJson：包在 ```json 代码块里也能解析',
  (() => {
    const j = extractJson('这是结果：\n```json\n' + REAL_BAD + '\n```\n以上。');
    return j.charge === '涉嫌偷走周一的早晨';
  })());

ok('extractJson：前后有废话时靠第一个 { 到最后一个 } 兜底',
  (() => {
    const j = extractJson('好的，我输出如下：{"a": 1} 希望有帮助');
    return j.a === 1;
  })());

ok('extractJson：真的没有 JSON 时明确报错（不要静默返回半成品）',
  (() => { try { extractJson('抱歉，我无法回答。'); return false; } catch (e) { return /没有 JSON/.test(e.message); } })());

ok('extractJson：空响应报错',
  (() => { try { extractJson(''); return false; } catch (e) { return /空响应/.test(e.message); } })());

ok('extractJson：JSON.parse("null") 不会被当成有效判决数据',
  (() => {
    // 这是原注释里提到的坑：parse 成功但得到 null，后面 data.xxx 会 TypeError。
    // extractJson 本身不管这层，由调用方判 —— 这里固化住"它确实返回 null"这个事实，
    // 防止有人误以为 extractJson 会兜住。
    return extractJson('null') === null;
  })());

console.log('\n── pickList：立案数组字段的本地兜底 ──');

ok('模型给了证人 → 原样用',
  (() => { const r = pickList(['被告家的闹钟'], 5, CASE_FALLBACKS.witnesses); return r.length === 1 && r[0] === '被告家的闹钟'; })());

ok('模型吐空数组 → 退回本地兜底（否则整局"证人出庭"不触发）',
  (() => { const r = pickList([], 5, CASE_FALLBACKS.witnesses); return r.length >= 2; })());

ok('字段缺失（undefined / null）→ 也走兜底',
  (() => pickList(undefined, 5, CASE_FALLBACKS.witnesses).length >= 2
       && pickList(null, 5, CASE_FALLBACKS.witnesses).length >= 2)());

ok('全是空白字符串 → 视为空，走兜底',
  (() => pickList(['   ', ''], 5, CASE_FALLBACKS.witnesses).length >= 2)());

ok('超长数组被截断到 max 条',
  (() => pickList(['a', 'b', 'c', 'd', 'e', 'f'], 3, []).length === 3)());

ok('默认兜底本身不为空（万一被写成空数组，兜底就白兜了）',
  (() => Object.values(CASE_FALLBACKS).every(v => Array.isArray(v) && v.length > 0))());

ok('四个字段的兜底都塞得进任何案子（不出现具体人名/时间）',
  (() => {
    const all = Object.values(CASE_FALLBACKS).flat().join('');
    return !/\d{4} 年 \d{1,2} 月|陈不急|严不怠/.test(all);
  })());

console.log('\n── 深度思考档位（对外叫"深度思考"，底层是 AI 要不要先想）──');

const savedEnv = process.env.THINK_LEVEL;

ok('两个档位都有，且没有假的中间档',
  (() => Object.keys(THINK_LEVELS).length === 2 && !!THINK_LEVELS.off && !!THINK_LEVELS.full)());

ok('对外叫「关闭 / 开启」，不再出现「省钱 / 全开 / 简单 / 困难」',
  (() => {
    const labels = Object.values(THINK_LEVELS).map(v => v.label);
    return labels.includes('关闭') && labels.includes('开启')
        && labels.every(l => !['省钱', '全开', '简单', '困难'].includes(l));
  })());

ok('档位说明里不含任何金额（玩家界面不提钱）',
  (() => Object.values(THINK_LEVELS).every(v => !/¥|元|价格|花费/.test(v.note)))());

ok('关闭档 = 不开思考（快）',
  (() => { delete process.env.THINK_LEVEL; return thinkFor('say', 'off').thinking === false; })());

ok('开启档 = 开思考（准）',
  (() => { delete process.env.THINK_LEVEL; return thinkFor('say', 'full').thinking === true; })());

ok('传入的档位覆盖环境变量（这是"按局生效"能成立的前提）',
  (() => {
    process.env.THINK_LEVEL = 'off';
    const r = thinkFor('say', 'full');
    return r.level === 'full' && r.thinking === true;
  })());

ok('没传档位时退回环境变量',
  (() => { process.env.THINK_LEVEL = 'full'; return thinkFor('say').level === 'full'; })());

ok('非法档位不会炸，退回默认档',
  (() => { delete process.env.THINK_LEVEL; return thinkFor('say', 'nightmare').level === 'off'; })());

ok('环境变量非法时也退回 off（不是 undefined）',
  (() => { process.env.THINK_LEVEL = '乱写'; return thinkFor('say').level === 'off'; })());

// 还原，别污染后面的用例
if (savedEnv === undefined) delete process.env.THINK_LEVEL; else process.env.THINK_LEVEL = savedEnv;

console.log('\n── 对抗强度（和深度思考是两件独立的事）──');

ok('三档齐全：简单 / 普通 / 困难',
  (() => {
    const labels = Object.values(SEVERITY_LEVELS).map(v => v.label);
    return labels.length === 3 && labels.includes('简单') && labels.includes('普通') && labels.includes('困难');
  })());

ok('合法档位原样返回',
  (() => severityFor('easy') === 'easy' && severityFor('hard') === 'hard' && severityFor('normal') === 'normal')());

ok('不传 / 非法 → 退回「普通」（不是报错、也不是 undefined）',
  (() => severityFor(undefined) === 'normal' && severityFor('') === 'normal'
       && severityFor('nightmare') === 'normal' && severityFor(null) === 'normal')());

ok('对抗强度说明里也不含金额',
  (() => Object.values(SEVERITY_LEVELS).every(v => !/¥|元|价格|花费/.test(v.note)))());

ok('对抗强度**不**碰 thinking —— 两个旋钮必须正交',
  (() => {
    // severity 只出现在提示词里；thinking 只由 THINK_LEVELS 决定。
    // 这条防的是"改难度顺手把思考也改了"这种回归。
    const sevKeys = Object.values(SEVERITY_LEVELS).flatMap(v => Object.keys(v));
    return !sevKeys.includes('thinking');
  })());

ok('困难档的说明明确写了"更狠"这一类词（否则调了等于没调）',
  (() => /翻旧账|传唤证人|从重/.test(SEVERITY_LEVELS.hard.note))());

console.log('\n── 对抗强度真的进了提示词（不然就是白调一个开关）──');

// 造一个最小可用的假会话，专门用来检查提示词拼装
const FAKE_SESSION = {
  round: 2,
  severity: 'normal',
  credibility: 0,
  grudges: [],
  judgeLedger: [],
  strategyLog: [],
  clerkNotes: [],
  exhibits: [],
  case: {
    case_no: '（2026）测试字第 1 号',
    case_title: '测试案',
    defendant_role: '测试被告',
    charge: '测试罪名',
    articles: ['《测试法》第 1 条'],
    witnesses: ['测试证人'],
    evidence: ['证据一', '证据二', '证据三'],
    precedents: ['P0 测试判例'],
    judge: { name: '测试法官', temper: '暴躁' },
    prosecutor: { name: '测试检察官', title: '公诉人', style: '快攻' },
  },
};

const promptOf = (sev) => daSystemPrompt({ ...FAKE_SESSION, severity: sev });

ok('困难档的提示词里出现"困难"和"优先翻旧账"',
  (() => { const t = promptOf('hard'); return t.includes('困难') && t.includes('优先翻旧账'); })());

ok('简单档的提示词里明确写了"本轮不主动翻旧账"',
  (() => { const t = promptOf('easy'); return t.includes('简单') && t.includes('不主动翻旧账'); })());

ok('普通档不塞额外指令（就是"按你自己节奏来"）',
  (() => { const t = promptOf('normal'); return t.includes('普通') && !t.includes('优先翻旧账'); })());

ok('三档的提示词互不相同（换档必须真的换内容）',
  (() => new Set([promptOf('easy'), promptOf('normal'), promptOf('hard')]).size === 3)());

ok('不传 severity 时按「普通」处理，不会生成 undefined 字样',
  (() => {
    const t = daSystemPrompt({ ...FAKE_SESSION, severity: undefined });
    return t.includes('普通') && !t.includes('undefined');
  })());

ok('静态前缀仍然是第一段（对抗强度插在它后面，缓存前缀没被破坏）',
  (() => {
    // DA_STATIC 是给上下文缓存用的：必须原样排在最前面。
    // 把动态内容插到它前面会让命中率归零，花费翻几十倍。
    const t = promptOf('hard');
    const staticIdx = t.indexOf(DA_STATIC);
    const sevIdx = t.indexOf('【本局对抗强度');
    return staticIdx === 0 && sevIdx > staticIdx;
  })());

ok('判决书的量刑口径也跟着对抗强度变',
  (() => {
    const hard = verdictSystemPrompt({ ...FAKE_SESSION, severity: 'hard' });
    const easy = verdictSystemPrompt({ ...FAKE_SESSION, severity: 'easy' });
    return hard.includes('从重') && easy.includes('从宽') && hard !== easy;
  })());

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
// guards.mjs — 纯逻辑校验层（无副作用，可离线单测）
// 这里放的都是"模型可能不听话，我们本地兜住"的逻辑。

/**
 * 引用校验：保证检察官真的逐字引用了被告的原话。
 * 模型经常只引半句、或把两句话缝在一起，这里做归一化比对 + 本地兜底。
 */
export function ensureQuote(proposed, defendantLines) {
  if (!Array.isArray(defendantLines) || defendantLines.length === 0) {
    return { quoted: '', exact: false };
  }
  const norm = (s) => String(s).replace(/[\s，。！？、；：""''（）()《》…—\-·,.!?;:"'`~]/g, '');
  const normed = defendantLines.map(norm);
  const p = norm(proposed || '');

  if (p.length >= 4) {
    const hit = normed.findIndex(n => n === p);
    if (hit >= 0) return { quoted: defendantLines[hit], exact: true };
    // 引用了其中一段（>=6 字）也算命中，但输出永远用原句，保证逐字
    if (p.length >= 6) {
      const partial = normed.findIndex(n => n.length >= 6 && (n.includes(p) || p.includes(n)));
      if (partial >= 0) return { quoted: defendantLines[partial], exact: true };
    }
  }
  // 兜底：挑最近几句里最长的一句
  let best = defendantLines[defendantLines.length - 1];
  for (const l of defendantLines.slice(-4)) if (l.length > best.length) best = l;
  return { quoted: best, exact: false };
}

/**
 * 法官称呼校验：把「X法官」里的错姓改成本案法官的姓。
 * 实测模型会把「陈不急」叫成「朱法官」。
 *
 * ⚠ 这里最容易写成误伤：早期版本用 /([\u4e00-\u9fa5]{1,3})法官/ 全局替换，
 * 于是「谢谢法官」→「谢陈法官」、「各位法官」→「各陈法官」、
 * 「审判长和法官」→「审判长陈法官」——全是正常中文词，被改烂。
 *
 * 现在的判据：只有能**确认这是姓氏**时才替换：
 *   ① 前面已经是法官全名 → 不动
 *   ② 「X法官」前面必须是行首/空白/标点（即 X 确实是个独立称呼的开头）
 *   ③ 而且 X 必须出现在常见姓氏表里（不在表里就说明不是称呼，原样放行）
 * 任一条件不满足 → 原样返回，绝不硬改。
 * 返回 { text, fixed }。
 */

/* 常见单姓（覆盖绝大多数情况即可；不在表里就不动，宁可漏改不可误改） */
const SURNAMES = new Set([
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜',
  '戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐',
  '费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄',
  '和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁',
  '杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍',
  '虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚',
  '程嵇邢滑裴陆荣翁荀羊于惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓',
  '牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙',
  '叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻',
  '莘党翟谭贡劳逄姬申扶堵冉宰郦雍卻璩桑桂濮牛寿通边扈燕冀郏浦尚农温',
  '别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡',
  '国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾',
  '毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公',
].join(''));

export function fixJudgeName(text, judgeName) {
  const s = String(text == null ? '' : text);
  if (!s || !judgeName) return { text: s, fixed: false };
  const name = String(judgeName);
  const correctSurname = name.charAt(0);
  let fixed = false;

  const out = s.replace(/([\u4e00-\u9fa5]{1,3})法官/g, (whole, pre) => {
    // ① 已经是全名（贪婪匹配会把整个名字抓成 pre）→ 不动
    if (name.length >= 2 && pre.endsWith(name)) return whole;

    // ② 真正的称呼前面只有一个汉字；两个以上说明它连着正文里的词
    if (pre.length !== 1) return whole;

    if (pre === correctSurname) return whole;       // 姓本来就对
    if (!SURNAMES.has(pre)) return whole;           // 不是姓氏（各位 / 这位 / 一位…）

    fixed = true;
    return correctSurname + '法官';
  });

  return { text: out, fixed };
}

/* ── 检察官记仇：小本本的合并与校验 ─────────────────────── */

const MAX_GRUDGES = 8;

const normLoose = (s) => String(s == null ? '' : s)
  .replace(/[\s，。！？、；：""''「」『』（）()《》…—\-·,.!?;:"'`~]/g, '');

/**
 * 引语是否真的出自被告说过的话。
 *
 * ⚠ 空串陷阱：早期版本写成 `q.includes(normed[i])`，
 * 当某条被告发言归一化后是空串（例如他只打了「……」或「。。。」），
 * `'任何字符串'.includes('')` 恒为 true —— 于是模型**编造**的引语
 * 会被当成"原话"记进小本本和书记员笔录，整道防线被一个标点绕过。
 * 所以两侧都必须非空，且较短一侧至少 6 字。
 */
function findSpokenLine(lines, normed, q) {
  if (!q) return null;
  const exact = lines.find((l, i) => normed[i] && normed[i] === q);
  if (exact) return exact;
  if (q.length < 6) return null;
  return lines.find((l, i) => {
    const n = normed[i];
    if (!n || n.length < 6) return false;
    return n.includes(q) || q.includes(n);
  }) || null;
}

/**
 * 从模型返回的值里抠出一个整数编号。
 *
 * 为什么需要它：提示词里我教模型「escalate 填要升级的 #编号」，
 * 于是它真的会返回 "#3"、"第 2 条"、甚至全角 "３"。
 * 直接 Number("#3") = NaN，会导致升级/翻旧账/引用证据全部静默失效——
 * 玩家只看到"检察官不翻旧账了"，没有任何报错。
 */
export function toIndex(v) {
  const s = String(v == null ? '' : v)
    // 全角数字转半角
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[＋]/g, '+');
  const m = s.match(/-?\d+/);
  return m ? Number(m[0]) : NaN;
}

/**
 * 把模型返回的 grudge_update 合并进小本本。
 *
 * 关键防线：
 *  · add 的 quote 必须**逐字出自被告真的说过的话**（宽松归一化后比对），编造的一律丢弃。
 *  · escalate 的 n 必须指向已存在的条目，乱指的一律丢弃。
 *  · level 夹到 1..5；总数上限 MAX_GRUDGES，超了淘汰"最轻 + 最久没提"的。
 *
 * @param {Array} grudges  当前小本本（会被复制，不原地改）
 * @param {Array} updates  模型返回的 grudge_update
 * @param {string[]} defendantLines 被告真实说过的所有原话
 * @param {number} round   当前轮次（0 起）
 * @returns {{ grudges: Array, added: Array, escalated: Array, dropped: number }}
 */
export function mergeGrudges(grudges, updates, defendantLines, round = 0) {
  const list = Array.isArray(grudges) ? grudges.map(g => ({ ...g })) : [];
  const lines = Array.isArray(defendantLines) ? defendantLines : [];
  const normed = lines.map(normLoose);
  const added = [], escalated = [];
  let dropped = 0;

  const ups = Array.isArray(updates) ? updates.slice(0, 4) : [];
  for (const u of ups) {
    if (!u || typeof u !== 'object') continue;
    const action = String(u.action || '').trim().toLowerCase();
    const lv = toIndex(u.level);
    const level = Math.max(1, Math.min(5, Math.round(Number.isFinite(lv) ? lv : 2)));
    const note = String(u.note == null ? '' : u.note).trim().slice(0, 60);

    if (action === 'add') {
      const quote = String(u.quote == null ? '' : u.quote).trim();
      if (!quote || !note) continue;
      const q = normLoose(quote);
      // 必须能在被告原话里找到（完全一致，或引了其中一段 >=6 字）
      const hit = findSpokenLine(lines, normed, q);
      if (!hit) continue;                                   // 编造的引语，丢弃
      if (list.some(g => normLoose(g.quote) === normLoose(hit))) continue;  // 已有同一条
      list.push({
        n: (list.reduce((m, g) => Math.max(m, g.n || 0), 0) + 1),
        quote: hit, note, level, firstRound: round, startRound: round, raised: 0, lastRaisedRound: null,
      });
      added.push(hit);   // 推真正入账的原句：前端靠它做"刚记下"高亮
    } else if (action === 'escalate') {
      const n = toIndex(u.n);
      const g = list.find(x => x.n === n);
      if (!g) continue;                                     // 乱指编号，丢弃
      if (level <= g.level && !note) continue;               // 没升级也没新备注，丢弃
      g.level = Math.max(g.level, level);
      if (note) g.note = note;
      escalated.push(g.n);
    }
  }

  // 超上限就淘汰。排序准则（越靠前越先被淘汰）：
  //   ① 重量低
  //   ② "最后一次被提起"的时间早 —— 从没提过的用 startRound（记下它那一刻）当参考，
  //      **不能当成 -1**，否则刚记下的新账会立刻被当成"最久没提"而当场扔掉。
  //   ③ 记下的时间早（同分时优先丢旧的）
  const staleAt = (g) => (g.lastRaisedRound != null ? g.lastRaisedRound
    : (g.startRound != null ? g.startRound : (g.firstRound != null ? g.firstRound : -1)));
  const scoreOf = (g) => [g.level || 0, staleAt(g), g.firstRound == null ? -1 : g.firstRound];
  const less = (a, b) => {
    const sa = scoreOf(a), sb = scoreOf(b);
    for (let i = 0; i < sa.length; i++) { if (sa[i] !== sb[i]) return sa[i] < sb[i]; }
    return false;
  };
  while (list.length > MAX_GRUDGES) {
    let worst = 0;
    for (let i = 1; i < list.length; i++) if (less(list[i], list[worst])) worst = i;
    list.splice(worst, 1);
    dropped++;
  }

  return { grudges: list, added, escalated, dropped };
}

/**
 * 记录"本轮翻了哪条旧账"。只有真的存在且被引用的编号才算。
 * `key` 决定额外返回哪个字段名（检察官 recalled / 法官 rule_used），保持接口向后兼容。
 * 返回 { list, event, key }，event 为 null 表示这轮没翻旧账。
 */
export function markRecalled(list, recalledN, round = 0, key = 'recalled') {
  const out = Array.isArray(list) ? list.map(g => ({ ...g })) : [];
  const n = toIndex(recalledN);
  if (!n) return { list: out, event: null, key };
  const g = out.find(x => x.n === n);
  if (!g) return { list: out, event: null, key };
  const timesBefore = g.raised || 0;
  g.raised = timesBefore + 1;
  g.lastRaisedRound = round;
  return {
    list: out,
    key,
    event: { n: g.n, quote: g.quote, note: g.note, times: timesBefore + 1, isCallback: timesBefore > 0 },
  };
}

/* ── 两本账：检察官记账 · 法官扣分 ─────────────────────── */

/**
 * 把模型一次返回里的两本账分别合并。
 *
 * 关键：**检察官和法官共用同一次 API 调用**（一个返回 JSON 里的两个字段），
 * 所以"法官也有记忆"这件事不增加任何请求数，也就不增加成本。
 *
 * @param {{prosecutor:Array, judge:Array}} store 当前两本账
 * @param {object} data 模型返回的 JSON（grudge_update / ledge_update）
 * @param {string[]} defendantLines 被告真实原话
 * @param {number} round 当前轮次（0 起）
 * @param {string} judgeName 法官全名（用于从判词里剥离签名）
 */
export function mergeBothLedgers(store, data, defendantLines, round = 0, judgeName = '') {
  const p = mergeGrudges(store?.prosecutor, data?.grudge_update, defendantLines, round);
  const j = mergeGrudges(store?.judge, data?.ledge_update, defendantLines, round);
  return {
    prosecutor: p.grudges,
    judge: j.grudges,
    added: { prosecutor: p.added, judge: j.added },
    escalated: { prosecutor: p.escalated, judge: j.escalated },
    dropped: p.dropped + j.dropped,
  };
}

/**
 * 法官脾气：从判词里剥离他自己的签名。
 * 让法官在文本末尾签个名，前端就能把它渲染成"批注卡片"而不是混在正文里 ——
 * 这给了法官第二处表达位，同样零额外调用。
 */
export function splitJudgeSign(text, judgeName) {
  const s = String(text == null ? '' : text).trim();
  if (!s || !judgeName) return { text: s, sign: null };
  const name = escapeRe(judgeName);
  // 允许名字后面跟 签/记/批注/注 之类的修饰词
  const deco = '(?:\\s*(?:签|记|批注|注))?';
  // 三种写法：换行后 / 破折号后 / 直接接在句末标点后
  const alternates = [
    new RegExp('\\n\\s*[-—–]{0,3}\\s*' + name + deco + '\\s*$'),          // 换行分隔
    new RegExp('\\s+[-—–]{1,3}\\s*' + name + deco + '\\s*$'),             // 破折号（前面有空白）
    new RegExp('(?<=[。！？；!?;])\\s*[-—–]{0,3}\\s*' + name + deco + '\\s*$'), // 紧跟句末标点
  ];
  for (const re of alternates) {
    const m = s.match(re);
    if (m) return { text: s.slice(0, m.index).trim(), sign: judgeName };
  }
  return { text: s, sign: null };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ── 庭辩态势：可信度、胜诉概率、证据解锁 ───────────────── */

export const CRED_MIN = -6;
export const CRED_MAX = 6;

/** 把模型返回的可信度变化夹到合法范围 */
export function clampMood(delta, current = 0) {
  const d = Number(delta);
  const base = Number(current) || 0;
  const next = base + (Number.isFinite(d) ? d : 0);
  return Math.max(CRED_MIN, Math.min(CRED_MAX, next));
}

/**
 * 可信度 → 胜诉概率（0–100）。纯本地计算，不花一分钱。
 * 用 sigmoid 形状：中间变化快，两端变缓，避免显示成线性的
 * "说了两句好话就 90%" 那种假手感。
 */
export function winChance(cred) {
  const c = Math.max(CRED_MIN, Math.min(CRED_MAX, Number(cred) || 0));
  // 把 [-6,6] 映射到 [-3,3] 后走 logistic
  const x = c / 2;
  const p = 1 / (1 + Math.exp(-x));
  return Math.round(p * 100);
}

/** 胜诉概率对应的档位文案（给界面用） */
export function moodLabel(cred) {
  const p = winChance(cred);
  if (p >= 78) return { key: 'winning', text: '本庭快信你了' };
  if (p >= 62) return { key: 'good', text: '略占上风' };
  if (p >= 45) return { key: 'even', text: '胜负未分' };
  if (p >= 28) return { key: 'bad', text: '形势不利' };
  return { key: 'losing', text: '基本定罪了' };
}

/* ── 证据的逐轮推进 ─────────────────────────────────────── */

/**
 * 根据当前轮次与可信度，算出哪些证据已解锁。
 * 纯本地，不调用模型。
 *   · 第 1 轮：只出第 1 件
 *   · 之后每轮多出一件
 *   · 被告可信度越低（越被动），检察官越快掏完
 */
export function evidenceState(evidence, round, cred = 0) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return [];
  const speed = cred < -2 ? 2 : 1;                       // 处于下风时检察官加速出示
  const unlocked = Math.max(1, Math.min(list.length, 1 + Math.floor(Math.max(0, round) * speed / 1)));
  return list.map((text, i) => ({
    n: i + 1,
    text,
    status: i < unlocked ? 'shown' : 'pending',
  }));
}

/** 还有几件没出示 —— 界面用来提示"后面还有牌" */
export function pendingEvidenceCount(evidence, round, cred = 0) {
  return evidenceState(evidence, round, cred).filter(e => e.status === 'pending').length;
}

/* ── 庭辩策略卡 ─────────────────────────────────────────── */

/**
 * 五张策略卡。玩家点一下就把对应指令拼进这一轮的说辞里。
 * **不额外调用模型** —— 它只是给同一次调用加一段约束。
 */
export const STRATEGIES = [
  {
    id: 'plead', name: '认罪求轻', icon: '认',
    hint: '承认事实，争取从轻。可信度大幅上升，但检察官会立刻锁死罪状',
    instruction: '【被告本轮的策略：认罪求轻】他先明确承认被指控的行为事实，再请求从轻处理。'
      + '他要显得诚恳但没有崩溃。检察官要立刻抓住这个自认，把它当作定罪的基础，同时否认"从轻"的空间。',
  },
  {
    id: 'deny', name: '正面抗辩', icon: '辩',
    hint: '逐条否认并给出自己的版本。常规打法，稳妥',
    instruction: '【被告本轮的策略：正面抗辩】他直接否认指控，并给出一个具体、可核查的替代版本。'
      + '检察官要拿证据和判例去戳这个版本的可信度。',
  },
  {
    id: 'silent', name: '保持沉默', icon: '默',
    hint: '一句话不说。法官会警告，检察官会自己加戏，可信度小幅下降',
    instruction: '【被告本轮的策略：保持沉默】他拒绝回答，只说一句极短的话或干脆不说话。'
      + '检察官要把这个沉默解读成默认或心虚，法官要就程序作出警告。',
  },
  {
    id: 'counter', name: '反咬检察官', icon: '咬',
    hint: '质疑检察官的程序或动机。高风险高回报',
    instruction: '【被告本轮的策略：反咬检察官】他质疑检察官的取证程序、动机或法条适用错误。'
      + '检察官要暴怒反击但不能失态，法官要独立判断这个质疑是否有道理——'
      + '**如果确实有道理，法官要当场认下来，甚至训斥检察官**。',
  },
  {
    id: 'appeal', name: '博取同情', icon: '情',
    hint: '讲处境、讲动机，争取法官理解。对铁石心肠的法官效果差',
    instruction: '【被告本轮的策略：博取同情】他讲自己的处境和动机，试图让法官理解而非脱罪。'
      + '检察官要指出"处境不是免责事由"，法官的反应要严格符合他自己的脾气——'
      + '**脾气硬的法官要明确表示不吃这套**。',
  },
];

export function getStrategy(id) {
  return STRATEGIES.find(s => s.id === id) || null;
}

/* ── 书记员：客观记录矛盾 ───────────────────────────────── */

/**
 * 把模型返回的 clerk_notes 与已有记录合并。
 * 书记员不站队，只记事实性矛盾（前后不一、与证据不符）。
 */
export function mergeClerkNotes(existing, updates, defendantLines, round = 0) {
  const list = Array.isArray(existing) ? existing.map(x => ({ ...x })) : [];
  const lines = Array.isArray(defendantLines) ? defendantLines : [];
  const normed = lines.map(normLoose);
  const added = [];

  const ups = Array.isArray(updates) ? updates.slice(0, 2) : [];
  for (const u of ups) {
    if (!u || typeof u !== 'object') continue;
    const quote = String(u.quote == null ? '' : u.quote).trim();
    const note = String(u.note == null ? '' : u.note).trim().slice(0, 80);
    if (!quote || !note) continue;
    const q = normLoose(quote);
    const hit = findSpokenLine(lines, normed, q);
    if (!hit) continue;                                    // 编造的引语，丢弃
    if (list.some(x => normLoose(x.quote) === normLoose(hit))) continue;
    const rec = { n: (list.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1), quote: hit, note, round };
    list.push(rec);
    added.push(rec);
  }
  // 书记员的笔录不需要淘汰策略：事实性矛盾越多越难看，保留全部（上限 12 条防止无限增长）
  while (list.length > 12) list.shift();
  return { notes: list, added };
}

/* ── 法官主动介入 ───────────────────────────────────────── */

const JUDGE_ACTIONS = {
  gavel:    { label: '敲槌',       effect: '维持秩序' },
  warn:     { label: '警告被告',   effect: '被告失分' },
  warn_da:  { label: '训斥检察官', effect: '检察官失分' },
  rule:     { label: '当庭裁定',   effect: '确立规则' },
  rush:     { label: '催促',       effect: '压缩流程' },
  side:     { label: '倾向一方',   effect: '影响可信度' },
};

/** 把模型给的法官动作规整成界面能用的结构。
 *  坑：必须按**最长匹配优先**。否则 Object.keys 里 'warn' 排在 'warn_da' 前面，
 *  输入 "warn_da" 会先被 'warn' 命中，把"训斥检察官"误判成"警告被告"。 */
const JUDGE_ACTION_KEYS = Object.keys(JUDGE_ACTIONS).sort((a, b) => b.length - a.length);

export function normalizeJudgeAction(input) {
  const t = String(input == null ? '' : input).trim().toLowerCase();
  if (!t) return null;
  const hit = JUDGE_ACTION_KEYS.find(k => t.includes(k));
  if (!hit) return null;
  return { id: hit, ...JUDGE_ACTIONS[hit] };
}

/* ── 结案陈词的支持度 ───────────────────────────────────── */

/**
 * 结案陈词由被告自己写，本地评估其"覆盖度"——
 * 是否提到了证据、判例、矛盾点。不调用模型。
 */
export function closingCoverage(text, session) {
  const t = String(text || '');
  const checks = [
    { key: 'evidence', label: '提到检察官的证据', hit: (session.case?.evidence || []).some(e => t.includes(String(e).slice(0, 6))) || /证据|物证|监控|记录/.test(t) },
    { key: 'precedent', label: '提到判例', hit: /判例|先例|第\s*\d+\s*号|参照/.test(t) },
    { key: 'contradiction', label: '提到矛盾点', hit: /矛盾|前后不一|自相|改口|对不上/.test(t) },
    { key: 'law', label: '提到法条', hit: /第\s*\d+\s*条|条例|法条|依照/.test(t) },
    { key: 'emotion', label: '给出自己的处境', hit: /我(当时|其实|只是|真的)|处境|因为|那天/.test(t) },
  ];
  const hitCount = checks.filter(c => c.hit).length;
  const len = t.trim().length;
  return {
    checks,
    hitCount,
    length: len,
    // 长度也计入：太短的结案陈词没有说服力
    bonus: Math.min(3, hitCount) + (len >= 80 ? 1 : 0) + (len >= 200 ? 1 : 0),
    tooShort: len < 20,
  };
}

/* ── 上诉：翻案评估 ─────────────────────────────────────── */

/**
 * 上诉的翻案可能。纯本地计算。
 * 依据：庭审中积累的可信度、书记员记录的矛盾数、检察官被法官训斥的次数。
 */
export function appealChance(cred, clerkCount, judgeWarnedDa, rounds) {
  let chance = winChance(cred);
  chance += Math.max(-15, 5 - clerkCount * 4);      // 矛盾越多越难翻
  chance += (judgeWarnedDa || 0) * 8;               // 法官训过检察官 → 对你有利
  chance += Math.min(10, (rounds || 0) * 2);        // 审得越久越容易找出程序问题
  return Math.max(3, Math.min(92, Math.round(chance)));
}

/**
 * 把模型输出里**裸的控制字符**修掉，让 JSON.parse 能吃下去。
 *
 * 真实事故（2026-09-27，用户手机上复现）：
 *   立案失败：Bad control character in string literal in JSON at position 755
 * 模型想输出多行文本时，有时会在 JSON 字符串里**直接敲回车**，而不是输出 `\n`。
 * JSON 规范（RFC 8259）禁止字符串字面量里出现未转义的 U+0000–U+001F，
 * 于是 JSON.parse 直接抛错。而流式路径（/api/case、/api/say）**没有重试**，
 * 一次吐脏就直接立案失败，还白花了这次调用的钱。
 *
 * 处理规则：
 *   · 字符串**内部**的控制字符 → 转成合法的转义序列（\n \r \t \b \f 或 \uXXXX）
 *   · 字符串**外部**的非法控制字符（NUL/VT/FF 之类）→ 直接丢掉；
 *     但制表符/换行/回车在字符串外是合法空白，必须保留，否则会弄坏正常的
 *     pretty-print JSON。
 *
 * 关键点：**不能无脑全局替换**。字符串外面的换行是合法空白，转成 `\n`
 * 反而会让整段 JSON 语法错误。所以必须带状态机，区分"在不在字符串里"。
 */
export function escapeRawControlChars(input) {
  const src = String(input ?? '');
  let out = '';
  let inStr = false;
  let pendingEscape = false;   // 上一个字符是反斜杠，当前字符是它的转义目标

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const code = c.charCodeAt(0);

    if (!inStr) {
      if (c === '"') inStr = true;
      // 字符串外的控制字符：\t \n \r 是合法空白要留；其余（NUL、VT、FF…）是垃圾
      if (code < 0x20 && c !== '\t' && c !== '\n' && c !== '\r') continue;
      out += c;
      continue;
    }

    // ── 以下都在字符串内部 ──
    if (pendingEscape) {
      // 反斜杠后面跟了个裸控制字符（比如反斜杠+回车），这是非法转义。
      // 补一个转义的反斜杠，再把控制字符转义掉，保证语法一定合法。
      if (code < 0x20) {
        out += '\\\\' + escControl(code);
      } else {
        out += c;
      }
      pendingEscape = false;
      continue;
    }
    if (c === '\\') { out += c; pendingEscape = true; continue; }
    if (c === '"') { out += c; inStr = false; continue; }
    out += code < 0x20 ? escControl(code) : c;
  }
  return out;
}

function escControl(code) {
  switch (code) {
    case 0x08: return '\\b';
    case 0x09: return '\\t';
    case 0x0a: return '\\n';
    case 0x0c: return '\\f';
    case 0x0d: return '\\r';
    default: return '\\u' + code.toString(16).padStart(4, '0');
  }
}

/**
 * 从模型回复里把 JSON 抠出来。
 * 依次尝试：原样 → 剥掉 ```json 代码块 → 截取第一个 { 到最后一个 }。
 * 每一步解析前都先过一遍 escapeRawControlChars，否则模型输出里的裸换行
 * 会让整个请求失败（流式路径没有重试）。
 * 放在 guards.mjs 而不是 server.mjs，是为了能被 test-guards.mjs 直接单测。
 */
export function extractJson(text) {
  if (!text) throw new Error('空响应');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  s = escapeRawControlChars(s);
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('响应里没有 JSON：' + s.slice(0, 200));
}

/**
 * 立案时数组字段的本地兜底。
 *
 * 为什么需要：模型偶尔会把某个数组吐成空 —— 实测有一次 `witnesses` 全空，
 * 于是整局"证人出庭"环节都没触发。提示词里已经写了"必须给 2-3 个"，
 * 但它还是会漏，所以代码层必须再兜一道（而且**不额外调用模型**，免费）。
 * 兜底内容刻意写成"什么案子都塞得进去"的物件证人 / 通用证据。
 */
export const CASE_FALLBACKS = {
  witnesses: [
    '被告家的门锁（坚持说自己当晚没被拧动过）',
    '楼道监控摄像头（只肯为它拍不到的那个角度作证）',
    '被告的手机（声称那条消息是它自己发出去的）',
  ],
  evidence: [
    '案发时段的小区门禁记录：被告在关键三分钟内进出过一次，未刷卡',
    '被告手机里一段被删除又恢复的语音，全长 11 秒，内容只有呼吸声',
    '现场遗留的一件物品，被告称从未见过，但上面检出他的指纹',
  ],
  articles: [
    '《邻里公共秩序管理条例》第 3 条：任何人不得以沉默替代解释',
  ],
  precedents: [
    '（2024）巷民初字第 66 号，被告以同样说法抗辩，被判处当庭把自己的辩解复述三遍',
  ],
};

/**
 * 数组字段：优先用模型给的，为空则退回本地兜底。
 * 顺带做了清洗 —— 去空白、丢掉空串、截断到 max 条。
 */
export function pickList(value, max, fallback) {
  const a = Array.isArray(value)
    ? value.map(x => String(x ?? '').trim()).filter(Boolean).slice(0, max)
    : [];
  return a.length ? a : (fallback || []).slice(0, max);
}

// app.js — 界面层：庭审流程、打字机、卷宗、判决书、长图导出
// 庭审记录的唯一权威副本在服务端 session.transcript；前端只负责渲染，
// 不在本地重新拼一份（避免两端不一致）。
'use strict';

/* ── 状态 ───────────────────────────────────────────────── */

const S = {
  sid: null,
  intensity: 'free',
  quickRounds: 5,
  caseData: null,
  grudges: [],
  judgeLedger: [],
  clerkNotes: [],
  credibility: 0,
  winChance: 50,
  evidence: [],
  strategy: null,          // 本轮选中的策略 id
  strategies: [],          // 策略卡清单（从服务端拉）
  exhibits: [],
  closing: null,
  appealResult: null,
  round: 0,
  busy: false,
  typing: false,
  skipTyping: false,
  canVerdict: false,
  hasSaidAnything: false,
  result: null,
};

const $ = (id) => document.getElementById(id);
const el = {
  home: $('screen-home'), trial: $('screen-trial'), verdict: $('screen-verdict'),
  tCourt: $('t-court'), tCase: $('t-case'), tCharge: $('t-charge'),
  transcript: $('transcript'),
  roundBar: $('round-bar'), roundText: $('round-text'),
  say: $('say'), btnSay: $('btn-say'), btnVerdict: $('btn-verdict'), footHint: $('foot-hint'),
  seedInput: $('seed-input'),
  dossier: $('dossier'), dossierBody: $('dossier-body'),
  menu: $('menu'), menuNote: $('menu-note'), scrim: $('scrim'),
  toast: $('toast'),
  verdictPaper: $('verdict-paper'), verdictScroll: $('verdict-scroll'),
  vCourt: $('v-court'), vTitle: $('v-title'), vRetitle: $('v-retitle'),
  vSentence: $('v-sentence'), vBody: $('v-body'),
  vQuotes: $('v-quotes'), vDa: $('v-da'), vJudgePrivate: $('v-judge-private'),
  vEpilogue: $('v-epilogue'), vStats: $('v-stats'),
  portrait: $('portrait'), portraitName: $('portrait-name'),
  portraitTemper: $('portrait-temper'), portraitLine: $('portrait-line'),
  grudgePanel: $('grudge-panel'), grudgeList: $('grudge-list'), grudgeCount: $('grudge-count'),
  grudgeColDa: $('grudge-col-da'), grudgeColJudge: $('grudge-col-judge'),
  ledgerList: $('ledger-list'), ledgerCount: $('ledger-count'),
  vGrudge: $('v-grudge'), vLedger: $('v-ledger'), vConcur: $('v-concur'),
  thinkPick: $('think-pick'), thinkOpts: $('think-opts'), thinkNote: $('think-note'),
  sevPick: $('sev-pick'), sevOpts: $('sev-opts'), sevNote: $('sev-note'),
  // 庭辩态势
  moodBar: $('mood-bar'), moodText: $('mood-text'), moodFill: $('mood-fill'), moodPct: $('mood-pct'),
  evidenceBar: $('evidence-bar'), evList: $('ev-list'),
  clerkRow: $('clerk-row'), clerkBody: $('clerk-body'),
  stratCards: $('strat-cards'),
  btnExhibit: $('btn-exhibit'), btnClosing: $('btn-closing'), btnAppeal: $('btn-appeal'),
  // 判决书新增
  vOutcome: $('v-outcome'), vCred: $('v-cred'), vClerk: $('v-clerk'), vStrat: $('v-strat'),
  vExhibit: $('v-exhibit'), vClosing: $('v-closing'), vScore: $('v-score'),
  vWitness: $('v-witness'), vOffscreen: $('v-offscreen'),
  vAppealResult: $('v-appeal-result'), vAppealText: $('v-appeal-text'),
  // 状态汇总 + 弹窗
  statusSummary: $('status-summary'), statusPanel: $('status-panel'),
  ssItems: $('ss-items'), ssCaret: $('ss-caret'), ssHint: $('ss-hint'),
  modalScrim: $('modal-scrim'), modal: $('modal'), modalTitle: $('modal-title'),
  modalSub: $('modal-sub'), modalInput: $('modal-input'), modalTips: $('modal-tips'),
  modalOk: $('modal-ok'), modalCancel: $('modal-cancel'),
};

/* ── 小工具 ─────────────────────────────────────────────── */

function show(screen) {
  for (const s of [el.home, el.trial, el.verdict]) s.classList.remove('active');
  screen.classList.add('active');
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({ ok: false, error: '服务返回了无法解析的内容' }));
  if (!r.ok || data.ok === false) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

/* ── 打字机 ─────────────────────────────────────────────── */

/**
 * 在 node 里逐字打出 text。
 * 返回 promise；期间点击屏幕可跳过（skipTyping）。
 */
function typeInto(node, text, speed = 16) {
  return new Promise(resolve => {
    node.textContent = '';
    node.classList.add('typing');
    let i = 0;
    const step = () => {
      if (S.skipTyping) {
        node.textContent = text;
        node.classList.remove('typing');
        S.typing = false;
        S.skipTyping = false;
        return resolve();
      }
      // 一次吐 1-3 个字，长文本更快
      const n = text.length > 260 ? 3 : text.length > 120 ? 2 : 1;
      i = Math.min(text.length, i + n);
      node.textContent = text.slice(0, i);
      if (i >= text.length) {
        node.classList.remove('typing');
        S.typing = false;
        return resolve();
      }
      setTimeout(step, speed);
    };
    S.typing = true;
    step();
  });
}

document.addEventListener('click', () => {
  if (S.typing) S.skipTyping = true;
}, true);

/* ── 渲染：一条庭审记录 ─────────────────────────────────── */

const ROLE_META = {
  judge: { cls: 'judge', label: '法官' },
  prosecutor: { cls: 'prosecutor', label: '检察官' },
  defendant: { cls: 'defendant', label: '被告' },
  clerk: { cls: 'clerk', label: '书记员' },
  offscreen: { cls: 'offscreen', label: '庭外' },
  witness: { cls: 'witness', label: '证人' },
};

/**
 * @param {'judge'|'prosecutor'|'defendant'} role
 * @param {{name?:string, content:string, quote?:string|null, attitude?:string, typewriter?:boolean}} opt
 */
function addMessage(role, opt = {}) {
  const meta = ROLE_META[role] || ROLE_META.clerk;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + meta.cls;

  const who = document.createElement('div');
  who.className = 'msg-who';
  const tag = document.createElement('span');
  tag.className = 'role-tag';
  tag.textContent = meta.label;
  who.appendChild(tag);
  if (opt.name) {
    const nm = document.createElement('span');
    nm.textContent = opt.name;
    who.appendChild(nm);
  }
  // 法官的主动动作徽章
  if (opt.action) {
    const act = document.createElement('span');
    act.className = 'judge-action ' + opt.action.id;
    act.textContent = opt.action.label;
    who.appendChild(act);
  }
  // 庭外情节的地点标签
  if (opt.place) {
    const w = document.createElement('span');
    w.className = 'where';
    w.textContent = opt.place;
    who.appendChild(w);
  }
  // 证人证词的影响
  if (opt.effect) {
    const e = document.createElement('span');
    e.className = 'eff ' + opt.effect;
    e.textContent = opt.effect;
    who.appendChild(e);
  }
  wrap.appendChild(who);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrap.appendChild(bubble);

  if (opt.quote) {
    const q = document.createElement('div');
    q.className = 'quote-echo';
    const lb = document.createElement('span');
    lb.className = 'qe-label';
    lb.textContent = '抓你这句话';
    q.appendChild(lb);
    q.appendChild(document.createTextNode('「' + opt.quote + '」'));
    wrap.appendChild(q);
  }

  if (opt.attitude) {
    const a = document.createElement('div');
    a.className = 'attitude';
    a.textContent = '检察官态度 · ' + opt.attitude;
    wrap.appendChild(a);
  }

  // 法官签名：渲染成一张小批注卡，而不是混在正文里
  if (opt.sign) {
    const sg = document.createElement('div');
    sg.className = 'judge-sign';
    const txt = document.createElement('span');
    txt.textContent = opt.sign + ' 记';
    const seal = document.createElement('span');
    seal.className = 'seal-mini';
    seal.textContent = '槌';
    sg.appendChild(txt);
    sg.appendChild(seal);
    wrap.appendChild(sg);
  }

  el.transcript.appendChild(wrap);
  scrollDown();

  if (opt.typewriter) return typeInto(bubble, opt.content).then(() => wrap);
  bubble.textContent = opt.content;
  return Promise.resolve(wrap);
}

function scrollDown() {
  requestAnimationFrame(() => { el.transcript.scrollTop = el.transcript.scrollHeight; });
}

/* ── 渲染：检察官的小本本 ───────────────────────────────── */

/**
 * 渲染两本账：检察官的罪证账 + 法官的态度账。
 * 两本账来自**同一次** API 调用，所以"法官也有记忆"不增加任何成本。
 * @param {Array} grudges 检察官账
 * @param {Array} ledger  法官账
 * @param {object} changes {added, escalated, recalled} + {ledgerAdded, ledgerEscalated, ruleUsed}
 */
function renderGrudges(grudges, ledger, changes = {}) {
  const gList = Array.isArray(grudges) ? grudges : [];
  const lList = Array.isArray(ledger) ? ledger : [];
  S.grudges = gList;
  S.judgeLedger = lList;

  el.grudgePanel.hidden = (gList.length === 0 && lList.length === 0);
  if (el.grudgePanel.hidden) return;

  const cols = [
    { col: el.grudgeColDa, list: el.grudgeList, count: el.grudgeCount, data: gList, judge: false,
      added: changes.added || [], escalated: changes.escalated || [], used: changes.recalled || null, usedKey: 'recalled' },
    { col: el.grudgeColJudge, list: el.ledgerList, count: el.ledgerCount, data: lList, judge: true,
      added: changes.ledgerAdded || [], escalated: changes.ledgerEscalated || [], used: changes.ruleUsed || null, usedKey: 'rule_used' },
  ];

  for (const c of cols) {
    if (!c.data.length) { c.col.hidden = true; continue; }
    c.col.hidden = false;
    c.count.textContent = c.data.length + ' 条 · 最重 ' + Math.max(...c.data.map(g => g.level || 0)) + '/5';
    c.list.innerHTML = '';

    const addedQ = c.added.map(q => String(q).replace(/\s/g, ''));
    const esc = new Set(c.escalated);

    for (const g of c.data) {
      const isNew = addedQ.includes(String(g.quote).replace(/\s/g, ''));
      const row = document.createElement('div');
      row.className = 'grudge-item' + (c.judge ? ' judge' : '');
      if (isNew) row.classList.add('just-added');

      const pips = document.createElement('div');
      pips.className = 'grudge-pips';
      for (let i = 1; i <= 5; i++) {
        const b = document.createElement('i');
        if (i <= (g.level || 0)) b.className = 'on';
        pips.appendChild(b);
      }
      row.appendChild(pips);

      const body = document.createElement('div');
      body.className = 'grudge-body';
      const q = document.createElement('div');
      q.className = 'grudge-quote';
      q.textContent = g.quote;
      body.appendChild(q);
      if (g.note) {
        const n = document.createElement('div');
        n.className = 'grudge-note';
        n.textContent = g.note;
        body.appendChild(n);
      }
      row.appendChild(body);

      let badge = null;
      if (c.used && c.used.n === g.n) {
        badge = c.judge
          ? { text: c.used.isCallback ? `又拿来敲打 ×${c.used.times}` : '本轮敲打', cls: c.used.isCallback ? 'rule-cb' : 'rule' }
          : { text: c.used.isCallback ? `翻旧账 ×${c.used.times}` : '本轮翻这条', cls: 'recall' };
      } else if (esc.has(g.n)) {
        badge = { text: c.judge ? '加扣' : '加重', cls: '' };
      } else if (isNew) {
        badge = { text: '记下', cls: '' };
      }
      if (badge) {
        const b = document.createElement('span');
        b.className = 'grudge-badge ' + badge.cls;
        b.textContent = badge.text;
        row.appendChild(b);
      }

      c.list.appendChild(row);
    }
  }
}

/* ── 流式 API：边收边显示，不用等整段生成完 ─────────────── */

/**
 * 以 SSE 方式调用接口。
 * @param onDelta (key, text) => void   每收到一个字段的最新全文就回调
 * @param onEvent (evt) => void         其他事件（start / thinking / error）
 * @returns 服务端 done 事件里的完整结果
 */
async function apiStream(path, body, onDelta, onEvent) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...body, stream: 1 }),
  });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => '');
    throw new Error(`请求失败（${r.status}）${t.slice(0, 160)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '', done = null;
  while (true) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(':')) continue;          // 心跳
      if (!line.startsWith('data:')) continue;
      let j = null;
      try { j = JSON.parse(line.slice(5)); } catch { continue; }
      if (j.type === 'delta') { if (onDelta) onDelta(j.key, j.text); }
      else if (j.type === 'done') { done = j; }
      else if (j.type === 'error') { throw new Error(j.error || '生成失败'); }
      else if (onEvent) onEvent(j);
    }
  }
  if (!done) throw new Error('连接中断，没有收到完整结果');
  return done;
}

/* ── 实时气泡：先建一个空泡泡，边生成边填 ───────────────── */

function makeLiveBubble(role, name) {
  const meta = ROLE_META[role] || ROLE_META.clerk;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + meta.cls;
  const who = document.createElement('div');
  who.className = 'msg-who';
  const tag = document.createElement('span');
  tag.className = 'role-tag';
  tag.textContent = meta.label;
  who.appendChild(tag);
  if (name) { const nm = document.createElement('span'); nm.textContent = name; who.appendChild(nm); }
  wrap.appendChild(who);
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing';
  wrap.appendChild(bubble);
  el.transcript.appendChild(wrap);
  scrollDown();
  let lastLen = 0;
  return {
    wrap,
    set(text) {
      if (!text || text.length === lastLen) return;
      lastLen = text.length;
      bubble.textContent = text;
      scrollDown();
    },
    seal(opt = {}) {
      bubble.classList.remove('typing');
      if (opt.sign) {
        const sg = document.createElement('div');
        sg.className = 'judge-sign';
        const txt = document.createElement('span');
        txt.textContent = opt.sign + ' 记';
        const seal = document.createElement('span');
        seal.className = 'seal-mini';
        seal.textContent = '槌';
        sg.appendChild(txt); sg.appendChild(seal);
        wrap.appendChild(sg);
      }
      if (opt.action) {
        const act = document.createElement('span');
        act.className = 'judge-action ' + opt.action.id;
        act.textContent = opt.action.label;
        wrap.querySelector('.msg-who').appendChild(act);
      }
      if (opt.quote) {
        const q = document.createElement('div');
        q.className = 'quote-echo';
        const lb = document.createElement('span');
        lb.className = 'qe-label';
        lb.textContent = '抓你这句话';
        q.appendChild(lb);
        q.appendChild(document.createTextNode('「' + opt.quote + '」'));
        wrap.appendChild(q);
      }
      if (opt.attitude) {
        const a = document.createElement('div');
        a.className = 'attitude';
        a.textContent = '检察官态度 · ' + opt.attitude;
        wrap.appendChild(a);
      }
      return wrap;
    },
    remove() { wrap.remove(); },
  };
}

/** 等待提示（放在正文里，比整屏加载页友好） */
function makeWaiting(role, text) {
  const meta = ROLE_META[role] || ROLE_META.clerk;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + meta.cls;
  wrap.innerHTML = `<div class="msg-who"><span class="role-tag">${meta.label}</span></div>`
    + `<div class="bubble typing"></div>`;
  wrap.querySelector('.bubble').textContent = text;
  el.transcript.appendChild(wrap);
  scrollDown();
  return wrap;
}

/* ── 渲染：庭辩态势（胜诉概率）───────────────────────────── */

const MOOD_TEXT = (p) => p >= 78 ? '本庭快信你了' : p >= 62 ? '略占上风'
  : p >= 45 ? '胜负未分' : p >= 28 ? '形势不利' : '基本定罪了';
const MOOD_CLASS = (p) => p >= 62 ? 'winning' : p <= 38 ? 'losing' : '';

function renderMood(winChance, credibility) {
  const p = Number.isFinite(winChance) ? winChance : 50;
  S.winChance = p;
  S.credibility = credibility || 0;
  el.moodFill.style.width = Math.max(2, Math.min(100, p)) + '%';
  el.moodPct.textContent = p + '%';
  el.moodText.textContent = MOOD_TEXT(p);
  el.moodBar.className = 'mood-bar ' + MOOD_CLASS(p);
}

/* ── 渲染：证据进度 ──────────────────────────────────────── */

function renderEvidence(evidence, usedN) {
  const list = Array.isArray(evidence) ? evidence : [];
  S.evidence = list;
  const shown = list.filter(e => e.status === 'shown').length;
  S.evShown = shown;
  S.evTotal = list.length;
  S.evUsed = usedN;
  el.evList.innerHTML = '';
  for (const e of list) {
    const d = document.createElement('span');
    d.className = 'ev-item' + (e.status === 'pending' ? ' pending' : '') + (usedN === e.n ? ' shown-now' : '');
    d.textContent = e.status === 'pending' ? `（未出示 ${e.n}）` : `${e.n}. ${e.text}`;
    d.title = e.status === 'pending' ? '这件证据检方还没拿出来' : e.text;
    el.evList.appendChild(d);
  }
  updateStatusSummary();
}

/* ── 状态汇总行（一行显示全部计数，点开才展开）─────────── */

function updateStatusSummary(pulse) {
  const parts = [];
  if (S.evTotal) {
    parts.push({ cls: 'ev', label: '证据', n: `${S.evShown}/${S.evTotal}`, key: 'ev' });
  }
  const g = (S.grudges || []).length;
  const j = (S.judgeLedger || []).length;
  const c = (S.clerkNotes || []).length;
  if (g) parts.push({ cls: 'da', label: '检察官记', n: g, key: 'da' });
  if (j) parts.push({ cls: 'judge', label: '法官记', n: j, key: 'judge' });
  if (c) parts.push({ cls: 'clerk', label: '笔录', n: c, key: 'clerk' });
  if (S.exhibits && S.exhibits.length) parts.push({ cls: 'ev', label: '调证', n: S.exhibits.length, key: 'ex' });

  if (!parts.length) {
    el.ssItems.innerHTML = '<span class="ss-hint-inline">暂无记录</span>';
    return;
  }
  el.ssItems.innerHTML = '';
  for (const p of parts) {
    const s = document.createElement('span');
    s.className = 'ss-chip ' + p.cls + (pulse === p.key ? ' pulse' : '');
    const b = document.createElement('b');
    b.textContent = p.n;
    s.appendChild(document.createTextNode(p.label + ' '));
    s.appendChild(b);
    el.ssItems.appendChild(s);
  }
}

function setStatusOpen(open) {
  el.statusPanel.hidden = !open;
  el.statusSummary.classList.toggle('open', open);
  el.statusSummary.setAttribute('aria-expanded', open ? 'true' : 'false');
  el.ssHint.textContent = open ? '收起' : '展开';
  S.statusOpen = open;
}

/* ── 渲染：书记员笔录 ────────────────────────────────────── */

function renderClerk(notes) {
  const list = Array.isArray(notes) ? notes : [];
  S.clerkNotes = list;
  el.clerkRow.hidden = list.length === 0;
  el.clerkBody.textContent = list.map(x => `第${x.round + 1}轮「${x.quote.slice(0, 18)}…」${x.note}`).join('　·　');
  updateStatusSummary();
}

/* ── 渲染：策略卡 ────────────────────────────────────────── */

function renderStrategies() {
  const list = Array.isArray(S.strategies) ? S.strategies : [];
  el.stratCards.innerHTML = '';
  for (const s of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'strat-card' + (S.strategy === s.id ? ' on' : '');
    b.title = s.hint;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = s.icon;
    b.appendChild(ic);
    b.appendChild(document.createTextNode(s.name));
    b.addEventListener('click', () => {
      S.strategy = (S.strategy === s.id) ? null : s.id;
      renderStrategies();
      const hit = list.find(x => x.id === S.strategy);
      if (hit) el.say.placeholder = `（本轮策略：${hit.name}）${hit.hint}`;
      else el.say.placeholder = '当庭辩护…（Enter 发言 / Shift+Enter 换行）';
    });
    el.stratCards.appendChild(b);
  }
}

/* ── 速审节奏条 ─────────────────────────────────────────── */

function renderRoundBar() {
  if (S.intensity !== 'quick') { el.roundBar.hidden = true; return; }
  el.roundBar.hidden = false;
  const left = Math.max(0, S.quickRounds - S.round);
  const pips = Array.from({ length: S.quickRounds }, (_, i) =>
    `<span class="pip${i < S.round ? ' used' : ''}"></span>`).join('');
  el.roundText.innerHTML = `速审程序 · 剩 <b>${left}</b> 次发言 <span class="round-pips">${pips}</span>`;
}

function refreshControls() {
  const hasText = el.say.value.trim().length > 0;
  const quickDone = S.intensity === 'quick' && S.round >= S.quickRounds;
  el.btnSay.disabled = S.busy || quickDone || !hasText;
  el.btnVerdict.disabled = S.busy || !S.canVerdict;
  el.btnVerdict.classList.toggle('urgent', quickDone);
  if (quickDone) {
    el.footHint.textContent = '发言次数已用完，请宣判';
  } else if (!S.canVerdict) {
    el.footHint.textContent = '先辩一句，宣判才会解锁';
  } else if (!hasText) {
    el.footHint.textContent = '写一句辩护词';
  } else if (S.intensity === 'quick') {
    el.footHint.textContent = `还可以说 ${Math.max(0, S.quickRounds - S.round)} 句`;
  } else {
    el.footHint.textContent = '想休庭随时按';
  }
  renderRoundBar();
}

/* ── 通用输入弹窗（替代 native prompt）───────────────────── */

/**
 * @param opt { title, sub, placeholder, tips, okText, minLen, validate }
 * @returns Promise<string|null>  取消返回 null
 */
function askText(opt = {}) {
  return new Promise(resolve => {
    el.modalTitle.textContent = opt.title || '输入';
    el.modalSub.innerHTML = opt.sub || '';
    el.modalInput.placeholder = opt.placeholder || '在这里写…';
    el.modalInput.value = opt.prefill || '';
    el.modalOk.textContent = opt.okText || '提交';
    el.modalTips.innerHTML = '';
    el.modalScrim.hidden = false;

    const refresh = () => {
      const v = el.modalInput.value.trim();
      const tooShort = opt.minLen && v.length < opt.minLen;
      let extra = '';
      if (opt.validate) {
        const r = opt.validate(v);
        if (r && r.tips) extra = r.tips;
        el.modalOk.disabled = !!r.blocked || tooShort;
      } else {
        el.modalOk.disabled = !!tooShort;
      }
      el.modalTips.innerHTML = (opt.tips || '') + extra;
    };
    el.modalInput.oninput = refresh;
    refresh();

    /* 不要在手机上自动弹键盘：只有桌面端（有鼠标）才自动聚焦 */
    const isTouch = window.matchMedia('(hover: none)').matches;
    if (!isTouch && opt.autofocus !== false) setTimeout(() => el.modalInput.focus(), 60);

    const close = (val) => {
      el.modalScrim.hidden = true;
      el.modalInput.oninput = null;
      el.modalOk.onclick = null;
      el.modalCancel.onclick = null;
      el.modalScrim.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    };
    const submit = () => {
      if (el.modalOk.disabled) return;
      close(el.modalInput.value.trim());
    };
    el.modalOk.onclick = submit;
    el.modalCancel.onclick = () => close(null);
    el.modalScrim.onclick = (e) => { if (e.target === el.modalScrim) close(null); };
    document.addEventListener('keydown', onKey, true);
  });
}

/* ── 忙碌态 ─────────────────────────────────────────────── */
/** 忙碌态：禁用一切会触发新请求的控件，并在按钮上显示当前在做什么 */
function setBusyUI(busy, label) {
  S.busy = !!busy;
  el.btnSay.disabled = busy;
  el.btnVerdict.disabled = busy;
  el.btnExhibit.disabled = busy;
  el.btnClosing.disabled = busy;
  if (label) el.footHint.textContent = label;
  else refreshControls();
}

/* ── 两个旋钮（首页）：对抗强度 + 深度思考 ──────────────────
 *
 * 以前只有一个开关叫"思考模式"，但它改的是"AI 要不要先想"，
 * 跟"难度"名不副实 —— 调难度却只改了速度，AI 该多凶还是多凶。
 * 现在拆成两个独立的东西：
 *   对抗强度 severity → 改提示词 → AI 打得多凶
 *   深度思考 think    → 改请求参数 → AI 要不要先想（影响速度）
 * 两个都**按局生效**：选完记在本地，立案时随请求带上去，
 * 服务端存进这一局的 session，之后整局都用它。各人改各人的，互不影响。
 */

const THINK_FALLBACK = [
  { key: 'off', label: '关闭', note: '张口就来：反应快，但引用会宽一些、旧账记得浅' },
  { key: 'full', label: '开启', note: '先想再开口：引用更刁、翻旧账更狠、判词更长。每次要多等几秒' },
];
const SEV_FALLBACK = [
  { key: 'easy', label: '简单', note: '检察官按程序出牌，一次只谈一件证据，不主动翻旧账，量刑从宽' },
  { key: 'normal', label: '普通', note: '检察官会盯你的漏洞，该翻旧账就翻，按他自己的节奏来' },
  { key: 'hard', label: '困难', note: '检察官穷追猛打：优先翻旧账、主动传唤证人、要求从重，量刑更狠' },
];

let thinkLevels = THINK_FALLBACK;
let severityLevels = SEV_FALLBACK;
const THINK_KEY = 'gangjing.think';
const SEV_KEY = 'gangjing.severity';
let chosenThink = null;      // null = 还没选过，用服务端给的默认
let chosenSeverity = null;

/** 通用档位渲染：两个旋钮长得一样，共用一套（也省得改两处 CSS） */
function renderPicker(els, levels, current, onPick) {
  els.pick.hidden = false;
  els.opts.innerHTML = '';
  for (const lv of levels) {
    const b = document.createElement('button');
    b.className = 'think-opt' + (lv.key === current ? ' on' : '');
    b.type = 'button';
    const t = document.createElement('span');
    t.textContent = lv.label;
    b.appendChild(t);
    b.addEventListener('click', () => onPick(lv));
    els.opts.appendChild(b);
  }
  const info = levels.find(x => x.key === current);
  if (info) els.note.textContent = info.note;
}

function drawPickers(serverDefaults) {
  renderPicker(
    { pick: el.sevPick, opts: el.sevOpts, note: el.sevNote },
    severityLevels, chosenSeverity || serverDefaults.severity || 'normal',
    (lv) => {
      chosenSeverity = lv.key;
      try { localStorage.setItem(SEV_KEY, lv.key); } catch { /* 无痕模式 */ }
      drawPickers(serverDefaults);
    });
  renderPicker(
    { pick: el.thinkPick, opts: el.thinkOpts, note: el.thinkNote },
    thinkLevels, chosenThink || serverDefaults.think || 'off',
    (lv) => {
      chosenThink = lv.key;
      try { localStorage.setItem(THINK_KEY, lv.key); } catch { /* 无痕模式 */ }
      drawPickers(serverDefaults);
    });
}

function readLocalPicks() {
  try {
    chosenThink = localStorage.getItem(THINK_KEY) || null;
    chosenSeverity = localStorage.getItem(SEV_KEY) || null;
  } catch { chosenThink = null; chosenSeverity = null; }
  if (chosenThink && !thinkLevels.some(x => x.key === chosenThink)) chosenThink = null;
  if (chosenSeverity && !severityLevels.some(x => x.key === chosenSeverity)) chosenSeverity = null;
}

/* ── 流程：立案（进庭审页后流式填充，没有全屏加载页）──────── */

async function startCase(mode) {
  S.intensity = mode === 'quick' ? 'quick' : 'free';
  S.sid = null; S.round = 0;
  S.canVerdict = false; S.hasSaidAnything = false; S.result = null;
  S.strategy = null; S.exhibits = []; S.closing = null; S.appealResult = null;
  S.clerkNotes = []; S.credibility = 0; S.winChance = 50; S.evidence = [];
  S.caseData = null;
  el.transcript.innerHTML = '';
  el.say.value = '';
  el.say.placeholder = '当庭辩护…（Enter 发言 / Shift+Enter 换行）';
  renderGrudges([], []);
  renderClerk([]);
  renderEvidence([]);
  renderMood(50, 0);
  if (el.btnAppeal) { el.btnAppeal.disabled = false; el.btnAppeal.textContent = '当庭上诉'; }
  $('v-appeal-block').hidden = true;
  autoGrow();

  /* 立刻进庭审页，用占位文字顶着 —— 不再有"点进去干等"的整屏加载页 */
  el.tCourt.textContent = '正在立案';
  el.tCase.textContent = '（书记员正在誊写卷宗…）';
  el.tCharge.textContent = '罪名待定';
  show(el.trial);
  setStatusOpen(false);
  setBusyUI(true, S.intensity === 'quick' ? '速审立案中…' : '正在立案…');

  const wait = makeWaiting('judge', '法庭正在立案，请稍候…（内容会一边生成一边显示）');

  // 实时气泡：案名/罪名一出就填，开庭词边生成边显示
  let judgeB = null, daB = null;
  const onDelta = (key, text) => {
    switch (key) {
      case 'case_title': el.tCase.textContent = text; break;
      case 'charge': el.tCharge.textContent = text; break;
      case 'court': S._court = text; if (S._no) el.tCourt.textContent = `${text}　${S._no}`; break;
      case 'case_no': S._no = text; if (S._court) el.tCourt.textContent = `${S._court}　${text}`; break;
      case 'prosecutor_name': S._daName = text; break;
      case 'judge_name': S._judgeName = text; break;
      case 'judge_opening':
        if (!judgeB) { wait.remove(); judgeB = makeLiveBubble('judge', S._judgeName); }
        judgeB.set(text);
        break;
      case 'prosecutor_opening':
        if (!daB) { daB = makeLiveBubble('prosecutor', S._daName); }
        daB.set(text);
        break;
    }
  };

  try {
    // seed 让玩家指定案件主题。服务端一直支持（caseUserPrompt 里有"必须围绕这个主题立案"），
    // 只是前端以前没接 —— 结果想录一个特定题材的案子只能反复重开，
    // 而每次重开都要真调一次模型（立案本身就要花钱）。
    const seed = (el.seedInput && el.seedInput.value || '').trim().slice(0, 30);
    const data = await apiStream('/api/case', {
      intensity: S.intensity, seed,
      difficulty: chosenThink || undefined,
      severity: chosenSeverity || undefined,
    }, onDelta);
    S.sid = data.sid;
    S.caseData = data.case;
    S.quickRounds = data.quickRounds || 5;

    wait.remove();
    if (judgeB) judgeB.seal(); else await addMessage('judge', { name: S.caseData.judge.name, content: S.caseData.judge.opening });
    if (daB) daB.seal(); else await addMessage('prosecutor', { name: S.caseData.prosecutor.name, content: S.caseData.prosecutor.opening });

    el.tCourt.textContent = S.caseData.court + '　' + S.caseData.case_no;
    el.tCase.textContent = S.caseData.case_title;
    el.tCharge.textContent = S.caseData.charge;

    renderDossier();
    renderStrategies();
    renderEvidence(S.caseData.evidence
      ? S.caseData.evidence.map((e, i) => ({ n: i + 1, text: e, status: i === 0 ? 'shown' : 'pending' }))
      : []);
    renderMood(50, 0);
    setBusyUI(false);
    refreshControls();
    // 故意不 el.say.focus()：手机上会自动弹出键盘，很烦。
    // 用户想打字时自己点输入框。
  } catch (e) {
    wait.remove();
    setBusyUI(false);
    show(el.home);
    toast('立案失败：' + e.message, 5000);
  }
}

/* ── 流程：被告发言 ─────────────────────────────────────── */

async function doSay() {
  const text = el.say.value.trim();
  if (!text || S.busy) return;

  setBusyUI(true, '检察官正在回应…');
  el.say.value = '';
  autoGrow();

  await addMessage('defendant', { content: text });
  S.hasSaidAnything = true;
  S.canVerdict = true;

  // 法官和检察官的泡泡先建好，边生成边填（不再等整段）
  const wait = makeWaiting('prosecutor', '检察官正在翻你的笔录…');
  let daB = null, judgeB = null;

  try {
    const r = await apiStream('/api/say', { sid: S.sid, text, strategy: S.strategy }, (key, val) => {
      if (key === 'judge_note') {
        if (!val) return;
        if (!judgeB) { judgeB = makeLiveBubble('judge', S.caseData.judge.name); }
        judgeB.set(val);
      } else if (key === 'prosecutor') {
        if (val && wait.parentNode) wait.remove();
        if (!daB) { daB = makeLiveBubble('prosecutor', S.caseData.prosecutor.name); }
        daB.set(val);
      }
    });
    wait.remove();
    S.round = r.round;

    // 收尾：把流式泡泡封口，补上引用回显/签名/态度/动作
    const pl = r.lines.find(l => l.role === 'prosecutor');
    const jl = r.lines.find(l => l.role === 'judge');
    if (daB && pl) {
      daB.set(pl.content);
      daB.seal({ quote: pl.quote, attitude: r.attitude });
    } else if (pl) {
      await addMessage('prosecutor', { name: S.caseData.prosecutor.name, content: pl.content, quote: pl.quote, attitude: r.attitude });
    }
    if (jl) {
      if (judgeB) { judgeB.set(jl.content); judgeB.seal({ sign: jl.sign, action: jl.action }); }
      else await addMessage('judge', { name: S.caseData.judge.name, content: jl.content, sign: jl.sign, action: jl.action });
    }
    // 书记员新增的矛盾 / 庭外情节 / 证人
    for (const c of (r.clerkAdded || [])) {
      await addMessage('clerk', { content: c.note, quote: c.quote });
    }
    if (r.witness) {
      await addMessage('witness', {
        name: r.witness.name,
        effect: r.witness.effect,
        content: r.witness.line,
      });
      toast(`证人「${r.witness.name}」出庭（${r.witness.effect}）`, 2600);
    }
    if (r.offscreen) {
      await addMessage('offscreen', { place: r.offscreen.place, content: r.offscreen.text });
    }

    // 本轮策略已消耗
    S.strategy = null;
    renderStrategies();
    el.say.placeholder = '当庭辩护…（Enter 发言 / Shift+Enter 换行）';

    // 态势 / 证据 / 书记员 / 两本账
    renderMood(r.winChance, r.credibility);
    renderEvidence(r.evidence, r.evidenceUsed ? r.evidenceUsed.n : null);
    renderClerk(r.clerkNotes);
    renderGrudges(r.grudges, r.judgeLedger, {
      added: r.grudgeAdded, escalated: r.grudgeEscalated, recalled: r.recalled,
      ledgerAdded: r.ledgerAdded, ledgerEscalated: r.ledgerEscalated, ruleUsed: r.ruleUsed,
    });

    // 只提示最重要的一件事：翻旧账 > 法官训斥检察官 > 被抓矛盾 > 记下
    if (r.recalled) {
      toast(r.recalled.isCallback
        ? `检察官翻了旧账（第 ${r.recalled.times} 次提这句）`
        : '检察官把这句话记进了小本本', 2400);
    } else if (r.judgeAction && r.judgeAction.id === 'warn_da') {
      toast('法官当庭训斥了检察官', 2600);
    } else if ((r.clerkAdded || []).length) {
      toast('书记员把你这句话记进了笔录', 2600);
    } else if ((r.grudgeAdded || []).length || (r.ledgerAdded || []).length) {
      toast('对方记下了你这句话', 2200);
    }
    if (r.credDelta) {
      const d = r.credDelta;
      setTimeout(() => toast(`本庭信任度 ${d > 0 ? '+' : ''}${d} · 胜诉概率 ${r.winChance}%`, 2000), 1300);
    }
    if (r.degraded) toast('检察官走神了，本轮回复是降级内容', 3200);

    if (r.mustVerdict) {
      toast('发言次数已用完，自动进入宣判', 3000);
      await sleep(700);
      setBusyUI(false);
      return doVerdict();
    }
  } catch (e) {
    wait.remove();
    toast('检察官那边出错了：' + e.message, 5000);
  } finally {
    setBusyUI(false);
    // 故意不 focus 输入框：手机上一 focus 就弹键盘，用户嫌烦
  }
}

/* ── 流程：申请补充取证 ─────────────────────────────────── */

async function doExhibit() {
  if (S.busy) return;
  if ((S.exhibits || []).length >= 3) { toast('本庭最多受理三次补充取证申请', 2800); return; }

  const want = await askText({
    title: '申请补充取证',
    sub: `你还能申请 <b>${3 - (S.exhibits || []).length}</b> 次。写清楚要调取什么——越具体越容易被准予。`,
    placeholder: '例：调取便利店门口的监控回放，能看到我当晚几点离开',
    tips: '法官会裁定准不准，检察官会当场质疑关联性。被准予才有用。',
    okText: '提交申请',
    minLen: 4,
  });
  if (!want) return;

  await addMessage('defendant', { content: `【申请取证】${want}` });
  S.hasSaidAnything = true; S.canVerdict = true;
  const wait = makeWaiting('judge', '法庭正在处理取证申请…（检察官在翻关联性）');
  setBusyUI(true, '法警去调取了…');

  try {
    const r = await api('/api/exhibit', { sid: S.sid, text: want });
    wait.remove();

    if (r.rejected) { toast(r.error || '申请未受理', 3600); return; }

    const ex = r.exhibit;
    // 渲染成三条：检察官质疑 → 法官裁定 → 证据内容
    await addMessage('prosecutor', {
      name: S.caseData.prosecutor.name,
      content: `被告申请调取「${ex.name}」。${ex.objection}`,
      typewriter: true,
    });
    await addMessage('judge', {
      name: S.caseData.judge.name,
      content: `【${ex.name}】${ex.ruling}。${ex.ruling_reason}`,
      typewriter: true,
    });
    await addMessage('clerk', {
      content: `${ex.name}：${ex.content}${ex.credDelta ? `（本庭信任度 ${ex.credDelta > 0 ? '+' : ''}${ex.credDelta}）` : ''}`,
      typewriter: true,
    });

    S.exhibits = r.exhibits || [];
    renderMood(r.winChance, r.credibility);
    setStatusOpen(true);          // 主动展开一次，让用户看到新证据已入册
    updateStatusSummary('ex');
    refreshControls();
  } catch (e) {
    wait.remove();
    toast('取证失败：' + e.message, 4000);
  } finally {
    setBusyUI(false);
  }
}

/* ── 流程：结案陈词（本地评估，不调用模型）───────────────── */

async function doClosing() {
  if (S.busy) return;
  const COV = [
    { k: '证据', re: /证据|物证|监控|记录/ },
    { k: '判例', re: /判例|先例|第\s*\d+\s*号|参照/ },
    { k: '矛盾点', re: /矛盾|前后不一|自相|改口|对不上/ },
    { k: '法条', re: /第\s*\d+\s*条|条例|法条|依照/ },
    { k: '处境', re: /我(当时|其实|只是|真的)|处境|因为|那天/ },
  ];
  const text = await askText({
    title: '结案陈词',
    sub: '这是你最后的机会。写完就直接宣判。',
    placeholder: '总结你的辩护：检方的证据哪里站不住、判例怎么说、你前后有没有矛盾、法条怎么适用……',
    okText: '提交结案陈词',
    minLen: 10,
    validate: (v) => {
      const hits = COV.filter(c => c.re.test(v)).map(c => c.k);
      const miss = COV.filter(c => !c.re.test(v)).map(c => c.k);
      return {
        tips: `<div>命中要点：<span class="tip-ok">${hits.join('、') || '暂无'}</span></div>`
          + (miss.length ? `<div>还没提到：<span class="tip-no">${miss.join('、')}</span></div>` : '')
          + `<div>${v.trim().length} 字${v.trim().length < 80 ? '（偏短，建议写长一点）' : ''}</div>`,
      };
    },
  });
  if (!text) return;

  try {
    const r = await api('/api/closing', { sid: S.sid, text });
    S.closing = r.closing;
    renderMood(r.winChance, r.credibility);

    const cov = r.coverage;
    const lines = [
      { role: 'defendant', content: `【结案陈词】${r.closing}` },
      { role: 'clerk', content: `书记员核对：命中 ${cov.hitCount}/5 项要点（${cov.checks.filter(c => c.hit).map(c => c.label).join('、') || '无'}），${cov.length} 字，本庭信任度 ${r.credDelta > 0 ? '+' : ''}${r.credDelta}` },
    ];
    for (const l of lines) await addMessage(l.role, { content: l.content, typewriter: true });

    toast(`结案陈词已记录 · 胜诉概率 ${r.winChance}%`, 3000);
  } catch (e) {
    toast('结案陈词提交失败：' + e.message, 3600);
  }
}

/* ── 流程：当庭上诉 ─────────────────────────────────────── */

async function doAppeal() {
  if (S.busy) return;
  if (!S.result) return;
  if (S.appealResult) { toast('本案已经上诉过了', 2600); return; }

  const note = await askText({
    title: '当庭上诉',
    sub: `原判：<b>${escapeHtml(S.result.sentence || '（无）')}</b><br>`
      + `本地估算翻案可能：<b>${S.result.appeal_chance != null ? S.result.appeal_chance + '%' : '未知'}</b>`,
    placeholder: '你的上诉理由（可以留空，让上级法院自己去挑一审的毛病）',
    tips: '上级法院不重申一遍，而是挑一审的程序瑕疵、事实认定和法条适用。留空也能上诉。',
    okText: '提起上诉',
    minLen: 0,
  });
  if (note === null) return;   // 用户取消

  renderAppealPending();
  setBusyUI(true, '上级法院正在审理…');

  try {
    const r = await api('/api/appeal', { sid: S.sid, note: note || '' });

    if (r.failed) { toast(r.error || '上诉审失败', 4000); hideAppealPending(); return; }
    if (r.already) { renderAppeal(r.appeal); return; }
    S.appealResult = r.appeal;
    renderAppeal(r.appeal);
    toast('上诉裁定：' + r.appeal.result, 3200);
  } catch (e) {
    hideAppealPending();
    toast('上诉失败：' + e.message, 4000);
  } finally {
    setBusyUI(false);
  }
}

/* 上诉等待：在判决书上就地显示进度，不跳转页面 */
function renderAppealPending() {
  $('v-appeal-block').hidden = false;
  el.vAppealResult.className = 'appeal-result';
  el.vAppealResult.textContent = '上级法院正在审理…';
  el.vAppealText.textContent = '正在调阅一审全部卷宗：核对一审程序 → 审查事实认定 → 评估量刑是否畸重';
}
function hideAppealPending() {
  $('v-appeal-block').hidden = true;
}

function renderAppeal(a) {
  if (!a) return;
  $('v-appeal-block').hidden = false;
  const cls = a.result === '改判' ? 'overturn' : a.result === '发回重审' ? 'remand' : 'uphold';
  el.vAppealResult.className = 'appeal-result ' + cls;
  el.vAppealResult.textContent = `${a.result}${a.chanceAtAppeal != null ? `（上诉前估算翻案率 ${a.chanceAtAppeal}%）` : ''}`;
  el.vAppealText.textContent = [a.title, a.text, a.sentence ? `\n${a.sentence}` : '',
    a.judge_comment ? `\n\n一审法官反应：${a.judge_comment}` : ''].filter(Boolean).join('\n');
  el.btnAppeal.disabled = true;
  el.btnAppeal.textContent = '已上诉';
}

/* ── 流程：宣判 ─────────────────────────────────────────── */

async function doVerdict() {
  if (S.busy || !S.canVerdict) return;
  closeDrawers();

  /* 就地显示进度：不跳转页面，判决书一边写一边填 */
  show(el.verdict);
  el.vCourt.textContent = (S.caseData?.court || '') + '　' + (S.caseData?.case_no || '');
  el.vTitle.textContent = '法官正在写判决书…';
  el.vRetitle.hidden = true;
  el.vSentence.textContent = '';
  el.vBody.textContent = '检察官在做最后陈述 → 法官在翻法条 → 书记员在誊写判词';
  el.vQuotes.innerHTML = '';
  for (const id of ['v-da-block', 'v-judge-block', 'v-epi-block', 'v-grudge-block', 'v-ledger-block',
    'v-concur-block', 'v-cred-block', 'v-clerk-block', 'v-strat-block', 'v-exhibit-block',
    'v-closing-block', 'v-appeal-block']) $(id).hidden = true;
  el.vScore.hidden = true;
  el.vStats.textContent = '';
  el.verdictScroll.scrollTop = 0;
  setBusyUI(true, '法官正在写判决书…');

  try {
    const r = await apiStream('/api/verdict', { sid: S.sid }, (key, text) => {
      if (key === 'verdict_text') { el.vBody.textContent = text; el.verdictScroll.scrollTop = el.verdictScroll.scrollHeight; }
      else if (key === 'verdict_title') el.vTitle.textContent = text;
      else if (key === 'sentence') el.vSentence.textContent = text;
    });
    S.result = r.result;
    renderVerdict(r.result);
    try { localStorage.setItem('gangjing:lastVerdict', JSON.stringify(r.result)); } catch { /* 忽略 */ }
    // 自动存档，下次可以接着看
    try { localStorage.setItem('gangjing:lastState', JSON.stringify({
      sid: S.sid, at: Date.now(), title: S.caseData?.case_title,
    })); } catch { /* 忽略 */ }
  } catch (e) {
    show(el.trial);
    toast('宣判失败：' + e.message, 5000);
  } finally {
    setBusyUI(false);
  }
}

/* ── 渲染：判决书 ───────────────────────────────────────── */

function renderVerdict(v) {
  el.vCourt.textContent = (v.case?.court || '') + '　' + (v.case?.case_no || '');
  el.vTitle.textContent = v.verdict_title || '本院认为';
  el.vRetitle.textContent = v.retitle || '';
  el.vRetitle.hidden = !v.retitle;
  el.vSentence.textContent = v.sentence || '';

  // 判决书正文：把 \n 变成段落，段间留空
  el.vBody.textContent = v.verdict_text || '';

  el.vQuotes.innerHTML = '';
  const quotes = (v.quotes || []).filter(Boolean);
  $('v-quotes-block').hidden = quotes.length === 0;
  for (const q of quotes) {
    const d = document.createElement('div');
    d.className = 'q-card';
    d.textContent = '「' + q + '」';
    el.vQuotes.appendChild(d);
  }

  $('v-da-block').hidden = !v.da_best;
  el.vDa.textContent = v.da_best ? '「' + v.da_best + '」' : '';

  $('v-judge-block').hidden = !v.judge_private;
  el.vJudgePrivate.textContent = v.judge_private || '';

  $('v-epi-block').hidden = !v.epilogue;
  el.vEpilogue.textContent = v.epilogue || '';

  /* ── 判决结果类型（大字）── */
  const outcomeMap = { '有罪': 'guilty', '部分有罪': 'partial', '无罪释放': 'acquitted', '发回重审': 'retrial' };
  if (v.outcome) {
    el.vOutcome.hidden = false;
    el.vOutcome.className = 'verdict-outcome ' + (outcomeMap[v.outcome] || '');
    el.vOutcome.innerHTML = '';
    const sp = document.createElement('span');
    sp.textContent = v.outcome;
    el.vOutcome.appendChild(sp);
  } else {
    el.vOutcome.hidden = true;
  }

  /* ── 对被告当庭表现的评价 ── */
  $('v-cred-block').hidden = !v.credibility_verdict;
  el.vCred.textContent = v.credibility_verdict || '';

  /* ── 书记员笔录 ── */
  const cn = Array.isArray(v.clerk_notes) ? v.clerk_notes : [];
  $('v-clerk-block').hidden = cn.length === 0;
  el.vClerk.innerHTML = '';
  for (const n of cn) {
    const d = document.createElement('div');
    d.className = 'q-card';
    d.textContent = `第${n.round + 1}轮「${n.quote}」${n.note}`;
    el.vClerk.appendChild(d);
  }

  /* ── 用过的策略 ── */
  const sl = Array.isArray(v.strategy_log) ? v.strategy_log : [];
  $('v-strat-block').hidden = sl.length === 0;
  el.vStrat.textContent = sl.map(s => `第${s.round + 1}轮 ${s.name}`).join('　→　');

  /* ── 申请调取的证据 ── */
  const ex = Array.isArray(v.exhibits) ? v.exhibits : [];
  $('v-exhibit-block').hidden = ex.length === 0;
  el.vExhibit.innerHTML = '';
  for (const e of ex) {
    const d = document.createElement('div');
    d.className = 'q-card';
    d.textContent = `【${e.ruling}】${e.name}：${e.content}`;
    el.vExhibit.appendChild(d);
  }

  /* ── 出庭证人 ── */
  const wc = Array.isArray(v.witnesses_called) ? v.witnesses_called : [];
  $('v-witness-block').hidden = wc.length === 0;
  el.vWitness.innerHTML = '';
  for (const w of wc) {
    const d = document.createElement('div');
    d.className = 'q-card';
    d.textContent = `【${w.effect}】${w.name}：「${w.line}」`;
    el.vWitness.appendChild(d);
  }

  /* ── 庭外情节 ── */
  const os = Array.isArray(v.offscreen) ? v.offscreen : [];
  $('v-offscreen-block').hidden = os.length === 0;
  el.vOffscreen.innerHTML = '';
  for (const o of os) {
    const d = document.createElement('div');
    d.className = 'q-card';
    d.style.fontStyle = 'italic';
    d.textContent = `${o.place}：${o.text}`;
    el.vOffscreen.appendChild(d);
  }

  /* ── 结案陈词 ── */
  $('v-closing-block').hidden = !v.closing;
  el.vClosing.textContent = v.closing || '';

  /* ── 精彩度评分 ── */
  if (Number.isFinite(v.case_score)) {
    el.vScore.hidden = false;
    el.vScore.innerHTML = '';
    const num = document.createElement('div');
    num.className = 'num';
    num.innerHTML = `${v.case_score}<small>/100</small>`;
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = `本案精彩度${v.case_score_reason ? '：' + v.case_score_reason : ''}`
      + (v.next_case_hook ? `\n下一案预告：${v.next_case_hook}` : '');
    desc.style.whiteSpace = 'pre-line';
    el.vScore.appendChild(num);
    el.vScore.appendChild(desc);
  } else {
    el.vScore.hidden = true;
  }

  /* ── 证据终局出示情况 ── */
  $('v-grudge-block').hidden = !v.grudge_verdict;
  el.vGrudge.textContent = v.grudge_verdict || '';

  $('v-ledger-block').hidden = !v.judge_ledger_verdict;
  el.vLedger.textContent = v.judge_ledger_verdict || '';

  // 法官对检察官主张的态度
  const concur = String(v.concur || '').trim();
  const cMap = { '全部采纳': 'adopt', '部分驳回': 'partial', '大部分驳回': 'reject' };
  const cls = cMap[concur];
  el.vConcur.hidden = !concur;
  el.vConcur.className = 'concur-badge' + (cls ? ' ' + cls : '');
  el.vConcur.textContent = concur || '';
  $('v-concur-block').hidden = !concur;

  el.vStats.textContent = `${v.rounds || 0} 轮交锋 · 被告共 ${v.defendant_words || 0} 字 · ${v.case?.prosecutor?.name || ''} 公诉`
    + (v.grudge_count ? ` · 罪证账 ${v.grudge_count} 条` : '')
    + (v.judge_ledger_count ? ` · 态度账 ${v.judge_ledger_count} 条` : '');

  // 玩家界面不再显示任何金额 / token / 调用次数 ——
  // 花多少钱是运维的事。要看数据用 GET /api/usage。

  el.verdictScroll.scrollTop = 0;
}

/* ── 卷宗抽屉 ───────────────────────────────────────────── */

function renderDossier() {
  const c = S.caseData;
  if (!c) return;
  const gs = S.grudges || [];
  const jl = S.judgeLedger || [];
  const sec = (title, inner) => `<div class="dossier-sec"><h4>${title}</h4>${inner}</div>`;
  const ul = (list) => list && list.length
    ? `<ul>${list.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : '<div class="kv">（无）</div>';

  el.dossierBody.innerHTML = [
    sec('案件', `<div class="kv">
      案号：${escapeHtml(c.case_no)}<br>
      案名：${escapeHtml(c.case_title)}<br>
      被告：${escapeHtml(c.defendant_role)}<br>
      罪名：${escapeHtml(c.charge)}
    </div>`),
    sec('引用法条', ul(c.articles)),
    sec('检察官', `<div class="speaker">${escapeHtml(c.prosecutor.name)} · ${escapeHtml(c.prosecutor.title)}</div>
      <div class="kv" style="margin-bottom:8px">打法：${escapeHtml(c.prosecutor.style)}</div>
      <div class="speech">${escapeHtml(c.prosecutor.opening)}</div>`),
    sec('主审法官', `<div class="speaker">${escapeHtml(c.judge.name)}</div>
      <div class="kv" style="margin-bottom:8px">脾气：${escapeHtml(c.judge.temper)}</div>
      <div class="speech">${escapeHtml(c.judge.opening)}</div>`),
    sec('证据', ul(c.evidence)),
    sec('判例', ul(c.precedents)),
    sec('证人', ul(c.witnesses)),
    gs.length ? sec('检察官的小本本（罪证账）', gs.map(g =>
      `<div class="kv" style="margin-bottom:8px">
        #${g.n} 「${escapeHtml(g.quote)}」<br>
        <span style="color:#8c7f72">→ ${escapeHtml(g.note || '')}</span><br>
        <span style="color:#7a5c57">重量 ${g.level}/5 · 已提过 ${g.raised || 0} 次</span>
      </div>`).join('')) : '',
    jl.length ? sec('法官的扣分表（态度账）', jl.map(g =>
      `<div class="kv" style="margin-bottom:8px">
        #${g.n} 「${escapeHtml(g.quote)}」<br>
        <span style="color:#8c7f72">→ ${escapeHtml(g.note || '')}</span><br>
        <span style="color:#7a5c57">扣 ${g.level}/5 分 · 用过 ${g.raised || 0} 次</span>
      </div>`).join('')) : '',
  ].join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function openDrawer(node) { node.classList.add('open'); el.scrim.classList.add('open'); }
function closeDrawers() {
  el.dossier.classList.remove('open');
  el.menu.classList.remove('open');
  el.scrim.classList.remove('open');
}

/* ── 判决书导出：Canvas 手绘长图（零依赖、离线可用）────── */

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('图片加载失败'));
    img.src = src;
  });
}

async function exportVerdictImage() {
  const paper = el.verdictPaper;
  const rect = paper.getBoundingClientRect();
  const W = Math.round(rect.width);
  const logicalH = Math.round(paper.scrollHeight);
  if (!W || !logicalH) throw new Error('页面还没渲染好');

  const SCALE = 2;
  const cv = document.createElement('canvas');
  const cssW = W + 56, cssH = logicalH + 56;
  cv.width = Math.round(cssW * SCALE);
  cv.height = Math.round(cssH * SCALE);
  const ctx = cv.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // 背景
  ctx.fillStyle = '#090807';
  ctx.fillRect(0, 0, cssW, cssH);

  // 宣纸底
  const px = 28, py = 28;
  const grad = ctx.createLinearGradient(px, py, px + W, py + logicalH);
  grad.addColorStop(0, '#e8e1d3');
  grad.addColorStop(1, '#d9d1bf');
  ctx.fillStyle = grad;
  roundRect(ctx, px, py, W, logicalH, 4);
  ctx.fill();

  // 内细框
  ctx.strokeStyle = 'rgba(28,26,23,0.13)';
  ctx.lineWidth = 1;
  roundRect(ctx, px + 10, py + 10, W - 20, logicalH - 20, 2);
  ctx.stroke();

  // 相对 paper 的坐标偏移
  const oy = py - rect.top;
  const ox = px - rect.left;

  const drawText = (node, { align = 'left', color = '#241f19', font, lineHeight } = {}) => {
    if (!node || node.hidden) return;
    const t = node.innerText || node.textContent || '';
    if (!t.trim()) return;
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const f = font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.font = f;
    ctx.fillStyle = color || cs.color;
    ctx.textBaseline = 'alphabetic';
    const lh = lineHeight || parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
    const x = align === 'center' ? r.left + ox + r.width / 2 : r.left + ox;
    ctx.textAlign = align === 'center' ? 'center' : 'left';
    drawWrapped(ctx, t, x, r.top + oy + parseFloat(cs.fontSize), r.width, lh);
  };

  // 按文档顺序绘制（含判决主文那块红底）
  try {
    const courtR = el.vCourt.getBoundingClientRect();
    drawText(el.vCourt, { align: 'center', color: '#6b6252' });

    drawText(el.vTitle, { align: 'center', color: '#14120e' });
    if (!el.vRetitle.hidden) drawText(el.vRetitle, { align: 'center', color: '#a8342c' });

    // 判决主文底色
    const sR = el.vSentence.getBoundingClientRect();
    ctx.fillStyle = 'rgba(168,52,44,0.09)';
    ctx.fillRect(sR.left + ox, sR.top + oy, sR.width, sR.height);
    ctx.strokeStyle = 'rgba(168,52,44,0.3)';
    ctx.beginPath();
    ctx.moveTo(sR.left + ox, sR.top + oy); ctx.lineTo(sR.left + ox + sR.width, sR.top + oy);
    ctx.moveTo(sR.left + ox, sR.top + oy + sR.height); ctx.lineTo(sR.left + ox + sR.width, sR.top + oy + sR.height);
    ctx.stroke();
    drawText(el.vSentence, { align: 'center', color: '#3a2420' });

    drawText(el.vBody, { color: '#241f19' });

    for (const q of el.vQuotes.querySelectorAll('.q-card')) {
      const qr = q.getBoundingClientRect();
      ctx.fillStyle = 'rgba(28,26,23,0.05)';
      ctx.fillRect(qr.left + ox, qr.top + oy, qr.width, qr.height);
      ctx.fillStyle = 'rgba(168,52,44,0.5)';
      ctx.fillRect(qr.left + ox, qr.top + oy, 2, qr.height);
      drawText(q, { color: '#2c2520' });
    }

    const block = (labelNode, valueNode, cls) => {
      if (!labelNode || labelNode.hidden || !valueNode || !valueNode.textContent.trim()) return;
      drawText(labelNode, { color: '#7a705c' });
      drawText(valueNode, { color: cls === 'dim' ? '#6d6353' : '#33291f' });
    };
    block(el.vQuotes.parentElement.querySelector('.block-label'), null); // 金句标签
    block($('v-da-block').querySelector('.block-label'), el.vDa);
    block($('v-judge-block').querySelector('.block-label'), el.vJudgePrivate);
    block($('v-epi-block').querySelector('.block-label'), el.vEpilogue, 'dim');
    drawText(el.vStats, { color: '#7a705c' });

    // 页脚
    ctx.font = `500 11px ${getComputedStyle(document.body).fontFamily}`;
    ctx.fillStyle = '#968c78';
    ctx.textAlign = 'center';
    ctx.fillText('本判决纯属虚构 · 杠精法庭', px + W / 2, py + logicalH - 22);

    // 红印章
    const sealX = px + W - 96, sealY = py + logicalH - 96;
    ctx.save();
    ctx.translate(sealX, sealY);
    ctx.rotate(-0.13);
    ctx.strokeStyle = 'rgba(168,52,44,0.5)';
    ctx.lineWidth = 2.5;
    roundRect(ctx, -32, -32, 64, 64, 6);
    ctx.stroke();
    ctx.fillStyle = 'rgba(168,52,44,0.6)';
    ctx.font = `700 32px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('判', 0, 2);
    ctx.restore();
  } catch (e) {
    console.warn('[export] 绘制部分失败：', e);
  }

  // 用 toBlob 下载（firefox 下 canvas.toBlob 可用）
  const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
  if (!blob) throw new Error('无法生成图片');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `杠精法庭-${(S.result?.case?.case_title || '判决书').replace(/[\\/:*?"<>|]/g, '')}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

/** 手写换行绘制：中文按字符断行 */
function drawWrapped(ctx, text, x, y, maxWidth, lineHeight) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    if (!para) { lines.push(''); continue; }
    let cur = '';
    for (const ch of para) {
      const test = cur + ch;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = ch; }
      else cur = test;
    }
    lines.push(cur);
  }
  let ly = y;
  for (const line of lines) { ctx.fillText(line, x, ly); ly += lineHeight; }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ── 复制文字 ───────────────────────────────────────────── */

async function copyVerdict() {
  const v = S.result;
  if (!v) return;
  const text = [
    v.case?.court || '', v.case?.case_no || '',
    '', v.verdict_title || '',
    v.retitle ? `（${v.retitle}）` : '',
    '', '判决主文：' + (v.sentence || ''),
    '', v.verdict_text || '',
    v.quotes?.length ? '\n被告当庭金句：\n' + v.quotes.map(q => '「' + q + '」').join('\n') : '',
    v.da_best ? '\n检察官致命一击：「' + v.da_best + '」' : '',
    v.judge_private ? '\n法官私评：' + v.judge_private : '',
    v.epilogue ? '\n庭后花絮：' + v.epilogue : '',
  ].filter(Boolean).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    toast('判决书已复制到剪贴板');
  } catch {
    // 回退：选中 + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('判决书已复制到剪贴板'); }
    catch { toast('复制失败，请手动选择文字'); }
    ta.remove();
  }
}

/* ── 输入框自适应高度 ───────────────────────────────────── */

function autoGrow() {
  el.say.style.height = 'auto';
  el.say.style.height = Math.min(132, Math.max(46, el.say.scrollHeight)) + 'px';
}

/* ── 事件绑定 ───────────────────────────────────────────── */

// 首页模式选择
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => startCase(btn.dataset.mode));
});

$('btn-again-case')?.addEventListener('click', () => {
  $('btn-again-case').hidden = true;
  toast('回首页选程序');
  show(el.home);
});

// 发言
el.btnSay.addEventListener('click', doSay);
el.say.addEventListener('input', () => { autoGrow(); refreshControls(); });
el.say.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    doSay();
  }
});

// 宣判
el.btnVerdict.addEventListener('click', doVerdict);
// 补充取证 / 结案陈词 / 上诉
el.btnExhibit.addEventListener('click', doExhibit);
el.btnClosing.addEventListener('click', doClosing);
el.btnAppeal.addEventListener('click', doAppeal);

// 状态面板展开/收起
el.statusSummary.addEventListener('click', () => setStatusOpen(!S.statusOpen));

// 抽屉
$('btn-dossier').addEventListener('click', () => openDrawer(el.dossier));
$('btn-dossier-close').addEventListener('click', closeDrawers);
$('btn-menu').addEventListener('click', () => {
  el.menuNote.textContent = S.intensity === 'quick'
    ? '当前为速审程序，5 次发言后自动宣判。'
    : '当前为普通程序，你可以一直辩下去。';
  openDrawer(el.menu);
});
$('btn-menu-close').addEventListener('click', closeDrawers);
el.scrim.addEventListener('click', closeDrawers);
$('btn-menu-verdict').addEventListener('click', () => { closeDrawers(); doVerdict(); });
$('btn-menu-restart').addEventListener('click', () => {
  closeDrawers();
  if (S.hasSaidAnything && !confirm('重新立案会丢掉当前这场庭审，确定吗？')) return;
  show(el.home);
  $('btn-again-case').hidden = true;
});

// 判决书操作
$('btn-save-img').addEventListener('click', async () => {
  const b = $('btn-save-img');
  b.disabled = true; b.textContent = '正在生成…';
  try {
    await exportVerdictImage();
    toast('已保存判决书图片');
  } catch (e) {
    toast('生成图片失败：' + e.message, 4000);
  } finally {
    b.disabled = false; b.textContent = '保存判决书图片';
  }
});
$('btn-copy').addEventListener('click', copyVerdict);
$('btn-again').addEventListener('click', () => show(el.home));

// 全局快捷键
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawers();
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'enter') {
    e.preventDefault();
    if (el.trial.classList.contains('active')) doVerdict();
  }
});

/* ── 离线演示模式 ───────────────────────────────────────── */

/** 仅供 ?demo=1 使用的小本本样片 */
const DEMO_GRUDGES = [
  { n: 1, quote: '法官大人，我承认我按了闹钟。但按掉闹钟不等于偷走早晨，我只是在跟它协商。', note: '他已自认"按了闹钟"，这是入侵的起点', level: 4, raised: 2, firstRound: 0 },
  { n: 2, quote: '那二十五分钟是我用加班换来的。我偷自己的时间，犯什么法？', note: '把私人账目当成公共豁免，可主张其账目造假', level: 3, raised: 1, firstRound: 1 },
];

/** 仅供 ?demo=1 使用：法官态度账样片 */
const DEMO_LEDGER = [
  { n: 1, quote: '法官大人，我承认我按了闹钟。但按掉闹钟不等于偷走早晨，我只是在跟它协商。', note: '当庭把"协商"当挡箭牌，态度轻慢', level: 3, raised: 1, firstRound: 0 },
  { n: 2, quote: '那二十五分钟是我用加班换来的。我偷自己的时间，犯什么法？', note: '反问法庭，属于对法庭不敬', level: 2, raised: 0, firstRound: 1 },
];

/**
 * ?demo=1            首页 + 法官画像
 * ?demo=1&stage=trial 直接进庭审（样片记录）
 * ?demo=1&stage=verdict 直接进判决书
 */
async function runDemo(stage) {
  const d = await (await fetch('/api/demo')).json();
  if (!d.ok) throw new Error('演示数据不可用');

  S.sid = 'demo';
  S.intensity = d.intensity;
  S.quickRounds = d.quickRounds;
  S.caseData = d.case;
  S.result = d.result;
  S.canVerdict = true;
  S.hasSaidAnything = false;

  el.portraitName.textContent = d.portrait.name;
  el.portraitTemper.textContent = d.portrait.temper;
  el.portraitLine.textContent = '「' + d.portrait.line + '」';
  el.portrait.hidden = false;

  if (stage !== 'trial' && stage !== 'verdict') return;

  // 布置庭审屏
  el.tCourt.textContent = d.case.court + '　' + d.case.case_no;
  el.tCase.textContent = d.case.case_title;
  el.tCharge.textContent = d.case.charge;
  el.transcript.innerHTML = '';
  renderDossier();
  S.round = 2;
  refreshControls();

  for (const t of d.transcript) {
    addMessage(t.role, {
      name: t.role === 'prosecutor' ? d.case.prosecutor.name
        : t.role === 'judge' ? d.case.judge.name
        : t.role === 'witness' ? t.name : undefined,
      content: t.content,
      quote: t.quote || null,
      sign: t.sign || undefined,
      action: t.action || undefined,
      place: t.place || undefined,
      effect: t.effect || undefined,
    });
  }

  // 演示两本账（样片数据，与真实庭审同一套渲染）
  renderGrudges(DEMO_GRUDGES, DEMO_LEDGER, {
    recalled: { n: 1, times: 2, isCallback: true }, escalated: [2],
    ruleUsed: { n: 2, times: 1, isCallback: false }, ledgerEscalated: [],
  });
  renderDossier();

  if (stage === 'verdict') {
    renderVerdict(d.result);
    show(el.verdict);
  } else {
    show(el.trial);
  }
  // 原本这里有一句 document.body.classList.add('demo-mode')，
  // 但 CSS 里从来没有 demo-mode 规则，是死代码，已删。
}

/* ── 启动 ───────────────────────────────────────────────── */

(async function boot() {
  refreshControls();
  autoGrow();

  const qs = new URLSearchParams(location.search);
  if (qs.get('demo') === '1') {
    try {
      await runDemo(qs.get('stage') || '');
      return;
    } catch (e) {
      toast('演示模式加载失败：' + e.message, 5000);
    }
  }

  // 首页法官画像（异步，失败不阻塞）
  try {
    const r = await fetch('/api/portrait');
    const d = await r.json();
    if (d.ok && d.portrait) {
      el.portraitName.textContent = d.portrait.name;
      el.portraitTemper.textContent = d.portrait.temper;
      el.portraitLine.textContent = '「' + d.portrait.line + '」';
      el.portrait.hidden = false;
    }
  } catch { /* 忽略 */ }

  // 服务没起来 / 模型不可用 / 公网限流，都在这里一次性说清楚
  try {
    const h = await (await fetch('/api/health')).json();
    if (!h.model_ready) toast('没有可用的模型端点，法庭不会说话', 6000);
    // 不再显示"还剩多少场"——场次已经不限制了，只留一句防刷爆的说明
    if (h.public && h.perMinutePerIp) {
      const el2 = $('home-foot');
      if (el2) el2.textContent = `本庭为公网体验版 · 每人每分钟最多 ${h.perMinutePerIp} 次操作`;
    }
    // 思考档位选择器 + 策略卡清单（都是静态接口，零成本）
    try {
      const s = await (await fetch('/api/settings')).json();
      if (s.ok) {
        if (Array.isArray(s.thinkLevels) && s.thinkLevels.length) thinkLevels = s.thinkLevels;
        if (Array.isArray(s.severityLevels) && s.severityLevels.length) severityLevels = s.severityLevels;
        readLocalPicks();
        drawPickers(s);
      }
    } catch { /* 忽略 */ }
    try {
      const st = await (await fetch('/api/strategies')).json();
      if (st.ok && Array.isArray(st.strategies)) { S.strategies = st.strategies; renderStrategies(); }
    } catch { /* 忽略 */ }
  } catch {
    toast('连不上本地服务，请确认 server.mjs 正在运行', 6000);
  }
})();

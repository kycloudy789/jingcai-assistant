/* 由 scripts/build-web.js 生成，请勿手改。源码：shared/ + web/js/ */
(function(){
"use strict";
var __modules = {};
var __cache = {};
function __define(id, factory){ __modules[id] = factory; }
function __resolve(fromId, request){
  var base = fromId.split("/").slice(0, -1);
  var parts = request.split("/");
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p === "" || p === ".") continue;
    if (p === "..") base.pop(); else base.push(p);
  }
  var id = base.join("/");
  if (id.slice(-3) !== ".js") id += ".js";
  return id;
}
function __makeRequire(fromId){
  return function(request){
    var id = __resolve(fromId, request);
    if (__cache[id]) return __cache[id].exports;
    var factory = __modules[id];
    if (!factory) throw new Error("模块未打包: " + id + "（引用自 " + fromId + "）");
    var mod = { exports: {} };
    __cache[id] = mod;
    factory(mod, mod.exports, __makeRequire(id));
    return mod.exports;
  };
}

/* ===== web/js/app.js ===== */
__define("web/js/app.js", function(module, exports, require){
/**
 * 竞彩助手 · Web 版入口（纯静态，无后端）。
 * 数据：开奖来自仓库内定时生成的 JSON；个人记录存本机；AI 用你自己填的 Key 直连 DeepSeek。
 */
const repo = require('./repo');
const store = require('./store');
const { createAi } = require('./ai');
const { GAME, GAME_META, PURCHASE_STATUS, DISCLAIMER } = require('../../shared/constants/games');
const { validateNumbers } = require('../../shared/validators/numbers');
const { suggestCost } = require('../../shared/rules/registry');
const { STRATEGY_META } = require('../../shared/domain/candidates');

const ai = createAi({
  store,
  getGate: () => repo.gateState(),
  saveBatch: (batch) => repo.saveCandidateBatch(batch),
});
const { emptyBet, betLabel, randomBets } = require('./bets');

const TABS = [
  { key: 'draws', label: '开奖' },
  { key: 'candidates', label: '选号' },
  { key: 'tickets', label: '我的号码' },
  { key: 'stats', label: '统计' },
  { key: 'ai', label: 'AI' },
  { key: 'data', label: '数据' },
];

const STATUS_TEXT = { draft: '草稿', confirmed: '已购买', void: '已作废' };

const PENDING_TEXT = {
  FUYUN_STATUS_UNKNOWN: '该期福运奖是否执行无法确认，转人工复核。',
  PRIZE_AMOUNT_PENDING: '该奖级单注奖金尚未在官方公告中确认。',
  NO_RULE_VERSION: '该期没有已建档的规则版本，不支持自动判奖。',
  NO_DRAW: '该期开奖数据尚未同步。',
  DRAW_NOT_VERIFIED: '该期开奖数据尚未核验。',
};

const SSQ_LEVEL = {
  1: '一等奖',
  2: '二等奖',
  3: '三等奖',
  4: '四等奖',
  5: '五等奖',
  6: '六等奖',
  fuyun: '福运奖',
};

const state = {
  tab: 'draws',
  game: GAME.SSQ,
  draws: [],
  tickets: [],
  checks: new Map(),
  stats: null,
  syncInfo: null,
  busy: false,
  message: null,
  lastError: null,
  form: null,
  detail: null,
  ai: { messages: [], busy: false, error: '', keyDraft: '', notice: '' },
  analytics: null,
  window: 30,
  ticketGame: 'all',
  restore: null,
  candidates: {
    gate: null,
    batches: [],
    last: null,
    detail: null,
    busy: false,
    error: '',
    form: {
      strategy: 'random',
      count: 3,
      targetIssue: '',
      include: '',
      exclude: '',
      seed: '',
      avoidPatterns: true,
      avoidRepeat: true,
      includeCold: 0,
      window: 30,
      sumMin: '',
      sumMax: '',
    },
  },
};

function esc(text) {
  return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function yuan(n) {
  if (n === null || n === undefined) return '待公告';
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)} 亿元`;
  if (n >= 10000) return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 2)} 万元`;
  return `${n} 元`;
}

function balls(numbers, game) {
  const isKl8 = game === GAME.KL8;
  const main = isKl8 ? numbers.kl8 || [] : numbers.red || [];
  const html = main.map((n) => `<span class="ball ${isKl8 ? 'kl8' : 'red'}">${pad2(n)}</span>`).join('');
  const blue =
    !isKl8 && numbers.blue !== null && numbers.blue !== undefined
      ? `<span class="ball blue">${pad2(numbers.blue)}</span>`
      : '';
  return `<div class="balls">${html}${blue}</div>`;
}

function notify(text, kind = 'info') {
  state.message = { text, kind, at: Date.now() };
  render();
  setTimeout(() => {
    if (state.message && Date.now() - state.message.at >= 2400) {
      state.message = null;
      render();
    }
  }, 2600);
}

function header() {
  return `
    <header class="top">
      <div class="brand">
        <span class="logo">竞</span>
        <div>
          <h1>竞彩助手</h1>
          <p class="sub">双色球 / 快乐8 选十 · 本地档案</p>
        </div>
      </div>
      <nav class="tabs">
        ${TABS.map(
          (t) =>
            `<button class="tab ${state.tab === t.key ? 'on' : ''}" data-act="tab" data-tab="${t.key}">${t.label}</button>`
        ).join('')}
      </nav>
    </header>`;
}

function messageBar() {
  if (!state.message) return '';
  return `<div class="toast ${state.message.kind}">${esc(state.message.text)}</div>`;
}

function gameSwitch() {
  return `
    <div class="segmented">
      ${[GAME.SSQ, GAME.KL8]
        .map(
          (g) =>
            `<button class="seg ${state.game === g ? 'on' : ''}" data-act="game" data-game="${g}">${
              GAME_META[g].shortName
            }</button>`
        )
        .join('')}
    </div>`;
}

function prizeRows(draw) {
  const info = draw.prizeInfo || {};
  if (draw.game === GAME.SSQ) {
    const rows = [
      ['一等奖', '6 红 + 1 蓝', info.first],
      ['二等奖', '6 红', info.second],
      ['三等奖', '5 红 + 1 蓝', info.third],
      ['四等奖', '5 红，或 4 红 + 1 蓝', info.fourth],
      ['五等奖', '4 红，或 3 红 + 1 蓝', info.fifth],
      ['六等奖', '1 蓝', info.sixth],
    ];
    if (info.fuyun) rows.push(['福运奖', '命中 3 红', info.fuyun]);
    return rows
      .map(
        ([name, cond, g]) => `
        <tr>
          <td>${name}<span class="cond">${cond}</span></td>
          <td class="num">${g && g.count !== null && g.count !== undefined ? g.count : '—'}</td>
          <td class="num">${g ? yuan(g.amount) : '—'}</td>
        </tr>`
      )
      .join('');
  }
  const c10 = info.choose10 || {};
  const rows = [
    ['中 10', 'hit10'],
    ['中 9', 'hit9'],
    ['中 8', 'hit8'],
    ['中 7', 'hit7'],
    ['中 6', 'hit6'],
    ['中 5', 'hit5'],
    ['中 0', 'hit0'],
  ];
  return rows
    .map(([name, key]) => {
      const g = c10[key];
      const amount = g ? (key === 'hit10' && (!g.amount || g.count === 0) ? '当期无人中' : yuan(g.amount)) : '—';
      return `<tr><td>${name}</td><td class="num">${g && g.count !== null ? g.count : '—'}</td><td class="num">${amount}</td></tr>`;
    })
    .join('');
}

function drawsView() {
  const sync = state.syncInfo || {};
  return `
    ${gameSwitch()}
    <div class="toolbar">
      <span class="muted">数据生成：${
        sync.generatedAt ? esc(sync.generatedAt.slice(0, 16).replace('T', ' ')) : '未知'
      } · 共 ${state.draws.length} 期</span>
      <div class="toolbar-actions">
        <button class="btn" data-act="sync" ${state.busy ? 'disabled' : ''}>${
          state.busy ? '同步中…' : '重新加载开奖'
        }</button>
      </div>
    </div>
    ${state.draws.length === 0 ? emptyBlock('还没有开奖数据', '点「重新加载开奖」从仓库里的 JSON 读取；若失败，可在「数据」页手动导入 CSV / JSON。') : ''}
    <div class="list">
      ${state.draws
        .map((d) => {
          const open = state.detail === d.id;
          return `
        <article class="card draw ${open ? 'open' : ''}">
          <div class="row-head" data-act="draw-toggle" data-id="${d.id}">
            <div class="row-title">
              <strong>${d.issue}</strong>
              <span class="muted">${d.drawDate}</span>
            </div>
            <span class="badge ok">已核验</span>
          </div>
          ${balls(d.numbers, d.game)}
          <div class="row-foot">
            <span class="muted">${d.ruleVersion || '无规则版本'} · 奖池 ${d.poolAmount ? yuan(d.poolAmount) : '—'}</span>
            <span class="link">${open ? '收起' : '奖级明细'}</span>
          </div>
          ${
            open
              ? `
          <div class="detail">
            <table class="prize">
              <thead><tr><th>奖级</th><th class="num">注数</th><th class="num">单注奖金</th></tr></thead>
              <tbody>${prizeRows(d)}</tbody>
            </table>
            <p class="muted small">来源：${
              d.sourceUrl ? `<a href="${esc(d.sourceUrl)}" target="_blank" rel="noreferrer">中国福彩网公告</a>` : '未知'
            } · 解析器 ${esc(d.parserVersion || '—')} · 核验 ${esc((d.verifiedAt || '').slice(0, 10))}</p>
            <p class="muted small">浮动奖金额取自当期公告；当期无人中或未公布时显示为待公告，不做估算。</p>
          </div>`
              : ''
          }
        </article>`;
        })
        .join('')}
    </div>`;
}

function renderCheck(c) {
  if (c.checkStatus === 'pending_manual_review') {
    return `<div><strong>待人工核验</strong><p class="small">${
      PENDING_TEXT[c.pendingReason] || '存在需要人工确认的情况。'
    }</p></div>`;
  }
  if (c.checkStatus === 'not_winner') {
    const hit = c.hit || {};
    const text =
      c.game === GAME.SSQ
        ? `命中 ${hit.red === undefined ? '-' : hit.red} 个红球${hit.blue ? ' + 蓝球' : ''}`
        : `命中 ${hit.count === undefined ? '-' : hit.count} 个号码`;
    return `<div><strong>未中奖</strong><p class="small">${text}</p></div>`;
  }
  const label = c.game === GAME.SSQ ? SSQ_LEVEL[c.prizeLevel] || `${c.prizeLevel} 等奖` : `选十中 ${c.prizeLevel}`;
  return `<div>
    <strong>中奖：${label}</strong>
    <p class="amount">${
      c.totalPrize === null || c.totalPrize === undefined
        ? `单注${yuan(c.unitPrize)}（待公告）`
        : yuan(c.totalPrize)
    }${c.quantity > 1 ? ` · ${c.quantity} 注` : ''}</p>
    <p class="small muted">命中号码：${((c.hit && c.hit.numbers) || []).map(pad2).join(' ') || '—'} · 规则 ${esc(
      c.ruleVersion || '—'
    )}</p>
  </div>`;
}

function ticketDetail(t, check) {
  if (t.purchaseStatus === PURCHASE_STATUS.DRAFT) {
    return `<div class="detail">
      <div class="form-inline">
        <label>实际金额（元）<input id="cost-${t.id}" type="number" min="0" step="1" value="${
          t.actualCost === null || t.actualCost === undefined
            ? (suggestCost(t.game, t.multiple || 1).value || '')
            : t.actualCost
        }" /></label>
        <label>倍数<input id="mult-${t.id}" type="number" min="1" max="99" value="${t.multiple}" /></label>
        <label>购买日期<input id="date-${t.id}" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
      </div>
      <p class="muted small">金额已按 ${t.multiple || 1} 倍 × 2 元/注预填，按实际支付改即可（赠票填 0）。</p>
      <div class="actions">
        <button class="btn primary" data-act="confirm" data-id="${t.id}">确认已购买（冻结号码）</button>
        <button class="btn danger-outline" data-act="void" data-id="${t.id}">作废</button>
        <button class="btn danger-outline" data-act="delete" data-id="${t.id}">删除</button>
      </div>
    </div>`;
  }
  if (t.purchaseStatus === PURCHASE_STATUS.CONFIRMED) {
    return `<div class="detail">
      <div class="check-box ${check && check.isWinner ? 'win' : check && check.checkStatus === 'pending_manual_review' ? 'warn' : ''}">
        ${check ? renderCheck(check) : '<span class="muted">尚未核对</span>'}
      </div>
      <div class="actions">
        <button class="btn" data-act="check-one" data-id="${t.id}">${check ? '重新核对' : '核对开奖结果'}</button>
        <button class="btn danger-outline" data-act="void" data-id="${t.id}">作废</button>
      </div>
      <p class="muted small">已购买后号码冻结；如需改号，请作废后新建。删除需先作废。</p>
    </div>`;
  }
  return `<div class="detail"><div class="actions"><button class="btn danger-outline" data-act="delete" data-id="${t.id}">永久删除</button></div></div>`;
}

function purchaseDateText(t) {
  if (t.purchaseStatus !== PURCHASE_STATUS.CONFIRMED) {
    return t.purchaseStatus === PURCHASE_STATUS.VOID ? '已作废' : '未确认购买';
  }
  if (!t.purchaseAt) return '购买日期未记录';
  const d = new Date(t.purchaseAt);
  if (Number.isNaN(d.getTime())) return '购买日期未记录';
  return `购买于 ${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function ticketCard(t) {
  const c = state.checks.get(t.id);
  let badge = '';
  if (t.purchaseStatus === PURCHASE_STATUS.CONFIRMED && c) {
    if (c.checkStatus === 'checked') badge = `<span class="badge win">中奖 ${c.totalPrize ? yuan(c.totalPrize) : ''}</span>`;
    else if (c.checkStatus === 'not_winner') badge = `<span class="badge plain">未中奖</span>`;
    else badge = `<span class="badge warn">待人工核验</span>`;
  }
  const open = state.detail === t.id;
  return `
    <article class="card ticket ${open ? 'open' : ''}">
      <div class="row-head" data-act="ticket-toggle" data-id="${t.id}">
        <div class="row-title">
          <strong>${esc(t.issue)}</strong>
          <span class="muted">${GAME_META[t.game].shortName}</span>
          ${badge}
        </div>
        <span class="badge ${t.purchaseStatus}">${STATUS_TEXT[t.purchaseStatus]}</span>
      </div>
      ${balls(t.numbers, t.game)}
      <div class="row-foot">
        <span class="muted">${t.multiple} 倍 · ${
          t.actualCost === null || t.actualCost === undefined ? '金额待补录' : `${t.actualCost} 元`
        } · ${purchaseDateText(t)}</span>
        <span class="link">${open ? '收起' : '详情'}</span>
      </div>
      ${open ? ticketDetail(t, c) : ''}
    </article>`;
}

function ticketForm() {
  const f = state.form;
  const isSsq = f.game === GAME.SSQ;
  const active = Math.min(f.active || 0, f.bets.length - 1);
  const bet = f.bets[active] || emptyBet();
  const suggestion = suggestCost(f.game, Number(f.multiple) || 1);

  const grid = (from, to, selected, act) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .map(
        (n) =>
          `<button class="pick ${selected.includes(n) ? 'on' : ''}" data-act="${act}" data-n="${n}">${pad2(n)}</button>`
      )
      .join('');

  const chips = f.bets
    .map(
      (b, i) => `
      <button class="bet-chip ${i === active ? 'on' : ''}" data-act="bet-select" data-i="${i}">
        <span>第 ${i + 1} 注</span>
        <em>${esc(betLabel(b, f.game))}</em>
      </button>`
    )
    .join('');

  return `
    <section class="card form">
      <div class="form-head">
        <strong>新增号码</strong>
        <button class="link" data-act="close-form">取消</button>
      </div>
      <div class="segmented">
        ${[GAME.SSQ, GAME.KL8]
          .map(
            (g) =>
              `<button class="seg ${f.game === g ? 'on' : ''}" data-act="form-game" data-game="${g}">${
                GAME_META[g].shortName
              }</button>`
          )
          .join('')}
      </div>
      <label class="field">目标期号
        <input id="f-issue" type="text" inputmode="numeric" maxlength="7" placeholder="如 2026127" value="${esc(
          f.issue || ''
        )}" />
      </label>
      <p class="muted small">期号请按官方销售公告填写，本工具不会用「上期 + 1」推算。</p>

      <div class="bet-bar">
        <label class="bet-count">注数
          <input id="f-betcount" type="number" min="1" max="5" value="${f.bets.length}" />
        </label>
        <button class="btn" data-act="random">随机生成</button>
        <button class="btn" data-act="bet-add">加一注</button>
        ${
          f.bets.length > 1
            ? `<button class="btn danger-outline" data-act="bet-remove" data-i="${active}">删当前注</button>`
            : ''
        }
      </div>
      <p class="muted small">注数 = 生成几注<b>不同</b>号码（最多 5 注）；倍数 = 每注打几倍，两者分开算钱。</p>

      ${f.bets.length > 1 ? `<div class="bet-chips">${chips}</div><p class="muted small">点某一注可切换编辑目标。</p>` : ''}

      ${
        isSsq
          ? `<div class="pick-group"><div class="pick-title">红球 <span class="muted">${
              bet.red.length
            }/6</span></div><div class="grid">${grid(1, 33, bet.red, 'pick-red')}</div></div>
           <div class="pick-group"><div class="pick-title">蓝球 <span class="muted">${
             bet.blue ? 1 : 0
           }/1</span></div><div class="grid small">${grid(1, 16, bet.blue ? [bet.blue] : [], 'pick-blue')}</div></div>`
          : `<div class="pick-group"><div class="pick-title">选十号码 <span class="muted">${
              bet.kl8.length
            }/10</span></div><div class="grid">${grid(1, 80, bet.kl8, 'pick-kl8')}</div></div>`
      }

      <div class="form-inline">
        <label>每注倍数<input id="f-multiple" type="number" min="1" max="99" value="${f.multiple || 1}" /></label>
        <label>每注金额（元，可留空）<input id="f-cost" type="number" min="0" placeholder="${
          suggestion.value ? `建议 ${suggestion.value}` : '按实际支付'
        }" value="${f.cost === null ? '' : f.cost}" /></label>
        <label>备注<input id="f-note" type="text" placeholder="选填" value="${esc(f.note || '')}" /></label>
      </div>

      <div class="actions">
        <button class="btn" data-act="clear-picks">清空当前注</button>
        <button class="btn primary" data-act="save-ticket">保存 ${f.bets.length} 注为草稿</button>
      </div>
      <p class="muted small">保存后都是「草稿」，不计入花费与中奖。线下真的买了，再逐注确认已购买（确认后号码冻结）。</p>
    </section>`;
}

function ticketsView() {
  const counts = state.stats ? state.stats.counts : { draft: 0, confirmed: 0, void: 0 };
  const filter = state.ticketGame || 'all';
  const visible = state.tickets.filter((t) => filter === 'all' || t.game === filter);

  const groupOf = (game) => visible.filter((t) => t.game === game);
  const ssq = groupOf(GAME.SSQ);
  const kl8 = groupOf(GAME.KL8);

  const section = (game, items) =>
    items.length
      ? `<div class="game-group">
          <div class="group-head">
            <strong>${GAME_META[game].shortName}</strong>
            <span class="muted">${items.length} 注</span>
          </div>
          <div class="list">${items.map(ticketCard).join('')}</div>
        </div>`
      : '';

  const empty =
    visible.length === 0 && !state.form
      ? emptyBlock(
          filter === 'all' ? '还没有号码记录' : `还没有${GAME_META[filter].shortName}的记录`,
          '点「新增号码」手动录入或随机生成。候选/随机号码也只生成草稿，必须你确认购买后才计入统计与判奖。'
        )
      : '';

  return `
    <div class="toolbar">
      <span class="muted">草稿 ${counts.draft || 0} · 已购买 ${counts.confirmed || 0} · 已作废 ${counts.void || 0}</span>
      <div class="toolbar-actions">
        <button class="btn" data-act="check-all" ${state.busy ? 'disabled' : ''}>一键核对</button>
        <button class="btn primary" data-act="new-ticket">新增号码</button>
      </div>
    </div>
    <div class="segmented game-filter">
      ${[
        { key: 'all', label: `全部 ${state.tickets.length}` },
        { key: GAME.SSQ, label: `${GAME_META[GAME.SSQ].shortName} ${state.tickets.filter((t) => t.game === GAME.SSQ).length}` },
        { key: GAME.KL8, label: `${GAME_META[GAME.KL8].shortName} ${state.tickets.filter((t) => t.game === GAME.KL8).length}` },
      ]
        .map(
          (o) =>
            `<button class="seg ${filter === o.key ? 'on' : ''}" data-act="ticket-game" data-game="${o.key}">${o.label}</button>`
        )
        .join('')}
    </div>
    ${state.form ? ticketForm() : ''}
    ${empty}
    ${section(GAME.SSQ, ssq)}
    ${section(GAME.KL8, kl8)}`;
}

/* ---------------- 选号：候选组合（阶段 6） ---------------- */

// balanced 已从界面移除（历史批次仍可展示，故 STRATEGY_META 保留它）
const STRATEGY_ORDER = ['random', 'preference', 'analyzed'];
const ANALYTICS_WINDOWS = [30, 50, 100, 200, 300, 1000, 3000];

function candForm() {
  return {
    strategy: 'random',
    count: 3,
    targetIssue: '',
    include: '',
    exclude: '',
    seed: '',
    avoidPatterns: true,
    avoidRepeat: true,
    includeCold: 0,
    window: 30,
    sumMin: '',
    sumMax: '',
  };
}

function readCandForm() {
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '') : '';
  };
  const bool = (id, fallback) => {
    const el = document.getElementById(id);
    return el ? !!el.checked : fallback;
  };
  const f = state.candidates.form;
  return {
    strategy: f.strategy,
    count: Number(val('cand-count') || f.count || 3),
    targetIssue: val('cand-issue').trim(),
    include: val('cand-include').trim(),
    exclude: val('cand-exclude').trim(),
    seed: val('cand-seed').trim(),
    avoidPatterns: bool('cand-avoid-patterns', f.avoidPatterns),
    avoidRepeat: bool('cand-avoid-repeat', f.avoidRepeat),
    includeCold: Number(val('cand-cold') || f.includeCold || 0),
    window: Number(val('cand-window') || f.window || 30),
    sumMin: val('cand-sum-min').trim(),
    sumMax: val('cand-sum-max').trim(),
  };
}

/** 只有填了和值区间才传，避免空字符串被当成 0 */
function buildAnalysisInput(f) {
  const input = {
    avoidPatterns: f.avoidPatterns !== false,
    avoidRepeat: f.avoidRepeat !== false,
    includeCold: Number(f.includeCold) || 0,
    window: Number(f.window) || 30,
  };
  if (f.sumMin !== '' && f.sumMax !== '') {
    input.sumRange = [Number(f.sumMin), Number(f.sumMax)];
  }
  return input;
}

function splitNumbers(text) {
  return String(text || '')
    .split(/[\s,，、]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);
}

function batchGroupsHtml(batch) {
  return `<div class="batch-groups">${batch.groups
    .map(
      (g) => `<div class="batch-group">
        <span class="bet-idx">第 ${g.index + 1} 注</span>
        ${balls(g.numbers, batch.game)}
        ${
          g.crowd
            ? `<span class="crowd-badge ${g.crowd.level}">拥挤 ${g.crowd.index}</span>`
            : ''
        }
      </div>
      ${
        g.crowd && g.crowd.factors && g.crowd.factors.length
          ? `<div class="crowd-why">${esc(g.crowd.factors.join('；'))}</div>`
          : ''
      }`
    )
    .join('')}</div>`;
}

/** 兼顾的代价：把"为了冷门牺牲了什么"直接摊开，不只报喜 */
function tradeoffHtml(tradeoff) {
  if (!tradeoff) return '';
  return `
    <div class="tradeoff">
      <div class="muted small">平均拥挤指数 ${tradeoff.avgCrowdIndex}（越低越冷门）· 和值 ${tradeoff.sumRange[0]}–${tradeoff.sumRange[1]} · ${tradeoff.withHighNumber} 注含 32/33 类大号 · ${tradeoff.withConsecutive} 注带连号</div>
      <div class="muted small">${esc(tradeoff.note)}</div>
    </div>`;
}

function batchMetaLine(b) {
  const meta = STRATEGY_META[b.strategy] || { label: b.strategy };
  const when = String(b.createdAt || '').replace('T', ' ').slice(0, 16);
  return `${meta.label} · ${b.count} 注 · 种子 ${b.randomSeed}${b.seedGenerated ? '（自动）' : ''} · ${when}`;
}

function sampleHint(window) {
  const available = state.draws.length;
  const want = Number(window) || 30;
  if (available >= want) return `本地已同步 ${available} 期，本次按近 ${want} 期统计。`;
  return `本地只有 ${available} 期，不足 ${want} 期——本次按实际 ${available} 期统计，样本偏小。到「开奖」页同步或跑 npm run publish:data 可补足。`;
}

function analysisPanel(f) {
  return `
    <div class="analysis-panel">
      <div class="pick-title">分析权重</div>
      <label class="check-row"><input id="cand-avoid-patterns" type="checkbox" ${f.avoidPatterns ? 'checked' : ''} /> 避开连号、等差、同尾扎堆</label>
      <label class="check-row"><input id="cand-avoid-repeat" type="checkbox" ${f.avoidRepeat ? 'checked' : ''} /> 不含上一期开奖号码</label>
      <div class="form-inline">
        <label>统计窗口
          <select id="cand-window">
            ${ANALYTICS_WINDOWS.map(
                (w) =>
                  `<option value="${w}" ${Number(f.window) === w ? 'selected' : ''}>近 ${w} 期</option>`
              ).join('')}
          </select>
        </label>
        <label>每注至少带几个冷号<input id="cand-cold" type="number" min="0" max="2" value="${f.includeCold}" /></label>
        <label>和值下限<input id="cand-sum-min" type="number" placeholder="默认 ${state.game === GAME.SSQ ? 75 : 300}" value="${esc(f.sumMin)}" /></label>
        <label>和值上限<input id="cand-sum-max" type="number" placeholder="默认 ${state.game === GAME.SSQ ? 130 : 500}" value="${esc(f.sumMax)}" /></label>
      </div>
      <p class="muted small">${sampleHint(f.window)}</p>
      <p class="muted small">冷号 = 所选窗口内没出现的号码。这里只把它当"大众较少选"的号码用，不代表它"该开了"——这是两件事。</p>
      <p class="muted small">生成时会采 600 组候选，丢掉不合格的，再按「拥挤度 + 和值偏离惩罚」取最优。</p>
    </div>`;
}

function candidatesView() {
  const c = state.candidates;
  const gate = c.gate;

  if (!gate || !gate.candidateGeneration) {
    return `
      <section class="card gate">
        <div class="form-head"><strong>候选组合</strong><span class="gate-tag off">已关闭</span></div>
        <p class="muted small">这个功能默认关闭。开启后可以按策略生成 1–5 注号码组合；导入「我的号码」后一律是<b>草稿</b>，不计入花费与中奖。</p>
        <p class="muted small">开启前请确认你理解：组合由随机算法产生，历史开奖号码不会改变任何概率，本工具不做预测、也不能提高中奖机会。</p>
        <label class="check-row"><input id="cand-ai" type="checkbox" /> 同时允许 AI 助手调用候选生成（可随时关闭）</label>
        <div class="actions">
          <button class="btn primary" data-act="cand-enable">我已了解，开启</button>
        </div>
        <p class="muted small">这是自托管静态站，没有平台可审批；开启代表你本人的知情确认，不是任何机构批准。</p>
      </section>`;
  }

  const f = c.form;
  const last = c.last;
  const history = c.batches;

  return `
    <section class="card">
      <div class="form-head">
        <strong>候选组合</strong>
        <span class="gate-tag on">已开启</span>
      </div>
      <p class="muted small">生成的是号码组合，不是购买记录。同一「随机种子 + 参数」永远得到同一批号码，便于复盘。</p>

      <div class="segmented">
        ${[GAME.SSQ, GAME.KL8]
          .map(
            (g) => `<button class="seg ${state.game === g ? 'on' : ''}" data-act="game" data-game="${g}">${GAME_META[g].shortName}</button>`
          )
          .join('')}
      </div>

      <div class="pick-title" style="margin-top:12px">策略</div>
      <div class="segmented">
        ${STRATEGY_ORDER.map(
          (s) =>
            `<button class="seg ${f.strategy === s ? 'on' : ''}" data-act="cand-strategy" data-strategy="${s}">${STRATEGY_META[s].label}</button>`
        ).join('')}
      </div>
      <p class="muted small">${esc((STRATEGY_META[f.strategy] || {}).desc || '')}</p>

      <div class="form-inline">
        <label>注数（1–5）<input id="cand-count" type="number" min="1" max="5" value="${f.count}" /></label>
        <label>目标期号<input id="cand-issue" type="text" inputmode="numeric" maxlength="7" placeholder="如 2026127" value="${esc(f.targetIssue)}" /></label>
        <label>随机种子（可留空）<input id="cand-seed" type="text" maxlength="64" placeholder="留空=自动生成" value="${esc(f.seed)}" /></label>
      </div>

      ${f.strategy === 'preference'
        ? `<div class="form-inline">
            <label>必含号码<input id="cand-include" type="text" placeholder="如 3 9，最多 ${state.game === GAME.SSQ ? 6 : 10} 个" value="${esc(f.include)}" /></label>
            <label>排除号码<input id="cand-exclude" type="text" placeholder="如 1 2，最多 30 个" value="${esc(f.exclude)}" /></label>
          </div>`
        : ''}

      ${f.strategy === 'analyzed' ? analysisPanel(f) : ''}

      <div class="actions">
        <button class="btn primary" data-act="cand-generate" ${c.busy ? 'disabled' : ''}>${c.busy ? '生成中…' : '生成'}</button>
        <button class="link" data-act="cand-disable">关闭候选功能</button>
      </div>
      ${c.error ? `<p class="small bad-text">${esc(c.error)}</p>` : ''}
    </section>

    ${last
      ? `<section class="card">
          <div class="form-head">
            <strong>本次结果</strong>
            <button class="link" data-act="cand-import" data-id="${last.id}">导入为草稿</button>
          </div>
          <div class="muted small">${esc(batchMetaLine(last))} · 算法 ${esc(last.algorithmVersion)}</div>
          ${
            last.targetIssue
              ? `<div class="muted small">目标期 ${esc(last.targetIssue)}</div>`
              : `<label class="field">目标期号（导入前必填）
                   <input id="cand-import-issue" type="text" inputmode="numeric" maxlength="7" placeholder="如 2026127" />
                 </label>`
          }
          ${batchGroupsHtml(last)}
          ${tradeoffHtml(last.tradeoff)}
          ${
            last.analysis
              ? `<p class="muted small">分析窗口：近 ${last.analysis.window} 期（实际用 ${last.analysis.sampleSize} 期）${
                  last.analysis.dataSufficient ? '' : ' — 样本不足，冷号与重号判断会偏粗'
                }</p>`
              : ''
          }
          <p class="muted small">导入后是草稿：需要在「我的号码」里逐注确认已购买，才会进入花费与中奖统计。</p>
          <p class="muted small">中奖概率与任何选号方式完全相同；上面这些分析只影响"万一中的是浮动奖，会不会被很多人平分"。</p>
        </section>`
      : ''}

    <section class="card">
      <div class="form-head"><strong>历史批次</strong><span class="muted small">共 ${history.length} 批</span></div>
      ${
        history.length
          ? history
              .map(
                (b) => `
        <div class="batch">
          <div class="batch-head">
            <div>
              <div class="batch-title">${esc((STRATEGY_META[b.strategy] || {}).label || b.strategy)} · ${b.count} 注</div>
              <div class="muted small">${esc(batchMetaLine(b))}${b.targetIssue ? ` · 期号 ${esc(b.targetIssue)}` : ''}</div>
              <div class="muted small">${
                b.importedAt ? `已导入 ${b.importedTicketIds ? b.importedTicketIds.length : b.count} 注草稿` : '尚未导入'
              }${b.tradeoff ? ` · 平均拥挤 ${b.tradeoff.avgCrowdIndex}` : ''}${
                b.review ? ` · 该期最高命中 ${b.review.best ? b.review.best.totalHits : 0} 个` : ''
              }</div>
            </div>
            <div class="batch-ops">
              <button class="link" data-act="cand-toggle" data-id="${b.id}">${c.detail === b.id ? '收起' : '展开'}</button>
              <button class="link danger" data-act="cand-delete" data-id="${b.id}">删除</button>
            </div>
          </div>
          ${
            c.detail === b.id
              ? `${batchGroupsHtml(b)}${tradeoffHtml(b.tradeoff)}${b.review ? batchReviewHtml(b.review) : ''}`
              : ''
          }
        </div>`
              )
              .join('')
          : '<p class="muted small">还没有生成过批次。生成后会留在这里，包含策略、种子与参数快照。</p>'
      }
    </section>`;
}

function batchReviewHtml(review) {
  return `
    <div class="review">
      <div class="muted small">与 ${esc(review.issue)} 期开奖号码的重合数（仅描述，不判奖）</div>
      ${review.groups
        .map(
          (g) =>
            `<div class="muted small">第 ${g.index + 1} 注：中 ${g.mainHits} 个${
              g.blueHit === null ? '' : g.blueHit ? ' + 蓝球' : ''
            }${g.matched.length ? `（${g.matched.map(pad2).join(' ')}）` : ''}</div>`
        )
        .join('')}
      <div class="muted small">${esc(review.note)}</div>
    </div>`;
}

function barRow(label, count, max, suffix) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return `<div class="bar-row"><span class="bar-label">${esc(label)}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-val">${count}${suffix || ''}</span></div>`;
}

function numberList(title, rows) {
  if (!rows || !rows.length) return '';
  return `<div class="mini-list">
    <div class="mini-title">${esc(title)}</div>
    ${rows
      .map(
        (r) =>
          `<div class="mini-row"><span class="mono">${String(r.number).padStart(2, '0')}</span><span class="muted">${r.count} 次 · 遗漏 ${r.omission} 期</span></div>`
      )
      .join('')}
  </div>`;
}

function structureCard(a) {
  if (!a) return '';
  const freq = a.frequency;
  if (!freq.ok) {
    return `<section class="card"><h2>开奖结构</h2><p class="muted small">${esc(freq.message)}</p></section>`;
  }

  const sum = a.sum;
  const parity = a.parity;
  const zones = a.zones;
  const cons = a.consecutive;

  const maxSum = sum.ok ? Math.max(...sum.buckets.map((b) => b.count), 1) : 1;
  const maxParity = parity.ok ? Math.max(...parity.rows.map((r) => r.count), 1) : 1;
  const maxZone = zones.ok ? Math.max(...zones.zones.map((z) => z.count), 1) : 1;

  return `
    <section class="card">
      <div class="form-head">
        <h2>开奖结构</h2>
        <div class="segmented tiny">
          ${ANALYTICS_WINDOWS.map(
            (w) => `<button class="seg ${state.window === w ? 'on' : ''}" data-act="stat-window" data-window="${w}">近 ${w} 期</button>`
          ).join('')}
        </div>
      </div>
      <p class="muted small">样本 ${freq.sampleSize} 期（${esc(freq.issueRange.from)}–${esc(freq.issueRange.to)}）。${esc(freq.note)}</p>

      <div class="mini-grid">
        ${numberList('出现最多', freq.mostSeen)}
        ${numberList('出现最少', freq.leastSeen)}
        ${numberList('遗漏最长', freq.longestOmission)}
      </div>

      ${
        sum.ok
          ? `<div class="chart-block">
              <div class="chart-title">和值分布（最小 ${sum.min} / 平均 ${sum.avg} / 中位 ${sum.median} / 最大 ${sum.max}）</div>
              ${sum.buckets.map((b) => barRow(`${b.from}–${b.to}`, b.count, maxSum, ' 期')).join('')}
            </div>`
          : ''
      }

      ${
        parity.ok
          ? `<div class="chart-block">
              <div class="chart-title">奇偶结构（奇数个数 → 出现期数）</div>
              ${parity.rows.map((r) => barRow(`${r.odd} 奇 ${r.even} 偶`, r.count, maxParity, ' 期')).join('')}
            </div>`
          : ''
      }

      ${
        zones.ok
          ? `<div class="chart-block">
              <div class="chart-title">分区占比（平均每期 ${zones.zones.map((z) => z.avgPerIssue).join(' / ')} 个）</div>
              ${zones.zones.map((z) => barRow(z.label, z.count, maxZone, ` 个 · ${z.share}%`)).join('')}
              <p class="muted small">${esc(zones.note)}</p>
            </div>`
          : ''
      }

      ${
        cons.ok
          ? `<div class="chart-block">
              <div class="chart-title">连号</div>
              <p class="muted small">${cons.sampleSize} 期里有 ${cons.withConsecutive} 期出现连号（${cons.share}%），平均每期 ${cons.avgPairs} 对。</p>
            </div>`
          : ''
      }
    </section>`;
}

function hitsCard(a, game) {
  if (!a || !a.hits) return '';
  const h = a.hits;
  if (!h.ok) {
    return `<section class="card"><h2>我的命中分布</h2><p class="muted small">${esc(h.message)}</p></section>`;
  }
  const max = Math.max(...h.rows.map((r) => r.count), 1);
  return `
    <section class="card">
      <h2>我的命中分布（${GAME_META[game].shortName}）</h2>
      <p class="muted small">共 ${h.sampleSize} 条核对结果。${
        game === GAME.SSQ ? `其中 ${h.blueHits} 注命中蓝球。` : ''
      }${esc(h.note)}</p>
      ${h.rows
        .filter((r) => r.count > 0 || r.hits <= 3)
        .map((r) => barRow(`中 ${r.hits} 个`, r.count, max, ' 注'))
        .join('')}
    </section>`;
}

function statsView() {
  const s = state.stats;
  if (!s) return emptyBlock('还没有统计数据', '先录入并确认购买号码。');
  const rows = Object.keys(s.byGame || {})
    .map((g) => {
      const b = s.byGame[g];
      return `<tr><td>${GAME_META[g].shortName}</td><td class="num">${b.tickets}</td><td class="num">${b.cost} 元</td><td class="num">${b.winners}</td><td class="num">${b.prize} 元</td></tr>`;
    })
    .join('');

  return `
    <div class="grid-cards">
      <div class="stat"><span class="stat-label">已购买注数</span><strong>${s.counts.confirmed || 0}</strong></div>
      <div class="stat"><span class="stat-label">投入</span><strong>${s.cost} 元</strong></div>
      <div class="stat"><span class="stat-label">中奖笔数</span><strong>${s.winners}</strong></div>
      <div class="stat"><span class="stat-label">奖金合计</span><strong>${s.prize} 元</strong></div>
      <div class="stat"><span class="stat-label">净额</span><strong class="${s.net >= 0 ? 'up' : 'down'}">${
        s.net >= 0 ? '+' : ''
      }${s.net} 元</strong></div>
      <div class="stat"><span class="stat-label">待处理</span><strong>${s.pending + s.unchecked}</strong></div>
    </div>
    <section class="card">
      <table class="prize">
        <thead><tr><th>彩种</th><th class="num">已购买</th><th class="num">投入</th><th class="num">中奖</th><th class="num">奖金</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">暂无已确认购买的记录</td></tr>'}</tbody>
      </table>
      <p class="muted small">只统计「已购买」的记录；草稿与已作废不计入。奖金来自核对结果，待人工核验与待公告的金额未计入。${
        s.missingCost > 0 ? `另有 ${s.missingCost} 条未填金额，投入金额偏低。` : ''
      }</p>
    </section>
    ${structureCard(state.analytics)}
    ${hitsCard(state.analytics, state.game)}`;
}

function aiView() {
  const a = state.ai;
  if (!ai.hasKey()) {
    return `
      <section class="card">
        <h2>接入 AI 助手</h2>
        <p class="muted small">AI 使用你自己提供的 DeepSeek API Key，只保存在这台浏览器里，不会上传到任何服务器。</p>
        <label class="field">DeepSeek API Key
          <input id="ai-key" type="password" placeholder="sk-..." value="${esc(a.keyDraft || '')}" autocomplete="off" />
        </label>
        <div class="actions">
          <button class="btn primary" data-act="ai-save-key">保存并验证</button>
          <a class="btn" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">去获取 Key</a>
        </div>
        <p class="muted small">Key 存在浏览器 localStorage：同一浏览器上的其他脚本或扩展理论上可读取。请用可随时吊销的 Key，不用时点「清除密钥」。费用由你的 DeepSeek 账户承担。</p>
        ${a.notice ? `<p class="small ${a.error ? 'bad-text' : 'ok-text'}">${esc(a.notice)}</p>` : ''}
      </section>`;
  }

  const messages = a.messages
    .map(
      (m) => `
      <div class="chat-row ${m.role}">
        <div class="bubble">${esc(m.text)}</div>
        ${m.tools && m.tools.length ? `<div class="muted small">已查询：${esc(m.tools.join('、'))}</div>` : ''}
      </div>`
    )
    .join('');

  return `
    <section class="card chat">
      <div class="form-head">
        <strong>AI 助手</strong>
        <div class="inline-actions">
          <button class="link" data-act="ai-verify">验证密钥</button>
          <button class="link" data-act="ai-reset">新对话</button>
          <button class="link" data-act="ai-clear-key">清除密钥</button>
        </div>
      </div>
      ${a.error ? `<p class="small bad-text">${esc(a.error)}</p>` : ''}
      <div class="chat-body">
        ${messages || '<p class="muted small">可以问：最新一期开奖是多少、我买了哪些号码、快乐8 中 8 个多少钱、某期适用哪版规则。</p>'}
        ${a.busy ? '<div class="chat-row assistant"><div class="bubble thinking">正在查询数据…</div></div>' : ''}
      </div>
      <div class="chat-input-row">
        <input id="ai-input" type="text" maxlength="1000" placeholder="问点什么…" ${a.busy ? 'disabled' : ''} />
        <button class="btn primary" data-act="ai-send" ${a.busy ? 'disabled' : ''}>发送</button>
      </div>
      <p class="muted small">回答由 DeepSeek 生成，事实来自本地已核验数据；不给预测，不构成购彩建议。</p>
      ${
        state.candidates.gate && !state.candidates.gate.aiFutureNumber
          ? '<p class="muted small">候选号码生成未开启：需要时到「选号」页开启，AI 才能调用生成工具。</p>'
          : ''
      }
    </section>`;
}

function restorePanel() {
  const r = state.restore;
  if (!r || !r.preview) return '';
  const p = r.preview;
  const line = (label, v) =>
    v
      ? `<div class="mini-row"><span>${esc(label)}</span><span class="muted">新增 ${v.inserted} · 覆盖 ${v.replaced} · 保留现有 ${v.kept}</span></div>`
      : '';
  return `
    <div class="restore-box">
      <div class="chart-title">恢复预览${
        p.exportedAt ? `（导出于 ${esc(String(p.exportedAt).replace('T', ' ').slice(0, 16))}）` : ''
      }</div>
      ${line('号码记录', p.plan.tickets)}
      ${line('核对结果', p.plan.checks)}
      ${line('开奖缓存', p.plan.draws)}
      ${line('候选批次', p.plan.candidates)}
      <p class="muted small">恢复是「合并覆盖」：同 id 用备份里的版本替换，备份里没有的现有记录会保留（不会删你的数据）。${
        p.gate && p.gate.candidateGenerationEnabled
          ? '注意：这份备份里候选功能处于开启状态，恢复后会一并开启。'
          : ''
      }</p>
      <div class="actions">
        <button class="btn primary" data-act="restore-confirm">确认恢复</button>
        <button class="btn" data-act="restore-cancel">取消</button>
      </div>
    </div>`;
}

function dataView() {
  return `
    <section class="card">
      <h2>开奖数据</h2>
      <p class="muted small">开奖 JSON 由仓库定时抓取生成，与本站同源，无需跨域。也可以手动导入。</p>
      <div class="actions">
        <button class="btn" data-act="sync" ${state.busy ? 'disabled' : ''}>从仓库数据重新加载</button>
        <label class="btn file">导入 CSV<input type="file" accept=".csv,text/csv" data-file="csv" hidden /></label>
        <label class="btn file">导入 JSON<input type="file" accept=".json,application/json" data-file="json" hidden /></label>
      </div>
      <p class="muted small">CSV 模板：<a href="./data/samples/draws_template.csv" download>下载</a>（列：game,issue,drawDate,red,blue,kl8,...）。</p>
    </section>

    <section class="card">
      <h2>本机数据备份</h2>
      <p class="muted small">个人记录只存在这台设备的浏览器里。换设备或清缓存前请导出。</p>
      <div class="actions">
        <button class="btn" data-act="export">导出备份 JSON</button>
        <label class="btn file">恢复备份<input type="file" accept=".json" data-file="backup" hidden /></label>
      </div>
      ${restorePanel()}
    </section>

    <section class="card">
      <h2>清空数据</h2>
      <p class="muted small">可以只清某一类。清空前建议先导出备份；清空不可撤销。</p>
      <div class="actions">
        <button class="btn danger-outline" data-act="clear-tickets">清空号码记录</button>
        <button class="btn danger-outline" data-act="clear-checks">清空核对结果</button>
        <button class="btn danger-outline" data-act="clear-candidates">清空候选批次</button>
        <button class="btn danger-outline" data-act="clear-all">清空全部本地数据</button>
      </div>
    </section>

    <section class="card">
      <h2>关于数据</h2>
      <p class="muted small">开奖来源：中国福彩网。本站不做任何购彩、代购或兑奖代办；判奖结果仅供参考，兑奖以官方终端打印的彩票与法定机构认定为准。</p>
      <p class="muted small">${esc(DISCLAIMER)}</p>
    </section>`;
}

function emptyBlock(title, desc) {
  return `<div class="empty"><strong>${esc(title)}</strong><p class="muted small">${esc(desc)}</p></div>`;
}

function render() {
  const app = document.getElementById('app');
  if (app) app.dataset.ready = '1';
  const body =
    state.tab === 'draws'
      ? drawsView()
      : state.tab === 'tickets'
      ? ticketsView()
      : state.tab === 'candidates'
      ? candidatesView()
      : state.tab === 'stats'
      ? statsView()
      : state.tab === 'ai'
      ? aiView()
      : dataView();

  app.innerHTML = `${header()}${messageBar()}<main class="main">${body}</main>
    <footer class="foot"><span>本地优先 · 无后端</span><span>${esc(DISCLAIMER)}</span></footer>`;
}

async function refreshAll() {
  state.draws = await repo.listDraws(state.game, 100);
  state.tickets = await repo.listTickets();
  state.checks = await repo.latestChecks();
  state.stats = await repo.stats();
  state.syncInfo = await store.getMeta(`sync:${state.game}`);
  state.candidates.gate = await repo.gateState();
  state.candidates.batches = await repo.listCandidateReviews(state.game);
  state.analytics = await repo.analytics(state.game, state.window);
}

async function syncDraws() {
  state.busy = true;
  render();
  try {
    const results = [];
    for (const g of [GAME.SSQ, GAME.KL8]) {
      const r = await repo.syncFromSite(g);
      results.push(`${GAME_META[g].shortName} ${r.saved} 期`);
    }
    await refreshAll();
    notify(`已加载：${results.join('，')}`, 'ok');
  } catch (err) {
    state.lastError = err.message;
    notify(`加载失败：${err.message}`, 'bad');
  } finally {
    state.busy = false;
    render();
  }
}

function newForm() {
  return { game: state.game, issue: '', multiple: 1, cost: null, note: '', bets: [emptyBet()], active: 0 };
}

function readFormInputs() {
  const f = state.form;
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : undefined;
  };
  const costRaw = val('f-cost');
  return {
    ...f,
    issue: (val('f-issue') || '').trim(),
    multiple: Number(val('f-multiple') || 1),
    betCount: Number(val('f-betcount') || f.bets.length),
    cost: costRaw === '' || costRaw === undefined ? null : Number(costRaw),
    note: val('f-note') || '',
  };
}

async function saveTicket() {
  const f = readFormInputs();
  state.form = f;

  const inputs = [];
  for (let i = 0; i < f.bets.length; i += 1) {
    const bet = f.bets[i];
    const numbers = f.game === GAME.SSQ ? { red: bet.red, blue: bet.blue } : { kl8: bet.kl8 };
    const check = validateNumbers(f.game, numbers);
    if (!check.ok) {
      notify(`第 ${i + 1} 注：${check.message}`, 'bad');
      return;
    }
    inputs.push({
      game: f.game,
      issue: f.issue,
      numbers: check.normalized,
      multiple: f.multiple,
      actualCost: f.cost,
      note: f.note,
    });
  }

  const res = await repo.createTickets(inputs);
  if (!res.ok) {
    notify(res.message, 'bad');
    return;
  }
  state.form = null;
  await refreshAll();
  notify(`已存为 ${res.count} 注草稿`, 'ok');
}

function activeBetIndex(f) {
  return Math.min(Math.max(f.active || 0, 0), f.bets.length - 1);
}

function updateActiveBet(mutator) {
  const f = readFormInputs();
  const idx = activeBetIndex(f);
  const bet = { ...f.bets[idx] };
  mutator(bet);
  const bets = f.bets.slice();
  bets[idx] = bet;
  state.form = { ...f, bets, active: idx };
  render();
}

async function aiSend() {
  const a = state.ai;
  if (a.busy) return;
  const input = document.getElementById('ai-input');
  const text = (input && input.value ? input.value : '').trim();
  if (!text) return notify('先说点什么吧', 'bad');

  const history = a.messages.slice();
  a.messages.push({ id: `u${Date.now()}`, role: 'user', text });
  a.busy = true;
  a.error = '';
  render();

  try {
    const out = await ai.chat({ history, message: text });
    a.messages.push({
      id: `a${Date.now()}`,
      role: 'assistant',
      text: out.reply || '（没有内容）',
      tools: out.toolCalls.map((t) => t.name),
    });
  } catch (err) {
    a.error = err.message;
    if (err.code === 'AI_NO_KEY') a.messages.pop();
  } finally {
    a.busy = false;
    render();
  }
}

async function onAction(act, el) {
  const id = el.dataset.id;

  if (act === 'tab') {
    state.tab = el.dataset.tab;
    state.form = null;
    state.detail = null;
    await refreshAll();
    render();
    return;
  }
  if (act === 'game') {
    state.game = el.dataset.game;
    await refreshAll();
    render();
    return;
  }
  if (act === 'ticket-game') {
    state.ticketGame = el.dataset.game;
    state.detail = null;
    render();
    return;
  }
  if (act === 'draw-toggle' || act === 'ticket-toggle') {
    state.detail = state.detail === id ? null : id;
    render();
    return;
  }
  if (act === 'sync') return syncDraws();

  if (act === 'new-ticket') {
    state.form = newForm();
    state.detail = null;
    render();
    return;
  }
  if (act === 'close-form') {
    state.form = null;
    render();
    return;
  }
  if (act === 'form-game') {
    state.form = { ...state.form, game: el.dataset.game, bets: [emptyBet()], active: 0 };
    render();
    return;
  }
  if (act === 'bet-select') {
    const f = readFormInputs();
    state.form = { ...f, active: Number(el.dataset.i) };
    render();
    return;
  }
  if (act === 'bet-add') {
    const f = readFormInputs();
    if (f.bets.length >= 5) return notify('最多 5 注', 'bad');
    state.form = { ...f, bets: f.bets.concat([emptyBet()]), active: f.bets.length };
    render();
    return;
  }
  if (act === 'bet-remove') {
    const f = readFormInputs();
    if (f.bets.length <= 1) return notify('至少保留 1 注', 'bad');
    const i = Number(el.dataset.i);
    const bets = f.bets.filter((_, idx) => idx !== i);
    state.form = { ...f, bets, active: Math.max(0, i - 1) };
    render();
    return;
  }
  if (act === 'pick-red' || act === 'pick-blue' || act === 'pick-kl8') {
    const n = Number(el.dataset.n);
    updateActiveBet((bet) => {
      if (act === 'pick-red') {
        const idx = bet.red.indexOf(n);
        if (idx >= 0) bet.red.splice(idx, 1);
        else if (bet.red.length >= 6) {
          notify('红球最多 6 个', 'bad');
          return;
        } else bet.red.push(n);
        bet.red.sort((a, b) => a - b);
      } else if (act === 'pick-blue') {
        bet.blue = bet.blue === n ? null : n;
      } else {
        const idx = bet.kl8.indexOf(n);
        if (idx >= 0) bet.kl8.splice(idx, 1);
        else if (bet.kl8.length >= 10) {
          notify('选十只能选 10 个', 'bad');
          return;
        } else bet.kl8.push(n);
        bet.kl8.sort((a, b) => a - b);
      }
    });
    return;
  }
  if (act === 'random') {
    const f = readFormInputs();
    const count = Math.max(1, Math.min(5, f.betCount || f.bets.length));
    state.form = { ...f, bets: randomBets(f.game, count), active: 0 };
    render();
    return;
  }
  if (act === 'clear-picks') {
    updateActiveBet((bet) => {
      bet.red = [];
      bet.blue = null;
      bet.kl8 = [];
    });
    return;
  }
  if (act === 'save-ticket') return saveTicket();

  if (act === 'confirm') {
    const costEl = document.getElementById(`cost-${id}`);
    const multEl = document.getElementById(`mult-${id}`);
    const dateEl = document.getElementById(`date-${id}`);
    const multiple = Number(multEl && multEl.value) || 1;
    const suggestion = suggestCost(state.tickets.find((x) => x.id === id)?.game || state.game, multiple);
    const rawCost = costEl ? String(costEl.value).trim() : '';
    // 留空时按"倍数 × 单价"预填（单价已确认：两个彩种都是 2 元/注），不再强制手输
    const cost = rawCost === '' ? Number(suggestion.value) : Number(rawCost);
    if (!Number.isFinite(cost) || cost < 0) {
      return notify('金额不合法：请输入 0 或正数', 'bad');
    }
    const res = await repo.confirmTicket(id, {
      actualCost: cost,
      multiple,
      purchaseAt: dateEl && dateEl.value ? `${dateEl.value}T12:00:00+08:00` : undefined,
    });
    if (!res.ok) return notify(res.message, 'bad');
    await refreshAll();
    notify('已确认购买，号码已冻结', 'ok');
    return;
  }
  if (act === 'void') {
    if (!confirm('作废后不再计入花费与中奖统计，记录会保留。确定作废？')) return;
    const res = await repo.voidTicket(id, '');
    if (!res.ok) return notify(res.message, 'bad');
    await refreshAll();
    notify('已作废', 'ok');
    return;
  }
  if (act === 'delete') {
    if (!confirm('永久删除后无法恢复。确定删除？')) return;
    const res = await repo.deleteTicket(id);
    if (!res.ok) return notify(res.message, 'bad');
    await refreshAll();
    notify('已删除', 'ok');
    return;
  }
  if (act === 'check-one' || act === 'check-all') {
    const summary = await repo.runChecks();
    await refreshAll();
    if (summary.total === 0) return notify('没有已确认购买的号码', 'bad');
    if (summary.skipped === summary.total) {
      return notify('这些期号的已核验开奖还没同步，先加载开奖数据', 'bad');
    }
    notify(`核对完成：新核对 ${summary.inserted} 条，中奖 ${summary.winners} 条`, 'ok');
    return;
  }

  if (act === 'cand-enable') {
    const aiBox = document.getElementById('cand-ai');
    const allowAi = !!(aiBox && aiBox.checked);
    await repo.setCandidateGate(true, { allowAi });
    await refreshAll();
    notify(allowAi ? '候选生成已开启（AI 也可调用）' : '候选生成已开启', 'ok');
    render();
    return;
  }
  if (act === 'cand-disable') {
    if (!confirm('关闭后选号页只显示开关，已生成的批次与草稿都保留。确定关闭？')) return;
    await repo.setCandidateGate(false);
    state.candidates.last = null;
    state.candidates.detail = null;
    await refreshAll();
    notify('已关闭候选功能', 'ok');
    render();
    return;
  }
  if (act === 'cand-strategy') {
    const f = readCandForm();
    state.candidates.form = { ...f, strategy: el.dataset.strategy };
    render();
    return;
  }
  if (act === 'cand-generate') {
    const f = readCandForm();
    state.candidates.form = f;
    state.candidates.error = '';

    if (f.sumMin !== '' && f.sumMax !== '' && Number(f.sumMin) > Number(f.sumMax)) {
      state.candidates.error = '和值下限不能大于上限';
      render();
      return;
    }

    state.candidates.busy = true;
    render();
    const res = await repo.generateCandidateBatch({
      game: state.game,
      strategy: f.strategy,
      count: f.count,
      targetIssue: f.targetIssue || undefined,
      seed: f.seed || undefined,
      params: { include: splitNumbers(f.include), exclude: splitNumbers(f.exclude) },
      ...(f.strategy === 'analyzed' ? { analysis: buildAnalysisInput(f) } : {}),
    });
    state.candidates.busy = false;
    if (!res.ok) {
      state.candidates.error = res.message;
      render();
      return;
    }
    state.candidates.last = res.batch;
    // 把实际用到的种子回填，下次能复现同一批
    state.candidates.form = { ...f, seed: String(res.batch.randomSeed) };
    await refreshAll();
    const crowd = res.batch.tradeoff ? `，平均拥挤指数 ${res.batch.tradeoff.avgCrowdIndex}` : '';
    notify(`已生成 ${res.batch.count} 注（种子 ${res.batch.randomSeed}${crowd}）`, 'ok');
    return;
  }
  if (act === 'cand-import') {
    const issueEl = document.getElementById('cand-import-issue');
    const issue = issueEl ? issueEl.value.trim() : '';
    const res = await repo.importCandidateBatch(id, issue || undefined);
    if (!res.ok) return notify(res.message, 'bad');
    await refreshAll();
    notify(`已导入 ${res.count} 注草稿，到「我的号码」逐注确认购买`, 'ok');
    return;
  }
  if (act === 'cand-delete') {
    if (!confirm('删除这条批次记录？已导入的草稿不受影响。')) return;
    await repo.deleteCandidateBatch(id);
    if (state.candidates.last && state.candidates.last.id === id) state.candidates.last = null;
    if (state.candidates.detail === id) state.candidates.detail = null;
    await refreshAll();
    notify('已删除批次', 'ok');
    return;
  }
  if (act === 'cand-toggle') {
    state.candidates.detail = state.candidates.detail === id ? null : id;
    render();
    return;
  }

  if (act === 'ai-save-key') {
    const input = document.getElementById('ai-key');
    try {
      ai.setKey(input ? input.value : '');
      state.ai.keyDraft = '';
      state.ai.error = '';
      const check = await ai.verifyKey();
      state.ai.notice = check.ok ? `密钥可用（模型 ${check.model}）` : '';
      if (!check.ok) {
        state.ai.error = check.message;
        state.ai.notice = `已保存，但验证失败：${check.message}`;
      }
      render();
      if (check.ok) notify('密钥已保存并验证通过', 'ok');
    } catch (err) {
      state.ai.error = err.message;
      render();
    }
    return;
  }
  if (act === 'ai-clear-key') {
    if (!confirm('清除本机保存的密钥？清除后 AI 不可用，其他功能不受影响。')) return;
    ai.clearKey();
    state.ai = { messages: [], busy: false, error: '', keyDraft: '', notice: '' };
    render();
    notify('已清除密钥', 'ok');
    return;
  }
  if (act === 'ai-verify') {
    const check = await ai.verifyKey();
    if (check.ok) notify('密钥可用', 'ok');
    else {
      state.ai.error = check.message;
      render();
    }
    return;
  }
  if (act === 'ai-reset') {
    state.ai.messages = [];
    state.ai.error = '';
    render();
    return;
  }
  if (act === 'ai-send') return aiSend();

  if (act === 'stat-window') {
    state.window = Number(el.dataset.window) || 30;
    await refreshAll();
    render();
    return;
  }
  if (act === 'restore-cancel') {
    state.restore = null;
    notify('已取消恢复，没有写入任何数据', 'info');
    return;
  }
  if (act === 'restore-confirm') {
    if (!state.restore || !state.restore.payload) return;
    try {
      const counts = await repo.importAll(state.restore.payload);
      state.restore = null;
      await refreshAll();
      notify(
        `已恢复：号码 ${counts.tickets}、核对 ${counts.checks}、开奖 ${counts.draws}、候选 ${counts.candidates}`,
        'ok'
      );
    } catch (err) {
      notify(`恢复失败：${err.message}`, 'bad');
    }
    return;
  }
  if (act === 'clear-tickets') {
    if (!confirm('清空全部号码记录（含草稿与已购买）？核对结果不会一并删除。此操作不可撤销。')) return;
    await repo.clearCollection('tickets');
    await refreshAll();
    notify('已清空号码记录', 'ok');
    return;
  }
  if (act === 'clear-checks') {
    if (!confirm('清空全部核对结果？号码记录会保留，但需要重新核对才能看到中奖情况。')) return;
    await repo.clearCollection('checks');
    await refreshAll();
    notify('已清空核对结果', 'ok');
    return;
  }
  if (act === 'clear-candidates') {
    if (!confirm('清空全部候选批次？已导入的号码草稿不受影响。')) return;
    await repo.clearCollection('candidates');
    if (state.candidates) {
      state.candidates.batches = [];
      state.candidates.last = null;
      state.candidates.detail = null;
    }
    await refreshAll();
    notify('已清空候选批次', 'ok');
    return;
  }

  if (act === 'export') {
    const data = await repo.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jingcai-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify('已导出备份', 'ok');
    return;
  }
  if (act === 'clear-all') {
    if (!confirm('将清空本机的号码、核对与开奖缓存，且无法恢复。建议先导出备份。继续？')) return;
    await store.clearAll();
    await refreshAll();
    notify('已清空本地数据', 'ok');
  }
}

async function onFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const text = await file.text();
  const kind = input.dataset.file;
  try {
    if (kind === 'csv') {
      const res = await repo.importDrawsCsv(text);
      notify(`CSV 导入 ${res.saved} 条${res.errors.length ? `，跳过 ${res.errors.length} 行` : ''}`, res.saved ? 'ok' : 'bad');
    } else if (kind === 'json') {
      const res = await repo.importDrawsJson(text);
      notify(`JSON 导入 ${res.saved} 条${res.errors.length ? `，跳过 ${res.errors.length} 条` : ''}`, res.saved ? 'ok' : 'bad');
    } else {
      const payload = JSON.parse(text);
      const preview = await repo.previewImport(payload);
      if (!preview.ok) {
        notify(preview.message, 'bad');
        return;
      }
      state.restore = { payload, preview };
      render();
      notify('已读取备份，确认后才写入', 'ok');
      return;
    }
    await refreshAll();
  } catch (err) {
    notify(`导入失败：${err.message}`, 'bad');
  } finally {
    input.value = '';
  }
}

function bind() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) {
      e.preventDefault();
      onAction(el.dataset.act, el).catch((err) => notify(err.message, 'bad'));
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches('input[type=file][data-file]')) {
      onFile(e.target).catch((err) => notify(err.message, 'bad'));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'ai-input') {
      e.preventDefault();
      aiSend().catch((err) => notify(err.message, 'bad'));
    }
  });
}

async function boot() {
  bind();
  render();

  try {
    await refreshAll();
  } catch (err) {
    state.message = { text: `本地数据库不可用：${err.message}`, kind: 'bad', at: Date.now() };
  }
  render();

  if (!state.draws.length) {
    await syncDraws();
  }




  if (typeof location !== 'undefined' && location.search.indexOf('debug') >= 0) {
    document.title = JSON.stringify({
      draws: state.draws.length,
      tickets: state.tickets.length,
      aiKey: ai.hasKey(),
      error: state.lastError || null,
      msg: state.message ? state.message.text : null,
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

module.exports = { boot, state, repo, ai };

});

/* ===== web/js/repo.js ===== */
__define("web/js/repo.js", function(module, exports, require){
/**
 * 领域操作层：把 shared/ 的纯逻辑接到本地存储上。
 * 这里不复制任何判定规则——号码校验、状态机、判奖全部 require 自 shared/。
 */

const store = require('./store');
const { GAME, PURCHASE_STATUS, DEFAULT_FEATURE_FLAGS } = require('../../shared/constants/games');
const { validateDrawRecord } = require('../../shared/validators/draws');
const { resolveRuleVersion } = require('../../shared/rules/registry');
const { judgeTicket } = require('../../shared/rules/judge');
const { resolveCandidateGate, COMPLIANCE_STATUS } = require('../../shared/security/access');
const candidatesDomain = require('../../shared/domain/candidates');
const analyticsDomain = require('../../shared/domain/analytics');
const {
  buildTicketDraft,
  applyPatch,
  confirmPurchase,
  voidTicket: voidTicketDomain,
  canDeleteTicket,
} = require('../../shared/domain/tickets');
const { parseDrawsCsv } = require('../../shared/parsers/csv');
const { formatDisplay } = require('../../shared/validators/numbers');

const DRAW_DATA_PATH = 'data/draws';

function drawKey(game, issue) {
  return `${game}:${issue}`;
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 规范化一条开奖记录（补 id / 计算规则版本） */
function normalizeDraw(raw) {
  const check = validateDrawRecord(raw, { now: new Date() });
  if (!check.ok) return { ok: false, code: check.code, message: check.message, issue: raw && raw.issue };
  const record = check.normalized;
  const rule = resolveRuleVersion(record.game, record.issue);
  return {
    ok: true,
    record: {
      ...record,
      id: drawKey(record.game, record.issue),
      ruleVersion: record.ruleVersion || (rule.found ? rule.ruleVersion : null),
      drawStatus: 'verified',
      verifiedAt: record.verifiedAt || new Date().toISOString(),
    },
  };
}

async function loadDrawsFile(game) {
  const res = await fetch(`${DRAW_DATA_PATH}/${game}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`读取开奖数据失败（HTTP ${res.status}）`);
  const payload = await res.json();
  return payload;
}

/** 从站点自带的 JSON 同步开奖（由 GitHub Actions 定时生成） */
async function syncFromSite(game) {
  const payload = await loadDrawsFile(game);
  const rows = Array.isArray(payload.records) ? payload.records : [];
  const good = [];
  const errors = [];
  for (const raw of rows) {
    const n = normalizeDraw({ ...raw, game: raw.game || game });
    if (n.ok) good.push(n.record);
    else errors.push({ issue: raw.issue, message: n.message });
  }
  await store.putAll('draws', good);
  await store.setMeta(`sync:${game}`, {
    generatedAt: payload.generatedAt || null,
    fetchedAt: new Date().toISOString(),
    count: good.length,
  });
  return { total: rows.length, saved: good.length, errors, generatedAt: payload.generatedAt || null };
}

/** 导入 JSON（手动粘贴 / 文件） */
async function importDrawsJson(text) {
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload) ? payload : payload.records || payload.result || [];
  const game = payload.game || (rows[0] && rows[0].game);
  const good = [];
  const errors = [];
  for (const raw of rows) {
    const n = normalizeDraw({ ...raw, game: raw.game || game });
    if (n.ok) good.push(n.record);
    else errors.push({ issue: raw && raw.issue, message: n.message });
  }
  await store.putAll('draws', good);
  return { saved: good.length, errors };
}

/** 导入 CSV（兜底通道，与小程序版同一套解析器） */
async function importDrawsCsv(text) {
  const parsed = parseDrawsCsv(text, {
    validation: (r) => validateDrawRecord(r, { now: new Date() }),
  });
  const good = [];
  for (const r of parsed.records) {
    const n = normalizeDraw(r);
    if (n.ok) good.push(n.record);
  }
  await store.putAll('draws', good);
  return { saved: good.length, errors: parsed.errors };
}

async function listDraws(game, limit = 100) {
  const all = await store.getAll('draws');
  return all
    .filter((d) => d.game === game)
    .sort((a, b) => Number(b.issue) - Number(a.issue))
    .slice(0, limit);
}

async function getDraw(game, issue) {
  return store.get('draws', drawKey(game, issue));
}

async function getDrawMap(game) {
  const all = await store.getAll('draws');
  const map = new Map();
  for (const d of all) {
    if (!game || d.game === game) map.set(drawKey(d.game, d.issue), d);
  }
  return map;
}

async function listTickets() {
  const all = await store.getAll('tickets');
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createTicket(input) {
  const built = buildTicketDraft(input, { ownerOpenId: 'local' });
  if (!built.ok) return built;
  const record = { ...built.record, id: newId('t') };
  await store.put('tickets', record);
  return { ok: true, ticket: record };
}

/**
 * 批量建草稿（随机多注 / 候选导入）。
 * 任何一注不合法就整体不写，避免出现"部分成功"的糊涂账。
 */
async function createTickets(inputs) {
  const records = [];
  for (let i = 0; i < (inputs || []).length; i += 1) {
    const built = buildTicketDraft(inputs[i], { ownerOpenId: 'local' });
    if (!built.ok) {
      return { ok: false, code: built.code, message: `第 ${i + 1} 注：${built.message}`, index: i };
    }
    records.push({ ...built.record, id: newId('t') });
  }
  await store.putAll('tickets', records);
  return { ok: true, tickets: records, count: records.length };
}

async function updateTicket(id, patch) {
  const ticket = await store.get('tickets', id);
  if (!ticket) return { ok: false, code: 'NOT_FOUND', message: '记录不存在' };
  const patched = applyPatch(ticket, patch);
  if (!patched.ok) return patched;
  const next = { ...ticket, ...patched.update };
  await store.put('tickets', next);
  return { ok: true, ticket: next };
}

async function confirmTicket(id, payload) {
  const ticket = await store.get('tickets', id);
  if (!ticket) return { ok: false, code: 'NOT_FOUND', message: '记录不存在' };
  const res = confirmPurchase(ticket, payload);
  if (!res.ok) return res;
  const next = { ...ticket, ...res.update };
  await store.put('tickets', next);
  return { ok: true, ticket: next };
}

async function voidTicket(id, reason) {
  const ticket = await store.get('tickets', id);
  if (!ticket) return { ok: false, code: 'NOT_FOUND', message: '记录不存在' };
  const res = voidTicketDomain(ticket, { reason });
  if (!res.ok) return res;
  const next = { ...ticket, ...res.update };
  await store.put('tickets', next);
  return { ok: true, ticket: next };
}

async function deleteTicket(id) {
  const ticket = await store.get('tickets', id);
  const verdict = canDeleteTicket(ticket);
  if (!verdict.ok) return verdict;
  await store.remove('tickets', id);
  return { ok: true };
}

/**
 * 核对：与云端 checkTickets 同语义——只判已确认购买的票，只用于已核验开奖，
 * 幂等（同票+同期+同规则版本+同数据不重复写入）。
 */async function runChecks(game) {
  const [tickets, draws] = await Promise.all([store.getAll('tickets'), store.getAll('draws')]);
  const drawMap = new Map(draws.map((d) => [drawKey(d.game, d.issue), d]));
  const checks = await store.getAll('checks');
  const existing = new Set(checks.map((c) => c.idempotencyKey));

  const summary = { total: 0, inserted: 0, unchanged: 0, skipped: 0, winners: 0, pending: 0 };
  const toSave = [];

  for (const ticket of tickets) {
    if (ticket.purchaseStatus !== PURCHASE_STATUS.CONFIRMED) continue;
    if (game && ticket.game !== game) continue;
    summary.total += 1;

    const draw = drawMap.get(drawKey(ticket.game, ticket.issue)) || null;
    const result = judgeTicket(ticket, draw);
    if (!result.ok) {
      summary.skipped += 1;
      continue;
    }
    if (result.pendingReason === 'NO_DRAW' || result.pendingReason === 'DRAW_NOT_VERIFIED') {
      summary.skipped += 1;
      continue;
    }

    const idempotencyKey = `${ticket.id}|${draw ? draw.id : 'none'}|${result.ruleVersion}|${
      (draw && draw.rawHash) || 'nohash'
    }`;
    if (existing.has(idempotencyKey)) {
      summary.unchanged += 1;
      continue;
    }

    if (result.isWinner) summary.winners += 1;
    if (result.checkStatus === 'pending_manual_review') summary.pending += 1;

    toSave.push({
      id: newId('c'),
      ownerOpenId: 'local',
      ticketId: ticket.id,
      game: ticket.game,
      issue: ticket.issue,
      drawId: draw ? draw.id : null,
      drawHash: draw ? draw.rawHash || null : null,
      ruleVersion: result.ruleVersion,
      hit: result.hit,
      hitDetails: result.hit,
      prizeLevel: result.prizeLevel,
      unitPrize: result.unitPrize,
      quantity: result.quantity,
      totalPrize: result.totalPrize,
      checkStatus: result.checkStatus,
      pendingReason: result.pendingReason,
      isWinner: result.isWinner,
      idempotencyKey,
      checkedAt: new Date().toISOString(),
    });
    summary.inserted += 1;
  }

  await store.putAll('checks', toSave);
  return summary;
}

async function latestChecks() {
  const all = await store.getAll('checks');
  const map = new Map();
  for (const c of all) {
    const prev = map.get(c.ticketId);
    if (!prev || String(c.checkedAt) > String(prev.checkedAt)) map.set(c.ticketId, c);
  }
  return map;
}

/* ---------------- 候选组合（阶段 6） ---------------- */

const GATE_KEY = 'gate';

async function getGateFlags() {
  const saved = await store.getMeta(GATE_KEY);
  return { ...DEFAULT_FEATURE_FLAGS, ...(saved || {}) };
}

async function setGateFlags(patch) {
  const next = { ...(await getGateFlags()), ...(patch || {}) };
  await store.setMeta(GATE_KEY, next);
  return next;
}

/**
 * 闸门状态。静态站没有平台可审批，因此这里允许"本人显式确认"这一种状态
 * （见 decisions.md D23）。默认仍是关闭：用户不点开关就用不了。
 */
async function gateState() {
  const flags = await getGateFlags();
  return { flags, ...resolveCandidateGate(flags, { acceptSelfAttested: true }) };
}

async function setCandidateGate(enabled, options = {}) {
  const patch = enabled
    ? {
        wxComplianceStatus: COMPLIANCE_STATUS.SELF_ATTESTED,
        candidateGenerationEnabled: true,
        aiFutureNumberFeatureEnabled: options.allowAi !== false,
        acknowledgedAt: new Date().toISOString(),
      }
    : {
        wxComplianceStatus: DEFAULT_FEATURE_FLAGS.wxComplianceStatus,
        candidateGenerationEnabled: false,
        aiFutureNumberFeatureEnabled: false,
      };
  const flags = await setGateFlags(patch);
  return { flags, ...resolveCandidateGate(flags, { acceptSelfAttested: true }) };
}

/** 生成并落库一个批次；未开启闸门时直接拒绝（不靠前端隐藏按钮） */
async function generateCandidateBatch(input) {
  const gate = await gateState();
  if (!gate.candidateGeneration) {
    return {
      ok: false,
      code: 'FEATURE_DISABLED',
      message: '候选生成未开启，请先在上方确认开启',
      gate,
    };
  }
  // 分析选号需要近期开奖（冷号、上期重号）；其余策略不读数据，保持零依赖
  let recentDraws = [];
  if ((input && input.strategy) === 'analyzed') {
    // 多取一些：分析窗口可选 30/50/100，具体用多少期由 domain 按 window 截取
    recentDraws = await listDraws((input && input.game) || GAME.SSQ, 100);
  }

  const res = candidatesDomain.generateCandidates({
    ...(input || {}),
    recentDraws,
    previousDraw: recentDraws[0] || null,
    complianceState: gate.complianceState,
  });
  if (!res.ok) return res;

  const batch = await saveCandidateBatch(res.batch);
  return { ok: true, batch };
}

/** 批次落库（AI 生成与手动生成共用同一条路径，避免两套写入逻辑） */
async function saveCandidateBatch(batch) {
  const record = {
    ...batch,
    id: newId('b'),
    ownerOpenId: 'local',
    importedAt: null,
    importedTicketIds: [],
  };
  await store.put('candidates', record);
  return record;
}

async function listCandidates(game) {
  const all = await store.getAll('candidates');
  return all
    .filter((b) => !game || b.game === game)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function deleteCandidateBatch(id) {
  await store.remove('candidates', id);
  return { ok: true };
}

/**
 * 把批次导入为号码记录：**只生成 draft**，不改变"是否买了"。
 * 一注一条记录，便于逐注确认购买、逐注作废（与线下小票一致）。
 */
async function importCandidateBatch(id, issue) {
  const gate = await gateState();
  if (!gate.candidateGeneration) {
    return { ok: false, code: 'FEATURE_DISABLED', message: '候选功能未开启', gate };
  }
  const batch = await store.get('candidates', id);
  if (!batch) return { ok: false, code: 'NOT_FOUND', message: '批次不存在' };

  const targetIssue = String(issue || batch.targetIssue || '').trim();
  if (!targetIssue) {
    return { ok: false, code: 'ISSUE_REQUIRED', message: '请填写目标期号后再导入' };
  }

  const verify = candidatesDomain.verifyBatch(batch);
  if (!verify.ok) return verify;

  const inputs = batch.groups.map((g) => ({
    game: batch.game,
    issue: targetIssue,
    numbers: g.numbers,
    multiple: 1,
    recordSource: 'candidate_import',
    candidateId: `${batch.id}#${g.index}`,
  }));

  const res = await createTickets(inputs);
  if (!res.ok) return res;

  await store.put('candidates', {
    ...batch,
    targetIssue,
    importedAt: new Date().toISOString(),
    importedTicketIds: res.tickets.map((t) => t.id),
  });
  return { ok: true, count: res.count, ids: res.tickets.map((t) => t.id) };
}

/** 批次回看：目标期已开奖时，算每注与开奖号码的重合数（描述性，不判奖） */
async function listCandidateReviews(game) {
  const [batches, draws] = await Promise.all([listCandidates(game), store.getAll('draws')]);
  const map = new Map(draws.map((d) => [drawKey(d.game, d.issue), d]));
  return batches.map((b) => {
    const draw = b.targetIssue ? map.get(drawKey(b.game, b.targetIssue)) : null;
    const usable = draw && draw.drawStatus === 'verified' ? draw : null;
    return { ...b, review: usable ? candidatesDomain.reviewBatch(b, usable) : null };
  });
}

/** 统计：只统计已确认购买的票；奖金只来自核对结果 */
async function stats() {
  const [tickets, checks] = await Promise.all([store.getAll('tickets'), store.getAll('checks')]);
  const latest = new Map();
  for (const c of checks) {
    const prev = latest.get(c.ticketId);
    if (!prev || String(c.checkedAt) > String(prev.checkedAt)) latest.set(c.ticketId, c);
  }

  const byGame = {};
  const out = {
    counts: { draft: 0, confirmed: 0, void: 0 },
    byGame,
    cost: 0,
    missingCost: 0,
    winners: 0,
    prize: 0,
    pending: 0,
    unchecked: 0,
  };

  for (const t of tickets) {
    out.counts[t.purchaseStatus] = (out.counts[t.purchaseStatus] || 0) + 1;
    if (t.purchaseStatus !== PURCHASE_STATUS.CONFIRMED) continue;

    byGame[t.game] = byGame[t.game] || { tickets: 0, cost: 0, winners: 0, prize: 0 };
    byGame[t.game].tickets += 1;

    if (typeof t.actualCost === 'number') {
      out.cost += t.actualCost;
      byGame[t.game].cost += t.actualCost;
    } else {
      out.missingCost += 1;
    }

    const c = latest.get(t.id);
    if (!c) {
      out.unchecked += 1;
      continue;
    }
    if (c.checkStatus === 'pending_manual_review') out.pending += 1;
    if (c.isWinner) {
      out.winners += 1;
      byGame[t.game].winners += 1;
      if (typeof c.totalPrize === 'number') {
        out.prize += c.totalPrize;
        byGame[t.game].prize += c.totalPrize;
      }
    }
  }

  out.net = out.prize - out.cost;
  return out;
}

function decorateNumbers(draw) {
  return formatDisplay(draw.game, draw.numbers);
}

/** 统计：开奖结构 + 个人命中分布（只读，纯函数在 shared/domain/analytics.js） */
async function analytics(game, window) {
  const [draws, checks] = await Promise.all([
    store.getAll('draws'),
    store.getAll('checks'),
  ]);
  return analyticsDomain.buildAnalytics(
    game,
    draws.filter((d) => d.game === game),
    checks,
    { window: window || 30 }
  );
}

/** 恢复前预览：只读，不写库。告诉用户会新增多少、覆盖多少、保留多少 */
async function previewImport(payload) {
  if (!payload || (payload.schema !== 'jingcai-web@2' && payload.schema !== 'jingcai-web@1')) {
    return { ok: false, code: 'BAD_SCHEMA', message: '备份文件格式不匹配（需要 jingcai-web@1 或 @2）' };
  }
  const plan = {};
  for (const name of ['tickets', 'checks', 'draws', 'candidates', 'meta']) {
    const rows = Array.isArray(payload[name]) ? payload[name] : [];
    const key = name === 'meta' ? 'k' : 'id';
    const existing = await store.getAll(name);
    const existingIds = new Set(existing.map((r) => r[key]));
    const incomingIds = new Set(rows.map((r) => r[key]));
    const replaced = rows.filter((r) => existingIds.has(r[key])).length;
    plan[name] = {
      total: rows.length,
      replaced,
      inserted: rows.length - replaced,
      kept: existing.filter((r) => !incomingIds.has(r[key])).length,
    };
  }
  const gateRow = (Array.isArray(payload.meta) ? payload.meta : []).find((r) => r && r.k === 'gate');
  return {
    ok: true,
    schema: payload.schema,
    exportedAt: payload.exportedAt || null,
    plan,
    gate: gateRow ? gateRow.v : null,
  };
}

/** 仅清空某一类数据，不动其他 */
async function clearCollection(name) {
  const allowed = ['tickets', 'checks', 'candidates'];
  if (!allowed.includes(name)) {
    return { ok: false, code: 'NOT_ALLOWED', message: '不支持清空该集合' };
  }
  await store.clear(name);
  return { ok: true };
}

/** 全量导出（备份用） */
async function exportAll() {
  const [tickets, checks, draws, candidates, meta] = await Promise.all([
    store.getAll('tickets'),
    store.getAll('checks'),
    store.getAll('draws'),
    store.getAll('candidates'),
    store.getAll('meta'),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    schema: 'jingcai-web@2',
    tickets,
    checks,
    draws,
    candidates,
    meta,
  };
}

/** 导入备份：按 id 覆盖，不删除现有数据 */
async function importAll(payload) {
  if (!payload || (payload.schema !== 'jingcai-web@2' && payload.schema !== 'jingcai-web@1')) {
    throw new Error('备份文件格式不匹配（需要 jingcai-web@1 或 @2）');
  }
  const counts = {};
  for (const name of ['tickets', 'checks', 'draws', 'candidates', 'meta']) {
    const rows = Array.isArray(payload[name]) ? payload[name] : [];
    await store.putAll(name, rows);
    counts[name] = rows.length;
  }
  return counts;
}

module.exports = {
  DRAW_DATA_PATH,
  drawKey,
  syncFromSite,
  importDrawsJson,
  importDrawsCsv,
  listDraws,
  getDraw,
  getDrawMap,
  listTickets,
  createTicket,
  createTickets,
  updateTicket,
  confirmTicket,
  voidTicket,
  deleteTicket,
  runChecks,
  latestChecks,
  analytics,
  previewImport,
  clearCollection,
  getGateFlags,
  gateState,
  setCandidateGate,
  generateCandidateBatch,
  saveCandidateBatch,
  listCandidates,
  deleteCandidateBatch,
  importCandidateBatch,
  listCandidateReviews,
  stats,
  decorateNumbers,
  exportAll,
  importAll,
};

});

/* ===== web/js/store.js ===== */
__define("web/js/store.js", function(module, exports, require){
/**
 * 本地存储：优先 IndexedDB，失败则降级到 localStorage。
 * 纯静态站没有后端，所有个人数据只存在这台设备的浏览器里；
 * 换设备 / 清缓存会丢数据，所以「数据」页提供导出与导入。
 *
 * 为什么要降级：隐私模式、无痕窗口、部分内置浏览器会禁用或阻塞 IndexedDB，
 * 直接空白页比"能用的降级"更糟。
 */

const DB_NAME = 'jingcai_assistant';
const DB_VERSION = 2;
const STORES = ['draws', 'tickets', 'checks', 'candidates', 'meta'];
const LS_PREFIX = 'jc:';

let backendPromise = null;
let backendKind = null;

function keyPathOf(name) {
  return name === 'meta' ? 'k' : 'id';
}

/* ---------------- IndexedDB ---------------- */

function createIdbBackend() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('打开 IndexedDB 超时'));
    }, 3000);

    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: keyPathOf(name) });
        }
      }
    };
    req.onsuccess = () => {
      if (settled) {
        req.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(makeIdbApi(req.result));
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error || new Error('打开 IndexedDB 失败'));
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('IndexedDB 被其他标签页占用'));
    };
  });
}

function makeIdbApi(db) {
  function run(name, mode, fn) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(name, mode);
      } catch (err) {
        reject(err);
        return;
      }
      const store = tx.objectStore(name);
      let value;
      try {
        value = fn(store);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(value && value.__req ? value.__req.result : value);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中断'));
    });
  }

  return {
    kind: 'indexeddb',
    putAll(name, rows) {
      if (!rows || !rows.length) return Promise.resolve(0);
      return run(name, 'readwrite', (store) => {
        for (const row of rows) store.put(row);
        return rows.length;
      });
    },
    getAll(name) {
      return run(name, 'readonly', (store) => ({ __req: store.getAll() }));
    },
    get(name, id) {
      return run(name, 'readonly', (store) => ({ __req: store.get(id) }));
    },
    put(name, row) {
      return run(name, 'readwrite', (store) => {
        store.put(row);
        return row;
      });
    },
    remove(name, id) {
      return run(name, 'readwrite', (store) => {
        store.delete(id);
        return true;
      });
    },
    clear(name) {
      return run(name, 'readwrite', (store) => {
        store.clear();
        return true;
      });
    },
  };
}

/* ---------------- localStorage ---------------- */

function createLsBackend() {
  if (typeof localStorage === 'undefined') {
    throw new Error('当前环境既不支持 IndexedDB 也不支持 localStorage');
  }
  const probeKey = 'jc:__probe';
  localStorage.setItem(probeKey, '1');
  localStorage.removeItem(probeKey);

  function read(name) {
    try {
      const raw = localStorage.getItem(LS_PREFIX + name);
      const rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      return [];
    }
  }
  function write(name, rows) {
    localStorage.setItem(LS_PREFIX + name, JSON.stringify(rows));
    return rows.length;
  }
  function upsert(name, row) {
    const rows = read(name);
    const key = keyPathOf(name);
    const idx = rows.findIndex((r) => r[key] === row[key]);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    write(name, rows);
    return row;
  }

  return {
    kind: 'localstorage',
    putAll(name, rows) {
      if (!rows || !rows.length) return Promise.resolve(0);
      const all = read(name);
      const key = keyPathOf(name);
      const index = new Map(all.map((r) => [r[key], r]));
      for (const row of rows) index.set(row[key], row);
      write(name, Array.from(index.values()));
      return Promise.resolve(rows.length);
    },
    getAll: (name) => Promise.resolve(read(name)),
    get: (name, id) => Promise.resolve(read(name).find((r) => r[keyPathOf(name)] === id) || null),
    put: (name, row) => Promise.resolve(upsert(name, row)),
    remove: (name, id) => {
      const key = keyPathOf(name);
      write(name, read(name).filter((r) => r[key] !== id));
      return Promise.resolve(true);
    },
    clear: (name) => {
      localStorage.removeItem(LS_PREFIX + name);
      return Promise.resolve(true);
    },
  };
}

/* ---------------- 统一出口 ---------------- */

async function backend() {
  if (!backendPromise) {
    backendPromise = createIdbBackend()
      .catch(() => {
        const ls = createLsBackend();
        return ls;
      })
      .then((b) => {
        backendKind = b.kind;
        return b;
      });
  }
  return backendPromise;
}

async function putAll(name, rows) {
  return (await backend()).putAll(name, rows);
}

async function getAll(name) {
  const rows = await (await backend()).getAll(name);
  return Array.isArray(rows) ? rows : [];
}

async function get(name, id) {
  return (await backend()).get(name, id);
}

async function put(name, row) {
  return (await backend()).put(name, row);
}

async function remove(name, id) {
  return (await backend()).remove(name, id);
}

async function clear(name) {
  return (await backend()).clear(name);
}

async function clearAll() {
  for (const name of STORES) await clear(name);
}

async function getMeta(key) {
  const row = await get('meta', key);
  return row ? row.v : null;
}

async function setMeta(key, value) {
  await put('meta', { k: key, v: value });
  return value;
}

function kind() {
  return backendKind;
}

module.exports = {
  DB_NAME,
  STORES,
  backend,
  kind,
  putAll,
  getAll,
  get,
  put,
  remove,
  clear,
  clearAll,
  getMeta,
  setMeta,
};

});

/* ===== shared/constants/games.js ===== */
__define("shared/constants/games.js", function(module, exports, require){
/**
 * 彩种常量。所有模块只允许通过本文件引用彩种标识，禁止散落字符串。
 * 期号一律为字符串（禁止转数字比较）。
 */

const GAME = {
  SSQ: 'ssq',
  KL8: 'kl8',
};

const GAME_META = {
  [GAME.SSQ]: {
    game: GAME.SSQ,
    name: '双色球',
    shortName: '双色球',
    playType: 'single',
    redMin: 1,
    redMax: 33,
    redCount: 6,
    blueMin: 1,
    blueMax: 16,
    drawCount: 7, // 6 红 + 1 蓝
    displayOrder: 1,
  },
  [GAME.KL8]: {
    game: GAME.KL8,
    name: '快乐8（选十）',
    shortName: '快乐8',
    playType: 'choose10',
    min: 1,
    max: 80,
    count: 10,
    drawCount: 20,
    displayOrder: 2,
  },
};

/** 官方开奖公告列表页（主数据源，见 docs/data-source-plan.md） */
const SOURCE_URL = {
  [GAME.SSQ]: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
  [GAME.KL8]: 'https://www.cwl.gov.cn/ygkj/wqkjgg/kl8/',
};

/** 记录与核对状态枚举 */
const PURCHASE_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  VOID: 'void',
};

const DRAW_STATUS = {
  PENDING: 'pending',
  PARSED: 'parsed',
  CONFLICT: 'conflict',
  VERIFIED: 'verified',
  CORRECTED: 'corrected',
};

const SPECIAL_RULE_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable',
};

/** 合规闸门默认值：一律关闭（见 docs/compliance-checklist.md） */
const DEFAULT_FEATURE_FLAGS = {
  wxComplianceStatus: 'not_checked', // not_checked | pending | approved | rejected
  candidateGenerationEnabled: false,
  aiFutureNumberFeatureEnabled: false,
  productionFeaturePolicy: 'compliance-gated',
};

const DISCLAIMER =
  '本工具用于个人记录和娱乐数据分析；不提供官方预测或购彩服务；历史数据不代表未来结果。中奖以官方销售终端打印的彩票及法定兑奖机构认定为准。';

function isGame(game) {
  return game === GAME.SSQ || game === GAME.KL8;
}

module.exports = {
  GAME,
  GAME_META,
  SOURCE_URL,
  PURCHASE_STATUS,
  DRAW_STATUS,
  SPECIAL_RULE_STATUS,
  DEFAULT_FEATURE_FLAGS,
  DISCLAIMER,
  isGame,
};

});

/* ===== shared/validators/draws.js ===== */
__define("shared/validators/draws.js", function(module, exports, require){
/**
 * 开奖记录校验（主方案 9.4）。
 * 只有通过本校验的记录才允许进入 verified 状态，进而在阶段 4 参与判奖。
 */

const { GAME, GAME_META, DRAW_STATUS } = require('../constants/games');
const { validateSsq, validateKl8 } = require('./numbers');
const { isValidIssue } = require('../rules/registry');

const CODE = {
  OK: 'OK',
  GAME_UNSUPPORTED: 'GAME_UNSUPPORTED',
  ISSUE_INVALID: 'ISSUE_INVALID',
  DATE_INVALID: 'DATE_INVALID',
  DATE_FUTURE: 'DATE_FUTURE',
  NUMBERS_INVALID: 'NUMBERS_INVALID',
  AMOUNT_INVALID: 'AMOUNT_INVALID',
  STATUS_INVALID: 'STATUS_INVALID',
};

const ALLOWED_STATUS = new Set(Object.values(DRAW_STATUS));

/** "2026-11-03" → Date（按 Asia/Shanghai 零点） */
function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const dt = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(dt.getTime())) return null;
  const back = new Date(dt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return back === value ? dt : null;
}

function isMoneyOrNull(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * @param {object} record 规范记录
 * @param {{now?: Date, allowFutureDays?: number}} options
 */
function validateDrawRecord(record, options = {}) {
  if (!record || typeof record !== 'object') {
    return { ok: false, code: CODE.ISSUE_INVALID, message: '记录为空' };
  }
  const { game } = record;
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '不支持的彩种' };
  }
  if (!isValidIssue(record.issue)) {
    return { ok: false, code: CODE.ISSUE_INVALID, message: `期号不合法: ${record.issue}` };
  }

  const date = parseIsoDate(record.drawDate);
  if (!date) {
    return { ok: false, code: CODE.DATE_INVALID, message: `开奖日期不合法: ${record.drawDate}` };
  }
  const now = options.now || new Date();
  const allowFutureDays = options.allowFutureDays === undefined ? 1 : options.allowFutureDays;
  if (date.getTime() > now.getTime() + allowFutureDays * 86400000) {
    return { ok: false, code: CODE.DATE_FUTURE, message: '开奖日期晚于当前时间，疑似脏数据' };
  }

  const numbers = record.numbers || {};
  const numberCheck =
    game === GAME.SSQ
      ? validateSsq(numbers.red, numbers.blue)
      : validateKl8(numbers.kl8, { asDraw: true });

  // 快乐8 用 kl8 字段；双色球若误把号码塞进 kl8 也应被拒
  if (!numberCheck.ok) {
    return { ok: false, code: CODE.NUMBERS_INVALID, message: numberCheck.message };
  }

  if (record.drawStatus && !ALLOWED_STATUS.has(record.drawStatus)) {
    return { ok: false, code: CODE.STATUS_INVALID, message: `未知状态: ${record.drawStatus}` };
  }

  const moneyFields = ['salesAmount', 'poolAmount', 'fixedPoolAmount'];
  for (const field of moneyFields) {
    if (!isMoneyOrNull(record[field])) {
      return { ok: false, code: CODE.AMOUNT_INVALID, message: `${field} 金额不合法` };
    }
  }

  return { ok: true, code: CODE.OK, normalized: { ...record, numbers: numberCheck.normalized } };
}

/** 期号前 4 位即年份，用于列表筛选 */
function issueYear(issue) {
  return isValidIssue(issue) ? issue.slice(0, 4) : null;
}

/** 只有 verified / corrected 可参与判奖（parsed 只是解析成功） */
function isJudgeableStatus(status) {
  return status === DRAW_STATUS.VERIFIED || status === DRAW_STATUS.CORRECTED;
}

module.exports = {
  CODE,
  validateDrawRecord,
  parseIsoDate,
  issueYear,
  isJudgeableStatus,
  GAME_META,
};

});

/* ===== shared/validators/numbers.js ===== */
__define("shared/validators/numbers.js", function(module, exports, require){
/**
 * 号码校验与规范化（前后端共用，唯一实现）。
 * 约定：内部一律使用整数升序数组；两位数格式只在展示层处理。
 */

const { GAME, GAME_META } = require('../constants/games');

const CODE = {
  OK: 'OK',
  NUM_EMPTY: 'NUM_EMPTY',
  NUM_TYPE: 'NUM_TYPE',
  NUM_COUNT: 'NUM_COUNT',
  NUM_RANGE: 'NUM_RANGE',
  NUM_DUPLICATE: 'NUM_DUPLICATE',
  GAME_UNSUPPORTED: 'GAME_UNSUPPORTED',
};

/**
 * 宽松解析号码输入：支持 "1,2,3" / "01 02 03" / [1,2,3] / ["1","2"]
 * 只做切分与数字转换，合法性交给 validate*。
 * @returns {{ok: boolean, code?: string, values?: number[]}}
 */
function parseNumbers(input) {
  if (input === null || input === undefined) {
    return { ok: false, code: CODE.NUM_EMPTY };
  }
  let parts;
  if (Array.isArray(input)) {
    parts = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, code: CODE.NUM_EMPTY };
    parts = trimmed.split(/[\s,，、;；]+/).filter(Boolean);
  } else if (typeof input === 'number') {
    parts = [input];
  } else {
    return { ok: false, code: CODE.NUM_TYPE };
  }

  const values = [];
  for (const raw of parts) {
    const text = String(raw).trim();
    if (!/^-?\d+$/.test(text)) return { ok: false, code: CODE.NUM_TYPE };
    values.push(parseInt(text, 10));
  }
  return { ok: true, values };
}

function dedupeSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

/**
 * 校验一组号码池（用于快乐8选十或开奖号码）
 * @param {number[]} values 已解析的整数数组
 * @param {{min:number,max:number,count:number,label:string}} spec
 */
function validatePool(values, spec) {
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, code: CODE.NUM_EMPTY, message: `${spec.label}不能为空` };
  }
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return { ok: false, code: CODE.NUM_TYPE, message: `${spec.label}必须为整数` };
    }
  }
  if (values.length !== spec.count) {
    return {
      ok: false,
      code: CODE.NUM_COUNT,
      message: `${spec.label}需 ${spec.count} 个，当前 ${values.length} 个`,
    };
  }
  const unique = new Set(values);
  if (unique.size !== values.length) {
    return { ok: false, code: CODE.NUM_DUPLICATE, message: `${spec.label}不可重复` };
  }
  for (const v of values) {
    if (v < spec.min || v > spec.max) {
      return {
        ok: false,
        code: CODE.NUM_RANGE,
        message: `${spec.label}需在 ${spec.min}–${spec.max} 之间`,
      };
    }
  }
  return { ok: true, code: CODE.OK, normalized: dedupeSorted(values) };
}

/**
 * 双色球：6 红 + 1 蓝
 * @param {string|number[]} red
 * @param {string|number} blue
 */
function validateSsq(red, blue) {
  const meta = GAME_META[GAME.SSQ];
  const redParsed = parseNumbers(red);
  if (!redParsed.ok) {
    return { ok: false, code: redParsed.code, message: '红球格式不正确' };
  }
  const redCheck = validatePool(redParsed.values, {
    min: meta.redMin,
    max: meta.redMax,
    count: meta.redCount,
    label: '红球',
  });
  if (!redCheck.ok) return redCheck;

  const blueParsed = parseNumbers(blue);
  if (!blueParsed.ok) {
    return { ok: false, code: blueParsed.code, message: '蓝球格式不正确' };
  }
  const blueCheck = validatePool(blueParsed.values, {
    min: meta.blueMin,
    max: meta.blueMax,
    count: 1,
    label: '蓝球',
  });
  if (!blueCheck.ok) return blueCheck;

  return {
    ok: true,
    code: CODE.OK,
    normalized: { red: redCheck.normalized, blue: blueCheck.normalized[0], kl8: [] },
  };
}

/**
 * 快乐8：选十 / 开奖 20 个
 * @param {string|number[]} numbers
 * @param {{asDraw?: boolean}} options asDraw=true 时按 20 个开奖号码校验
 */
function validateKl8(numbers, options = {}) {
  const meta = GAME_META[GAME.KL8];
  const spec = options.asDraw
    ? { min: meta.min, max: meta.max, count: meta.drawCount, label: '开奖号码' }
    : { min: meta.min, max: meta.max, count: meta.count, label: '选十号码' };

  const parsed = parseNumbers(numbers);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code, message: `${spec.label}格式不正确` };
  }
  const check = validatePool(parsed.values, spec);
  if (!check.ok) return check;

  return {
    ok: true,
    code: CODE.OK,
    normalized: { red: [], blue: null, kl8: check.normalized },
  };
}

/**
 * 统一校验入口
 * @param {string} game
 * @param {{red?: any, blue?: any, kl8?: any}} numbers
 */
function validateNumbers(game, numbers) {
  const payload = numbers || {};
  if (game === GAME.SSQ) return validateSsq(payload.red, payload.blue);
  if (game === GAME.KL8) return validateKl8(payload.kl8);
  return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '不支持的彩种' };
}

/** 两位显示（01–80） */
function formatTwo(n) {
  return String(n).padStart(2, '0');
}

/** 展示文本：双色球 "01 05 09 12 20 33 | 07"；快乐8 "01 02 ..." */
function formatDisplay(game, numbers) {
  if (!numbers) return '';
  if (game === GAME.SSQ) {
    const red = (numbers.red || []).map(formatTwo).join(' ');
    const blue = numbers.blue === null || numbers.blue === undefined ? '' : formatTwo(numbers.blue);
    return `${red} | ${blue}`;
  }
  return (numbers.kl8 || []).map(formatTwo).join(' ');
}

/** 落库用的稳定字符串，便于幂等与去重比对 */
function combinationKey(game, numbers) {
  if (game === GAME.SSQ) {
    const red = (numbers.red || []).slice().sort((a, b) => a - b).join(',');
    return `ssq:${red}|${numbers.blue}`;
  }
  return `kl8:${(numbers.kl8 || []).slice().sort((a, b) => a - b).join(',')}`;
}

module.exports = {
  CODE,
  parseNumbers,
  validatePool,
  validateSsq,
  validateKl8,
  validateNumbers,
  formatTwo,
  formatDisplay,
  combinationKey,
};

});

/* ===== shared/rules/registry.js ===== */
__define("shared/rules/registry.js", function(module, exports, require){
/**
 * 规则版本注册表（主方案 8.3）。
 * 判奖逻辑在阶段 4 实现；本文件只负责"某期适用哪一版规则"与奖级表查询。
 * 严禁在页面或判奖代码里硬编码奖级金额。
 */

const { GAME } = require('../constants/games');

/**
 * 期号比较：仅接受 7 位数字期号，按整数比较（安全，远小于 2^53）。
 * 不做"上期+1"推算——期号只认官方公告。
 */
function isValidIssue(issue) {
  return typeof issue === 'string' && /^\d{7}$/.test(issue);
}

function compareIssue(a, b) {
  if (!isValidIssue(a) || !isValidIssue(b)) {
    throw new Error(`非法期号: ${a} / ${b}`);
  }
  return Number(a) - Number(b);
}

/** 双色球奖级：1–6 等奖；福运奖为特别规定，单列 */
const SSQ_PRIZE_TABLE = {
  1: 'floating',
  2: 'floating',
  3: 3000,
  4: 200,
  5: 10,
  6: 5,
};

/** 快乐8选十奖级：键为命中个数 */
const KL8_CHOOSE10_PRIZE_TABLE = {
  10: 'floating',
  9: 8000,
  8: 720,
  7: 80,
  6: 5,
  5: 3,
  0: 2,
};

/**
 * 已建档规则版本。旧版本（ssq < 2026014、kl8 < 2025350）尚未取得权威文本，
 * 不建档即代表"不支持自动核对"，必须转人工，不得套用新规则。
 */
const RULE_VERSIONS = [
  {
    game: GAME.SSQ,
    ruleVersion: 'ssq_2026_02_01',
    effectiveFromIssue: '2026014',
    effectiveToIssue: null,
    prizeTable: SSQ_PRIZE_TABLE,
    specialRuleConditions: {
      type: 'fuyun',
      matchRed: 3,
      prizePerTicket: 5,
      poolStartAmount: 1500000000,
      poolStopAmount: 300000000,
      note: '奖池达 15 亿元（含）起执行；执行后奖池低于 3 亿元停止。按期官方公告判定。',
    },
    sourceUrl: 'https://www.scflcp.com.cn/tzgg/823144831.jhtml',
    verifiedAt: '2026-11-04',
    status: 'active',
  },
  {
    game: GAME.KL8,
    ruleVersion: 'kl8_2025_12_30',
    effectiveFromIssue: '2025350',
    effectiveToIssue: null,
    prizeTable: KL8_CHOOSE10_PRIZE_TABLE,
    specialRuleConditions: {},
    sourceUrl: 'https://www.scflcp.com.cn/yxgz/823144315.jhtml',
    verifiedAt: '2026-11-04',
    status: 'active',
  },
];

/**
 * 解析某期适用规则。
 * @returns {{found: boolean, ruleVersion: string|null, rule: object|null, reason?: string}}
 */
function resolveRuleVersion(game, issue) {
  if (!isValidIssue(issue)) {
    return { found: false, ruleVersion: null, rule: null, reason: 'INVALID_ISSUE' };
  }
  const candidates = RULE_VERSIONS.filter((r) => r.game === game && r.status === 'active');
  for (const rule of candidates) {
    const afterStart = compareIssue(issue, rule.effectiveFromIssue) >= 0;
    const beforeEnd = !rule.effectiveToIssue || compareIssue(issue, rule.effectiveToIssue) <= 0;
    if (afterStart && beforeEnd) {
      return { found: true, ruleVersion: rule.ruleVersion, rule };
    }
  }
  return {
    found: false,
    ruleVersion: null,
    rule: null,
    reason: 'NO_RULE_VERSION',
  };
}

/** 查询某规则版本的单注奖金；'floating' 表示必须读当期公告 */
function getUnitPrize(rule, key) {
  const table = rule && rule.prizeTable ? rule.prizeTable : {};
  if (!Object.prototype.hasOwnProperty.call(table, key)) return { known: false, value: null };
  const value = table[key];
  if (value === 'floating') return { known: false, value: null, floating: true };
  return { known: true, value };
}

/**
 * 单注价格。仅用于给用户一个"默认建议"，绝不代替用户录入的实际金额。
 * verified 表示该单价已确认（官方规则文本，或产品所有者确认），可作为输入框占位建议。
 */
const UNIT_PRICE = {
  [GAME.SSQ]: { value: 2, verified: true, source: '双色球游戏规则：单式一注 2 元' },
  [GAME.KL8]: { value: 2, verified: true, source: '快乐8 单注 2 元（产品所有者 2026-11-05 确认）' },
};

/**
 * 建议金额。verified=false 时返回 null，避免把未确认的单价伪装成"系统算出来的"。
 * @returns {{value: number|null, verified: boolean, source: string}}
 */
function suggestCost(game, multiple) {
  const unit = UNIT_PRICE[game];
  const m = Number.isInteger(multiple) && multiple > 0 ? multiple : 1;
  if (!unit) return { value: null, verified: false, source: '未知彩种' };
  if (!unit.verified) return { value: null, verified: false, source: unit.source };
  return { value: unit.value * m, verified: true, source: unit.source };
}

module.exports = {
  RULE_VERSIONS,
  SSQ_PRIZE_TABLE,
  KL8_CHOOSE10_PRIZE_TABLE,
  UNIT_PRICE,
  isValidIssue,
  compareIssue,
  resolveRuleVersion,
  getUnitPrize,
  suggestCost,
};

});

/* ===== shared/rules/judge.js ===== */
__define("shared/rules/judge.js", function(module, exports, require){
/**
 * 判奖引擎（确定性代码，唯一判定入口）。
 *
 * 铁律：
 *   1. 只对 purchaseStatus=confirmed 的号码判奖。
 *   2. 只接受 drawStatus=verified / corrected 的开奖数据。
 *   3. 一/二等奖、快乐8"中 10"必须读当期官方公告金额；缺失即"待公告"，绝不估算。
 *   4. 福运奖状态 unknown 时转人工，不猜。
 *   5. 一注只按最高奖级兑付，福运奖仅覆盖"3 红且未中其他奖级"。
 *
 * 本文件不访问数据库、不读环境变量，纯函数，可被前端与云函数共用。
 */

const { GAME, PURCHASE_STATUS, SPECIAL_RULE_STATUS } = require('../constants/games');
const { resolveRuleVersion, getUnitPrize } = require('./registry');
const { isJudgeableStatus } = require('../validators/draws');

const CHECK_STATUS = {
  CHECKED: 'checked',
  NOT_WINNER: 'not_winner',
  PENDING: 'pending_manual_review',
};

const PENDING_REASON = {
  NO_DRAW: 'NO_DRAW',
  DRAW_NOT_VERIFIED: 'DRAW_NOT_VERIFIED',
  NO_RULE_VERSION: 'NO_RULE_VERSION',
  PRIZE_AMOUNT_PENDING: 'PRIZE_AMOUNT_PENDING',
  PRIZE_INFO_MISSING: 'PRIZE_INFO_MISSING',
  FUYUN_STATUS_UNKNOWN: 'FUYUN_STATUS_UNKNOWN',
  NOT_CONFIRMED: 'NOT_CONFIRMED',
  MISMATCH: 'MISMATCH',
};

function intersect(a, b) {
  const setB = new Set(b || []);
  return (a || []).filter((n) => setB.has(n));
}

function quantityOf(ticket) {
  const q = Number(ticket && ticket.multiple);
  return Number.isInteger(q) && q > 0 ? q : 1;
}

/** 读取当期公告的奖级注数与单注金额；无人中（count=0）视为金额未知 */
function announcedGrade(draw, path) {
  let node = draw && draw.prizeInfo;
  for (const key of path) {
    if (!node || typeof node !== 'object') return { count: null, amount: null };
    node = node[key];
  }
  if (!node || typeof node !== 'object') return { count: null, amount: null };
  const count = typeof node.count === 'number' ? node.count : null;
  const amount = typeof node.amount === 'number' ? node.amount : null;
  if (count === 0) return { count: 0, amount: null };
  return { count, amount };
}

function baseResult(ticket, draw, extra) {
  return {
    ok: true,
    ticketId: ticket._id || ticket.id || null,
    game: ticket.game,
    issue: ticket.issue,
    drawStatus: draw ? draw.drawStatus : null,
    drawRecordId: draw ? draw._id || null : null,
    drawHash: draw ? draw.rawHash || null : null,
    ruleVersion: null,
    hit: null,
    prizeLevel: null,
    unitPrize: null,
    quantity: quantityOf(ticket),
    totalPrize: null,
    checkStatus: CHECK_STATUS.PENDING,
    isWinner: false,
    pendingReason: null,
    ...extra,
  };
}

function pending(ticket, draw, reason, extra = {}) {
  return baseResult(ticket, draw, {
    checkStatus: CHECK_STATUS.PENDING,
    pendingReason: reason,
    ...extra,
  });
}

/**
 * 双色球判奖
 * @param {object} ticket 号码记录
 * @param {object} draw 开奖记录（已核验）
 * @param {object} rule 规则版本对象
 * @param {string} checkedAt ISO 时间
 */
function judgeSsq(ticket, draw, rule, checkedAt) {
  const red = ticket.numbers.red || [];
  const drawRed = draw.numbers.red || [];
  const matchedRed = intersect(red, drawRed);
  const redHit = matchedRed.length;
  const blueHit = ticket.numbers.blue === draw.numbers.blue;

  let level = null;
  if (redHit === 6 && blueHit) level = '1';
  else if (redHit === 6) level = '2';
  else if (redHit === 5 && blueHit) level = '3';
  else if (redHit === 5 || (redHit === 4 && blueHit)) level = '4';
  else if (redHit === 4 || (redHit === 3 && blueHit)) level = '5';
  else if (blueHit) level = '6';

  const hit = {
    red: redHit,
    blue: blueHit,
    numbers: matchedRed,
    blueNumber: blueHit ? draw.numbers.blue : null,
  };

  // 福运奖：仅当恰好 3 红、未中蓝、且未落入 1–6 等奖
  if (!level && redHit === 3 && !blueHit) {
    const status = draw.specialRuleStatus || SPECIAL_RULE_STATUS.UNKNOWN;
    if (status === SPECIAL_RULE_STATUS.ACTIVE) {
      const special = rule.specialRuleConditions || {};
      const unitPrize = typeof special.prizePerTicket === 'number' ? special.prizePerTicket : null;
      if (unitPrize === null) {
        return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION, {
          ruleVersion: rule.ruleVersion,
          hit,
        });
      }
      const quantity = quantityOf(ticket);
      return baseResult(ticket, draw, {
        ruleVersion: rule.ruleVersion,
        hit,
        prizeLevel: 'fuyun',
        unitPrize,
        quantity,
        totalPrize: unitPrize * quantity,
        checkStatus: CHECK_STATUS.CHECKED,
        isWinner: true,
        checkedAt,
      });
    }
    if (status === SPECIAL_RULE_STATUS.INACTIVE || status === SPECIAL_RULE_STATUS.NOT_APPLICABLE) {
      return baseResult(ticket, draw, {
        ruleVersion: rule.ruleVersion,
        hit,
        checkStatus: CHECK_STATUS.NOT_WINNER,
        checkedAt,
      });
    }
    return pending(ticket, draw, PENDING_REASON.FUYUN_STATUS_UNKNOWN, {
      ruleVersion: rule.ruleVersion,
      hit,
    });
  }

  if (!level) {
    return baseResult(ticket, draw, {
      ruleVersion: rule.ruleVersion,
      hit,
      checkStatus: CHECK_STATUS.NOT_WINNER,
      checkedAt,
    });
  }

  // 一/二等奖为浮动奖，必须读当期公告
  if (level === '1' || level === '2') {
    const path = level === '1' ? ['first'] : ['second'];
    const grade = announcedGrade(draw, path);
    if (grade.amount === null) {
      return pending(ticket, draw, PENDING_REASON.PRIZE_AMOUNT_PENDING, {
        ruleVersion: rule.ruleVersion,
        hit,
        prizeLevel: level,
      });
    }
    const quantity = quantityOf(ticket);
    return baseResult(ticket, draw, {
      ruleVersion: rule.ruleVersion,
      hit,
      prizeLevel: level,
      unitPrize: grade.amount,
      quantity,
      totalPrize: grade.amount * quantity,
      checkStatus: CHECK_STATUS.CHECKED,
      isWinner: true,
      checkedAt,
    });
  }

  const fixed = getUnitPrize(rule, level);
  if (!fixed.known) {
    return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION, {
      ruleVersion: rule.ruleVersion,
      hit,
      prizeLevel: level,
    });
  }
  const quantity = quantityOf(ticket);
  return baseResult(ticket, draw, {
    ruleVersion: rule.ruleVersion,
    hit,
    prizeLevel: level,
    unitPrize: fixed.value,
    quantity,
    totalPrize: fixed.value * quantity,
    checkStatus: CHECK_STATUS.CHECKED,
    isWinner: true,
    checkedAt,
  });
}

/** 快乐8选十判奖 */
function judgeKl8(ticket, draw, rule, checkedAt) {
  const picked = ticket.numbers.kl8 || [];
  const drawNumbers = draw.numbers.kl8 || [];
  const matched = intersect(picked, drawNumbers);
  const hitCount = matched.length;
  const hit = { count: hitCount, numbers: matched };
  const quantity = quantityOf(ticket);

  if (hitCount === 10) {
    const grade = announcedGrade(draw, ['choose10', 'hit10']);
    if (grade.amount === null) {
      return pending(ticket, draw, PENDING_REASON.PRIZE_AMOUNT_PENDING, {
        ruleVersion: rule.ruleVersion,
        hit,
        prizeLevel: '10',
      });
    }
    return baseResult(ticket, draw, {
      ruleVersion: rule.ruleVersion,
      hit,
      prizeLevel: '10',
      unitPrize: grade.amount,
      quantity,
      totalPrize: grade.amount * quantity,
      checkStatus: CHECK_STATUS.CHECKED,
      isWinner: true,
      checkedAt,
    });
  }

  const fixed = getUnitPrize(rule, String(hitCount));
  if (!fixed.known) {
    // 1–4 命中：规则表里没有该奖级，属于"不中奖"，不是缺规则
    if ([1, 2, 3, 4].includes(hitCount)) {
      return baseResult(ticket, draw, {
        ruleVersion: rule.ruleVersion,
        hit,
        checkStatus: CHECK_STATUS.NOT_WINNER,
        checkedAt,
      });
    }
    return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION, {
      ruleVersion: rule.ruleVersion,
      hit,
    });
  }

  return baseResult(ticket, draw, {
    ruleVersion: rule.ruleVersion,
    hit,
    prizeLevel: String(hitCount),
    unitPrize: fixed.value,
    quantity,
    totalPrize: fixed.value * quantity,
    checkStatus: CHECK_STATUS.CHECKED,
    isWinner: true,
    checkedAt,
  });
}

/**
 * 统一入口
 * @param {object} ticket 号码记录（须 confirmed）
 * @param {object|null} draw 对应期开奖记录
 * @param {{checkedAt?: string}} options
 */
function judgeTicket(ticket, draw, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();

  if (!ticket || ticket.purchaseStatus !== PURCHASE_STATUS.CONFIRMED) {
    return {
      ok: false,
      code: PENDING_REASON.NOT_CONFIRMED,
      message: '只有「已确认购买」的号码才参与判奖',
    };
  }
  if (!draw) return pending(ticket, null, PENDING_REASON.NO_DRAW);
  if (!isJudgeableStatus(draw.drawStatus)) {
    return pending(ticket, draw, PENDING_REASON.DRAW_NOT_VERIFIED);
  }
  if (draw.game !== ticket.game || draw.issue !== ticket.issue) {
    return pending(ticket, draw, PENDING_REASON.MISMATCH);
  }

  const rule = resolveRuleVersion(ticket.game, ticket.issue);
  if (!rule.found) {
    return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION);
  }

  if (ticket.game === GAME.SSQ) return judgeSsq(ticket, draw, rule.rule, checkedAt);
  if (ticket.game === GAME.KL8) return judgeKl8(ticket, draw, rule.rule, checkedAt);
  return pending(ticket, draw, PENDING_REASON.NO_RULE_VERSION);
}

/** 批量：draws 以 `${game}:${issue}` 为键 */
function judgeMany(tickets, drawMap, options = {}) {
  const results = [];
  for (const ticket of tickets || []) {
    const key = `${ticket.game}:${ticket.issue}`;
    results.push(judgeTicket(ticket, (drawMap && drawMap[key]) || null, options));
  }
  return results;
}

/** 幂等键：同一张票 + 同一份开奖 + 同一版规则 + 同一份原始数据 → 同一次核对 */
function checkIdempotencyKey(ticket, draw, ruleVersion) {
  return [
    ticket._id || ticket.id || 'no-ticket',
    draw && (draw._id || 'no-draw'),
    ruleVersion || 'no-rule',
    (draw && draw.rawHash) || 'no-hash',
  ].join('|');
}

module.exports = {
  CHECK_STATUS,
  PENDING_REASON,
  judgeTicket,
  judgeMany,
  checkIdempotencyKey,
  announcedGrade,
  intersect,
};

});

/* ===== shared/security/access.js ===== */
__define("shared/security/access.js", function(module, exports, require){
/**
 * 单用户访问控制（纯函数，便于单测与云函数复用）。
 * 规则（fail-closed）：
 *  1. openid 为空 → 拒绝；
 *  2. 白名单非空 → 只认白名单；
 *  3. 白名单为空但有 envOwner → 认 envOwner（阶段 1 过渡措施，见 decisions.md D6）；
 *  4. 两者皆空 → 拒绝。
 * 前端任何判断都不具备授权效力，只有服务端调用本函数得出的结果有效。
 */

const REASON = {
  ALLOWED: 'ALLOWED',
  NO_OPENID: 'NO_OPENID',
  NOT_IN_WHITELIST: 'NOT_IN_WHITELIST',
  NO_OWNER_CONFIGURED: 'NO_OWNER_CONFIGURED',
};

const AUTH_SOURCE = {
  WHITELIST: 'app_config.ownerWhitelist',
  ENV: 'env.OWNER_OPENID',
  NONE: 'none',
};

function normalizeWhitelist(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : String(list).split(/[\s,;]+/);
  return arr.map((x) => String(x || '').trim()).filter(Boolean);
}

/**
 * @param {string} openid 来自 wxContext.OPENID，不可由前端传入
 * @param {{whitelist?: string[]|string, envOwner?: string}} config
 * @returns {{allowed: boolean, reason: string, authSource: string}}
 */
function resolveOwner(openid, config = {}) {
  const id = String(openid || '').trim();
  if (!id) {
    return { allowed: false, reason: REASON.NO_OPENID, authSource: AUTH_SOURCE.NONE };
  }

  const whitelist = normalizeWhitelist(config.whitelist);
  if (whitelist.length > 0) {
    return whitelist.includes(id)
      ? { allowed: true, reason: REASON.ALLOWED, authSource: AUTH_SOURCE.WHITELIST }
      : { allowed: false, reason: REASON.NOT_IN_WHITELIST, authSource: AUTH_SOURCE.WHITELIST };
  }

  const envOwner = String(config.envOwner || '').trim();
  if (envOwner) {
    return envOwner === id
      ? { allowed: true, reason: REASON.ALLOWED, authSource: AUTH_SOURCE.ENV }
      : { allowed: false, reason: REASON.NOT_IN_WHITELIST, authSource: AUTH_SOURCE.ENV };
  }

  return { allowed: false, reason: REASON.NO_OWNER_CONFIGURED, authSource: AUTH_SOURCE.NONE };
}

/**
 * 合规状态取值。
 * 前四个用于微信小程序（需平台结论）；最后一个用于自托管静态站：
 * 没有平台可审批，只能由使用者本人显式确认"我知道这是随机组合、不代表更容易中"。
 * 两种状态不可混用——调用方必须显式传 acceptSelfAttested 才认最后一种。
 */
const COMPLIANCE_STATUS = {
  NOT_CHECKED: 'not_checked',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SELF_ATTESTED: 'self_attested_personal_use',
};

const GATE_REASON = {
  OK: 'GATE_OK',
  COMPLIANCE_NOT_APPROVED: 'COMPLIANCE_NOT_APPROVED',
  CANDIDATE_DISABLED: 'CANDIDATE_DISABLED',
  AI_FUTURE_DISABLED: 'AI_FUTURE_DISABLED',
};

/**
 * 合规闸门：候选号码生成 / AI 未来号码推荐是否可用。
 * 两个条件必须同时满足，缺一即关闭（fail-closed）。
 *
 * @param {{wxComplianceStatus?: string, complianceState?: string, candidateGenerationEnabled?: boolean, aiFutureNumberFeatureEnabled?: boolean}} flags
 * @param {{acceptSelfAttested?: boolean}} [options] 仅自托管场景传 true；云函数不得传
 */
function resolveCandidateGate(flags = {}, options = {}) {
  const status = flags.wxComplianceStatus || flags.complianceState || COMPLIANCE_STATUS.NOT_CHECKED;
  const approvedByPlatform = status === COMPLIANCE_STATUS.APPROVED;
  const selfAttested =
    status === COMPLIANCE_STATUS.SELF_ATTESTED && options.acceptSelfAttested === true;
  const complianceOk = approvedByPlatform || selfAttested;

  const candidateGeneration = complianceOk && flags.candidateGenerationEnabled === true;
  const aiFutureNumber = complianceOk && flags.aiFutureNumberFeatureEnabled === true;

  let reason = GATE_REASON.OK;
  if (!complianceOk) reason = GATE_REASON.COMPLIANCE_NOT_APPROVED;
  else if (!candidateGeneration) reason = GATE_REASON.CANDIDATE_DISABLED;

  return {
    candidateGeneration,
    aiFutureNumber,
    complianceState: status,
    reason,
    selfAttested,
  };
}

module.exports = {
  REASON,
  AUTH_SOURCE,
  COMPLIANCE_STATUS,
  GATE_REASON,
  normalizeWhitelist,
  resolveOwner,
  resolveCandidateGate,
};

});

/* ===== shared/domain/candidates.js ===== */
__define("shared/domain/candidates.js", function(module, exports, require){
/**
 * 候选号码组合生成（阶段 6）。
 *
 * 三条硬约束：
 *   1. 纯函数 + 确定性：同一个 (game, strategy, count, seed, params) 永远得到同一批号码。
 *      这样"这批号码哪来的"可以复现，开奖后能复盘，而不是每次点都不一样。
 *   2. 只产出候选，不产出"买了"。落到号码表里一律是 draft（见 shared/domain/tickets.js）。
 *   3. 不做任何"提升中奖机会"的暗示：策略只是结构约束（分区/奇偶/偏好），
 *      不读历史频次做加权——把冷热包装成算法能力属于伪预测，这里明确不做。
 *
 * 术语：一"注"（group）在双色球是 6 红 + 1 蓝，在快乐8选十是 10 个号码。
 */

const { GAME, GAME_META, isGame } = require('../constants/games');
const { isValidIssue } = require('../rules/registry');
const {
  crowdIndex,
  coldNumbers,
  consecutivePairs,
  hasArithmeticRun,
  sameTailPairs,
  CROWD_MODEL_VERSION,
} = require('./analysis');

const ALGORITHM_VERSION = 'candidate@1.0.0';

const STRATEGY = {
  RANDOM: 'random',
  BALANCED: 'balanced',
  PREFERENCE: 'preference',
  ANALYZED: 'analyzed',
};

const STRATEGY_META = {
  [STRATEGY.RANDOM]: {
    label: '随机',
    desc: '从号码池等概率抽取，每注互不相同。',
  },
  [STRATEGY.BALANCED]: {
    label: '分区均衡',
    desc: '按号码区间与奇偶做结构均衡，避免出现全小或全奇这类结构。',
  },
  [STRATEGY.PREFERENCE]: {
    label: '偏好约束',
    desc: '先满足你指定的必含/排除号码，余下随机补足。',
  },
  [STRATEGY.ANALYZED]: {
    label: '分析选号',
    desc: '在结构合格的前提下，挑「拥挤度最低」的组合：避开生日区扎堆、连号等差、上期重号，并可要求带冷门号。',
  },
};

const CODE = {
  OK: 'OK',
  BAD_GAME: 'BAD_GAME',
  BAD_STRATEGY: 'BAD_STRATEGY',
  BAD_COUNT: 'BAD_COUNT',
  BAD_ISSUE: 'BAD_ISSUE',
  BAD_SEED: 'BAD_SEED',
  BAD_INCLUDE: 'BAD_INCLUDE',
  BAD_EXCLUDE: 'BAD_EXCLUDE',
  NO_ROOM: 'NO_ROOM',
  DUPLICATE_EXHAUSTED: 'DUPLICATE_EXHAUSTED',
  BAD_ANALYSIS: 'BAD_ANALYSIS',
};

const MIN_COUNT = 1;
const MAX_COUNT = 5;
const DEFAULT_COUNT = 3;
const MAX_EXCLUDE_NUMBERS = 30;
const MAX_ATTEMPTS_PER_GROUP = 80;

/* ---------------- 确定性随机源 ---------------- */

/** FNV-1a 32 位哈希：把任意种子文本折成 uint32 */
function hashSeed(input) {
  const text = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32：小、快、可复现。
 * 不是密码学随机，这里也不需要——目的是"同种子同结果"，不是防预测。
 */
function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 规范化种子。
 * - 整数 / 数字字符串 → 折成 uint32
 * - 其他字符串（如 "batch-2026-11-05"）→ 哈希
 * - 缺省 → 随机生成，并把实际用到的种子回传，保证"用户能复现这一次"
 */
function normalizeSeed(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, seed: Math.floor(Math.random() * 4294967296) >>> 0, generated: true };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, message: '随机种子必须是有限数字或字符串' };
    return { ok: true, seed: Math.abs(Math.trunc(raw)) >>> 0, generated: false };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, seed: Math.floor(Math.random() * 4294967296) >>> 0, generated: true };
    if (/^\d+$/.test(trimmed)) return { ok: true, seed: Number(trimmed) >>> 0, generated: false };
    if (trimmed.length > 64) return { ok: false, message: '随机种子最长 64 字符' };
    return { ok: true, seed: hashSeed(trimmed), generated: false };
  }
  return { ok: false, message: '随机种子只支持数字或字符串' };
}

/* ---------------- 号码池与抽取 ---------------- */

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function shuffle(list, rng) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function pick(pool, k, rng) {
  return shuffle(pool, rng).slice(0, k);
}

function oddCount(list) {
  return list.filter((n) => n % 2 === 1).length;
}

function zoneSpread(list, zones) {
  const counts = zones.map(() => 0);
  for (const n of list) {
    for (let i = 0; i < zones.length; i += 1) {
      if (n >= zones[i][0] && n <= zones[i][1]) {
        counts[i] += 1;
        break;
      }
    }
  }
  return counts;
}

/**
 * 结构均衡评分：分区间越均匀、奇偶越接近目标，分越高。
 * 用"采样多个候选取最优"而不是构造式算法——构造式在奇偶与分区冲突时会失败，
 * 采样法永远不会产生非法组合，且仍然完全确定性（同 rng 同结果）。
 */
function bestBalanced(sampleFn, scoreFn, samples, rng) {
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < samples; i += 1) {
    const candidate = sampleFn(rng);
    const s = scoreFn(candidate);
    if (s > bestScore) {
      bestScore = s;
      best = candidate;
    }
  }
  return best;
}

function ssqZones() {
  return [
    [1, 11],
    [12, 22],
    [23, 33],
  ];
}

function kl8Zones() {
  return [
    [1, 20],
    [21, 40],
    [41, 60],
    [61, 80],
  ];
}

/* ---------------- 参数规范化 ---------------- */

function normalizeList(raw, { min, max, label, maxLen }) {
  if (raw === undefined || raw === null) return { ok: true, list: [] };
  const arr = Array.isArray(raw) ? raw : String(raw).split(/[\s,，、]+/);
  const list = [];
  for (const item of arr) {
    if (item === '' || item === null || item === undefined) continue;
    const n = Number(item);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, code: label === 'include' ? CODE.BAD_INCLUDE : CODE.BAD_EXCLUDE, message: `${label === 'include' ? '必含' : '排除'}号码必须是 ${min}–${max} 的整数` };
    }
    if (!list.includes(n)) list.push(n);
  }
  if (list.length > maxLen) {
    return { ok: false, code: label === 'include' ? CODE.BAD_INCLUDE : CODE.BAD_EXCLUDE, message: `${label === 'include' ? '必含' : '排除'}号码最多 ${maxLen} 个` };
  }
  return { ok: true, list: list.sort((a, b) => a - b) };
}

/**
 * 参数快照：随批次一起存，保证"参数→结果"可复现。
 * 所有字段都是可 JSON 化的标量或数组，禁止函数/引用。
 */
function snapshotParams(game, params) {
  const p = params || {};
  const base = {
    include: Array.isArray(p.include) ? p.include.slice() : [],
    exclude: Array.isArray(p.exclude) ? p.exclude.slice() : [],
  };
  if (game === GAME.SSQ) base.blueFixed = Number.isInteger(p.blueFixed) ? p.blueFixed : null;
  return base;
}

/* ---------------- 单注生成 ---------------- */

function buildSsqGroup({ strategy, include, exclude, blueFixed, rng }) {
  const zones = ssqZones();
  const all = range(1, 33).filter((n) => !exclude.includes(n));
  const forced = include.filter((n) => !exclude.includes(n));
  const free = all.filter((n) => !forced.includes(n));
  const need = 6 - forced.length;
  if (need < 0) return null;
  if (free.length < need) return null;

  let red;
  if (strategy === STRATEGY.BALANCED) {
    red = bestBalanced(
      (r) => forced.concat(pick(free, need, r)).sort((a, b) => a - b),
      (candidate) => {
        const spread = zoneSpread(candidate, zones);
        const zoneCost = spread.reduce((acc, c) => acc + Math.abs(c - 2), 0);
        const oddCost = Math.abs(oddCount(candidate) - 3);
        return -(zoneCost * 2 + oddCost);
      },
      48,
      rng
    );
  } else {
    red = forced.concat(pick(free, need, rng)).sort((a, b) => a - b);
  }
  if (!red || red.length !== 6) return null;

  const bluePool = range(1, 16);
  const blue = Number.isInteger(blueFixed) && bluePool.includes(blueFixed) ? blueFixed : pick(bluePool, 1, rng)[0];
  return { numbers: { red, blue, kl8: [] } };
}

function buildKl8Group({ strategy, include, exclude, rng }) {
  const zones = kl8Zones();
  const all = range(1, 80).filter((n) => !exclude.includes(n));
  const forced = include.filter((n) => !exclude.includes(n));
  const free = all.filter((n) => !forced.includes(n));
  const need = 10 - forced.length;
  if (need < 0) return null;
  if (free.length < need) return null;

  let kl8;
  if (strategy === STRATEGY.BALANCED) {
    kl8 = bestBalanced(
      (r) => forced.concat(pick(free, need, r)).sort((a, b) => a - b),
      (candidate) => {
        const spread = zoneSpread(candidate, zones);
        const zoneCost = spread.reduce((acc, c, i) => acc + Math.abs(c - [3, 3, 2, 2][i]), 0);
        const oddCost = Math.abs(oddCount(candidate) - 5);
        return -(zoneCost * 2 + oddCost);
      },
      64,
      rng
    );
  } else {
    kl8 = forced.concat(pick(free, need, rng)).sort((a, b) => a - b);
  }
  if (!kl8 || kl8.length !== 10) return null;
  return { numbers: { red: [], blue: null, kl8 } };
}

/**
 * 兼顾的"代价"：为降拥挤度，必然有些注看起来不那么"均衡"。
 * 这里把代价量化出来给用户看，而不是只报喜。
 */
function summarizeTradeoff(game, groups) {
  const list = groups.map((g) => g.crowd.index);
  const sums = groups.map((g) => {
    const main = game === GAME.SSQ ? g.numbers.red : g.numbers.kl8;
    return main.reduce((acc, n) => acc + n, 0);
  });
  const withHigh = groups.filter((g) => {
    const main = game === GAME.SSQ ? g.numbers.red : g.numbers.kl8;
    return main.some((n) => n > 31);
  }).length;
  const withConsecutive = groups.filter((g) => {
    const main = game === GAME.SSQ ? g.numbers.red : g.numbers.kl8;
    return consecutivePairs(main).length > 0;
  }).length;

  const avg = Math.round((list.reduce((acc, n) => acc + n, 0) / list.length) * 10) / 10;
  return {
    avgCrowdIndex: avg,
    minCrowdIndex: Math.min(...list),
    maxCrowdIndex: Math.max(...list),
    withHighNumber: withHigh,
    withConsecutive,
    sumRange: [Math.min(...sums), Math.max(...sums)],
    note: '拥挤度越低，越不像大众会选的号码；代价是可能出现 32/33、连号这类"不好看"的组合。结构约束仍然满足。',
  };
}

/** 一组号码的规范化键，用于组间去重 */
function groupKey(game, numbers) {
  const list = game === GAME.SSQ ? numbers.red : numbers.kl8;
  const tail = game === GAME.SSQ ? `|${numbers.blue}` : '';
  return `${list.join(',')}${tail}`;
}

/* ---------------- 分析选号：拥挤度优化 ---------------- */

const ANALYSIS_DEFAULTS = {
  avoidPatterns: true,
  avoidRepeat: true,
  includeCold: 0,
  maxCrowdIndex: 92,
  window: 30,
};

/** 冷号统计窗口：只能从这几个值里选（与统计页保持一致） */
const ANALYSIS_WINDOWS = [30, 50, 100, 200, 300, 1000, 3000];

/** 每注采多少个候选再挑最优；越大越"冷门"，也越慢（本地毫秒级） */
const ANALYSIS_SAMPLES = 600;

function normalizeAnalysisParams(game, raw) {
  const src = raw || {};
  const meta = GAME_META[game];
  const count = game === GAME.SSQ ? meta.redCount : meta.count;
  const max = game === GAME.SSQ ? meta.redMax : meta.max;

  const boolOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

  const includeCold = src.includeCold === undefined || src.includeCold === null ? 0 : Number(src.includeCold);
  if (!Number.isInteger(includeCold) || includeCold < 0 || includeCold > 2) {
    return { ok: false, code: CODE.BAD_ANALYSIS, message: 'includeCold 只能是 0 / 1 / 2' };
  }

  const maxCrowdIndex =
    src.maxCrowdIndex === undefined || src.maxCrowdIndex === null
      ? ANALYSIS_DEFAULTS.maxCrowdIndex
      : Number(src.maxCrowdIndex);
  if (!Number.isFinite(maxCrowdIndex) || maxCrowdIndex < 0 || maxCrowdIndex > 100) {
    return { ok: false, code: CODE.BAD_ANALYSIS, message: 'maxCrowdIndex 需在 0–100 之间' };
  }

  const rangeOr = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [a, b] = value.map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return null;
    return [Math.max(0, Math.trunc(a)), Math.min(max * count, Math.trunc(b))];
  };

  let window = src.window === undefined || src.window === null ? ANALYSIS_DEFAULTS.window : Number(src.window);
  if (!ANALYSIS_WINDOWS.includes(window)) {
    return { ok: false, code: CODE.BAD_ANALYSIS, message: 'window 只能是 30 / 50 / 100 / 200 / 300 / 1000 / 3000' };
  }

  const sumRange = rangeOr(src.sumRange, game === GAME.SSQ ? [75, 130] : [300, 500]);
  if (!sumRange) {
    return { ok: false, code: CODE.BAD_ANALYSIS, message: 'sumRange 需要 [最小, 最大] 且最小 ≤ 最大' };
  }

  const oddRange = rangeOr(src.oddRange, game === GAME.SSQ ? [2, 4] : [4, 6]);
  if (!oddRange || oddRange[1] > count) {
    return { ok: false, code: CODE.BAD_ANALYSIS, message: `oddRange 需要 [最小, 最大]，上限不超过 ${count}` };
  }

  return {
    ok: true,
    params: {
      avoidPatterns: boolOr(src.avoidPatterns, ANALYSIS_DEFAULTS.avoidPatterns),
      avoidRepeat: boolOr(src.avoidRepeat, ANALYSIS_DEFAULTS.avoidRepeat),
      includeCold,
      maxCrowdIndex: Math.round(maxCrowdIndex),
      window,
      sumRange,
      oddRange,
    },
  };
}

function mainOf(game, numbers) {
  return game === GAME.SSQ ? numbers.red : numbers.kl8;
}

function overlapCount(a, b) {
  const set = new Set(a);
  return b.filter((n) => set.has(n)).length;
}

/** 结构硬约束：不满足就整注丢弃，而不是"稍微调整"（避免调到不合法） */
function passesAnalysis(game, numbers, analysis, coldSet, prevSet) {
  const main = mainOf(game, numbers);
  const sum = main.reduce((acc, n) => acc + n, 0);
  if (sum < analysis.sumRange[0] || sum > analysis.sumRange[1]) return false;

  const odd = main.filter((n) => n % 2 === 1).length;
  if (odd < analysis.oddRange[0] || odd > analysis.oddRange[1]) return false;

  if (analysis.avoidRepeat && prevSet.size && main.some((n) => prevSet.has(n))) return false;

  if (analysis.avoidPatterns) {
    // 阈值必须随号码个数放大：快乐8 选 10 个号，同尾/连号本来就是常态，
    // 用双色球的 6 号阈值会把绝大多数合法组合误杀（踩过这个坑）。
    const isSsq = game === GAME.SSQ;
    if (consecutivePairs(main).length > (isSsq ? 1 : 2)) return false;
    if (hasArithmeticRun(main, isSsq ? 4 : 5)) return false;
    if (sameTailPairs(main) > (isSsq ? 1 : 2)) return false;
  }

  if (analysis.includeCold > 0) {
    const hits = main.filter((n) => coldSet.has(n)).length;
    if (hits < analysis.includeCold) return false;
  }
  return true;
}

/**
 * 采 260 个候选，逐个丢掉不合格的，再取拥挤度最低的那个。
 * 组间再做一次"重合度"限制，避免两注只差一个号（那等于把钱押在一个形状上）。
 */
const SUM_CENTER = { [GAME.SSQ]: 100, [GAME.KL8]: 400 };
/** 和值偏离的惩罚系数：每偏离 10 点，多算 2.5 分（等价于"拥挤 2.5 点"） */
const SUM_DEVIATION_WEIGHT = 0.25;

function buildAnalyzedGroup(options) {
  const { game, rng, include, exclude, blueFixed, analysis, coldSet, prevSet, previousDraw, chosen } = options;
  const maxOverlap = game === GAME.SSQ ? 3 : 6;
  const center = SUM_CENTER[game];
  let best = null;

  for (let i = 0; i < ANALYSIS_SAMPLES; i += 1) {
    const built =
      game === GAME.SSQ
        ? buildSsqGroup({ strategy: STRATEGY.RANDOM, include, exclude, blueFixed, rng })
        : buildKl8Group({ strategy: STRATEGY.RANDOM, include, exclude, rng });
    if (!built) break;

    const main = mainOf(game, built.numbers);
    if (!passesAnalysis(game, built.numbers, analysis, coldSet, prevSet)) continue;
    if (chosen.some((prev) => overlapCount(prev, main) > maxOverlap)) continue;

    const crowd = crowdIndex(game, built.numbers, { previousDraw });
    if (!crowd.ok) continue;
    if (crowd.index > analysis.maxCrowdIndex) continue;

    // 纯取最冷会让每注都挤到"全大号"那一角，结构就崩了。
    // 所以目标函数是「拥挤度 + 和值偏离惩罚」——这就是"两者兼顾"的具体含义。
    const sum = main.reduce((acc, n) => acc + n, 0);
    const objective = crowd.index + Math.abs(sum - center) * SUM_DEVIATION_WEIGHT;

    if (!best || objective < best.objective) {
      best = { numbers: built.numbers, crowd, objective: Math.round(objective * 10) / 10 };
    }
  }
  return best;
}

/* ---------------- 对外主函数 ---------------- */

/**
 * 生成候选组合。
 * @param {object} input
 * @param {'ssq'|'kl8'} input.game
 * @param {'random'|'balanced'|'preference'} [input.strategy]
 * @param {number} [input.count] 1–5，默认 3
 * @param {string} [input.targetIssue] 目标期号（可选，仅记录）
 * @param {number|string} [input.seed] 随机种子；不传则自动生成并回传
 * @param {{include?:number[], exclude?:number[], blueFixed?:number}} [input.params]
 * @param {string} [input.complianceState] 记录生成时的闸门状态
 * @returns {{ok:boolean, code:string, message?:string, batch?:object}}
 */
function generateCandidates(input) {
  const src = input || {};
  const game = src.game;
  if (!isGame(game)) {
    return { ok: false, code: CODE.BAD_GAME, message: '只支持双色球（ssq）与快乐8选十（kl8）' };
  }

  const strategy = src.strategy || STRATEGY.RANDOM;
  if (!Object.values(STRATEGY).includes(strategy)) {
    return { ok: false, code: CODE.BAD_STRATEGY, message: '策略只能是 random / balanced / preference' };
  }

  const count = src.count === undefined || src.count === null ? DEFAULT_COUNT : Number(src.count);
  if (!Number.isInteger(count) || count < MIN_COUNT || count > MAX_COUNT) {
    return { ok: false, code: CODE.BAD_COUNT, message: `注数需为 ${MIN_COUNT}–${MAX_COUNT} 的整数` };
  }

  let targetIssue = null;
  if (src.targetIssue !== undefined && src.targetIssue !== null && src.targetIssue !== '') {
    const issue = String(src.targetIssue).trim();
    if (!isValidIssue(issue)) {
      return { ok: false, code: CODE.BAD_ISSUE, message: '目标期号需为 7 位数字，如 2026127' };
    }
    targetIssue = issue;
  }

  const meta = GAME_META[game];
  const numberMin = game === GAME.SSQ ? meta.redMin : meta.min;
  const numberMax = game === GAME.SSQ ? meta.redMax : meta.max;
  const need = game === GAME.SSQ ? meta.redCount : meta.count;

  const params = src.params || {};
  const inc = normalizeList(params.include, {
    min: numberMin,
    max: numberMax,
    label: 'include',
    maxLen: need,
  });
  if (!inc.ok) return inc;

  const exc = normalizeList(params.exclude, {
    min: numberMin,
    max: numberMax,
    label: 'exclude',
    maxLen: MAX_EXCLUDE_NUMBERS,
  });
  if (!exc.ok) return exc;

  const conflict = inc.list.filter((n) => exc.list.includes(n));
  if (conflict.length) {
    return { ok: false, code: CODE.BAD_INCLUDE, message: `号码 ${conflict.join('、')} 同时出现在必含与排除里` };
  }

  if (inc.list.length > need) {
    return { ok: false, code: CODE.NO_ROOM, message: `必含号码最多 ${need} 个` };
  }
  const available = numberMax - numberMin + 1 - exc.list.length;
  if (available < need) {
    return { ok: false, code: CODE.NO_ROOM, message: '排除的号码太多，剩余号码不足以组成一注' };
  }

  const seedRes = normalizeSeed(src.seed);
  if (!seedRes.ok) {
    return { ok: false, code: CODE.BAD_SEED, message: seedRes.message };
  }
  const rng = createRng(seedRes.seed);

  const groups = [];
  const seen = new Set();
  const chosen = [];
  const buildGroup = game === GAME.SSQ ? buildSsqGroup : buildKl8Group;

  const isAnalyzed = strategy === STRATEGY.ANALYZED;
  const previousDraw = src.previousDraw || null;
  let analysisParams = null;
  let coldList = [];
  let coldSet = new Set();
  let prevSet = new Set();

  if (isAnalyzed) {
    const normalized = normalizeAnalysisParams(game, src.analysis);
    if (!normalized.ok) return normalized;
    analysisParams = normalized.params;

    const recent = src.recentDraws || [];
    const coldInfo = coldNumbers(game, recent, analysisParams.window);
    if (!coldInfo.ok) return coldInfo;
    coldList = coldInfo.cold;
    coldSet = new Set(coldList);

    // 样本量要如实记录：只有 10 期时说"近 30 期"就是不诚实
    analysisParams.sampleSize = Math.min(recent.length, analysisParams.window);
    analysisParams.availableDraws = recent.length;
    analysisParams.dataSufficient = recent.length >= analysisParams.window;

    if (analysisParams.includeCold > coldList.length) {
      return {
        ok: false,
        code: CODE.BAD_ANALYSIS,
        message: `当前窗口内只有 ${coldList.length} 个冷号，无法要求带上 ${analysisParams.includeCold} 个`,
      };
    }

    if (previousDraw && previousDraw.numbers) {
      prevSet = new Set(mainOf(game, previousDraw.numbers));
    }
  }

  for (let i = 0; i < count; i += 1) {
    let built = null;

    if (isAnalyzed) {
      const picked = buildAnalyzedGroup({
        game,
        rng,
        include: inc.list,
        exclude: exc.list,
        blueFixed: params.blueFixed,
        analysis: analysisParams,
        coldSet,
        prevSet,
        previousDraw,
        chosen,
      });
      if (picked) {
        built = { numbers: picked.numbers, key: groupKey(game, picked.numbers), crowd: picked.crowd };
      }
    } else {
      let attempts = 0;
      while (attempts < MAX_ATTEMPTS_PER_GROUP) {
      attempts += 1;
      const candidate = buildGroup({
        strategy,
        include: inc.list,
        exclude: exc.list,
        blueFixed: params.blueFixed,
        rng,
      });
      if (!candidate) break;
      const key = groupKey(game, candidate.numbers);
      if (seen.has(key)) continue;
        built = { ...candidate, key };
        break;
      }
    }

    if (!built) {
      return {
        ok: false,
        code: CODE.DUPLICATE_EXHAUSTED,
        message: isAnalyzed
          ? '当前分析条件太紧（和值区间/奇偶/冷号/避开模式），可生成的合法组合不足。请放宽条件或减少注数。'
          : groups.length === 0
          ? '当前约束下无法生成合法号码，请放宽必含/排除条件'
          : '当前约束下可生成的组合不足，请减少注数或放宽约束',
      };
    }
    seen.add(built.key);
    chosen.push(mainOf(game, built.numbers));
    groups.push({
      index: i,
      numbers: built.numbers,
      key: built.key,
      displayText: game === GAME.SSQ
        ? `${built.numbers.red.map((n) => String(n).padStart(2, '0')).join(' ')} + ${String(built.numbers.blue).padStart(2, '0')}`
        : built.numbers.kl8.map((n) => String(n).padStart(2, '0')).join(' '),
      ...(built.crowd
        ? {
            crowd: {
              index: built.crowd.index,
              level: built.crowd.level,
              levelText: built.crowd.levelText,
              factors: built.crowd.factors.map((f) => f.label),
            },
          }
        : {}),
    });
  }

  return {
    ok: true,
    code: CODE.OK,
    batch: {
      algorithmVersion: ALGORITHM_VERSION,
      game,
      strategy,
      count,
      randomSeed: seedRes.seed,
      seedGenerated: seedRes.generated,
      parameterSnapshot: snapshotParams(game, { ...params, include: inc.list, exclude: exc.list }),
      targetIssue,
      complianceState: src.complianceState || null,
      createdAt: (src.now instanceof Date ? src.now : new Date()).toISOString(),
      analysis: isAnalyzed
        ? {
            ...analysisParams,
            coldNumbers: coldList,
            crowdModelVersion: CROWD_MODEL_VERSION,
            sampleCount: ANALYSIS_SAMPLES,
            previousIssue: previousDraw ? previousDraw.issue || null : null,
          }
        : null,
      crowdSummary: isAnalyzed
        ? groups.map((g) => ({
            index: g.index,
            crowdIndex: g.crowd.index,
            level: g.crowd.level,
            levelText: g.crowd.levelText,
            reasons: g.crowd.factors,
          }))
        : null,
      tradeoff: isAnalyzed ? summarizeTradeoff(game, groups) : null,
      groups,
    },
  };
}

/**
 * 批次完整性自检：用于导入历史批次、以及"复现校验"。
 * 只做结构校验，不判奖。
 */
function verifyBatch(batch) {
  if (!batch || typeof batch !== 'object') {
    return { ok: false, code: 'BATCH_INVALID', message: '批次数据为空' };
  }
  if (!isGame(batch.game)) {
    return { ok: false, code: 'BATCH_INVALID', message: '批次彩种不合法' };
  }
  if (batch.algorithmVersion !== ALGORITHM_VERSION) {
    return {
      ok: false,
      code: 'ALGORITHM_VERSION_MISMATCH',
      message: `批次算法版本为 ${batch.algorithmVersion || '(空)'}，当前为 ${ALGORITHM_VERSION}`,
    };
  }
  if (!Array.isArray(batch.groups) || !batch.groups.length) {
    return { ok: false, code: 'BATCH_INVALID', message: '批次没有号码组' };
  }
  const seen = new Set();
  for (const g of batch.groups) {
    const n = g && g.numbers;
    const list = batch.game === GAME.SSQ ? n && n.red : n && n.kl8;
    if (!Array.isArray(list) || !list.length) {
      return { ok: false, code: 'BATCH_INVALID', message: '存在空号码组' };
    }
    const key = groupKey(batch.game, n);
    if (seen.has(key)) {
      return { ok: false, code: 'GROUP_DUPLICATED', message: '批次内存在重复号码组' };
    }
    seen.add(key);
  }
  return { ok: true, code: 'OK' };
}

/**
 * 用一期开奖结果回看批次命中情况（描述性，不判奖、不算钱）。
 * 判奖仍只走 shared/rules/judge.js。
 */
function reviewBatch(batch, draw) {
  if (!batch || !draw) {
    return { ok: false, code: 'NO_DRAW', message: '缺少批次或开奖数据' };
  }
  if (batch.game !== draw.game) {
    return { ok: false, code: 'GAME_MISMATCH', message: '批次与开奖彩种不一致' };
  }
  const isSsq = batch.game === GAME.SSQ;
  const drawRed = isSsq ? draw.numbers.red || [] : draw.numbers.kl8 || [];
  const drawBlue = isSsq ? draw.numbers.blue : null;

  const groups = (batch.groups || []).map((g) => {
    const list = isSsq ? g.numbers.red : g.numbers.kl8;
    const matched = list.filter((n) => drawRed.includes(n));
    const blueHit = isSsq && drawBlue !== null && drawBlue !== undefined ? g.numbers.blue === drawBlue : null;
    return {
      index: g.index,
      mainHits: matched.length,
      matched,
      blueHit,
      totalHits: matched.length + (blueHit ? 1 : 0),
    };
  });

  const best = groups.reduce((acc, g) => (acc === null || g.totalHits > acc.totalHits ? g : acc), null);
  return {
    ok: true,
    game: batch.game,
    issue: draw.issue,
    groups,
    best,
    note: '这是候选组合与开奖号码的重合情况，不代表已购买，也不构成任何预测结论。',
  };
}

module.exports = {
  ALGORITHM_VERSION,
  STRATEGY,
  STRATEGY_META,
  CODE,
  DEFAULT_COUNT,
  MIN_COUNT,
  MAX_COUNT,
  generateCandidates,
  verifyBatch,
  reviewBatch,
  normalizeSeed,
  createRng,
  hashSeed,
  groupKey,
};

});

/* ===== shared/domain/analysis.js ===== */
__define("shared/domain/analysis.js", function(module, exports, require){
/**
 * 号码分析：结构画像 + 拥挤度（"会不会被很多人同时选中"）。
 *
 * 这个文件只回答两个问题：
 *   1. 这组号码的形态是什么？（和值/跨度/奇偶/大小/分区/连号/AC/重号）
 *   2. 这组号码有多"像大众会选的号"？（拥挤度指数）
 *
 * 它明确不回答"下期会开什么"——那在数学上不成立，不做。
 *
 * 拥挤度的现实意义：
 *   双色球一/二等奖、快乐8选十中十是**浮动奖**，按中奖注数均分。
 *   中奖概率与号码选择无关，但"有多少人跟你选了同一组"会影响到手金额。
 *   所以避开大众偏好，改变的是"中了分多少"，不是"能不能中"。
 *
 * 研究依据（参数据此设定，不是拍脑袋）：
 *   - Cook & Clotfelter (1993) "conscious selection"：玩家系统性偏向日期号，1–31 被超额选择。
 *   - Farrell, Hartley, Lanot & Walker (2000)：英国彩票中 7 最热，被选频率比最冷的 46 高约 25%。
 *   - Cox 等 (1998, JRSS-A)：冷门组合长期回报约 95 便士/英镑，随机约 45 便士（仍 < 1，赚不了钱）。
 *   - Baker & McHale (2009)：玩家偏爱"看起来像设计过"的票（连号、等差、等间距）。
 *
 * 重要限制：中国福彩不公布每注号码的投注分布，因此这里的权重是**基于公开研究的推定**，
 * 不是实测数据。界面必须如实标注这一点，不得表述为"测算出的真实中奖人数"。
 */

const { GAME, GAME_META } = require('../constants/games');

const CROWD_MODEL_VERSION = 'crowd@1.0.0';

const CODE = {
  OK: 'OK',
  BAD_GAME: 'BAD_GAME',
  BAD_NUMBERS: 'BAD_NUMBERS',
};

/** 拥挤度等级（按指数切分，越低越冷门） */
const CROWD_LEVEL = {
  LOW: 'low',
  MEDIUM_LOW: 'medium_low',
  MEDIUM: 'medium',
  MEDIUM_HIGH: 'medium_high',
  HIGH: 'high',
};

const CROWD_LEVEL_TEXT = {
  low: '低',
  medium_low: '中低',
  medium: '中',
  medium_high: '中高',
  high: '高',
};

/**
 * 权重表：单位是"人群偏好分"，正数=更像大众会选，负数=大众回避。
 * 全部集中在这里，改权重必须升 CROWD_MODEL_VERSION 并补测试。
 */
const WEIGHTS = {
  // 生日区（日期可达）：按"超出随机期望的个数"计，而不是按绝对个数。
  // 双色球只有 32/33 两个号在日期之外，若按绝对个数算，几乎每注都会被判"拥挤"，
  // 指数就失去区分度——这是第一版校准踩过的坑。
  birthdayExcess: 1.6,
  monthDayExcess: 0.5, // ≤12 的号码（既是日也是月），同样按超出期望计
  // 文化偏好
  luckyCN: 0.5, // 6 / 8 / 9
  unluckyCN: -0.5, // 4（中文语境忌讳，被选得更少）
  luckySeven: 0.6, // 7（多国数据一致偏热）
  // 形态
  allInBirthdayZone: 3.0, // 整注都在 1–31
  consecutivePair: 0.8, // 每有一对连号
  arithmeticRun: 2.0, // 存在长度 ≥3 的等差
  sameTailPair: 0.4, // 同尾号（个位相同）每对
  repeatWithPrev: 1.0, // 与上期重号，每个
  centerSum: 0.5, // 和值落在"最常见区间"（看着最正常）
  allOddOrEven: -0.8, // 全奇/全偶，人很少这么选
  // 蓝球
  blueMonthDay: 0.5, // 蓝球 ≤12
  blueHigh: -0.3, // 蓝球 13–16
  blueLucky: 0.4, // 蓝球 7 / 8
};

/** 和值"最正常"的区间：双色球按研究常提到的 85–115；快乐8 按 10 个号的均值换算 */
const CENTER_SUM = {
  [GAME.SSQ]: [85, 115],
  [GAME.KL8]: [360, 450],
};

function numList(game, numbers) {
  if (game === GAME.SSQ) return (numbers && numbers.red) || [];
  return (numbers && numbers.kl8) || [];
}

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

/** 连号对数：相邻且差 1 的号码对 */
function consecutivePairs(list) {
  const sorted = list.slice().sort((a, b) => a - b);
  const pairs = [];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) pairs.push([sorted[i - 1], sorted[i]]);
  }
  return pairs;
}

/**
 * 是否存在"看起来被设计过"的等差数列。
 * 阈值：长度 ≥4，或长度 3 且公差为 1（三连号）。
 * 随意 6 个号里出现 3 项等差太常见，不算大众模式，否则会误伤普通组合。
 */
function hasArithmeticRun(list, minLen = 4) {
  const sorted = list.slice().sort((a, b) => a - b);
  for (let i = 0; i <= sorted.length - minLen; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const step = sorted[j] - sorted[i];
      if (step <= 0) continue;
      let count = 2;
      let last = sorted[j];
      for (let k = j + 1; k < sorted.length; k += 1) {
        if (sorted[k] - last === step) {
          count += 1;
          last = sorted[k];
          const qualifies = count >= minLen || (count === 3 && step === 1);
          if (qualifies) return { start: sorted[i], step, length: count };
        } else if (sorted[k] - last > step) {
          break;
        }
      }
    }
  }
  return null;
}

/** 同尾号对数（个位相同） */
function sameTailPairs(list) {
  const buckets = new Map();
  for (const n of list) {
    const tail = n % 10;
    buckets.set(tail, (buckets.get(tail) || 0) + 1);
  }
  let pairs = 0;
  for (const count of buckets.values()) {
    if (count >= 2) pairs += (count * (count - 1)) / 2;
  }
  return pairs;
}

/** AC 值：不同差值个数 - (号码个数 - 1)，衡量号码离散程度 */
function acValue(list) {
  const diffs = new Set();
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      diffs.add(Math.abs(list[j] - list[i]));
    }
  }
  return diffs.size - (list.length - 1);
}

/**
 * 结构画像：纯描述，不含任何倾向性判断。
 * @param {'ssq'|'kl8'} game
 * @param {{red?:number[], blue?:number, kl8?:number[]}} numbers
 * @param {{previousDraw?: object}} [options]
 */
function describeStructure(game, numbers, options = {}) {
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.BAD_GAME, message: '彩种不合法' };
  }
  const main = numList(game, numbers);
  const count = game === GAME.SSQ ? GAME_META[GAME.SSQ].redCount : GAME_META[GAME.KL8].count;
  if (!Array.isArray(main) || main.length !== count) {
    return { ok: false, code: CODE.BAD_NUMBERS, message: `号码数量应为 ${count} 个` };
  }

  const sorted = main.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const span = sorted[sorted.length - 1] - sorted[0];
  const odd = sorted.filter((n) => n % 2 === 1).length;
  const even = sorted.length - odd;
  const bigLine = game === GAME.SSQ ? 17 : 41;
  const big = sorted.filter((n) => n >= bigLine).length;
  const small = sorted.length - big;

  const zones = game === GAME.SSQ
    ? [
        [1, 11],
        [12, 22],
        [23, 33],
      ]
    : [
        [1, 20],
        [21, 40],
        [41, 60],
        [61, 80],
      ];
  const zoneCounts = zones.map(() => 0);
  for (const n of sorted) {
    for (let i = 0; i < zones.length; i += 1) {
      if (n >= zones[i][0] && n <= zones[i][1]) {
        zoneCounts[i] += 1;
        break;
      }
    }
  }

  const prev = options.previousDraw ? numList(game, options.previousDraw.numbers) : [];
  const repeats = prev.length ? sorted.filter((n) => prev.includes(n)) : [];
  const pairs = consecutivePairs(sorted);
  const run = hasArithmeticRun(sorted);
  const center = CENTER_SUM[game];
  const inCenterSum = sum >= center[0] && sum <= center[1];

  return {
    ok: true,
    game,
    numbers: sorted,
    blue: game === GAME.SSQ && numbers.blue !== undefined ? numbers.blue : null,
    sum,
    span,
    odd,
    even,
    big,
    small,
    zones: zoneCounts,
    zoneLabels: game === GAME.SSQ ? ['1–11', '12–22', '23–33'] : ['1–20', '21–40', '41–60', '61–80'],
    consecutivePairs: pairs.length,
    consecutive: pairs,
    arithmeticRun: run,
    sameTailPairs: sameTailPairs(sorted),
    acValue: acValue(sorted),
    repeats,
    inCenterSum,
    centerSumRange: center,
    count: sorted.length,
  };
}

/**
 * 拥挤度指数：0（最冷门）–100（最拥挤）。
 * 这是公开研究推导出的**推定值**，不是实测投注人数。
 */
function crowdIndex(game, numbers, options = {}) {
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.BAD_GAME, message: '彩种不合法' };
  }
  const main = numList(game, numbers);
  const count = game === GAME.SSQ ? GAME_META[GAME.SSQ].redCount : GAME_META[GAME.KL8].count;
  if (!Array.isArray(main) || main.length !== count) {
    return { ok: false, code: CODE.BAD_NUMBERS, message: `号码数量应为 ${count} 个` };
  }

  const sorted = main.slice().sort((a, b) => a - b);
  const factors = [];
  let score = 0;

  const add = (key, label, delta) => {
    if (!delta) return;
    score += delta;
    factors.push({ key, label, delta: Math.round(delta * 100) / 100 });
  };

  const poolMax = game === GAME.SSQ ? GAME_META[GAME.SSQ].redMax : GAME_META[GAME.KL8].max;
  const lowInBirthday = sorted.filter((n) => n <= 31).length;
  const highAbove = sorted.filter((n) => n > 31).length;
  const monthDay = sorted.filter((n) => n <= 12).length;
  const lucky = sorted.filter((n) => n === 6 || n === 8 || n === 9).length;
  const unlucky = sorted.filter((n) => n === 4).length;
  const sevens = sorted.filter((n) => n === 7).length;

  // 随机选号时"落在生日区"的期望个数；超出多少才算偏大众
  const expectedLow = (31 / poolMax) * sorted.length;
  const expectedMonthDay = (12 / poolMax) * sorted.length;
  const lowExcess = lowInBirthday - expectedLow;
  const monthExcess = monthDay - expectedMonthDay;

  add(
    'birthdayZone',
    `${lowInBirthday} 个号在 1–31（随机期望约 ${expectedLow.toFixed(1)} 个）`,
    lowExcess * WEIGHTS.birthdayExcess
  );
  add(
    'monthDay',
    `${monthDay} 个号 ≤12（日/月重叠，随机期望约 ${expectedMonthDay.toFixed(1)} 个）`,
    monthExcess * WEIGHTS.monthDayExcess
  );
  add('luckyCN', `${lucky} 个号码是 6/8/9（中文吉利数）`, lucky * WEIGHTS.luckyCN);
  add('unluckyCN', `${unlucky} 个号码是 4（中文忌讳，反而少人选）`, unlucky * WEIGHTS.unluckyCN);
  add('luckySeven', `${sevens} 个号码是 7（多国最热号）`, sevens * WEIGHTS.luckySeven);

  if (highAbove === 0) add('allInBirthdayZone', '整注都在 1–31 内', WEIGHTS.allInBirthdayZone);

  const pairs = consecutivePairs(sorted).length;
  add('consecutivePair', `${pairs} 对连号`, Math.min(pairs, 2) * WEIGHTS.consecutivePair);

  const run = hasArithmeticRun(sorted);
  add('arithmeticRun', run ? `存在等差 ${run.start} 起、公差 ${run.step}` : '', run ? WEIGHTS.arithmeticRun : 0);

  const tails = sameTailPairs(sorted);
  add('sameTailPair', `${tails} 对同尾号`, Math.min(tails, 2) * WEIGHTS.sameTailPair);

  const prev = options.previousDraw ? numList(game, options.previousDraw.numbers) : [];
  const repeats = prev.length ? sorted.filter((n) => prev.includes(n)) : [];
  add('repeatWithPrev', prev.length ? `${repeats.length} 个号与上期重号` : '', Math.min(repeats.length, 3) * WEIGHTS.repeatWithPrev);

  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const center = CENTER_SUM[game];
  const inCenter = sum >= center[0] && sum <= center[1];
  add('centerSum', inCenter ? `和值 ${sum} 落在「最常见」区间` : '', inCenter ? WEIGHTS.centerSum : 0);

  const odd = sorted.filter((n) => n % 2 === 1).length;
  if (odd === 0 || odd === sorted.length) {
    add('allOddOrEven', odd === 0 ? '全偶数（人很少这么选）' : '全奇数（人很少这么选）', WEIGHTS.allOddOrEven);
  }

  if (game === GAME.SSQ && numbers.blue !== undefined && numbers.blue !== null) {
    const blue = numbers.blue;
    add('blueMonthDay', blue <= 12 ? `蓝球 ${blue} ≤12（日期可达）` : '', blue <= 12 ? WEIGHTS.blueMonthDay : 0);
    add('blueHigh', blue > 12 ? `蓝球 ${blue} 在 13–16（日期不可达）` : '', blue > 12 ? WEIGHTS.blueHigh : 0);
    add('blueLucky', blue === 7 || blue === 8 ? `蓝球 ${blue} 是热门号` : '', blue === 7 || blue === 8 ? WEIGHTS.blueLucky : 0);
  }

  const index = Math.max(0, Math.min(100, Math.round(50 + score * 5)));
  const level =
    index <= 25
      ? CROWD_LEVEL.LOW
      : index <= 42
      ? CROWD_LEVEL.MEDIUM_LOW
      : index <= 58
      ? CROWD_LEVEL.MEDIUM
      : index <= 72
      ? CROWD_LEVEL.MEDIUM_HIGH
      : CROWD_LEVEL.HIGH;

  return {
    ok: true,
    game,
    index,
    level,
    levelText: CROWD_LEVEL_TEXT[level],
    score: Math.round(score * 100) / 100,
    factors: factors.filter((f) => f.delta !== 0),
    modelVersion: CROWD_MODEL_VERSION,
    caveat:
      '拥挤度是基于公开研究（生日偏好、幸运号、连号/等差偏好等）推导的推定值，不是实测投注人数——中国福彩不公布每注号码的投注分布。它只影响浮动奖的均分，不改变中奖概率。',
  };
}

/** 组合分析：一次拿到结构 + 拥挤度 */
function analyzeNumbers(game, numbers, options = {}) {
  const structure = describeStructure(game, numbers, options);
  if (!structure.ok) return structure;
  const crowd = crowdIndex(game, numbers, options);
  if (!crowd.ok) return crowd;
  return {
    ok: true,
    game,
    numbers: structure.numbers,
    structure,
    crowd,
    note: '结构是描述，拥挤度是推定；两者都不改变中奖概率。',
  };
}

/**
 * 冷号：近 window 期一次都没出现的号码。
 * 用途只有一个——当作"大众会回避的号"来降低拥挤度，
 * **不是**"该回补了"。这两件事必须区分清楚。
 */
function coldNumbers(game, recentDraws, window = 30) {
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.BAD_GAME, message: '彩种不合法' };
  }
  const meta = GAME_META[game];
  const max = game === GAME.SSQ ? meta.redMax : meta.max;
  const list = (recentDraws || []).slice(0, Math.max(0, window));
  if (!list.length) {
    return { ok: true, window: 0, sampleSize: 0, cold: [], frequencies: {}, note: '没有历史开奖数据，冷号为空' };
  }
  const freq = {};
  for (let n = 1; n <= max; n += 1) freq[n] = 0;
  for (const d of list) {
    const nums = numList(game, d.numbers);
    for (const n of nums) {
      if (freq[n] !== undefined) freq[n] += 1;
    }
  }
  const cold = Object.keys(freq)
    .map(Number)
    .filter((n) => freq[n] === 0)
    .sort((a, b) => a - b);
  return {
    ok: true,
    window: list.length,
    sampleSize: list.length,
    cold,
    frequencies: freq,
    note: '冷号只代表这段时间没出现过，不代表下期更可能或更不可能出现。',
  };
}

module.exports = {
  CROWD_MODEL_VERSION,
  CROWD_LEVEL,
  CROWD_LEVEL_TEXT,
  WEIGHTS,
  CODE,
  describeStructure,
  crowdIndex,
  analyzeNumbers,
  coldNumbers,
  consecutivePairs,
  hasArithmeticRun,
  sameTailPairs,
  acValue,
};

});

/* ===== shared/domain/analytics.js ===== */
__define("shared/domain/analytics.js", function(module, exports, require){
/**
 * 统计计算（纯函数，无副作用）。
 *
 * 这里只做**描述性统计**：出现了多少次、遗漏几期、和值落在哪、命中几个。
 * 不产生任何"下期倾向"结论——历史分布不改变独立随机事件的概率。
 *
 * 与 analysis.js 的分工：
 *   analytics.js = 看历史（开奖结构、个人表现）
 *   analysis.js  = 选号码（拥挤度），明确不用于预测
 */

const { GAME, GAME_META } = require('../constants/games');

const ANALYTICS_VERSION = 'analytics@1.0.0';
const WINDOWS = [30, 50, 100, 200, 300, 1000, 3000];

const NOTE =
  '以上均为历史描述性统计：它说明过去发生了什么，不预示下一期。样本量越小，波动越大。';

function isGame(game) {
  return game === GAME.SSQ || game === GAME.KL8;
}

function sortedDraws(draws) {
  return (draws || [])
    .filter((d) => d && d.numbers)
    .slice()
    .sort((a, b) => Number(b.issue) - Number(a.issue));
}

function mainNumbers(game, draw) {
  if (game === GAME.SSQ) return (draw.numbers && draw.numbers.red) || [];
  return (draw.numbers && draw.numbers.kl8) || [];
}

function mean(list) {
  if (!list.length) return 0;
  return list.reduce((acc, n) => acc + n, 0) / list.length;
}

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

function percentile(list, p) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

/**
 * 号码频次与当前遗漏。
 * @param {'ssq'|'kl8'} game
 * @param {Array} draws 开奖记录（任意顺序，内部按 issue 降序）
 * @param {{window?: number}} [options]
 */
function numberFrequency(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) {
    return {
      ok: false,
      code: 'NO_DRAWS',
      message: '本地还没有已核验的开奖数据，先在「开奖」页同步',
    };
  }

  const meta = GAME_META[game];
  const max = game === GAME.SSQ ? meta.redMax : meta.max;
  const rows = [];
  for (let n = 1; n <= max; n += 1) rows.push({ number: n, count: 0, omission: list.length });

  // list 已按最新在前，第一次遇到即为"当前遗漏"
  list.forEach((d, idx) => {
    for (const n of mainNumbers(game, d)) {
      const row = rows[n - 1];
      if (!row) continue;
      row.count += 1;
      if (row.omission === list.length) row.omission = idx;
    }
  });

  for (const row of rows) row.rate = Math.round((row.count / list.length) * 1000) / 10;

  const blue = [];
  if (game === GAME.SSQ) {
    for (let n = 1; n <= meta.blueMax; n += 1) blue.push({ number: n, count: 0, omission: list.length });
    list.forEach((d, idx) => {
      const b = d.numbers && d.numbers.blue;
      if (b === null || b === undefined) return;
      const row = blue[b - 1];
      if (!row) return;
      row.count += 1;
      if (row.omission === list.length) row.omission = idx;
    });
    for (const row of blue) row.rate = Math.round((row.count / list.length) * 1000) / 10;
  }

  const byCount = rows.slice().sort((a, b) => b.count - a.count || a.number - b.number);
  const byOmission = rows.slice().sort((a, b) => b.omission - a.omission || a.number - b.number);

  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    requestedWindow: window,
    issueRange: { from: list[list.length - 1].issue, to: list[0].issue },
    rows,
    blue: game === GAME.SSQ ? blue : undefined,
    mostSeen: byCount.slice(0, 5),
    leastSeen: byCount.slice(-5).reverse(),
    longestOmission: byOmission.slice(0, 5),
    note: list.length < window ? `请求 ${window} 期，本地只有 ${list.length} 期，样本偏小。` : NOTE,
  };
}

/** 和值分布：分桶 + 分位 */
function sumDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const sums = list.map((d) => mainNumbers(game, d).reduce((acc, n) => acc + n, 0));
  const min = Math.min(...sums);
  const max = Math.max(...sums);
  const bucketCount = 6;
  const step = Math.max(1, Math.ceil((max - min + 1) / bucketCount));
  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const from = min + i * step;
    const to = from + step - 1;
    buckets.push({ from, to, count: sums.filter((s) => s >= from && s <= to).length });
  }

  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    min,
    max,
    avg: Math.round(mean(sums) * 10) / 10,
    median: median(sums),
    p25: percentile(sums, 25),
    p75: percentile(sums, 75),
    buckets,
    note: NOTE,
  };
}

/** 奇偶分布：奇数个数 → 期数 */
function parityDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  // 双色球统计 6 个红球；快乐8 开奖是 20 个号，不能按"选十"的 10 个分桶
  // （早期版本按 10 分桶，奇数 >10 的期数会被静默丢弃——已修正）
  const maxLen = Math.max(...list.map((d) => mainNumbers(game, d).length), 0);
  const rows = [];
  for (let i = 0; i <= maxLen; i += 1) rows.push({ odd: i, even: maxLen - i, count: 0 });
  for (const d of list) {
    const odd = mainNumbers(game, d).filter((n) => n % 2 === 1).length;
    if (rows[odd]) rows[odd].count += 1;
  }
  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    ballsPerDraw: maxLen,
    rows,
    note: NOTE,
  };
}

/** 三区（双色球）/ 四区（快乐8）分布 */
function zoneDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const zones = game === GAME.SSQ
    ? [
        { label: '1–11', from: 1, to: 11 },
        { label: '12–22', from: 12, to: 22 },
        { label: '23–33', from: 23, to: 33 },
      ]
    : [
        { label: '1–20', from: 1, to: 20 },
        { label: '21–40', from: 21, to: 40 },
        { label: '41–60', from: 41, to: 60 },
        { label: '61–80', from: 61, to: 80 },
      ];

  const totals = zones.map(() => 0);
  let brokenZoneIssues = 0;
  for (const d of list) {
    const nums = mainNumbers(game, d);
    const counts = zones.map((z) => nums.filter((n) => n >= z.from && n <= z.to).length);
    counts.forEach((c, i) => {
      totals[i] += c;
    });
    if (counts.some((c) => c === 0)) brokenZoneIssues += 1;
  }

  const totalBalls = totals.reduce((acc, n) => acc + n, 0) || 1;
  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    zones: zones.map((z, i) => ({
      label: z.label,
      count: totals[i],
      share: Math.round((totals[i] / totalBalls) * 1000) / 10,
      avgPerIssue: Math.round((totals[i] / list.length) * 100) / 100,
    })),
    brokenZoneIssues,
    note: `${NOTE} 断区（某区一个号都没出）在 ${list.length} 期里出现 ${brokenZoneIssues} 次，属于正常波动，不是"该回补"的信号。`,
  };
}

/** 连号出现情况 */
function consecutiveDistribution(game, draws, options = {}) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const window = WINDOWS.includes(Number(options.window)) ? Number(options.window) : 30;
  const list = sortedDraws(draws).slice(0, window);
  if (!list.length) return { ok: false, code: 'NO_DRAWS', message: '暂无开奖数据' };

  const rows = [];
  for (const d of list) {
    const nums = mainNumbers(game, d).slice().sort((a, b) => a - b);
    let pairs = 0;
    for (let i = 1; i < nums.length; i += 1) if (nums[i] - nums[i - 1] === 1) pairs += 1;
    rows.push({ issue: d.issue, pairs });
  }
  const withConsecutive = rows.filter((r) => r.pairs > 0).length;
  return {
    ok: true,
    game,
    window,
    sampleSize: list.length,
    withConsecutive,
    share: Math.round((withConsecutive / list.length) * 1000) / 10,
    avgPairs: Math.round(mean(rows.map((r) => r.pairs)) * 100) / 100,
    note: NOTE,
  };
}

/**
 * 个人命中分布：从核对结果统计"每注命中几个"。
 * 双色球按红球命中数分桶，并单独统计蓝球；快乐8按命中个数分桶。
 * 只统计有核对结果的记录（草稿不参与）。
 */
function hitDistribution(game, checks) {
  if (!isGame(game)) return { ok: false, code: 'BAD_GAME', message: '彩种不合法' };
  const list = (checks || []).filter((c) => c && c.game === game && c.hitDetails);
  if (!list.length) {
    return { ok: false, code: 'NO_CHECKS', message: '还没有核对结果，先到「我的号码」点一键核对' };
  }

  if (game === GAME.SSQ) {
    const rows = [];
    for (let i = 0; i <= 6; i += 1) rows.push({ hits: i, count: 0 });
    let blueHits = 0;
    for (const c of list) {
      const red = Number(c.hitDetails.red) || 0;
      if (rows[red]) rows[red].count += 1;
      if (c.hitDetails.blue) blueHits += 1;
    }
    return {
      ok: true,
      game,
      sampleSize: list.length,
      rows,
      blueHits,
      note: '统计的是已核对过的记录（每注一条），同一注重算不会重复计数。',
    };
  }

  const rows = [];
  for (let i = 0; i <= 10; i += 1) rows.push({ hits: i, count: 0 });
  for (const c of list) {
    const hits = Number(c.hitDetails.count);
    if (Number.isInteger(hits) && rows[hits]) rows[hits].count += 1;
  }
  return {
    ok: true,
    game,
    sampleSize: list.length,
    rows,
    note: '统计的是已核对过的记录（每注一条），同一注重算不会重复计数。',
  };
}

/** 汇总：一次算完统计页需要的所有块 */
function buildAnalytics(game, draws, checks, options = {}) {
  return {
    version: ANALYTICS_VERSION,
    game,
    frequency: numberFrequency(game, draws, options),
    sum: sumDistribution(game, draws, options),
    parity: parityDistribution(game, draws, options),
    zones: zoneDistribution(game, draws, options),
    consecutive: consecutiveDistribution(game, draws, options),
    hits: hitDistribution(game, checks),
  };
}

module.exports = {
  ANALYTICS_VERSION,
  WINDOWS,
  NOTE,
  numberFrequency,
  sumDistribution,
  parityDistribution,
  zoneDistribution,
  consecutiveDistribution,
  hitDistribution,
  buildAnalytics,
};

});

/* ===== shared/domain/tickets.js ===== */
__define("shared/domain/tickets.js", function(module, exports, require){
/**
 * 号码记录域模型（前后端共用）。
 *
 * 核心不变量：
 *   1. 候选/草稿 ≠ 已购买。只有 draft → confirmed 的显式动作才算"买了"。
 *   2. confirmed 之后号码冻结：只能改备注/金额/倍数，改号必须作废重建（保留痕迹）。
 *   3. 只有 confirmed 参与真实投入统计与判奖（见 isEligibleForPrize / isCountedInStats）。
 */

const { GAME, GAME_META, PURCHASE_STATUS, isGame } = require('../constants/games');
const { validateNumbers, combinationKey, formatDisplay } = require('../validators/numbers');
const { isValidIssue } = require('../rules/registry');

const CODE = {
  OK: 'OK',
  GAME_UNSUPPORTED: 'GAME_UNSUPPORTED',
  ISSUE_INVALID: 'ISSUE_INVALID',
  NUMBERS_INVALID: 'NUMBERS_INVALID',
  MULTIPLE_INVALID: 'MULTIPLE_INVALID',
  COST_INVALID: 'COST_INVALID',
  NOTE_TOO_LONG: 'NOTE_TOO_LONG',
  PURCHASE_AT_INVALID: 'PURCHASE_AT_INVALID',
  IDEMPOTENCY_INVALID: 'IDEMPOTENCY_INVALID',
  STATUS_INVALID: 'STATUS_INVALID',
  TRANSITION_NOT_ALLOWED: 'TRANSITION_NOT_ALLOWED',
  NUMBER_FROZEN: 'NUMBER_FROZEN',
  FIELD_NOT_EDITABLE: 'FIELD_NOT_EDITABLE',
  DELETE_NOT_ALLOWED: 'DELETE_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
};

const MAX_MULTIPLE = 99;
const MAX_COST = 1000000;
const MAX_NOTE_LENGTH = 200;

/** draft 可改字段；confirmed 只允许这些非号码字段；void 只读 */
const EDITABLE_FIELDS = {
  draft: ['game', 'issue', 'numbers', 'multiple', 'actualCost', 'note', 'recordSource', 'candidateId'],
  confirmed: ['note', 'actualCost', 'multiple'],
  void: [],
};

function isIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const dt = new Date(value);
  return !Number.isNaN(dt.getTime());
}

function validateMultiple(value) {
  if (value === undefined || value === null) return { ok: true, value: 1 };
  if (!Number.isInteger(value) || value < 1 || value > MAX_MULTIPLE) {
    return { ok: false, code: CODE.MULTIPLE_INVALID, message: `倍数需为 1–${MAX_MULTIPLE} 的整数` };
  }
  return { ok: true, value };
}

function validateCost(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > MAX_COST) {
    return { ok: false, code: CODE.COST_INVALID, message: `金额需在 0–${MAX_COST} 元之间` };
  }
  return { ok: true, value: Math.round(num * 100) / 100 };
}

function validateNote(value) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  const text = String(value);
  if (text.length > MAX_NOTE_LENGTH) {
    return { ok: false, code: CODE.NOTE_TOO_LONG, message: `备注最多 ${MAX_NOTE_LENGTH} 字` };
  }
  return { ok: true, value: text };
}

/** 购买时间：允许过去，允许当天，不允许晚于当前 +1 天（防手误年份） */
function validatePurchaseAt(value, now) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (!isIsoDateTime(value)) {
    return { ok: false, code: CODE.PURCHASE_AT_INVALID, message: '购买时间格式不正确' };
  }
  const dt = new Date(value);
  const limit = (now || new Date()).getTime() + 86400000;
  if (dt.getTime() > limit) {
    return { ok: false, code: CODE.PURCHASE_AT_INVALID, message: '购买时间不能晚于当前时间' };
  }
  return { ok: true, value: dt.toISOString() };
}

/**
 * 构造草稿记录（尚未确认购买）。
 * @param {object} input {game, issue, numbers, recordSource, candidateId, note, multiple, actualCost, idempotencyKey}
 * @param {{ownerOpenId?: string, now?: Date}} ctx
 */
function buildTicketDraft(input, ctx = {}) {
  const payload = input || {};
  const { game } = payload;

  if (!isGame(game)) {
    return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '只支持双色球与快乐8选十' };
  }
  if (!isValidIssue(payload.issue)) {
    return { ok: false, code: CODE.ISSUE_INVALID, message: '期号需为 7 位数字，如 2026127' };
  }

  const numbers = validateNumbers(game, payload.numbers || {});
  if (!numbers.ok) {
    return { ok: false, code: CODE.NUMBERS_INVALID, message: numbers.message };
  }

  const multiple = validateMultiple(payload.multiple);
  if (!multiple.ok) return multiple;

  const cost = validateCost(payload.actualCost);
  if (!cost.ok) return cost;

  const note = validateNote(payload.note);
  if (!note.ok) return note;

  const key = payload.idempotencyKey;
  if (key !== undefined && key !== null && (typeof key !== 'string' || key.length > 64)) {
    return { ok: false, code: CODE.IDEMPOTENCY_INVALID, message: '幂等键不合法' };
  }

  const now = ctx.now || new Date();
  const meta = GAME_META[game];

  return {
    ok: true,
    code: CODE.OK,
    record: {
      ownerOpenId: ctx.ownerOpenId || null,
      game,
      playType: meta.playType,
      issue: payload.issue,
      numbers: numbers.normalized,
      displayText: formatDisplay(game, numbers.normalized),
      numberKey: combinationKey(game, numbers.normalized),
      recordSource: payload.recordSource === 'candidate_import' ? 'candidate_import' : 'manual',
      candidateId: payload.candidateId || null,
      purchaseStatus: PURCHASE_STATUS.DRAFT,
      purchaseAt: null,
      actualCost: cost.value,
      multiple: multiple.value,
      note: note.value,
      idempotencyKey: key || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: null,
      voidedAt: null,
    },
  };
}

function getAllowedFields(status) {
  return EDITABLE_FIELDS[status] || [];
}

/**
 * 编辑草稿/已购买记录。
 * 已购买记录的号码字段一律拒绝（NUMBER_FROZEN），必须作废后重建。
 */
function applyPatch(ticket, patch, ctx = {}) {
  if (!ticket || !ticket.purchaseStatus) {
    return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  }
  const status = ticket.purchaseStatus;
  const allowed = getAllowedFields(status);

  if (status === PURCHASE_STATUS.VOID) {
    return { ok: false, code: CODE.FIELD_NOT_EDITABLE, message: '已作废记录不可编辑' };
  }

  const incoming = patch || {};
  const keys = Object.keys(incoming).filter((k) => incoming[k] !== undefined);
  if (keys.length === 0) {
    return { ok: false, code: CODE.FIELD_NOT_EDITABLE, message: '没有需要修改的内容' };
  }

  const blockedNumbers = ['numbers', 'game', 'issue', 'numberKey'].filter((k) => keys.includes(k));
  if (blockedNumbers.length && status === PURCHASE_STATUS.CONFIRMED) {
    return {
      ok: false,
      code: CODE.NUMBER_FROZEN,
      message: '已确认购买的记录不能修改号码或期号；如需更正请先作废再新建',
    };
  }

  const forbidden = keys.filter((k) => !allowed.includes(k));
  if (forbidden.length) {
    return {
      ok: false,
      code: CODE.FIELD_NOT_EDITABLE,
      message: `以下字段不可修改：${forbidden.join(', ')}`,
    };
  }

  const update = {};

  if (keys.includes('game') || keys.includes('issue') || keys.includes('numbers')) {
    const nextGame = incoming.game || ticket.game;
    const nextIssue = incoming.issue || ticket.issue;
    if (!isGame(nextGame)) {
      return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '不支持的彩种' };
    }
    if (!isValidIssue(nextIssue)) {
      return { ok: false, code: CODE.ISSUE_INVALID, message: '期号需为 7 位数字' };
    }
    const numbers = validateNumbers(nextGame, incoming.numbers || ticket.numbers);
    if (!numbers.ok) {
      return { ok: false, code: CODE.NUMBERS_INVALID, message: numbers.message };
    }
    update.game = nextGame;
    update.issue = nextIssue;
    update.playType = GAME_META[nextGame].playType;
    update.numbers = numbers.normalized;
    update.displayText = formatDisplay(nextGame, numbers.normalized);
    update.numberKey = combinationKey(nextGame, numbers.normalized);
  }

  if (keys.includes('multiple')) {
    const m = validateMultiple(incoming.multiple);
    if (!m.ok) return m;
    update.multiple = m.value;
  }
  if (keys.includes('actualCost')) {
    const c = validateCost(incoming.actualCost);
    if (!c.ok) return c;
    update.actualCost = c.value;
  }
  if (keys.includes('note')) {
    const n = validateNote(incoming.note);
    if (!n.ok) return n;
    update.note = n.value;
  }
  if (keys.includes('recordSource')) {
    update.recordSource = incoming.recordSource === 'candidate_import' ? 'candidate_import' : 'manual';
  }
  if (keys.includes('candidateId')) {
    update.candidateId = incoming.candidateId || null;
  }

  update.updatedAt = (ctx.now || new Date()).toISOString();
  return { ok: true, code: CODE.OK, update };
}

/**
 * 确认已购买：draft → confirmed。
 * 必须显式提供实际金额（可为 0，如赠票），避免用"推算金额"污染统计。
 */
function confirmPurchase(ticket, payload, ctx = {}) {
  if (!ticket || !ticket.purchaseStatus) {
    return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  }
  if (ticket.purchaseStatus !== PURCHASE_STATUS.DRAFT) {
    return {
      ok: false,
      code: CODE.TRANSITION_NOT_ALLOWED,
      message: `当前状态 ${ticket.purchaseStatus} 不能执行"确认已购买"`,
    };
  }

  const input = payload || {};
  const now = ctx.now || new Date();

  const cost = validateCost(input.actualCost);
  if (!cost.ok) return cost;
  if (cost.value === null) {
    return { ok: false, code: CODE.COST_INVALID, message: '请填写实际支付金额（赠送票可填 0）' };
  }

  const multiple = validateMultiple(input.multiple === undefined ? ticket.multiple : input.multiple);
  if (!multiple.ok) return multiple;

  const purchaseAt = validatePurchaseAt(input.purchaseAt, now);
  if (!purchaseAt.ok) return purchaseAt;

  const note = input.note === undefined ? { ok: true, value: ticket.note } : validateNote(input.note);
  if (!note.ok) return note;

  return {
    ok: true,
    code: CODE.OK,
    update: {
      purchaseStatus: PURCHASE_STATUS.CONFIRMED,
      purchaseAt: purchaseAt.value || now.toISOString(),
      actualCost: cost.value,
      multiple: multiple.value,
      note: note.value,
      confirmedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
}

/** 作废：draft / confirmed → void。已核对结果（阶段 4）不受影响，但会从统计中剔除 */
function voidTicket(ticket, payload, ctx = {}) {
  if (!ticket || !ticket.purchaseStatus) {
    return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  }
  if (ticket.purchaseStatus === PURCHASE_STATUS.VOID) {
    return { ok: false, code: CODE.TRANSITION_NOT_ALLOWED, message: '该记录已作废' };
  }
  const reason = validateNote((payload || {}).reason);
  if (!reason.ok) return reason;
  const now = ctx.now || new Date();

  return {
    ok: true,
    code: CODE.OK,
    update: {
      purchaseStatus: PURCHASE_STATUS.VOID,
      voidedAt: now.toISOString(),
      voidReason: reason.value || '',
      updatedAt: now.toISOString(),
    },
  };
}

/** 只有草稿与已作废可物理删除；已确认购买必须先作废（主方案 14.4） */
function canDeleteTicket(ticket) {
  if (!ticket) return { ok: false, code: CODE.NOT_FOUND, message: '记录不存在' };
  if (ticket.purchaseStatus === PURCHASE_STATUS.CONFIRMED) {
    return {
      ok: false,
      code: CODE.DELETE_NOT_ALLOWED,
      message: '已确认购买的记录请先作废再删除，以免历史统计无痕变化',
    };
  }
  return { ok: true, code: CODE.OK };
}

/** 判奖准入：仅 confirmed */
function isEligibleForPrize(ticket) {
  return Boolean(ticket) && ticket.purchaseStatus === PURCHASE_STATUS.CONFIRMED;
}

/** 统计准入：仅 confirmed（void 与 draft 都不计入真实投入/中奖） */
function isCountedInStats(ticket) {
  return Boolean(ticket) && ticket.purchaseStatus === PURCHASE_STATUS.CONFIRMED;
}

/** 列表分组计数 */
function summarize(list) {
  const acc = { draft: 0, confirmed: 0, void: 0, total: 0 };
  for (const t of list || []) {
    acc.total += 1;
    if (acc[t.purchaseStatus] !== undefined) acc[t.purchaseStatus] += 1;
  }
  return acc;
}

module.exports = {
  CODE,
  MAX_MULTIPLE,
  MAX_COST,
  MAX_NOTE_LENGTH,
  EDITABLE_FIELDS,
  buildTicketDraft,
  applyPatch,
  confirmPurchase,
  voidTicket,
  canDeleteTicket,
  isEligibleForPrize,
  isCountedInStats,
  summarize,
  validateMultiple,
  validateCost,
  validateNote,
  validatePurchaseAt,
};

});

/* ===== shared/parsers/csv.js ===== */
__define("shared/parsers/csv.js", function(module, exports, require){
/**
 * 开奖数据 CSV 导入/导出（零依赖）。
 * 这是"官方接口不可用"时的长期兜底通道，不是临时补丁。
 * 模板见 data/samples/draws_template.csv。
 */

const { GAME, DRAW_STATUS, SPECIAL_RULE_STATUS } = require('../constants/games');
const { parseNumberList, parseMoney } = require('../adapters/cwl');

const HEADERS = [
  'game',
  'issue',
  'drawDate',
  'red',
  'blue',
  'kl8',
  'firstCount',
  'firstAmount',
  'secondCount',
  'secondAmount',
  'poolAmount',
  'sourceUrl',
  'note',
];

/** 解析 CSV 文本为二维数组，支持引号包裹、转义双引号、CRLF、BOM */
function parseCsv(text) {
  if (typeof text !== 'string') return [];
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // 忽略，等 \n
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 行对象 → 规范记录（保持与官方适配器一致的结构） */
function rowToRecord(row, options = {}) {
  const game = String(row.game || '').trim();
  const issue = String(row.issue || '').trim();
  const drawDate = String(row.drawDate || '').trim();

  const numbers =
    game === GAME.SSQ
      ? { red: parseNumberList(row.red), blue: parseNumberList(row.blue)[0] || null, kl8: [] }
      : { red: [], blue: null, kl8: parseNumberList(row.kl8) };

  const firstCount = parseMoney(row.firstCount);
  const firstAmount = parseMoney(row.firstAmount);
  const secondCount = parseMoney(row.secondCount);
  const secondAmount = parseMoney(row.secondAmount);

  const prizeInfo =
    game === GAME.SSQ
      ? {
          first: firstCount === null && firstAmount === null ? null : { count: firstCount, amount: firstAmount },
          second:
            secondCount === null && secondAmount === null ? null : { count: secondCount, amount: secondAmount },
          third: null,
          fourth: null,
          fifth: null,
          sixth: null,
          fuyun: null,
        }
      : {
          choose10: {
            hit10: firstCount === null && firstAmount === null ? null : { count: firstCount, amount: firstAmount },
            hit9: secondCount === null && secondAmount === null ? null : { count: secondCount, amount: secondAmount },
            hit8: null,
            hit7: null,
            hit6: null,
            hit5: null,
            hit0: null,
          },
        };

  return {
    game,
    issue,
    drawDate,
    numbers,
    prizeInfo,
    specialRuleStatus:
      game === GAME.SSQ ? SPECIAL_RULE_STATUS.UNKNOWN : SPECIAL_RULE_STATUS.NOT_APPLICABLE,
    ruleVersion: null,
    sourceUrl: String(row.sourceUrl || '').trim() || null,
    sourceType: options.sourceType || 'manual_official_import',
    sourceApi: null,
    rawHash: null,
    parserVersion: 'csv_import@1.0.0',
    drawStatus: DRAW_STATUS.PARSED,
    fetchedAt: options.fetchedAt || null,
    verifiedAt: null,
    salesAmount: null,
    poolAmount: parseMoney(row.poolAmount),
    fixedPoolAmount: null,
    note: String(row.note || '').trim(),
  };
}

/**
 * 解析 CSV → 记录数组 + 逐行错误
 * @param {string} text
 * @param {{validation?: Function, sourceType?: string, fetchedAt?: string}} options
 */
function parseDrawsCsv(text, options = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { records: [], errors: [{ line: 0, code: 'EMPTY_FILE', message: '文件为空' }], headerOk: false };
  }

  const header = rows[0].map((h) => String(h).trim());
  const missing = ['game', 'issue', 'drawDate'].filter((h) => !header.includes(h));
  if (missing.length) {
    return {
      records: [],
      errors: [{ line: 1, code: 'BAD_HEADER', message: `缺少必需列: ${missing.join(', ')}` }],
      headerOk: false,
    };
  }

  const records = [];
  const errors = [];
  for (let i = 1; i < rows.length; i += 1) {
    const raw = {};
    header.forEach((key, idx) => {
      raw[key] = rows[i][idx];
    });
    if (!raw.game || !raw.issue) {
      errors.push({ line: i + 1, code: 'ROW_INCOMPLETE', message: 'game / issue 不能为空' });
      continue;
    }
    const record = rowToRecord(raw, options);
    if (typeof options.validation === 'function') {
      const check = options.validation(record);
      if (!check.ok) {
        errors.push({ line: i + 1, code: check.code, message: check.message, issue: record.issue });
        continue;
      }
      records.push(check.normalized || record);
    } else {
      records.push(record);
    }
  }

  return { records, errors, headerOk: true };
}

/** 记录数组 → CSV 文本（用于导出/交接） */
function toDrawsCsv(records, options = {}) {
  const includePrize = options.includePrize !== false;
  const lines = [HEADERS.join(',')];
  for (const r of records || []) {
    const n = r.numbers || {};
    const p = r.prizeInfo || {};
    const first = (p.first || (p.choose10 && p.choose10.hit10)) || null;
    const second = (p.second || (p.choose10 && p.choose10.hit9)) || null;
    lines.push(
      [
        r.game,
        r.issue,
        r.drawDate,
        (n.red || []).join(','),
        n.blue === null || n.blue === undefined ? '' : n.blue,
        (n.kl8 || []).join(','),
        includePrize && first ? first.count : '',
        includePrize && first ? first.amount : '',
        includePrize && second ? second.count : '',
        includePrize && second ? second.amount : '',
        r.poolAmount === null || r.poolAmount === undefined ? '' : r.poolAmount,
        r.sourceUrl || '',
        r.note || '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { HEADERS, parseCsv, parseDrawsCsv, toDrawsCsv, rowToRecord };

});

/* ===== shared/adapters/cwl.js ===== */
__define("shared/adapters/cwl.js", function(module, exports, require){
/**
 * 中国福彩网开奖数据适配器（纯映射，不做网络请求）。
 *
 * 数据入口（2026-11-05 实测）：
 *   https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice
 *   —— 该接口由中国福彩网"往期开奖公告"页自身的前端脚本调用，返回 JSON。
 *
 * 实测要点（写入代码前已逐条验证，勿凭印象修改）：
 *   1. 往期公告页 HTML 不含号码，数据由上述接口异步加载（早期文档中"服务端渲染"的判断是错的）。
 *   2. 快乐8 会忽略 pageSize：不带 issueCount 时一次返回全部 2115 期（约 5.3MB）。
 *      因此所有查询必须显式带 issueCount 或 issueStart/issueEnd。
 *   3. 快乐8 的 pageNo 对分页无效，禁止依靠翻页遍历历史。
 *   4. 快乐8 选十"中 10"在无人中奖时返回 typenum="0"、typemoney="0"，
 *      这不代表单注奖金 0 元，必须映射为 null（浮动奖待官方公告）。
 *   5. 双色球一等奖存在单注封顶（实测 2026119 期为 2 注 × 10,000,000 元）。
 */

const { GAME, GAME_META, DRAW_STATUS, SPECIAL_RULE_STATUS } = require('../constants/games');
const { validateSsq, validateKl8 } = require('../validators/numbers');
const { isValidIssue } = require('../rules/registry');

const PARSER_VERSION = 'cwl_api@1.0.0';
const ENDPOINT = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice';
const DETAIL_BASE = 'https://www.cwl.gov.cn';

/** 业务上限：一次最多取多少期，防止误触发全量拉取 */
const MAX_ISSUE_COUNT = 100;

const CODE = {
  OK: 'OK',
  RAW_EMPTY: 'RAW_EMPTY',
  ISSUE_INVALID: 'ISSUE_INVALID',
  DATE_INVALID: 'DATE_INVALID',
  NUMBERS_INVALID: 'NUMBERS_INVALID',
  GAME_UNSUPPORTED: 'GAME_UNSUPPORTED',
};

/** "09,10,13" → [9,10,13]；空串 → [] */
function parseNumberList(text) {
  if (!text) return [];
  return String(text)
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map((s) => parseInt(s, 10));
}

/** 金额："9014860" / "74325672.00" / "" → number|null（不做任何估算） */
function parseMoney(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/** 开奖日期："2026-11-03(二)" → "2026-11-03" */
function parseDrawDate(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const dt = new Date(`${iso}T00:00:00+08:00`);
  if (Number.isNaN(dt.getTime())) return null;
  // 反向校验，拒绝 2026-02-31 这类被自动进位的日期
  const back = new Date(dt.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return back === iso ? iso : null;
}

/** 奖级注数与金额：注数为 0 时视为"该奖级无人中"，单注金额不可作数 */
function buildGrade(entry) {
  const count = entry && entry.typenum !== '' ? Number(entry.typenum) : null;
  const amount = parseMoney(entry && entry.typemoney);
  return {
    count: Number.isFinite(count) ? count : null,
    amount: Number.isFinite(count) && count > 0 ? amount : null,
  };
}

const SSQ_GRADE_LABEL = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth' };

/** 双色球奖级 → { first..sixth, fuyun } */
function mapSsqPrizeInfo(raw) {
  const info = { first: null, second: null, third: null, fourth: null, fifth: null, sixth: null, fuyun: null };
  for (const entry of raw.prizegrades || []) {
    const label = SSQ_GRADE_LABEL[Number(entry.type)];
    if (label) info[label] = buildGrade(entry);
  }
  const fuyunCount = parseMoney(raw.fyjCount);
  const fuyunMoney = parseMoney(raw.fyjMoney);
  if (fuyunMoney !== null) {
    info.fuyun = { count: fuyunCount, amount: fuyunMoney };
  }
  return info;
}

/** 快乐8：只保留选十（x10z*）奖级，其他玩法不入库 */
function mapKl8PrizeInfo(raw) {
  const hit = {};
  for (const entry of raw.prizegrades || []) {
    const type = String(entry.type || '');
    const m = type.match(/^x10z(\d+)$/);
    if (!m) continue;
    hit[m[1]] = buildGrade(entry);
  }
  return {
    choose10: {
      hit10: hit['10'] || null,
      hit9: hit['9'] || null,
      hit8: hit['8'] || null,
      hit7: hit['7'] || null,
      hit6: hit['6'] || null,
      hit5: hit['5'] || null,
      hit0: hit['0'] || null,
    },
  };
}

/**
 * 双色球福运奖状态。
 * 只有官方数据里明确带出福运奖金额时才认定 active；
 * 低于规则起始期号则 not_applicable；
 * 其余一律 unknown（转人工），除非显式打开"空字段视为未执行"的开关。
 */
function deriveSsqSpecialRule(raw, options) {
  const fuyunMoney = parseMoney(raw.fyjMoney);
  if (fuyunMoney !== null && fuyunMoney > 0) return SPECIAL_RULE_STATUS.ACTIVE;
  if (compareIssueSafe(raw.code, '2026014') < 0) return SPECIAL_RULE_STATUS.NOT_APPLICABLE;
  return options.fuyunEmptyMeansInactive
    ? SPECIAL_RULE_STATUS.INACTIVE
    : SPECIAL_RULE_STATUS.UNKNOWN;
}

function compareIssueSafe(a, b) {
  if (!isValidIssue(a) || !isValidIssue(b)) return 0;
  return Number(a) - Number(b);
}

/**
 * 单条原始记录 → 规范记录
 * @param {'ssq'|'kl8'} game
 * @param {object} raw 官方接口 result 数组中的一项
 * @param {{fuyunEmptyMeansInactive?: boolean, fetchedAt?: string}} options
 */
function mapRecord(game, raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: CODE.RAW_EMPTY, message: '原始记录为空' };
  }
  if (game !== GAME.SSQ && game !== GAME.KL8) {
    return { ok: false, code: CODE.GAME_UNSUPPORTED, message: '不支持的彩种' };
  }

  const issue = String(raw.code || '').trim();
  if (!isValidIssue(issue)) {
    return { ok: false, code: CODE.ISSUE_INVALID, message: `期号不合法: ${raw.code}` };
  }

  const drawDate = parseDrawDate(raw.date);
  if (!drawDate) {
    return { ok: false, code: CODE.DATE_INVALID, message: `开奖日期不合法: ${raw.date}` };
  }

  let numbers;
  if (game === GAME.SSQ) {
    const check = validateSsq(parseNumberList(raw.red), parseNumberList(raw.blue)[0]);
    if (!check.ok) {
      return { ok: false, code: CODE.NUMBERS_INVALID, message: `号码不合法: ${check.message}` };
    }
    numbers = check.normalized;
  } else {
    const check = validateKl8(parseNumberList(raw.red), { asDraw: true });
    if (!check.ok) {
      return { ok: false, code: CODE.NUMBERS_INVALID, message: `号码不合法: ${check.message}` };
    }
    numbers = check.normalized;
  }

  const detailsLink = raw.detailsLink ? `${DETAIL_BASE}${raw.detailsLink}` : null;

  return {
    ok: true,
    code: CODE.OK,
    record: {
      game,
      issue,
      drawDate,
      numbers,
      prizeInfo: game === GAME.SSQ ? mapSsqPrizeInfo(raw) : mapKl8PrizeInfo(raw),
      specialRuleStatus:
        game === GAME.SSQ
          ? deriveSsqSpecialRule(raw, options)
          : SPECIAL_RULE_STATUS.NOT_APPLICABLE,
      ruleVersion: null, // 由调用方按 issue 解析，采集器不赋值
      sourceUrl: detailsLink,
      sourceType: 'official_web',
      sourceApi: ENDPOINT,
      rawHash: null, // 由调用方对原始 JSON 计算
      parserVersion: PARSER_VERSION,
      drawStatus: DRAW_STATUS.PARSED,
      fetchedAt: options.fetchedAt || null,
      verifiedAt: null,
      salesAmount: parseMoney(raw.sales),
      poolAmount: parseMoney(raw.poolmoney),
      fixedPoolAmount: parseMoney(raw.gdjc),
      note: '',
    },
  };
}

/**
 * 构造官方接口查询 URL。
 * mode:
 *   incremental → issueCount 条最新
 *   issue       → issueStart/issueEnd 指定期号
 *   year        → 该年份全部（issueStart=YYYY001, issueEnd=YYYY999）
 */
function buildQueryUrl(params) {
  const { game, mode, issueStart, issueEnd, issueCount, pageNo } = params;
  const name = game === GAME.SSQ ? 'ssq' : game === GAME.KL8 ? 'kl8' : null;
  if (!name) throw new Error('不支持的彩种');

  const query = { name, pageNo: pageNo || 1, pageSize: 100, systemType: 'PC' };

  if (mode === 'page') {
    // 纯分页：不传 issueCount，靠 pageNo 往前翻（双色球支持，每页 100）
  } else if (mode === 'incremental') {
    const count = Math.min(Math.max(Number(issueCount) || 30, 1), MAX_ISSUE_COUNT);
    query.issueCount = count;
  } else if (mode === 'issue') {
    if (!isValidIssue(issueStart) || !isValidIssue(issueEnd || issueStart)) {
      throw new Error('期号区间不合法');
    }
    query.issueStart = issueStart;
    query.issueEnd = issueEnd || issueStart;
  } else if (mode === 'year') {
    const year = String(issueStart || '').slice(0, 4);
    if (!/^\d{4}$/.test(year)) throw new Error('年份不合法');
    query.issueStart = `${year}001`;
    query.issueEnd = `${year}999`;
  } else {
    throw new Error('未知的同步模式');
  }

  const qs = Object.keys(query)
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');
  return `${ENDPOINT}?${qs}`;
}

/** 校验官方响应外壳，避免把错误页当作数据 */
function assertResponseShape(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'BAD_RESPONSE', message: '响应不是合法 JSON 对象' };
  }
  if (Number(payload.state) !== 0) {
    return {
      ok: false,
      code: 'BAD_STATE',
      message: `接口返回异常状态: ${payload.state} ${payload.message || ''}`.trim(),
    };
  }
  if (!Array.isArray(payload.result)) {
    return { ok: false, code: 'NO_RESULT', message: '响应缺少 result 数组' };
  }
  return { ok: true, code: CODE.OK, count: payload.result.length };
}

/** 批量映射，逐条保留失败原因（不因一条坏数据丢弃整批） */
function mapRecords(game, list, options = {}) {
  const records = [];
  const errors = [];
  for (const raw of list || []) {
    const res = mapRecord(game, raw, options);
    if (res.ok) records.push(res.record);
    else errors.push({ issue: raw && raw.code, code: res.code, message: res.message });
  }
  return { records, errors };
}

/** 记录内容指纹：用于判断"同一条数据是否变过"（不含采集时间等易变字段） */
function contentSignature(record) {
  return JSON.stringify({
    game: record.game,
    issue: record.issue,
    drawDate: record.drawDate,
    numbers: record.numbers,
    prizeInfo: record.prizeInfo,
  });
}

module.exports = {
  ENDPOINT,
  PARSER_VERSION,
  MAX_ISSUE_COUNT,
  CODE,
  parseNumberList,
  parseMoney,
  parseDrawDate,
  mapRecord,
  mapRecords,
  mapSsqPrizeInfo,
  mapKl8PrizeInfo,
  deriveSsqSpecialRule,
  buildQueryUrl,
  assertResponseShape,
  contentSignature,
  GAME_META,
};

});

/* ===== web/js/ai.js ===== */
__define("web/js/ai.js", function(module, exports, require){
/**
 * Web 版 AI：浏览器直连 DeepSeek，Key 由用户自己在设置里填，只存本机。
 *
 * 复用关系（不复制任何判定逻辑）：
 *   - 提示词：shared/ai/prompt.js
 *   - 工具白名单与参数校验：shared/ai/tools.js
 *   - 工具执行器：shared/cloud/aiTools.js（通过 localdb 适配本地存储）
 *   - 调用编排：shared/ai/orchestrator.js
 *
 * 安全边界：Key 存在 localStorage，同源脚本与浏览器扩展理论上可读，
 * 因此界面必须明确告知，并提供「清除密钥」。绝不把 Key 写进任何提交里的文件。
 */

const { buildSystemPrompt, FINALIZE_INSTRUCTION, SYSTEM_PROMPT_VERSION } = require('../../shared/ai/prompt');
const { getToolSchemas } = require('../../shared/ai/tools');
const { runToolLoop } = require('../../shared/ai/orchestrator');
const { createExecutors } = require('../../shared/cloud/aiTools');
const {
  ENDPOINT,
  LIMITS,
  isAcceptableModel,
  buildRequestBody,
  parseCompletion,
  mapHttpError,
  validateUserMessage,
} = require('../../shared/ai/deepseek');
const { createLocalDb } = require('./localdb');

const KEY_STORAGE = 'jc:deepseek_key';
const MODEL_STORAGE = 'jc:deepseek_model';
const DEFAULT_MODEL = 'deepseek-flash';

function createAi(options = {}) {
  const {
    store,
    getGate = null,
    saveBatch = null,
    fetchImpl = typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = options;

  function readRaw(key) {
    if (!storage) return '';
    try {
      return storage.getItem(key) || '';
    } catch (err) {
      return '';
    }
  }

  function writeRaw(key, value) {
    if (!storage) throw Object.assign(new Error('当前浏览器禁止本地存储，无法保存密钥'), { code: 'NO_STORAGE' });
    try {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch (err) {
      throw Object.assign(new Error('写入本地存储失败（可能是隐私模式）'), { code: 'NO_STORAGE' });
    }
  }

  const getKey = () => readRaw(KEY_STORAGE).trim();
  const hasKey = () => getKey().length > 0;

  function setKey(raw) {
    const key = String(raw || '').trim();
    if (key.length < 20) {
      throw Object.assign(new Error('密钥看起来太短，请检查是否复制完整'), { code: 'BAD_KEY' });
    }
    writeRaw(KEY_STORAGE, key);
    return key;
  }

  const clearKey = () => writeRaw(KEY_STORAGE, null);

  function getModel() {
    const saved = readRaw(MODEL_STORAGE);
    return isAcceptableModel(saved) ? saved : DEFAULT_MODEL;
  }

  function setModel(name) {
    writeRaw(MODEL_STORAGE, isAcceptableModel(name) ? name : DEFAULT_MODEL);
  }

  async function callModel(messages, tools) {
    const key = getKey();
    if (!key) {
      throw Object.assign(new Error('还没有填写 DeepSeek 密钥'), { code: 'AI_NO_KEY' });
    }
    if (!fetchImpl) {
      throw Object.assign(new Error('当前环境不支持网络请求'), { code: 'AI_NO_FETCH' });
    }

    const body = buildRequestBody({ model: getModel(), messages, tools });
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw Object.assign(new Error('网络请求失败（可能是网络或跨域限制）'), { code: 'AI_NETWORK' });
    }

    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        text = '';
      }
      const mapped = mapHttpError(res.status, text);
      throw Object.assign(new Error(mapped.message), { code: mapped.code });
    }

    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      throw Object.assign(new Error('AI 返回不是合法 JSON'), { code: 'BAD_RESPONSE' });
    }

    const parsed = parseCompletion(payload);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.message), { code: parsed.code });
    }
    return { content: parsed.content, toolCalls: parsed.toolCalls, usage: parsed.usage };
  }

  /**
   * @param {{history?: Array, message: string}} input
   */
  async function chat(input) {
    const checked = validateUserMessage(input && input.message);
    if (!checked.ok) {
      throw Object.assign(new Error(checked.message), { code: 'BAD_MESSAGE' });
    }
    if (!hasKey()) {
      throw Object.assign(new Error('还没有填写 DeepSeek 密钥，请先在下方粘贴并保存'), { code: 'AI_NO_KEY' });
    }

    // 闸门状态每次都现读：用户刚在「选号」页关掉，下一步对话就必须拿不到生成工具
    let gate = null;
    try {
      gate = getGate ? await getGate() : null;
    } catch (err) {
      gate = null;
    }
    const futureNumbers = !!(gate && gate.aiFutureNumber);

    const history = Array.isArray(input.history) ? input.history.slice(-LIMITS.historyMessages) : [];
    const messages = [
      { role: 'system', content: buildSystemPrompt({ futureNumbers }) },
      ...history
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text)
        .map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: checked.value },
    ];

    const executors = createExecutors({
      db: createLocalDb(store),
      openid: 'local',
      gate: { futureNumbers, complianceState: gate ? gate.complianceState : null },
      saveBatch,
    });
    const out = await runToolLoop({
      messages,
      toolSchemas: getToolSchemas({ futureNumbers }),
      callModel,
      executeTool: (name, args) => executors.execute(name, args),
      finalizeInstruction: FINALIZE_INSTRUCTION,
    });

    return {
      reply: (out.finalText || '').slice(0, 4000),
      toolCalls: out.toolCalls.map((t) => ({ name: t.name, ok: t.ok })),
      rounds: out.rounds,
      stoppedReason: out.stoppedReason,
      usage: out.usage || null,
      promptVersion: SYSTEM_PROMPT_VERSION,
    };
  }

  /** 用一条极短的请求验证密钥是否可用 */
  async function verifyKey() {
    if (!hasKey()) {
      return { ok: false, code: 'AI_NO_KEY', message: '还没有填写密钥' };
    }
    try {
      const res = await callModel(
        [
          { role: 'system', content: '只回复"ok"两个字符。' },
          { role: 'user', content: 'ping' },
        ],
        null
      );
      return { ok: true, reply: (res.content || '').slice(0, 20), model: getModel() };
    } catch (err) {
      return { ok: false, code: err.code || 'AI_ERROR', message: err.message };
    }
  }

  return { getKey, hasKey, setKey, clearKey, getModel, setModel, chat, verifyKey, callModel };
}

module.exports = { createAi, KEY_STORAGE, MODEL_STORAGE, DEFAULT_MODEL, ENDPOINT };

});

/* ===== shared/ai/prompt.js ===== */
__define("shared/ai/prompt.js", function(module, exports, require){
/**
 * AI 系统提示词（版本化，服务端维护）。
 * 改动必须升 SYSTEM_PROMPT_VERSION，并在 docs/phase-6-report.md 记录原因。
 *
 * 原则：模型只是"解释器"，事实一律来自工具返回；不许编数据、不许宣称能提升中奖机会。
 */

const SYSTEM_PROMPT_VERSION = 'ai_system@1.3.0';

const RULES = [
  '你是「竞彩助手」的个人数据分析助手，不是彩票发行机构，也不是选号专家。',
  '所有事实性内容（期号、开奖号码、奖金、中奖等级、个人记录、统计口径）必须来自工具返回值；工具没给的，就说没有。',
  '绝对不要编造期号、开奖号码、奖级、奖金金额、历史统计或个人购买记录。',
  '历史开奖是随机事件的历史样本。不得声称历史冷热、遗漏、AI 或任何方法能提升中奖机会。',
  '用户问最新开奖时，必须调用 get_latest_draw；若返回为空或未核验，明确说明"本地尚未同步/核验"，并给出最后一次同步时间。',
  '中奖等级与奖金只能引用 get_ticket_check 或 get_rule_info 的结果，不得自行推断或按比例估算。',
  '若工具返回 pending_manual_review 或 pendingReason，如实说明"待人工核验"及原因，不要给出结论金额。',
  '所有数值分析要说明时间范围与样本数（例如"近 30 期"）。',
  '只服务当前用户本人的记录；不要假设或询问他人的数据。',
  '回答用简体中文，简洁、分点；不写营销话术，不做收益承诺。',
];

/** 闸门关闭时的规则：不给任何未来期号码，连"文本形式"都不给 */
const DISABLED_RULE =
  '当前候选号码/未来号码功能未开放。若未开放，明确告知不可用，不要以文本形式给出任何未来期号码组合。';

/** 闸门开启时的规则：号码只能原样引用工具结果，且必须带上"不代表更容易中奖" */
const FUTURE_RULES = [
  '候选号码功能当前已开启。只有用户明确要求"给我几注/生成号码/分析选号"时，才调用 generate_candidates；号码必须原样引用工具返回的 displayText，不得改动、补号或重新排序。',
  '给出号码时必须同时说明：中奖概率与任何选号方式完全相同；候选不是已购买，导入后仍是草稿。',
  '用户要求"分析选号"时，用 strategy=analyzed，并把他的自然语言翻成 analysis 权重（例如"别要生日号"→ avoidPatterns/降低 1–31 占比；"别跟上期重样"→ avoidRepeat；"带个冷门号"→ includeCold 1–2；"和值别太极端"→ sumRange）。只能用工具 schema 里列出的字段，不要自造参数名。',
  '解释分析时，必须讲清它改变的是什么：双色球一/二等奖、快乐8选十中十是**浮动奖，按中奖注数均分**，避开大众号只影响"万一中了会不会被很多人分"；三等奖及以下是固定奖金，不受影响。',
  '拥挤度是基于公开研究（生日偏好、幸运号、连号/等差偏好）的**推定值**，不得说成"实测有多少人买了这组号"，也不得给出虚构的中奖人数或奖金。',
  '也不得说"更可能出""该补冷号""回补"；冷号只能被描述为"大众较少选的号"，不是"该开的号"。',
  '提到历史统计或冷号时，必须说明用了多少期（工具返回的 sampleSize）；若 dataSufficient 为 false，必须明确指出"本地样本不足，判断会偏粗"，并建议先同步更多开奖数据。',
  '即使 get_number_stats 显示某些号码出现更多或更少，也不得说"这些号更可能出"，只能如实陈述统计与样本量。',
];

/**
 * @param {{today?: string, futureNumbers?: boolean}} [options]
 */
function buildSystemPrompt(options = {}) {
  const date = options.today || new Date().toISOString().slice(0, 10);
  const rules = options.futureNumbers ? RULES.concat(FUTURE_RULES) : RULES.concat([DISABLED_RULE]);
  return [`今天是 ${date}（Asia/Shanghai）。`, ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n');
}

/** 触发"轮次超限"时给模型的收尾指令（不带工具再请求一次） */
const FINALIZE_INSTRUCTION =
  '已达到工具调用轮次上限。请仅基于上面已获得的数据作答；数据不足时直接说明缺少什么，不要再次请求工具，也不要编造。';

/** 工具未开放时的统一说明，避免模型自由发挥 */
const FEATURE_DISABLED_TEXT =
  '候选号码与未来号码相关功能当前未开启，因此我无法提供任何未来期号码组合。可以帮你查历史开奖、你自己的号码记录、规则与统计；需要生成时请到「选号」页开启。';

module.exports = {
  SYSTEM_PROMPT_VERSION,
  RULES,
  FUTURE_RULES,
  DISABLED_RULE,
  FINALIZE_INSTRUCTION,
  FEATURE_DISABLED_TEXT,
  buildSystemPrompt,
};

});

/* ===== shared/ai/tools.js ===== */
__define("shared/ai/tools.js", function(module, exports, require){
/**
 * AI 工具白名单（只读）。
 *
 * 设计约束（对应主方案 13.3）：
 *   - 只有查询能力：查开奖、查我的记录、查统计、查规则、查核对结果。
 *   - 不接受模型传入用户标识：ownerOpenId 一律由服务端从运行上下文注入。
 *   - 参数全部做白名单式校验，越界直接拒绝，不"尽量理解"。
 *   - 不提供任何写库、删库、改奖级、改开奖数据的能力。
 */

const { GAME, GAME_META, PURCHASE_STATUS } = require('../constants/games');
const { isValidIssue } = require('../rules/registry');
const { STRATEGY } = require('../domain/candidates');

const TOOL_NAMES = [
  'get_latest_draw',
  'get_draws',
  'get_my_tickets',
  'get_my_ticket_stats',
  'get_number_stats',
  'get_ticket_check',
  'get_rule_info',
];

/** 默认不注册的工具：只有候选/未来号码闸门开启时才允许模型看到它 */
const GATED_TOOL_NAMES = ['generate_candidates'];

const CODE = {
  OK: 'OK',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  BAD_ARGS: 'BAD_ARGS',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
};

const GAMES = [GAME.SSQ, GAME.KL8];
const WINDOWS = [30, 50, 100];

function clampLimit(value, fallback = 5, max = 20) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), 1), max);
}

function requireGame(raw) {
  if (!GAMES.includes(raw.game)) {
    return { ok: false, message: 'game 必须是 ssq 或 kl8' };
  }
  return { ok: true, game: raw.game };
}

const TOOLS = {
  get_latest_draw: {
    description: '查询指定彩种最新一期「已核验」的开奖结果，含号码、各奖级注数与单注金额、来源与核验时间。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES, description: 'ssq=双色球；kl8=快乐8' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      return { ok: true, args: { game: g.game } };
    },
  },

  get_draws: {
    description: '按期号或最近期数查询已核验的开奖记录（最多 20 期），用于对比或复盘。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        issue: { type: 'string', description: '7 位期号，例如 2026126' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回期数，默认 5' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      const args = { game: g.game, limit: clampLimit(raw.limit, 5) };
      if (raw.issue !== undefined && raw.issue !== null && raw.issue !== '') {
        const issue = String(raw.issue);
        if (!isValidIssue(issue)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'issue 必须是 7 位数字期号' };
        }
        args.issue = issue;
      }
      return { ok: true, args };
    },
  },

  get_my_tickets: {
    description: '查询当前用户本人的号码记录（草稿/已购买/已作废），可按彩种与状态过滤。用户身份由服务端注入，不得传入。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        status: { type: 'string', enum: Object.values(PURCHASE_STATUS) },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '默认 10' },
      },
      required: [],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      const args = { limit: clampLimit(src.limit, 10) };
      if (src.game !== undefined && src.game !== null && src.game !== '') {
        if (!GAMES.includes(src.game)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'game 必须是 ssq 或 kl8' };
        }
        args.game = src.game;
      }
      if (src.status !== undefined && src.status !== null && src.status !== '') {
        if (!Object.values(PURCHASE_STATUS).includes(src.status)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'status 必须是 draft/confirmed/void' };
        }
        args.status = src.status;
      }
      return { ok: true, args };
    },
  },

  get_my_ticket_stats: {
    description: '汇总当前用户本人的号码记录：各状态数量、已购买注数、录入金额合计、中奖笔数与奖金合计（奖金来自核对结果）。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
      },
      required: [],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      if (src.game !== undefined && src.game !== null && src.game !== '') {
        if (!GAMES.includes(src.game)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'game 必须是 ssq 或 kl8' };
        }
        return { ok: true, args: { game: src.game } };
      }
      return { ok: true, args: {} };
    },
  },

  get_number_stats: {
    description: '按最近 N 期已核验开奖统计号码出现频次与当前遗漏期数。这是描述性统计，不代表未来倾向。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        window: { type: 'integer', enum: WINDOWS, description: '统计窗口（期数），默认 30' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      let window = 30;
      if (raw.window !== undefined) {
        const w = Number(raw.window);
        if (!WINDOWS.includes(w)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'window 只能是 30 / 50 / 100 / 200 / 300 / 1000 / 3000' };
        }
        window = w;
      }
      return { ok: true, args: { game: g.game, window } };
    },
  },

  get_ticket_check: {
    description: '查询某条个人号码记录的核对结果（命中号码、奖级、单注与总奖金、是否待人工核验）。',
    parameters: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: '记录 ID' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      if (typeof src.ticketId !== 'string' || !src.ticketId || src.ticketId.length > 64) {
        return { ok: false, code: CODE.BAD_ARGS, message: 'ticketId 不合法' };
      }
      return { ok: true, args: { ticketId: src.ticketId } };
    },
  },

  generate_candidates: {
    description:
      '按策略生成候选号码组合（1–5 注，组间不重复）。strategy=analyzed 时按"拥挤度最低"挑选（避开生日区扎堆、连号等差、上期重号，可要求带冷号），这只影响浮动奖被均分的风险，不改变中奖概率。号码由确定性算法产生，只能原样转述，不得改写或补充。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        strategy: {
          type: 'string',
          enum: [STRATEGY.RANDOM, STRATEGY.PREFERENCE, STRATEGY.ANALYZED],
          description:
            'random=随机；preference=偏好约束；analyzed=分析选号（结构合格前提下挑拥挤度最低）',
        },
        count: { type: 'integer', minimum: 1, maximum: 5, description: '注数，默认 3' },
        targetIssue: { type: 'string', description: '目标期号（7 位），可留空' },
        seed: { type: 'string', description: '随机种子；不传则自动生成并回传' },
        include: {
          type: 'array',
          items: { type: 'integer' },
          description: '必含号码（仅 preference 策略使用）',
        },
        exclude: {
          type: 'array',
          items: { type: 'integer' },
          description: '排除号码（仅 preference 策略使用）',
        },
        analysis: {
          type: 'object',
          description:
            '分析权重，仅 strategy=analyzed 生效。用户说"别要生日号"就开 avoidBirthday 类约束（由 avoidPatterns/avoidRepeat 覆盖）；说"带几个冷门号"就调 includeCold。不要自己发明权重名。',
          properties: {
            avoidPatterns: {
              type: 'boolean',
              description: '避开连号≥2 对、等差、同尾≥2 对的组合（默认 true）',
            },
            avoidRepeat: { type: 'boolean', description: '不包含上一期开出的号码（默认 true）' },
            includeCold: {
              type: 'integer',
              minimum: 0,
              maximum: 2,
              description: '每注至少包含几个近 30 期未出现的号码（默认 0）',
            },
            maxCrowdIndex: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: '可接受的拥挤度上限（越低越冷门，默认 92）',
            },
            window: {
              type: 'integer',
              enum: [30, 50, 100, 200, 300, 1000, 3000],
              description: '统计窗口（期数），用于冷号与上期重号判定，默认 30',
            },
            sumRange: {
              type: 'array',
              items: { type: 'integer' },
              minItems: 2,
              maxItems: 2,
              description: '和值区间 [最小, 最大]',
            },
            oddRange: {
              type: 'array',
              items: { type: 'integer' },
              minItems: 2,
              maxItems: 2,
              description: '奇数个数区间 [最小, 最大]',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const src = raw || {};
      const g = requireGame(src);
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };

      const strategy = src.strategy || STRATEGY.RANDOM;
      // balanced 已停用（D28）：界面不给、AI 也不给，只有历史批次还能显示
      if (![STRATEGY.RANDOM, STRATEGY.PREFERENCE, STRATEGY.ANALYZED].includes(strategy)) {
        return {
          ok: false,
          code: CODE.BAD_ARGS,
          message: 'strategy 只能是 random / preference / analyzed',
        };
      }

      const count = src.count === undefined || src.count === null ? 3 : Number(src.count);
      if (!Number.isInteger(count) || count < 1 || count > 5) {
        return { ok: false, code: CODE.BAD_ARGS, message: 'count 需为 1–5 的整数' };
      }

      const args = { game: g.game, strategy, count };

      if (src.targetIssue !== undefined && src.targetIssue !== null && src.targetIssue !== '') {
        const issue = String(src.targetIssue);
        if (!isValidIssue(issue)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'targetIssue 必须是 7 位数字期号' };
        }
        args.targetIssue = issue;
      }

      if (src.seed !== undefined && src.seed !== null && src.seed !== '') {
        if (typeof src.seed !== 'string' && typeof src.seed !== 'number') {
          return { ok: false, code: CODE.BAD_ARGS, message: 'seed 只支持字符串或数字' };
        }
        args.seed = String(src.seed).slice(0, 64);
      }

      const meta = GAME_META[g.game];
      const lo = g.game === GAME.SSQ ? meta.redMin : meta.min;
      const hi = g.game === GAME.SSQ ? meta.redMax : meta.max;
      const need = g.game === GAME.SSQ ? meta.redCount : meta.count;

      for (const key of ['include', 'exclude']) {
        if (src[key] === undefined || src[key] === null) continue;
        if (!Array.isArray(src[key])) {
          return { ok: false, code: CODE.BAD_ARGS, message: `${key} 必须是数字数组` };
        }
        const limit = key === 'include' ? need : 30;
        if (src[key].length > limit) {
          return { ok: false, code: CODE.BAD_ARGS, message: `${key} 最多 ${limit} 个号码` };
        }
        for (const n of src[key]) {
          if (!Number.isInteger(n) || n < lo || n > hi) {
            return { ok: false, code: CODE.BAD_ARGS, message: `${key} 里的号码需在 ${lo}–${hi}` };
          }
        }
        args[key] = src[key].slice();
      }

      if (src.analysis !== undefined && src.analysis !== null) {
        if (typeof src.analysis !== 'object' || Array.isArray(src.analysis)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'analysis 必须是对象' };
        }
        const a = src.analysis;
        const clean = {};
        for (const key of ['avoidPatterns', 'avoidRepeat']) {
          if (a[key] !== undefined) {
            if (typeof a[key] !== 'boolean') {
              return { ok: false, code: CODE.BAD_ARGS, message: `${key} 必须是布尔值` };
            }
            clean[key] = a[key];
          }
        }
        for (const key of ['includeCold', 'maxCrowdIndex']) {
          if (a[key] !== undefined) {
            const n = Number(a[key]);
            if (!Number.isInteger(n) || n < 0 || n > (key === 'includeCold' ? 2 : 100)) {
              return { ok: false, code: CODE.BAD_ARGS, message: `${key} 超出允许范围` };
            }
            clean[key] = n;
          }
        }
        if (a.window !== undefined) {
          const w = Number(a.window);
          if (![30, 50, 100, 200, 300, 1000, 3000].includes(w)) {
            return { ok: false, code: CODE.BAD_ARGS, message: 'window 只能是 30 / 50 / 100 / 200 / 300 / 1000 / 3000' };
          }
          clean.window = w;
        }
        for (const key of ['sumRange', 'oddRange']) {
          if (a[key] !== undefined) {
            if (!Array.isArray(a[key]) || a[key].length !== 2) {
              return { ok: false, code: CODE.BAD_ARGS, message: `${key} 必须是长度为 2 的数组` };
            }
            const pair = a[key].map(Number);
            if (!pair.every((n) => Number.isInteger(n)) || pair[0] > pair[1]) {
              return { ok: false, code: CODE.BAD_ARGS, message: `${key} 需要 [最小, 最大] 且最小 ≤ 最大` };
            }
            clean[key] = pair;
          }
        }
        args.analysis = clean;
      }

      return { ok: true, args };
    },
  },

  get_rule_info: {
    description: '查询某彩种某期适用的规则版本、奖级表与来源（用于解释规则变化，例如快乐8 新旧规则奖金差异）。',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', enum: GAMES },
        issue: { type: 'string', description: '7 位期号；不传则返回当前生效版本' },
      },
      required: ['game'],
      additionalProperties: false,
    },
    validate(raw) {
      const g = requireGame(raw || {});
      if (!g.ok) return { ok: false, code: CODE.BAD_ARGS, message: g.message };
      const args = { game: g.game };
      if (raw.issue !== undefined && raw.issue !== null && raw.issue !== '') {
        const issue = String(raw.issue);
        if (!isValidIssue(issue)) {
          return { ok: false, code: CODE.BAD_ARGS, message: 'issue 必须是 7 位数字期号' };
        }
        args.issue = issue;
      }
      return { ok: true, args };
    },
  },
};

/**
 * 发给模型的 function schema 列表（不含 validate）。
 * @param {{futureNumbers?: boolean}} [options] 候选/未来号码闸门是否开启
 */
function getToolSchemas(options = {}) {
  const names = options.futureNumbers ? TOOL_NAMES.concat(GATED_TOOL_NAMES) : TOOL_NAMES;
  return names.map((name) => ({
    type: 'function',
    function: {
      name,
      description: TOOLS[name].description,
      parameters: TOOLS[name].parameters,
    },
  }));
}

/**
 * 校验工具名与参数；拒绝一切未列入白名单的调用。
 * 闸门关闭时，即使模型凭空调用 generate_candidates 也会被这里拦下（不靠提示词）。
 * @param {{futureNumbers?: boolean}} [options]
 */
function validateToolCall(name, rawArgs, options = {}) {
  if (GATED_TOOL_NAMES.includes(name) && options.futureNumbers !== true) {
    return {
      ok: false,
      code: CODE.FEATURE_DISABLED,
      message: '候选号码功能当前未开启，无法生成号码组合',
    };
  }
  if (!TOOL_NAMES.includes(name) && !GATED_TOOL_NAMES.includes(name)) {
    return { ok: false, code: CODE.UNKNOWN_TOOL, message: `工具 ${name} 不在允许列表内` };
  }
  let parsed = rawArgs;
  if (typeof rawArgs === 'string') {
    try {
      parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (err) {
      return { ok: false, code: CODE.BAD_ARGS, message: '工具参数不是合法 JSON' };
    }
  }
  return TOOLS[name].validate(parsed || {});
}

module.exports = { TOOL_NAMES, GATED_TOOL_NAMES, CODE, TOOLS, getToolSchemas, validateToolCall };

});

/* ===== shared/ai/orchestrator.js ===== */
__define("shared/ai/orchestrator.js", function(module, exports, require){
/**
 * 工具调用编排（纯逻辑，不碰网络/数据库，便于用假模型测试）。
 *
 * 约束：
 *   - 最多 maxRounds 轮模型调用；每轮最多执行 maxToolCallsPerRound 个工具；总量上限 maxTotalToolCalls。
 *   - 工具名与参数由 shared/ai/tools.js 校验；执行异常不抛出，转成工具结果回给模型。
 *   - 轮次用尽后再请求一次（不带工具）拿最终答复，避免用户收到空回复。
 */

const DEFAULT_LIMITS = { maxRounds: 3, maxToolCallsPerRound: 4, maxTotalToolCalls: 8 };

/**
 * @param {object} options
 * @param {Array} options.messages 初始消息（含 system）
 * @param {Array} options.toolSchemas 工具 schema 列表
 * @param {(messages:Array, tools:Array|null) => Promise<{content?:string, toolCalls?:Array, usage?:object}>} options.callModel
 * @param {(name:string, args:any) => Promise<object>} options.executeTool 返回可 JSON 化的对象；约定 ok:false 表示业务拒绝
 * @param {string} [options.finalizeInstruction]
 */
async function runToolLoop(options) {
  const {
    messages,
    toolSchemas,
    callModel,
    executeTool,
    maxRounds = DEFAULT_LIMITS.maxRounds,
    maxToolCallsPerRound = DEFAULT_LIMITS.maxToolCallsPerRound,
    maxTotalToolCalls = DEFAULT_LIMITS.maxTotalToolCalls,
    finalizeInstruction = '已达到工具调用上限，请仅基于已获得的数据作答。',
  } = options;

  const convo = (messages || []).slice();
  const executed = [];
  let rounds = 0;
  let usage = null;

  for (let round = 0; round < maxRounds; round += 1) {
    rounds += 1;
    const res = (await callModel(convo, toolSchemas)) || {};
    usage = res.usage || usage;
    const calls = Array.isArray(res.toolCalls) ? res.toolCalls : [];

    if (calls.length === 0) {
      const finalText = typeof res.content === 'string' ? res.content : '';
      convo.push({ role: 'assistant', content: finalText });
      return {
        ok: true,
        finalText,
        messages: convo,
        toolCalls: executed,
        rounds,
        stoppedReason: null,
        usage,
      };
    }

    convo.push({
      role: 'assistant',
      content: typeof res.content === 'string' ? res.content : '',
      tool_calls: calls.map((c) => ({
        id: c.id || `call_${executed.length}_${c.name}`,
        type: 'function',
        function: {
          name: c.name,
          arguments:
            typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {}),
        },
      })),
    });

    for (const call of calls.slice(0, maxToolCallsPerRound)) {
      if (executed.length >= maxTotalToolCalls) {
        convo.push({
          role: 'tool',
          tool_call_id: call.id || `call_${executed.length}_${call.name}`,
          content: JSON.stringify({ ok: false, code: 'TOOL_BUDGET_EXCEEDED', message: '本次对话工具调用次数已达上限' }),
        });
        continue;
      }

      let payload;
      try {
        const out = await executeTool(call.name, call.arguments);
        payload = out && typeof out === 'object' ? out : { ok: true, data: out };
      } catch (err) {
        payload = { ok: false, code: 'TOOL_ERROR', message: String((err && err.message) || err).slice(0, 200) };
      }

      executed.push({ name: call.name, args: call.arguments, ok: payload.ok !== false });
      convo.push({
        role: 'tool',
        tool_call_id: call.id || `call_${executed.length}_${call.name}`,
        content: JSON.stringify(payload),
      });
    }
  }

  // 轮次用尽：不带工具再要一次总结
  convo.push({ role: 'system', content: finalizeInstruction });
  const last = (await callModel(convo, null)) || {};
  const finalText = typeof last.content === 'string' ? last.content : '';
  convo.push({ role: 'assistant', content: finalText });

  return {
    ok: true,
    finalText,
    messages: convo,
    toolCalls: executed,
    rounds: rounds + 1,
    stoppedReason: 'TOOL_ROUND_LIMIT',
    usage: last.usage || usage,
  };
}

module.exports = { runToolLoop, DEFAULT_LIMITS };

});

/* ===== shared/cloud/aiTools.js ===== */
__define("shared/cloud/aiTools.js", function(module, exports, require){
/**
 * AI 工具执行器（仅云端）。
 *
 * 铁律：ownerOpenId 只从运行上下文来，任何工具参数都不能指定用户。
 * 返回结构统一为 { ok, ... }，ok:false 表示业务上无法回答（找不到/未核验/未开放），
 * 由模型向用户如实说明，而不是编造。
 */

const { GAME, GAME_META, PURCHASE_STATUS } = require('../constants/games');
const { resolveRuleVersion } = require('../rules/registry');
const { validateToolCall } = require('../ai/tools');
const { generateCandidates } = require('../domain/candidates');

const DRAWS = 'draw_records';
const TICKETS = 'ticket_records';
const CHECKS = 'ticket_checks';
const LOGS = 'sync_logs';

const JUDGEABLE = ['verified', 'corrected'];

function stripPrivate(row) {
  const { ownerOpenId, ...rest } = row;
  return rest;
}

function summaryOfDraw(d) {
  return {
    issue: d.issue,
    drawDate: d.drawDate,
    numbers: d.numbers,
    prizeInfo: d.prizeInfo,
    specialRuleStatus: d.specialRuleStatus,
    drawStatus: d.drawStatus,
    sourceUrl: d.sourceUrl,
    verifiedAt: d.verifiedAt,
    ruleVersion: d.ruleVersion,
  };
}

async function latestSync(db) {
  try {
    const res = await db.collection(LOGS).orderBy('createdAt', 'desc').limit(1).get();
    const log = (res.data && res.data[0]) || null;
    if (!log) return null;
    return { finishedAt: log.finishedAt || log.createdAt, status: log.status, game: log.game };
  } catch (err) {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.db 云数据库或本地适配器
 * @param {string} options.openid 服务端注入，工具参数无法指定
 * @param {{futureNumbers?: boolean, complianceState?: string}} [options.gate] 候选闸门状态
 * @param {(batch:object)=>Promise<object>} [options.saveBatch] 可选：生成后落库（留痕）
 */
function createExecutors({ db, openid, now = () => new Date(), gate = null, saveBatch = null }) {
  const gateOptions = { futureNumbers: !!(gate && gate.futureNumbers) };
  const draws = db.collection(DRAWS);
  const tickets = db.collection(TICKETS);
  const checks = db.collection(CHECKS);

  async function findDraw(game, issue) {
    const res = await draws.where({ game, issue }).limit(1).get();
    return (res.data && res.data[0]) || null;
  }

  async function recentDraws(game, want) {
    // 多取一些再过滤状态，避免依赖 _.in
    const res = await draws.where({ game }).orderBy('issue', 'desc').limit(want * 3).get();
    return (res.data || []).filter((d) => JUDGEABLE.includes(d.drawStatus)).slice(0, want);
  }

  const handlers = {
    async get_latest_draw(args) {
      const list = await recentDraws(args.game, 1);
      const sync = await latestSync(db);
      if (!list.length) {
        return {
          ok: false,
          code: 'NO_VERIFIED_DRAW',
          message: '本地暂无该彩种的已核验开奖数据',
          lastSync: sync,
          hint: '可让用户在「开奖」页点击「同步最新」，或使用 CSV 导入。',
        };
      }
      return { ok: true, game: args.game, draw: summaryOfDraw(list[0]), lastSync: sync };
    },

    async get_draws(args) {
      if (args.issue) {
        const one = await findDraw(args.game, args.issue);
        if (!one || !JUDGEABLE.includes(one.drawStatus)) {
          return {
            ok: false,
            code: 'NOT_FOUND',
            message: `本地没有 ${args.game} 第 ${args.issue} 期的已核验数据`,
          };
        }
        return { ok: true, game: args.game, count: 1, draws: [summaryOfDraw(one)] };
      }
      const list = await recentDraws(args.game, args.limit || 5);
      if (!list.length) {
        return { ok: false, code: 'NO_VERIFIED_DRAW', message: '本地暂无该彩种的已核验开奖数据' };
      }
      return { ok: true, game: args.game, count: list.length, draws: list.map(summaryOfDraw) };
    },

    async get_my_tickets(args) {
      const where = { ownerOpenId: openid };
      if (args.game) where.game = args.game;
      if (args.status) where.purchaseStatus = args.status;

      const res = await tickets.where(where).orderBy('createdAt', 'desc').limit(args.limit || 10).get();
      const rows = res.data || [];
      const countRes = await tickets.where(where).count();

      return {
        ok: true,
        total: countRes.total || 0,
        returned: rows.length,
        filter: { game: args.game || 'all', status: args.status || 'all' },
        tickets: rows.map((t) => ({
          id: t._id,
          game: t.game,
          issue: t.issue,
          displayText: t.displayText,
          purchaseStatus: t.purchaseStatus,
          actualCost: t.actualCost === undefined ? null : t.actualCost,
          multiple: t.multiple,
          checkSummary: t.checkSummary || null,
          createdAt: t.createdAt,
        })),
        note: rows.length < (countRes.total || 0) ? '仅返回最近若干条，未列出全部' : '已列出全部匹配记录',
      };
    },

    async get_my_ticket_stats(args) {
      const scope = { ownerOpenId: openid };
      if (args.game) scope.game = args.game;

      const counts = {};
      for (const status of Object.values(PURCHASE_STATUS)) {
        const res = await tickets.where({ ...scope, purchaseStatus: status }).count();
        counts[status] = res.total || 0;
      }

      const confirmedRes = await tickets
        .where({ ...scope, purchaseStatus: PURCHASE_STATUS.CONFIRMED })
        .limit(500)
        .get();
      const confirmed = confirmedRes.data || [];

      let totalCost = 0;
      let missingCost = 0;
      for (const t of confirmed) {
        if (typeof t.actualCost === 'number') totalCost += t.actualCost;
        else missingCost += 1;
      }

      // 奖金只认核对结果，不读 checkSummary 的金额做统计口径（D16）
      const checkRes = await checks.where(scope).limit(500).get();
      const checkRows = checkRes.data || [];
      const latestByTicket = new Map();
      for (const c of checkRows) {
        const prev = latestByTicket.get(c.ticketId);
        if (!prev || String(c.checkedAt) > String(prev.checkedAt)) latestByTicket.set(c.ticketId, c);
      }

      const confirmedIds = new Set(confirmed.map((t) => t._id));
      let winners = 0;
      let totalPrize = 0;
      let pendingReview = 0;
      let recordsWithCheck = 0;

      for (const [ticketId, c] of latestByTicket) {
        if (!confirmedIds.has(ticketId)) continue;
        recordsWithCheck += 1;
        if (c.checkStatus === 'pending_manual_review') pendingReview += 1;
        if (c.isWinner) {
          winners += 1;
          if (typeof c.totalPrize === 'number') totalPrize += c.totalPrize;
        }
      }

      return {
        ok: true,
        scope: { game: args.game || 'all' },
        counts,
        purchased: {
          tickets: counts.confirmed,
          totalCost,
          missingCostTickets: missingCost,
          costNote:
            missingCost > 0
              ? `有 ${missingCost} 张已购买记录未填写实际金额，合计金额仅统计已填写的部分`
              : '金额为用户录入的实际支付额',
        },
        winnings: {
          recordsWithCheck,
          winners,
          totalPrize,
          pendingReview,
          prizeNote: '奖金来自核对结果；待人工核验或待官方公告的金额未计入合计',
        },
      };
    },

    async get_number_stats(args) {
      const window = args.window || 30;
      const list = await recentDraws(args.game, window);
      if (!list.length) {
        return { ok: false, code: 'NO_VERIFIED_DRAW', message: '本地暂无已核验开奖数据，无法统计' };
      }

      const meta = GAME_META[args.game];
      const isSsq = args.game === GAME.SSQ;
      const pick = (d) => (isSsq ? { red: d.numbers.red || [], blue: [d.numbers.blue] } : { red: d.numbers.kl8 || [], blue: [] });

      // list 已按 issue 降序
      const appearRed = new Map();
      const appearBlue = new Map();
      const omissionRed = new Map();
      const omissionBlue = new Map();

      list.forEach((d, idx) => {
        const picked = pick(d);
        for (const n of picked.red) {
          appearRed.set(n, (appearRed.get(n) || 0) + 1);
          if (!omissionRed.has(n)) omissionRed.set(n, idx);
        }
        for (const n of picked.blue) {
          if (!n) continue;
          appearBlue.set(n, (appearBlue.get(n) || 0) + 1);
          if (!omissionBlue.has(n)) omissionBlue.set(n, idx);
        }
      });

      const maxRed = isSsq ? meta.redMax : meta.max;
      const build = (max, appear, omission) => {
        const out = [];
        for (let n = 1; n <= max; n += 1) {
          out.push({
            number: n,
            count: appear.get(n) || 0,
            omission: omission.has(n) ? omission.get(n) : list.length,
          });
        }
        return out;
      };

      const result = {
        ok: true,
        game: args.game,
        window,
        sampleSize: list.length,
        issueRange: { from: list[list.length - 1].issue, to: list[0].issue },
        red: isSsq ? build(33, appearRed, omissionRed) : undefined,
        blue: isSsq ? build(16, appearBlue, omissionBlue) : undefined,
        kl8: isSsq ? undefined : build(80, appearRed, omissionRed),
        definitions: {
          count: '在统计窗口内出现的期数',
          omission: '自最近一次出现后连续未出现的期数；窗口内从未出现记为窗口长度',
        },
        note: '这是历史描述性统计，不能用于判断未来开奖倾向。',
      };
      return result;
    },

    async generate_candidates(args) {
      if (!gateOptions.futureNumbers) {
        return { ok: false, code: 'FEATURE_DISABLED', message: '候选号码功能未开启，无法生成号码组合' };
      }
      // 分析选号要把近期开奖喂给模型之外的代码（冷号、上期重号），
      // 但它只用于"降低拥挤度"，不用于推断下期号码。
      let drawList = [];
      if (args.strategy === 'analyzed') {
        drawList = await recentDraws(args.game, 100);
      }

      const res = generateCandidates({
        game: args.game,
        strategy: args.strategy,
        count: args.count,
        targetIssue: args.targetIssue,
        seed: args.seed,
        params: { include: args.include, exclude: args.exclude },
        analysis: args.analysis,
        recentDraws: drawList,
        previousDraw: drawList[0] || null,
        complianceState: (gate && gate.complianceState) || null,
      });
      if (!res.ok) {
        return { ok: false, code: res.code, message: res.message };
      }

      let batch = res.batch;
      if (saveBatch) {
        try {
          batch = (await saveBatch(res.batch)) || res.batch;
        } catch (err) {
          // 落库失败不影响回答，但必须让模型知道"这批没有存下来"
          batch = { ...res.batch, saved: false };
        }
      }

      return {
        ok: true,
        batchId: batch.id || null,
        saved: batch.saved !== false,
        game: batch.game,
        strategy: batch.strategy,
        count: batch.count,
        targetIssue: batch.targetIssue,
        randomSeed: batch.randomSeed,
        algorithmVersion: batch.algorithmVersion,
        groups: batch.groups.map((g) => ({
          index: g.index,
          displayText: g.displayText,
          numbers: g.numbers,
          crowd: g.crowd
            ? { index: g.crowd.index, level: g.crowd.levelText, reasons: g.crowd.factors }
            : undefined,
        })),
        analysis: batch.analysis
          ? {
              sumRange: batch.analysis.sumRange,
              oddRange: batch.analysis.oddRange,
              includeCold: batch.analysis.includeCold,
              window: batch.analysis.window,
              coldNumbers: batch.analysis.coldNumbers,
              sampleSize: batch.analysis.sampleSize,
              dataSufficient: batch.analysis.dataSufficient,
              avoidPatterns: batch.analysis.avoidPatterns,
              avoidRepeat: batch.analysis.avoidRepeat,
              crowdModelVersion: batch.analysis.crowdModelVersion,
            }
          : null,
        tradeoff: batch.tradeoff || null,
        notice:
          '号码由确定性算法在你给定的权重下生成：中奖概率与任何选号方式完全相同；分析只影响"万一中的是浮动奖，会不会被很多人平分"。拥挤度是基于公开研究（生日偏好、幸运号、连号/等差偏好）的推定值，不是实测投注人数。导入后仍是草稿，需自行确认购买。',
      };
    },

    async get_ticket_check(args) {
      const res = await tickets.where({ _id: args.ticketId, ownerOpenId: openid }).limit(1).get();
      const ticket = (res.data && res.data[0]) || null;
      if (!ticket) {
        return { ok: false, code: 'NOT_FOUND', message: '没有找到这条记录（或不属于当前用户）' };
      }
      const checkRes = await checks
        .where({ ticketId: args.ticketId })
        .orderBy('checkedAt', 'desc')
        .limit(1)
        .get();
      const check = (checkRes.data && checkRes.data[0]) || null;
      if (!check) {
        return {
          ok: false,
          code: 'NO_CHECK',
          message: '这条记录还没有核对结果',
          ticket: { id: ticket._id, issue: ticket.issue, displayText: ticket.displayText },
          hint: '需先同步该期已核验开奖，再执行"一键核对"。',
        };
      }
      return {
        ok: true,
        ticket: {
          id: ticket._id,
          game: ticket.game,
          issue: ticket.issue,
          displayText: ticket.displayText,
          purchaseStatus: ticket.purchaseStatus,
        },
        check: {
          checkStatus: check.checkStatus,
          prizeLevel: check.prizeLevel,
          unitPrize: check.unitPrize,
          quantity: check.quantity,
          totalPrize: check.totalPrize,
          hitDetails: check.hitDetails,
          pendingReason: check.pendingReason,
          ruleVersion: check.ruleVersion,
          checkedAt: check.checkedAt,
        },
      };
    },

    async get_rule_info(args) {
      const rule = resolveRuleVersion(args.game, args.issue || '');
      if (!rule.found) {
        const fallback = resolveRuleVersion(args.game, '9999999');
        if (args.issue) {
          return {
            ok: false,
            code: 'NO_RULE_VERSION',
            message: `第 ${args.issue} 期没有已建档的规则版本，不支持自动判奖`,
            current: fallback.found
              ? {
                  ruleVersion: fallback.rule.ruleVersion,
                  effectiveFromIssue: fallback.rule.effectiveFromIssue,
                }
              : null,
          };
        }
        if (!fallback.found) {
          return { ok: false, code: 'NO_RULE_VERSION', message: '该彩种没有已建档规则' };
        }
        return { ok: true, game: args.game, rule: describe(fallback.rule) };
      }
      return { ok: true, game: args.game, rule: describe(rule.rule) };
    },
  };

  function describe(rule) {
    return {
      ruleVersion: rule.ruleVersion,
      effectiveFromIssue: rule.effectiveFromIssue,
      effectiveToIssue: rule.effectiveToIssue,
      prizeTable: rule.prizeTable,
      specialRuleConditions: rule.specialRuleConditions,
      sourceUrl: rule.sourceUrl,
      verifiedAt: rule.verifiedAt,
      note: '奖金以"floating"表示浮动奖，必须读取当期官方公告，不得估算。',
    };
  }

  /** 统一入口：先校验工具名与参数，再执行 */
  async function execute(name, rawArgs) {
    const checked = validateToolCall(name, rawArgs, gateOptions);
    if (!checked.ok) {
      return { ok: false, code: checked.code, message: checked.message };
    }
    const handler = handlers[name];
    if (!handler) {
      return { ok: false, code: 'UNKNOWN_TOOL', message: `工具 ${name} 不在允许列表内` };
    }
    return handler(checked.args);
  }

  return { execute, handlers };
}

module.exports = { createExecutors, stripPrivate, summaryOfDraw };

});

/* ===== shared/ai/deepseek.js ===== */
__define("shared/ai/deepseek.js", function(module, exports, require){
/**
 * DeepSeek Chat Completions 报文构造与解析（纯函数，可离线测试）。
 * 接口：POST https://api.deepseek.com/chat/completions
 * 模型名必须来自服务端配置，不在此处写死。
 */

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

const LIMITS = {
  maxInputChars: 1000,
  maxOutputTokens: 900,
  timeoutMs: 25000,
  historyMessages: 10,
};

/** 模型名白名单前缀：只接受 DeepSeek 官方模型，防止配置被写成奇怪的值 */
function isAcceptableModel(name) {
  return typeof name === 'string' && /^deepseek-[a-z0-9.-]{2,40}$/.test(name);
}

function buildRequestBody({ model, messages, tools, temperature = 0.2, maxTokens }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens || LIMITS.maxOutputTokens,
    stream: false,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/** 把模型返回的 tool_calls 归一化成 {id, name, arguments} */
function normalizeToolCalls(message) {
  const raw = message && message.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => ({
    id: (c && c.id) || `call_${i}`,
    name: c && c.function ? c.function.name : '',
    arguments: c && c.function ? c.function.arguments : '{}',
  }));
}

/**
 * @returns {{ok:boolean, content:string, toolCalls:Array, usage:object|null, finishReason:string|null, code?:string, message?:string}}
 */
function parseCompletion(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'BAD_RESPONSE', message: '模型返回不是合法 JSON', content: '', toolCalls: [], usage: null };
  }
  if (payload.error) {
    return {
      ok: false,
      code: 'UPSTREAM_ERROR',
      message: String(payload.error.message || '上游返回错误').slice(0, 200),
      content: '',
      toolCalls: [],
      usage: null,
    };
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices.length) {
    return { ok: false, code: 'EMPTY_CHOICES', message: '模型未返回任何内容', content: '', toolCalls: [], usage: null };
  }
  const choice = choices[0] || {};
  const message = choice.message || {};
  return {
    ok: true,
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: normalizeToolCalls(message),
    usage: payload.usage || null,
    finishReason: choice.finish_reason || null,
  };
}

/** HTTP 状态码 → 可读错误码（不把响应体原样回传前端） */
function mapHttpError(status, bodyText) {
  if (status === 401 || status === 403) {
    return { code: 'AI_AUTH_FAILED', message: 'AI 服务鉴权失败：密钥无效或已失效，请重新填写' };
  }
  if (status === 402) {
    return { code: 'AI_QUOTA', message: 'AI 账户余额不足，请到 DeepSeek 控制台充值' };
  }
  if (status === 429) {
    return { code: 'AI_RATE_LIMIT', message: 'AI 请求过于频繁，请稍后再试' };
  }
  if (status >= 500) {
    return { code: 'AI_UPSTREAM', message: 'AI 服务暂时不可用，请稍后再试' };
  }
  return {
    code: 'AI_BAD_REQUEST',
    message: `AI 请求被拒绝（HTTP ${status}）${bodyText ? '，请检查模型名或参数配置' : ''}`,
  };
}

/** 输入长度控制：超长直接拒绝，不做静默截断 */
function validateUserMessage(text) {
  if (typeof text !== 'string') return { ok: false, message: '消息格式不正确' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: '消息不能为空' };
  if (trimmed.length > LIMITS.maxInputChars) {
    return { ok: false, message: `消息过长（上限 ${LIMITS.maxInputChars} 字），请精简后重试` };
  }
  return { ok: true, value: trimmed };
}

module.exports = {
  ENDPOINT,
  LIMITS,
  isAcceptableModel,
  buildRequestBody,
  parseCompletion,
  normalizeToolCalls,
  mapHttpError,
  validateUserMessage,
};

});

/* ===== web/js/localdb.js ===== */
__define("web/js/localdb.js", function(module, exports, require){
/**
 * 把本地存储包装成"像云数据库"的最小接口，
 * 这样 shared/cloud/aiTools.js（原本跑在云函数里）可以原样复用，不必重写一套查询。
 *
 * 支持：where(等值) / orderBy / skip / limit / get / count
 */

const LOCAL_NAMES = {
  draw_records: 'draws',
  ticket_records: 'tickets',
  ticket_checks: 'checks',
};

function createLocalDb(store) {
  async function run(cloudName, state) {
    const localName = LOCAL_NAMES[cloudName];
    if (!localName) return []; // sync_logs 等本地不存的集合：按空处理
    let rows = await store.getAll(localName);

    if (state.where && Object.keys(state.where).length) {
      rows = rows.filter((row) =>
        Object.keys(state.where).every((key) => {
          const expected = state.where[key];
          return row[key] === expected;
        })
      );
    }

    if (state.order) {
      const [field, dir] = state.order;
      rows = rows.slice().sort((a, b) => {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        return av > bv ? 1 : -1;
      });
      if (dir === 'desc') rows.reverse();
    }

    if (state.skip) rows = rows.slice(state.skip);
    if (Number.isFinite(state.limit)) rows = rows.slice(0, state.limit);

    // 本地记录主键叫 id，云数据库叫 _id；统一补上 _id 供复用代码读取
    return rows.map((row) => ({ ...row, _id: row._id || row.id }));
  }

  return {
    collection(name) {
      const state = { where: {}, order: null, limit: Infinity, skip: 0 };
      const api = {
        where(condition) {
          state.where = condition || {};
          return api;
        },
        orderBy(field, dir) {
          state.order = [field, dir || 'asc'];
          return api;
        },
        skip(n) {
          state.skip = n;
          return api;
        },
        limit(n) {
          state.limit = n;
          return api;
        },
        async get() {
          return { data: await run(name, state) };
        },
        async count() {
          return { total: (await run(name, state)).length };
        },
      };
      return api;
    },
  };
}

module.exports = { createLocalDb };

});

/* ===== web/js/bets.js ===== */
__define("web/js/bets.js", function(module, exports, require){
/**
 * 号码组合的生成与展示（与界面无关，便于测试）。
 * 注数 = 生成几注不同号码；倍数 = 每注打几倍，两者独立。
 */

const { GAME } = require('../../shared/constants/games');

const MAX_BETS = 5;

function emptyBet() {
  return { red: [], blue: null, kl8: [] };
}

function betKey(bet, game) {
  return game === GAME.SSQ ? `${bet.red.join(',')}|${bet.blue}` : bet.kl8.join(',');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function betLabel(bet, game) {
  const parts = game === GAME.SSQ ? bet.red : bet.kl8;
  if (!parts.length) return '未选号';
  const main = parts.map(pad2).join(' ');
  return game === GAME.SSQ && bet.blue ? `${main} + ${pad2(bet.blue)}` : main;
}

function pick(from, to, count) {
  const pool = [];
  for (let n = from; n <= to; n += 1) pool.push(n);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

function randomBet(game) {
  return game === GAME.SSQ
    ? { red: pick(1, 33, 6), blue: pick(1, 16, 1)[0], kl8: [] }
    : { red: [], blue: null, kl8: pick(1, 80, 10) };
}

/**
 * 生成 count 注互不相同的号码。
 * 注数超过上限时截断到 5，低于 1 时按 1 处理。
 */
function randomBets(game, count) {
  const total = Math.max(1, Math.min(MAX_BETS, Number(count) || 1));
  const out = [];
  const seen = new Set();
  let guard = 0;
  while (out.length < total && guard < total * 60) {
    guard += 1;
    const bet = randomBet(game);
    const key = betKey(bet, game);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bet);
  }
  return out;
}

module.exports = { MAX_BETS, emptyBet, betKey, betLabel, randomBet, randomBets, pad2 };

});

var __entry = __makeRequire("__bundle__");
if (typeof window !== "undefined") { window.__JC = { require: __entry, modules: Object.keys(__modules) }; }
__entry("./web/js/app.js");
})();
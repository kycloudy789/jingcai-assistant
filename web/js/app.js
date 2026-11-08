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

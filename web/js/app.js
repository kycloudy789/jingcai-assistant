/**
 * 竞彩助手 · Web 版入口（纯静态，无后端）。
 * 数据：开奖来自仓库内定时生成的 JSON；个人记录存本机 IndexedDB。
 */
const repo = require('./repo');
const store = require('./store');
const { GAME, GAME_META, PURCHASE_STATUS, DISCLAIMER } = require('../../shared/constants/games');
const { validateNumbers } = require('../../shared/validators/numbers');
const { suggestCost } = require('../../shared/rules/registry');

const TABS = [
  { key: 'draws', label: '开奖' },
  { key: 'tickets', label: '我的号码' },
  { key: 'stats', label: '统计' },
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

const SSQ_LEVEL = { 1: '一等奖', 2: '二等奖', 3: '三等奖', 4: '四等奖', 5: '五等奖', 6: '六等奖', fuyun: '福运奖' };

const state = {
  tab: 'draws',
  game: GAME.SSQ,
  draws: [],
  tickets: [],
  checks: new Map(),
  stats: null,
  busy: false,
  message: null,
  form: null,
  detail: null,
  editingNote: null,
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
  const html = main
    .map((n) => `<span class="ball ${isKl8 ? 'kl8' : 'red'}">${pad2(n)}</span>`)
    .join('');
  const blue = !isKl8 && numbers.blue !== null && numbers.blue !== undefined
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
      <span class="muted">数据生成：${sync.generatedAt ? esc(sync.generatedAt.slice(0, 16).replace('T', ' ')) : '未知'} · 共 ${state.draws.length} 期</span>
      <div class="toolbar-actions">
        <button class="btn" data-act="sync" ${state.busy ? 'disabled' : ''}>${state.busy ? '同步中…' : '重新加载开奖'}</button>
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
          ${open ? `
          <div class="detail">
            <table class="prize">
              <thead><tr><th>奖级</th><th class="num">注数</th><th class="num">单注奖金</th></tr></thead>
              <tbody>${prizeRows(d)}</tbody>
            </table>
            <p class="muted small">来源：${d.sourceUrl ? `<a href="${esc(d.sourceUrl)}" target="_blank" rel="noreferrer">中国福彩网公告</a>` : '未知'} · 解析器 ${esc(d.parserVersion || '—')} · 核验 ${esc((d.verifiedAt || '').slice(0, 10))}</p>
            <p class="muted small">浮动奖金额取自当期公告；当期无人中或未公布时显示为待公告，不做估算。</p>
          </div>` : ''}
        </article>`;
        })
        .join('')}
    </div>`;
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
        <span class="muted">${t.multiple} 倍 · ${t.actualCost === null || t.actualCost === undefined ? '金额待补录' : `${t.actualCost} 元`}</span>
        <span class="link">${open ? '收起' : '详情'}</span>
      </div>
      ${open ? ticketDetail(t, c) : ''}
    </article>`;
}

function ticketDetail(t, check) {
  const rows = [];
  if (t.purchaseStatus === PURCHASE_STATUS.DRAFT) {
    rows.push(`
      <div class="form-inline">
        <label>实际金额（元）<input id="cost-${t.id}" type="number" min="0" step="1" placeholder="如 ${suggestCost(t.game, t.multiple || 1).value || ''}" value="${t.actualCost === null ? '' : t.actualCost}" /></label>
        <label>倍数<input id="mult-${t.id}" type="number" min="1" max="99" value="${t.multiple}" /></label>
        <label>购买日期<input id="date-${t.id}" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="confirm" data-id="${t.id}">确认已购买（冻结号码）</button>
        <button class="btn danger-outline" data-act="void" data-id="${t.id}">作废</button>
        <button class="btn danger-outline" data-act="delete" data-id="${t.id}">删除</button>
      </div>`);
  } else if (t.purchaseStatus === PURCHASE_STATUS.CONFIRMED) {
    rows.push(`
      <div class="check-box ${check && check.isWinner ? 'win' : check && check.checkStatus === 'pending_manual_review' ? 'warn' : ''}">
        ${check ? renderCheck(check) : '<span class="muted">尚未核对</span>'}
      </div>
      <div class="actions">
        <button class="btn" data-act="check-one" data-id="${t.id}">${check ? '重新核对' : '核对开奖结果'}</button>
        <button class="btn danger-outline" data-act="void" data-id="${t.id}">作废</button>
      </div>
      <p class="muted small">已购买后号码冻结；如需改号，请作废后新建。删除需先作废。</p>`);
  } else {
    rows.push(`<div class="actions"><button class="btn danger-outline" data-act="delete" data-id="${t.id}">永久删除</button></div>`);
  }
  return `<div class="detail">${rows.join('')}</div>`;
}

function renderCheck(c) {
  if (c.checkStatus === 'pending_manual_review') {
    return `<div><strong>待人工核验</strong><p class="small">${PENDING_TEXT[c.pendingReason] || '存在需要人工确认的情况。'}</p></div>`;
  }
  if (c.checkStatus === 'not_winner') {
    const hit = c.hit || {};
    const text = c.game === GAME.SSQ
      ? `命中 ${hit.red === undefined ? '-' : hit.red} 个红球${hit.blue ? ' + 蓝球' : ''}`
      : `命中 ${hit.count === undefined ? '-' : hit.count} 个号码`;
    return `<div><strong>未中奖</strong><p class="small">${text}</p></div>`;
  }
  const label = c.game === GAME.SSQ ? SSQ_LEVEL[c.prizeLevel] || `${c.prizeLevel} 等奖` : `选十中 ${c.prizeLevel}`;
  return `<div>
    <strong>中奖：${label}</strong>
    <p class="amount">${c.totalPrize === null || c.totalPrize === undefined ? `单注${yuan(c.unitPrize)}（待公告）` : yuan(c.totalPrize)}${c.quantity > 1 ? ` · ${c.quantity} 注` : ''}</p>
    <p class="small muted">命中号码：${((c.hit && c.hit.numbers) || []).map(pad2).join(' ') || '—'} · 规则 ${esc(c.ruleVersion || '—')}</p>
  </div>`;
}

function ticketsView() {
  const counts = state.stats ? state.stats.counts : { draft: 0, confirmed: 0, void: 0 };
  return `
    <div class="toolbar">
      <span class="muted">草稿 ${counts.draft} · 已购买 ${counts.confirmed} · 已作废 ${counts.void}</span>
      <div class="toolbar-actions">
        <button class="btn" data-act="check-all" ${state.busy ? 'disabled' : ''}>一键核对</button>
        <button class="btn primary" data-act="new-ticket">新增号码</button>
      </div>
    </div>
    ${state.form ? ticketForm() : ''}
    ${state.tickets.length === 0 && !state.form ? emptyBlock('还没有号码记录', '点「新增号码」手动录入。候选导入也只生成草稿，必须你确认购买后才计入统计与判奖。') : ''}
    <div class="list">${state.tickets.map(ticketCard).join('')}</div>`;
}

function ticketForm() {
  const f = state.form;
  const meta = GAME_META[f.game];
  const isSsq = f.game === GAME.SSQ;
  const suggestion = suggestCost(f.game, Number(f.multiple) || 1);

  const grid = (from, to, selected, act) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .map(
        (n) =>
          `<button class="pick ${selected.includes(n) ? 'on' : ''}" data-act="${act}" data-n="${n}">${pad2(n)}</button>`
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
            (g) => `<button class="seg ${f.game === g ? 'on' : ''}" data-act="form-game" data-game="${g}">${GAME_META[g].shortName}</button>`
          )
          .join('')}
      </div>
      <label class="field">目标期号
        <input id="f-issue" type="text" inputmode="numeric" maxlength="7" placeholder="如 2026127" value="${esc(f.issue || '')}" />
      </label>
      <p class="muted small">期号请按官方销售公告填写，本工具不会用「上期 + 1」推算。</p>

      ${isSsq
        ? `<div class="pick-group"><div class="pick-title">红球 <span class="muted">${f.red.length}/6</span></div><div class="grid">${grid(1, 33, f.red, 'pick-red')}</div></div>
           <div class="pick-group"><div class="pick-title">蓝球 <span class="muted">${f.blue ? 1 : 0}/1</span></div><div class="grid small">${grid(1, 16, f.blue ? [f.blue] : [], 'pick-blue')}</div></div>`
        : `<div class="pick-group"><div class="pick-title">选十号码 <span class="muted">${f.kl8.length}/10</span></div><div class="grid">${grid(1, 80, f.kl8, 'pick-kl8')}</div></div>`}

      <div class="form-inline">
        <label>倍数<input id="f-multiple" type="number" min="1" max="99" value="${f.multiple || 1}" /></label>
        <label>实际金额（元，可留空）<input id="f-cost" type="number" min="0" placeholder="${suggestion.value ? `建议 ${suggestion.value}` : '按实际支付'}" value="${f.cost === null ? '' : f.cost}" /></label>
        <label>备注<input id="f-note" type="text" placeholder="选填" value="${esc(f.note || '')}" /></label>
      </div>

      <div class="actions">
        <button class="btn" data-act="random">随机一注</button>
        <button class="btn" data-act="clear-picks">清空</button>
        <button class="btn primary" data-act="save-ticket">保存为草稿</button>
      </div>
      <p class="muted small">保存后是「草稿」，不计入花费与中奖。线下真的买了，再点「确认已购买」。</p>
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
      <div class="stat"><span class="stat-label">净额</span><strong class="${s.net >= 0 ? 'up' : 'down'}">${s.net >= 0 ? '+' : ''}${s.net} 元</strong></div>
      <div class="stat"><span class="stat-label">待处理</span><strong>${s.pending + s.unchecked}</strong></div>
    </div>
    <section class="card">
      <table class="prize">
        <thead><tr><th>彩种</th><th class="num">已购买</th><th class="num">投入</th><th class="num">中奖</th><th class="num">奖金</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">暂无已确认购买的记录</td></tr>'}</tbody>
      </table>
      <p class="muted small">只统计「已购买」的记录；草稿与已作废不计入。奖金来自核对结果，待人工核验与待公告的金额未计入。${s.missingCost > 0 ? `另有 ${s.missingCost} 条未填金额，投入金额偏低。` : ''}</p>
    </section>`;
}

function dataView() {
  return `
    <section class="card">
      <h2>开奖数据</h2>
      <p class="muted small">开奖 JSON 由仓库的 GitHub Actions 每天定时抓取并提交，与本站同源，无需跨域。也可以手动导入。</p>
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
      : state.tab === 'stats'
      ? statsView()
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
  return { game: state.game, issue: '', red: [], blue: null, kl8: [], multiple: 1, cost: null, note: '' };
}

function readFormInputs() {
  const f = state.form;
  const issue = (document.getElementById('f-issue') || {}).value || '';
  const multiple = Number((document.getElementById('f-multiple') || {}).value || 1);
  const costRaw = (document.getElementById('f-cost') || {}).value;
  const note = (document.getElementById('f-note') || {}).value || '';
  return {
    ...f,
    issue: issue.trim(),
    multiple,
    cost: costRaw === '' || costRaw === undefined ? null : Number(costRaw),
    note,
  };
}

async function saveTicket() {
  state.form = readFormInputs();
  const f = state.form;
  const numbers =
    f.game === GAME.SSQ ? { red: f.red, blue: f.blue } : { kl8: f.kl8 };
  const check = validateNumbers(f.game, numbers);
  if (!check.ok) {
    notify(check.message, 'bad');
    return;
  }
  const res = await repo.createTicket({
    game: f.game,
    issue: f.issue,
    numbers: check.normalized,
    multiple: f.multiple,
    actualCost: f.cost,
    note: f.note,
  });
  if (!res.ok) {
    notify(res.message, 'bad');
    return;
  }
  state.form = null;
  await refreshAll();
  notify('已存为草稿', 'ok');
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
  if (act === 'draw-toggle') {
    state.detail = state.detail === el.dataset.id ? null : el.dataset.id;
    render();
    return;
  }
  if (act === 'sync') return syncDraws();
  if (act === 'ticket-toggle') {
    state.detail = state.detail === el.dataset.id ? null : el.dataset.id;
    render();
    return;
  }
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
    state.form = { ...state.form, game: el.dataset.game, red: [], blue: null, kl8: [] };
    render();
    return;
  }
  if (act === 'pick-red' || act === 'pick-blue' || act === 'pick-kl8') {
    const f = readFormInputs();
    const n = Number(el.dataset.n);
    if (act === 'pick-red') {
      const idx = f.red.indexOf(n);
      if (idx >= 0) f.red.splice(idx, 1);
      else if (f.red.length >= 6) return notify('红球最多 6 个', 'bad');
      else f.red.push(n);
      f.red.sort((a, b) => a - b);
    } else if (act === 'pick-blue') {
      f.blue = f.blue === n ? null : n;
    } else {
      const idx = f.kl8.indexOf(n);
      if (idx >= 0) f.kl8.splice(idx, 1);
      else if (f.kl8.length >= 10) return notify('选十只能选 10 个', 'bad');
      else f.kl8.push(n);
      f.kl8.sort((a, b) => a - b);
    }
    state.form = f;
    render();
    return;
  }
  if (act === 'random') {
    const pick = (from, to, count) => {
      const pool = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      for (let i = pool.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      return pool.slice(0, count).sort((a, b) => a - b);
    };
    const f = readFormInputs();
    if (f.game === GAME.SSQ) {
      f.red = pick(1, 33, 6);
      f.blue = pick(1, 16, 1)[0];
    } else {
      f.kl8 = pick(1, 80, 10);
    }
    state.form = f;
    render();
    return;
  }
  if (act === 'clear-picks') {
    state.form = { ...readFormInputs(), red: [], blue: null, kl8: [] };
    render();
    return;
  }
  if (act === 'save-ticket') return saveTicket();

  if (act === 'confirm') {
    const costEl = document.getElementById(`cost-${id}`);
    const multEl = document.getElementById(`mult-${id}`);
    const dateEl = document.getElementById(`date-${id}`);
    const cost = costEl ? Number(costEl.value) : NaN;
    if (!Number.isFinite(cost) || cost < 0 || costEl.value === '') {
      return notify('请填写实际支付金额（赠票填 0）', 'bad');
    }
    const res = await repo.confirmTicket(id, {
      actualCost: cost,
      multiple: Number(multEl && multEl.value) || 1,
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
      const counts = await repo.importAll(JSON.parse(text));
      notify(`已恢复：号码 ${counts.tickets}、核对 ${counts.checks}、开奖 ${counts.draws}`, 'ok');
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
}

async function boot() {
  bind();
  render(); // 先渲染骨架，别让用户对着空白等数据库

  try {
    await refreshAll();
  } catch (err) {
    state.message = { text: `本地数据库不可用：${err.message}`, kind: 'bad', at: Date.now() };
  }
  render();

  if (!state.draws.length) {
    // 首次打开自动拉一次仓库数据，失败也不阻塞
    await syncDraws();
  }

  if (typeof location !== 'undefined' && location.search.indexOf('debug') >= 0) {
    document.title = JSON.stringify({
      draws: state.draws.length,
      tickets: state.tickets.length,
      error: state.lastError || null,
      msg: state.message ? state.message.text : null,
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

module.exports = { boot, state, repo };

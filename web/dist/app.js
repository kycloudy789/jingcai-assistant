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

});

/* ===== web/js/repo.js ===== */
__define("web/js/repo.js", function(module, exports, require){
/**
 * 领域操作层：把 shared/ 的纯逻辑接到本地存储上。
 * 这里不复制任何判定规则——号码校验、状态机、判奖全部 require 自 shared/。
 */

const store = require('./store');
const { GAME, PURCHASE_STATUS } = require('../../shared/constants/games');
const { validateDrawRecord } = require('../../shared/validators/draws');
const { resolveRuleVersion } = require('../../shared/rules/registry');
const { judgeTicket } = require('../../shared/rules/judge');
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
 */
async function runChecks(game) {
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
      ticketId: ticket.id,
      game: ticket.game,
      issue: ticket.issue,
      drawId: draw ? draw.id : null,
      drawHash: draw ? draw.rawHash || null : null,
      ruleVersion: result.ruleVersion,
      hit: result.hit,
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

/** 全量导出（备份用） */
async function exportAll() {
  const [tickets, checks, draws, meta] = await Promise.all([
    store.getAll('tickets'),
    store.getAll('checks'),
    store.getAll('draws'),
    store.getAll('meta'),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    schema: 'jingcai-web@1',
    tickets,
    checks,
    draws,
    meta,
  };
}

/** 导入备份：按 id 覆盖，不删除现有数据 */
async function importAll(payload) {
  if (!payload || payload.schema !== 'jingcai-web@1') {
    throw new Error('备份文件格式不匹配（需要 jingcai-web@1）');
  }
  const counts = {};
  for (const name of ['tickets', 'checks', 'draws', 'meta']) {
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
  updateTicket,
  confirmTicket,
  voidTicket,
  deleteTicket,
  runChecks,
  latestChecks,
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
const DB_VERSION = 1;
const STORES = ['draws', 'tickets', 'checks', 'meta'];
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

  if (mode === 'incremental') {
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

var __entry = __makeRequire("__bundle__");
if (typeof window !== "undefined") { window.__JC = { require: __entry, modules: Object.keys(__modules) }; }
__entry("./web/js/app.js");
})();
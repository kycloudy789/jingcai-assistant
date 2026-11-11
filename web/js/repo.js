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
      promo: result.promo || null,
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

/**
 * 期号 → 开奖日期 / 开奖号码。
 * 用于「历史号码按日期归纳」和「核对结果里对照当期开奖号码」，
 * 只读本机已同步的数据，不额外发请求。
 */
async function drawInfoMap() {
  const all = await store.getAll('draws');
  const map = new Map();
  for (const d of all) {
    map.set(`${d.game}:${d.issue}`, { drawDate: d.drawDate || null, numbers: d.numbers || null });
  }
  return map;
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
  drawInfoMap,
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

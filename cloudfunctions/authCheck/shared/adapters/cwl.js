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

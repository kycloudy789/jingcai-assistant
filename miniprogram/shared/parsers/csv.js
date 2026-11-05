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

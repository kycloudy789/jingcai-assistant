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

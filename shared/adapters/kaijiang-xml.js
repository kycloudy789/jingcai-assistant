/**
 * 500.com 开奖号码 XML 列表解析（只要号码 + 日期，不含奖级明细）。
 *
 * 为什么用它：中国福彩网对 GitHub Runner 返回 403（网宿 WAF 按 IP 拦），
 * 而 `https://kaijiang.500.com/static/info/kaijiang/xml/<game>/list.xml`
 * 一次请求就能拿到全量历史（双色球 3500+ 期、快乐8 1700+ 期），
 * 字段是 `expect / opencode / opentime`，很小也很快。
 *
 * 奖级明细（浮动奖金额、派奖）仍然走官方公告（只在本机能抓），
 * 所以这个源只负责"号码别落后"。
 */

const { GAME } = require('../constants/games');

const BASE = 'https://kaijiang.500.com/static/info/kaijiang/xml';

const SOURCE = 'third_party:500.com/xml';
const PARSER_VERSION = 'kaijiangxml@1.0.0';

/**
 * 双色球 XML 里的期号是 5 位（26129 = 2026 年第 129 期），
 * 2003 年是 03001。这里统一补成 7 位。
 */
function normalizeIssue(game, expect) {
  const raw = String(expect || '').trim();
  if (game === GAME.KL8) return /^\d{7}$/.test(raw) ? raw : null;
  if (/^\d{7}$/.test(raw)) return raw;
  if (/^\d{5}$/.test(raw)) return `20${raw}`;
  return null;
}

function parseDate(opentime) {
  const m = String(opentime || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function toNumbers(list, min, max, count) {
  const nums = list
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n >= min && n <= max);
  if (nums.length !== count) return null;
  if (new Set(nums).size !== nums.length) return null;
  return nums.sort((a, b) => a - b);
}

/** 解析一条 row；不合法返回 null（脏数据直接丢，不猜） */
function parseRow(game, attrs) {
  const get = (key) => {
    const m = attrs.match(new RegExp(`${key}="([^"]*)"`));
    return m ? m[1] : '';
  };
  const issue = normalizeIssue(game, get('expect'));
  const drawDate = parseDate(get('opentime'));
  const opencode = get('opencode');
  if (!issue || !drawDate || !opencode) return null;

  if (game === GAME.SSQ) {
    const [redPart, bluePart] = opencode.split('|');
    if (!redPart || !bluePart) return null;
    const red = toNumbers(redPart.split(','), 1, 33, 6);
    const blue = Number(String(bluePart).trim());
    if (!red || !Number.isInteger(blue) || blue < 1 || blue > 16) return null;
    return { issue, drawDate, numbers: { red, blue, kl8: [] } };
  }

  if (game === GAME.KL8) {
    const kl8 = toNumbers(opencode.split(','), 1, 80, 20);
    if (!kl8) return null;
    return { issue, drawDate, numbers: { red: [], blue: null, kl8 } };
  }

  return null;
}

/** 解析整份 XML → 按期号降序的数组 */
function parseList(game, xml) {
  const out = [];
  const re = /<row\s([^>]+?)\/?>/g;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const row = parseRow(game, m[1]);
    if (row) out.push(row);
  }
  out.sort((a, b) => Number(b.issue) - Number(a.issue));
  return out;
}

function listUrl(game) {
  const name = game === GAME.SSQ ? 'ssq' : game === GAME.KL8 ? 'kl8' : null;
  return name ? `${BASE}/${name}/list.xml` : null;
}

module.exports = { parseList, parseRow, normalizeIssue, listUrl, SOURCE, PARSER_VERSION };

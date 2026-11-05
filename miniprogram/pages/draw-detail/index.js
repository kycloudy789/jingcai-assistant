const api = require('../../services/api');
const { GAME, GAME_META, SPECIAL_RULE_STATUS, DISCLAIMER } = require('../../shared/constants/games');
const { resolveRuleVersion } = require('../../shared/rules/registry');

const SSQ_LEVELS = [
  { key: 'first', label: '一等奖', cond: '6 红 + 1 蓝' },
  { key: 'second', label: '二等奖', cond: '6 红' },
  { key: 'third', label: '三等奖', cond: '5 红 + 1 蓝' },
  { key: 'fourth', label: '四等奖', cond: '5 红，或 4 红 + 1 蓝' },
  { key: 'fifth', label: '五等奖', cond: '4 红，或 3 红 + 1 蓝' },
  { key: 'sixth', label: '六等奖', cond: '1 蓝' },
];

const KL8_LEVELS = [
  { key: 'hit10', label: '中 10', hit: 10 },
  { key: 'hit9', label: '中 9', hit: 9 },
  { key: 'hit8', label: '中 8', hit: 8 },
  { key: 'hit7', label: '中 7', hit: 7 },
  { key: 'hit6', label: '中 6', hit: 6 },
  { key: 'hit5', label: '中 5', hit: 5 },
  { key: 'hit0', label: '中 0', hit: 0 },
];

function yuanText(amount) {
  if (amount === null || amount === undefined) return '待官方公告';
  if (amount >= 10000) return `${(amount / 10000).toFixed(amount % 10000 === 0 ? 0 : 2)} 万元`;
  return `${amount} 元`;
}

function buildPrizeRows(item) {
  const info = item.prizeInfo || {};
  if (item.game === GAME.SSQ) {
    const rows = SSQ_LEVELS.map((lvl) => {
      const grade = info[lvl.key];
      return {
        label: lvl.label,
        cond: lvl.cond,
        count: grade && grade.count !== null ? grade.count : null,
        amountText: grade ? yuanText(grade.amount) : '—',
      };
    });
    if (info.fuyun) {
      rows.push({
        label: '福运奖',
        cond: '命中 3 个红球（特别规定期间）',
        count: info.fuyun.count,
        amountText: yuanText(info.fuyun.amount),
      });
    }
    return rows;
  }

  const choose10 = info.choose10 || {};
  return KL8_LEVELS.map((lvl) => {
    const grade = choose10[lvl.key];
    return {
      label: lvl.label,
      cond: `命中 ${lvl.hit} 个`,
      count: grade && grade.count !== null ? grade.count : null,
      amountText: grade
        ? lvl.hit === 10 && (!grade.amount || grade.count === 0)
          ? '浮动奖（当期无人中或未公告）'
          : yuanText(grade.amount)
        : '—',
    };
  });
}

Page({
  data: {
    loading: true,
    error: '',
    item: null,
    prizeRows: [],
    specialWarn: '',
    ruleText: '',
    disclaimer: DISCLAIMER,
    balls: [],
    blue: null,
    isKl8: false,
  },

  onLoad(query) {
    const game = query.game === GAME.KL8 ? GAME.KL8 : GAME.SSQ;
    const issue = query.issue || '';
    this.setData({ game, issue });
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    const res = await api.call('queryDraws', {
      mode: 'detail',
      game: this.data.game,
      issue: this.data.issue,
    });
    if (!res.success) {
      this.setData({ loading: false, error: res.message || '加载失败' });
      return;
    }

    const item = res.data.item;
    const rule = resolveRuleVersion(item.game, item.issue);
    const balls =
      item.game === GAME.SSQ ? item.numbers.red || [] : (item.numbers.kl8 || []).slice();

    let specialWarn = '';
    if (item.game === GAME.SSQ && item.specialRuleStatus === SPECIAL_RULE_STATUS.UNKNOWN) {
      specialWarn =
        '该期「福运奖」是否执行无法从已核验数据确认，涉及 3 个红球的记录将转人工复核，不做自动判断。';
    }

    this.setData({
      loading: false,
      item,
      balls,
      blue: item.game === GAME.SSQ ? item.numbers.blue : null,
      isKl8: item.game === GAME.KL8,
      gameName: (GAME_META[item.game] || {}).shortName || item.game,
      prizeRows: buildPrizeRows(item),
      specialWarn,
      ruleText: rule.found
        ? `${rule.ruleVersion}（自 ${rule.rule.effectiveFromIssue} 期起）`
        : '无适用规则版本（该期不支持自动判奖）',
    });
  },

  copySource() {
    const url = this.data.item && this.data.item.sourceUrl;
    if (!url) {
      wx.showToast({ title: '该记录无来源链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '来源链接已复制', icon: 'success' }),
    });
  },
});

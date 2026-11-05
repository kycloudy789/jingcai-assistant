const api = require('../../services/api');
const { GAME, GAME_META, DRAW_STATUS } = require('../../shared/constants/games');
const { formatDisplay } = require('../../shared/validators/numbers');

const STATUS_TEXT = {
  verified: '已核验',
  corrected: '已更正',
  conflict: '数据冲突',
  parsed: '待核验',
  pending: '待核验',
};

function decorate(item) {
  const meta = GAME_META[item.game] || {};
  const first =
    item.game === GAME.SSQ
      ? item.prizeInfo && item.prizeInfo.first
      : item.prizeInfo && item.prizeInfo.choose10 && item.prizeInfo.choose10.hit10;

  return {
    ...item,
    gameName: meta.shortName || item.game,
    display: formatDisplay(item.game, item.numbers),
    redBalls: item.game === GAME.SSQ ? (item.numbers.red || []) : item.numbers.kl8 || [],
    blueBall: item.game === GAME.SSQ ? item.numbers.blue : null,
    isKl8: item.game === GAME.KL8,
    statusText: STATUS_TEXT[item.drawStatus] || item.drawStatus,
    statusClass:
      item.drawStatus === DRAW_STATUS.VERIFIED || item.drawStatus === DRAW_STATUS.CORRECTED
        ? 'ok'
        : item.drawStatus === DRAW_STATUS.CONFLICT
        ? 'bad'
        : 'warn',
    firstPrizeText:
      first && first.amount
        ? `一等奖 ${first.count} 注 / ${(first.amount / 10000).toFixed(0)} 万元`
        : item.game === GAME.KL8
        ? '选十中十：当期无人中'
        : '一等奖：详见公告',
  };
}

Page({
  data: {
    games: [
      { game: GAME.SSQ, name: '双色球' },
      { game: GAME.KL8, name: '快乐8（选十）' },
    ],
    game: GAME.SSQ,
    items: [],
    total: 0,
    pageNo: 1,
    pageSize: 20,
    hasMore: false,
    loading: false,
    error: '',
    syncing: false,
    yearOptions: [],
    year: '',
    lastSyncText: '',
    authorized: false,
  },

  onLoad(query) {
    const game = query && query.game === GAME.KL8 ? GAME.KL8 : GAME.SSQ;
    this.setData({ game, yearOptions: this.buildYears() });
  },

  onShow() {
    const app = getApp();
    const authorized = Boolean(app.globalData.auth && app.globalData.auth.allowed);
    this.setData({ authorized });
    if (authorized) this.load(true);
  },

  buildYears() {
    const current = new Date().getFullYear();
    const years = [''];
    for (let y = current; y >= 2020; y -= 1) years.push(String(y));
    return years.map((y) => ({ value: y, label: y === '' ? '全部年份' : `${y} 年` }));
  },

  switchGame(e) {
    const game = e.currentTarget.dataset.game;
    if (game === this.data.game) return;
    this.setData({ game, items: [], pageNo: 1, error: '' });
    this.load(true);
  },

  onYearChange(e) {
    const index = Number(e.detail.value);
    const year = this.data.yearOptions[index] ? this.data.yearOptions[index].value : '';
    this.setData({ year, items: [], pageNo: 1 });
    this.load(true);
  },

  async load(reset) {
    if (this.data.loading) return;
    const pageNo = reset ? 1 : this.data.pageNo + 1;
    this.setData({ loading: true, error: '' });

    const res = await api.call('queryDraws', {
      mode: 'list',
      game: this.data.game,
      year: this.data.year || undefined,
      pageNo,
      pageSize: this.data.pageSize,
    });

    if (!res.success) {
      this.setData({ loading: false, error: res.message || '加载失败' });
      wx.stopPullDownRefresh();
      return;
    }

    const incoming = (res.data.items || []).map(decorate);
    this.setData({
      items: reset ? incoming : this.data.items.concat(incoming),
      total: res.data.total || 0,
      pageNo,
      hasMore: Boolean(res.data.hasMore),
      loading: false,
    });
    wx.stopPullDownRefresh();
  },

  onPullDownRefresh() {
    this.load(true);
  },

  onRetry() {
    this.load(true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false);
  },

  async onSync() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    wx.showLoading({ title: '同步中', mask: true });

    const res = await api.call('syncDraws', { game: this.data.game, mode: 'incremental', issueCount: 30 });
    wx.hideLoading();

    if (!res.success) {
      this.setData({ syncing: false });
      wx.showModal({
        title: '同步失败',
        content: `${res.message}\n\n本地历史数据不受影响。`,
        showCancel: false,
      });
      return;
    }

    const d = res.data;
    this.setData({ syncing: false });
    wx.showToast({
      title: `新增 ${d.inserted} 条，冲突 ${d.conflicts} 条`,
      icon: d.conflicts > 0 ? 'none' : 'success',
    });
    this.load(true);
  },

  goDetail(e) {
    const { game, issue } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/draw-detail/index?game=${game}&issue=${issue}` });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index' });
  },
});

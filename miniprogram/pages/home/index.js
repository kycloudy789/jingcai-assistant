const api = require('../../services/api');
const { GAME, GAME_META, DEFAULT_FEATURE_FLAGS, DISCLAIMER } = require('../../shared/constants/games');
const { formatDisplay } = require('../../shared/validators/numbers');

Page({
  data: {
    games: [
      { game: GAME.SSQ, meta: GAME_META[GAME.SSQ] },
      { game: GAME.KL8, meta: GAME_META[GAME.KL8] },
    ],
    latest: {},
    authAllowed: false,
    authDegraded: false,
    lastSyncText: '尚未同步',
    flags: DEFAULT_FEATURE_FLAGS,
    candidateOpen: false,
    disclaimer: DISCLAIMER,
    loading: true,
  },

  onShow() {
    const app = getApp();
    const auth = (app.globalData && app.globalData.auth) || {};
    this.setData({
      authAllowed: Boolean(auth.allowed),
      authDegraded: auth.checked && !auth.allowed && auth.reason === 'CLOUD_UNAVAILABLE',
      flags: (app.globalData && app.globalData.featureFlags) || DEFAULT_FEATURE_FLAGS,
      candidateOpen: Boolean(app.globalData && app.globalData.candidateGenerationEnabled),
    });
    if (auth.allowed) this.loadLatest();
  },

  async loadLatest() {
    this.setData({ loading: true });
    const latest = {};

    for (const game of [GAME.SSQ, GAME.KL8]) {
      const res = await api.call('queryDraws', { mode: 'list', game, pageNo: 1, pageSize: 1 });
      if (res.success && res.data.items && res.data.items.length) {
        const item = res.data.items[0];
        latest[game] = {
          ...item,
          display: formatDisplay(item.game, item.numbers),
          redBalls: item.game === GAME.SSQ ? item.numbers.red : item.numbers.kl8,
          blueBall: item.game === GAME.SSQ ? item.numbers.blue : null,
          isKl8: item.game === GAME.KL8,
          statusText: item.drawStatus === 'verified' || item.drawStatus === 'corrected' ? '已核验' : '待核验',
        };
      } else {
        latest[game] = null;
      }
    }

    const metaRes = await api.call('queryDraws', { mode: 'meta' });
    let lastSyncText = '尚未同步';
    if (metaRes.success && metaRes.data.lastSync) {
      const sync = metaRes.data.lastSync;
      lastSyncText = `${sync.finishedAt || sync.createdAt || ''}（${
        sync.status === 'success' ? '成功' : sync.status === 'no_change' ? '无变化' : sync.status
      }）`;
    }

    this.setData({ latest, lastSyncText, loading: false });
  },

  goDraws(e) {
    const game = (e.currentTarget.dataset && e.currentTarget.dataset.game) || GAME.SSQ;
    wx.navigateTo({ url: `/pages/draws/index?game=${game}` });
  },

  goDetail(e) {
    const { game, issue } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/pages/draw-detail/index?game=${game}&issue=${issue}` });
  },

  goTickets() {
    wx.switchTab({ url: '/pages/tickets/index' });
  },

  goAssistant() {
    wx.switchTab({ url: '/pages/assistant/index' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index' });
  },
});

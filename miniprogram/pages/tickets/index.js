const api = require('../../services/api');
const { GAME, GAME_META, PURCHASE_STATUS } = require('../../shared/constants/games');

const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: PURCHASE_STATUS.DRAFT, label: '草稿' },
  { key: PURCHASE_STATUS.CONFIRMED, label: '已购买' },
  { key: PURCHASE_STATUS.VOID, label: '已作废' },
];

const STATUS_TEXT = { draft: '草稿', confirmed: '已购买', void: '已作废' };

/** 列表只显示核对结论摘要；金额与命中细节去详情页看 */
function checkBadgeOf(t) {
  const s = t.checkSummary;
  if (t.purchaseStatus !== 'confirmed' || !s || !s.checkStatus) return { text: '', cls: '' };
  if (s.checkStatus === 'checked') {
    return { text: s.totalPrize ? `中奖 ¥${s.totalPrize}` : '已中奖', cls: 'win' };
  }
  if (s.checkStatus === 'not_winner') return { text: '未中奖', cls: 'plain' };
  return { text: '待人工核验', cls: 'warn' };
}

function decorate(t) {
  const meta = GAME_META[t.game] || {};
  const numbers = t.numbers || {};
  const badge = checkBadgeOf(t);
  return {
    ...t,
    id: t._id || t.id,
    gameName: meta.shortName || t.game,
    isKl8: t.game === GAME.KL8,
    redBalls: t.game === GAME.SSQ ? numbers.red || [] : numbers.kl8 || [],
    blueBall: t.game === GAME.SSQ ? numbers.blue : null,
    statusText: STATUS_TEXT[t.purchaseStatus] || t.purchaseStatus,
    statusClass: t.purchaseStatus,
    costText:
      t.actualCost === null || t.actualCost === undefined ? '金额待补录' : `¥${t.actualCost}`,
    sourceText: t.recordSource === 'candidate_import' ? '候选导入' : '手动录入',
    checkText: badge.text,
    checkClass: badge.cls,
  };
}

Page({
  data: {
    tabs: STATUS_TABS,
    status: '',
    items: [],
    counts: { draft: 0, confirmed: 0, void: 0 },
    total: 0,
    pageNo: 1,
    pageSize: 20,
    hasMore: false,
    loading: false,
    error: '',
    authorized: false,
    checking: false,
  },

  onShow() {
    const app = getApp();
    const authorized = Boolean(app.globalData.auth && app.globalData.auth.allowed);
    this.setData({ authorized });
    if (authorized) this.load(true);
  },

  switchTab(e) {
    const status = e.currentTarget.dataset.status;
    if (status === this.data.status) return;
    this.setData({ status, items: [], pageNo: 1 });
    this.load(true);
  },

  async load(reset) {
    if (this.data.loading) return;
    const pageNo = reset ? 1 : this.data.pageNo + 1;
    this.setData({ loading: true, error: '' });

    const res = await api.call('queryTickets', {
      mode: 'list',
      status: this.data.status || undefined,
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
      counts: res.data.counts || this.data.counts,
      pageNo,
      hasMore: Boolean(res.data.hasMore),
      loading: false,
    });
    wx.stopPullDownRefresh();
  },

  onPullDownRefresh() {
    this.load(true);
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.load(false);
  },

  onRetry() {
    this.load(true);
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/ticket-edit/index' });
  },

  async onCheckAll() {
    if (this.data.checking) return;
    this.setData({ checking: true });
    const res = await api.call('checkTickets', {});
    this.setData({ checking: false });

    if (!res.success) {
      wx.showModal({ title: '核对失败', content: res.message, showCancel: false });
      return;
    }
    const d = res.data;
    if (d.total === 0) {
      wx.showToast({ title: '没有已确认购买的号码', icon: 'none' });
      return;
    }
    if (d.skipped === d.total) {
      wx.showModal({
        title: '还无法核对',
        content: '这些期号的开奖数据尚未同步或尚未通过核验。请先到「开奖」页同步官方数据。',
        showCancel: false,
      });
      return;
    }
    wx.showToast({
      title: `新核对 ${d.inserted} 条，中奖 ${d.winners} 条`,
      icon: 'none',
    });
    this.load(true);
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/ticket-detail/index?ticketId=${id}` });
  },
});

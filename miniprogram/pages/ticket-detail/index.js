const api = require('../../services/api');
const { GAME, GAME_META } = require('../../shared/constants/games');
const { suggestCost } = require('../../shared/rules/registry');

const STATUS_TEXT = { draft: '草稿（未确认购买）', confirmed: '已购买', void: '已作废' };

const SSQ_LEVEL_LABEL = {
  1: '一等奖',
  2: '二等奖',
  3: '三等奖',
  4: '四等奖',
  5: '五等奖',
  6: '六等奖',
  fuyun: '福运奖',
};

const PENDING_TEXT = {
  FUYUN_STATUS_UNKNOWN: '该期福运奖是否执行无法确认，已转人工复核（涉及命中 3 个红球的情形）。',
  PRIZE_AMOUNT_PENDING: '该奖级的单注奖金尚未在官方公告中确认，暂不估算金额。',
  NO_RULE_VERSION: '该期没有已建档的规则版本，暂不支持自动判奖，请人工核对。',
  NO_DRAW: '该期开奖数据尚未同步。',
  DRAW_NOT_VERIFIED: '该期开奖数据尚未通过核验。',
};

function yuanText(amount) {
  if (amount === null || amount === undefined) return '待官方公告';
  if (amount >= 10000) return `${(amount / 10000).toFixed(amount % 10000 === 0 ? 0 : 2)} 万元`;
  return `${amount} 元`;
}

/** 把 checkSummary 翻译成可读展示；这里不做任何判定，只做文案 */
function decorateCheck(ticket) {
  const s = ticket.checkSummary;
  if (!s || !s.checkStatus) {
    return { hasCheck: false, title: '尚未核对', tone: 'none', detail: '', amountText: '' };
  }
  if (s.checkStatus === 'pending_manual_review') {
    return {
      hasCheck: true,
      title: '待人工核验',
      tone: 'warn',
      detail: PENDING_TEXT[s.pendingReason] || '存在需要人工确认的情况。',
      amountText: '',
      hitNumbers: s.hitNumbers || [],
      checkedAt: s.checkedAt,
    };
  }
  if (s.checkStatus === 'not_winner') {
    return {
      hasCheck: true,
      title: '未中奖',
      tone: 'plain',
      detail:
        ticket.game === 'ssq'
          ? `命中 ${s.hitRed === null || s.hitRed === undefined ? '-' : s.hitRed} 个红球${s.hitBlue ? ' + 蓝球' : ''}`
          : `命中 ${s.hitCount === null || s.hitCount === undefined ? '-' : s.hitCount} 个号码`,
      amountText: '',
      hitNumbers: s.hitNumbers || [],
      checkedAt: s.checkedAt,
    };
  }
  const label =
    ticket.game === 'ssq'
      ? SSQ_LEVEL_LABEL[s.prizeLevel] || `${s.prizeLevel} 等奖`
      : `选十中 ${s.prizeLevel}`;
  return {
    hasCheck: true,
    title: `中奖：${label}`,
    tone: 'win',
    detail:
      ticket.game === 'ssq'
        ? `命中 ${s.hitRed} 红${s.hitBlue ? ' + 蓝球' : ''}`
        : `命中 ${s.hitCount} 个号码`,
    amountText:
      s.totalPrize === null || s.totalPrize === undefined
        ? `单注${yuanText(s.unitPrize)}（待官方公告）`
        : `${yuanText(s.totalPrize)}${s.quantity > 1 ? `（${s.quantity} 注）` : ''}`,
    hitNumbers: s.hitNumbers || [],
    checkedAt: s.checkedAt,
    ruleVersion: s.ruleVersion,
  };
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

Page({
  data: {
    loading: true,
    error: '',
    ticket: null,
    statusText: '',
    isDraft: false,
    isConfirmed: false,
    isVoid: false,
    redBalls: [],
    blueBall: null,
    isKl8: false,
    confirmOpen: false,
    costInput: '',
    costPlaceholder: '实际支付金额',
    multipleInput: 1,
    purchaseDate: '',
    editNoteOpen: false,
    noteInput: '',
    costEditInput: '',
    busy: false,
    check: { hasCheck: false, title: '尚未核对', tone: 'none', detail: '', amountText: '' },
    checking: false,
  },

  onLoad(query) {
    this.ticketId = query.ticketId;
    this.setData({ purchaseDate: today() });
    this.load();
  },

  onShow() {
    if (!this.data.loading && this.ticketId) this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    const res = await api.call('queryTickets', { mode: 'detail', ticketId: this.ticketId });
    if (!res.success) {
      this.setData({ loading: false, error: res.message || '加载失败' });
      return;
    }
    this.apply(res.data.item);
    this.setData({ loading: false });
  },

  apply(t) {
    const numbers = t.numbers || {};
    const suggestion = suggestCost(t.game, t.multiple || 1);
    this.setData({
      ticket: t,
      check: decorateCheck(t),
      isKl8: t.game === GAME.KL8,
      gameName: (GAME_META[t.game] || {}).shortName || t.game,
      redBalls: t.game === GAME.SSQ ? numbers.red || [] : numbers.kl8 || [],
      blueBall: t.game === GAME.SSQ ? numbers.blue : null,
      statusText: STATUS_TEXT[t.purchaseStatus] || t.purchaseStatus,
      isDraft: t.purchaseStatus === 'draft',
      isConfirmed: t.purchaseStatus === 'confirmed',
      isVoid: t.purchaseStatus === 'void',
      costPlaceholder:
        suggestion.value === null ? '实际支付金额' : `如 ${suggestion.value} 元（可修改）`,
      costInput: t.actualCost === null || t.actualCost === undefined ? '' : String(t.actualCost),
      multipleInput: t.multiple || 1,
      noteInput: t.note || '',
      costEditInput: t.actualCost === null || t.actualCost === undefined ? '' : String(t.actualCost),
    });
  },

  openConfirm() {
    this.setData({ confirmOpen: true });
  },

  closeConfirm() {
    this.setData({ confirmOpen: false });
  },

  onCostInput(e) {
    this.setData({ costInput: e.detail.value });
  },

  onMultipleInput(e) {
    this.setData({ multipleInput: e.detail.value });
  },

  onCostEditInput(e) {
    this.setData({ costEditInput: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ noteInput: e.detail.value });
  },

  onDateChange(e) {
    this.setData({ purchaseDate: e.detail.value });
  },

  async doConfirm() {
    if (this.data.busy) return;
    const cost = Number(this.data.costInput);
    if (this.data.costInput === '' || !Number.isFinite(cost) || cost < 0) {
      wx.showToast({ title: '请填写实际支付金额（赠票填 0）', icon: 'none' });
      return;
    }
    this.setData({ busy: true });
    const res = await api.call('ticketService', {
      action: 'confirm',
      ticketId: this.ticketId,
      payload: {
        actualCost: cost,
        multiple: Number(this.data.multipleInput) || 1,
        purchaseAt: `${this.data.purchaseDate}T12:00:00+08:00`,
      },
    });
    this.setData({ busy: false });

    if (!res.success) {
      wx.showModal({ title: '确认失败', content: res.message, showCancel: false });
      return;
    }
    this.apply(res.data.ticket);
    this.setData({ confirmOpen: false });
    wx.showToast({ title: '已确认购买', icon: 'success' });
  },

  async doSaveNote() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    const res = await api.call('ticketService', {
      action: 'update',
      ticketId: this.ticketId,
      patch: {
        note: this.data.noteInput,
        actualCost: this.data.costEditInput === '' ? null : Number(this.data.costEditInput),
      },
    });
    this.setData({ busy: false });
    if (!res.success) {
      wx.showModal({ title: '保存失败', content: res.message, showCancel: false });
      return;
    }
    this.apply(res.data.ticket);
    this.setData({ editNoteOpen: false });
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  doVoid() {
    wx.showModal({
      title: '作废这条记录？',
      content: '作废后不再计入花费与中奖统计，记录本身会保留以便追溯。',
      confirmText: '作废',
      confirmColor: '#c62828',
      success: async (r) => {
        if (!r.confirm) return;
        const res = await api.call('ticketService', { action: 'void', ticketId: this.ticketId });
        if (!res.success) {
          wx.showModal({ title: '作废失败', content: res.message, showCancel: false });
          return;
        }
        this.apply(res.data.ticket);
        wx.showToast({ title: '已作废', icon: 'success' });
      },
    });
  },

  doDelete() {
    wx.showModal({
      title: '永久删除？',
      content: '删除后无法恢复。若只是想让它不计入统计，请用「作废」。',
      confirmText: '删除',
      confirmColor: '#c62828',
      success: async (r) => {
        if (!r.confirm) return;
        const res = await api.call('ticketService', { action: 'delete', ticketId: this.ticketId });
        if (!res.success) {
          wx.showModal({ title: '删除失败', content: res.message, showCancel: false });
          return;
        }
        wx.showToast({ title: '已删除', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 500);
      },
    });
  },

  async onCheck() {
    if (this.data.checking) return;
    this.setData({ checking: true });
    const res = await api.call('checkTickets', { ticketId: this.ticketId });
    this.setData({ checking: false });

    if (!res.success) {
      wx.showModal({ title: '核对失败', content: res.message, showCancel: false });
      return;
    }
    if (res.data.skipped > 0 && res.data.inserted === 0 && res.data.unchanged === 0) {
      wx.showModal({
        title: '还无法核对',
        content: '该期开奖数据尚未同步或尚未通过核验。请先到「开奖」页同步官方数据。',
        showCancel: false,
      });
      return;
    }
    wx.showToast({ title: '已核对', icon: 'success' });
    this.load();
  },

  goEdit() {
    wx.navigateTo({ url: `/pages/ticket-edit/index?ticketId=${this.ticketId}` });
  },

  toggleNoteEdit() {
    this.setData({ editNoteOpen: !this.data.editNoteOpen });
  },
});

const api = require('../../services/api');
const { GAME, GAME_META } = require('../../shared/constants/games');
const { validateNumbers, formatDisplay } = require('../../shared/validators/numbers');
const { suggestCost, isValidIssue } = require('../../shared/rules/registry');

function buildCells(from, to, selected) {
  const set = new Set(selected || []);
  const cells = [];
  for (let n = from; n <= to; n += 1) {
    cells.push({ n, label: String(n).padStart(2, '0'), selected: set.has(n) });
  }
  return cells;
}

function pickRandom(from, to, count) {
  const pool = [];
  for (let n = from; n <= to; n += 1) pool.push(n);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).sort((a, b) => a - b);
}

Page({
  data: {
    mode: 'create',
    ticketId: '',
    status: 'draft',
    game: GAME.SSQ,
    gameName: '双色球',
    issue: '',
    red: [],
    blue: null,
    kl8: [],
    redCells: [],
    blueCells: [],
    kl8Cells: [],
    redCount: 0,
    kl8Count: 0,
    multiple: 1,
    cost: '',
    costPlaceholder: '按实际支付填写',
    costHint: '',
    note: '',
    saving: false,
    loading: false,
    displayText: '',
  },

  onLoad(query) {
    const ticketId = query && query.ticketId;
    this.idempotencyKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    if (ticketId) {
      this.setData({ mode: 'edit', ticketId, loading: true });
      this.loadTicket(ticketId);
    } else {
      this.setData({ game: GAME.SSQ, gameName: GAME_META[GAME.SSQ].shortName });
      this.resetGrid(this.data.game, [], null, []);
      this.refreshCostHint();
    }
  },

  async loadTicket(ticketId) {
    const res = await api.call('queryTickets', { mode: 'detail', ticketId });
    if (!res.success) {
      this.setData({ loading: false });
      wx.showModal({ title: '无法打开', content: res.message, showCancel: false });
      return;
    }
    const t = res.data.item;
    if (t.purchaseStatus !== 'draft') {
      this.setData({ loading: false });
      wx.showModal({
        title: '不可编辑',
        content: '已购买或已作废的记录不能改号码。如需更正，请作废后新建。',
        showCancel: false,
        success: () => wx.navigateBack(),
      });
      return;
    }
    this.setData({
      loading: false,
      status: t.purchaseStatus,
      game: t.game,
      gameName: (GAME_META[t.game] || {}).shortName || t.game,
      issue: t.issue,
      multiple: t.multiple || 1,
      cost: t.actualCost === null || t.actualCost === undefined ? '' : String(t.actualCost),
      note: t.note || '',
    });
    this.resetGrid(t.game, t.numbers.red || [], t.numbers.blue, t.numbers.kl8 || []);
    this.refreshCostHint();
  },

  switchGame(e) {
    if (this.data.mode === 'edit') return;
    const game = e.currentTarget.dataset.game;
    if (game === this.data.game) return;
    this.setData({ game, gameName: GAME_META[game].shortName });
    this.resetGrid(game, [], null, []);
    this.refreshCostHint();
  },

  /** 用给定号码重建网格；不传则全部清空 */
  resetGrid(game, red, blue, kl8) {
    if (game === GAME.SSQ) {
      const redSel = red || [];
      const blueSel = blue === null || blue === undefined ? [] : [blue];
      this.setData({
        red: redSel,
        blue: blue === null || blue === undefined ? null : blue,
        kl8: [],
        redCells: buildCells(1, 33, redSel),
        blueCells: buildCells(1, 16, blueSel),
        kl8Cells: [],
        redCount: redSel.length,
        kl8Count: 0,
        displayText: redSel.length ? formatDisplay(game, { red: redSel, blue, kl8: [] }) : '',
      });
    } else {
      const kl8Sel = kl8 || [];
      this.setData({
        red: [],
        blue: null,
        kl8: kl8Sel,
        redCells: [],
        blueCells: [],
        kl8Cells: buildCells(1, 80, kl8Sel),
        redCount: 0,
        kl8Count: kl8Sel.length,
        displayText: kl8Sel.length ? formatDisplay(game, { red: [], blue: null, kl8: kl8Sel }) : '',
      });
    }
  },

  tapRed(e) {
    const n = Number(e.currentTarget.dataset.n);
    const red = this.data.red.slice();
    const idx = red.indexOf(n);
    if (idx >= 0) {
      red.splice(idx, 1);
    } else if (red.length >= 6) {
      wx.showToast({ title: '红球已选满 6 个', icon: 'none' });
      return;
    } else {
      red.push(n);
    }
    red.sort((a, b) => a - b);
    this.resetGrid(GAME.SSQ, red, this.data.blue, []);
  },

  tapBlue(e) {
    const n = Number(e.currentTarget.dataset.n);
    const next = this.data.blue === n ? null : n;
    this.resetGrid(GAME.SSQ, this.data.red, next, []);
  },

  tapKl8(e) {
    const n = Number(e.currentTarget.dataset.n);
    const kl8 = this.data.kl8.slice();
    const idx = kl8.indexOf(n);
    if (idx >= 0) {
      kl8.splice(idx, 1);
    } else if (kl8.length >= 10) {
      wx.showToast({ title: '快乐8 选十只能选 10 个', icon: 'none' });
      return;
    } else {
      kl8.push(n);
    }
    kl8.sort((a, b) => a - b);
    this.resetGrid(GAME.KL8, [], null, kl8);
  },

  onRandom() {
    if (this.data.game === GAME.SSQ) {
      this.resetGrid(GAME.SSQ, pickRandom(1, 33, 6), pickRandom(1, 16, 1)[0], []);
    } else {
      this.resetGrid(GAME.KL8, [], null, pickRandom(1, 80, 10));
    }
  },

  onClear() {
    this.resetGrid(this.data.game, [], null, []);
  },

  onIssueInput(e) {
    this.setData({ issue: e.detail.value.trim() });
  },

  onMultipleChange(e) {
    const multiple = Math.max(1, Math.min(99, Number(e.detail.value) || 1));
    this.setData({ multiple });
    this.refreshCostHint();
  },

  onCostInput(e) {
    this.setData({ cost: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  /**
   * 金额提示：双色球单价已核对，给出建议值；快乐8 未核对，不给数字只给说明。
   * 建议值只作占位提示，绝不自动写入 actualCost。
   */
  refreshCostHint() {
    const s = suggestCost(this.data.game, this.data.multiple);
    this.setData({
      costPlaceholder: s.value === null ? '按实际支付填写' : `如 ${s.value} 元`,
      costHint: s.verified ? s.source : `${s.source}（请按实际支付填写）`,
    });
  },

  validateBeforeSave() {
    if (!isValidIssue(this.data.issue)) {
      wx.showToast({ title: '期号需为 7 位数字', icon: 'none' });
      return null;
    }
    const numbers =
      this.data.game === GAME.SSQ
        ? { red: this.data.red, blue: this.data.blue }
        : { kl8: this.data.kl8 };
    const check = validateNumbers(this.data.game, numbers);
    if (!check.ok) {
      wx.showToast({ title: check.message, icon: 'none' });
      return null;
    }
    return check.normalized;
  },

  async onSave() {
    if (this.data.saving) return;
    const numbers = this.validateBeforeSave();
    if (!numbers) return;

    this.setData({ saving: true });
    const payload = {
      game: this.data.game,
      issue: this.data.issue,
      numbers,
      multiple: this.data.multiple,
      actualCost: this.data.cost === '' ? null : Number(this.data.cost),
      note: this.data.note,
    };

    let res;
    if (this.data.mode === 'edit') {
      res = await api.call('ticketService', {
        action: 'update',
        ticketId: this.data.ticketId,
        patch: payload,
      });
    } else {
      res = await api.call('ticketService', {
        action: 'create',
        ticket: { ...payload, idempotencyKey: this.idempotencyKey },
      });
    }

    this.setData({ saving: false });

    if (!res.success) {
      wx.showModal({ title: '保存失败', content: res.message, showCancel: false });
      return;
    }

    wx.showToast({ title: this.data.mode === 'edit' ? '已保存' : '已存为草稿', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 600);
  },
});

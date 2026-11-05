const api = require('../../services/api');
const { DISCLAIMER, DEFAULT_FEATURE_FLAGS } = require('../../shared/constants/games');

const REASON_TEXT = {
  NO_OPENID: '未获取到 OpenID（请确认在微信环境中运行）',
  NOT_IN_WHITELIST: '当前 OpenID 不在白名单中',
  NO_OWNER_CONFIGURED: '服务端尚未配置所有者 OpenID',
  CLOUD_UNAVAILABLE: '云函数未部署或云环境不可用',
  ALLOWED: '已通过校验',
};

Page({
  data: {
    disclaimer: DISCLAIMER,
    version: '0.5.0 (阶段 5)',
    auth: {},
    authText: '',
    flags: DEFAULT_FEATURE_FLAGS,
    checking: false,
    initializing: false,
    initResult: null,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const app = getApp();
    const auth = (app && app.globalData.auth) || {};
    const flags = (app && app.globalData.featureFlags) || DEFAULT_FEATURE_FLAGS;
    this.setData({
      auth,
      authText: REASON_TEXT[auth.reason] || (auth.allowed ? '已通过校验' : '未校验'),
      flags,
    });
  },

  recheck() {
    const app = getApp();
    this.setData({ checking: true });
    app
      .checkAuth()
      .then(() => {
        this.setData({ checking: false });
        this.refresh();
        wx.showToast({ title: '已重新校验', icon: 'none' });
      })
      .catch(() => this.setData({ checking: false }));
  },

  copyOpenid() {
    const openid = this.data.auth.openid;
    if (!openid) {
      wx.showToast({ title: '暂无 OpenID', icon: 'none' });
      return;
    }
    wx.setClipboardData({ data: openid });
  },

  /**
   * 一键初始化：建 8 个集合、写 app_config（把当前 OpenID 加白名单）、灌规则种子。
   * 索引无法通过 SDK 创建，结果里会给出清单。
   */
  async runInit() {
    if (this.data.initializing) return;

    if (!this.data.auth.allowed) {
      wx.showModal({
        title: '需要先通过身份校验',
        content:
          '首次使用请先打开云开发控制台 → 云函数 → authCheck → 配置 → 环境变量，添加 OWNER_OPENID 为你的 OpenID，然后回来点「重新校验」，再来点这里。',
        showCancel: false,
      });
      return;
    }

    this.setData({ initializing: true, initResult: null });
    const res = await api.call('initDb', {});
    this.setData({ initializing: false });

    if (!res.success) {
      wx.showModal({
        title: '初始化失败',
        content: `${res.message}\n\n若提示 SDK 不支持自动建集合，请到云开发控制台手动创建 8 个集合。`,
        showCancel: false,
      });
      return;
    }

    const d = res.data;
    const lines = [
      `新建集合：${d.created.length} 个`,
      `已存在：${d.existed.length} 个`,
      `配置：${d.config.seeded ? '已写入（含你的 OpenID）' : '已存在，未改动'}`,
      `规则种子：${d.rules.seeded ? `写入 ${d.rules.seeded} 条` : '已存在，未改动'}`,
    ];
    if (d.failed && d.failed.length) {
      lines.push(`失败：${d.failed.map((f) => f.name).join('、')}`);
    }

    this.setData({ initResult: d });
    wx.showModal({
      title: '初始化完成',
      content: `${lines.join('\n')}\n\n还剩索引要在控制台手动建，清单见本页下方。`,
      showCancel: false,
    });

    getApp().checkAuth();
  },

  showTodo() {
    wx.showModal({
      title: '后续阶段',
      content: '统计图表、导出、备份与恢复将在阶段 7 开放。',
      showCancel: false,
    });
  },
});

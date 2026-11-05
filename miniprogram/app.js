/**
 * 竞彩助手 · 小程序入口
 * 职责：初始化云开发 → 服务端鉴权 → 写入全局状态（供页面读取展示）。
 * 注意：globalData 中的 auth/featureFlags 仅用于界面展示，不能作为授权依据；
 *       所有业务判定必须在云函数内重新执行（见 shared/security/access.js）。
 */
const { DEFAULT_FEATURE_FLAGS } = require('./shared/constants/games');

App({
  globalData: {
    /** @type {{checked:boolean, allowed:boolean, reason:string, openid:string, authSource:string, degraded:boolean, errorMessage:string}} */
    auth: {
      checked: false,
      allowed: false,
      reason: '',
      openid: '',
      authSource: '',
      degraded: false,
      errorMessage: '',
    },
    featureFlags: Object.assign({}, DEFAULT_FEATURE_FLAGS),
    candidateGenerationEnabled: false,
    envReady: false,
  },

  onLaunch() {
    this.initCloud();
    this.authReady = this.checkAuth();
  },

  initCloud() {
    if (!wx.cloud) {
      console.error('[app] 当前基础库不支持云开发，请升级微信客户端');
      this.globalData.auth.degraded = true;
      this.globalData.auth.errorMessage = '当前基础库不支持云开发';
      return;
    }
    try {
      // 不指定 env 时使用开发者工具中选择的默认环境；也可通过 TCB_ENV_ID 显式指定
      wx.cloud.init({ traceUser: false });
      this.globalData.envReady = true;
    } catch (err) {
      console.error('[app] 云开发初始化失败', err);
      this.globalData.auth.degraded = true;
      this.globalData.auth.errorMessage = '云开发初始化失败，请检查环境配置';
    }
  },

  /**
   * 调用 authCheck 云函数。失败时不阻塞界面渲染，但标记 degraded，
   * 由页面显示"云端未连接"横幅——绝不把未鉴权状态伪装成已授权。
   */
  checkAuth() {
    return new Promise((resolve) => {
      if (!this.globalData.envReady) {
        this.globalData.auth.checked = true;
        this.globalData.auth.allowed = false;
        this.globalData.auth.degraded = true;
        this.globalData.auth.reason = 'CLOUD_UNAVAILABLE';
        resolve(this.globalData.auth);
        return;
      }
      wx.cloud
        .callFunction({ name: 'authCheck', data: {} })
        .then((res) => {
          const payload = (res && res.result) || {};
          const data = payload.data || {};
          this.globalData.auth = {
            checked: true,
            allowed: payload.success === true && data.allowed === true,
            reason: data.reason || payload.code || '',
            openid: data.openid || '',
            authSource: data.authSource || '',
            degraded: false,
            errorMessage: '',
          };
          if (data.flags) this.globalData.featureFlags = data.flags;
          // 仅用于隐藏入口；真正是否放行由云函数按同一开关重新判定
          this.globalData.candidateGenerationEnabled = Boolean(
            data.gates && data.gates.candidateGeneration
          );
          resolve(this.globalData.auth);
        })
        .catch((err) => {
          console.error('[app] authCheck 调用失败', err);
          this.globalData.auth = {
            checked: true,
            allowed: false,
            reason: 'CLOUD_UNAVAILABLE',
            openid: '',
            authSource: '',
            degraded: true,
            errorMessage: '云函数未部署或网络不可用',
          };
          resolve(this.globalData.auth);
        });
    });
  },

  /** 需要页面进入前确认权限时使用 */
  ensureAuthorized() {
    if (this.authReady) return this.authReady;
    return this.checkAuth();
  },
});

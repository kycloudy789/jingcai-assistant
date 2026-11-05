Page({
  data: {
    openid: '',
    reason: '',
  },

  onShow() {
    const auth = (getApp().globalData.auth) || {};
    this.setData({ openid: auth.openid || '', reason: auth.reason || '' });
  },

  copyOpenid() {
    if (!this.data.openid) {
      wx.showToast({ title: '暂无 OpenID', icon: 'none' });
      return;
    }
    wx.setClipboardData({ data: this.data.openid });
  },

  retry() {
    getApp()
      .checkAuth()
      .then((auth) => {
        if (auth.allowed) {
          wx.switchTab({ url: '/pages/home/index' });
        } else {
          this.setData({ openid: auth.openid || '', reason: auth.reason || '' });
          wx.showToast({ title: '仍未通过校验', icon: 'none' });
        }
      });
  },
});

const api = require('../../services/api');
const { DISCLAIMER } = require('../../shared/constants/games');

const SUGGESTIONS = [
  '最新一期双色球开奖号码是多少？',
  '我最近买了哪些号码？花了多少钱？',
  '快乐8 选十中 8 个是多少钱？',
  '帮我看看我最近的核对结果',
];

const ERROR_TEXT = {
  AI_NOT_CONFIGURED: '云端还没配置 DEEPSEEK_API_KEY，AI 功能暂不可用。其他功能不受影响。',
  AI_DISABLED: 'AI 功能已在服务端关闭。',
  AI_AUTH_FAILED: 'AI 服务鉴权失败，请检查云端密钥是否有效。',
  AI_QUOTA: 'AI 账户余额不足。',
  AI_RATE_LIMIT: '请求太频繁，稍等几秒再试。',
  AI_UPSTREAM: 'AI 服务暂时不可用，稍后再试。',
  AI_TIMEOUT: 'AI 响应超时，可以再问一次或换个问法。',
  AI_NETWORK: '网络异常，请检查后重试。',
  BAD_MESSAGE: '消息不符合要求（不能为空、不超过 1000 字）。',
};

Page({
  data: {
    messages: [],
    input: '',
    sending: false,
    sessionId: '',
    error: '',
    suggestions: SUGGESTIONS,
    disclaimer: DISCLAIMER,
    authorized: false,
  },

  onShow() {
    const app = getApp();
    const authorized = Boolean(app.globalData.auth && app.globalData.auth.allowed);
    this.setData({ authorized });
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  useSuggestion(e) {
    const text = e.currentTarget.dataset.text;
    this.setData({ input: text });
    this.send();
  },

  newSession() {
    this.setData({ sessionId: '', messages: [], error: '' });
  },

  scrollToBottom() {
    const last = this.data.messages.length - 1;
    if (last < 0) return;
    wx.pageScrollTo({ scrollTop: 999999, duration: 200 });
  },

  async send() {
    if (this.data.sending) return;
    const text = (this.data.input || '').trim();
    if (!text) {
      wx.showToast({ title: '说点什么吧', icon: 'none' });
      return;
    }
    if (text.length > 1000) {
      wx.showToast({ title: '消息太长了（上限 1000 字）', icon: 'none' });
      return;
    }

    const messages = this.data.messages.concat([{ id: `u${Date.now()}`, role: 'user', content: text, tools: [] }]);
    this.setData({ messages, input: '', sending: true, error: '' });
    this.scrollToBottom();

    const res = await api.call('aiChat', { sessionId: this.data.sessionId || undefined, message: text });

    if (!res.success) {
      this.setData({
        sending: false,
        error: ERROR_TEXT[res.code] || res.message || 'AI 暂时不可用',
      });
      return;
    }

    const toolNames = (res.data.toolCalls || []).map((t) => t.name).filter(Boolean);
    this.setData({
      sending: false,
      sessionId: res.data.sessionId || this.data.sessionId,
      messages: this.data.messages.concat([
        { id: `a${Date.now()}`, role: 'assistant', content: res.data.reply || '（没有内容）', tools: toolNames },
      ]),
    });
    this.scrollToBottom();
  },
});

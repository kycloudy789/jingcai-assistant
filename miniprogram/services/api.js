/**
 * 云函数调用封装：统一返回结构、错误码、requestId 透传。
 * 未通过服务端鉴权时拒绝发起业务调用（前端第一道闸，服务端仍会二次校验）。
 */
const { buildRequestId } = require('../shared/utils/response');

const MESSAGES = {
  AUTH_REQUIRED: '未通过身份校验，请先在设置中确认白名单',
  FEATURE_DISABLED: '该功能当前未开放',
  CLOUD_UNAVAILABLE: '云端未连接，请检查云开发环境',
  NETWORK_ERROR: '网络异常，请稍后重试',
  NOT_IMPLEMENTED: '该功能尚未实现（当前阶段未开放）',
};

function isAuthorized() {
  const app = getApp();
  return Boolean(app && app.globalData && app.globalData.auth && app.globalData.auth.allowed);
}

/**
 * @param {string} name 云函数名
 * @param {object} data 入参
 * @returns {Promise<{success:boolean, code:string, message:string, data:any, requestId:string}>}
 */
function call(name, data = {}) {
  const requestId = buildRequestId();
  if (!isAuthorized()) {
    return Promise.resolve({
      success: false,
      code: 'AUTH_REQUIRED',
      message: MESSAGES.AUTH_REQUIRED,
      data: null,
      requestId,
    });
  }

  return new Promise((resolve) => {
    wx.cloud.callFunction({
      name,
      data: Object.assign({}, data, { requestId }),
      success: (res) => {
        const payload = (res && res.result) || {};
        resolve({
          success: payload.success === true,
          code: payload.code || (payload.success ? 'OK' : 'UNKNOWN_ERROR'),
          message: payload.message || '',
          data: payload.data === undefined ? null : payload.data,
          requestId: payload.requestId || requestId,
        });
      },
      fail: (err) => {
        console.error(`[api] ${name} 调用失败`, err);
        resolve({
          success: false,
          code: 'NETWORK_ERROR',
          message: MESSAGES.NETWORK_ERROR,
          data: null,
          requestId,
        });
      },
    });
  });
}

/** 尚未实现的能力统一返回 NOT_IMPLEMENTED，避免前端出现假数据 */
function notImplemented(feature) {
  console.warn(`[api] 功能未实现: ${feature}`);
  return Promise.resolve({
    success: false,
    code: 'NOT_IMPLEMENTED',
    message: MESSAGES.NOT_IMPLEMENTED,
    data: null,
    requestId: buildRequestId(),
  });
}

module.exports = { call, notImplemented, isAuthorized, MESSAGES };

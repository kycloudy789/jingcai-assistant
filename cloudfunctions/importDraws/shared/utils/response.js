/**
 * 统一返回结构（主方案 12.2）。
 * 失败时不回传堆栈、连接串、密钥等内部信息。
 */

function buildRequestId(prefix = 'req') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

function ok(data = {}, requestId = buildRequestId()) {
  return { success: true, code: 'OK', message: 'ok', data, requestId };
}

function fail(code, message, requestId = buildRequestId(), extra = {}) {
  return {
    success: false,
    code: code || 'UNKNOWN_ERROR',
    message: message || '请求失败',
    data: Object.keys(extra).length ? extra : null,
    requestId,
  };
}

/** 把异常收敛为可读信息，避免堆栈外泄 */
function fromError(error, fallbackCode = 'INTERNAL_ERROR') {
  const message =
    error && typeof error.message === 'string' && error.message.length <= 200
      ? error.message
      : '服务暂时不可用，请稍后重试';
  return fail(fallbackCode, message);
}

module.exports = { buildRequestId, ok, fail, fromError };

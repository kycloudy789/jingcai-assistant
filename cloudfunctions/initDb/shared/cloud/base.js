/**
 * 云函数通用外壳（仅云端使用，不打包进小程序）。
 * 统一做三件事：解析真实 OpenID → 白名单校验 → 统一返回结构。
 */

const cloud = require('wx-server-sdk');
const { resolveOwner } = require('../security/access');
const { ok, fail, fromError, buildRequestId } = require('../utils/response');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const CONFIG_DOC_ID = 'global';

/**
 * 读取服务端配置。集合不存在时返回 null，由调用方回退到环境变量。
 * 注意：任何"前端传进来的开关"都不参与这里的判定。
 */
async function loadAppConfig() {
  try {
    const res = await cloud.database().collection('app_config').doc(CONFIG_DOC_ID).get();
    return res.data || null;
  } catch (err) {
    return null;
  }
}

/**
 * @param {string} name 云函数名（用于日志）
 * @param {(ctx: object) => Promise<object>} handler 业务处理；返回值会被包装成统一结构
 */
function createHandler(name, handler) {
  return async (event, context) => {
    const requestId = (event && event.requestId) || buildRequestId(name);
    try {
      const wxContext = cloud.getWXContext();
      const openid = wxContext.OPENID;
      const config = await loadAppConfig();

      const owner = resolveOwner(openid, {
        whitelist: config && config.ownerWhitelist,
        envOwner: process.env.OWNER_OPENID,
      });

      if (!owner.allowed) {
        console.warn(`[${name}] 拒绝非白名单访问 reason=${owner.reason}`);
        return fail('AUTH_DENIED', '未通过身份校验', requestId, { reason: owner.reason });
      }

      const result = await handler({
        event: event || {},
        context,
        openid,
        config: config || {},
        requestId,
      });

      if (result && typeof result === 'object' && typeof result.success === 'boolean') {
        return result;
      }
      return ok(result === undefined ? {} : result, requestId);
    } catch (err) {
      // 只记录可读信息，绝不打印密钥/连接串
      console.error(`[${name}] 处理失败 requestId=${requestId}`, err && err.message);
      const payload = fromError(err);
      payload.requestId = requestId;
      return payload;
    }
  };
}

module.exports = { cloud, createHandler, loadAppConfig, CONFIG_DOC_ID };

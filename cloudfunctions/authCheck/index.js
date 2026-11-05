/**
 * authCheck —— 单用户身份校验（阶段 1）
 *
 * 输入：无（仅可选的 requestId）。OpenID 只从运行上下文读取，绝不接受前端传入。
 * 输出：{ success, code, message, data: { allowed, reason, authSource, openid, flags, gates }, requestId }
 *
 * 配置来源优先级：
 *   1. app_config 集合 doc('global').ownerWhitelist（阶段 2 建库后生效）
 *   2. 环境变量 OWNER_OPENID（阶段 1 过渡）
 *   3. 都没有 → 一律拒绝（fail-closed）
 */
const cloud = require('wx-server-sdk');
const { resolveOwner, resolveCandidateGate, REASON } = require('./shared/security/access');
const { DEFAULT_FEATURE_FLAGS, GAME } = require('./shared/constants/games');
const { ok, fail, fromError, buildRequestId } = require('./shared/utils/response');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const CONFIG_DOC_ID = 'global';

/** 读取服务端配置；集合或文档不存在属于预期情况，返回 null 交给回退逻辑 */
async function loadAppConfig() {
  try {
    const res = await cloud.database().collection('app_config').doc(CONFIG_DOC_ID).get();
    return res && res.data ? res.data : null;
  } catch (err) {
    console.warn('[authCheck] app_config 不可读，回退环境变量:', err && err.errCode);
    return null;
  }
}

function mergeFlags(config) {
  const source = config || {};
  return {
    wxComplianceStatus: source.wxComplianceStatus || DEFAULT_FEATURE_FLAGS.wxComplianceStatus,
    candidateGenerationEnabled: source.candidateGenerationEnabled === true,
    aiFutureNumberFeatureEnabled: source.aiFutureNumberFeatureEnabled === true,
    productionFeaturePolicy:
      source.productionFeaturePolicy || DEFAULT_FEATURE_FLAGS.productionFeaturePolicy,
    aiEnabled: source.aiEnabled !== false,
    modelName: source.modelName || null,
    supportedGames: [GAME.SSQ, GAME.KL8],
  };
}

exports.main = async (event) => {
  const requestId = (event && event.requestId) || buildRequestId('auth');
  try {
    const { OPENID, APPID } = cloud.getWXContext();
    if (!OPENID) {
      return fail('NO_OPENID', '未获取到 OpenID，请在微信客户端内访问', requestId);
    }

    const config = await loadAppConfig();
    const verdict = resolveOwner(OPENID, {
      whitelist: config && config.ownerWhitelist,
      envOwner: process.env.OWNER_OPENID,
    });

    const flags = mergeFlags(config);
    const gates = resolveCandidateGate(flags);

    // 仅记录非敏感信息，不记录密钥
    console.log('[authCheck]', {
      requestId,
      appid: APPID,
      allowed: verdict.allowed,
      reason: verdict.reason,
      authSource: verdict.authSource,
    });

    if (!verdict.allowed) {
      // 拒绝时仍返回 openid，便于本人把它加入白名单；不返回任何业务数据
      return {
        success: false,
        code: verdict.reason === REASON.NO_OWNER_CONFIGURED ? 'OWNER_NOT_CONFIGURED' : 'FORBIDDEN',
        message: '当前身份不在允许名单内',
        data: {
          allowed: false,
          reason: verdict.reason,
          authSource: verdict.authSource,
          openid: OPENID,
          flags,
          gates,
        },
        requestId,
      };
    }

    return ok(
      {
        allowed: true,
        reason: verdict.reason,
        authSource: verdict.authSource,
        openid: OPENID,
        flags,
        gates,
      },
      requestId
    );
  } catch (err) {
    console.error('[authCheck] 异常', { requestId, message: err && err.message });
    return fromError(err, 'AUTH_INTERNAL_ERROR');
  }
};

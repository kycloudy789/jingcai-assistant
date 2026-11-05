/**
 * 单用户访问控制（纯函数，便于单测与云函数复用）。
 * 规则（fail-closed）：
 *  1. openid 为空 → 拒绝；
 *  2. 白名单非空 → 只认白名单；
 *  3. 白名单为空但有 envOwner → 认 envOwner（阶段 1 过渡措施，见 decisions.md D6）；
 *  4. 两者皆空 → 拒绝。
 * 前端任何判断都不具备授权效力，只有服务端调用本函数得出的结果有效。
 */

const REASON = {
  ALLOWED: 'ALLOWED',
  NO_OPENID: 'NO_OPENID',
  NOT_IN_WHITELIST: 'NOT_IN_WHITELIST',
  NO_OWNER_CONFIGURED: 'NO_OWNER_CONFIGURED',
};

const AUTH_SOURCE = {
  WHITELIST: 'app_config.ownerWhitelist',
  ENV: 'env.OWNER_OPENID',
  NONE: 'none',
};

function normalizeWhitelist(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : String(list).split(/[\s,;]+/);
  return arr.map((x) => String(x || '').trim()).filter(Boolean);
}

/**
 * @param {string} openid 来自 wxContext.OPENID，不可由前端传入
 * @param {{whitelist?: string[]|string, envOwner?: string}} config
 * @returns {{allowed: boolean, reason: string, authSource: string}}
 */
function resolveOwner(openid, config = {}) {
  const id = String(openid || '').trim();
  if (!id) {
    return { allowed: false, reason: REASON.NO_OPENID, authSource: AUTH_SOURCE.NONE };
  }

  const whitelist = normalizeWhitelist(config.whitelist);
  if (whitelist.length > 0) {
    return whitelist.includes(id)
      ? { allowed: true, reason: REASON.ALLOWED, authSource: AUTH_SOURCE.WHITELIST }
      : { allowed: false, reason: REASON.NOT_IN_WHITELIST, authSource: AUTH_SOURCE.WHITELIST };
  }

  const envOwner = String(config.envOwner || '').trim();
  if (envOwner) {
    return envOwner === id
      ? { allowed: true, reason: REASON.ALLOWED, authSource: AUTH_SOURCE.ENV }
      : { allowed: false, reason: REASON.NOT_IN_WHITELIST, authSource: AUTH_SOURCE.ENV };
  }

  return { allowed: false, reason: REASON.NO_OWNER_CONFIGURED, authSource: AUTH_SOURCE.NONE };
}

/**
 * 合规闸门：候选号码生成 / AI 未来号码推荐是否可用。
 * 两个条件必须同时满足，缺一即关闭。
 * @param {{wxComplianceStatus?: string, candidateGenerationEnabled?: boolean, aiFutureNumberFeatureEnabled?: boolean}} flags
 */
function resolveCandidateGate(flags = {}) {
  const approved = flags.wxComplianceStatus === 'approved';
  return {
    candidateGeneration: approved && flags.candidateGenerationEnabled === true,
    aiFutureNumber: approved && flags.aiFutureNumberFeatureEnabled === true,
  };
}

module.exports = { REASON, AUTH_SOURCE, normalizeWhitelist, resolveOwner, resolveCandidateGate };

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
 * 合规状态取值。
 * 前四个用于微信小程序（需平台结论）；最后一个用于自托管静态站：
 * 没有平台可审批，只能由使用者本人显式确认"我知道这是随机组合、不代表更容易中"。
 * 两种状态不可混用——调用方必须显式传 acceptSelfAttested 才认最后一种。
 */
const COMPLIANCE_STATUS = {
  NOT_CHECKED: 'not_checked',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  SELF_ATTESTED: 'self_attested_personal_use',
};

const GATE_REASON = {
  OK: 'GATE_OK',
  COMPLIANCE_NOT_APPROVED: 'COMPLIANCE_NOT_APPROVED',
  CANDIDATE_DISABLED: 'CANDIDATE_DISABLED',
  AI_FUTURE_DISABLED: 'AI_FUTURE_DISABLED',
};

/**
 * 合规闸门：候选号码生成 / AI 未来号码推荐是否可用。
 * 两个条件必须同时满足，缺一即关闭（fail-closed）。
 *
 * @param {{wxComplianceStatus?: string, complianceState?: string, candidateGenerationEnabled?: boolean, aiFutureNumberFeatureEnabled?: boolean}} flags
 * @param {{acceptSelfAttested?: boolean}} [options] 仅自托管场景传 true；云函数不得传
 */
function resolveCandidateGate(flags = {}, options = {}) {
  const status = flags.wxComplianceStatus || flags.complianceState || COMPLIANCE_STATUS.NOT_CHECKED;
  const approvedByPlatform = status === COMPLIANCE_STATUS.APPROVED;
  const selfAttested =
    status === COMPLIANCE_STATUS.SELF_ATTESTED && options.acceptSelfAttested === true;
  const complianceOk = approvedByPlatform || selfAttested;

  const candidateGeneration = complianceOk && flags.candidateGenerationEnabled === true;
  const aiFutureNumber = complianceOk && flags.aiFutureNumberFeatureEnabled === true;

  let reason = GATE_REASON.OK;
  if (!complianceOk) reason = GATE_REASON.COMPLIANCE_NOT_APPROVED;
  else if (!candidateGeneration) reason = GATE_REASON.CANDIDATE_DISABLED;

  return {
    candidateGeneration,
    aiFutureNumber,
    complianceState: status,
    reason,
    selfAttested,
  };
}

module.exports = {
  REASON,
  AUTH_SOURCE,
  COMPLIANCE_STATUS,
  GATE_REASON,
  normalizeWhitelist,
  resolveOwner,
  resolveCandidateGate,
};

/**
 * 单用户访问控制与合规闸门测试（主方案 14.1 / 16.7 / 3.3）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveOwner,
  resolveCandidateGate,
  normalizeWhitelist,
  REASON,
  AUTH_SOURCE,
} = require('../shared/security/access');
const { ok, fail, fromError } = require('../shared/utils/response');

const OWNER = 'oOWNER_abc123';

test('白名单命中 → 允许', () => {
  const r = resolveOwner(OWNER, { whitelist: [OWNER] });
  assert.equal(r.allowed, true);
  assert.equal(r.authSource, AUTH_SOURCE.WHITELIST);
});

test('白名单未命中 → 拒绝', () => {
  const r = resolveOwner('oOTHER', { whitelist: [OWNER] });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, REASON.NOT_IN_WHITELIST);
});

test('白名单优先于环境变量（环境变量不能绕过白名单）', () => {
  const r = resolveOwner('oOTHER', { whitelist: [OWNER], envOwner: 'oOTHER' });
  assert.equal(r.allowed, false);
});

test('白名单为空时回退环境变量', () => {
  const r = resolveOwner(OWNER, { whitelist: [], envOwner: OWNER });
  assert.equal(r.allowed, true);
  assert.equal(r.authSource, AUTH_SOURCE.ENV);
});

test('无任何配置 → fail-closed 拒绝', () => {
  const r = resolveOwner(OWNER, {});
  assert.equal(r.allowed, false);
  assert.equal(r.reason, REASON.NO_OWNER_CONFIGURED);
});

test('openid 缺失 → 拒绝', () => {
  assert.equal(resolveOwner('', { whitelist: [OWNER] }).reason, REASON.NO_OPENID);
  assert.equal(resolveOwner(undefined, { envOwner: OWNER }).reason, REASON.NO_OPENID);
});

test('白名单字符串形式可解析（逗号/空格/分号）', () => {
  assert.deepEqual(normalizeWhitelist('a, b;c  d'), ['a', 'b', 'c', 'd']);
  const r = resolveOwner('b', { whitelist: 'a,b' });
  assert.equal(r.allowed, true);
});

test('合规闸门：未核准时任何开启意图都无效', () => {
  const g = resolveCandidateGate({
    wxComplianceStatus: 'not_checked',
    candidateGenerationEnabled: true,
    aiFutureNumberFeatureEnabled: true,
  });
  assert.equal(g.candidateGeneration, false);
  assert.equal(g.aiFutureNumber, false);
});

test('合规闸门：pending / rejected 同样关闭', () => {
  for (const status of ['pending', 'rejected']) {
    const g = resolveCandidateGate({
      wxComplianceStatus: status,
      candidateGenerationEnabled: true,
      aiFutureNumberFeatureEnabled: true,
    });
    assert.equal(g.candidateGeneration, false, status);
    assert.equal(g.aiFutureNumber, false, status);
  }
});

test('合规闸门：approved 但开关为 false 仍关闭', () => {
  const g = resolveCandidateGate({ wxComplianceStatus: 'approved' });
  assert.equal(g.candidateGeneration, false);
});

test('合规闸门：approved + 开关 true 才开放', () => {
  const g = resolveCandidateGate({
    wxComplianceStatus: 'approved',
    candidateGenerationEnabled: true,
    aiFutureNumberFeatureEnabled: true,
  });
  assert.equal(g.candidateGeneration, true);
  assert.equal(g.aiFutureNumber, true);
});

test('统一返回结构符合主方案 12.2', () => {
  const success = ok({ hello: 1 }, 'req_1');
  assert.deepEqual(Object.keys(success).sort(), ['code', 'data', 'message', 'requestId', 'success']);
  assert.equal(success.success, true);
  assert.equal(success.requestId, 'req_1');

  const failure = fail('NUM_COUNT', '号码数量不对', 'req_2');
  assert.equal(failure.success, false);
  assert.equal(failure.code, 'NUM_COUNT');
});

test('异常收敛不泄露堆栈', () => {
  const err = new Error('connect ECONNREFUSED 10.0.0.1:27017');
  err.stack = 'STACK_TRACE_SHOULD_NOT_LEAK';
  const payload = fromError(err);
  assert.equal(payload.success, false);
  assert.ok(!JSON.stringify(payload).includes('STACK_TRACE_SHOULD_NOT_LEAK'));
});

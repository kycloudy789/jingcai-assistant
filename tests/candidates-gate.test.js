/**
 * 候选功能的闸门测试：
 *   1. 默认关闭；三种"未批准"状态一律关闭；
 *   2. 自托管"本人确认"必须由调用方显式允许才生效（云函数不得传）；
 *   3. 工具 schema 与工具调用两层都拦——不靠提示词；
 *   4. 执行器在闸门关闭时返回 FEATURE_DISABLED，且不会写库。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  resolveCandidateGate,
  COMPLIANCE_STATUS,
  GATE_REASON,
} = require('../shared/security/access');
const {
  getToolSchemas,
  validateToolCall,
  GATED_TOOL_NAMES,
} = require('../shared/ai/tools');
const { createExecutors } = require('../shared/cloud/aiTools');
const { buildSystemPrompt, FUTURE_RULES, DISABLED_RULE } = require('../shared/ai/prompt');

/* ---------------- 闸门 ---------------- */

test('默认配置：未核实 + 开关关闭 → 全部关闭', () => {
  const g = resolveCandidateGate({});
  assert.equal(g.candidateGeneration, false);
  assert.equal(g.aiFutureNumber, false);
  assert.equal(g.reason, GATE_REASON.COMPLIANCE_NOT_APPROVED);
});

test('approved + 开关打开才放行', () => {
  const g = resolveCandidateGate({
    wxComplianceStatus: COMPLIANCE_STATUS.APPROVED,
    candidateGenerationEnabled: true,
    aiFutureNumberFeatureEnabled: true,
  });
  assert.equal(g.candidateGeneration, true);
  assert.equal(g.aiFutureNumber, true);
  assert.equal(g.reason, GATE_REASON.OK);
});

test('approved 但开关关闭 → 关闭，原因是开关而非合规', () => {
  const g = resolveCandidateGate({ wxComplianceStatus: COMPLIANCE_STATUS.APPROVED });
  assert.equal(g.candidateGeneration, false);
  assert.equal(g.reason, GATE_REASON.CANDIDATE_DISABLED);
});

test('自托管"本人确认"不显式允许时不生效（云函数保持严格）', () => {
  const flags = {
    wxComplianceStatus: COMPLIANCE_STATUS.SELF_ATTESTED,
    candidateGenerationEnabled: true,
    aiFutureNumberFeatureEnabled: true,
  };
  const strict = resolveCandidateGate(flags);
  assert.equal(strict.candidateGeneration, false, '未传 acceptSelfAttested 必须拒绝');
  assert.equal(strict.selfAttested, false);

  const web = resolveCandidateGate(flags, { acceptSelfAttested: true });
  assert.equal(web.candidateGeneration, true);
  assert.equal(web.aiFutureNumber, true);
  assert.equal(web.selfAttested, true);
  assert.equal(web.complianceState, COMPLIANCE_STATUS.SELF_ATTESTED);
});

test('pending / rejected / 空状态一律关闭', () => {
  for (const status of [COMPLIANCE_STATUS.PENDING, COMPLIANCE_STATUS.REJECTED, '', null]) {
    const g = resolveCandidateGate(
      { wxComplianceStatus: status, candidateGenerationEnabled: true },
      { acceptSelfAttested: true }
    );
    assert.equal(g.candidateGeneration, false, String(status));
  }
});

/* ---------------- 工具层 ---------------- */

test('闸门关闭：schema 里没有 generate_candidates', () => {
  const names = getToolSchemas().map((t) => t.function.name);
  assert.equal(names.includes('generate_candidates'), false);
  assert.equal(names.length, 7);
});

test('闸门开启：schema 多出 generate_candidates，且参数有 enum 约束', () => {
  const schemas = getToolSchemas({ futureNumbers: true });
  const tool = schemas.find((t) => t.function.name === 'generate_candidates');
  assert.ok(tool, '应包含生成工具');
  assert.deepEqual(tool.function.parameters.properties.game.enum, ['ssq', 'kl8']);
  assert.deepEqual(tool.function.parameters.properties.strategy.enum, ['random', 'balanced', 'preference']);
  assert.equal(tool.function.parameters.properties.count.maximum, 5);
  assert.equal(tool.function.parameters.additionalProperties, false);
});

test('闸门关闭：模型硬调 generate_candidates 会被参数层拒绝', () => {
  const r = validateToolCall('generate_candidates', { game: 'ssq' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FEATURE_DISABLED');
});

test('闸门开启：非法参数仍被拒绝（不做"理解着执行"）', () => {
  const opt = { futureNumbers: true };
  assert.equal(validateToolCall('generate_candidates', { game: 'dlt' }, opt).ok, false);
  assert.equal(validateToolCall('generate_candidates', { game: 'ssq', strategy: 'hot' }, opt).ok, false);
  assert.equal(validateToolCall('generate_candidates', { game: 'ssq', count: 9 }, opt).ok, false);
  assert.equal(
    validateToolCall('generate_candidates', { game: 'ssq', targetIssue: '2026' }, opt).ok,
    false
  );
  assert.equal(
    validateToolCall('generate_candidates', { game: 'ssq', include: [99] }, opt).ok,
    false
  );
  const ok = validateToolCall('generate_candidates', { game: 'ssq', count: 2, seed: 'a' }, opt);
  assert.equal(ok.ok, true);
  assert.equal(ok.args.count, 2);
});

test('未知名工具依旧是 UNKNOWN_TOOL，与闸门无关', () => {
  const r = validateToolCall('drop_table', {}, { futureNumbers: true });
  assert.equal(r.code, 'UNKNOWN_TOOL');
  assert.deepEqual(GATED_TOOL_NAMES, ['generate_candidates']);
});

/* ---------------- 执行器 ---------------- */

function fakeDb() {
  return {
    collection: () => ({
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return this;
      },
      async get() {
        return { data: [] };
      },
      async count() {
        return { total: 0 };
      },
    }),
  };
}

test('执行器：闸门关闭返回 FEATURE_DISABLED，且不落库', async () => {
  let saved = 0;
  const ex = createExecutors({
    db: fakeDb(),
    openid: 'local',
    gate: { futureNumbers: false },
    saveBatch: async () => {
      saved += 1;
    },
  });
  const r = await ex.execute('generate_candidates', { game: 'ssq' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'FEATURE_DISABLED');
  assert.equal(saved, 0);
});

test('执行器：闸门开启时生成并调用 saveBatch 留痕', async () => {
  const captured = [];
  const ex = createExecutors({
    db: fakeDb(),
    openid: 'local',
    gate: { futureNumbers: true, complianceState: COMPLIANCE_STATUS.SELF_ATTESTED },
    saveBatch: async (batch) => {
      captured.push(batch);
      return { ...batch, id: 'b_test' };
    },
  });
  const r = await ex.execute('generate_candidates', { game: 'ssq', count: 2, seed: 'exec-1' });
  assert.equal(r.ok, true);
  assert.equal(r.batchId, 'b_test');
  assert.equal(r.groups.length, 2);
  assert.equal(r.saved, true);
  assert.match(r.notice, /不代表更容易中奖/);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].complianceState, COMPLIANCE_STATUS.SELF_ATTESTED);
  assert.equal(captured[0].groups.length, 2);
});

test('执行器：落库失败仍返回号码，但标记 saved=false', async () => {
  const ex = createExecutors({
    db: fakeDb(),
    openid: 'local',
    gate: { futureNumbers: true },
    saveBatch: async () => {
      throw new Error('disk full');
    },
  });
  const r = await ex.execute('generate_candidates', { game: 'kl8', count: 1, seed: 'exec-2' });
  assert.equal(r.ok, true);
  assert.equal(r.saved, false);
  assert.equal(r.groups[0].numbers.kl8.length, 10);
});

/* ---------------- 提示词 ---------------- */

test('提示词：闸门关闭时禁止给号码，开启时要求原样引用并声明无预测性', () => {
  const closed = buildSystemPrompt({ futureNumbers: false, today: '2026-11-05' });
  assert.ok(closed.includes(DISABLED_RULE));
  assert.ok(!closed.includes(FUTURE_RULES[0]));

  const open = buildSystemPrompt({ futureNumbers: true, today: '2026-11-05' });
  assert.ok(open.includes(FUTURE_RULES[0]));
  assert.ok(!open.includes(DISABLED_RULE));
  assert.match(open, /不得改动、补号或重新排序/);
  assert.match(open, /不代表更容易中奖/);
});

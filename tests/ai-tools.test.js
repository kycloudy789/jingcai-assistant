/**
 * AI 工具白名单与参数校验测试（主方案 13.3 / 16.6 的"参数超范围应被拒绝"）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOL_NAMES, getToolSchemas, validateToolCall } = require('../shared/ai/tools');

test('工具白名单：只有 7 个只读工具，且不含写操作', () => {
  assert.equal(TOOL_NAMES.length, 7);
  for (const forbidden of ['save_ticket', 'delete_ticket', 'update_draw', 'sql', 'change_prize']) {
    assert.equal(TOOL_NAMES.includes(forbidden), false);
  }
});

test('schema 结构符合 function calling 约定', () => {
  const schemas = getToolSchemas();
  assert.equal(schemas.length, 7);
  for (const s of schemas) {
    assert.equal(s.type, 'function');
    assert.equal(typeof s.function.name, 'string');
    assert.equal(s.function.parameters.type, 'object');
    assert.ok(s.function.description.length > 10);
  }
});

test('未知工具一律拒绝', () => {
  const r = validateToolCall('run_sql', { sql: 'select * from ticket_records' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNKNOWN_TOOL');
});

test('彩种必须是 ssq / kl8', () => {
  assert.equal(validateToolCall('get_latest_draw', { game: 'fc3d' }).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_latest_draw', {}).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_latest_draw', { game: 'kl8' }).ok, true);
});

test('limit 被夹到 1–20，越界不会穿透', () => {
  assert.equal(validateToolCall('get_draws', { game: 'ssq', limit: 999 }).args.limit, 20);
  assert.equal(validateToolCall('get_draws', { game: 'ssq', limit: -5 }).args.limit, 1);
  assert.equal(validateToolCall('get_draws', { game: 'ssq' }).args.limit, 5);
  assert.equal(validateToolCall('get_my_tickets', { limit: 999 }).args.limit, 20);
});

test('期号必须是 7 位数字', () => {
  assert.equal(validateToolCall('get_draws', { game: 'ssq', issue: '2026' }).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_draws', { game: 'ssq', issue: '2026126' }).ok, true);
});

test('统计窗口只允许 30 / 50 / 100', () => {
  assert.equal(validateToolCall('get_number_stats', { game: 'ssq', window: 40 }).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_number_stats', { game: 'ssq', window: 100 }).args.window, 100);
  assert.equal(validateToolCall('get_number_stats', { game: 'ssq' }).args.window, 30);
});

test('状态只允许 draft / confirmed / void', () => {
  assert.equal(validateToolCall('get_my_tickets', { status: 'bought' }).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_my_tickets', { status: 'confirmed' }).ok, true);
});

test('get_ticket_check 必须带合法 ticketId', () => {
  assert.equal(validateToolCall('get_ticket_check', {}).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_ticket_check', { ticketId: 'x'.repeat(65) }).code, 'BAD_ARGS');
  assert.equal(validateToolCall('get_ticket_check', { ticketId: 'id_1' }).ok, true);
});

test('参数字符串形式（模型常见输出）可解析', () => {
  const r = validateToolCall('get_latest_draw', '{"game":"ssq"}');
  assert.equal(r.ok, true);
  assert.equal(r.args.game, 'ssq');
  assert.equal(validateToolCall('get_latest_draw', '{bad json').code, 'BAD_ARGS');
});

test('模型试图传入 userId 会被忽略（schema 不接受该字段）', () => {
  const r = validateToolCall('get_my_tickets', { userId: 'someone-else', limit: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.args.userId, undefined, '用户身份只能由服务端注入');
});

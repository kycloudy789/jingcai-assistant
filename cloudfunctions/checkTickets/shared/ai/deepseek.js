/**
 * DeepSeek Chat Completions 报文构造与解析（纯函数，可离线测试）。
 * 接口：POST https://api.deepseek.com/chat/completions
 * 模型名必须来自服务端配置，不在此处写死。
 */

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

const LIMITS = {
  maxInputChars: 1000,
  maxOutputTokens: 900,
  timeoutMs: 25000,
  historyMessages: 10,
};

/** 模型名白名单前缀：只接受 DeepSeek 官方模型，防止配置被写成奇怪的值 */
function isAcceptableModel(name) {
  return typeof name === 'string' && /^deepseek-[a-z0-9.-]{2,40}$/.test(name);
}

function buildRequestBody({ model, messages, tools, temperature = 0.2, maxTokens }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens || LIMITS.maxOutputTokens,
    stream: false,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/** 把模型返回的 tool_calls 归一化成 {id, name, arguments} */
function normalizeToolCalls(message) {
  const raw = message && message.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((c, i) => ({
    id: (c && c.id) || `call_${i}`,
    name: c && c.function ? c.function.name : '',
    arguments: c && c.function ? c.function.arguments : '{}',
  }));
}

/**
 * @returns {{ok:boolean, content:string, toolCalls:Array, usage:object|null, finishReason:string|null, code?:string, message?:string}}
 */
function parseCompletion(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'BAD_RESPONSE', message: '模型返回不是合法 JSON', content: '', toolCalls: [], usage: null };
  }
  if (payload.error) {
    return {
      ok: false,
      code: 'UPSTREAM_ERROR',
      message: String(payload.error.message || '上游返回错误').slice(0, 200),
      content: '',
      toolCalls: [],
      usage: null,
    };
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices.length) {
    return { ok: false, code: 'EMPTY_CHOICES', message: '模型未返回任何内容', content: '', toolCalls: [], usage: null };
  }
  const choice = choices[0] || {};
  const message = choice.message || {};
  return {
    ok: true,
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: normalizeToolCalls(message),
    usage: payload.usage || null,
    finishReason: choice.finish_reason || null,
  };
}

/** HTTP 状态码 → 可读错误码（不把响应体原样回传前端） */
function mapHttpError(status, bodyText) {
  if (status === 401 || status === 403) {
    return { code: 'AI_AUTH_FAILED', message: 'AI 服务鉴权失败：密钥无效或已失效，请重新填写' };
  }
  if (status === 402) {
    return { code: 'AI_QUOTA', message: 'AI 账户余额不足，请到 DeepSeek 控制台充值' };
  }
  if (status === 429) {
    return { code: 'AI_RATE_LIMIT', message: 'AI 请求过于频繁，请稍后再试' };
  }
  if (status >= 500) {
    return { code: 'AI_UPSTREAM', message: 'AI 服务暂时不可用，请稍后再试' };
  }
  return {
    code: 'AI_BAD_REQUEST',
    message: `AI 请求被拒绝（HTTP ${status}）${bodyText ? '，请检查模型名或参数配置' : ''}`,
  };
}

/** 输入长度控制：超长直接拒绝，不做静默截断 */
function validateUserMessage(text) {
  if (typeof text !== 'string') return { ok: false, message: '消息格式不正确' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: '消息不能为空' };
  if (trimmed.length > LIMITS.maxInputChars) {
    return { ok: false, message: `消息过长（上限 ${LIMITS.maxInputChars} 字），请精简后重试` };
  }
  return { ok: true, value: trimmed };
}

module.exports = {
  ENDPOINT,
  LIMITS,
  isAcceptableModel,
  buildRequestBody,
  parseCompletion,
  normalizeToolCalls,
  mapHttpError,
  validateUserMessage,
};

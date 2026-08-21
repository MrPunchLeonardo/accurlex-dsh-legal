import { parseResponseBody, ResponseParseError } from './ndjson.js';

export const DEFAULT_API_ORIGIN = 'https://accurlex.com';

export class AccurLexError extends Error {
  constructor(code, message, { status = 502, details = {}, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AccurLexError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sanitizeMessage(value, forbiddenValues = []) {
  let message = String(value ?? '未知错误')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/ak_(?:live|test)_[A-Za-z0-9_-]+/gi, '[redacted-key]')
    .replace(/\s+/g, ' ')
    .trim();
  const uniqueForbiddenValues = [...new Set(forbiddenValues)]
    .filter((item) => typeof item === 'string' && item.length > 1)
    .sort((left, right) => right.length - left.length);
  for (const forbiddenValue of uniqueForbiddenValues) {
    message = message.split(forbiddenValue).join('[redacted-input]');
  }
  return message.slice(0, 240);
}

function normalizeErrorCode(value, status) {
  const candidate = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(candidate) ? candidate : `http_${status}`;
}

function collectStringValues(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, output);
  }
  return output;
}

function apiOrigin(value) {
  const candidate = value || DEFAULT_API_ORIGIN;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AccurLexError('configuration_error', 'accurLex API base URL 不是有效 URL。', { status: 500 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AccurLexError('configuration_error', 'accurLex API base URL 必须使用 HTTP 或 HTTPS。', { status: 500 });
  }
  return parsed.origin;
}

function extractRemoteError(text, contentType, status, body) {
  let parsed;
  try {
    parsed = parseResponseBody(text, contentType).value;
  } catch {
    parsed = null;
  }
  const candidate = parsed && typeof parsed === 'object' ? parsed : {};
  const nested = candidate.error && typeof candidate.error === 'object' ? candidate.error : {};
  const rawCode = typeof candidate.error === 'string'
    ? candidate.error
    : nested.code || candidate.code || `http_${status}`;
  const code = normalizeErrorCode(rawCode, status);
  const bodyValues = collectStringValues(body);
  return {
    code,
    message: sanitizeMessage(`accurLex API 返回 ${code}（HTTP ${status}）。`, bodyValues),
  };
}

export async function requestAccurLex({
  method,
  path,
  body = null,
  signal,
  environment = process.env,
  fetchImpl = globalThis.fetch,
}) {
  const apiKey = environment.ACCURLEX_API_KEY;
  if (!apiKey) {
    throw new AccurLexError('configuration_error', '未配置 ACCURLEX_API_KEY。', { status: 500 });
  }
  if (typeof fetchImpl !== 'function') {
    throw new AccurLexError('configuration_error', '当前 Node 运行时没有可用的 fetch。', { status: 500 });
  }

  const url = new URL(path, `${apiOrigin(environment.ACCURLEX_API_BASE_URL)}/`);
  const headers = {
    Accept: 'application/json, application/x-ndjson',
    Authorization: `Bearer ${apiKey}`,
  };
  const init = { method, headers, signal };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }

  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new AccurLexError('cancelled', '工具调用已取消。', { status: 499, cause: error });
    }
    throw new AccurLexError('network_error', '无法连接 accurLex Open Platform。', { status: 502, cause: error });
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new AccurLexError('response_read_error', '读取 accurLex 响应失败。', { status: response.status, cause: error });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const remote = extractRemoteError(text, contentType, response.status, body);
    throw new AccurLexError(remote.code, remote.message, {
      status: response.status,
      details: { remoteCode: remote.code },
    });
  }

  let parsed;
  try {
    parsed = parseResponseBody(text, contentType);
  } catch (error) {
    if (error instanceof ResponseParseError) {
      throw new AccurLexError(error.code, error.message, { status: response.status, cause: error });
    }
    throw error;
  }
  if (parsed.remoteError) {
    const code = normalizeErrorCode(parsed.remoteError.code, response.status);
    throw new AccurLexError(
      code,
      `accurLex API 返回 ${code}（HTTP ${response.status}）。`,
      { status: response.status },
    );
  }
  return parsed;
}

export function publicError(error) {
  const code = sanitizeMessage(error?.code || 'plugin_error');
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = sanitizeMessage(error?.message || '插件执行失败。');
  return { status, code, message };
}

export class ResponseParseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResponseParseError';
    this.code = code;
    this.status = 502;
    this.details = details;
  }
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function projectJsonValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const data = value.data ?? value.answer ?? value.content ?? value.text;
    const originalContent = value.original_content ?? value.originalContent ?? '';
    return {
      format: 'json',
      value,
      data: data === undefined || data === null ? '' : asText(data),
      originalContent: asText(originalContent),
      records: [value],
    };
  }
  return {
    format: 'json',
    value,
    data: asText(value),
    originalContent: '',
    records: [value],
  };
}

function parseNdjson(text) {
  const records = [];
  const dataParts = [];
  const originalParts = [];
  let remoteError = null;
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      throw new ResponseParseError('invalid_ndjson', `第 ${index + 1} 行不是有效 JSON。`, {
        line: index + 1,
      });
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new ResponseParseError('invalid_ndjson_record', `第 ${index + 1} 行不是 JSON object。`, {
        line: index + 1,
      });
    }
    if (record.heartbeat === true) continue;
    records.push(record);
    if (record.error) {
      remoteError = {
        code: typeof record.error === 'string' ? record.error : record.error.code,
        message: typeof record.error === 'string' ? record.error : record.error.message,
      };
    }
    if (record.data !== undefined && record.data !== null) dataParts.push(asText(record.data));
    if (record.original_content !== undefined && record.original_content !== null) {
      originalParts.push(asText(record.original_content));
    }
  }

  if (records.length === 0 && !remoteError) {
    throw new ResponseParseError('empty_response', '上游返回为空。');
  }

  return {
    format: 'ndjson',
    value: records,
    data: dataParts.join(''),
    originalContent: originalParts.join(''),
    records,
    remoteError,
  };
}

export function parseResponseBody(text, contentType = '') {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (!trimmed) throw new ResponseParseError('empty_response', '上游返回为空。');

  try {
    return projectJsonValue(JSON.parse(trimmed));
  } catch {
    if (/ndjson/i.test(contentType) || trimmed.includes('\n')) return parseNdjson(raw);
    if (/json/i.test(contentType)) {
      throw new ResponseParseError('invalid_json', '上游返回不是有效 JSON。');
    }
    return {
      format: 'text',
      value: null,
      data: raw,
      originalContent: '',
      records: [],
    };
  }
}

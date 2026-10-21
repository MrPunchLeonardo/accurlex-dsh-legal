export const API_LIMITS = Object.freeze({
  qa: Object.freeze({ deep: 10_000, expert: 30_000 }),
  lawSearch: Object.freeze({ deep: 10_000, expert: 30_000 }),
  contractReview: 30_000,
  documentDraft: 30_000,
  history: 20_000,
});

export class ValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

export function countCharacters(value) {
  return Array.from(String(value ?? '')).length;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field}_required`, `${field} 不能为空。`, { field });
  }
  return value;
}

function requiredAliasedText(args, canonicalField, aliasField) {
  const canonicalValue = args?.[canonicalField];
  const aliasValue = args?.[aliasField];
  if (!canonicalValue && !aliasValue) {
    throw new ValidationError(
      `${canonicalField}_required`,
      `${canonicalField} 或 ${aliasField} 至少提供一个非空字符串。`,
      { field: canonicalField, aliases: [canonicalField, aliasField] },
    );
  }
  return requiredText(canonicalValue || aliasValue, canonicalField);
}

function optionalText(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ValidationError(`${field}_invalid`, `${field} 必须是字符串。`, { field });
  }
  return value;
}

function enumValue(value, field, allowed, fallback) {
  const normalized = value === undefined || value === null || value === '' ? fallback : value;
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`${field}_invalid`, `${field} 必须是 ${allowed.join(' 或 ')}。`, {
      field,
      allowed,
    });
  }
  return normalized;
}

export function normalizeMode(value) {
  return enumValue(value, 'mode', ['deep', 'expert'], 'deep');
}

export function normalizeOutputMode(value) {
  return enumValue(value, 'output_mode', ['normal', 'json'], 'normal');
}

export function normalizeHistory(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value;
  throw new ValidationError('history_invalid', 'history 必须是字符串或数组。', { field: 'history' });
}

function assertHistoryLimit(history) {
  const serialized = typeof history === 'string' ? history : JSON.stringify(history ?? []);
  const actual = countCharacters(serialized);
  if (actual > API_LIMITS.history) {
    throw new ValidationError('history_exceed_char_limit', `history 超过 ${API_LIMITS.history} 字符限制。`, {
      field: 'history',
      actual,
      limit: API_LIMITS.history,
    });
  }
}

function assertLimit(field, value, limit) {
  const actual = countCharacters(value);
  if (actual > limit) {
    throw new ValidationError('exceed_char_limit', `${field} 超过 ${limit} 字符限制。`, {
      field,
      actual,
      limit,
    });
  }
}

function withQuestionContext(contextText, question) {
  return contextText ? `${contextText}\n\n${question}` : question;
}

export function mapQaArgs(args = {}) {
  const question = requiredText(args.question, 'question');
  const contextText = optionalText(args.context_text, 'context_text');
  const mode = normalizeMode(args.mode);
  const history = normalizeHistory(args.history);
  assertLimit('question + context_text', withQuestionContext(contextText, question), API_LIMITS.qa[mode]);
  assertHistoryLimit(history);
  return {
    method: 'POST',
    path: '/v1/qa',
    body: {
      question,
      context_text: contextText,
      mode,
      history,
      stream: true,
    },
    meta: { mode, scope: `qa_${mode}` },
  };
}

export function mapLawSearchArgs(args = {}) {
  const query = requiredAliasedText(args, 'prompt', 'query');
  const mode = normalizeMode(args.mode);
  assertLimit('query', query, API_LIMITS.lawSearch[mode]);
  return {
    method: 'POST',
    path: '/v1/law_search',
    body: {
      prompt: query,
      mode,
      stream: true,
    },
    meta: { mode, scope: 'law_search' },
  };
}

export function mapContractReviewArgs(args = {}) {
  const contractText = requiredText(args.contract_text, 'contract_text');
  const standpoint = requiredText(args.standpoint, 'standpoint');
  const outputMode = normalizeOutputMode(args.output_mode);
  const history = normalizeHistory(args.history);
  assertLimit('contract_text + standpoint', `${contractText}${standpoint}`, API_LIMITS.contractReview);
  assertHistoryLimit(history);
  return {
    method: 'POST',
    path: '/v1/contracts_review',
    body: {
      contract_text: contractText,
      standpoint,
      output_mode: outputMode,
      history,
      stream: true,
    },
    meta: { outputMode, scope: 'contract_review' },
  };
}

export function mapDocumentDraftArgs(args = {}) {
  const requirement = requiredAliasedText(args, 'prompt', 'requirement');
  const referenceMaterial = optionalText(args.reference_material, 'reference_material');
  const sampleDocument = optionalText(args.sample_document, 'sample_document');
  const history = normalizeHistory(args.history);
  assertLimit(
    'requirement + reference_material + sample_document',
    `${requirement}${referenceMaterial}${sampleDocument}`,
    API_LIMITS.documentDraft,
  );
  assertHistoryLimit(history);
  return {
    method: 'POST',
    path: '/v1/documents_draft',
    body: {
      prompt: requirement,
      reference_material: referenceMaterial,
      sample_document: sampleDocument,
      history,
      stream: true,
    },
    meta: { scope: 'document_draft' },
  };
}

export function mapAccountUsageArgs(args = {}) {
  const scope = enumValue(args.capability, 'capability', ['qa_deep', 'qa_expert', 'law_search', 'document_draft', 'contract_review'], 'qa_deep');
  return {
    method: 'GET',
    path: '/v1/account_usage',
    body: null,
    meta: { scope },
  };
}

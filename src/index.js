import { publicError, requestAccurLex } from './api-client.js';
import {
  mapAccountUsageArgs,
  mapContractReviewArgs,
  mapDocumentDraftArgs,
  mapLawSearchArgs,
  mapQaArgs,
} from './validation.js';

export const name = 'accurlex-dsh-legal';
export const inject = ['tools'];
export const DEFAULT_USAGE_RECENT_LIMIT = 5;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 600_000;
const MAX_TOOL_CALL_TIMEOUT_MS = 2_147_483_647;

export function normalizeToolCallTimeoutMs(value) {
  const candidate = value === undefined
    ? DEFAULT_TOOL_CALL_TIMEOUT_MS
    : value;
  if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > MAX_TOOL_CALL_TIMEOUT_MS) {
    throw new Error(`toolCallTimeoutMs 必须是 1 到 ${MAX_TOOL_CALL_TIMEOUT_MS} 之间的整数。`);
  }
  return candidate;
}

const historySchema = {
  oneOf: [
    { type: 'string' },
    { type: 'array', items: {} },
  ],
  description: '可选的历史对话或上下文材料。',
};

const outputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    tool: { type: 'string' },
    content: { type: 'string' },
    result: {},
    original_content: {},
    output_mode: { type: 'string' },
    mode: { type: 'string' },
    summary: {},
    recent: {},
    recent_total: { type: 'integer' },
    recent_limit: { type: 'integer' },
    recent_truncated: { type: 'boolean' },
    error: {},
  },
  required: ['ok', 'tool', 'content'],
  additionalProperties: true,
};

function renderResult(_args, value) {
  const content = typeof value?.content === 'string' && value.content
    ? value.content
    : JSON.stringify(value ?? {}, null, 2);
  return [{ type: 'text', text: content }];
}

function definition({ name: toolName, description, properties, required = [], mapArgs, project }) {
  return {
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: outputSchema,
      render: renderResult,
    },
    async execute(args, exec) {
      try {
        const mapped = mapArgs(args);
        const response = await requestAccurLex({
          method: mapped.method,
          path: mapped.path,
          body: mapped.body,
          signal: exec?.signal,
        });
        return project(response, mapped.meta, toolName);
      } catch (error) {
        const safe = publicError(error);
        return {
          ok: false,
          tool: toolName,
          content: `accurLex 工具失败（${safe.code}）：${safe.message}`,
          error: safe,
        };
      }
    },
  };
}

function responseContent(response) {
  if (response.data) return response.data;
  if (response.originalContent) return response.originalContent;
  if (response.value && typeof response.value === 'object') {
    const candidate = response.value.data ?? response.value.answer ?? response.value.content;
    if (candidate !== undefined && candidate !== null) return String(candidate);
    return JSON.stringify(response.value, null, 2);
  }
  return response.data || '';
}

function success(tool, response, extra = {}) {
  return {
    ok: true,
    tool,
    content: responseContent(response),
    result: response.value ?? null,
    original_content: response.originalContent || null,
    ...extra,
  };
}

function parseContractResult(content) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation, then report a stable parse error to the caller.
    }
  }
  return null;
}

function projectQa(response, meta, toolName) {
  return success(toolName, response, { mode: meta.mode });
}

function projectLawSearch(response, meta, toolName) {
  return success(toolName, response, { mode: meta.mode });
}

function projectContract(response, meta, toolName) {
  const content = responseContent(response);
  const result = meta.outputMode === 'json' ? parseContractResult(content) : null;
  if (meta.outputMode === 'json' && result === null) {
    return {
      ok: false,
      tool: toolName,
      content: '合同审查 JSON 模式的上游结果无法解析为 JSON，已保留原始文本。',
      output_mode: meta.outputMode,
      result: null,
      original_content: response.originalContent || null,
      error: {
        status: 502,
        code: 'contract_json_parse_error',
        message: '上游结果不是有效 JSON。',
      },
    };
  }
  return {
    ...success(toolName, response, { output_mode: meta.outputMode }),
    content,
    result,
  };
}

function projectDraft(response, _meta, toolName) {
  return success(toolName, response);
}

function projectUsage(response, _meta, toolName) {
  const value = response.value && typeof response.value === 'object' ? response.value : {};
  const rawRecent = value.recent;
  const recent = Array.isArray(rawRecent)
    ? rawRecent.slice(0, DEFAULT_USAGE_RECENT_LIMIT)
    : null;
  const recentTotal = Array.isArray(rawRecent) ? rawRecent.length : 0;
  const usageMeta = {
    recent_total: recentTotal,
    recent_limit: DEFAULT_USAGE_RECENT_LIMIT,
    recent_truncated: recentTotal > DEFAULT_USAGE_RECENT_LIMIT,
  };
  const projectedValue = {
    ...value,
    recent,
    ...usageMeta,
  };
  return {
    ok: true,
    tool: toolName,
    content: JSON.stringify(projectedValue, null, 2),
    result: projectedValue,
    original_content: response.originalContent || null,
    summary: value.summary ?? null,
    recent,
    ...usageMeta,
  };
}

const baseToolDefinitions = [
  definition({
    name: 'accurlex_legal_qa',
    description: '调用 accurLex 进行法律问答。可提供完整的相关上下文；插件不会自动读取 workspace。',
    properties: {
      question: { type: 'string', description: '要回答的法律问题。' },
      context_text: { type: 'string', description: '可选的完整相关背景、文件内容或事实材料。' },
      mode: { type: 'string', enum: ['deep', 'expert'], description: 'deep 免费深度模式；expert 按平台规则计费。' },
      history: historySchema,
    },
    required: ['question'],
    mapArgs: mapQaArgs,
    project: projectQa,
  }),
  definition({
    name: 'accurlex_law_search',
    description: '调用已开启的 accurLex 法规检索 API。支持 deep/expert；prompt 是 API canonical 字段，query 是兼容 alias。',
    properties: {
      prompt: { type: 'string', description: 'API canonical 检索输入。' },
      query: { type: 'string', description: '兼容 alias；仅在 prompt 未提供有效值时使用。' },
      mode: { type: 'string', enum: ['deep', 'expert'], description: '检索模式；expert 已开启，最多 30,000 字符。' },
    },
    required: [],
    mapArgs: mapLawSearchArgs,
    project: projectLawSearch,
  }),
  definition({
    name: 'accurlex_contract_review',
    description: '调用 accurLex 审查合同。默认返回 normal 自然语言结果；只有明确选择 output_mode=json 才返回结构化 JSON。',
    properties: {
      contract_text: { type: 'string', description: '完整合同文本或本次审查所需的完整相关材料。' },
      standpoint: { type: 'string', description: '审查立场、目标和需要重点关注的风险。' },
      output_mode: { type: 'string', enum: ['normal', 'json'], description: '默认 normal；需要程序化处理时显式选择 json。' },
      history: historySchema,
    },
    required: ['contract_text', 'standpoint'],
    mapArgs: mapContractReviewArgs,
    project: projectContract,
  }),
  definition({
    name: 'accurlex_document_draft',
    description: '调用已开启的 accurLex 文书生成 API。prompt 是 API canonical 字段，requirement 是兼容 alias；可提供完整参考材料和样本文书。',
    properties: {
      prompt: { type: 'string', description: 'API canonical 文书写作要求。' },
      requirement: { type: 'string', description: '兼容 alias；仅在 prompt 未提供有效值时使用。' },
      reference_material: { type: 'string', description: '可选的完整事实、条款或参考材料。' },
      sample_document: { type: 'string', description: '可选的样本文书。' },
      history: historySchema,
    },
    required: [],
    mapArgs: mapDocumentDraftArgs,
    project: projectDraft,
  }),
  definition({
    name: 'accurlex_account_usage',
    description: '查询当前 accurLex API Key 的近 30 天汇总和近期用量记录。',
    properties: {},
    required: [],
    mapArgs: mapAccountUsageArgs,
    project: projectUsage,
  }),
];

export function createToolDefinitions(options = {}) {
  const timeoutMs = normalizeToolCallTimeoutMs(options?.toolCallTimeoutMs);
  return baseToolDefinitions.map((tool) => ({ ...tool, timeoutMs }));
}

export const toolDefinitions = createToolDefinitions();

export function apply(ctx, config = {}) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('accurLex DSH plugin requires ctx.tools.register.');
  }
  for (const tool of createToolDefinitions(config)) ctx.tools.register(tool);
}

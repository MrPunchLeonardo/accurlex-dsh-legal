import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  apply,
  createToolDefinitions,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  toolDefinitions,
} from '../src/index.js';
import { createFakeDshContext, execution } from './fake-dsh.js';
import { jsonResponse, ndjsonResponse, startMockApi } from './mock-api.js';

const originalKey = process.env.ACCURLEX_API_KEY;
const originalBaseUrl = process.env.ACCURLEX_API_BASE_URL;

afterEach(() => {
  if (originalKey === undefined) delete process.env.ACCURLEX_API_KEY;
  else process.env.ACCURLEX_API_KEY = originalKey;
  if (originalBaseUrl === undefined) delete process.env.ACCURLEX_API_BASE_URL;
  else process.env.ACCURLEX_API_BASE_URL = originalBaseUrl;
});

function setMockEnv(server) {
  process.env.ACCURLEX_API_KEY = 'ak_live_' + 'synthetic_test_key_'.repeat(3);
  process.env.ACCURLEX_API_BASE_URL = server.baseUrl;
}

function getTool(name) {
  const tool = toolDefinitions.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

async function withServer(handler, callback) {
  const server = await startMockApi(handler);
  try {
    setMockEnv(server);
    return await callback(server);
  } finally {
    await server.close();
  }
}

describe('DSH plugin registration', () => {
  test('registers six tools without making a request or requiring a key', () => {
    delete process.env.ACCURLEX_API_KEY;
    const { ctx, registered } = createFakeDshContext();
    apply(ctx);
    assert.deepEqual(registered.map((tool) => tool.name), [
      'accurlex_legal_qa',
      'accurlex_law_search',
      'accurlex_contract_review',
      'accurlex_document_draft',
      'accurlex_account_usage',
      'accurlex_connect',
    ]);
    for (const tool of registered) {
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.output.schema.type, 'object');
      assert.equal(tool.output.schema.required.includes('content'), true);
      assert.equal(tool.timeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
      assert.equal(tool.output.render({}, { content: 'ok' })[0].text, 'ok');
    }

    for (const name of ['accurlex_law_search', 'accurlex_document_draft']) {
      const tool = registered.find((candidate) => candidate.name === name);
      assert.deepEqual(tool.parameters.required, []);
      assert.equal('anyOf' in tool.parameters, false);
    }
  });

  test('maps toolCallTimeoutMs to native timeoutMs and rejects invalid values', () => {
    const { ctx, registered } = createFakeDshContext();
    apply(ctx, { toolCallTimeoutMs: 900_000 });
    assert.equal(registered.length, 6);
    assert.deepEqual([...new Set(registered.map((tool) => tool.timeoutMs))], [900_000]);
    assert.throws(() => apply(ctx, { toolCallTimeoutMs: 0 }), /toolCallTimeoutMs/);
    assert.throws(() => apply(ctx, { toolCallTimeoutMs: 1.5 }), /toolCallTimeoutMs/);
    assert.throws(() => apply(ctx, { toolCallTimeoutMs: '900000' }), /toolCallTimeoutMs/);
    assert.throws(() => apply(ctx, { toolCallTimeoutMs: 2_147_483_648 }), /toolCallTimeoutMs/);
  });
});

describe('accurLex REST tool mapping', () => {
  test('keeps aliased prompt fields optional in schema but validates one at execution time', async () => {
    const lawSearch = await getTool('accurlex_law_search').execute({}, execution());
    assert.equal(lawSearch.ok, false);
    assert.equal(lawSearch.error.code, 'prompt_required');

    const documentDraft = await getTool('accurlex_document_draft').execute({}, execution());
    assert.equal(documentDraft.ok, false);
    assert.equal(documentDraft.error.code, 'prompt_required');
  });

  test('maps QA with context/history and bearer authentication', async () => {
    await withServer(async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/qa');
      assert.equal(request.headers.authorization, 'Bearer ' + process.env.ACCURLEX_API_KEY);
      assert.equal(request.body.question, '劳动合同问题');
      assert.equal(request.body.context_text, '完整的合成背景材料');
      assert.deepEqual(request.body.history, [{ role: 'user', content: '此前问题' }]);
      assert.equal(request.body.stream, true);
      return ndjsonResponse([
        JSON.stringify({ heartbeat: true }),
        JSON.stringify({ original_content: '合成依据' }),
        JSON.stringify({ data: '合成回答' }),
      ]);
    }, async (server) => {
      const result = await getTool('accurlex_legal_qa').execute({
        question: '劳动合同问题',
        context_text: '完整的合成背景材料',
        history: [{ role: 'user', content: '此前问题' }],
      }, execution());
      assert.equal(result.ok, true);
      assert.equal(result.content, '合成回答');
      assert.equal(result.original_content, '合成依据');
      assert.equal(server.requests.length, 1);
    });
  });

  test('maps law search query to canonical prompt', async () => {
    await withServer(async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/law_search');
      assert.equal(request.body.prompt, '劳动法加班检索');
      assert.equal(request.body.mode, 'deep');
      assert.equal(request.body.stream, true);
      return ndjsonResponse([
        JSON.stringify({ heartbeat: true }),
        JSON.stringify({ original_content: '合成法条检索结果' }),
      ]);
    }, async (server) => {
      const result = await getTool('accurlex_law_search').execute({ query: '劳动法加班检索' }, execution());
      assert.equal(result.ok, true);
      assert.equal(result.content, '合成法条检索结果');
      assert.equal(server.requests.length, 1);
    });
  });

  test('maps enabled law search expert with canonical prompt', async () => {
    await withServer(async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/law_search');
      assert.equal(request.body.prompt, '格式条款提示说明义务');
      assert.equal(request.body.mode, 'expert');
      assert.equal(request.body.stream, true);
      return ndjsonResponse([
        JSON.stringify({ heartbeat: true }),
        JSON.stringify({ original_content: '合成 expert 法条检索结果' }),
      ]);
    }, async (server) => {
      const result = await getTool('accurlex_law_search').execute({
        prompt: '格式条款提示说明义务',
        query: '应被 canonical prompt 覆盖的 alias',
        mode: 'expert',
      }, execution());
      assert.equal(result.ok, true);
      assert.equal(result.mode, 'expert');
      assert.equal(result.content, '合成 expert 法条检索结果');
      assert.equal(server.requests.length, 1);
    });
  });

  test('maps enabled document draft canonical prompt while retaining alias compatibility', async () => {
    await withServer(async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/documents_draft');
      assert.equal(request.body.prompt, 'canonical 文书生成要求');
      assert.equal(request.body.reference_material, '完整合成事实');
      assert.equal(request.body.sample_document, '合成样本');
      assert.deepEqual(request.body.history, [{ role: 'user', content: '合成历史' }]);
      assert.equal(request.body.stream, true);
      return ndjsonResponse([
        JSON.stringify({ heartbeat: true }),
        JSON.stringify({ original_content: '合成参考' }),
        JSON.stringify({ data: '合成 canonical 文书正文' }),
      ]);
    }, async (server) => {
      const result = await getTool('accurlex_document_draft').execute({
        prompt: 'canonical 文书生成要求',
        requirement: '应被 canonical prompt 覆盖的 alias',
        reference_material: '完整合成事实',
        sample_document: '合成样本',
        history: [{ role: 'user', content: '合成历史' }],
      }, execution());
      assert.equal(result.ok, true);
      assert.equal(result.content, '合成 canonical 文书正文');
      assert.equal(server.requests.length, 1);
    });
  });

  test('maps document draft and account usage', async () => {
    await withServer(async (request) => {
      if (request.url === '/v1/documents_draft') {
        assert.equal(request.body.prompt, '起草合成确认函');
        assert.equal(request.body.reference_material, '完整合成事实');
        assert.equal(request.body.sample_document, '合成样本');
        assert.equal(request.body.stream, true);
        return ndjsonResponse([
          JSON.stringify({ heartbeat: true }),
          JSON.stringify({ original_content: '合成参考' }),
          JSON.stringify({ data: '合成文书正文' }),
        ]);
      }
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/account_usage');
      assert.equal(request.body, null);
      return jsonResponse({ summary: [{ endpoint: 'v1/qa', count: 1 }], recent: [] });
    }, async (server) => {
      const draft = await getTool('accurlex_document_draft').execute({
        requirement: '起草合成确认函',
        reference_material: '完整合成事实',
        sample_document: '合成样本',
      }, execution());
      assert.equal(draft.ok, true);
      assert.equal(draft.content, '合成文书正文');
      const usage = await getTool('accurlex_account_usage').execute({}, execution());
      assert.equal(usage.ok, true);
      assert.deepEqual(usage.summary, [{ endpoint: 'v1/qa', count: 1 }]);
      assert.deepEqual(usage.recent, []);
      assert.equal(server.requests.length, 2);
    });
  });

  test('truncates usage recent consistently across result and rendered content', async () => {
    const recent = Array.from({ length: 8 }, (_, index) => ({
      request_id: `request-${index}`,
      endpoint: 'v1/qa',
      status: 'success',
      created_at: `2026-08-20 12:0${index}:00`,
    }));
    await withServer(async (request) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.url, '/v1/account_usage');
      return jsonResponse({
        summary: [{ endpoint: 'v1/qa', count: 8 }],
        recent,
      });
    }, async () => {
      const usage = await getTool('accurlex_account_usage').execute({}, execution());
      assert.equal(usage.ok, true);
      assert.equal(usage.recent.length, 5);
      assert.equal(usage.result.recent.length, 5);
      assert.equal(usage.recent_total, 8);
      assert.equal(usage.recent_limit, 5);
      assert.equal(usage.recent_truncated, true);
      assert.equal(usage.result.recent_total, 8);
      assert.equal(usage.result.recent_truncated, true);
      assert.match(usage.content, /request-0/);
      assert.doesNotMatch(usage.content, /request-5/);
      assert.match(usage.content, /recent_truncated/);
      const rendered = getTool('accurlex_account_usage').output.render({}, usage)[0].text;
      assert.match(rendered, /request-0/);
      assert.doesNotMatch(rendered, /request-5/);
    });
  });
});

describe('合同审查 output_mode 和 NDJSON', () => {
  test('defaults to normal and keeps readable content', async () => {
    await withServer(async (request) => {
      assert.equal(request.body.output_mode, 'normal');
      assert.equal(request.body.stream, true);
      return ndjsonResponse([
        JSON.stringify({ heartbeat: true }),
        JSON.stringify({ original_content: '合成参考条款' }),
        JSON.stringify({ data: '自然语言' }),
        JSON.stringify({ data: '审查意见' }),
      ]);
    }, async (server) => {
      const result = await getTool('accurlex_contract_review').execute({
        contract_text: '完整合成合同',
        standpoint: '乙方',
      }, execution());
      assert.equal(result.ok, true);
      assert.equal(result.output_mode, 'normal');
      assert.equal(result.content, '自然语言审查意见');
      assert.equal(result.result, null);
      assert.equal(result.original_content, '合成参考条款');
      assert.equal(server.requests.length, 1);
    });
  });

  test('supports explicit normal and explicit json independently', async () => {
    await withServer(async (request) => {
      assert.equal(request.body.stream, true);
      if (request.body.output_mode === 'normal') {
        return ndjsonResponse([JSON.stringify({ data: '显式 normal' })]);
      }
      assert.equal(request.body.output_mode, 'json');
      return ndjsonResponse([
        JSON.stringify({ data: '{"metadata":{"overall_comment":"总体意见"},' }),
        JSON.stringify({ data: '"revisions":[{"original":"原条款","revised":"建议条款"}]}' }),
      ]);
    }, async (server) => {
      const normal = await getTool('accurlex_contract_review').execute({
        contract_text: '合成合同',
        standpoint: '甲方',
        output_mode: 'normal',
      }, execution());
      assert.equal(normal.ok, true);
      assert.equal(normal.output_mode, 'normal');
      assert.equal(normal.content, '显式 normal');

      const json = await getTool('accurlex_contract_review').execute({
        contract_text: '合成合同',
        standpoint: '甲方',
        output_mode: 'json',
      }, execution());
      assert.equal(json.ok, true);
      assert.equal(json.output_mode, 'json');
      assert.deepEqual(json.result, {
        metadata: { overall_comment: '总体意见' },
        revisions: [{ original: '原条款', revised: '建议条款' }],
      });
      assert.equal(server.requests.length, 2);
    });
  });

  test('reports invalid JSON mode result instead of inventing a structure', async () => {
    await withServer(async () => ndjsonResponse([JSON.stringify({ data: '不是 JSON 的合成文本' })]), async () => {
      const result = await getTool('accurlex_contract_review').execute({
        contract_text: '合成合同',
        standpoint: '甲方',
        output_mode: 'json',
      }, execution());
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'contract_json_parse_error');
      assert.match(result.content, /无法解析/);
    });
  });
});

describe('错误、取消和输入边界', () => {
  test('guides missing credentials to SMS onboarding without making a request', async () => {
    await withServer(async () => {
      throw new Error('must not be called');
    }, async (server) => {
      delete process.env.ACCURLEX_API_KEY;
      const tools = createToolDefinitions({}, { home: path.join(os.tmpdir(), 'accurlex-no-home-' + randomUUID()) });
      const result = await tools.find(tool => tool.name === 'accurlex_legal_qa').execute({ question: '合成问题' }, execution());
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'api_key_required');
      assert.equal(result.capability, 'qa_deep');
      assert.match(result.content, /accurlex_connect/);
      assert.equal(server.requests.length, 0);
    });
  });

  test('rejects invalid/oversized input before HTTP and does not truncate', async () => {
    await withServer(async () => {
      throw new Error('must not be called');
    }, async (server) => {
      const empty = await getTool('accurlex_legal_qa').execute({ question: '' }, execution());
      assert.equal(empty.ok, false);
      assert.equal(empty.error.code, 'question_required');

      const invalid = await getTool('accurlex_contract_review').execute({
        contract_text: '合成合同',
        standpoint: '甲方',
        output_mode: 'xml',
      }, execution());
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, 'output_mode_invalid');

      const invalidMode = await getTool('accurlex_law_search').execute({
        query: '合成检索',
        mode: 'turbo',
      }, execution());
      assert.equal(invalidMode.ok, false);
      assert.equal(invalidMode.error.code, 'mode_invalid');

      const oversized = await getTool('accurlex_legal_qa').execute({
        question: 'a'.repeat(10_001),
      }, execution());
      assert.equal(oversized.ok, false);
      assert.equal(oversized.error.code, 'exceed_char_limit');

      const oversizedExpert = await getTool('accurlex_legal_qa').execute({
        question: 'a'.repeat(30_001),
        mode: 'expert',
      }, execution());
      assert.equal(oversizedExpert.ok, false);

      const oversizedLawExpert = await getTool('accurlex_law_search').execute({
        prompt: 'a'.repeat(30_001),
        mode: 'expert',
      }, execution());
      assert.equal(oversizedLawExpert.ok, false);
      assert.equal(oversizedLawExpert.error.code, 'exceed_char_limit');

      const oversizedContract = await getTool('accurlex_contract_review').execute({
        contract_text: 'a'.repeat(30_000),
        standpoint: 'b',
      }, execution());
      assert.equal(oversizedContract.ok, false);

      const oversizedDraft = await getTool('accurlex_document_draft').execute({
        requirement: 'a'.repeat(30_001),
      }, execution());
      assert.equal(oversizedDraft.ok, false);
      assert.equal(server.requests.length, 0);
    });
  });

  test('reports invalid NDJSON without returning partial content as success', async () => {
    await withServer(async () => ({
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      body: '{"data":"部分"}\n不是 JSON\n',
    }), async (server) => {
      const result = await getTool('accurlex_contract_review').execute({
        contract_text: '合成合同',
        standpoint: '甲方',
      }, execution());
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'invalid_ndjson');
      assert.equal(server.requests.length, 1);
    });
  });

  test('sanitizes remote errors and never retries', async () => {
    await withServer(async () => jsonResponse({ error: 'api_key_invalid', message: 'Bearer ak_test_mock 合成合同' }, 401), async (server) => {
      const result = await getTool('accurlex_legal_qa').execute({ question: '合成问题' }, execution());
      assert.equal(result.ok, false);
      assert.equal(result.error.status, 401);
      assert.equal(result.error.code, 'api_key_invalid');
      assert.doesNotMatch(JSON.stringify(result), /ak_test_mock/);
      assert.doesNotMatch(JSON.stringify(result), /合成合同/);
      assert.equal(server.requests.length, 1);
    });
  });

  test('preserves the main remote status families without retrying', async () => {
    const statuses = [402, 403, 413, 429, 502, 503, 504];
    let nextStatus = 0;
    await withServer(async () => {
      const status = statuses[nextStatus++];
      return jsonResponse({ error: `mock_${status}`, message: '不应透传正文' }, status);
    }, async (server) => {
      for (const status of statuses) {
        const result = await getTool('accurlex_legal_qa').execute({ question: `合成问题 ${status}` }, execution());
        assert.equal(result.ok, false);
        assert.equal(result.error.status, status);
        assert.equal(result.error.code, `mock_${status}`);
      }
      assert.equal(server.requests.length, statuses.length);
    });
  });

  test('honors AbortSignal and performs at most one request', async () => {
    await withServer(async () => jsonResponse({ status: 'success', data: '迟到的结果' }, 200), async (server) => {
      const controller = new AbortController();
      const promise = getTool('accurlex_legal_qa').execute({ question: '合成问题' }, execution(controller.signal));
      controller.abort();
      const result = await promise;
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'cancelled');
      assert.ok(server.requests.length <= 1);
    });
  });
});
